// One-time data change: put every APPROVED semi-finished (SFG) BOM on the same
// production routing.
//
//   1  CUTTING
//      … any stage that runs BEFORE printing today keeps that slot (edging,
//        embroidery — pre-printing operations, not post-upper ones)
//      PRINTING
//      UPPER
//      … every other stage, in its current relative order
//   n  DC PROI                                                   <- always last
//
// and drop the STITCHING route entirely.
//
// Writes straight to erp.bom_stage_routing rather than going through
// bom/service.js: that path rewrites every line of a BOM and raises one approval
// request per BOM, which is the wrong shape for a bulk routing correction. The
// change IS recorded in erp.bom_change_log (sections "stage_routes" and
// "sfg_lines") so the BOM Change Log report still explains where the rows came
// from.
//
// TWO CONSEQUENCES TO SAY OUT LOUD BEFORE --apply:
//
//   1. Stock creation moves to DC PROI. production-voucher-service treats the
//      highest-sequence REQUIRED route as the final stage, and the final stage is
//      where WIP is converted into real SFG stock (isFinalRequiredStage ->
//      applySkuStockInTx). After this run, SFG stock only exists once production
//      is posted at DC PROI.
//   2. Any WIP still sitting at the stitching department is stranded -- those
//      pairs have no forward route once STITCHING is gone. The script proceeds
//      anyway (by decision) and prints the open pair count per article.
//
// It also moves RM and labour lines off the stitching DEPARTMENT onto UPPER.
// bom_rm_line.dept_id / bom_labour_line.dept_id are NOT NULL and department-keyed,
// so a line left on stitching survives but is never issued and never costed once
// no stage routes there. A line whose target slot on UPPER is already occupied
// would duplicate the material, so it is reported and left alone instead.
//
// What it does NOT touch:
//   - is_required / enforce_sequence on existing routes. Only sequence_no moves.
//     Newly inserted UPPER / DC PROI rows get required = true, follow sequence = true.
//   - BOMs missing CUTTING or PRINTING, and BOMs with no stage routing at all
//     (reported as REVIEW; pass --allow-missing-anchors to include them).
//   - FINISHED BOMs, drafts, pending and rejected BOMs.
//
// It DOES re-point erp.bom_sfg_line.consumed_in_stage_id from STITCHING to UPPER.
// That value is validated against the BOM's own mapped stages in bom/service.js,
// so leaving it would make the BOM fail validation on its next save.
//
// Dry run by default; nothing is committed without --apply:
//   node src/scripts/reorder-sfg-bom-stages.js           # preview
//   node src/scripts/reorder-sfg-bom-stages.js --apply   # write
//
// Useful flags:
//   --cutting-stage=NAME      first stage            (default "CUTTING")
//   --printing-stage=NAME     second stage           (default "PRINTING")
//   --upper-stage=NAME        third stage            (default "UPPER")
//   --stitching-stage=NAME    stage to remove        (default "STITCHING")
//   --final-stage=NAME        last stage             (default "DC PROI")
//   --<role>-stage-id=N       pick a stage by id when the name is ambiguous
//   --bom=12,34               limit to these bom_header ids (rehearsal)
//   --changed-by=N            user id for the change log (default: the BOM's own
//                             approver, else its creator)
//   --allow-missing-anchors   also reorder BOMs that have no CUTTING or PRINTING
//   --no-insert-upper         do not create a missing UPPER route
//   --no-insert-final         do not create a missing DC PROI route

const knex = require("../db/knex");
const { buildChangeRows } = require("../utils/bom-change-log");

const TAG = "[reorder-sfg-bom-stages]";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const flagValue = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
};
const toPositiveInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

const APPLY = hasFlag("apply") || process.env.APPLY === "1";
const CHANGED_BY = toPositiveInt(flagValue("changed-by"));
const ALLOW_MISSING_ANCHORS = hasFlag("allow-missing-anchors");
const INSERT_UPPER = !hasFlag("no-insert-upper");
const INSERT_FINAL = !hasFlag("no-insert-final");
const ONLY_BOM_IDS = String(flagValue("bom", ""))
  .split(",")
  .map((part) => toPositiveInt(part))
  .filter(Boolean);

// Role -> how the stage is resolved and how strictly it is checked. UPPER and
// DC PROI may be INSERTED, so their department has to be a live production one;
// the other three are only matched against existing routes, so an already
// deactivated stage is still fine to pin or delete.
const STAGE_ROLES = [
  { key: "cutting", label: "CUTTING", flag: "cutting-stage", fallback: "CUTTING", allowInactive: true, requireProductionDept: false },
  { key: "printing", label: "PRINTING", flag: "printing-stage", fallback: "PRINTING", allowInactive: true, requireProductionDept: false },
  { key: "upper", label: "UPPER", flag: "upper-stage", fallback: "UPPER", allowInactive: false, requireProductionDept: true },
  { key: "stitching", label: "STITCHING", flag: "stitching-stage", fallback: "STITCHING", allowInactive: true, requireProductionDept: false },
  { key: "final", label: "FINAL", flag: "final-stage", fallback: "DC PROI", allowInactive: false, requireProductionDept: true },
];

// Thrown to unwind the transaction after a successful dry run.
const ROLLBACK = Symbol("dry-run");

class AbortError extends Error {}

const stageQuery = (trx) =>
  trx("erp.production_stages as ps")
    .leftJoin("erp.departments as d", "d.id", "ps.dept_id")
    .select(
      "ps.id",
      "ps.code",
      "ps.name",
      "ps.is_active",
      "ps.dept_id",
      "d.name as dept_name",
      "d.is_active as dept_is_active",
      "d.is_production as dept_is_production",
    );

const describeStage = (row) =>
  `id=${row.id} code=${row.code} name="${row.name}" dept="${row.dept_name || "?"}" (dept_id=${row.dept_id})`;

// Stage rows are auto-created from departments by bom/service.js, so `name` is
// the department name and `code` is usually DEPT-<id>; match on either.
const resolveStage = async (trx, { label, flag, explicitId, needle, allowInactive }) => {
  if (explicitId) {
    const row = await stageQuery(trx).where("ps.id", explicitId).first();
    if (!row) {
      throw new AbortError(
        `${label}: no erp.production_stages row with id ${explicitId}.`,
      );
    }
    return row;
  }

  const norm = String(needle || "").trim().toUpperCase();
  if (!norm) throw new AbortError(`${label}: empty stage name.`);

  const exact = await stageQuery(trx)
    .modify((qb) => {
      if (!allowInactive) qb.where("ps.is_active", true);
    })
    .andWhere((qb) =>
      qb
        .whereRaw("upper(trim(ps.name)) = ?", [norm])
        .orWhereRaw("upper(trim(ps.code)) = ?", [norm]),
    );

  if (exact.length === 1) return exact[0];

  if (exact.length > 1) {
    throw new AbortError(
      [
        `${label}: "${needle}" matches ${exact.length} stages, refusing to guess.`,
        ...exact.map((row) => `    ${describeStage(row)}`),
        `  Re-run with --${flag}-id=<id>.`,
      ].join("\n"),
    );
  }

  // Nothing matched. Say exactly what does exist so the fix is obvious.
  const fuzzy = await stageQuery(trx).whereRaw("upper(ps.name) like ?", [
    `%${norm}%`,
  ]);
  const dept = await trx("erp.departments")
    .select("id", "name", "is_active", "is_production")
    .whereRaw("upper(trim(name)) = ?", [norm])
    .first();

  const lines = [
    `${label}: no production stage named "${needle}" exists. Nothing was changed.`,
  ];
  if (fuzzy.length) {
    lines.push("  Similar stages:");
    fuzzy.forEach((row) => lines.push(`    ${describeStage(row)}`));
  }
  if (dept) {
    lines.push(
      `  A department "${dept.name}" (id=${dept.id}, active=${dept.is_active}, production=${dept.is_production}) does exist,`,
      "  but no production stage is mapped to it yet. Stages are created from",
      "  departments the first time one is used on a BOM's Stage Routing tab.",
    );
  } else {
    lines.push(
      `  No department named "${needle}" exists either -- create the department`,
      "  (Production = yes) and use it on one BOM first, then re-run this script.",
    );
  }
  lines.push("  Stages on this database:");
  const all = await stageQuery(trx).orderBy("ps.name", "asc");
  all.forEach((row) =>
    lines.push(`    ${describeStage(row)}${row.is_active ? "" : "  [INACTIVE]"}`),
  );
  throw new AbortError(lines.join("\n"));
};

const assertUsableStage = (row, { label, allowInactive, requireProductionDept }) => {
  if (!allowInactive && row.is_active !== true) {
    throw new AbortError(
      `${label}: stage ${describeStage(row)} is INACTIVE. Reactivate it first.`,
    );
  }
  if (!requireProductionDept) return;
  if (row.dept_is_active !== true || row.dept_is_production !== true) {
    throw new AbortError(
      [
        `${label}: department "${row.dept_name}" (id=${row.dept_id}) is`,
        `  active=${row.dept_is_active}, production=${row.dept_is_production}.`,
        "  A stage route on a non-production or inactive department is invisible",
        "  to the BOM form and to production vouchers. Fix the department first.",
      ].join("\n"),
    );
  }
};

// Same column list and ordering as getBomSnapshot() in bom/service.js, so the
// change-log payloads read identically to ones written by the BOM screen.
const snapshotRoute = (row) => ({
  stage_id: row.stage_id,
  sequence_no: row.sequence_no,
  is_required: row.is_required,
  enforce_sequence: row.enforce_sequence,
  dept_id: row.dept_id,
  dept_name: row.dept_name,
});

const snapshotRmLine = (row, deptId) => ({
  rm_item_id: row.rm_item_id,
  color_id: row.color_id,
  size_id: row.size_id,
  dept_id: deptId === undefined ? row.dept_id : deptId,
  qty: row.qty,
  uom_id: row.uom_id,
  normal_loss_pct: row.normal_loss_pct,
});

const snapshotLabourLine = (row, deptId) => ({
  size_scope: row.size_scope,
  size_id: row.size_id,
  dept_id: deptId === undefined ? row.dept_id : deptId,
  labour_id: row.labour_id,
  rate_type: row.rate_type,
  rate_value: row.rate_value,
});

const snapshotSfgLine = (row) => ({
  fg_size_id: row.fg_size_id,
  sfg_sku_id: row.sfg_sku_id,
  required_qty: row.required_qty,
  uom_id: row.uom_id,
  consumed_in_stage_id: row.consumed_in_stage_id,
  ref_approved_bom_id: row.ref_approved_bom_id,
});

// erp.bom_stage_routing carries a non-deferrable UNIQUE (bom_id, sequence_no), so
// a straight renumber trips a spurious violation part-way through the statement.
// Every write here is therefore parked above the BOM's current max sequence first
// and only then brought down to its final 1..n slot.
const applySequenceBatch = async (trx, rows) => {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk
      .map(() => "(?::bigint, ?::bigint, ?::int)")
      .join(", ");
    const bindings = [];
    chunk.forEach((row) => {
      bindings.push(row.bom_id, row.stage_id, row.sequence_no);
    });
    // eslint-disable-next-line no-await-in-loop
    await trx.raw(
      `UPDATE erp.bom_stage_routing AS bsr
          SET sequence_no = v.sequence_no
         FROM (VALUES ${placeholders}) AS v(bom_id, stage_id, sequence_no)
        WHERE bsr.bom_id = v.bom_id
          AND bsr.stage_id = v.stage_id`,
      bindings,
    );
  }
};

const run = async (trx) => {
  const stages = {};
  for (const role of STAGE_ROLES) {
    // eslint-disable-next-line no-await-in-loop
    const row = await resolveStage(trx, {
      label: role.label,
      flag: role.flag,
      explicitId: toPositiveInt(flagValue(`${role.flag}-id`)),
      needle: flagValue(role.flag, role.fallback),
      allowInactive: role.allowInactive,
    });
    assertUsableStage(row, {
      label: role.label,
      allowInactive: role.allowInactive,
      requireProductionDept: role.requireProductionDept,
    });
    stages[role.key] = row;
  }

  const seenIds = new Map();
  STAGE_ROLES.forEach((role) => {
    const id = Number(stages[role.key].id);
    if (seenIds.has(id)) {
      throw new AbortError(
        `${role.label} and ${seenIds.get(id)} both resolve to the same stage ` +
          `(${describeStage(stages[role.key])}). Disambiguate with --<role>-stage-id=<id>.`,
      );
    }
    seenIds.set(id, role.label);
  });

  STAGE_ROLES.forEach((role) => {
    console.log(
      `${TAG} ${String(role.label).padEnd(9)} -> ${describeStage(stages[role.key])}`,
    );
  });
  console.log("");

  let bomQuery = trx("erp.bom_header as bh")
    .join("erp.items as i", "i.id", "bh.item_id")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.item_id",
      "bh.version_no",
      "bh.approved_by",
      "bh.created_by",
      "i.name as item_name",
    )
    .where("bh.level", "SEMI_FINISHED")
    .andWhere("bh.status", "APPROVED")
    .orderBy([
      { column: "i.name", order: "asc" },
      { column: "bh.version_no", order: "asc" },
    ]);
  if (ONLY_BOM_IDS.length) bomQuery = bomQuery.whereIn("bh.id", ONLY_BOM_IDS);
  const boms = await bomQuery;

  if (!boms.length) {
    console.log(`${TAG} No APPROVED semi-finished BOMs found. Nothing to do.`);
    return;
  }

  const bomIds = boms.map((row) => Number(row.id));
  const itemIds = [...new Set(boms.map((row) => Number(row.item_id)))];

  // Production reads the highest approved version per item, so older approved
  // versions are inert. They are still updated (the ask was "all approved"), but
  // flagged so the counts are not surprising.
  const latestVersionByItem = new Map();
  boms.forEach((row) => {
    const itemId = Number(row.item_id);
    const version = Number(row.version_no || 0);
    if (version > Number(latestVersionByItem.get(itemId) || 0)) {
      latestVersionByItem.set(itemId, version);
    }
  });

  const routeRows = await trx("erp.bom_stage_routing as bsr")
    .leftJoin("erp.production_stages as ps", "ps.id", "bsr.stage_id")
    .leftJoin("erp.departments as dept", "dept.id", "ps.dept_id")
    .select(
      "bsr.bom_id",
      "bsr.stage_id",
      "bsr.sequence_no",
      "bsr.is_required",
      "bsr.enforce_sequence",
      "ps.dept_id",
      "ps.name as stage_name",
      "dept.name as dept_name",
    )
    .whereIn("bsr.bom_id", bomIds)
    .orderBy([
      { column: "bsr.bom_id", order: "asc" },
      { column: "bsr.sequence_no", order: "asc" },
    ]);

  const routesByBom = new Map();
  routeRows.forEach((row) => {
    const key = Number(row.bom_id);
    if (!routesByBom.has(key)) routesByBom.set(key, []);
    routesByBom.get(key).push(row);
  });

  const sfgLineRows = await trx("erp.bom_sfg_line")
    .select(
      "id",
      "bom_id",
      "fg_size_id",
      "sfg_sku_id",
      "required_qty",
      "uom_id",
      "consumed_in_stage_id",
      "ref_approved_bom_id",
    )
    .whereIn("bom_id", bomIds)
    .orderBy("id", "asc");
  const sfgLinesByBom = new Map();
  sfgLineRows.forEach((row) => {
    const key = Number(row.bom_id);
    if (!sfgLinesByBom.has(key)) sfgLinesByBom.set(key, []);
    sfgLinesByBom.get(key).push(row);
  });

  // Lines parked on the stitching DEPARTMENT. They move to UPPER, except where
  // UPPER already holds the same line -- moving that one would duplicate the
  // material rather than relocate it. NULL matches NULL here on purpose: the
  // table's UNIQUE constraint treats NULLs as distinct, so a clashing pair would
  // insert cleanly and silently double the consumption.
  const loadDeptLines = async (table, columns, keyOf) => {
    const rows = await trx(table)
      .select("id", "bom_id", "dept_id", ...columns)
      .whereIn("bom_id", bomIds)
      .whereIn("dept_id", [stages.stitching.dept_id, stages.upper.dept_id]);
    const onStitching = new Map();
    const upperKeys = new Set();
    rows.forEach((row) => {
      if (Number(row.dept_id) === Number(stages.upper.dept_id)) {
        upperKeys.add(`${row.bom_id}|${keyOf(row)}`);
        return;
      }
      const key = Number(row.bom_id);
      if (!onStitching.has(key)) onStitching.set(key, []);
      onStitching.get(key).push(row);
    });
    return { onStitching, upperKeys, keyOf };
  };
  const nz = (value) => (value === null || value === undefined ? "~" : value);
  const stitchRm = await loadDeptLines(
    "erp.bom_rm_line",
    ["rm_item_id", "color_id", "size_id", "qty", "uom_id", "normal_loss_pct"],
    (row) => `${row.rm_item_id}|${nz(row.color_id)}|${nz(row.size_id)}`,
  );
  const stitchLabour = await loadDeptLines(
    "erp.bom_labour_line",
    ["size_scope", "size_id", "labour_id", "rate_type", "rate_value"],
    (row) =>
      `${row.labour_id}|${nz(row.size_scope)}|${nz(row.size_id)}|${nz(row.rate_type)}`,
  );

  // Open WIP is keyed by sku, so it resolves per ARTICLE, not per BOM version.
  const wipRows = await trx("erp.wip_dept_ledger as wl")
    .join("erp.skus as s", "s.id", "wl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .select("v.item_id")
    .select(trx.raw("SUM(wl.direction * wl.qty_pairs)::int AS open_pairs"))
    .where("wl.dept_id", stages.stitching.dept_id)
    .whereIn("v.item_id", itemIds)
    .groupBy("v.item_id");
  const stitchWipByItem = new Map(
    wipRows
      .filter((row) => Number(row.open_pairs || 0) > 0)
      .map((row) => [Number(row.item_id), Number(row.open_pairs)]),
  );

  // A pending "update" request carries the whole form payload captured at SUBMIT
  // time. Approving it runs saveBomDraftTx -> replaceBomLines, which DELETEs every
  // bom_stage_routing row for the BOM and re-inserts only what the payload holds --
  // silently undoing everything below. Other actions do not rewrite these rows.
  const pendingRows = await trx("erp.approval_request")
    .select("id", "entity_id")
    .select(trx.raw("COALESCE(new_value ->> '_action', '') AS pending_action"))
    .where({ entity_type: "BOM", status: "PENDING" })
    .whereIn("entity_id", bomIds.map(String));
  const pendingByBomId = new Map();
  pendingRows.forEach((row) => {
    const key = String(row.entity_id);
    if (!pendingByBomId.has(key)) pendingByBomId.set(key, []);
    pendingByBomId.get(key).push(row);
  });
  const CLOBBERING_ACTIONS = new Set(["update", "create"]);

  const splitMovable = (source, bomId) => {
    const move = [];
    const blocked = [];
    (source.onStitching.get(bomId) || []).forEach((row) => {
      if (source.upperKeys.has(`${bomId}|${source.keyOf(row)}`)) blocked.push(row);
      else move.push(row);
    });
    return { move, blocked };
  };

  const plans = boms.map((bom) => {
    const bomId = Number(bom.id);
    const routes = routesByBom.get(bomId) || [];
    const pending = pendingByBomId.get(String(bomId)) || [];
    const base = {
      bom,
      bomId,
      routes,
      isLatestVersion:
        Number(bom.version_no || 0) ===
        Number(latestVersionByItem.get(Number(bom.item_id)) || 0),
      rm: splitMovable(stitchRm, bomId),
      labour: splitMovable(stitchLabour, bomId),
      stitchWipPairs: Number(stitchWipByItem.get(Number(bom.item_id)) || 0),
      clobberingRequests: pending.filter((row) =>
        CLOBBERING_ACTIONS.has(String(row.pending_action || "").toLowerCase()),
      ),
      otherPendingActions: pending
        .map((row) => String(row.pending_action || "?").toLowerCase())
        .filter((action) => !CLOBBERING_ACTIONS.has(action)),
      desired: [],
      inserts: [],
      deleteStageIds: [],
      repointSfg: false,
      // Only BOMs that end up routed through UPPER can take the stitching lines.
      movesLines: false,
    };

    if (!routes.length) {
      return { ...base, action: "REVIEW", note: "BOM has no stage routing" };
    }

    const byStage = (stage) =>
      routes.find((row) => Number(row.stage_id) === Number(stage.id)) || null;
    const cuttingRoute = byStage(stages.cutting);
    const printingRoute = byStage(stages.printing);
    if (!ALLOW_MISSING_ANCHORS && (!cuttingRoute || !printingRoute)) {
      const missing = [
        cuttingRoute ? null : stages.cutting.name,
        printingRoute ? null : stages.printing.name,
      ].filter(Boolean);
      return {
        ...base,
        action: "REVIEW",
        note: `no ${missing.join(" and ")} route (use --allow-missing-anchors)`,
      };
    }

    const stitchingRoute = byStage(stages.stitching);
    const survivors = routes.filter(
      (row) => Number(row.stage_id) !== Number(stages.stitching.id),
    );

    const pinnedIds = new Set(
      [stages.cutting, stages.printing, stages.upper, stages.final].map((s) =>
        Number(s.id),
      ),
    );
    const others = survivors.filter(
      (row) => !pinnedIds.has(Number(row.stage_id)),
    );
    // A stage that runs before printing today is a pre-printing operation
    // (edging, embroidery) and keeps that slot; everything else follows UPPER.
    const pivotSeq = Number((printingRoute || cuttingRoute)?.sequence_no || 0);
    const othersBefore = others.filter(
      (row) => Number(row.sequence_no || 0) < pivotSeq,
    );
    const othersAfter = others.filter(
      (row) => Number(row.sequence_no || 0) > pivotSeq,
    );

    // A route we are about to create rather than move. Ids are kept exactly as the
    // driver returned them (bigint -> string) so change-log snapshots compare
    // equal to the untouched rows instead of showing a spurious 67 vs "67" diff.
    const newRoute = (stage) => ({
      bom_id: bomId,
      stage_id: stage.id,
      is_required: true,
      enforce_sequence: true,
      dept_id: stage.dept_id,
      dept_name: stage.dept_name,
      stage_name: stage.name,
      isNew: true,
    });

    let upperRoute = survivors.find(
      (row) => Number(row.stage_id) === Number(stages.upper.id),
    );
    if (!upperRoute && INSERT_UPPER) upperRoute = newRoute(stages.upper);

    let finalRoute = survivors.find(
      (row) => Number(row.stage_id) === Number(stages.final.id),
    );
    if (!finalRoute && INSERT_FINAL) finalRoute = newRoute(stages.final);

    const desired = [
      cuttingRoute,
      ...othersBefore,
      printingRoute,
      upperRoute,
      ...othersAfter,
      finalRoute,
    ].filter(Boolean);

    const inserts = desired.filter((row) => row.isNew);
    const deleteStageIds = stitchingRoute ? [Number(stages.stitching.id)] : [];
    const repointSfg =
      Boolean(stitchingRoute) &&
      (sfgLinesByBom.get(bomId) || []).some(
        (row) =>
          Number(row.consumed_in_stage_id) === Number(stages.stitching.id),
      );

    const orderChanged = desired.some(
      (row, idx) => Number(row.sequence_no || 0) !== idx + 1,
    );
    const changed =
      orderChanged || inserts.length > 0 || deleteStageIds.length > 0;

    return {
      ...base,
      action: changed ? "REORDER" : "SKIP",
      note: changed ? "" : "already in the target order",
      desired,
      inserts,
      deleteStageIds,
      repointSfg,
      movesLines: desired.some(
        (row) => Number(row.stage_id) === Number(stages.upper.id),
      ),
    };
  });

  const stageLabel = (row) =>
    String(row.stage_name || `stage ${row.stage_id}`) + (row.isNew ? "*" : "");
  const orderText = (rows) =>
    rows.length ? rows.map(stageLabel).join(" > ") : "(none)";

  plans.forEach((plan) => {
    const header = `${plan.bom.bom_no}  ${String(plan.bom.item_name).slice(0, 40)}  v${plan.bom.version_no}  ${plan.action}`;
    console.log(header);
    if (plan.action === "REORDER") {
      console.log(`   before: ${orderText(plan.routes)}`);
      console.log(`   after : ${orderText(plan.desired)}`);
      if (plan.deleteStageIds.length) {
        console.log(`   - ${stages.stitching.name} route removed`);
      }
      if (plan.inserts.length) {
        console.log(
          `   - inserted (*): ${plan.inserts.map((row) => row.stage_name).join(", ")} (required, follow sequence on)`,
        );
      }
      if (plan.repointSfg) {
        console.log(
          `   - sfg line(s) consumed at ${stages.stitching.name} re-pointed to ${stages.upper.name}`,
        );
      }
    } else if (plan.note) {
      console.log(`   ${plan.note}`);
    }
    if (!plan.isLatestVersion) console.log("   superseded version");
    if (plan.movesLines && (plan.rm.move.length || plan.labour.move.length)) {
      console.log(
        `   - ${plan.rm.move.length} RM line(s) and ${plan.labour.move.length} labour line(s) moved from dept "${stages.stitching.dept_name}" to "${stages.upper.dept_name}"`,
      );
    }
    if (plan.rm.blocked.length || plan.labour.blocked.length) {
      console.log(
        `   !! ${plan.rm.blocked.length} RM line(s) and ${plan.labour.blocked.length} labour line(s) on dept "${stages.stitching.dept_name}" NOT moved`,
      );
      console.log(
        `      -- "${stages.upper.dept_name}" already holds the same line; moving would duplicate it. Fix on the BOM screen.`,
      );
    }
    if (!plan.movesLines && (plan.rm.move.length || plan.labour.move.length)) {
      console.log(
        `   !! ${plan.rm.move.length} RM line(s) and ${plan.labour.move.length} labour line(s) left on dept "${stages.stitching.dept_name}"`,
      );
      console.log(
        "      -- this BOM was skipped, so its stitching route still exists",
      );
    }
    if (plan.stitchWipPairs) {
      console.log(
        `   !! ${plan.stitchWipPairs} pair(s) open WIP at dept "${stages.stitching.dept_name}" for this article -- will be stranded`,
      );
    }
    plan.clobberingRequests.forEach((row) => {
      console.log(
        `   !! PENDING "${row.pending_action}" request #${row.id} WILL REVERT THIS`,
      );
    });
    if (plan.otherPendingActions.length) {
      console.log(
        `   pending ${plan.otherPendingActions.join("/")} (harmless)`,
      );
    }
  });
  console.log("");

  const changing = plans.filter((plan) => plan.action === "REORDER");
  const movingLines = plans.filter(
    (plan) =>
      plan.movesLines && (plan.rm.move.length || plan.labour.move.length),
  );

  const deleteIds = [];
  const parkRows = [];
  const insertRows = [];
  const finalRows = [];
  const rmMoveIds = [];
  const labourMoveIds = [];
  const changeLogRows = [];

  const changedByFor = (bom) =>
    CHANGED_BY ||
    toPositiveInt(bom.approved_by) ||
    toPositiveInt(bom.created_by) ||
    null;

  // dept_id is part of the change-log key for both sections, so relocating a line
  // reads as REMOVED on stitching + ADDED on upper. That is what happened.
  movingLines.forEach((plan) => {
    const changedBy = changedByFor(plan.bom);
    const log = (section, rows, snapshot) => {
      if (!rows.length) return;
      changeLogRows.push(
        ...buildChangeRows({
          bomId: plan.bomId,
          versionNo: plan.bom.version_no,
          requestId: null,
          changedBy,
          section,
          beforeRows: rows.map((row) => snapshot(row)),
          afterRows: rows.map((row) => snapshot(row, stages.upper.dept_id)),
        }),
      );
    };
    plan.rm.move.forEach((row) => rmMoveIds.push(row.id));
    plan.labour.move.forEach((row) => labourMoveIds.push(row.id));
    log("rm_lines", plan.rm.move, snapshotRmLine);
    log("labour_lines", plan.labour.move, snapshotLabourLine);
  });

  changing.forEach((plan) => {
    const maxSeq = plan.routes.reduce(
      (acc, row) => Math.max(acc, Number(row.sequence_no || 0)),
      0,
    );
    // Above every sequence_no this BOM currently holds, so neither the park pass
    // nor the insert can collide with a row that has not moved yet.
    const offset = maxSeq + plan.desired.length + 1;

    if (plan.deleteStageIds.length) {
      deleteIds.push({
        bom_id: plan.bomId,
        stage_ids: plan.deleteStageIds,
      });
    }

    plan.desired.forEach((row, idx) => {
      if (row.isNew) {
        insertRows.push({
          bom_id: plan.bomId,
          stage_id: Number(row.stage_id),
          sequence_no: offset + idx,
          is_required: true,
          enforce_sequence: true,
        });
      } else {
        parkRows.push({
          bom_id: plan.bomId,
          stage_id: Number(row.stage_id),
          sequence_no: offset + idx,
        });
      }
      finalRows.push({
        bom_id: plan.bomId,
        stage_id: Number(row.stage_id),
        sequence_no: idx + 1,
      });
    });

    const before = plan.routes.map(snapshotRoute);
    const after = plan.desired.map((row, idx) => ({
      stage_id: row.stage_id,
      sequence_no: idx + 1,
      is_required: row.isNew ? true : row.is_required,
      enforce_sequence: row.isNew ? true : row.enforce_sequence,
      dept_id: row.dept_id,
      dept_name: row.dept_name,
    }));

    const changedBy = changedByFor(plan.bom);

    changeLogRows.push(
      ...buildChangeRows({
        bomId: plan.bomId,
        versionNo: plan.bom.version_no,
        requestId: null,
        changedBy,
        section: "stage_routes",
        beforeRows: before,
        afterRows: after,
      }),
    );

    if (plan.repointSfg) {
      const lines = sfgLinesByBom.get(plan.bomId) || [];
      changeLogRows.push(
        ...buildChangeRows({
          bomId: plan.bomId,
          versionNo: plan.bom.version_no,
          requestId: null,
          changedBy,
          section: "sfg_lines",
          beforeRows: lines.map(snapshotSfgLine),
          afterRows: lines.map((row) => {
            const snap = snapshotSfgLine(row);
            if (
              Number(snap.consumed_in_stage_id) === Number(stages.stitching.id)
            ) {
              snap.consumed_in_stage_id = stages.upper.id;
            }
            return snap;
          }),
        }),
      );
    }
  });

  const repointBomIds = changing
    .filter((plan) => plan.repointSfg)
    .map((plan) => plan.bomId);

  let deleted = 0;
  for (const entry of deleteIds) {
    // eslint-disable-next-line no-await-in-loop
    deleted += await trx("erp.bom_stage_routing")
      .where("bom_id", entry.bom_id)
      .whereIn("stage_id", entry.stage_ids)
      .del();
  }

  let repointed = 0;
  if (repointBomIds.length) {
    repointed = await trx("erp.bom_sfg_line")
      .whereIn("bom_id", repointBomIds)
      .andWhere("consumed_in_stage_id", stages.stitching.id)
      .update({ consumed_in_stage_id: stages.upper.id });
  }

  let rmMoved = 0;
  if (rmMoveIds.length) {
    rmMoved = await trx("erp.bom_rm_line")
      .whereIn("id", rmMoveIds)
      .update({ dept_id: stages.upper.dept_id });
  }
  let labourMoved = 0;
  if (labourMoveIds.length) {
    labourMoved = await trx("erp.bom_labour_line")
      .whereIn("id", labourMoveIds)
      .update({ dept_id: stages.upper.dept_id });
  }

  if (parkRows.length) await applySequenceBatch(trx, parkRows);
  if (insertRows.length) await trx("erp.bom_stage_routing").insert(insertRows);
  if (finalRows.length) await applySequenceBatch(trx, finalRows);
  if (changeLogRows.length) {
    await trx("erp.bom_change_log").insert(changeLogRows);
  }

  const totals = {
    scanned: plans.length,
    reordered: changing.length,
    skipped: plans.filter((plan) => plan.action === "SKIP").length,
    review: plans.filter((plan) => plan.action === "REVIEW").length,
    deleted,
    insertedUpper: insertRows.filter(
      (row) => Number(row.stage_id) === Number(stages.upper.id),
    ).length,
    insertedFinal: insertRows.filter(
      (row) => Number(row.stage_id) === Number(stages.final.id),
    ).length,
    repointed,
    rmMoved,
    labourMoved,
    logged: changeLogRows.length,
    strandedWip: changing.filter((plan) => plan.stitchWipPairs > 0).length,
    blockedLines: plans.filter(
      (plan) => plan.rm.blocked.length || plan.labour.blocked.length,
    ).length,
    orphanedLines: plans.filter(
      (plan) =>
        !plan.movesLines && (plan.rm.move.length || plan.labour.move.length),
    ).length,
    pending: plans.filter((plan) => plan.clobberingRequests.length).length,
  };

  console.log(`${TAG} approved SFG BOMs scanned     : ${totals.scanned}`);
  console.log(`${TAG} reordered                     : ${totals.reordered}`);
  console.log(`${TAG} already correct               : ${totals.skipped}`);
  console.log(`${TAG} needs review (skipped)        : ${totals.review}`);
  console.log(`${TAG} "${stages.stitching.name}" routes removed  : ${totals.deleted}`);
  console.log(`${TAG} "${stages.upper.name}" routes inserted : ${totals.insertedUpper}`);
  console.log(`${TAG} "${stages.final.name}" routes inserted  : ${totals.insertedFinal}`);
  console.log(`${TAG} sfg lines re-pointed          : ${totals.repointed}`);
  console.log(`${TAG} RM lines moved to "${stages.upper.dept_name}"     : ${totals.rmMoved}`);
  console.log(`${TAG} labour lines moved to "${stages.upper.dept_name}" : ${totals.labourMoved}`);
  console.log(`${TAG} bom_change_log rows           : ${totals.logged}`);

  if (totals.reordered) {
    console.log("");
    console.log(
      `${TAG} NOTE: "${stages.final.name}" is now the last required stage on ${totals.reordered} BOM(s).`,
    );
    console.log(
      `${TAG}   That is where WIP becomes real SFG stock, so stock will only be`,
    );
    console.log(
      `${TAG}   created once production is posted at "${stages.final.name}".`,
    );
  }
  if (totals.blockedLines) {
    console.log("");
    console.log(
      `${TAG} WARNING: ${totals.blockedLines} BOM(s) have lines that could NOT be moved off dept`,
    );
    console.log(
      `${TAG}   "${stages.stitching.dept_name}" because "${stages.upper.dept_name}" already holds the same line.`,
    );
    console.log(
      `${TAG}   Moving them would duplicate the material. Fix on the BOM screen.`,
    );
  }
  if (totals.orphanedLines) {
    console.log("");
    console.log(
      `${TAG} WARNING: ${totals.orphanedLines} skipped BOM(s) still carry lines on dept`,
    );
    console.log(
      `${TAG}   "${stages.stitching.dept_name}". Their routing was left alone, so those lines`,
    );
    console.log(`${TAG}   are still reachable -- nothing to do unless you route them.`);
  }
  if (totals.strandedWip) {
    console.log("");
    console.log(
      `${TAG} WARNING: ${totals.strandedWip} BOM(s) have open WIP at dept "${stages.stitching.dept_name}".`,
    );
    console.log(
      `${TAG}   Those pairs have no forward route now that the stage is gone.`,
    );
  }
  if (totals.pending) {
    console.log("");
    console.log(
      `${TAG} WARNING: ${totals.pending} BOM(s) have a PENDING create/update request.`,
    );
    console.log(
      `${TAG}   Approving one runs replaceBomLines, which deletes ALL of that BOM's`,
    );
    console.log(
      `${TAG}   bom_stage_routing rows and re-inserts only what the request payload`,
    );
    console.log(
      `${TAG}   captured at submit time -- i.e. it silently undoes this reordering.`,
    );
    console.log(
      `${TAG}   Decide those requests first, then re-run this script for those BOMs.`,
    );
  }
};

(async () => {
  let failed = false;
  console.log(`${TAG} mode: ${APPLY ? "APPLY (writes committed)" : "DRY RUN"}`);
  if (ONLY_BOM_IDS.length) {
    console.log(`${TAG} restricted to bom ids: ${ONLY_BOM_IDS.join(", ")}`);
  }
  console.log("");
  try {
    await knex.transaction(async (trx) => {
      await run(trx);
      if (!APPLY) throw ROLLBACK;
    });
    console.log(`\n${TAG} committed.`);
  } catch (err) {
    if (err === ROLLBACK) {
      console.log(
        `\n${TAG} dry run complete -- rolled back, nothing was written.`,
      );
      console.log(`${TAG} re-run with --apply to commit.`);
    } else if (err instanceof AbortError) {
      failed = true;
      console.error(`\n${TAG} ABORTED\n${err.message}`);
    } else {
      failed = true;
      console.error(`\n${TAG} FAILED:`, err);
    }
  } finally {
    await knex.destroy();
  }
  process.exit(failed ? 1 : 0);
})();
