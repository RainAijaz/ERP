const knex = require("../../db/knex");

// Readiness answers the one question the BOM register cannot: which articles are
// only half-built?
//
// An FG article that uses a semi-finished part needs BOTH an approved FG recipe
// and an approved recipe for every SFG part it consumes. saveBomDraft already
// enforces that pairing at approval time (an FG BOM whose item has uses_sfg must
// carry an SFG line for every SKU size), but nothing ever looks across articles.
// So "SFG signed off, FG never written" stays invisible until a production
// voucher fails on the floor. This report surfaces those pairs.

// Severity order, worst first. The array position IS the ranking, so the first
// matching issue on a row becomes its headline verdict.
const READINESS_ISSUES = [
  // The half-built case that motivated this report: the component recipe is
  // approved, the assembly recipe is not. Ranked worst because the work looks
  // done from every other screen.
  "FG_MISSING_SFG_READY",
  "FG_BOM_MISSING",
  "SFG_BOM_MISSING",
  "SFG_NOT_LINKED",
  "FG_BOM_NOT_APPROVED",
  "SFG_BOM_NOT_APPROVED",
  "SFG_ORPHAN",
  "READY",
];

const ISSUE_FILTERS = ["ALL", "PROBLEMS", ...READINESS_ISSUES];

// How usable a BOM is, best first. A deactivated approved BOM cannot be used in
// production, so it ranks below an active approved one but above anything still
// sitting in the queue.
const BOM_STATE_PRIORITY = {
  APPROVED: 6,
  INACTIVE: 5,
  PENDING: 4,
  DRAFT: 3,
  REJECTED: 2,
  MISSING: 1,
};

let bomLifecycleColumnPromise = null;
let globalSfgColumnPromise = null;

const toPositiveInt = (value) => {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
};

const parseList = (value) => {
  if (!value) return [];
  if (Array.isArray(value))
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeIdList = (value) => [
  ...new Set(
    parseList(value)
      .map((entry) => toPositiveInt(entry))
      .filter(Boolean),
  ),
];

const normalizeIssueFilter = (value) => {
  const normalized = String(value || "PROBLEMS")
    .trim()
    .toUpperCase();
  return ISSUE_FILTERS.includes(normalized) ? normalized : "PROBLEMS";
};

const normalizeSortOrder = (value) => {
  const normalized = String(value || "severity")
    .trim()
    .toLowerCase();
  return ["severity", "item_name"].includes(normalized)
    ? normalized
    : "severity";
};

const hasBomLifecycleColumn = async () => {
  if (bomLifecycleColumnPromise) return bomLifecycleColumnPromise;
  bomLifecycleColumnPromise = (async () => {
    try {
      return await knex.schema
        .withSchema("erp")
        .hasColumn("bom_header", "is_active");
    } catch (err) {
      bomLifecycleColumnPromise = null;
      return false;
    }
  })();
  return bomLifecycleColumnPromise;
};

// is_global_sfg arrived in a later DDL pass, so never assume it exists: without
// the guard this whole report would throw on an environment that predates it.
const hasGlobalSfgColumn = async () => {
  if (globalSfgColumnPromise) return globalSfgColumnPromise;
  globalSfgColumnPromise = (async () => {
    try {
      return await knex.schema
        .withSchema("erp")
        .hasColumn("items", "is_global_sfg");
    } catch (err) {
      globalSfgColumnPromise = null;
      return false;
    }
  })();
  return globalSfgColumnPromise;
};

// Collapses every BOM an item owns into the single best one, since only the most
// usable version decides whether the item can actually be produced.
const resolveBomState = (rows, lifecycleSupported) => {
  let best = {
    state: "MISSING",
    bom_id: null,
    bom_no: null,
    version_no: null,
  };
  (rows || []).forEach((row) => {
    const status = String(row.status || "").toUpperCase();
    let state = status;
    if (status === "APPROVED") {
      const active = lifecycleSupported ? row.is_active !== false : true;
      state = active ? "APPROVED" : "INACTIVE";
    }
    // An unrecognised status must never outrank a real one.
    if (!BOM_STATE_PRIORITY[state]) state = "REJECTED";
    const rank = BOM_STATE_PRIORITY[state];
    const bestRank = BOM_STATE_PRIORITY[best.state] || 0;
    const newer =
      rank === bestRank &&
      Number(row.version_no || 0) > Number(best.version_no || 0);
    if (rank > bestRank || newer) {
      best = {
        state,
        bom_id: toPositiveInt(row.id),
        bom_no: row.bom_no || null,
        version_no: row.version_no ?? null,
      };
    }
  });
  return best;
};

// The SFG suffixes an article's parts are conventionally coded with.
const suffixesForPartType = (partType) => {
  const normalized = String(partType || "")
    .trim()
    .toUpperCase();
  if (normalized === "STEP") return ["step"];
  if (normalized === "UPPER") return ["upper"];
  return ["step", "upper"];
};

const loadReadinessArticleOptions = async (includeInactive) => {
  const query = knex("erp.items as i")
    .select("i.id", "i.code", "i.name")
    .where("i.item_type", "FG");
  if (!includeInactive) query.andWhere("i.is_active", true);
  return query.orderBy("i.name", "asc");
};

const getBomReadinessReportPageData = async ({ req, input = {} }) => {
  const selectedItemIds = normalizeIdList(input?.item_ids || input?.itemIds);
  const issueFilter = normalizeIssueFilter(input?.issue);
  const includeInactiveItems =
    String(input?.include_inactive || input?.includeInactive || "0").trim() ===
    "1";
  const sortOrder = normalizeSortOrder(input?.order_by || input?.orderBy);
  const reportLoaded =
    String(input?.load_report || input?.loadReport || "").trim() === "1";

  const itemOptions = await loadReadinessArticleOptions(includeInactiveItems);

  const filters = {
    reportLoaded,
    itemIds: selectedItemIds,
    issue: issueFilter,
    includeInactive: includeInactiveItems,
    orderBy: sortOrder,
  };

  const options = {
    items: itemOptions,
    issues: ISSUE_FILTERS.map((value) => ({ value })),
    orderBys: [{ value: "severity" }, { value: "item_name" }],
  };

  const emptyTotals = {
    rowCount: 0,
    scopeCount: 0,
    readyCount: 0,
    problemCount: 0,
    issueCounts: {},
  };

  if (!reportLoaded) {
    return { filters, options, reportData: { rows: [], totals: emptyTotals } };
  }

  const [lifecycleSupported, globalSfgSupported] = await Promise.all([
    hasBomLifecycleColumn(),
    hasGlobalSfgColumn(),
  ]);

  // 1. Every FG article in scope.
  const fgQuery = knex("erp.items as i")
    .select(
      "i.id",
      "i.code",
      "i.name",
      "i.uses_sfg",
      "i.sfg_part_type",
      "i.is_active",
    )
    .where("i.item_type", "FG");
  if (!includeInactiveItems) fgQuery.andWhere("i.is_active", true);
  if (selectedItemIds.length) fgQuery.whereIn("i.id", selectedItemIds);
  const fgRows = await fgQuery.orderBy("i.name", "asc");
  const fgIds = fgRows.map((row) => toPositiveInt(row.id)).filter(Boolean);

  // 2. Declared FG -> SFG links.
  const sfgIdsByFg = new Map();
  const addLink = (fgId, sfgId) => {
    const key = toPositiveInt(fgId);
    const value = toPositiveInt(sfgId);
    if (!key || !value) return;
    if (!sfgIdsByFg.has(key)) sfgIdsByFg.set(key, []);
    const list = sfgIdsByFg.get(key);
    if (!list.includes(value)) list.push(value);
  };
  if (fgIds.length) {
    const usageRows = await knex("erp.item_usage")
      .select("fg_item_id", "sfg_item_id")
      .whereIn("fg_item_id", fgIds);
    usageRows.forEach((row) => addLink(row.fg_item_id, row.sfg_item_id));
  }

  // 3. Legacy fallback. Older articles were never given item_usage rows and are
  //    linked only by the generated code pattern ("<fg code>_upper"). Without
  //    this, every one of them would be reported as a false "not linked".
  //    Deliberately unfiltered on is_active: a deactivated part is still a link,
  //    and hiding it here would turn it into a phantom missing-link instead.
  const fallbackCodeToFgIds = new Map();
  fgRows.forEach((fg) => {
    if (!fg.uses_sfg) return;
    if ((sfgIdsByFg.get(toPositiveInt(fg.id)) || []).length) return;
    const code = String(fg.code || "").trim();
    if (!code) return;
    suffixesForPartType(fg.sfg_part_type).forEach((suffix) => {
      const candidate = `${code}_${suffix}`.toLowerCase();
      if (!fallbackCodeToFgIds.has(candidate))
        fallbackCodeToFgIds.set(candidate, []);
      fallbackCodeToFgIds.get(candidate).push(toPositiveInt(fg.id));
    });
  });
  if (fallbackCodeToFgIds.size) {
    const inferredRows = await knex("erp.items")
      .select("id", "code")
      .whereRaw("lower(trim(code)) = ANY(?)", [[...fallbackCodeToFgIds.keys()]])
      .andWhere("item_type", "SFG");
    inferredRows.forEach((row) => {
      const key = String(row.code || "")
        .trim()
        .toLowerCase();
      (fallbackCodeToFgIds.get(key) || []).forEach((fgId) =>
        addLink(fgId, row.id),
      );
    });
  }

  // 4. Orphan SFGs: a part with a recipe that belongs to no article at all.
  //    Global SFGs ("tingle") are shared across every article and carry no
  //    item_usage rows by design, so including them would report every single
  //    one as an orphan.
  let orphanSfgRows = [];
  if (!selectedItemIds.length) {
    const orphanQuery = knex("erp.items as i")
      .select("i.id", "i.code", "i.name", "i.is_active")
      .where("i.item_type", "SFG")
      .whereExists(function hasAnyBom() {
        this.select(1)
          .from("erp.bom_header as bh")
          .whereRaw("bh.item_id = i.id");
      })
      .whereNotExists(function hasNoUsage() {
        this.select(1)
          .from("erp.item_usage as iu")
          .whereRaw("iu.sfg_item_id = i.id");
      });
    if (!includeInactiveItems) orphanQuery.andWhere("i.is_active", true);
    if (globalSfgSupported) orphanQuery.andWhere("i.is_global_sfg", false);
    orphanSfgRows = await orphanQuery.orderBy("i.name", "asc");

    // Same legacy convention in reverse: a part coded "<fg code>_upper" against
    // a real article is linked, even with no item_usage row to prove it.
    if (orphanSfgRows.length) {
      const fgCodeRows = await knex("erp.items")
        .select("code")
        .where("item_type", "FG");
      const fgCodes = new Set(
        fgCodeRows
          .map((row) =>
            String(row.code || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      );
      orphanSfgRows = orphanSfgRows.filter((row) => {
        const code = String(row.code || "")
          .trim()
          .toLowerCase();
        return !["step", "upper"].some(
          (suffix) =>
            code.endsWith(`_${suffix}`) &&
            fgCodes.has(code.slice(0, -(suffix.length + 1))),
        );
      });
    }
  }

  // 5. One pass for every BOM belonging to any item on the report.
  const linkedSfgIds = [
    ...new Set([...sfgIdsByFg.values()].flat().filter(Boolean)),
  ];
  const orphanIds = orphanSfgRows
    .map((row) => toPositiveInt(row.id))
    .filter(Boolean);
  const allItemIds = [...new Set([...fgIds, ...linkedSfgIds, ...orphanIds])];

  const bomRowsByItem = new Map();
  if (allItemIds.length) {
    const bomRows = await knex("erp.bom_header as bh")
      .select(
        "bh.id",
        "bh.item_id",
        "bh.bom_no",
        "bh.status",
        "bh.version_no",
        lifecycleSupported ? "bh.is_active" : knex.raw("true as is_active"),
      )
      .whereIn("bh.item_id", allItemIds);
    bomRows.forEach((row) => {
      const key = toPositiveInt(row.item_id);
      if (!key) return;
      if (!bomRowsByItem.has(key)) bomRowsByItem.set(key, []);
      bomRowsByItem.get(key).push(row);
    });
  }

  const sfgItemById = new Map();
  if (linkedSfgIds.length) {
    const sfgItemRows = await knex("erp.items")
      .select("id", "code", "name", "is_active")
      .whereIn("id", linkedSfgIds);
    sfgItemRows.forEach((row) => sfgItemById.set(toPositiveInt(row.id), row));
  }

  // 6. Verdict per article.
  const rows = [];
  fgRows.forEach((fg) => {
    const fgId = toPositiveInt(fg.id);
    const fgBom = resolveBomState(bomRowsByItem.get(fgId), lifecycleSupported);
    const usesSfg = Boolean(fg.uses_sfg);
    const linkedItems = (sfgIdsByFg.get(fgId) || [])
      .map((id) => sfgItemById.get(id))
      .filter(Boolean);

    // The weakest linked part decides: one unbuildable component blocks the
    // whole article, however healthy its siblings are.
    let sfgBom = null;
    let weakestSfgItem = null;
    if (usesSfg && linkedItems.length) {
      linkedItems.forEach((item) => {
        const state = resolveBomState(
          bomRowsByItem.get(toPositiveInt(item.id)),
          lifecycleSupported,
        );
        const worse =
          !sfgBom ||
          BOM_STATE_PRIORITY[state.state] < BOM_STATE_PRIORITY[sfgBom.state];
        if (worse) {
          sfgBom = state;
          weakestSfgItem = item;
        }
      });
    }

    const issues = [];
    if (usesSfg && !linkedItems.length) issues.push("SFG_NOT_LINKED");
    if (fgBom.state === "MISSING") issues.push("FG_BOM_MISSING");
    else if (fgBom.state !== "APPROVED") issues.push("FG_BOM_NOT_APPROVED");
    if (usesSfg && linkedItems.length && sfgBom) {
      if (sfgBom.state === "MISSING") issues.push("SFG_BOM_MISSING");
      else if (sfgBom.state !== "APPROVED") issues.push("SFG_BOM_NOT_APPROVED");
    }
    if (fgBom.state !== "APPROVED" && sfgBom?.state === "APPROVED") {
      issues.push("FG_MISSING_SFG_READY");
    }

    const primaryIssue = issues.length
      ? issues.sort(
          (a, b) => READINESS_ISSUES.indexOf(a) - READINESS_ISSUES.indexOf(b),
        )[0]
      : "READY";

    rows.push({
      row_kind: "FG",
      item_id: fgId,
      item_code: fg.code || null,
      item_name: fg.name || null,
      item_is_active: fg.is_active !== false,
      uses_sfg: usesSfg,
      fg_bom_state: fgBom.state,
      fg_bom_no: fgBom.bom_no,
      fg_bom_id: fgBom.bom_id,
      fg_version_no: fgBom.version_no,
      sfg_item_name: weakestSfgItem?.name || null,
      sfg_item_code: weakestSfgItem?.code || null,
      sfg_linked_count: linkedItems.length,
      sfg_bom_state: usesSfg ? (sfgBom ? sfgBom.state : "MISSING") : null,
      sfg_bom_no: sfgBom?.bom_no || null,
      sfg_bom_id: sfgBom?.bom_id || null,
      sfg_version_no: sfgBom?.version_no ?? null,
      primary_issue: primaryIssue,
      issues,
    });
  });

  orphanSfgRows.forEach((sfg) => {
    const sfgId = toPositiveInt(sfg.id);
    const state = resolveBomState(bomRowsByItem.get(sfgId), lifecycleSupported);
    rows.push({
      row_kind: "SFG",
      item_id: sfgId,
      item_code: sfg.code || null,
      item_name: sfg.name || null,
      item_is_active: sfg.is_active !== false,
      uses_sfg: false,
      fg_bom_state: null,
      fg_bom_no: null,
      fg_bom_id: null,
      fg_version_no: null,
      sfg_item_name: sfg.name || null,
      sfg_item_code: sfg.code || null,
      sfg_linked_count: 0,
      sfg_bom_state: state.state,
      sfg_bom_no: state.bom_no,
      sfg_bom_id: state.bom_id,
      sfg_version_no: state.version_no,
      primary_issue: "SFG_ORPHAN",
      issues: ["SFG_ORPHAN"],
    });
  });

  // Counted over everything examined, not over what survives the issue filter,
  // so the tiles stay a stable summary the user can filter down from.
  const issueCounts = {};
  READINESS_ISSUES.forEach((code) => {
    issueCounts[code] = 0;
  });
  rows.forEach((row) => {
    issueCounts[row.primary_issue] = (issueCounts[row.primary_issue] || 0) + 1;
  });
  const scopeCount = rows.length;
  const readyCount = issueCounts.READY || 0;

  let visibleRows = rows;
  if (issueFilter === "PROBLEMS") {
    visibleRows = rows.filter((row) => row.primary_issue !== "READY");
  } else if (issueFilter !== "ALL") {
    visibleRows = rows.filter((row) => row.primary_issue === issueFilter);
  }

  const byName = (a, b) =>
    String(a.item_name || "").localeCompare(
      String(b.item_name || ""),
      undefined,
      { sensitivity: "base" },
    );
  visibleRows =
    sortOrder === "item_name"
      ? [...visibleRows].sort(byName)
      : [...visibleRows].sort((a, b) => {
          const diff =
            READINESS_ISSUES.indexOf(a.primary_issue) -
            READINESS_ISSUES.indexOf(b.primary_issue);
          return diff !== 0 ? diff : byName(a, b);
        });

  return {
    filters,
    options,
    reportData: {
      rows: visibleRows,
      totals: {
        rowCount: visibleRows.length,
        scopeCount,
        readyCount,
        problemCount: scopeCount - readyCount,
        issueCounts,
      },
    },
  };
};

module.exports = {
  getBomReadinessReportPageData,
  READINESS_ISSUES,
};
