// labour-rate-copy-service.js
// Purpose: Copy one labour's existing article rates onto other labours.
//
// This is deliberately a SEPARATE path from labour-rates-service.js. The Add
// Labour Rates writer walks `for labour -> for sku` issuing one awaited
// INSERT/UPDATE per pair; a copy writes targets x articles rows, so the same
// shape would mean thousands of serial round-trips inside one transaction.
// Everything here reads in a fixed number of queries and writes in chunked
// ON CONFLICT batches. Nothing in the Add path is imported or modified.
//
// Key semantics:
// - Only sku-pinned rules can be copied. A scope-wide fallback rule (sku_id
//   NULL) cannot be expressed as a {sku_id, rate} row, so it is reported back
//   as "not copied" instead of being silently dropped.
// - Copied rows are written as apply_on = 'SKU'. Readers match a rule carrying
//   a sku_id on sku_id whatever its apply_on says, so this is display-only.
// - article_type is never written, matching the existing bulk writer.

const knex = require("../../db/knex");

const TABLE = "erp.labour_rate_rules";
const CHUNK_SIZE = 500;
const MAX_COPY_ROWS = 5000;

const ARTICLE_TYPE = { FG: "FG", SFG: "SFG", BOTH: "BOTH" };
const CONFLICT_MODE = { SKIP: "SKIP", OVERWRITE: "OVERWRITE" };
const ROW_STATE = { NEW: "NEW", CONFLICT: "CONFLICT", IDENTICAL: "IDENTICAL" };
const BLOCK_REASON = {
  NOT_ASSIGNED: "NOT_ASSIGNED",
  INACTIVE: "INACTIVE",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
};

const toPositiveIntOrNull = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const toPositiveIntArray = (value) => {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value == null
        ? []
        : [value];
  return [
    ...new Set(
      source.map((entry) => toPositiveIntOrNull(entry)).filter(Boolean),
    ),
  ];
};

const toMoney = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return Number(numberValue.toFixed(2));
};

const normalizeArticleTypeFilter = (value) => {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  if (raw === "FG" || raw === "FINISHED") return ARTICLE_TYPE.FG;
  if (raw === "SFG" || raw === "SEMI_FINISHED") return ARTICLE_TYPE.SFG;
  return ARTICLE_TYPE.BOTH;
};

const normalizeConflictMode = (value) => {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  return raw === CONFLICT_MODE.OVERWRITE
    ? CONFLICT_MODE.OVERWRITE
    : CONFLICT_MODE.SKIP;
};

const normalizeRateType = (value) => {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  return raw === "PER_DOZEN" ? "PER_DOZEN" : "PER_PAIR";
};

const localizedName = (alias, locale) =>
  locale === "ur"
    ? `COALESCE(${alias}.name_ur, ${alias}.name)`
    : `${alias}.name`;

// Same status semantics as the listing, the bulk preview and the DCV resolver.
// An exact 'active' match silently drops rules stored as 'ACTIVE' / ' active '.
const whereActive = (query, column = "status") =>
  query.whereRaw(`lower(trim(coalesce(${column}, ''))) = 'active'`);

/**
 * Departments where the source labour has active rate rules, with counts.
 * Drives the Department dropdown so it can never produce an empty preview.
 */
const fetchSourceDepartments = async ({
  db = knex,
  sourceLabourId,
  locale = "en",
}) => {
  const source = toPositiveIntOrNull(sourceLabourId);
  if (!source) return [];

  const rows = await whereActive(
    db(`${TABLE} as r`)
      .join("erp.departments as d", "d.id", "r.dept_id")
      .where({ "r.labour_id": source, "r.applies_to_all_labours": false }),
    "r.status",
  )
    .groupBy("d.id")
    .select(
      "d.id as dept_id",
      db.raw(`${localizedName("d", locale)} as dept_name`),
      db.raw("count(*) FILTER (WHERE r.sku_id IS NOT NULL)::int as rule_count"),
      db.raw("count(*) FILTER (WHERE r.sku_id IS NULL)::int as scope_wide_count"),
      db.raw(
        "array_agg(DISTINCT upper(trim(coalesce(r.rate_type, '')))) as rate_types",
      ),
    )
    .orderBy("dept_name", "asc");

  return rows.map((row) => ({
    dept_id: Number(row.dept_id),
    dept_name: row.dept_name || "",
    rule_count: Number(row.rule_count || 0),
    scope_wide_count: Number(row.scope_wide_count || 0),
    rate_types: (row.rate_types || []).filter(Boolean),
  }));
};

/**
 * Every active rule the source labour has in one department, split into what
 * can be copied (sku-pinned) and what cannot (scope-wide fallbacks).
 * One query — the joins carry the labels the preview needs.
 */
const fetchCopyableRules = async ({
  db = knex,
  sourceLabourId,
  deptId,
  locale = "en",
}) => {
  const source = toPositiveIntOrNull(sourceLabourId);
  const dept = toPositiveIntOrNull(deptId);
  if (!source || !dept) return { copyable: [], scopeWide: [] };

  const rows = await whereActive(
    db(`${TABLE} as r`)
      .leftJoin("erp.skus as s", "s.id", "r.sku_id")
      .leftJoin("erp.variants as v", "v.id", "s.variant_id")
      .leftJoin("erp.items as i", "i.id", "v.item_id")
      .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
      .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
      .leftJoin("erp.product_subgroups as sg_rule", "sg_rule.id", "r.subgroup_id")
      .leftJoin("erp.product_groups as pg_rule", "pg_rule.id", "r.group_id")
      .where({
        "r.labour_id": source,
        "r.dept_id": dept,
        "r.applies_to_all_labours": false,
      }),
    "r.status",
  )
    .select(
      "r.id as rule_id",
      "r.sku_id",
      "r.apply_on",
      "r.rate_type",
      "r.rate_value",
      "s.sku_code",
      "i.item_type",
      "i.subgroup_id",
      "i.group_id",
      db.raw(`${localizedName("i", locale)} as item_name`),
      db.raw(`${localizedName("sg", locale)} as subgroup_name`),
      db.raw(`${localizedName("pg", locale)} as group_name`),
      db.raw(`${localizedName("sg_rule", locale)} as rule_subgroup_name`),
      db.raw(`${localizedName("pg_rule", locale)} as rule_group_name`),
    )
    .orderBy("s.sku_code", "asc");

  const copyable = [];
  const scopeWide = [];

  (rows || []).forEach((row) => {
    const skuId = toPositiveIntOrNull(row.sku_id);
    if (!skuId) {
      // A rule with no sku_id is a scope-wide fallback. The approval applier
      // drops rows without a sku_id, so it cannot ride a copy payload.
      scopeWide.push({
        rule_id: Number(row.rule_id),
        apply_on: String(row.apply_on || "").toUpperCase(),
        scope_name: row.rule_subgroup_name || row.rule_group_name || "",
        rate_type: normalizeRateType(row.rate_type),
        rate_value: toMoney(row.rate_value),
      });
      return;
    }
    // Defensive: a rule can outlive its sku/item rows via a stale reference.
    if (!row.sku_code) return;
    copyable.push({
      rule_id: Number(row.rule_id),
      sku_id: skuId,
      sku_code: row.sku_code || "",
      item_name: row.item_name || "",
      item_type: String(row.item_type || "").toUpperCase(),
      subgroup_id: toPositiveIntOrNull(row.subgroup_id),
      subgroup_name: row.subgroup_name || "",
      group_id: toPositiveIntOrNull(row.group_id),
      group_name: row.group_name || "",
      rate_type: normalizeRateType(row.rate_type),
      rate_value: toMoney(row.rate_value),
    });
  });

  return { copyable, scopeWide };
};

/**
 * Split the requested targets into ones that can legally receive the copy and
 * ones that cannot. A target not assigned to the department must be caught
 * here: the approval applier re-resolves labour ids at apply time and would
 * otherwise fail the whole approved request long after the user clicked.
 */
const resolveTargetLabours = async ({
  db = knex,
  targetLabourIds,
  deptId,
  sourceLabourId,
  allowedBranchIds = [],
  locale = "en",
}) => {
  const requested = toPositiveIntArray(targetLabourIds).filter(
    (id) => id !== toPositiveIntOrNull(sourceLabourId),
  );
  if (!requested.length) return { allowed: [], blocked: [] };

  const dept = toPositiveIntOrNull(deptId);
  const branchList = toPositiveIntArray(allowedBranchIds);

  const rows = await db("erp.labours as l")
    .whereIn("l.id", requested)
    .select(
      "l.id",
      db.raw(`${localizedName("l", locale)} as name`),
      db.raw("lower(trim(coalesce(l.status, ''))) = 'active' as is_active"),
      db.raw(
        `EXISTS (
           SELECT 1 FROM erp.labour_department ld
           WHERE ld.labour_id = l.id AND ld.dept_id = ?
         ) OR l.dept_id = ? as in_department`,
        [dept, dept],
      ),
      branchList.length
        ? db.raw(
            `EXISTS (
               SELECT 1 FROM erp.labour_branch lb
               WHERE lb.labour_id = l.id AND lb.branch_id = ANY(?::bigint[])
             ) as in_branch_scope`,
            [branchList],
          )
        : db.raw("true as in_branch_scope"),
    )
    .orderBy("name", "asc");

  const allowed = [];
  const blocked = [];
  const seen = new Set();

  (rows || []).forEach((row) => {
    const id = Number(row.id);
    seen.add(id);
    const entry = { labour_id: id, labour_name: row.name || "" };
    if (!row.in_branch_scope) {
      blocked.push({ ...entry, reason: BLOCK_REASON.OUT_OF_SCOPE });
      return;
    }
    if (!row.is_active) {
      blocked.push({ ...entry, reason: BLOCK_REASON.INACTIVE });
      return;
    }
    if (!row.in_department) {
      blocked.push({ ...entry, reason: BLOCK_REASON.NOT_ASSIGNED });
      return;
    }
    allowed.push(entry);
  });

  requested.forEach((id) => {
    if (!seen.has(id)) {
      blocked.push({
        labour_id: id,
        labour_name: "",
        reason: BLOCK_REASON.OUT_OF_SCOPE,
      });
    }
  });

  return { allowed, blocked };
};

const buildFacets = (copyable) => {
  const groups = new Map();
  const subgroups = new Map();
  const articleTypes = new Map();

  copyable.forEach((rule) => {
    if (rule.group_id) {
      const entry = groups.get(rule.group_id) || {
        value: rule.group_id,
        label: rule.group_name,
        count: 0,
      };
      entry.count += 1;
      groups.set(rule.group_id, entry);
    }
    if (rule.subgroup_id) {
      const entry = subgroups.get(rule.subgroup_id) || {
        value: rule.subgroup_id,
        label: rule.subgroup_name,
        count: 0,
      };
      entry.count += 1;
      subgroups.set(rule.subgroup_id, entry);
    }
    if (rule.item_type) {
      articleTypes.set(
        rule.item_type,
        (articleTypes.get(rule.item_type) || 0) + 1,
      );
    }
  });

  const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));

  return {
    groups: [...groups.values()].sort(byLabel),
    subgroups: [...subgroups.values()].sort(byLabel),
    articles: copyable.map((rule) => ({
      value: rule.sku_id,
      label: rule.sku_code,
      item_name: rule.item_name,
    })),
    article_types: [...articleTypes.entries()].map(([value, count]) => ({
      value,
      count,
    })),
  };
};

const applyFilters = (copyable, filters = {}) => {
  const articleType = normalizeArticleTypeFilter(filters.articleType);
  const groupIds = new Set(toPositiveIntArray(filters.groupIds));
  const subgroupIds = new Set(toPositiveIntArray(filters.subgroupIds));
  const skuIds = new Set(toPositiveIntArray(filters.skuIds));

  return copyable.filter((rule) => {
    if (articleType !== ARTICLE_TYPE.BOTH && rule.item_type !== articleType)
      return false;
    if (groupIds.size && !groupIds.has(rule.group_id)) return false;
    if (subgroupIds.size && !subgroupIds.has(rule.subgroup_id)) return false;
    if (skuIds.size && !skuIds.has(rule.sku_id)) return false;
    return true;
  });
};

/**
 * The authoritative plan. The route rebuilds this server-side on save and
 * ignores whatever the client sent, so a stale or tampered browser payload can
 * never write something the preview did not show.
 */
const buildCopyPlan = async ({
  db = knex,
  sourceLabourId,
  targetLabourIds,
  deptId,
  filters = {},
  conflictMode,
  allowedBranchIds = [],
  locale = "en",
}) => {
  const source = toPositiveIntOrNull(sourceLabourId);
  const dept = toPositiveIntOrNull(deptId);
  const mode = normalizeConflictMode(conflictMode);

  const empty = {
    rows: [],
    targets: [],
    blocked_targets: [],
    scope_wide_skipped: [],
    facets: { groups: [], subgroups: [], articles: [], article_types: [] },
    rate_types: [],
    counts: {
      articles: 0,
      articles_after_filter: 0,
      new: 0,
      conflict: 0,
      identical: 0,
      writes: 0,
    },
    conflict_mode: mode,
    over_limit: false,
    limit: MAX_COPY_ROWS,
  };

  if (!source || !dept) return empty;

  const [{ copyable, scopeWide }, targetResolution] = await Promise.all([
    fetchCopyableRules({ db, sourceLabourId: source, deptId: dept, locale }),
    resolveTargetLabours({
      db,
      targetLabourIds,
      deptId: dept,
      sourceLabourId: source,
      allowedBranchIds,
      locale,
    }),
  ]);

  const facets = buildFacets(copyable);
  const filtered = applyFilters(copyable, filters);
  const targets = targetResolution.allowed;

  const base = {
    ...empty,
    targets,
    blocked_targets: targetResolution.blocked,
    scope_wide_skipped: scopeWide,
    facets,
    counts: { ...empty.counts, articles: copyable.length },
  };

  if (!filtered.length || !targets.length) {
    return {
      ...base,
      counts: {
        ...base.counts,
        articles_after_filter: filtered.length,
      },
      rate_types: [...new Set(filtered.map((rule) => rule.rate_type))],
    };
  }

  if (filtered.length * targets.length > MAX_COPY_ROWS) {
    return {
      ...base,
      counts: {
        ...base.counts,
        articles_after_filter: filtered.length,
      },
      rate_types: [...new Set(filtered.map((rule) => rule.rate_type))],
      over_limit: true,
    };
  }

  // One query for every target's current rate on the articles in scope.
  // Keyed lookups below — never a scan per row.
  const skuIds = filtered.map((rule) => rule.sku_id);
  const existingRows = await whereActive(
    db(TABLE)
      .where({ dept_id: dept, applies_to_all_labours: false })
      .whereIn(
        "labour_id",
        targets.map((target) => target.labour_id),
      )
      .whereIn("sku_id", skuIds),
  ).select("labour_id", "sku_id", "rate_type", "rate_value");

  const existingByKey = new Map();
  (existingRows || []).forEach((row) => {
    existingByKey.set(`${Number(row.labour_id)}:${Number(row.sku_id)}`, {
      rate_value: toMoney(row.rate_value),
      rate_type: normalizeRateType(row.rate_type),
    });
  });

  let newCount = 0;
  let conflictCount = 0;
  let identicalCount = 0;
  let writes = 0;

  const rows = filtered.map((rule) => {
    const cells = targets.map((target) => {
      const current = existingByKey.get(`${target.labour_id}:${rule.sku_id}`);
      let state = ROW_STATE.NEW;
      if (current) {
        state =
          current.rate_value === rule.rate_value &&
          current.rate_type === rule.rate_type
            ? ROW_STATE.IDENTICAL
            : ROW_STATE.CONFLICT;
      }

      if (state === ROW_STATE.NEW) newCount += 1;
      else if (state === ROW_STATE.CONFLICT) conflictCount += 1;
      else identicalCount += 1;

      // IDENTICAL never writes: the target already holds this exact rate and
      // type, so even Overwrite has nothing to change. Keeps the approval list
      // to real changes only.
      const willWrite =
        state === ROW_STATE.NEW ||
        (state === ROW_STATE.CONFLICT && mode === CONFLICT_MODE.OVERWRITE);
      if (willWrite) writes += 1;

      return {
        labour_id: target.labour_id,
        labour_name: target.labour_name,
        current_rate: current ? current.rate_value : null,
        current_rate_type: current ? current.rate_type : null,
        state,
        will_write: willWrite,
      };
    });

    return {
      sku_id: rule.sku_id,
      sku_code: rule.sku_code,
      item_name: rule.item_name,
      item_type: rule.item_type,
      group_id: rule.group_id,
      subgroup_id: rule.subgroup_id,
      rate_type: rule.rate_type,
      rate_value: rule.rate_value,
      targets: cells,
    };
  });

  return {
    ...base,
    rows,
    rate_types: [...new Set(filtered.map((rule) => rule.rate_type))],
    counts: {
      articles: copyable.length,
      articles_after_filter: filtered.length,
      new: newCount,
      conflict: conflictCount,
      identical: identicalCount,
      writes,
    },
  };
};

/**
 * Flatten a plan into the write list for one rate type, honouring the conflict
 * mode. Also the exact row set that goes into the approval payload, so what an
 * approver sees is what gets written.
 */
const buildWriteRows = ({ plan, rateType }) => {
  const wanted = normalizeRateType(rateType);
  const rows = [];
  (plan?.rows || []).forEach((row) => {
    if (row.rate_type !== wanted) return;
    row.targets.forEach((cell) => {
      if (!cell.will_write) return;
      rows.push({
        labour_id: cell.labour_id,
        sku_id: row.sku_id,
        sku_code: row.sku_code,
        item_name: row.item_name,
        previous_rate: cell.current_rate,
        new_rate: row.rate_value,
        rate_type: wanted,
      });
    });
  });
  return rows;
};

const chunk = (items, size) => {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

/**
 * Chunked ON CONFLICT upsert.
 *
 * The supporting unique index is PARTIAL
 * (uq_labour_rate_rules_labour_dept_sku ... WHERE applies_to_all_labours =
 * false AND labour_id IS NOT NULL AND sku_id IS NOT NULL), so the ON CONFLICT
 * clause has to repeat that predicate or Postgres cannot infer the index.
 * knex's .onConflict() cannot express an index predicate — hence raw SQL.
 *
 * SKIP -> DO NOTHING, OVERWRITE -> DO UPDATE. Both are idempotent, which also
 * settles the race where a rate is added to a target between preview and
 * approval: the outcome still matches the mode the approver signed off on.
 */
const applyCopy = async ({
  trx,
  deptId,
  rows,
  conflictMode,
  status = "active",
}) => {
  const dept = toPositiveIntOrNull(deptId);
  const mode = normalizeConflictMode(conflictMode);
  const writable = (rows || [])
    .map((row) => ({
      labourId: toPositiveIntOrNull(row.labour_id ?? row.labourId),
      skuId: toPositiveIntOrNull(row.sku_id ?? row.skuId),
      rateType: normalizeRateType(row.rate_type ?? row.rateType),
      rateValue: toMoney(row.new_rate ?? row.rate_value ?? row.rateValue),
    }))
    .filter(
      (row) => row.labourId && row.skuId && row.rateValue !== null && dept,
    );

  if (!writable.length) return { created: 0, updated: 0, skipped: 0 };

  const conflictAction =
    mode === CONFLICT_MODE.OVERWRITE
      ? `DO UPDATE SET
           rate_type = EXCLUDED.rate_type,
           rate_value = EXCLUDED.rate_value,
           status = EXCLUDED.status,
           apply_on = 'SKU',
           subgroup_id = NULL,
           group_id = NULL`
      : "DO NOTHING";

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const batch of chunk(writable, CHUNK_SIZE)) {
    const placeholders = batch
      .map(() => "(?::bigint, ?::bigint, ?::bigint, ?::text, ?::numeric, ?::text)")
      .join(", ");
    const bindings = [];
    batch.forEach((row) => {
      bindings.push(
        row.labourId,
        dept,
        row.skuId,
        row.rateType,
        row.rateValue,
        status,
      );
    });

    const result = await trx.raw(
      `INSERT INTO ${TABLE}
         (applies_to_all_labours, labour_id, dept_id, apply_on, sku_id,
          subgroup_id, group_id, rate_type, rate_value, status)
       SELECT false, v.labour_id, v.dept_id, 'SKU', v.sku_id,
              NULL, NULL, v.rate_type, v.rate_value, v.status
       FROM (VALUES ${placeholders})
         AS v(labour_id, dept_id, sku_id, rate_type, rate_value, status)
       ON CONFLICT (labour_id, dept_id, sku_id)
         WHERE applies_to_all_labours = false
           AND labour_id IS NOT NULL
           AND sku_id IS NOT NULL
       ${conflictAction}
       RETURNING (xmax::text = '0') AS inserted`,
      bindings,
    );

    const returned = result?.rows || [];
    returned.forEach((row) => {
      if (row.inserted) created += 1;
      else updated += 1;
    });
    skipped += batch.length - returned.length;
  }

  return { created, updated, skipped };
};

module.exports = {
  ARTICLE_TYPE,
  CONFLICT_MODE,
  ROW_STATE,
  BLOCK_REASON,
  MAX_COPY_ROWS,
  normalizeArticleTypeFilter,
  normalizeConflictMode,
  normalizeRateType,
  toPositiveIntArray,
  toPositiveIntOrNull,
  fetchSourceDepartments,
  fetchCopyableRules,
  resolveTargetLabours,
  buildCopyPlan,
  buildWriteRows,
  applyCopy,
};
