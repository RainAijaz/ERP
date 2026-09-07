const knex = require("../../db/knex");
const {
  getReportAllowedBranchIds,
  normalizeReportBranchIds,
  reportCanFilterAllBranches,
} = require("../../utils/report-branch-scope");

const BOM_LEVELS = ["FINISHED", "SEMI_FINISHED"];
const BOM_STATUSES = ["DRAFT", "PENDING", "APPROVED", "REJECTED"];
const LIFECYCLE_OPTIONS = ["ALL", "ACTIVE", "INACTIVE"];
const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"];
const APPROVAL_ACTIONS = [
  "approve_draft",
  "delete_draft",
  "create_version_from",
  "toggle_lifecycle",
];
const COST_VALUATION_MODES = [
  "WAC_FALLBACK_PURCHASE",
  "WAC_ONLY",
  "PURCHASE_RATE",
];
// SUM is the default because it is what production actually books: a DCV emits
// one costed labour line per labour row in the department (see buildLabourLines
// in production-voucher-service.js), so AVG/MAX could never reconcile with the
// posted cost. AVG/MAX stay available for BOMs whose extra rows are meant as
// alternative labours rather than additional operations.
const LABOUR_AGGREGATION_MODES = ["SUM", "AVG", "MAX"];
const COST_EXPLOSION_MODES = ["DIRECT", "EXPLODED"];
// Must stay in step with the sections bom-change-log.js actually writes,
// otherwise a section is logged but cannot be filtered for.
const CHANGE_LOG_SECTIONS = [
  "header",
  "rm_lines",
  "sfg_lines",
  "labour_lines",
  "stage_routes",
  "variant_rules",
  "sku_overrides",
];
const CHANGE_TYPES = ["ADDED", "UPDATED", "REMOVED"];

let bomLifecycleColumnSupportPromise = null;
let bomChangeLogTableSupportPromise = null;

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

const toDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const yyyy = String(value.getFullYear()).padStart(4, "0");
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = String(parsed.getFullYear()).padStart(4, "0");
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

// "ALL" is a first-class value: every caller guards its level filter with
// `level !== "ALL"`, so returning FINISHED for an unrecognised input silently
// hid every SEMI_FINISHED BOM from reports that never offered an All option.
const normalizeBomLevel = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toUpperCase();
  return BOM_LEVELS.includes(normalized) ? normalized : "ALL";
};

const normalizeBomStatus = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toUpperCase();
  return BOM_STATUSES.includes(normalized) ? normalized : "ALL";
};

const normalizeLifecycle = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toUpperCase();
  return LIFECYCLE_OPTIONS.includes(normalized) ? normalized : "ALL";
};

const normalizeApprovalStatus = (value) => {
  const normalized = String(value || "PENDING")
    .trim()
    .toUpperCase();
  return APPROVAL_STATUSES.includes(normalized) ? normalized : "PENDING";
};

const normalizeApprovalAction = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toLowerCase();
  return APPROVAL_ACTIONS.includes(normalized) ? normalized : "ALL";
};

const normalizeAgingBucket = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toUpperCase();
  if (["ALL", "0_2", "3_7", "8_15", "15_PLUS"].includes(normalized))
    return normalized;
  return "ALL";
};

const normalizePendingFlag = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toUpperCase();
  if (["ALL", "YES", "NO"].includes(normalized)) return normalized;
  return "ALL";
};

const normalizeSortOrder = (value, allowed, fallback) => {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
};

const normalizeValuationMode = (value) => {
  const normalized = String(value || "WAC_FALLBACK_PURCHASE")
    .trim()
    .toUpperCase();
  return COST_VALUATION_MODES.includes(normalized)
    ? normalized
    : "WAC_FALLBACK_PURCHASE";
};

const normalizeLabourAggregation = (value) => {
  const normalized = String(value || "SUM")
    .trim()
    .toUpperCase();
  return LABOUR_AGGREGATION_MODES.includes(normalized) ? normalized : "SUM";
};

const normalizeExplosionMode = (value) => {
  const normalized = String(value || "DIRECT")
    .trim()
    .toUpperCase();
  return COST_EXPLOSION_MODES.includes(normalized) ? normalized : "DIRECT";
};

const normalizeChangeSection = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toLowerCase();
  return CHANGE_LOG_SECTIONS.includes(normalized) ? normalized : "ALL";
};

const normalizeChangeType = (value) => {
  const normalized = String(value || "ALL")
    .trim()
    .toUpperCase();
  return CHANGE_TYPES.includes(normalized) ? normalized : "ALL";
};

const normalizePage = (value, fallback = 1) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
};

const normalizeLimit = (value, fallback = 50) => {
  const n = Number(value);
  if (![25, 50, 100].includes(n)) return fallback;
  return n;
};

const diffDaysInclusive = (fromDate, toDate) => {
  if (!fromDate || !toDate) return 0;
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  const diffMs = to.getTime() - from.getTime();
  return Math.floor(diffMs / 86400000) + 1;
};

// Single source of truth for "how old is this request", shared by the SELECT
// (which drives the displayed Bucket) and the bucket WHERE clause.
const AGE_DAYS_SQL =
  "GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - ar.requested_at)) / 86400))::int";

const AGING_BUCKET_RANGES = {
  "0_2": { min: 0, max: 2 },
  "3_7": { min: 3, max: 7 },
  "8_15": { min: 8, max: 15 },
  "15_PLUS": { min: 16, max: null },
};

const resolveAgingBucketByDays = (days) => {
  const n = Number(days || 0);
  if (!Number.isFinite(n) || n <= 2) return "0_2";
  if (n <= 7) return "3_7";
  if (n <= 15) return "8_15";
  return "15_PLUS";
};

// Reports render article names, so they have to follow the UI locale the same
// way bom/service.js loadFormOptions does. Without this the register and every
// report showed English names to Urdu users while the BOM form showed Urdu.
// `table` and `alias` are always code literals here, never request input.
const localizedNameColumn = (locale, alias = "item_name", table = "i") =>
  String(locale || "").toLowerCase() === "ur"
    ? knex.raw(`COALESCE(${table}.name_ur, ${table}.name) as ${alias}`)
    : knex.raw(`${table}.name as ${alias}`);

const localeOf = (req) => String(req?.locale || "en").toLowerCase();

const hasBomLifecycleColumn = async () => {
  if (bomLifecycleColumnSupportPromise) return bomLifecycleColumnSupportPromise;
  bomLifecycleColumnSupportPromise = (async () => {
    try {
      // `return await` matters: returning the promise unawaited puts the
      // rejection outside this try, so one DB hiccup would cache a rejected
      // promise and break every BOM report until the process restarted.
      return await knex.schema
        .withSchema("erp")
        .hasColumn("bom_header", "is_active");
    } catch (err) {
      bomLifecycleColumnSupportPromise = null;
      return false;
    }
  })();
  return bomLifecycleColumnSupportPromise;
};

// Mirrors production-voucher-service.js: BOM quantities are stored in an
// arbitrary UOM and only become comparable once converted to PAIR.
const loadPairFactorByUomId = async () => {
  const pair =
    (await knex("erp.uom as u")
      .select("u.id")
      .whereRaw("upper(coalesce(u.code, '')) = 'PAIR'")
      .andWhere("u.is_active", true)
      .first()) ||
    (await knex("erp.uom as u")
      .select("u.id")
      .whereRaw("upper(coalesce(u.name, '')) = 'PAIR'")
      .andWhere("u.is_active", true)
      .first());
  const factors = new Map();
  if (!pair) return factors;
  const pairId = Number(pair.id);
  factors.set(pairId, 1);

  const [directRows, reverseRows] = await Promise.all([
    knex("erp.uom_conversions as uc")
      .join("erp.uom as from_u", "from_u.id", "uc.from_uom_id")
      .select("from_u.id", "uc.factor")
      .where({
        "uc.to_uom_id": pairId,
        "uc.is_active": true,
        "from_u.is_active": true,
      }),
    knex("erp.uom_conversions as uc")
      .join("erp.uom as to_u", "to_u.id", "uc.to_uom_id")
      .select("to_u.id", "uc.factor")
      .where({
        "uc.from_uom_id": pairId,
        "uc.is_active": true,
        "to_u.is_active": true,
      }),
  ]);

  directRows.forEach((row) => {
    const id = toPositiveInt(row?.id);
    const factor = Number(row?.factor || 0);
    if (!id || factors.has(id) || !Number.isFinite(factor) || factor <= 0)
      return;
    factors.set(id, Number(factor.toFixed(6)));
  });
  reverseRows.forEach((row) => {
    const id = toPositiveInt(row?.id);
    const factor = Number(row?.factor || 0);
    if (!id || factors.has(id) || !Number.isFinite(factor) || factor <= 0)
      return;
    factors.set(id, Number((1 / factor).toFixed(6)));
  });
  return factors;
};

const hasBomChangeLogTable = async () => {
  if (bomChangeLogTableSupportPromise) return bomChangeLogTableSupportPromise;
  bomChangeLogTableSupportPromise = (async () => {
    try {
      const row = await knex.raw(
        "SELECT to_regclass('erp.bom_change_log') AS reg",
      );
      const value = row?.rows?.[0]?.reg || row?.[0]?.reg || null;
      return Boolean(value);
    } catch (err) {
      bomChangeLogTableSupportPromise = null;
      return false;
    }
  })();
  return bomChangeLogTableSupportPromise;
};

const hasStockBalanceRmTable = async () => {
  try {
    const row = await knex.raw(
      "SELECT to_regclass('erp.stock_balance_rm') AS reg",
    );
    const value = row?.rows?.[0]?.reg || row?.[0]?.reg || null;
    return Boolean(value);
  } catch (err) {
    return false;
  }
};

const hasStockBalanceSkuTable = async () => {
  try {
    const row = await knex.raw(
      "SELECT to_regclass('erp.stock_balance_sku') AS reg",
    );
    const value = row?.rows?.[0]?.reg || row?.[0]?.reg || null;
    return Boolean(value);
  } catch (err) {
    return false;
  }
};

const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return getReportAllowedBranchIds(req);
};

const loadBranchOptions = async (req, canAllBranches = false) => {
  const locale = localeOf(req);
  let query = knex("erp.branches")
    .select("id", localizedNameColumn(locale, "name", "branches"))
    .where({ is_active: true })
    .orderBy("name", "asc");
  const allowed = getAllowedBranchIds(req);
  if (!req?.user?.isAdmin && !canAllBranches && allowed.length) {
    query = query.whereIn("id", allowed);
  }
  return query;
};

const normalizeBranchFilter = ({ req, input, scopeKey }) =>
  normalizeReportBranchIds({
    req,
    input,
    canAllBranches: reportCanFilterAllBranches(req, scopeKey),
  });

const loadBomArticleOptions = async (level, locale = "en") => {
  const hasLevel =
    typeof level !== "undefined" &&
    level !== null &&
    String(level).trim() !== "";
  const requested = hasLevel ? normalizeBomLevel(level) : "ALL";
  // "ALL" must not narrow item_type, or the picker silently drops SFG articles.
  const normalizedLevel = requested === "ALL" ? null : requested;
  const itemType = normalizedLevel === "SEMI_FINISHED" ? "SFG" : "FG";
  const query = knex("erp.items as i")
    .select("i.id", "i.code", localizedNameColumn(locale, "name"), "i.item_type")
    .whereExists(function whereItemHasBom() {
      this.select(1).from("erp.bom_header as bh").whereRaw("bh.item_id = i.id");
      if (normalizedLevel) this.andWhere("bh.level", normalizedLevel);
    });

  if (normalizedLevel) query.where("i.item_type", itemType);
  return query.orderBy("i.name", "asc");
};

const buildValidationState = ({
  t,
  rawFromDate,
  rawToDate,
  fromDate,
  toDate,
  reportLoaded,
}) => {
  if (reportLoaded && ((rawFromDate && !fromDate) || (rawToDate && !toDate))) {
    return {
      message:
        (typeof t === "function" && t("invalid_date_range")) ||
        "Invalid date range.",
    };
  }
  if (reportLoaded && fromDate && toDate && fromDate > toDate) {
    return {
      message:
        (typeof t === "function" && t("invalid_date_range")) ||
        "Invalid date range.",
    };
  }
  return { message: "" };
};

const getBomVersionHistoryReportPageData = async ({ req, input = {} }) => {
  const rawFromDate = String(input?.from_date || input?.fromDate || "").trim();
  const rawToDate = String(input?.to_date || input?.toDate || "").trim();
  const reportLoaded =
    String(input?.load_report || input?.loadReport || "").trim() === "1";

  // Set default dates on first load (when report is not yet loaded)
  let fromDate = toDateOnly(rawFromDate);
  let toDate = toDateOnly(rawToDate);

  if (!reportLoaded && !rawFromDate && !rawToDate) {
    // Default to the current calendar year, not a hardcoded date: the old
    // literal "2026-01-01" would have kept widening the window every year.
    const today = new Date();
    const yyyy = String(today.getFullYear()).padStart(4, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    fromDate = `${yyyy}-01-01`;
    toDate = `${yyyy}-${mm}-${dd}`;
  }

  const selectedItemIds = normalizeIdList(input?.item_ids || input?.itemIds);
  const level = normalizeBomLevel(input?.level);
  const workflowStatus = normalizeBomStatus(input?.status);
  const lifecycle = normalizeLifecycle(input?.lifecycle);
  const sortOrder = normalizeSortOrder(
    input?.order_by || input?.orderBy,
    ["latest", "oldest", "item_version"],
    "latest",
  );

  const validation = buildValidationState({
    t: req?.res?.locals?.t,
    rawFromDate,
    rawToDate,
    fromDate,
    toDate,
    reportLoaded,
  });

  const missingRequiredItem = reportLoaded && selectedItemIds.length === 0;
  const lifecycleSupported = await hasBomLifecycleColumn();
  const locale = localeOf(req);
  const itemOptions = await loadBomArticleOptions(level, locale);

  const filters = {
    reportLoaded,
    fromDate: fromDate || "",
    toDate: toDate || "",
    itemIds: selectedItemIds,
    level,
    status: workflowStatus,
    lifecycle,
    orderBy: sortOrder,
    validationMessage: validation.message,
    missingRequiredItem,
  };

  const options = {
    items: itemOptions,
    levels: [{ value: "ALL" }, ...BOM_LEVELS.map((value) => ({ value }))],
    statuses: [{ value: "ALL" }, ...BOM_STATUSES.map((v) => ({ value: v }))],
    lifecycles: LIFECYCLE_OPTIONS.map((value) => ({ value })),
    orderBys: [
      { value: "latest" },
      { value: "oldest" },
      { value: "item_version" },
    ],
  };

  if (!reportLoaded || validation.message || missingRequiredItem) {
    return {
      filters,
      options,
      reportData: { rows: [], totals: { rowCount: 0 } },
    };
  }

  const query = knex("erp.bom_header as bh")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.item_id",
      "bh.level",
      "bh.status",
      "bh.version_no",
      "bh.created_at",
      "bh.approved_at",
      "i.code as item_code",
      localizedNameColumn(locale),
      "cu.username as created_by_name",
      "au.username as approved_by_name",
      lifecycleSupported
        ? knex.raw(
            "CASE WHEN bh.status = 'APPROVED' THEN bh.is_active ELSE NULL END as bom_is_active",
          )
        : knex.raw(
            "CASE WHEN bh.status = 'APPROVED' THEN COALESCE(i.is_active, true) ELSE NULL END as bom_is_active",
          ),
    )
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .leftJoin("erp.users as cu", "bh.created_by", "cu.id")
    .leftJoin("erp.users as au", "bh.approved_by", "au.id")
    .whereIn("bh.item_id", selectedItemIds);

  if (level !== "ALL") query.andWhere("bh.level", level);
  if (workflowStatus !== "ALL") query.andWhere("bh.status", workflowStatus);
  if (lifecycle === "ACTIVE") {
    query
      .andWhere("bh.status", "APPROVED")
      .andWhere(lifecycleSupported ? "bh.is_active" : "i.is_active", true);
  }
  if (lifecycle === "INACTIVE") {
    query
      .andWhere("bh.status", "APPROVED")
      .andWhere(lifecycleSupported ? "bh.is_active" : "i.is_active", false);
  }
  if (fromDate) query.andWhereRaw("bh.created_at::date >= ?", [fromDate]);
  if (toDate) query.andWhereRaw("bh.created_at::date <= ?", [toDate]);

  if (sortOrder === "oldest") {
    query.orderBy("bh.created_at", "asc").orderBy("bh.id", "asc");
  } else if (sortOrder === "item_version") {
    query
      .orderBy("i.name", "asc")
      .orderBy("bh.level", "asc")
      .orderBy("bh.version_no", "desc");
  } else {
    query.orderBy("bh.created_at", "desc").orderBy("bh.id", "desc");
  }

  const rows = await query;
  return {
    filters,
    options,
    reportData: {
      rows,
      totals: { rowCount: rows.length },
    },
  };
};

const getBomLifecycleStatusReportPageData = async ({ req, input = {} }) => {
  const rawFromDate = String(input?.from_date || input?.fromDate || "").trim();
  const rawToDate = String(input?.to_date || input?.toDate || "").trim();
  const fromDate = toDateOnly(rawFromDate);
  const toDate = toDateOnly(rawToDate);
  const selectedItemIds = normalizeIdList(input?.item_ids || input?.itemIds);
  const level = normalizeBomLevel(input?.level);
  const workflowStatus = normalizeBomStatus(input?.status);
  const lifecycle = normalizeLifecycle(input?.lifecycle);
  const pendingFlag = normalizePendingFlag(
    input?.pending_approval_flag || input?.pendingApprovalFlag,
  );
  const sortOrder = normalizeSortOrder(
    input?.order_by || input?.orderBy,
    ["latest", "item", "status"],
    "latest",
  );
  const reportLoaded =
    String(input?.load_report || input?.loadReport || "").trim() === "1";

  const validation = buildValidationState({
    t: req?.res?.locals?.t,
    rawFromDate,
    rawToDate,
    fromDate,
    toDate,
    reportLoaded,
  });

  const lifecycleSupported = await hasBomLifecycleColumn();
  const locale = localeOf(req);
  const itemOptions = await loadBomArticleOptions(level, locale);

  const filters = {
    reportLoaded,
    fromDate: fromDate || "",
    toDate: toDate || "",
    itemIds: selectedItemIds,
    level,
    status: workflowStatus,
    lifecycle,
    pendingApprovalFlag: pendingFlag,
    orderBy: sortOrder,
    validationMessage: validation.message,
  };

  const options = {
    items: itemOptions,
    levels: [{ value: "ALL" }, ...BOM_LEVELS.map((value) => ({ value }))],
    statuses: [{ value: "ALL" }, ...BOM_STATUSES.map((v) => ({ value: v }))],
    lifecycles: LIFECYCLE_OPTIONS.map((value) => ({ value })),
    pendingFlags: [{ value: "ALL" }, { value: "YES" }, { value: "NO" }],
    orderBys: [{ value: "latest" }, { value: "item" }, { value: "status" }],
  };

  if (!reportLoaded || validation.message) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        totals: {
          rowCount: 0,
          draftCount: 0,
          pendingCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          activeApprovedCount: 0,
          inactiveApprovedCount: 0,
        },
      },
    };
  }

  const query = knex("erp.bom_header as bh")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.item_id",
      "bh.level",
      "bh.status",
      "bh.version_no",
      "bh.created_at",
      "bh.approved_at",
      "i.code as item_code",
      localizedNameColumn(locale),
      lifecycleSupported
        ? knex.raw(
            "CASE WHEN bh.status = 'APPROVED' THEN bh.is_active ELSE NULL END as bom_is_active",
          )
        : knex.raw(
            "CASE WHEN bh.status = 'APPROVED' THEN COALESCE(i.is_active, true) ELSE NULL END as bom_is_active",
          ),
      knex.raw(
        `(SELECT COUNT(1) FROM erp.approval_request ar
          WHERE ar.entity_type = 'BOM'
            AND ar.entity_id = bh.id::text
            AND ar.status = 'PENDING') AS pending_approval_count`,
      ),
      knex.raw(
        `(SELECT MAX(ar.requested_at) FROM erp.approval_request ar
          WHERE ar.entity_type = 'BOM'
            AND ar.entity_id = bh.id::text
            AND ar.status = 'PENDING') AS last_pending_requested_at`,
      ),
    )
    .leftJoin("erp.items as i", "bh.item_id", "i.id");

  if (selectedItemIds.length) query.whereIn("bh.item_id", selectedItemIds);
  if (level !== "ALL") query.andWhere("bh.level", level);
  if (workflowStatus !== "ALL") query.andWhere("bh.status", workflowStatus);
  if (lifecycle === "ACTIVE") {
    query
      .andWhere("bh.status", "APPROVED")
      .andWhere(lifecycleSupported ? "bh.is_active" : "i.is_active", true);
  }
  if (lifecycle === "INACTIVE") {
    query
      .andWhere("bh.status", "APPROVED")
      .andWhere(lifecycleSupported ? "bh.is_active" : "i.is_active", false);
  }
  if (fromDate) query.andWhereRaw("bh.created_at::date >= ?", [fromDate]);
  if (toDate) query.andWhereRaw("bh.created_at::date <= ?", [toDate]);

  if (pendingFlag === "YES") {
    query.andWhereRaw(
      `(SELECT COUNT(1) FROM erp.approval_request ar
        WHERE ar.entity_type = 'BOM'
          AND ar.entity_id = bh.id::text
          AND ar.status = 'PENDING') > 0`,
    );
  } else if (pendingFlag === "NO") {
    query.andWhereRaw(
      `(SELECT COUNT(1) FROM erp.approval_request ar
        WHERE ar.entity_type = 'BOM'
          AND ar.entity_id = bh.id::text
          AND ar.status = 'PENDING') = 0`,
    );
  }

  if (sortOrder === "item") {
    query.orderBy("i.name", "asc").orderBy("bh.version_no", "desc");
  } else if (sortOrder === "status") {
    query.orderBy("bh.status", "asc").orderBy("bh.created_at", "desc");
  } else {
    query.orderBy("bh.created_at", "desc").orderBy("bh.id", "desc");
  }

  const rows = await query;
  const totals = rows.reduce(
    (acc, row) => {
      acc.rowCount += 1;
      const normalizedStatus = String(row?.status || "").toUpperCase();
      if (normalizedStatus === "DRAFT") acc.draftCount += 1;
      if (normalizedStatus === "PENDING") acc.pendingCount += 1;
      if (normalizedStatus === "APPROVED") {
        acc.approvedCount += 1;
        if (row?.bom_is_active === true) acc.activeApprovedCount += 1;
        if (row?.bom_is_active === false) acc.inactiveApprovedCount += 1;
      }
      if (normalizedStatus === "REJECTED") acc.rejectedCount += 1;
      return acc;
    },
    {
      rowCount: 0,
      draftCount: 0,
      pendingCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      activeApprovedCount: 0,
      inactiveApprovedCount: 0,
    },
  );

  return { filters, options, reportData: { rows, totals } };
};

const getBomApprovalQueueAgingReportPageData = async ({ req, input = {} }) => {
  const rawFromDate = String(input?.from_date || input?.fromDate || "").trim();
  const rawToDate = String(input?.to_date || input?.toDate || "").trim();
  const fromDate = toDateOnly(rawFromDate);
  const toDate = toDateOnly(rawToDate);
  const selectedItemIds = normalizeIdList(input?.item_ids || input?.itemIds);
  const requestStatus = normalizeApprovalStatus(
    input?.request_status || input?.requestStatus,
  );
  const actionType = normalizeApprovalAction(
    input?.request_action || input?.requestAction,
  );
  const agingBucket = normalizeAgingBucket(
    input?.aging_bucket || input?.agingBucket,
  );
  const sortOrder = normalizeSortOrder(
    input?.order_by || input?.orderBy,
    ["oldest_first", "newest_first"],
    "oldest_first",
  );
  const reportLoaded =
    String(input?.load_report || input?.loadReport || "").trim() === "1";

  const validation = buildValidationState({
    t: req?.res?.locals?.t,
    rawFromDate,
    rawToDate,
    fromDate,
    toDate,
    reportLoaded,
  });

  const locale = localeOf(req);
  const itemOptions = await loadBomArticleOptions("ALL", locale);
  const filters = {
    reportLoaded,
    fromDate: fromDate || "",
    toDate: toDate || "",
    itemIds: selectedItemIds,
    requestStatus,
    requestAction: actionType,
    agingBucket,
    orderBy: sortOrder,
    validationMessage: validation.message,
  };

  const options = {
    items: itemOptions,
    requestStatuses: APPROVAL_STATUSES.map((value) => ({ value })),
    requestActions: [
      { value: "ALL" },
      ...APPROVAL_ACTIONS.map((v) => ({ value: v })),
    ],
    agingBuckets: [
      { value: "ALL" },
      { value: "0_2" },
      { value: "3_7" },
      { value: "8_15" },
      { value: "15_PLUS" },
    ],
    orderBys: [{ value: "oldest_first" }, { value: "newest_first" }],
  };

  if (!reportLoaded || validation.message) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        totals: { rowCount: 0 },
        bucketCounts: { "0_2": 0, "3_7": 0, "8_15": 0, "15_PLUS": 0 },
      },
    };
  }

  const [
    hasReviewedByColumn,
    hasReviewedAtColumn,
    hasDecidedByColumn,
    hasDecidedAtColumn,
  ] = await Promise.all([
    knex.schema.withSchema("erp").hasColumn("approval_request", "reviewed_by"),
    knex.schema.withSchema("erp").hasColumn("approval_request", "reviewed_at"),
    knex.schema.withSchema("erp").hasColumn("approval_request", "decided_by"),
    knex.schema.withSchema("erp").hasColumn("approval_request", "decided_at"),
  ]);
  const reviewUserColumn = hasReviewedByColumn
    ? "ar.reviewed_by"
    : hasDecidedByColumn
      ? "ar.decided_by"
      : null;
  const reviewAtExpression = hasReviewedAtColumn
    ? knex.raw("ar.reviewed_at as reviewed_at")
    : hasDecidedAtColumn
      ? knex.raw("ar.decided_at as reviewed_at")
      : knex.raw("NULL::timestamp as reviewed_at");
  const reviewedByNameExpression = reviewUserColumn
    ? "rv.username as reviewed_by_name"
    : knex.raw("NULL::text as reviewed_by_name");

  const query = knex("erp.approval_request as ar")
    .select(
      "ar.id",
      "ar.entity_id",
      "ar.status",
      "ar.requested_at",
      "ar.requested_by",
      reviewAtExpression,
      knex.raw("COALESCE(ar.new_value ->> '_action', '') as request_action"),
      "ru.username as requested_by_name",
      reviewedByNameExpression,
      "bh.id as bom_id",
      "bh.bom_no",
      "bh.version_no",
      "bh.level",
      localizedNameColumn(locale),
      "i.code as item_code",
      knex.raw(`${AGE_DAYS_SQL} as age_days`),
    )
    .leftJoin("erp.users as ru", "ar.requested_by", "ru.id")
    .modify((builder) => {
      if (reviewUserColumn) {
        builder.leftJoin("erp.users as rv", reviewUserColumn, "rv.id");
      }
    })
    .leftJoin("erp.bom_header as bh", function joinBomHeader() {
      // CASE, not `regex AND cast`: Postgres does not guarantee AND operand
      // order, so it may run the ::bigint cast on a non-numeric entity_id and
      // abort the whole report with "invalid input syntax for type bigint".
      this.on(
        knex.raw(
          "bh.id = (CASE WHEN ar.entity_id ~ '^[0-9]+$' THEN ar.entity_id::bigint ELSE NULL END)",
        ),
      );
    })
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .where("ar.entity_type", "BOM")
    .andWhere("ar.status", requestStatus);

  if (selectedItemIds.length) query.andWhereIn("bh.item_id", selectedItemIds);
  if (actionType !== "ALL") {
    query.andWhereRaw("COALESCE(ar.new_value ->> '_action', '') = ?", [
      actionType,
    ]);
  }
  if (fromDate) query.andWhereRaw("ar.requested_at::date >= ?", [fromDate]);
  if (toDate) query.andWhereRaw("ar.requested_at::date <= ?", [toDate]);

  // Filter on the same whole-day age the Bucket column is derived from. The
  // old `now() - interval 'N days'` bounds disagreed with FLOOR(age): a
  // request 2.5 days old displayed "0-2" but only showed up under the 3-7
  // filter, and the bucket-count tiles could never be reconciled with the grid.
  const bucketRange = AGING_BUCKET_RANGES[agingBucket];
  if (bucketRange) {
    query.andWhereRaw(`${AGE_DAYS_SQL} >= ?`, [bucketRange.min]);
    if (bucketRange.max !== null) {
      query.andWhereRaw(`${AGE_DAYS_SQL} <= ?`, [bucketRange.max]);
    }
  }

  if (sortOrder === "newest_first") {
    query.orderBy("ar.requested_at", "desc").orderBy("ar.id", "desc");
  } else {
    query.orderBy("ar.requested_at", "asc").orderBy("ar.id", "asc");
  }

  const rows = await query;
  const bucketCounts = { "0_2": 0, "3_7": 0, "8_15": 0, "15_PLUS": 0 };
  rows.forEach((row) => {
    const bucket = resolveAgingBucketByDays(row?.age_days);
    bucketCounts[bucket] = Number(bucketCounts[bucket] || 0) + 1;
  });

  return {
    filters,
    options,
    reportData: {
      rows,
      totals: { rowCount: rows.length },
      bucketCounts,
    },
  };
};

const getBomChangeLogReportPageData = async ({ req, input = {} }) => {
  const t = req?.res?.locals?.t;
  const rawFromDate = String(input?.from_date || input?.fromDate || "").trim();
  const rawToDate = String(input?.to_date || input?.toDate || "").trim();
  const fromDate = toDateOnly(rawFromDate);
  const toDate = toDateOnly(rawToDate);
  const selectedItemIds = normalizeIdList(input?.item_ids || input?.itemIds);
  const bomNo = String(input?.bom_no || input?.bomNo || "").trim();
  const section = normalizeChangeSection(input?.section);
  const changeType = normalizeChangeType(
    input?.change_type || input?.changeType,
  );
  const changedByIds = normalizeIdList(
    input?.changed_by_ids || input?.changedByIds || input?.changed_by_id,
  );
  const sortOrder = normalizeSortOrder(
    input?.order_by || input?.orderBy,
    ["latest", "oldest"],
    "latest",
  );
  const limit = normalizeLimit(input?.limit, 50);
  const pageInput = normalizePage(input?.page, 1);
  const reportLoaded =
    String(input?.load_report || input?.loadReport || "").trim() === "1";

  const validation = buildValidationState({
    t,
    rawFromDate,
    rawToDate,
    fromDate,
    toDate,
    reportLoaded,
  });

  const isGlobalQuery = reportLoaded && selectedItemIds.length === 0 && !bomNo;
  let guardrailMessage = "";
  if (!validation.message && isGlobalQuery) {
    if (!fromDate || !toDate) {
      guardrailMessage =
        (typeof t === "function" && t("bom_change_log_requires_date_range")) ||
        "Date range is required when article and BOM number are not selected.";
    } else {
      const spanDays = diffDaysInclusive(fromDate, toDate);
      if (spanDays > 7) {
        guardrailMessage =
          (typeof t === "function" && t("bom_change_log_max_date_range")) ||
          "Date range cannot exceed 7 days for global change log search.";
      }
    }
  }

  const hasChangeLogTable = await hasBomChangeLogTable();
  const infraMessage =
    reportLoaded && !hasChangeLogTable
      ? (typeof t === "function" && t("bom_change_log_not_available")) ||
        "BOM change log is not available in this environment."
      : "";
  const locale = localeOf(req);
  const [itemOptions, changedByOptions] = await Promise.all([
    loadBomArticleOptions("ALL", locale),
    hasChangeLogTable
      ? knex("erp.users as u")
          .distinct("u.id", "u.username")
          .join("erp.bom_change_log as bcl", "bcl.changed_by", "u.id")
          .orderBy("u.username", "asc")
      : Promise.resolve([]),
  ]);

  const filters = {
    reportLoaded,
    fromDate: fromDate || "",
    toDate: toDate || "",
    itemIds: selectedItemIds,
    bomNo,
    section,
    changeType,
    changedByIds,
    orderBy: sortOrder,
    page: pageInput,
    limit,
    validationMessage: validation.message || guardrailMessage || infraMessage,
  };

  const options = {
    items: itemOptions,
    changedByUsers: changedByOptions,
    sections: [
      { value: "ALL" },
      ...CHANGE_LOG_SECTIONS.map((v) => ({ value: v })),
    ],
    changeTypes: [{ value: "ALL" }, ...CHANGE_TYPES.map((v) => ({ value: v }))],
    limits: [{ value: 25 }, { value: 50 }, { value: 100 }],
    orderBys: [{ value: "latest" }, { value: "oldest" }],
  };

  if (!reportLoaded || validation.message || guardrailMessage || infraMessage) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        totals: { rowCount: 0 },
        pagination: {
          page: 1,
          limit,
          totalRows: 0,
          totalPages: 0,
          hasPrev: false,
          hasNext: false,
        },
      },
    };
  }

  const baseQuery = knex("erp.bom_change_log as bcl")
    .leftJoin("erp.bom_header as bh", "bcl.bom_id", "bh.id")
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .leftJoin("erp.users as u", "bcl.changed_by", "u.id")
    .leftJoin("erp.approval_request as ar", "bcl.request_id", "ar.id");

  if (selectedItemIds.length) baseQuery.whereIn("bh.item_id", selectedItemIds);
  if (bomNo) baseQuery.andWhereILike("bh.bom_no", `%${bomNo}%`);
  if (section !== "ALL") baseQuery.andWhere("bcl.section", section);
  if (changeType !== "ALL") baseQuery.andWhere("bcl.change_type", changeType);
  if (changedByIds.length) baseQuery.andWhereIn("bcl.changed_by", changedByIds);
  if (fromDate) baseQuery.andWhereRaw("bcl.changed_at::date >= ?", [fromDate]);
  if (toDate) baseQuery.andWhereRaw("bcl.changed_at::date <= ?", [toDate]);

  const countRow = await baseQuery
    .clone()
    .clearSelect()
    .clearOrder()
    .countDistinct({ count: "bcl.id" })
    .first();
  const totalRows = Number(countRow?.count || 0);
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / limit) : 0;
  const page = totalPages > 0 ? Math.min(pageInput, totalPages) : 1;
  const offset = (page - 1) * limit;

  const rowsQuery = baseQuery
    .clone()
    .select(
      "bcl.id",
      "bcl.bom_id",
      "bcl.version_no",
      "bcl.request_id",
      "bcl.section",
      "bcl.entity_key",
      "bcl.change_type",
      "bcl.old_value",
      "bcl.new_value",
      "bcl.changed_by",
      "bcl.changed_at",
      "bh.bom_no",
      "bh.level",
      "bh.status as bom_status",
      localizedNameColumn(locale),
      "i.code as item_code",
      "u.username as changed_by_name",
      knex.raw("COALESCE(ar.new_value ->> '_action', '') as request_action"),
      "ar.status as request_status",
      "ar.requested_at as request_created_at",
    )
    .limit(limit)
    .offset(offset);

  if (sortOrder === "oldest") {
    rowsQuery.orderBy("bcl.changed_at", "asc").orderBy("bcl.id", "asc");
  } else {
    rowsQuery.orderBy("bcl.changed_at", "desc").orderBy("bcl.id", "desc");
  }

  const rows = await rowsQuery;
  return {
    filters: { ...filters, page },
    options,
    reportData: {
      rows,
      totals: { rowCount: totalRows },
      pagination: {
        page,
        limit,
        totalRows,
        totalPages,
        hasPrev: page > 1,
        hasNext: totalPages > page,
      },
    },
  };
};

const getBomCostBreakdownReportPageData = async ({ req, input = {} }) => {
  const t = req?.res?.locals?.t;
  const canFilterAllBranches = reportCanFilterAllBranches(
    req,
    "master_data.bom.reports.cost_breakdown",
  );
  const selectedItemIds = normalizeIdList(input?.item_ids || input?.itemIds);
  const level = normalizeBomLevel(input?.level);
  const explosionMode = normalizeExplosionMode(
    input?.explosion_mode || input?.explosionMode,
  );
  const valuationMode = normalizeValuationMode(
    input?.valuation_mode || input?.valuationMode,
  );
  const labourAggregation = normalizeLabourAggregation(
    input?.labour_aggregation || input?.labourAggregation,
  );
  const includeInactiveApproved =
    String(input?.include_inactive || input?.includeInactive || "0") === "1";
  const selectedBranchIds = normalizeBranchFilter({
    req,
    input,
    scopeKey: "master_data.bom.reports.cost_breakdown",
  });
  const sortOrder = normalizeSortOrder(
    input?.order_by || input?.orderBy,
    ["total_cost_desc", "total_cost_asc", "item_name"],
    "total_cost_desc",
  );
  const reportLoaded =
    String(input?.load_report || input?.loadReport || "").trim() === "1";
  const missingRequiredItem = reportLoaded && selectedItemIds.length === 0;

  const locale = localeOf(req);
  const [itemOptions, branchOptions] = await Promise.all([
    loadBomArticleOptions(level, locale),
    loadBranchOptions(req, canFilterAllBranches),
  ]);
  const lifecycleSupported = await hasBomLifecycleColumn();
  const [hasRmStockBalanceTable, hasSkuStockBalanceTable, pairFactorByUomId] =
    await Promise.all([
      hasStockBalanceRmTable(),
      hasStockBalanceSkuTable(),
      loadPairFactorByUomId(),
    ]);

  const filters = {
    reportLoaded,
    itemIds: selectedItemIds,
    level,
    explosionMode,
    valuationMode,
    labourAggregation,
    includeInactive: includeInactiveApproved,
    branchIds: selectedBranchIds,
    canFilterAllBranches,
    orderBy: sortOrder,
    missingRequiredItem,
  };

  const options = {
    items: itemOptions,
    branches: branchOptions,
    levels: [{ value: "ALL" }, ...BOM_LEVELS.map((value) => ({ value }))],
    explosionModes: COST_EXPLOSION_MODES.map((value) => ({ value })),
    valuationModes: COST_VALUATION_MODES.map((value) => ({ value })),
    labourAggregations: LABOUR_AGGREGATION_MODES.map((value) => ({ value })),
    orderBys: [
      { value: "total_cost_desc" },
      { value: "total_cost_asc" },
      { value: "item_name" },
    ],
  };

  if (!reportLoaded || missingRequiredItem) {
    return {
      filters,
      options,
      reportData: {
        summaryRows: [],
        detailRows: [],
        totals: {
          bomCount: 0,
          rmCost: 0,
          labourCost: 0,
          sfgCost: 0,
          totalCost: 0,
        },
      },
    };
  }

  const latestApprovedSubQuery = knex("erp.bom_header as bh2")
    .select("bh2.item_id", "bh2.level")
    .max("bh2.version_no as max_version")
    .where("bh2.status", "APPROVED")
    .groupBy("bh2.item_id", "bh2.level")
    .as("latest");

  const bomQuery = knex("erp.bom_header as bh")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.item_id",
      "bh.level",
      "bh.status",
      "bh.version_no",
      "bh.output_qty",
      "bh.output_uom_id",
      lifecycleSupported
        ? "bh.is_active"
        : knex.raw("COALESCE(i.is_active, true) as is_active"),
      "i.code as item_code",
      localizedNameColumn(locale),
    )
    .join(latestApprovedSubQuery, function joinLatest() {
      this.on("latest.item_id", "=", "bh.item_id")
        .andOn("latest.level", "=", "bh.level")
        .andOn("latest.max_version", "=", "bh.version_no");
    })
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .whereIn("bh.item_id", selectedItemIds)
    .andWhere("bh.status", "APPROVED");

  if (level !== "ALL") bomQuery.andWhere("bh.level", level);
  if (lifecycleSupported && !includeInactiveApproved) {
    bomQuery.andWhere("bh.is_active", true);
  }

  const bomRows = await bomQuery;
  if (!bomRows.length) {
    return {
      filters,
      options,
      reportData: {
        summaryRows: [],
        detailRows: [],
        totals: {
          bomCount: 0,
          rmCost: 0,
          labourCost: 0,
          sfgCost: 0,
          totalCost: 0,
        },
      },
    };
  }

  const bomById = new Map();
  const preferredApprovedBomByItemId = new Map();
  const rmLinesByBom = new Map();
  const labourLinesByBom = new Map();
  const sfgLinesByBom = new Map();

  const pushIntoMap = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };

  const pickPreferredBomByItem = (rows = []) => {
    const preferredByItem = new Map();
    rows.forEach((row) => {
      const itemId = toPositiveInt(row.item_id);
      if (!itemId) return;
      const current = preferredByItem.get(itemId);
      if (!current) {
        preferredByItem.set(itemId, row);
        return;
      }
      const currentLevelWeight =
        String(current.level || "").toUpperCase() === "SEMI_FINISHED" ? 2 : 1;
      const nextLevelWeight =
        String(row.level || "").toUpperCase() === "SEMI_FINISHED" ? 2 : 1;
      if (nextLevelWeight > currentLevelWeight) {
        preferredByItem.set(itemId, row);
        return;
      }
      if (
        nextLevelWeight === currentLevelWeight &&
        Number(row.version_no || 0) > Number(current.version_no || 0)
      ) {
        preferredByItem.set(itemId, row);
      }
    });
    return preferredByItem;
  };

  const loadLinesForBomIds = async (bomIds = []) => {
    const ids = [
      ...new Set((bomIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
    ];
    if (!ids.length) return;
    const [rmRows, labourRows, sfgRows] = await Promise.all([
      knex("erp.bom_rm_line as rl")
        .select(
          "rl.bom_id",
          "rl.rm_item_id",
          "rl.color_id",
          "rl.size_id",
          "rl.dept_id",
          "rl.qty",
          "rl.normal_loss_pct",
          "i.code as item_code",
          localizedNameColumn(locale),
        )
        .leftJoin("erp.items as i", "rl.rm_item_id", "i.id")
        .whereIn("rl.bom_id", ids),
      knex("erp.bom_labour_line as ll")
        .select(
          "ll.bom_id",
          "ll.dept_id",
          "ll.labour_id",
          "ll.rate_type",
          "ll.rate_value",
          localizedNameColumn(locale, "dept_name", "d"),
          localizedNameColumn(locale, "labour_name", "l"),
        )
        .leftJoin("erp.departments as d", "ll.dept_id", "d.id")
        .leftJoin("erp.labours as l", "ll.labour_id", "l.id")
        .whereIn("ll.bom_id", ids),
      knex("erp.bom_sfg_line as sl")
        .select(
          "sl.bom_id",
          "sl.sfg_sku_id",
          "sl.required_qty",
          // fg_size_id and uom_id are what make an SFG line costable: the line
          // applies to ONE finished size, and its qty is in its own UOM.
          "sl.fg_size_id",
          "sl.uom_id",
          "s.sku_code",
          localizedNameColumn(locale),
          "v.item_id as sfg_item_id",
          localizedNameColumn(locale, "fg_size_name", "sz"),
        )
        .leftJoin("erp.skus as s", "sl.sfg_sku_id", "s.id")
        .leftJoin("erp.variants as v", "s.variant_id", "v.id")
        .leftJoin("erp.items as i", "v.item_id", "i.id")
        .leftJoin("erp.sizes as sz", "sl.fg_size_id", "sz.id")
        .whereIn("sl.bom_id", ids),
    ]);
    rmRows.forEach((row) =>
      pushIntoMap(rmLinesByBom, Number(row.bom_id || 0), row),
    );
    labourRows.forEach((row) =>
      pushIntoMap(labourLinesByBom, Number(row.bom_id || 0), row),
    );
    sfgRows.forEach((row) =>
      pushIntoMap(sfgLinesByBom, Number(row.bom_id || 0), row),
    );
  };

  bomRows.forEach((row) => {
    const bomId = toPositiveInt(row.id);
    const itemId = toPositiveInt(row.item_id);
    if (!bomId || !itemId) return;
    bomById.set(bomId, row);
    preferredApprovedBomByItemId.set(itemId, row);
  });

  await loadLinesForBomIds([...bomById.keys()]);

  if (explosionMode === "EXPLODED") {
    const seenItemIds = new Set();
    const pendingItemIds = new Set();
    const pushSfgItemIdsFromBom = (bomId) => {
      const rows = sfgLinesByBom.get(Number(bomId || 0)) || [];
      rows.forEach((line) => {
        const itemId = toPositiveInt(line.sfg_item_id);
        if (itemId && !seenItemIds.has(itemId)) pendingItemIds.add(itemId);
      });
    };
    [...bomById.keys()].forEach((id) => pushSfgItemIdsFromBom(id));

    while (pendingItemIds.size) {
      const batchItemIds = [...pendingItemIds]
        .map((id) => toPositiveInt(id))
        .filter((id) => id && !seenItemIds.has(id))
        .slice(0, 250);
      if (!batchItemIds.length) break;
      batchItemIds.forEach((id) => {
        pendingItemIds.delete(id);
        seenItemIds.add(id);
      });

      const childCandidates = await knex("erp.bom_header as bh")
        .select(
          "bh.id",
          "bh.bom_no",
          "bh.item_id",
          "bh.level",
          "bh.status",
          "bh.version_no",
          "bh.output_qty",
          "bh.output_uom_id",
          lifecycleSupported
            ? "bh.is_active"
            : knex.raw("COALESCE(i.is_active, true) as is_active"),
          "i.code as item_code",
          localizedNameColumn(locale),
        )
        .leftJoin("erp.items as i", "bh.item_id", "i.id")
        .whereIn("bh.item_id", batchItemIds)
        .andWhere("bh.status", "APPROVED")
        .modify((query) => {
          if (lifecycleSupported && !includeInactiveApproved) {
            query.andWhere("bh.is_active", true);
          }
        })
        .orderBy("bh.item_id", "asc")
        .orderByRaw(
          "CASE WHEN bh.level = 'SEMI_FINISHED' THEN 0 ELSE 1 END ASC",
        )
        .orderBy("bh.version_no", "desc");

      const preferredRows = pickPreferredBomByItem(childCandidates);
      const nextBomIds = [];
      preferredRows.forEach((row, itemId) => {
        if (preferredApprovedBomByItemId.has(itemId)) return;
        preferredApprovedBomByItemId.set(itemId, row);
        const bomId = toPositiveInt(row.id);
        if (!bomId || bomById.has(bomId)) return;
        bomById.set(bomId, row);
        nextBomIds.push(bomId);
      });
      if (!nextBomIds.length) continue;
      await loadLinesForBomIds(nextBomIds);
      nextBomIds.forEach((id) => pushSfgItemIdsFromBom(id));
    }
  }

  const allRmLines = [];
  const allSfgLines = [];
  rmLinesByBom.forEach((rows) => rows.forEach((row) => allRmLines.push(row)));
  sfgLinesByBom.forEach((rows) => rows.forEach((row) => allSfgLines.push(row)));
  const rmItemIds = [
    ...new Set(
      allRmLines.map((line) => toPositiveInt(line.rm_item_id)).filter(Boolean),
    ),
  ];
  const sfgSkuIds = [
    ...new Set(
      allSfgLines.map((line) => toPositiveInt(line.sfg_sku_id)).filter(Boolean),
    ),
  ];

  // Rates are stored at whatever colour/size granularity the buyer maintained,
  // so an exact (item,colour,size) lookup misses a colour-only or item-only
  // row and silently costs the line at 0. Keep every candidate per item and
  // resolve with the same most-specific-wins precedence the purchase entry
  // screen uses (see RM_PURCHASE_RATE_LATERAL_SQL in purchase-report-service).
  const rmRateCandidatesByItem = new Map();
  const pushRateCandidate = (map, itemId, candidate) => {
    if (!itemId || !(Number(candidate.rate) > 0)) return;
    if (!map.has(itemId)) map.set(itemId, []);
    map.get(itemId).push(candidate);
  };
  const resolveVariantRate = (candidates, colorId, sizeId) => {
    const matches = (candidates || []).filter((row) => {
      // A NULL dimension on the rate row means "applies to any"; a NULL on the
      // BOM line means the line itself is dimensionless, so only equally
      // dimensionless rate rows may apply.
      const colorOk = colorId
        ? !row.colorId || row.colorId === colorId
        : !row.colorId;
      const sizeOk = sizeId ? !row.sizeId || row.sizeId === sizeId : !row.sizeId;
      return colorOk && sizeOk;
    });
    if (!matches.length) return 0;
    matches.sort((a, b) => {
      const specificity = (row) =>
        (row.colorId ? 1 : 0) + (row.sizeId ? 1 : 0);
      const bySpecificity = specificity(b) - specificity(a);
      if (bySpecificity !== 0) return bySpecificity;
      return Number(b.seq || 0) - Number(a.seq || 0);
    });
    return Number(matches[0].rate) || 0;
  };

  const rmWacCandidatesByItem = new Map();
  if (hasRmStockBalanceTable && rmItemIds.length) {
    const wacRows = await knex("erp.stock_balance_rm as sb")
      .select(
        "sb.item_id",
        "sb.color_id",
        "sb.size_id",
        knex.raw("SUM(COALESCE(sb.qty, 0)) as qty_sum"),
        knex.raw("SUM(COALESCE(sb.value, 0)) as value_sum"),
      )
      .where("sb.stock_state", "ON_HAND")
      .whereIn("sb.item_id", rmItemIds)
      .modify((query) => {
        if (selectedBranchIds.length)
          query.whereIn("sb.branch_id", selectedBranchIds);
      })
      .groupBy("sb.item_id", "sb.color_id", "sb.size_id");
    wacRows.forEach((row) => {
      const qty = Number(row.qty_sum || 0);
      const value = Number(row.value_sum || 0);
      const rate = qty > 0 ? value / qty : 0;
      pushRateCandidate(rmWacCandidatesByItem, toPositiveInt(row.item_id), {
        colorId: toPositiveInt(row.color_id),
        sizeId: toPositiveInt(row.size_id),
        rate: Number.isFinite(rate) ? rate : 0,
        seq: 0,
      });
    });
  }

  if (rmItemIds.length) {
    const purchaseRows = await knex("erp.rm_purchase_rates as r")
      .select(
        "r.id",
        "r.rm_item_id",
        "r.color_id",
        "r.size_id",
        "r.purchase_rate",
        "r.avg_purchase_rate",
      )
      .whereIn("r.rm_item_id", rmItemIds)
      .andWhere("r.is_active", true);
    purchaseRows.forEach((row) => {
      const rate = Number(row.avg_purchase_rate || row.purchase_rate || 0);
      pushRateCandidate(rmRateCandidatesByItem, toPositiveInt(row.rm_item_id), {
        colorId: toPositiveInt(row.color_id),
        sizeId: toPositiveInt(row.size_id),
        rate: Number.isFinite(rate) ? rate : 0,
        seq: Number(row.id || 0),
      });
    });
  }

  const sfgWacBySku = new Map();
  if (hasSkuStockBalanceTable && sfgSkuIds.length) {
    const sfgRows = await knex("erp.stock_balance_sku as sb")
      .select(
        "sb.sku_id",
        knex.raw("SUM(COALESCE(sb.qty_pairs, 0)) as qty_sum"),
        knex.raw("SUM(COALESCE(sb.value, 0)) as value_sum"),
      )
      .where("sb.stock_state", "ON_HAND")
      .whereIn("sb.sku_id", sfgSkuIds)
      .modify((query) => {
        if (selectedBranchIds.length)
          query.whereIn("sb.branch_id", selectedBranchIds);
      })
      .groupBy("sb.sku_id");
    sfgRows.forEach((row) => {
      const skuId = toPositiveInt(row.sku_id);
      if (!skuId) return;
      const qty = Number(row.qty_sum || 0);
      const value = Number(row.value_sum || 0);
      const rate = qty > 0 ? value / qty : 0;
      sfgWacBySku.set(skuId, Number.isFinite(rate) ? rate : 0);
    });
  }

  const summaryRows = [];
  const treeRows = [];
  const treeChildCount = new Map();
  let treeNodeSeq = 0;

  const buildTreeNodeId = () => `bom-node-${++treeNodeSeq}`;
  const pushTreeRow = (row) => {
    treeRows.push(row);
    if (row.parent_node_id) {
      treeChildCount.set(
        row.parent_node_id,
        (treeChildCount.get(row.parent_node_id) || 0) + 1,
      );
    }
  };
  const totals = {
    bomCount: 0,
    rmCost: 0,
    labourCost: 0,
    sfgCost: 0,
    totalCost: 0,
  };

  const resolveRmRate = (line) => {
    const itemId = toPositiveInt(line.rm_item_id) || 0;
    const colorId = toPositiveInt(line.color_id);
    const sizeId = toPositiveInt(line.size_id);
    const wacRate = resolveVariantRate(
      rmWacCandidatesByItem.get(itemId),
      colorId,
      sizeId,
    );
    const purchaseRate = resolveVariantRate(
      rmRateCandidatesByItem.get(itemId),
      colorId,
      sizeId,
    );
    let effectiveRate = 0;
    let source = "NONE";
    if (valuationMode === "WAC_ONLY") {
      effectiveRate = wacRate;
      source = "WAC";
    } else if (valuationMode === "PURCHASE_RATE") {
      effectiveRate = purchaseRate;
      source = "PURCHASE_RATE";
    } else if (wacRate > 0) {
      effectiveRate = wacRate;
      source = "WAC";
    } else {
      effectiveRate = purchaseRate;
      source = "PURCHASE_RATE";
    }
    return {
      wacRate: Number(wacRate.toFixed(6)),
      purchaseRate: Number(purchaseRate.toFixed(6)),
      effectiveRate: Number(effectiveRate.toFixed(6)),
      source,
    };
  };

  const resolveBomOutputQty = (bomRow) => {
    const outputQty = Number(bomRow?.output_qty || 1);
    return outputQty > 0 ? outputQty : 1;
  };

  const resolveUomFactorToPair = (uomId) => {
    const id = toPositiveInt(uomId);
    if (!id) return 1;
    const factor = Number(pairFactorByUomId.get(id) || 0);
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  };

  // A BOM lot is `output_qty` expressed in `output_uom_id`; everything priced
  // per pair (labour rates, SFG stock WAC) has to be scaled by the pair count,
  // not by the raw output_qty. Skipping this understated a Dozen-output BOM's
  // labour and SFG cost by 12x -- see production-voucher-service.js, which
  // derives outputQtyInPairs the same way.
  const resolveBomOutputPairs = (bomRow) => {
    const pairs = Number(
      (
        resolveBomOutputQty(bomRow) *
        resolveUomFactorToPair(bomRow?.output_uom_id)
      ).toFixed(6),
    );
    return pairs > 0 ? pairs : resolveBomOutputQty(bomRow);
  };

  // SFG lines are declared per finished size: producing one lot of size 8
  // consumes only the lines whose fg_size_id is 8 (production filters on
  // fg_size_id === the SKU's size). Summing every size therefore multiplied a
  // BOM's SFG cost by its size count. Collapse the sizes onto one representative
  // lot by weighting each size 1/sizeCount -- i.e. the average of the per-size
  // subtotals, which is exact whenever the sizes consume alike (the normal case:
  // one upper per pair, differing only in which size-specific SKU is used).
  //
  // This is deliberately NOT tied to the labour aggregation control: multiple
  // labours in a department are additional operations that really do all get
  // costed, whereas size variants are mutually exclusive for a given lot.
  const resolveSfgSizeWeights = (sfgLines) => {
    const weights = new Map();
    const sizeIds = [
      ...new Set((sfgLines || []).map((line) => Number(line.fg_size_id || 0))),
    ];
    const weight = sizeIds.length > 1 ? 1 / sizeIds.length : 1;
    sizeIds.forEach((sizeId) => weights.set(sizeId, weight));
    return weights;
  };

  bomRows.forEach((bomRow) => {
    const bomId = Number(bomRow.id || 0);
    const outputQty = resolveBomOutputQty(bomRow);
    let rmCost = 0;
    let labourCost = 0;
    let sfgCost = 0;
    const rootNodeId = buildTreeNodeId();
    const traversalStack = [
      {
        rootBomId: bomId,
        currentBomId: bomId,
        factor: 1,
        depth: 0,
        path: [bomId],
        node_id: rootNodeId,
        parent_node_id: null,
      },
    ];
    const maxDepth = 15;

    while (traversalStack.length) {
      const node = traversalStack.pop();
      const currentBomId = Number(node.currentBomId || 0);
      const factor = Number(node.factor || 0);
      if (!currentBomId || !Number.isFinite(factor) || factor <= 0) continue;
      const currentBom = bomById.get(currentBomId);
      if (!currentBom) continue;
      const currentOutputPairs = resolveBomOutputPairs(currentBom);
      const currentNodeId = node.node_id || buildTreeNodeId();
      const currentParentNodeId = node.parent_node_id || null;
      const currentDepth = Number(node.depth || 0);

      const nodeRow = {
        row_type: "BOM",
        node_id: currentNodeId,
        parent_node_id: currentParentNodeId,
        depth: currentDepth,
        bom_id: currentBomId,
        bom_no: currentBom.bom_no,
        item_name: currentBom.item_name,
        item_code: currentBom.item_code,
        level: currentBom.level,
        version_no: currentBom.version_no,
        component_type: "SFG",
        component_label:
          currentBom.item_code || currentBom.item_name || currentBom.bom_no,
        qty: null,
        unit_rate: null,
        line_cost: null,
        rate_source: null,
        wac_rate: null,
        purchase_rate: null,
        variance_pct: null,
        rm_cost: 0,
        labour_cost: 0,
        sfg_cost: 0,
        total_cost: 0,
      };
      pushTreeRow(nodeRow);

      const rmForBom = rmLinesByBom.get(currentBomId) || [];
      rmForBom.forEach((line) => {
        const itemId = toPositiveInt(line.rm_item_id) || 0;
        const { wacRate, purchaseRate, effectiveRate, source } =
          resolveRmRate(line);
        const baseQty = Number(line.qty || 0);
        const lossPct = Number(line.normal_loss_pct || 0);
        // Accumulate at full precision and round only what is displayed --
        // rounding each line first lets fractional weights drift the total.
        const rawQty = baseQty * (1 + lossPct / 100) * factor;
        const effectiveQty = Number(rawQty.toFixed(6));
        const lineCost = Number((rawQty * effectiveRate).toFixed(6));
        rmCost += rawQty * effectiveRate;
        nodeRow.rm_cost += rawQty * effectiveRate;
        const variancePct =
          wacRate > 0
            ? Number((((purchaseRate - wacRate) / wacRate) * 100).toFixed(2))
            : 0;
        pushTreeRow({
          row_type: "COMPONENT",
          node_id: buildTreeNodeId(),
          parent_node_id: currentNodeId,
          depth: currentDepth + 1,
          bom_id: currentBomId,
          bom_no: currentBom.bom_no,
          item_name: currentBom.item_name,
          item_code: currentBom.item_code,
          level: currentBom.level,
          version_no: currentBom.version_no,
          component_type: "RM",
          component_label: line.item_name || line.item_code || `RM#${itemId}`,
          qty: effectiveQty,
          unit_rate: effectiveRate,
          line_cost: lineCost,
          rate_source: source,
          wac_rate: wacRate,
          purchase_rate: purchaseRate,
          variance_pct: variancePct,
        });
      });

      const labourForBom = labourLinesByBom.get(currentBomId) || [];
      const labourCostsByDept = new Map();
      labourForBom.forEach((line) => {
        const deptId = toPositiveInt(line.dept_id) || 0;
        const rateValue = Number(line.rate_value || 0);
        const rateType = String(line.rate_type || "PER_PAIR").toUpperCase();
        // Rates are per PAIR (or per dozen pairs), so the multiplier is the
        // lot's pair count -- never the raw output_qty, which may be dozens.
        const ratePerPair =
          rateType === "PER_DOZEN" ? rateValue / 12 : rateValue;
        const normalizedCost = Number(
          (ratePerPair * currentOutputPairs).toFixed(6),
        );
        if (!labourCostsByDept.has(deptId)) {
          labourCostsByDept.set(deptId, {
            dept_name: line.dept_name || `Dept#${deptId}`,
            values: [],
          });
        }
        labourCostsByDept.get(deptId).values.push(normalizedCost);
      });
      labourCostsByDept.forEach((entry) => {
        const values = entry.values.filter((v) => Number.isFinite(v));
        if (!values.length) return;
        const total = values.reduce((sum, value) => sum + value, 0);
        const deptCostPerLot =
          labourAggregation === "MAX"
            ? Math.max(...values)
            : labourAggregation === "AVG"
              ? total / values.length
              : total;
        const scaledDeptCost = Number((deptCostPerLot * factor).toFixed(6));
        labourCost += deptCostPerLot * factor;
        nodeRow.labour_cost += deptCostPerLot * factor;
        pushTreeRow({
          row_type: "COMPONENT",
          node_id: buildTreeNodeId(),
          parent_node_id: currentNodeId,
          depth: currentDepth + 1,
          bom_id: currentBomId,
          bom_no: currentBom.bom_no,
          item_name: currentBom.item_name,
          item_code: currentBom.item_code,
          level: currentBom.level,
          version_no: currentBom.version_no,
          component_type: "LABOUR",
          component_label: entry.dept_name || "-",
          qty: Number((currentOutputPairs * factor).toFixed(6)),
          unit_rate: Number(deptCostPerLot.toFixed(6)),
          line_cost: scaledDeptCost,
          rate_source: labourAggregation,
          wac_rate: null,
          purchase_rate: null,
          variance_pct: null,
        });
      });

      const sfgForBom = sfgLinesByBom.get(currentBomId) || [];
      const sfgSizeWeights = resolveSfgSizeWeights(sfgForBom);
      const sfgLabelOf = (line, skuId) => {
        const base = line.item_name || line.sku_code || `SKU#${skuId}`;
        return line.fg_size_name ? `${base} (${line.fg_size_name})` : base;
      };
      sfgForBom.forEach((line) => {
        const skuId = toPositiveInt(line.sfg_sku_id) || 0;
        const sizeWeight = Number(
          sfgSizeWeights.get(Number(line.fg_size_id || 0)) ?? 1,
        );
        // MAX aggregation zeroes every size but the costliest; drop those lines
        // outright rather than showing a row that contributes nothing.
        if (!(sizeWeight > 0)) return;
        // required_qty is stored in the line's own UOM while every SFG rate is
        // per PAIR, so convert before costing (production does the same).
        const qtyPairs =
          Number(line.required_qty || 0) * resolveUomFactorToPair(line.uom_id);
        // Keep the unrounded quantity for costing; sizeWeight is often 1/n.
        const rawQty = qtyPairs * sizeWeight * factor;
        const scaledQty = Number(rawQty.toFixed(6));
        if (!(rawQty > 0)) return;
        if (explosionMode === "EXPLODED" && node.depth < maxDepth) {
          const childItemId = toPositiveInt(line.sfg_item_id);
          const childBom = childItemId
            ? preferredApprovedBomByItemId.get(childItemId)
            : null;
          const childBomId = toPositiveInt(childBom?.id);
          if (
            childBomId &&
            childBomId !== currentBomId &&
            !node.path.includes(childBomId)
          ) {
            // Both sides are now in pairs, so the ratio is dimensionless.
            const childOutputPairs = resolveBomOutputPairs(childBom);
            const childFactor = rawQty / childOutputPairs;
            if (childFactor > 0) {
              const childNodeId = buildTreeNodeId();
              traversalStack.push({
                rootBomId: node.rootBomId,
                currentBomId: childBomId,
                factor: childFactor,
                depth: Number(node.depth || 0) + 1,
                path: [...node.path, childBomId],
                node_id: childNodeId,
                parent_node_id: currentNodeId,
              });
              return;
            }
          }
        }
        const rate = Number(sfgWacBySku.get(skuId) || 0);
        const lineCost = Number((rawQty * rate).toFixed(6));
        sfgCost += rawQty * rate;
        nodeRow.sfg_cost += rawQty * rate;
        pushTreeRow({
          row_type: "COMPONENT",
          node_id: buildTreeNodeId(),
          parent_node_id: currentNodeId,
          depth: currentDepth + 1,
          bom_id: currentBomId,
          bom_no: currentBom.bom_no,
          item_name: currentBom.item_name,
          item_code: currentBom.item_code,
          level: currentBom.level,
          version_no: currentBom.version_no,
          component_type: "SFG",
          component_label: sfgLabelOf(line, skuId),
          qty: scaledQty,
          unit_rate: Number(rate.toFixed(6)),
          line_cost: lineCost,
          rate_source: explosionMode === "EXPLODED" ? "WAC_FALLBACK" : "WAC",
          wac_rate: Number(rate.toFixed(6)),
          purchase_rate: null,
          variance_pct: null,
        });
      });

      nodeRow.total_cost = Number(
        (nodeRow.rm_cost + nodeRow.labour_cost + nodeRow.sfg_cost).toFixed(6),
      );
      nodeRow.line_cost = nodeRow.total_cost;
    }

    const totalCost = Number((rmCost + labourCost + sfgCost).toFixed(6));
    summaryRows.push({
      bom_id: bomId,
      bom_no: bomRow.bom_no,
      item_name: bomRow.item_name,
      item_code: bomRow.item_code,
      level: bomRow.level,
      version_no: bomRow.version_no,
      output_qty: outputQty,
      output_pairs: resolveBomOutputPairs(bomRow),
      explosion_mode: explosionMode,
      rm_cost: Number(rmCost.toFixed(6)),
      labour_cost: Number(labourCost.toFixed(6)),
      sfg_cost: Number(sfgCost.toFixed(6)),
      total_cost: totalCost,
      is_active: bomRow.is_active !== false,
    });

    totals.bomCount += 1;
    totals.rmCost += rmCost;
    totals.labourCost += labourCost;
    totals.sfgCost += sfgCost;
    totals.totalCost += totalCost;
  });

  if (sortOrder === "item_name") {
    summaryRows.sort((a, b) =>
      String(a.item_name || "").localeCompare(
        String(b.item_name || ""),
        undefined,
        {
          sensitivity: "base",
        },
      ),
    );
  } else if (sortOrder === "total_cost_asc") {
    summaryRows.sort(
      (a, b) => Number(a.total_cost || 0) - Number(b.total_cost || 0),
    );
  } else {
    summaryRows.sort(
      (a, b) => Number(b.total_cost || 0) - Number(a.total_cost || 0),
    );
  }

  // Roll descendant costs up into their parent BOM node. Without this an
  // exploded parent showed only its own direct lines, so a collapsed parent
  // read lower than the children hidden underneath it.
  const treeRowByNodeId = new Map(treeRows.map((row) => [row.node_id, row]));
  [...treeRows]
    .sort((a, b) => Number(b.depth || 0) - Number(a.depth || 0))
    .forEach((row) => {
      const parent = row.parent_node_id
        ? treeRowByNodeId.get(row.parent_node_id)
        : null;
      if (!parent || parent.row_type !== "BOM" || row.row_type !== "BOM")
        return;
      parent.rm_cost = Number(
        (Number(parent.rm_cost || 0) + Number(row.rm_cost || 0)).toFixed(6),
      );
      parent.labour_cost = Number(
        (
          Number(parent.labour_cost || 0) + Number(row.labour_cost || 0)
        ).toFixed(6),
      );
      parent.sfg_cost = Number(
        (Number(parent.sfg_cost || 0) + Number(row.sfg_cost || 0)).toFixed(6),
      );
      parent.total_cost = Number(
        (
          Number(parent.rm_cost || 0) +
          Number(parent.labour_cost || 0) +
          Number(parent.sfg_cost || 0)
        ).toFixed(6),
      );
      parent.line_cost = parent.total_cost;
    });

  treeRows.forEach((row) => {
    row.has_children = (treeChildCount.get(row.node_id) || 0) > 0;
  });

  return {
    filters,
    options,
    reportData: {
      summaryRows,
      detailRows: treeRows,
      totals: {
        bomCount: totals.bomCount,
        rmCost: Number(totals.rmCost.toFixed(6)),
        labourCost: Number(totals.labourCost.toFixed(6)),
        sfgCost: Number(totals.sfgCost.toFixed(6)),
        totalCost: Number(totals.totalCost.toFixed(6)),
        rowCount: treeRows.length,
      },
      supportsWac: hasRmStockBalanceTable || hasSkuStockBalanceTable || false,
    },
  };
};

module.exports = {
  getBomVersionHistoryReportPageData,
  getBomLifecycleStatusReportPageData,
  getBomApprovalQueueAgingReportPageData,
  getBomChangeLogReportPageData,
  getBomCostBreakdownReportPageData,
};
