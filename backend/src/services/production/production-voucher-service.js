const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog, queueAuditLog } = require("../../utils/audit-log");
const { toLocalDateOnly } = require("../../utils/date-only");
const { syncVoucherGlPostingTx } = require("../financial/gl-posting-service");

const PRODUCTION_VOUCHER_TYPES = {
  finishedProduction: "PROD_FG",
  semiFinishedProduction: "PROD_SFG",
  departmentCompletion: "DCV",
  labourProduction: "LABOUR_PROD",
  consumption: "CONSUMP",
  productionPlan: "PROD_PLAN",
  abnormalLoss: "LOSS",
};

const PRODUCTION_VOUCHER_TYPE_SET = new Set(
  Object.values(PRODUCTION_VOUCHER_TYPES),
);
const AUTO_GENERATED_VOUCHER_TYPES = new Set([
  PRODUCTION_VOUCHER_TYPES.labourProduction,
  PRODUCTION_VOUCHER_TYPES.consumption,
]);
const EDITABLE_VOUCHER_TYPES = new Set([
  PRODUCTION_VOUCHER_TYPES.departmentCompletion,
  PRODUCTION_VOUCHER_TYPES.productionPlan,
  PRODUCTION_VOUCHER_TYPES.abnormalLoss,
]);

const ROW_STATUS_VALUES = ["PACKED", "LOOSE"];
const ROW_UNIT_VALUES = ["PAIR", "DZN"];
const LOSS_TYPE_VALUES = new Set([
  "RM_LOSS",
  "SFG_LOSS",
  "FG_LOSS",
  "DVC_ABANDON",
]);
const PAIRS_PER_DOZEN = 12;
const LABOUR_RATE_TYPE = {
  perPair: "PER_PAIR",
  perDozen: "PER_DOZEN",
};

let approvalRequestHasVoucherTypeCodeColumn;
let productionStagesTableSupport;
let productionLineStageColumnSupport;
let dcvHeaderStageColumnSupport;
let abnormalLossStageColumnSupport;
let bomStageRoutingTableSupport;
let bomSfgLineTableSupport;
let bomSkuOverrideTableSupport;
let labourRateRulesArticleTypeColumnSupport;
let bomStageRoutingEnforceSequenceColumnSupport;
let bomSfgConsumedStageColumnSupport;
let stockBalanceSkuTableSupport;
let stockBalanceRmTableSupport;
let stockLedgerTableSupport;
let rmPurchaseRatesTableSupport;
let stockBalanceRmColorColumnSupport;
let stockBalanceRmSizeColumnSupport;
let stockLedgerColorColumnSupport;
let stockLedgerSizeColumnSupport;
const RM_BALANCE_CONFLICT_TARGET_SQL =
  "(branch_id, stock_state, item_id, COALESCE(color_id, 0), COALESCE(size_id, 0))";
// Typed error marker used to route non-admin shortage cases into approval instead of hard failures.
const RM_STOCK_SHORTAGE_ERROR_CODE = "RM_STOCK_SHORTAGE";

const toDateOnly = toLocalDateOnly;

const normalizeText = (value, max = 1000) => {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
};

const tableExistsTx = async (trx, tableName) => {
  try {
    const row = await trx.raw("SELECT to_regclass(?) AS reg", [tableName]);
    const value = row?.rows?.[0]?.reg || row?.[0]?.reg || null;
    return Boolean(value);
  } catch (err) {
    return false;
  }
};

const hasColumnTx = async (trx, schemaName, tableName, columnName) => {
  try {
    return trx.schema.withSchema(schemaName).hasColumn(tableName, columnName);
  } catch (err) {
    return false;
  }
};

const hasProductionStagesTableTx = async (trx) => {
  if (typeof productionStagesTableSupport === "boolean")
    return productionStagesTableSupport;
  productionStagesTableSupport = await tableExistsTx(
    trx,
    "erp.production_stages",
  );
  return productionStagesTableSupport;
};

const hasBomStageRoutingTableTx = async (trx) => {
  if (typeof bomStageRoutingTableSupport === "boolean")
    return bomStageRoutingTableSupport;
  bomStageRoutingTableSupport = await tableExistsTx(
    trx,
    "erp.bom_stage_routing",
  );
  return bomStageRoutingTableSupport;
};

const hasBomSkuOverrideTableTx = async (trx) => {
  if (typeof bomSkuOverrideTableSupport === "boolean")
    return bomSkuOverrideTableSupport;
  bomSkuOverrideTableSupport = await tableExistsTx(
    trx,
    "erp.bom_sku_override_line",
  );
  return bomSkuOverrideTableSupport;
};

const hasBomSfgLineTableTx = async (trx) => {
  if (typeof bomSfgLineTableSupport === "boolean")
    return bomSfgLineTableSupport;
  bomSfgLineTableSupport = await tableExistsTx(trx, "erp.bom_sfg_line");
  return bomSfgLineTableSupport;
};

const hasBomStageRoutingEnforceSequenceColumnTx = async (trx) => {
  if (typeof bomStageRoutingEnforceSequenceColumnSupport === "boolean") {
    return bomStageRoutingEnforceSequenceColumnSupport;
  }
  bomStageRoutingEnforceSequenceColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "bom_stage_routing",
    "enforce_sequence",
  );
  return bomStageRoutingEnforceSequenceColumnSupport;
};

const hasBomSfgConsumedStageColumnTx = async (trx) => {
  if (typeof bomSfgConsumedStageColumnSupport === "boolean")
    return bomSfgConsumedStageColumnSupport;
  bomSfgConsumedStageColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "bom_sfg_line",
    "consumed_in_stage_id",
  );
  return bomSfgConsumedStageColumnSupport;
};

const hasStockBalanceSkuTableTx = async (trx) => {
  if (typeof stockBalanceSkuTableSupport === "boolean")
    return stockBalanceSkuTableSupport;
  stockBalanceSkuTableSupport = await tableExistsTx(
    trx,
    "erp.stock_balance_sku",
  );
  return stockBalanceSkuTableSupport;
};

const hasStockBalanceRmTableTx = async (trx) => {
  if (typeof stockBalanceRmTableSupport === "boolean")
    return stockBalanceRmTableSupport;
  stockBalanceRmTableSupport = await tableExistsTx(trx, "erp.stock_balance_rm");
  return stockBalanceRmTableSupport;
};

const hasStockLedgerTableTx = async (trx) => {
  if (typeof stockLedgerTableSupport === "boolean")
    return stockLedgerTableSupport;
  stockLedgerTableSupport = await tableExistsTx(trx, "erp.stock_ledger");
  return stockLedgerTableSupport;
};

const loadOnHandSfgPairsBySkuTx = async ({ trx, branchId, skuIds = [] }) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuIds = [
    ...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalizedBranchId || !normalizedSkuIds.length) return new Map();

  if (await hasStockLedgerTableTx(trx)) {
    const rows = await trx("erp.stock_ledger as sl")
      .select("sl.sku_id")
      .sum({
        qty_pairs: trx.raw(
          "CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END",
        ),
      })
      .where({
        "sl.branch_id": Number(normalizedBranchId),
        "sl.stock_state": "ON_HAND",
        "sl.category": "SFG",
      })
      .whereIn("sl.sku_id", normalizedSkuIds)
      .groupBy("sl.sku_id");
    return new Map(
      rows.map((row) => [Number(row.sku_id), Number(row.qty_pairs || 0)]),
    );
  }

  if (!(await hasStockBalanceSkuTableTx(trx))) {
    throw new HttpError(
      400,
      "SFG stock source is unavailable; cannot validate stage SFG consumption",
    );
  }

  const rows = await trx("erp.stock_balance_sku as sb")
    .select("sb.sku_id")
    .sum({ qty_pairs: trx.raw("COALESCE(sb.qty_pairs, 0)") })
    .where({
      "sb.branch_id": Number(normalizedBranchId),
      "sb.stock_state": "ON_HAND",
      "sb.category": "SFG",
    })
    .whereIn("sb.sku_id", normalizedSkuIds)
    .groupBy("sb.sku_id");
  return new Map(
    rows.map((row) => [Number(row.sku_id), Number(row.qty_pairs || 0)]),
  );
};

const hasStockBalanceRmColorColumnTx = async (trx) => {
  if (typeof stockBalanceRmColorColumnSupport === "boolean")
    return stockBalanceRmColorColumnSupport;
  stockBalanceRmColorColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "stock_balance_rm",
    "color_id",
  );
  return stockBalanceRmColorColumnSupport;
};

const hasStockBalanceRmSizeColumnTx = async (trx) => {
  if (typeof stockBalanceRmSizeColumnSupport === "boolean")
    return stockBalanceRmSizeColumnSupport;
  stockBalanceRmSizeColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "stock_balance_rm",
    "size_id",
  );
  return stockBalanceRmSizeColumnSupport;
};

const hasStockBalanceRmVariantDimensionsTx = async (trx) => {
  const [hasColor, hasSize] = await Promise.all([
    hasStockBalanceRmColorColumnTx(trx),
    hasStockBalanceRmSizeColumnTx(trx),
  ]);
  return hasColor && hasSize;
};

const hasStockLedgerColorColumnTx = async (trx) => {
  if (typeof stockLedgerColorColumnSupport === "boolean")
    return stockLedgerColorColumnSupport;
  stockLedgerColorColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "stock_ledger",
    "color_id",
  );
  return stockLedgerColorColumnSupport;
};

const hasStockLedgerSizeColumnTx = async (trx) => {
  if (typeof stockLedgerSizeColumnSupport === "boolean")
    return stockLedgerSizeColumnSupport;
  stockLedgerSizeColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "stock_ledger",
    "size_id",
  );
  return stockLedgerSizeColumnSupport;
};

const hasStockLedgerVariantDimensionsTx = async (trx) => {
  const [hasColor, hasSize] = await Promise.all([
    hasStockLedgerColorColumnTx(trx),
    hasStockLedgerSizeColumnTx(trx),
  ]);
  return hasColor && hasSize;
};

const hasRmPurchaseRatesTableTx = async (trx) => {
  if (typeof rmPurchaseRatesTableSupport === "boolean")
    return rmPurchaseRatesTableSupport;
  rmPurchaseRatesTableSupport = await tableExistsTx(
    trx,
    "erp.rm_purchase_rates",
  );
  return rmPurchaseRatesTableSupport;
};

const hasProductionLineStageColumnTx = async (trx) => {
  if (typeof productionLineStageColumnSupport === "boolean")
    return productionLineStageColumnSupport;
  productionLineStageColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "production_line",
    "stage_id",
  );
  return productionLineStageColumnSupport;
};

const hasDcvHeaderStageColumnTx = async (trx) => {
  if (typeof dcvHeaderStageColumnSupport === "boolean")
    return dcvHeaderStageColumnSupport;
  dcvHeaderStageColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "dcv_header",
    "stage_id",
  );
  return dcvHeaderStageColumnSupport;
};

const hasAbnormalLossStageColumnTx = async (trx) => {
  if (typeof abnormalLossStageColumnSupport === "boolean")
    return abnormalLossStageColumnSupport;
  abnormalLossStageColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "abnormal_loss_line",
    "stage_id",
  );
  return abnormalLossStageColumnSupport;
};

const hasLabourRateRulesArticleTypeColumnTx = async (trx) => {
  if (typeof labourRateRulesArticleTypeColumnSupport === "boolean")
    return labourRateRulesArticleTypeColumnSupport;
  labourRateRulesArticleTypeColumnSupport = await hasColumnTx(
    trx,
    "erp",
    "labour_rate_rules",
    "article_type",
  );
  return labourRateRulesArticleTypeColumnSupport;
};

const loadActiveProductionStagesTx = async (trx) => {
  const hasStagesTable = await hasProductionStagesTableTx(trx);
  if (!hasStagesTable) return [];
  return trx("erp.production_stages as ps")
    .leftJoin("erp.departments as d", "d.id", "ps.dept_id")
    .select("ps.id", "ps.code", "ps.name", "ps.dept_id", "ps.is_active")
    .where("ps.is_active", true)
    .andWhere("d.is_active", true)
    .andWhere("d.is_production", true)
    .orderBy("ps.name", "asc");
};

const toPositiveInt = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const normalizeRmDimensionId = (value) => toPositiveInt(value);

const buildRmStockIdentity = ({
  branchId,
  stockState = "ON_HAND",
  itemId,
  colorId = null,
  sizeId = null,
}) => ({
  branchId: toPositiveInt(branchId),
  stockState:
    String(stockState || "ON_HAND")
      .trim()
      .toUpperCase() || "ON_HAND",
  itemId: toPositiveInt(itemId),
  colorId: normalizeRmDimensionId(colorId),
  sizeId: normalizeRmDimensionId(sizeId),
});

const applyRmStockIdentityWhere = ({
  query,
  identity,
  alias = "",
  supportsVariantDimensions = true,
}) => {
  const prefix = alias ? `${alias}.` : "";
  const chained = query
    .where(`${prefix}branch_id`, Number(identity.branchId))
    .where(
      `${prefix}stock_state`,
      String(identity.stockState || "ON_HAND")
        .trim()
        .toUpperCase() || "ON_HAND",
    )
    .where(`${prefix}item_id`, Number(identity.itemId));
  if (!supportsVariantDimensions) return chained;
  return chained
    .whereRaw(`COALESCE(${prefix}color_id, 0) = ?`, [
      Number(identity.colorId || 0),
    ])
    .whereRaw(`COALESCE(${prefix}size_id, 0) = ?`, [
      Number(identity.sizeId || 0),
    ]);
};

const ensureRmBalanceSeedTx = async ({
  trx,
  identity,
  supportsVariantDimensions = true,
}) => {
  if (!identity?.branchId || !identity?.itemId) return;
  const payload = {
    branch_id: Number(identity.branchId),
    stock_state:
      String(identity.stockState || "ON_HAND")
        .trim()
        .toUpperCase() || "ON_HAND",
    item_id: Number(identity.itemId),
    qty: 0,
    value: 0,
    wac: 0,
    last_txn_at: trx.fn.now(),
  };
  if (supportsVariantDimensions) {
    payload.color_id = identity.colorId || null;
    payload.size_id = identity.sizeId || null;
  }
  const seedQuery = trx("erp.stock_balance_rm").insert(payload);
  if (supportsVariantDimensions) {
    seedQuery.onConflict(trx.raw(RM_BALANCE_CONFLICT_TARGET_SQL)).ignore();
  } else {
    seedQuery.onConflict(["branch_id", "stock_state", "item_id"]).ignore();
  }
  await seedQuery;
};

const toNonNegativeNumber = (value, decimals = 2) => {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(decimals));
};

const toPositiveNumber = (value, decimals = 3) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(decimals));
};

const isRmStockShortageError = (err) =>
  String(err?.code || "")
    .trim()
    .toUpperCase() === RM_STOCK_SHORTAGE_ERROR_CODE;

const parseVoucherNo = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const normalizeVoucherTypeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeRowStatus = (value) => {
  const status = String(value || "LOOSE")
    .trim()
    .toUpperCase();
  return ROW_STATUS_VALUES.includes(status) ? status : "LOOSE";
};

const normalizeRowUnit = (value) => {
  const unit = String(value || "")
    .trim()
    .toUpperCase();
  return ROW_UNIT_VALUES.includes(unit) ? unit : null;
};

const unitToStatus = (unit) =>
  String(unit || "").toUpperCase() === "DZN" ? "PACKED" : "LOOSE";

const statusToUnit = (status) =>
  String(status || "").toUpperCase() === "PACKED" ? "DZN" : "PAIR";
const isDozenEquivalentFactor = (factor) => {
  const n = Number(factor);
  if (!Number.isFinite(n) || n <= 0) return false;
  return Math.abs(n - 12) < 0.000001;
};

const resolveProductionUnitAndStatus = (line = {}) => {
  const normalizedUnit = normalizeRowUnit(line?.unit || line?.entry_unit);
  const fallbackStatus = normalizeRowStatus(line?.status || line?.row_status);
  const unit = normalizedUnit || statusToUnit(fallbackStatus);
  const status = unitToStatus(unit);
  return { unit, status };
};

const resolvePairUomTx = async (trx) => {
  const pairByCode = await trx("erp.uom as u")
    .select("u.id", "u.code", "u.name")
    .whereRaw("upper(coalesce(u.code, '')) = 'PAIR'")
    .andWhere("u.is_active", true)
    .first();
  if (pairByCode) return pairByCode;

  return trx("erp.uom as u")
    .select("u.id", "u.code", "u.name")
    .whereRaw("upper(coalesce(u.name, '')) = 'PAIR'")
    .andWhere("u.is_active", true)
    .first();
};

const loadPairConvertibleUomOptionsTx = async (trx) => {
  const pair = await resolvePairUomTx(trx);
  if (!pair) return [];

  const pairId = Number(pair.id);
  const directRows = await trx("erp.uom_conversions as uc")
    .join("erp.uom as from_u", "from_u.id", "uc.from_uom_id")
    .select("from_u.id", "from_u.code", "from_u.name", "uc.factor")
    .where({
      "uc.to_uom_id": pairId,
      "uc.is_active": true,
      "from_u.is_active": true,
    });

  const reverseRows = await trx("erp.uom_conversions as uc")
    .join("erp.uom as to_u", "to_u.id", "uc.to_uom_id")
    .select("to_u.id", "to_u.code", "to_u.name", "uc.factor")
    .where({
      "uc.from_uom_id": pairId,
      "uc.is_active": true,
      "to_u.is_active": true,
    });

  const byCode = new Map();
  const upsertOption = (row, factorToPair) => {
    const id = toPositiveInt(row?.id);
    const code = String(row?.code || "")
      .trim()
      .toUpperCase();
    const name = String(row?.name || "").trim();
    const factor = Number(factorToPair);
    if (!id || !code || !name || !Number.isFinite(factor) || factor <= 0)
      return;
    if (!byCode.has(code)) {
      byCode.set(code, {
        id,
        code,
        name,
        factor_to_pair: Number(factor.toFixed(6)),
      });
    }
  };

  upsertOption(pair, 1);
  directRows.forEach((row) => upsertOption(row, row.factor));
  reverseRows.forEach((row) => {
    const reverseFactor = Number(row?.factor || 0);
    if (!Number.isFinite(reverseFactor) || reverseFactor <= 0) return;
    upsertOption(row, 1 / reverseFactor);
  });

  return [...byCode.values()].sort((a, b) => {
    if (a.code === "PAIR") return -1;
    if (b.code === "PAIR") return 1;
    if (a.code === "DZN") return -1;
    if (b.code === "DZN") return 1;
    return String(a.name).localeCompare(String(b.name));
  });
};

const normalizeLossType = (value) => {
  const lossType = String(value || "")
    .trim()
    .toUpperCase();
  return LOSS_TYPE_VALUES.has(lossType) ? lossType : null;
};

const qtyToPairs = ({ qty, status }) => {
  const numericQty = Number(qty || 0);
  if (!Number.isFinite(numericQty) || numericQty <= 0) return null;
  if (status === "PACKED") {
    const doubled = Number((numericQty * 2).toFixed(4));
    if (!Number.isInteger(doubled)) return null;
    const totalPairs = Number((numericQty * PAIRS_PER_DOZEN).toFixed(3));
    if (!Number.isInteger(totalPairs)) return null;
    return Number(totalPairs);
  }
  if (!Number.isInteger(numericQty)) return null;
  return Number(numericQty);
};

const computeLineQuantityTotals = (lines = []) => {
  const totalPairs = Number(
    (Array.isArray(lines) ? lines : [])
      .reduce((sum, line) => sum + Number(line?.total_pairs || 0), 0)
      .toFixed(3),
  );
  const totalDozens = Number((totalPairs / PAIRS_PER_DOZEN).toFixed(3));
  return { totalPairs, totalDozens };
};

const canDo = (req, scopeType, scopeKey, action) => {
  const check = req?.res?.locals?.can;
  if (typeof check !== "function") return false;
  return check(scopeType, scopeKey, action);
};

const canApproveVoucherAction = (req, scopeKey) =>
  req?.user?.isAdmin === true || canDo(req, "VOUCHER", scopeKey, "approve");

const requiresApprovalForAction = async (trx, voucherTypeCode, action) => {
  const policy = await trx("erp.approval_policy")
    .select("requires_approval")
    .where({ entity_type: "VOUCHER_TYPE", entity_key: voucherTypeCode, action })
    .first();
  if (policy) return policy.requires_approval === true;
  if (action !== "create") return false;
  const voucherType = await trx("erp.voucher_type")
    .select("requires_approval")
    .where({ code: voucherTypeCode })
    .first();
  if (!voucherType) throw new HttpError(400, "Invalid voucher type");
  return voucherType.requires_approval === true;
};

const hasApprovalRequestVoucherTypeCodeColumnTx = async (trx) => {
  if (typeof approvalRequestHasVoucherTypeCodeColumn === "boolean") {
    return approvalRequestHasVoucherTypeCodeColumn;
  }
  try {
    approvalRequestHasVoucherTypeCodeColumn = await trx.schema
      .withSchema("erp")
      .hasColumn("approval_request", "voucher_type_code");
    return approvalRequestHasVoucherTypeCodeColumn;
  } catch (err) {
    console.error("Error in ProductionVoucherApprovalService:", err);
    approvalRequestHasVoucherTypeCodeColumn = false;
    return false;
  }
};

const isProductionVoucherType = (voucherTypeCode) =>
  PRODUCTION_VOUCHER_TYPE_SET.has(normalizeVoucherTypeCode(voucherTypeCode));

const assertEditableVoucherType = (voucherTypeCode) => {
  if (!isProductionVoucherType(voucherTypeCode)) {
    throw new HttpError(400, "Unsupported production voucher type");
  }
  if (!EDITABLE_VOUCHER_TYPES.has(voucherTypeCode)) {
    throw new HttpError(
      400,
      "This voucher is auto-generated and cannot be created manually",
    );
  }
};

const getNextVoucherNoTx = async (trx, branchId, voucherTypeCode) => {
  const latest = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .max({ value: "voucher_no" })
    .first();
  return Number(latest?.value || 0) + 1;
};

const createApprovalRequestTx = async ({
  trx,
  req,
  entityId,
  voucherTypeCode,
  summary,
  oldValue = null,
  newValue = null,
}) => {
  const payload = {
    branch_id: req.branchId,
    request_type: "VOUCHER",
    entity_type: "VOUCHER",
    entity_id: String(entityId),
    summary,
    old_value: oldValue,
    new_value: newValue,
    requested_by: req.user.id,
  };

  if (await hasApprovalRequestVoucherTypeCodeColumnTx(trx)) {
    payload.voucher_type_code = voucherTypeCode;
  }

  let row;
  try {
    [row] = await trx("erp.approval_request").insert(payload).returning(["id"]);
  } catch (err) {
    const missingOptionalColumn =
      String(err?.code || "").trim() === "42703" &&
      String(err?.message || "")
        .toLowerCase()
        .includes("voucher_type_code");
    if (!missingOptionalColumn) throw err;
    approvalRequestHasVoucherTypeCodeColumn = false;
    delete payload.voucher_type_code;
    [row] = await trx("erp.approval_request").insert(payload).returning(["id"]);
  }

  await insertActivityLog(trx, {
    branch_id: req.branchId,
    user_id: req.user.id,
    entity_type: "VOUCHER",
    entity_id: String(entityId),
    voucher_type_code: voucherTypeCode,
    action: "SUBMIT",
    ip_address: req.ip,
    context: {
      approval_request_id: row?.id || null,
      summary,
      source: "production-voucher-service",
      new_value: newValue,
    },
  });

  return row?.id || null;
};

const loadSkuMapTx = async ({ trx, skuIds = [], itemTypes = [] }) => {
  const normalizedSkuIds = [
    ...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalizedSkuIds.length) return new Map();

  const normalizedTypes = [
    ...new Set(
      (itemTypes || [])
        .map((type) =>
          String(type || "")
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    ),
  ];

  let query = trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.grades as g", "g.id", "v.grade_id")
    .leftJoin("erp.sizes as sz", "sz.id", "v.size_id")
    .leftJoin("erp.colors as c", "c.id", "v.color_id")
    .leftJoin("erp.packing_types as pt", "pt.id", "v.packing_type_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .select(
      "s.id",
      "s.sku_code",
      "v.id as variant_id",
      "v.size_id",
      "v.grade_id",
      "v.color_id",
      "v.packing_type_id",
      "g.grade_rank",
      "i.id as item_id",
      "i.name as item_name",
      "i.item_type",
      "i.base_uom_id",
      "u.name as base_uom_name",
      "sz.name as size_name",
      "c.name as color_name",
      "pt.name as packing_name",
    )
    .whereIn("s.id", normalizedSkuIds)
    .where({ "s.is_active": true, "i.is_active": true });

  if (normalizedTypes.length) {
    query = query.whereIn(
      trx.raw("upper(coalesce(i.item_type::text, ''))"),
      normalizedTypes,
    );
  }

  const rows = await query;
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const buildSkuDisplayLabel = (row) => {
  const skuCode = String(row?.sku_code || "").trim();
  const itemName = String(row?.item_name || "").trim();
  if (skuCode && itemName) return `${skuCode} - ${itemName}`;
  if (skuCode) return skuCode;
  if (itemName) return itemName;
  return "Unknown SKU";
};

const loadSkuDisplayMapTx = async ({ trx, skuIds = [] }) => {
  const normalizedSkuIds = [
    ...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalizedSkuIds.length) return new Map();

  const rows = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id as sku_id", "s.sku_code", "i.name as item_name")
    .whereIn("s.id", normalizedSkuIds);
  return new Map(rows.map((row) => [Number(row.sku_id), row]));
};

const loadBomHeaderByItemIdTx = async ({ trx, itemId }) => {
  const normalizedItemId = toPositiveInt(itemId);
  if (!normalizedItemId) return null;
  return trx("erp.bom_header")
    .select(
      "id",
      "item_id",
      "output_qty",
      "output_uom_id",
      "status",
      "version_no",
    )
    .where({ item_id: normalizedItemId, status: "APPROVED" })
    .orderBy("version_no", "desc")
    .first();
};

const ensureApprovedBomExistsForSkusTx = async ({ trx, skuIds = [] }) => {
  const normalizedSkuIds = [
    ...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalizedSkuIds.length) return;

  const missingRows = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.bom_header as bh", function joinApprovedBom() {
      this.on("bh.item_id", "=", "i.id").andOn(
        "bh.status",
        "=",
        trx.raw("?", ["APPROVED"]),
      );
    })
    .select("s.id as sku_id", "s.sku_code", "i.name as item_name")
    .whereIn("s.id", normalizedSkuIds)
    .groupBy("s.id", "s.sku_code", "i.name")
    .havingRaw("COUNT(bh.id) = 0")
    .orderBy("s.sku_code", "asc");

  if (!missingRows.length) return;
  const skuLabel = buildSkuDisplayLabel(missingRows[0]);
  throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
};

const loadBomProfileBySkuTx = async ({ trx, skuId }) => {
  const normalizedSkuId = toPositiveInt(skuId);
  if (!normalizedSkuId) return null;

  const sku = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select(
      "s.id",
      "v.size_id",
      "v.color_id",
      "v.packing_type_id",
      "i.id as item_id",
      "i.item_type",
    )
    .where({
      "s.id": normalizedSkuId,
      "s.is_active": true,
      "i.is_active": true,
    })
    .first();

  if (!sku) return null;
  const bomHeader = await loadBomHeaderByItemIdTx({ trx, itemId: sku.item_id });
  if (!bomHeader) return null;
  const pairConvertibleUomOptions = await loadPairConvertibleUomOptionsTx(trx);
  const pairFactorByUomId = new Map(
    (pairConvertibleUomOptions || [])
      .map((row) => {
        const uomId = toPositiveInt(row?.id);
        const factor = Number(row?.factor_to_pair || 0);
        if (!uomId || !Number.isFinite(factor) || factor <= 0) return null;
        return [uomId, factor];
      })
      .filter(Boolean),
  );
  const hasBomStageRouting = await hasBomStageRoutingTableTx(trx);
  const hasBomSfgLineTable = await hasBomSfgLineTableTx(trx);
  const hasStagesTable = await hasProductionStagesTableTx(trx);
  const hasBomSkuOverrideTable = await hasBomSkuOverrideTableTx(trx);
  const hasEnforceSequenceColumn =
    await hasBomStageRoutingEnforceSequenceColumnTx(trx);
  const hasConsumedStageColumn = await hasBomSfgConsumedStageColumnTx(trx);

  const [rmLines, labourLines, stageRoutes, skuOverrides, sfgLines] =
    await Promise.all([
      trx("erp.bom_rm_line")
        .select(
          "id",
          "rm_item_id",
          "color_id",
          "size_id",
          "dept_id",
          "qty",
          "uom_id",
          "normal_loss_pct",
        )
        .where({ bom_id: bomHeader.id }),
      trx("erp.bom_labour_line")
        .select(
          "id",
          "dept_id",
          "labour_id",
          "rate_type",
          "rate_value",
          "size_scope",
          "size_id",
        )
        .where({ bom_id: bomHeader.id }),
      hasBomStageRouting && hasStagesTable
        ? trx("erp.bom_stage_routing as bsr")
            .join("erp.production_stages as ps", "ps.id", "bsr.stage_id")
            .select(
              "bsr.stage_id",
              "bsr.sequence_no",
              "bsr.is_required",
              ...(hasEnforceSequenceColumn ? ["bsr.enforce_sequence"] : []),
              "ps.dept_id",
              "ps.name as stage_name",
            )
            .where({ "bsr.bom_id": bomHeader.id })
            .andWhere("ps.is_active", true)
            .orderBy("bsr.sequence_no", "asc")
        : Promise.resolve([]),
      hasBomSkuOverrideTable
        ? trx("erp.bom_sku_override_line")
            .select(
              "sku_id",
              "target_rm_item_id",
              "dept_id",
              "is_excluded",
              "override_qty",
              "override_uom_id",
              "replacement_rm_item_id",
              "rm_color_id",
              "rm_size_id",
            )
            .where({ bom_id: bomHeader.id, sku_id: normalizedSkuId })
        : Promise.resolve([]),
      hasBomSfgLineTable
        ? trx("erp.bom_sfg_line")
            .select(
              "fg_size_id",
              "sfg_sku_id",
              "required_qty",
              "uom_id",
              ...(hasConsumedStageColumn ? ["consumed_in_stage_id"] : []),
            )
            .where({ bom_id: bomHeader.id })
        : Promise.resolve([]),
    ]);

  const applicableLabourLines = labourLines.filter((line) => {
    const scope = String(line.size_scope || "ALL")
      .trim()
      .toUpperCase();
    if (scope !== "SPECIFIC") return true;
    return Number(line.size_id || 0) === Number(sku.size_id || 0);
  });
  const skuOverrideByRmDept = new Map();
  (skuOverrides || []).forEach((row) => {
    const rmItemId = toPositiveInt(row?.target_rm_item_id);
    const deptId = toPositiveInt(row?.dept_id);
    if (!rmItemId || !deptId) return;
    skuOverrideByRmDept.set(`${rmItemId}:${deptId}`, {
      is_excluded: row?.is_excluded === true,
      override_qty: row?.override_qty == null ? null : Number(row.override_qty),
      override_uom_id: toPositiveInt(row?.override_uom_id),
      replacement_rm_item_id: toPositiveInt(row?.replacement_rm_item_id),
      rm_color_id: toPositiveInt(row?.rm_color_id),
      rm_size_id: toPositiveInt(row?.rm_size_id),
    });
  });
  const outputUomId = toPositiveInt(bomHeader.output_uom_id);
  const outputUomFactorToPair = outputUomId
    ? Number(pairFactorByUomId.get(outputUomId) || 0)
    : 1;
  if (!(Number.isFinite(outputUomFactorToPair) && outputUomFactorToPair > 0)) {
    throw new HttpError(
      400,
      `BOM output UOM conversion to PAIR is missing for SKU ${normalizedSkuId}`,
    );
  }

  return {
    skuId: normalizedSkuId,
    skuSizeId: Number(sku.size_id || 0) || null,
    skuColorId: Number(sku.color_id || 0) || null,
    skuPackingTypeId: Number(sku.packing_type_id || 0) || null,
    itemId: Number(sku.item_id),
    itemType: String(sku.item_type || "").toUpperCase(),
    bomId: Number(bomHeader.id),
    outputQty: Number(bomHeader.output_qty || 1),
    outputUomId: outputUomId || null,
    outputUomFactorToPair: Number(outputUomFactorToPair.toFixed(6)),
    rmLines: rmLines.map((row) => ({
      id: Number(row.id),
      rm_item_id: Number(row.rm_item_id),
      color_id: toPositiveInt(row.color_id),
      size_id: toPositiveInt(row.size_id),
      dept_id: Number(row.dept_id),
      qty: Number(row.qty || 0),
      uom_id: toPositiveInt(row.uom_id),
      normal_loss_pct: Number(row.normal_loss_pct || 0),
    })),
    skuOverrideByRmDept,
    labourLines: applicableLabourLines.map((row) => ({
      id: Number(row.id),
      dept_id: Number(row.dept_id),
      labour_id: Number(row.labour_id),
      rate_type: String(
        row.rate_type || LABOUR_RATE_TYPE.perPair,
      ).toUpperCase(),
      rate_value: Number(row.rate_value || 0),
    })),
    stageRoutes: (stageRoutes || []).map((row) => ({
      stage_id: Number(row.stage_id),
      sequence_no: Number(row.sequence_no || 0),
      is_required: row.is_required !== false,
      enforce_sequence: row.enforce_sequence !== false,
      dept_id: Number(row.dept_id || 0) || null,
      stage_name: String(row.stage_name || ""),
    })),
    sfgLines: (sfgLines || [])
      .map((row) => {
        const uomId = toPositiveInt(row.uom_id);
        const uomFactor = uomId ? Number(pairFactorByUomId.get(uomId) || 0) : 0;
        return {
          fg_size_id: toPositiveInt(row.fg_size_id),
          sfg_sku_id: toPositiveInt(row.sfg_sku_id),
          required_qty: Number(row.required_qty || 0),
          uom_id: uomId,
          uom_factor_to_pair:
            Number.isFinite(uomFactor) && uomFactor > 0
              ? Number(uomFactor.toFixed(6))
              : null,
          consumed_in_stage_id: toPositiveInt(row.consumed_in_stage_id),
        };
      })
      .filter(
        (row) => row.fg_size_id && row.sfg_sku_id && row.required_qty > 0,
      ),
  };
};

const resolveDcvStageTransitionForBomProfile = ({
  bomProfile,
  stageId,
  departmentId,
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  const normalizedDepartmentId = toPositiveInt(departmentId);
  const stageRoutes = Array.isArray(bomProfile?.stageRoutes)
    ? bomProfile.stageRoutes
    : [];
  if (!stageRoutes.length || !normalizedStageId) {
    return {
      hasStageRouting: false,
      currentRoute: null,
      finalRequiredRoute: null,
      requiredRoutes: [],
      previousRequiredStageId: null,
      previousRequiredDeptId: null,
    };
  }

  const orderedRoutes = [...stageRoutes]
    .filter((route) => toPositiveInt(route?.stage_id))
    .sort((a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0));
  const currentRoute = orderedRoutes.find(
    (route) => Number(route.stage_id) === Number(normalizedStageId),
  );
  if (!currentRoute) {
    throw new HttpError(400, "Selected stage is not mapped in approved BOM");
  }

  const mappedDeptId = toPositiveInt(currentRoute.dept_id);
  if (
    normalizedDepartmentId &&
    mappedDeptId &&
    Number(mappedDeptId) !== Number(normalizedDepartmentId)
  ) {
    throw new HttpError(
      400,
      "Selected stage does not match selected department in approved BOM",
    );
  }

  const currentSeq = Number(currentRoute.sequence_no || 0);
  const requiredRoutes = orderedRoutes.filter(
    (route) => route.is_required !== false,
  );
  const finalRequiredRoute =
    [...requiredRoutes].sort(
      (a, b) => Number(b.sequence_no || 0) - Number(a.sequence_no || 0),
    )[0] || null;
  const shouldEnforceSequence =
    currentRoute.is_required !== false &&
    currentRoute.enforce_sequence !== false;
  const previousRequiredRoute = [...orderedRoutes]
    .filter(
      (route) =>
        route.is_required !== false &&
        route.enforce_sequence !== false &&
        Number(route.sequence_no || 0) < currentSeq,
    )
    .sort((a, b) => Number(b.sequence_no || 0) - Number(a.sequence_no || 0))[0];

  return {
    hasStageRouting: true,
    currentRoute: {
      stage_id: Number(currentRoute.stage_id),
      sequence_no: Number(currentRoute.sequence_no || 0),
      is_required: currentRoute.is_required !== false,
      enforce_sequence: currentRoute.enforce_sequence !== false,
      dept_id: toPositiveInt(currentRoute.dept_id),
      stage_name: String(currentRoute.stage_name || ""),
    },
    requiredRoutes: requiredRoutes.map((route) => ({
      stage_id: Number(route.stage_id),
      sequence_no: Number(route.sequence_no || 0),
      is_required: route.is_required !== false,
      enforce_sequence: route.enforce_sequence !== false,
      dept_id: toPositiveInt(route.dept_id),
      stage_name: String(route.stage_name || ""),
    })),
    finalRequiredRoute: finalRequiredRoute
      ? {
          stage_id: Number(finalRequiredRoute.stage_id),
          sequence_no: Number(finalRequiredRoute.sequence_no || 0),
          is_required: finalRequiredRoute.is_required !== false,
          enforce_sequence: finalRequiredRoute.enforce_sequence !== false,
          dept_id: toPositiveInt(finalRequiredRoute.dept_id),
          stage_name: String(finalRequiredRoute.stage_name || ""),
        }
      : null,
    previousRequiredStageId: shouldEnforceSequence
      ? toPositiveInt(previousRequiredRoute?.stage_id)
      : null,
    previousRequiredDeptId: shouldEnforceSequence
      ? toPositiveInt(previousRequiredRoute?.dept_id)
      : null,
  };
};

const loadProductionDepartmentMapTx = async ({ trx, departmentIds = [] }) => {
  const normalizedDepartmentIds = [
    ...new Set(
      (departmentIds || []).map((id) => toPositiveInt(id)).filter(Boolean),
    ),
  ];
  if (!normalizedDepartmentIds.length) return new Map();
  const rows = await trx("erp.departments")
    .select("id", "name", "is_production", "is_active")
    .whereIn("id", normalizedDepartmentIds);
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const validateDepartmentTx = async ({
  trx,
  departmentId,
  requireProduction = true,
}) => {
  const normalizedDepartmentId = toPositiveInt(departmentId);
  if (!normalizedDepartmentId)
    throw new HttpError(400, "Department is required");
  const row = await trx("erp.departments")
    .select("id", "is_active", "is_production")
    .where({ id: normalizedDepartmentId })
    .first();
  if (!row || row.is_active !== true) {
    throw new HttpError(400, "Department is invalid");
  }
  if (requireProduction && row.is_production !== true) {
    throw new HttpError(400, "Department must be a production department");
  }
  return Number(row.id);
};

const validateStageTx = async ({
  trx,
  stageId,
  departmentId = null,
  allowNull = true,
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  if (!normalizedStageId) {
    if (allowNull) return null;
    throw new HttpError(400, "Stage is required");
  }

  if (!(await hasProductionStagesTableTx(trx))) {
    throw new HttpError(400, "Stage is not available in this environment");
  }

  const stage = await trx("erp.production_stages")
    .select("id", "dept_id", "is_active")
    .where({ id: normalizedStageId })
    .first();
  if (!stage || stage.is_active !== true) {
    throw new HttpError(400, "Selected stage is invalid");
  }
  const normalizedDeptId = toPositiveInt(departmentId);
  if (normalizedDeptId && Number(stage.dept_id) !== Number(normalizedDeptId)) {
    throw new HttpError(
      400,
      "Selected stage does not belong to selected department",
    );
  }
  return Number(stage.id);
};

const resolveActiveStageForDepartmentTx = async ({
  trx,
  departmentId,
  allowNull = false,
}) => {
  const normalizedDeptId = toPositiveInt(departmentId);
  if (!normalizedDeptId) {
    if (allowNull) return null;
    throw new HttpError(400, "Department is required");
  }
  const hasStagesTable = await hasProductionStagesTableTx(trx);
  if (!hasStagesTable) {
    if (allowNull) return null;
    throw new HttpError(400, "Stage is not available in this environment");
  }
  const rows = await trx("erp.production_stages")
    .select("id")
    .where({ dept_id: normalizedDeptId, is_active: true })
    .orderBy("id", "asc")
    .limit(2);
  if (!rows.length) {
    if (allowNull) return null;
    throw new HttpError(
      400,
      "No active production stage is mapped to the selected department",
    );
  }
  if (rows.length > 1) {
    throw new HttpError(
      400,
      "Multiple active stages are mapped to the selected department",
    );
  }
  return toPositiveInt(rows[0].id);
};

const validateLabourTx = async ({ trx, req, labourId, allowNull = true }) => {
  const normalizedLabourId = toPositiveInt(labourId);
  if (!normalizedLabourId) {
    if (allowNull) return null;
    throw new HttpError(400, "Labour is required");
  }
  const row = await trx("erp.labours as l")
    .select("l.id")
    .where({ "l.id": normalizedLabourId })
    .whereRaw("lower(coalesce(l.status, '')) = 'active'")
    .whereExists(function labourBranch() {
      this.select(1)
        .from("erp.labour_branch as lb")
        .whereRaw("lb.labour_id = l.id")
        .andWhere("lb.branch_id", req.branchId);
    })
    .first();
  if (!row) throw new HttpError(400, "Labour is invalid for current branch");
  return Number(row.id);
};

const loadLabourAllowedDeptIdsTx = async ({ trx, labourId }) => {
  const normalizedLabourId = toPositiveInt(labourId);
  if (!normalizedLabourId) return [];

  const [labour, mappedRows] = await Promise.all([
    trx("erp.labours as l")
      .select("l.id", "l.dept_id")
      .where({ "l.id": normalizedLabourId })
      .first(),
    trx("erp.labour_department as ld")
      .select("ld.dept_id")
      .where({ labour_id: normalizedLabourId }),
  ]);

  if (!labour) return [];

  const allowedDeptIds = new Set();
  const primaryDeptId = toPositiveInt(labour.dept_id);
  if (primaryDeptId) allowedDeptIds.add(primaryDeptId);
  mappedRows.forEach((row) => {
    const deptId = toPositiveInt(row?.dept_id);
    if (deptId) allowedDeptIds.add(deptId);
  });

  return [...allowedDeptIds];
};

const validateDepartmentForLabourTx = async ({
  trx,
  departmentId,
  labourId,
  requireProduction = true,
}) => {
  const deptId = await validateDepartmentTx({
    trx,
    departmentId,
    requireProduction,
  });

  const normalizedLabourId = toPositiveInt(labourId);
  if (!normalizedLabourId) return deptId;

  const allowedDeptIds = await loadLabourAllowedDeptIdsTx({
    trx,
    labourId: normalizedLabourId,
  });
  if (!allowedDeptIds.length) {
    throw new HttpError(400, "Selected labour has no mapped department");
  }
  if (!allowedDeptIds.includes(Number(deptId))) {
    throw new HttpError(
      400,
      "Selected department is not allowed for this labour",
    );
  }
  return deptId;
};

const validateReasonCodeTx = async ({ trx, reasonCodeId, voucherTypeCode }) => {
  const normalizedReasonCodeId = toPositiveInt(reasonCodeId);
  if (!normalizedReasonCodeId) return null;

  const reason = await trx("erp.reason_codes as rc")
    .select("rc.id", "rc.is_active")
    .where({ "rc.id": normalizedReasonCodeId })
    .first();
  if (!reason || reason.is_active !== true) {
    throw new HttpError(400, "Reason code is invalid");
  }

  const mapping = await trx("erp.reason_code_voucher_type_map")
    .select("reason_code_id")
    .where({
      reason_code_id: normalizedReasonCodeId,
      voucher_type_code: voucherTypeCode,
    })
    .first();
  const hasMapping = Boolean(mapping);
  const mappingCountRow = await trx("erp.reason_code_voucher_type_map")
    .count({ value: "*" })
    .where({ reason_code_id: normalizedReasonCodeId })
    .first();
  const mappingCount = Number(mappingCountRow?.value || 0);
  if (mappingCount > 0 && !hasMapping) {
    throw new HttpError(
      400,
      "Reason code is not allowed for this voucher type",
    );
  }

  return normalizedReasonCodeId;
};

const validateProductionOrPlanLinesTx = async ({
  trx,
  voucherTypeCode,
  planKind = null,
  rawLines = [],
}) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const targetItemType =
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction
      ? "FG"
      : voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
        ? "SFG"
        : String(planKind || "").toUpperCase() === "FG"
          ? "FG"
          : "SFG";

  const skuIds = lines
    .map((line) => toPositiveInt(line?.sku_id || line?.skuId))
    .filter(Boolean);
  const uniqueSkuIds = [...new Set(skuIds)];
  const skuMap = await loadSkuMapTx({
    trx,
    skuIds: uniqueSkuIds,
    itemTypes: [targetItemType],
  });
  if (skuMap.size !== uniqueSkuIds.length) {
    throw new HttpError(400, "One or more selected SKUs are invalid");
  }

  return lines.map((line, index) => {
    const lineNo = Number(index + 1);
    const skuId = toPositiveInt(line?.sku_id || line?.skuId);
    const sku = skuMap.get(Number(skuId));
    if (!sku) throw new HttpError(400, `Line ${lineNo}: SKU is invalid`);

    const { unit, status } = resolveProductionUnitAndStatus(line);
    const qty = toPositiveNumber(line?.qty, 3);
    if (!qty)
      throw new HttpError(
        400,
        `Line ${lineNo}: quantity must be greater than zero`,
      );

    const totalPairs = qtyToPairs({ qty, status });
    if (!totalPairs) {
      throw new HttpError(
        400,
        status === "PACKED"
          ? `Line ${lineNo}: dozen quantity must be in 0.5 steps`
          : `Line ${lineNo}: pair quantity must be whole numbers`,
      );
    }

    const rate = toNonNegativeNumber(line?.rate, 4);
    if (rate === null)
      throw new HttpError(400, `Line ${lineNo}: rate is invalid`);
    const inputAmount = toNonNegativeNumber(line?.amount, 2);
    if (inputAmount === null)
      throw new HttpError(400, `Line ${lineNo}: amount is invalid`);
    const amount = Number(
      (inputAmount > 0 ? inputAmount : Number(qty) * Number(rate)).toFixed(2),
    );
    const stageId = toPositiveInt(line?.stage_id || line?.stageId);

    return {
      line_no: lineNo,
      line_kind: "SKU",
      sku_id: Number(skuId),
      uom_id: toPositiveInt(sku.base_uom_id),
      qty: Number(qty.toFixed(3)),
      rate: Number(rate.toFixed(4)),
      amount,
      meta: {
        unit,
        status,
        total_pairs: Number(totalPairs),
        total_dozens: Number((Number(totalPairs) / PAIRS_PER_DOZEN).toFixed(3)),
        stage_id: stageId,
      },
      unit,
      status,
      stage_id: stageId,
      is_packed: status === "PACKED",
      total_pairs: Number(totalPairs),
    };
  });
};

const validateDcvLinesTx = async ({
  trx,
  req,
  labourId,
  deptId,
  rawLines = [],
  dcvUnits = [],
}) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const skuIds = lines
    .map((line) => toPositiveInt(line?.sku_id || line?.skuId))
    .filter(Boolean);
  const uniqueSkuIds = [...new Set(skuIds)];
  const skuMap = await loadSkuMapTx({
    trx,
    skuIds: uniqueSkuIds,
    itemTypes: ["FG", "SFG"],
  });
  if (skuMap.size !== uniqueSkuIds.length) {
    throw new HttpError(400, "One or more selected SKUs are invalid");
  }

  const unitByCode = new Map(
    (Array.isArray(dcvUnits) ? dcvUnits : [])
      .map((row) => {
        const code = String(row?.code || "")
          .trim()
          .toUpperCase();
        const id = toPositiveInt(row?.id);
        const factor = Number(row?.factor_to_pair || 0);
        if (!code || !id || !Number.isFinite(factor) || factor <= 0)
          return null;
        return [code, { id, code, factorToPair: factor }];
      })
      .filter(Boolean),
  );

  if (!unitByCode.has("PAIR")) {
    throw new HttpError(400, "PAIR unit is not configured for production");
  }

  const t = req?.res?.locals?.t;

  return Promise.all(
    lines.map(async (line, index) => {
      const lineNo = Number(index + 1);
      const skuId = toPositiveInt(line?.sku_id || line?.skuId);
      const sku = skuMap.get(Number(skuId));
      if (!sku) throw new HttpError(400, `Line ${lineNo}: SKU is invalid`);

      const requestedUnitCode =
        String(line?.unit || line?.entry_unit || statusToUnit(line?.status))
          .trim()
          .toUpperCase() || "PAIR";
      const resolvedUnit = unitByCode.get(requestedUnitCode);
      if (!resolvedUnit) {
        throw new HttpError(
          400,
          `Line ${lineNo}: selected unit is invalid for Pair conversion`,
        );
      }

      const qty = toPositiveNumber(line?.qty, 3);
      if (!qty)
        throw new HttpError(
          400,
          `Line ${lineNo}: quantity must be greater than zero`,
        );

      const rawPairs = Number(qty) * Number(resolvedUnit.factorToPair);
      const totalPairs = Number(rawPairs.toFixed(3));
      if (!Number.isInteger(totalPairs)) {
        throw new HttpError(
          400,
          `Line ${lineNo}: quantity must convert to whole pairs`,
        );
      }

      const resolvedRatePayload = await resolveDcvRateForSku({
        req,
        labourId,
        deptId,
        skuId: Number(skuId),
        unitCode: resolvedUnit.code,
      });
      if (
        !resolvedRatePayload?.found ||
        Number(resolvedRatePayload?.rate || 0) <= 0
      ) {
        const skuLabel = buildSkuDisplayLabel(sku);
        const fallback = `Line ${lineNo}: Labour rate is missing for ${skuLabel}. Please add Labour+Department+SKU rate in Labour Rates.`;
        const localizedTemplate =
          typeof t === "function"
            ? t("error_dcv_missing_labour_rate_for_sku")
            : "";
        const message = String(localizedTemplate || "").trim()
          ? String(localizedTemplate)
              .replace("{line}", String(lineNo))
              .replace("{sku}", String(skuLabel))
          : fallback;
        throw new HttpError(400, message);
      }
      const rate = Number(resolvedRatePayload?.rate || 0);
      const safeRate =
        Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(4)) : 0;
      const amount = Number((Number(qty) * safeRate).toFixed(2));
      const normalizedStatus = isDozenEquivalentFactor(
        resolvedUnit.factorToPair,
      )
        ? "PACKED"
        : "LOOSE";

      return {
        line_no: lineNo,
        line_kind: "SKU",
        sku_id: Number(skuId),
        uom_id: Number(resolvedUnit.id),
        qty: Number(qty.toFixed(3)),
        rate: safeRate,
        amount,
        meta: {
          unit: resolvedUnit.code,
          status: normalizedStatus,
          total_pairs: Number(totalPairs),
        },
        unit: resolvedUnit.code,
        status: normalizedStatus,
        is_packed: normalizedStatus === "PACKED",
        total_pairs: Number(totalPairs),
      };
    }),
  );
};

const validateDcvStageFlowTx = async ({
  trx,
  req,
  stageId,
  departmentId,
  voucherDate = null,
  voucherId = null,
  lines = [],
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  const normalizedDepartmentId = toPositiveInt(departmentId);
  if (
    !normalizedStageId ||
    !normalizedDepartmentId ||
    !Array.isArray(lines) ||
    !lines.length
  ) {
    return;
  }

  const linePairsBySku = new Map();
  for (const line of lines) {
    const skuId = toPositiveInt(line?.sku_id);
    const pairs = Number(line?.total_pairs || line?.qty || 0);
    if (!skuId || !Number.isInteger(pairs) || pairs <= 0) continue;
    linePairsBySku.set(skuId, Number(linePairsBySku.get(skuId) || 0) + pairs);
  }
  if (!linePairsBySku.size) return;

  const skuIds = [...linePairsBySku.keys()];
  const normalizedVoucherId = toPositiveInt(voucherId);
  const [skuDisplayMap] = await Promise.all([
    loadSkuDisplayMapTx({ trx, skuIds }),
  ]);
  const bomProfileBySku = new Map();

  const resolveWipAddBackBySkuTx = async ({
    deptId,
    skuIds: targetSkuIds = [],
  }) => {
    const normalizedDeptId = toPositiveInt(deptId);
    const normalizedSkuIds = [
      ...new Set(
        (Array.isArray(targetSkuIds) ? targetSkuIds : [])
          .map((id) => toPositiveInt(id))
          .filter(Boolean),
      ),
    ];
    if (!normalizedVoucherId || !normalizedDeptId || !normalizedSkuIds.length)
      return new Map();
    // Edit-mode add-back:
    // include what this same voucher previously consumed from predecessor WIP so
    // reducing qty does not fail as if it were a brand-new voucher.
    const rows = await trx("erp.wip_dept_ledger as wl")
      .select("wl.sku_id")
      .sum({ qty_pairs: trx.raw("COALESCE(wl.qty_pairs, 0)") })
      .where({
        "wl.branch_id": Number(req.branchId),
        "wl.source_voucher_id": Number(normalizedVoucherId),
        "wl.direction": -1,
        "wl.dept_id": Number(normalizedDeptId),
      })
      .whereIn("wl.sku_id", normalizedSkuIds)
      .groupBy("wl.sku_id");
    return new Map(
      rows.map((row) => [Number(row.sku_id), Number(row.qty_pairs || 0)]),
    );
  };

  for (const skuId of skuIds) {
    // Stage-routing constraints are BOM-driven, so keep one profile per SKU in memory.
    let bomProfile = bomProfileBySku.get(skuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(
          skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` },
        );
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomProfileBySku.set(skuId, bomProfile);
    }

    const skuLabel = buildSkuDisplayLabel(
      skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` },
    );
    const stageFlow = resolveDcvStageTransitionForBomProfile({
      bomProfile,
      stageId: normalizedStageId,
      departmentId: normalizedDepartmentId,
    });

    const requiredPairs = Number(linePairsBySku.get(skuId) || 0);
    if (!stageFlow.hasStageRouting) continue;

    if (stageFlow.previousRequiredDeptId) {
      // First, try predecessor stock of the exact same SKU.
      const previousDeptId = toPositiveInt(stageFlow.previousRequiredDeptId);
      const addBackBySku = await resolveWipAddBackBySkuTx({
        deptId: previousDeptId,
        skuIds: [skuId],
      });
      const pool = await getCurrentWipBalanceTx({
        trx,
        branchId: req.branchId,
        skuId,
        deptId: previousDeptId,
      });
      const availablePairs = Number(
        Number(pool?.qty_pairs || 0) +
          Number(addBackBySku.get(Number(skuId)) || 0),
      );
      const directDeficit = Math.max(0, requiredPairs - availablePairs);
      let conversionCoverPairs = 0;
      if (directDeficit > 0) {
        // If short, see whether better-grade pools can cover the gap for same item+dimensions.
        const conversionPools = await findBetterGradeSourcePoolsTx({
          trx,
          branchId: req.branchId,
          deptId: previousDeptId,
          targetSkuId: skuId,
        });
        const conversionAddBackBySku = await resolveWipAddBackBySkuTx({
          deptId: previousDeptId,
          skuIds: conversionPools.map((row) => Number(row.sku_id)),
        });
        conversionCoverPairs = Number(
          conversionPools.reduce(
            (sum, row) =>
              sum +
              Number(row.available_pairs || 0) +
              Number(conversionAddBackBySku.get(Number(row.sku_id)) || 0),
            0,
          ),
        );
      }
      const effectiveAvailablePairs = Number(
        availablePairs + conversionCoverPairs,
      );
      if (effectiveAvailablePairs < requiredPairs) {
        throw new HttpError(
          400,
          `Stage flow blocked for SKU ${skuLabel}: previous stage WIP is insufficient`,
        );
      }
    }

    const currentRoute = stageFlow.currentRoute || null;
    const finalRequiredRoute = stageFlow.finalRequiredRoute || null;
    if (!currentRoute || !finalRequiredRoute) continue;
    if (Number(currentRoute.stage_id) !== Number(finalRequiredRoute.stage_id))
      continue;

    const mandatoryAnyOrderRoutes = (stageFlow.requiredRoutes || []).filter(
      (route) =>
        Number(route.stage_id) !== Number(currentRoute.stage_id) &&
        route.enforce_sequence === false &&
        toPositiveInt(route.dept_id),
    );
    if (!mandatoryAnyOrderRoutes.length) continue;

    const deptIdsToCheck = [
      toPositiveInt(finalRequiredRoute.dept_id),
      ...mandatoryAnyOrderRoutes.map((route) => toPositiveInt(route.dept_id)),
    ].filter(Boolean);
    if (!deptIdsToCheck.length) continue;

    const completedByDept = await loadWipCompletedPairsByDeptForSkuTx({
      trx,
      branchId: req.branchId,
      skuId,
      deptIds: deptIdsToCheck,
      upToDate: voucherDate,
    });
    const finalStageCompletedBefore = Number(
      completedByDept.get(
        Number(toPositiveInt(finalRequiredRoute.dept_id) || 0),
      ) || 0,
    );
    const expectedFinalAfterPosting = finalStageCompletedBefore + requiredPairs;

    const missingStages = mandatoryAnyOrderRoutes
      .map((route) => {
        const deptId = Number(toPositiveInt(route.dept_id) || 0);
        const completedPairs = Number(completedByDept.get(deptId) || 0);
        const deficitPairs = Math.max(
          0,
          expectedFinalAfterPosting - completedPairs,
        );
        if (deficitPairs <= 0) return null;
        return `${String(route.stage_name || `Stage ${route.stage_id}`)} short by ${deficitPairs} pair(s)`;
      })
      .filter(Boolean);

    if (missingStages.length) {
      throw new HttpError(
        400,
        `Mandatory stage completion is insufficient for SKU ${skuLabel}. ${missingStages.join("; ")}`,
      );
    }
  }
};

const loadWipCompletedPairsByDeptForSkuTx = async ({
  trx,
  branchId,
  skuId,
  deptIds = [],
  upToDate = null,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuId = toPositiveInt(skuId);
  const normalizedDeptIds = [
    ...new Set((deptIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalizedBranchId || !normalizedSkuId || !normalizedDeptIds.length) {
    return new Map();
  }

  let query = trx("erp.wip_dept_ledger as wl")
    .select("wl.dept_id")
    .sum({
      completed_pairs: trx.raw(
        "CASE WHEN wl.direction = 1 THEN wl.qty_pairs ELSE 0 END",
      ),
    })
    .where("wl.branch_id", normalizedBranchId)
    .andWhere("wl.sku_id", normalizedSkuId)
    .whereIn("wl.dept_id", normalizedDeptIds)
    .groupBy("wl.dept_id");

  if (upToDate) {
    query = query.andWhere("wl.txn_date", "<=", upToDate);
  }

  const rows = await query;
  return new Map(
    rows.map((row) => [Number(row.dept_id), Number(row.completed_pairs || 0)]),
  );
};

const buildSfgRequirementsForStage = ({
  bomProfile,
  stageId,
  producedPairs,
  lineNo = null,
  skuLabel = "SKU",
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  const linePairs = Number(producedPairs || 0);
  if (!normalizedStageId || !Number.isInteger(linePairs) || linePairs <= 0)
    return [];
  const profile =
    bomProfile && typeof bomProfile === "object" ? bomProfile : null;
  if (!profile) return [];

  const sourceSizeId = toPositiveInt(profile.skuSizeId);
  const outputQty = Number(profile.outputQty || 0);
  const outputFactorToPair = Number(profile.outputUomFactorToPair || 0);
  const outputQtyInPairs = Number((outputQty * outputFactorToPair).toFixed(6));
  if (!(Number.isFinite(outputQtyInPairs) && outputQtyInPairs > 0)) {
    return [];
  }
  const ratio = Number((linePairs / outputQtyInPairs).toFixed(12));

  const stageSfgLines = (
    Array.isArray(profile.sfgLines) ? profile.sfgLines : []
  ).filter((row) => {
    const consumedStageId = toPositiveInt(row?.consumed_in_stage_id);
    if (
      !consumedStageId ||
      Number(consumedStageId) !== Number(normalizedStageId)
    )
      return false;
    const fgSizeId = toPositiveInt(row?.fg_size_id);
    if (!fgSizeId || !sourceSizeId) return false;
    return Number(fgSizeId) === Number(sourceSizeId);
  });

  const requirements = [];
  for (const sfgLine of stageSfgLines) {
    const sfgSkuId = toPositiveInt(sfgLine?.sfg_sku_id);
    const requiredQty = Number(sfgLine?.required_qty || 0);
    const uomFactorToPair = Number(sfgLine?.uom_factor_to_pair || 0);
    if (!sfgSkuId || requiredQty <= 0) continue;
    if (!(Number.isFinite(uomFactorToPair) && uomFactorToPair > 0)) {
      throw new HttpError(
        400,
        `SFG UOM conversion to PAIR is missing for SKU #${sfgSkuId} in BOM for ${skuLabel}`,
      );
    }

    const requiredPairsRaw = Number(
      (requiredQty * uomFactorToPair * ratio).toFixed(6),
    );
    const requiredPairsRounded = Math.round(requiredPairsRaw);
    if (Math.abs(requiredPairsRaw - requiredPairsRounded) > 0.000001) {
      const linePrefix = lineNo ? `Line ${lineNo}: ` : "";
      throw new HttpError(
        400,
        `${linePrefix}SFG requirement for ${skuLabel} -> SFG #${sfgSkuId} is fractional (${requiredPairsRaw} pairs). Align BOM qty/UOM to whole pairs.`,
      );
    }
    if (requiredPairsRounded <= 0) continue;
    requirements.push({
      sfg_sku_id: Number(sfgSkuId),
      required_pairs: Number(requiredPairsRounded),
    });
  }
  return requirements;
};

const validateDcvSfgAvailabilityTx = async ({
  trx,
  req,
  stageId,
  voucherId = null,
  lines = [],
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  const normalizedLines = Array.isArray(lines) ? lines : [];
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedStageId || !normalizedLines.length) return;

  const skuIds = [
    ...new Set(
      normalizedLines
        .map((line) => toPositiveInt(line?.sku_id))
        .filter(Boolean),
    ),
  ];
  if (!skuIds.length) return;

  const skuDisplayMap = await loadSkuDisplayMapTx({ trx, skuIds });
  const bomBySku = new Map();
  const requiredPairsBySfgSku = new Map();

  for (const line of normalizedLines) {
    const fgSkuId = toPositiveInt(line?.sku_id);
    const lineNo = Number(line?.line_no || 0) || null;
    const producedPairs = Number(line?.total_pairs || line?.qty || 0);
    if (!fgSkuId || !Number.isInteger(producedPairs) || producedPairs <= 0)
      continue;

    let bomProfile = bomBySku.get(fgSkuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId: fgSkuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(
          skuDisplayMap.get(fgSkuId) || { sku_code: `#${fgSkuId}` },
        );
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomBySku.set(fgSkuId, bomProfile);
    }

    const skuLabel = buildSkuDisplayLabel(
      skuDisplayMap.get(fgSkuId) || { sku_code: `#${fgSkuId}` },
    );
    const requirements = buildSfgRequirementsForStage({
      bomProfile,
      stageId: normalizedStageId,
      producedPairs,
      lineNo,
      skuLabel,
    });

    requirements.forEach((row) => {
      const nextQty =
        Number(requiredPairsBySfgSku.get(row.sfg_sku_id) || 0) +
        Number(row.required_pairs || 0);
      requiredPairsBySfgSku.set(Number(row.sfg_sku_id), Number(nextQty));
    });
  }

  if (!requiredPairsBySfgSku.size) return;

  const requiredSkuIds = [...requiredPairsBySfgSku.keys()];
  let addBackBySku = new Map();
  if (normalizedVoucherId && (await hasStockLedgerTableTx(trx))) {
    const generatedLink = await trx("erp.production_generated_links")
      .select("consumption_voucher_id")
      .where({ production_voucher_id: Number(normalizedVoucherId) })
      .first();
    const addBackVoucherIds = [
      Number(normalizedVoucherId),
      toPositiveInt(generatedLink?.consumption_voucher_id),
    ].filter(Boolean);
    if (addBackVoucherIds.length) {
      // Edit-mode add-back:
      // include SFG stock already consumed by this DCV (and its generated
      // consumption voucher) so a qty reduction does not falsely fail.
      const addBackRows = await trx("erp.stock_ledger as sl")
        .select("sl.sku_id")
        .sum({ qty_pairs: trx.raw("COALESCE(sl.qty_pairs, 0)") })
        .where({
          "sl.branch_id": Number(req.branchId),
          "sl.stock_state": "ON_HAND",
          "sl.category": "SFG",
          "sl.direction": -1,
        })
        .whereIn("sl.voucher_header_id", addBackVoucherIds)
        .whereIn("sl.sku_id", requiredSkuIds)
        .groupBy("sl.sku_id");
      addBackBySku = new Map(
        addBackRows.map((row) => [
          Number(row.sku_id),
          Number(row.qty_pairs || 0),
        ]),
      );
    }
  }
  const availableBySku = await loadOnHandSfgPairsBySkuTx({
    trx,
    branchId: req.branchId,
    skuIds: requiredSkuIds,
  });
  const requiredSkuDisplayMap = await loadSkuDisplayMapTx({
    trx,
    skuIds: requiredSkuIds,
  });
  const deficits = requiredSkuIds
    .map((sfgSkuId) => {
      const requiredPairs = Number(requiredPairsBySfgSku.get(sfgSkuId) || 0);
      const availablePairs = Number(
        Number(availableBySku.get(sfgSkuId) || 0) +
          Number(addBackBySku.get(Number(sfgSkuId)) || 0),
      );
      const deficitPairs = Math.max(0, requiredPairs - availablePairs);
      if (deficitPairs <= 0) return null;
      const skuLabel = buildSkuDisplayLabel(
        requiredSkuDisplayMap.get(sfgSkuId) || { sku_code: `#${sfgSkuId}` },
      );
      return `${skuLabel} deficit ${deficitPairs} pair(s) (required ${requiredPairs}, available ${availablePairs})`;
    })
    .filter(Boolean);

  if (deficits.length) {
    throw new HttpError(
      400,
      `SFG stock is insufficient for selected stage. ${deficits.join("; ")}`,
    );
  }
};

const validateLossLinesTx = async ({
  trx,
  req,
  rawLines = [],
  lossType: headerLossType,
  departmentId: headerDepartmentId,
}) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const normalizedLossType = normalizeLossType(headerLossType);
  if (!normalizedLossType) {
    throw new HttpError(400, "Loss type is invalid");
  }
  const normalizedHeaderDeptId = toPositiveInt(headerDepartmentId);
  const normalizedRmHeaderDeptId =
    normalizedLossType === "RM_LOSS" ? normalizedHeaderDeptId : null;

  if (normalizedLossType === "DVC_ABANDON") {
    const dept = await trx("erp.departments")
      .select("id", "is_active", "is_production")
      .where({ id: normalizedHeaderDeptId })
      .first();
    if (!dept || dept.is_active !== true || dept.is_production !== true) {
      throw new HttpError(
        400,
        "Production department is required for DVC abandon",
      );
    }
  }

  const rmItemIds = [];
  const rmDeptIds = [];
  const rmColorIds = [];
  const rmSizeIds = [];
  const skuIds = [];
  lines.forEach((line) => {
    if (normalizedLossType === "RM_LOSS") {
      const itemId = toPositiveInt(line?.item_id || line?.itemId);
      if (itemId) rmItemIds.push(itemId);
      const deptId =
        toPositiveInt(line?.dept_id || line?.department_id) ||
        normalizedRmHeaderDeptId;
      if (deptId) rmDeptIds.push(deptId);
      const colorId = toPositiveInt(
        line?.rm_color_id || line?.rmColorId || line?.color_id || line?.colorId,
      );
      const sizeId = toPositiveInt(
        line?.rm_size_id || line?.rmSizeId || line?.size_id || line?.sizeId,
      );
      if (colorId) rmColorIds.push(colorId);
      if (sizeId) rmSizeIds.push(sizeId);
      return;
    }
    const skuId = toPositiveInt(line?.sku_id || line?.skuId);
    if (skuId) skuIds.push(skuId);
  });

  const itemRows = rmItemIds.length
    ? await trx("erp.items")
        .select("id", "item_type", "name")
        .whereIn("id", [...new Set(rmItemIds)])
        .where({ is_active: true })
    : [];
  const itemMap = new Map(itemRows.map((row) => [Number(row.id), row]));

  const rmDeptRows = rmDeptIds.length
    ? await trx("erp.departments")
        .select("id", "is_active", "is_production")
        .whereIn("id", [...new Set(rmDeptIds)])
    : [];
  const rmDeptMap = new Map(rmDeptRows.map((row) => [Number(row.id), row]));

  const hasRmPurchaseRates = await hasRmPurchaseRatesTableTx(trx);
  const rmVariantRows =
    hasRmPurchaseRates && rmItemIds.length
      ? await trx("erp.rm_purchase_rates as r")
          .select("r.rm_item_id", "r.color_id", "r.size_id")
          .whereIn("r.rm_item_id", [...new Set(rmItemIds)])
          .andWhere("r.is_active", true)
      : [];
  const rmVariantIdentityByItemId = new Map();
  rmVariantRows.forEach((row) => {
    const itemId = toPositiveInt(row?.rm_item_id);
    if (!itemId) return;
    const colorId = toPositiveInt(row?.color_id);
    const sizeId = toPositiveInt(row?.size_id);
    const key = `${Number(colorId || 0)}:${Number(sizeId || 0)}`;
    const bucket = rmVariantIdentityByItemId.get(Number(itemId)) || new Set();
    bucket.add(key);
    rmVariantIdentityByItemId.set(Number(itemId), bucket);
  });

  const colorRows = rmColorIds.length
    ? await trx("erp.colors")
        .select("id", "is_active")
        .whereIn("id", [...new Set(rmColorIds)])
    : [];
  const sizeRows = rmSizeIds.length
    ? await trx("erp.sizes")
        .select("id", "is_active")
        .whereIn("id", [...new Set(rmSizeIds)])
    : [];
  const colorMap = new Map(colorRows.map((row) => [Number(row.id), row]));
  const sizeMap = new Map(sizeRows.map((row) => [Number(row.id), row]));

  const skuMap = await loadSkuMapTx({ trx, skuIds, itemTypes: ["FG", "SFG"] });

  return Promise.all(
    lines.map(async (line, index) => {
      const lineNo = Number(index + 1);
      const lossType = normalizedLossType;

      const qty = toPositiveNumber(line?.qty, 3);
      if (!qty)
        throw new HttpError(
          400,
          `Line ${lineNo}: quantity must be greater than zero`,
        );
      const rate = toNonNegativeNumber(line?.rate, 4);
      if (rate === null)
        throw new HttpError(400, `Line ${lineNo}: rate is invalid`);
      const inputAmount = toNonNegativeNumber(line?.amount, 2);
      if (inputAmount === null)
        throw new HttpError(400, `Line ${lineNo}: amount is invalid`);
      const amount = Number(
        (inputAmount > 0 ? inputAmount : Number(qty) * Number(rate)).toFixed(2),
      );

      if (lossType === "RM_LOSS") {
        const itemId = toPositiveInt(line?.item_id || line?.itemId);
        const item = itemMap.get(Number(itemId || 0));
        if (!item || String(item.item_type || "").toUpperCase() !== "RM") {
          throw new HttpError(400, `Line ${lineNo}: raw material is invalid`);
        }
        const deptId =
          toPositiveInt(line?.dept_id || line?.department_id) ||
          normalizedRmHeaderDeptId;
        const dept = rmDeptMap.get(Number(deptId || 0));
        if (
          !deptId ||
          !dept ||
          dept.is_active !== true ||
          dept.is_production !== true
        ) {
          throw new HttpError(
            400,
            `Line ${lineNo}: production department is required for raw material loss`,
          );
        }

        const colorId = toPositiveInt(
          line?.rm_color_id ||
            line?.rmColorId ||
            line?.color_id ||
            line?.colorId,
        );
        const sizeId = toPositiveInt(
          line?.rm_size_id || line?.rmSizeId || line?.size_id || line?.sizeId,
        );
        const color = colorMap.get(Number(colorId || 0));
        const size = sizeMap.get(Number(sizeId || 0));
        if (colorId && (!color || color.is_active !== true)) {
          throw new HttpError(
            400,
            `Line ${lineNo}: raw material color is invalid`,
          );
        }
        if (sizeId && (!size || size.is_active !== true)) {
          throw new HttpError(
            400,
            `Line ${lineNo}: raw material size is invalid`,
          );
        }

        const allowedVariantSet =
          rmVariantIdentityByItemId.get(Number(itemId)) || null;
        if (allowedVariantSet && allowedVariantSet.size) {
          const variantKey = `${Number(colorId || 0)}:${Number(sizeId || 0)}`;
          if (!allowedVariantSet.has(variantKey)) {
            throw new HttpError(
              400,
              `Line ${lineNo}: select a valid color/size combination for raw material loss`,
            );
          }
        }

        return {
          line_no: lineNo,
          line_kind: "ITEM",
          item_id: Number(itemId),
          uom_id: toPositiveInt(line?.uom_id || line?.uomId),
          qty: Number(qty.toFixed(3)),
          rate: Number(rate.toFixed(4)),
          amount,
          meta: {
            rm_color_id: colorId || null,
            rm_size_id: sizeId || null,
          },
          loss_type: lossType,
          dept_id: Number(deptId),
        };
      }

      if (!Number.isInteger(Number(qty))) {
        throw new HttpError(
          400,
          lossType === "DVC_ABANDON"
            ? `Line ${lineNo}: DVC abandon quantity must be whole pairs`
            : `Line ${lineNo}: SKU loss quantity must be whole pairs`,
        );
      }

      const skuId = toPositiveInt(line?.sku_id || line?.skuId);
      const sku = skuMap.get(Number(skuId || 0));
      if (!sku) throw new HttpError(400, `Line ${lineNo}: SKU is invalid`);

      const skuItemType = String(sku.item_type || "").toUpperCase();
      if (lossType === "FG_LOSS" && skuItemType !== "FG") {
        throw new HttpError(400, `Line ${lineNo}: FG loss requires an FG SKU`);
      }
      if (lossType === "SFG_LOSS" && skuItemType !== "SFG") {
        throw new HttpError(
          400,
          `Line ${lineNo}: SFG loss requires an SFG SKU`,
        );
      }

      let deptId = null;
      if (lossType === "DVC_ABANDON") {
        deptId = normalizedHeaderDeptId;
        if (!deptId)
          throw new HttpError(
            400,
            "Production department is required for DVC abandon",
          );

        const pool = await trx("erp.wip_dept_balance")
          .select("qty_pairs")
          .where({
            branch_id: req.branchId,
            sku_id: Number(skuId),
            dept_id: Number(deptId),
          })
          .first();

        if (Number(pool?.qty_pairs || 0) < Number(qty)) {
          throw new HttpError(
            400,
            `Line ${lineNo}: abandon quantity exceeds pending WIP balance`,
          );
        }
      }

      return {
        line_no: lineNo,
        line_kind: "SKU",
        sku_id: Number(skuId),
        uom_id: toPositiveInt(sku.base_uom_id),
        qty: Number(qty.toFixed(3)),
        rate: Number(rate.toFixed(4)),
        amount,
        meta: {},
        loss_type: lossType,
        dept_id: deptId,
      };
    }),
  );
};

const validateProductionLineStagesTx = async ({ trx, lines = [] }) => {
  const hasStagesTable = await hasProductionStagesTableTx(trx);
  const hasLineStageColumn = await hasProductionLineStageColumnTx(trx);
  if (!hasStagesTable || !hasLineStageColumn) return lines;

  const stageRows = await loadActiveProductionStagesTx(trx);
  if (!stageRows.length) {
    return (lines || []).map((line) => ({
      ...line,
      stage_id: null,
      meta: {
        ...(line?.meta && typeof line.meta === "object" ? line.meta : {}),
        stage_id: null,
      },
    }));
  }

  const activeStageIdSet = new Set(stageRows.map((row) => Number(row.id)));
  return (lines || []).map((line, index) => {
    const lineNo = Number(index + 1);
    const stageId = toPositiveInt(
      line?.stage_id || line?.stageId || line?.meta?.stage_id,
    );
    if (!stageId) {
      throw new HttpError(400, `Line ${lineNo}: stage is required`);
    }
    if (!activeStageIdSet.has(Number(stageId))) {
      throw new HttpError(400, `Line ${lineNo}: selected stage is invalid`);
    }
    return {
      ...line,
      stage_id: Number(stageId),
      meta: {
        ...(line?.meta && typeof line.meta === "object" ? line.meta : {}),
        stage_id: Number(stageId),
      },
    };
  });
};

const normalizeAndValidatePayloadTx = async ({
  trx,
  req,
  voucherTypeCode,
  voucherId = null,
  payload = {},
}) => {
  const voucherDate = toDateOnly(payload?.voucher_date || payload?.voucherDate);
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  const remarks = normalizeText(payload?.remarks || payload?.description, 1000);
  const referenceNo = normalizeText(
    payload?.reference_no || payload?.referenceNo,
    120,
  );

  if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
  ) {
    const baseLines = await validateProductionOrPlanLinesTx({
      trx,
      voucherTypeCode,
      rawLines: payload?.lines,
    });
    const lines = await validateProductionLineStagesTx({
      trx,
      lines: baseLines,
    });
    await ensureApprovedBomExistsForSkusTx({
      trx,
      skuIds: lines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
    });
    return {
      voucherDate,
      remarks,
      referenceNo,
      lines,
      deptId: null,
      labourId: null,
      stageId: null,
      planKind: null,
      reasonCodeId: null,
    };
  }

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion) {
    const supportsDcvStage = await hasDcvHeaderStageColumnTx(trx);
    const dcvUnits = await loadPairConvertibleUomOptionsTx(trx);
    const labourId = await validateLabourTx({
      trx,
      req,
      labourId: payload?.labour_id,
      allowNull: false,
    });
    const deptId = await validateDepartmentForLabourTx({
      trx,
      departmentId: payload?.dept_id || payload?.department_id,
      labourId,
      requireProduction: true,
    });
    const requestedStageId = toPositiveInt(
      payload?.stage_id || payload?.stageId,
    );
    const stageId = requestedStageId
      ? await validateStageTx({
          trx,
          stageId: requestedStageId,
          departmentId: deptId,
          allowNull: false,
        })
      : await resolveActiveStageForDepartmentTx({
          trx,
          departmentId: deptId,
          allowNull: !supportsDcvStage,
        });
    const lines = await validateDcvLinesTx({
      trx,
      req,
      labourId,
      deptId,
      rawLines: payload?.lines,
      dcvUnits,
    });
    await validateDcvStageFlowTx({
      trx,
      req,
      stageId,
      departmentId: deptId,
      voucherDate,
      voucherId,
      lines,
    });
    await validateDcvSfgAvailabilityTx({
      trx,
      req,
      stageId,
      voucherId,
      lines,
    });
    return {
      voucherDate,
      remarks,
      referenceNo,
      lines,
      deptId,
      labourId,
      stageId,
      planKind: null,
      reasonCodeId: null,
    };
  }

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.productionPlan) {
    const planKind = String(payload?.plan_kind || payload?.planKind || "FG")
      .trim()
      .toUpperCase();
    if (planKind !== "FG" && planKind !== "SFG") {
      throw new HttpError(400, "Plan kind is invalid");
    }
    const lines = await validateProductionOrPlanLinesTx({
      trx,
      voucherTypeCode,
      planKind,
      rawLines: payload?.lines,
    });
    return {
      voucherDate,
      remarks,
      referenceNo,
      lines,
      deptId: null,
      labourId: null,
      stageId: null,
      planKind,
      reasonCodeId: null,
    };
  }

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss) {
    const lossType = normalizeLossType(payload?.loss_type || payload?.lossType);
    const deptId = toPositiveInt(payload?.dept_id || payload?.department_id);
    const reasonCodeId = await validateReasonCodeTx({
      trx,
      reasonCodeId: payload?.reason_code_id,
      voucherTypeCode,
    });
    const lines = await validateLossLinesTx({
      trx,
      req,
      rawLines: payload?.lines,
      lossType,
      departmentId: deptId,
    });
    return {
      voucherDate,
      remarks,
      referenceNo,
      lines,
      deptId: lossType === "DVC_ABANDON" ? deptId : null,
      labourId: null,
      stageId: null,
      planKind: null,
      reasonCodeId,
      lossType,
    };
  }

  throw new HttpError(400, "Unsupported production voucher type");
};

const insertVoucherLinesTx = async ({ trx, voucherId, lines = [] }) => {
  if (!lines.length) return [];
  const rows = lines.map((line, index) => ({
    voucher_header_id: voucherId,
    line_no: Number(line.line_no || index + 1),
    line_kind: String(line.line_kind || "").toUpperCase(),
    item_id: toPositiveInt(line.item_id),
    sku_id: toPositiveInt(line.sku_id),
    account_id: toPositiveInt(line.account_id),
    party_id: toPositiveInt(line.party_id),
    labour_id: toPositiveInt(line.labour_id),
    employee_id: toPositiveInt(line.employee_id),
    uom_id: toPositiveInt(line.uom_id),
    qty: Number(line.qty || 0),
    rate: Number(line.rate || 0),
    amount: Number(line.amount || 0),
    reference_no: normalizeText(line.reference_no, 120),
    meta: line.meta && typeof line.meta === "object" ? line.meta : {},
  }));
  return trx("erp.voucher_line")
    .insert(rows)
    .returning([
      "id",
      "line_no",
      "line_kind",
      "item_id",
      "sku_id",
      "labour_id",
    ]);
};

const upsertVoucherExtensionsTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  validated,
  insertedLines = [],
}) => {
  const lineByNo = new Map(
    (insertedLines || []).map((row) => [Number(row.line_no), Number(row.id)]),
  );
  const supportsDcvStage = await hasDcvHeaderStageColumnTx(trx);
  const supportsProductionStage = await hasProductionLineStageColumnTx(trx);
  const supportsLossStage = await hasAbnormalLossStageColumnTx(trx);

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion) {
    const dcvPayload = {
      voucher_id: voucherId,
      dept_id: validated.deptId,
      labour_id: validated.labourId,
    };
    if (supportsDcvStage)
      dcvPayload.stage_id = toPositiveInt(validated.stageId);
    await trx("erp.dcv_header")
      .insert(dcvPayload)
      .onConflict("voucher_id")
      .merge(
        supportsDcvStage
          ? ["dept_id", "labour_id", "stage_id"]
          : ["dept_id", "labour_id"],
      );
    return;
  }

  if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
  ) {
    const productionLineRows = validated.lines
      .map((line) => {
        const voucherLineId = lineByNo.get(Number(line.line_no));
        if (!voucherLineId) return null;
        return {
          voucher_line_id: Number(voucherLineId),
          is_packed: line.is_packed === true,
          total_pairs: Number(line.total_pairs || 0),
          ...(supportsProductionStage
            ? { stage_id: toPositiveInt(line.stage_id) }
            : {}),
        };
      })
      .filter(Boolean);

    if (productionLineRows.length) {
      await trx("erp.production_line").insert(productionLineRows);
    }
    return;
  }

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.productionPlan) {
    await trx("erp.production_plan_header")
      .insert({
        voucher_id: voucherId,
        plan_kind: validated.planKind,
      })
      .onConflict("voucher_id")
      .merge(["plan_kind"]);

    const planLineRows = validated.lines
      .map((line) => {
        const voucherLineId = lineByNo.get(Number(line.line_no));
        if (!voucherLineId) return null;
        return {
          voucher_line_id: Number(voucherLineId),
          is_packed: line.is_packed === true,
          total_pairs: Number(line.total_pairs || 0),
        };
      })
      .filter(Boolean);
    if (planLineRows.length) {
      await trx("erp.production_plan_line").insert(planLineRows);
    }
    return;
  }

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss) {
    await trx("erp.abnormal_loss_header")
      .insert({
        voucher_id: voucherId,
        reason_code_id: validated.reasonCodeId,
      })
      .onConflict("voucher_id")
      .merge(["reason_code_id"]);

    const lossLineRows = validated.lines
      .map((line) => {
        const voucherLineId = lineByNo.get(Number(line.line_no));
        if (!voucherLineId) return null;
        return {
          voucher_line_id: Number(voucherLineId),
          loss_type: line.loss_type,
          dept_id: line.dept_id || null,
          ...(supportsLossStage
            ? { stage_id: toPositiveInt(line.stage_id) }
            : {}),
        };
      })
      .filter(Boolean);
    if (lossLineRows.length) {
      await trx("erp.abnormal_loss_line").insert(lossLineRows);
    }
  }
};

const adjustWipBalanceTx = async ({
  trx,
  branchId,
  skuId,
  deptId,
  qtyDelta = 0,
  costDelta = 0,
  activityDate = null,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuId = toPositiveInt(skuId);
  const normalizedDeptId = toPositiveInt(deptId);
  if (!normalizedBranchId || !normalizedSkuId || !normalizedDeptId) return;

  await trx("erp.wip_dept_balance")
    .insert({
      branch_id: normalizedBranchId,
      sku_id: normalizedSkuId,
      dept_id: normalizedDeptId,
      qty_pairs: 0,
      cost_value: 0,
      last_activity_date: activityDate || null,
    })
    .onConflict(["branch_id", "sku_id", "dept_id"])
    .ignore();

  await trx("erp.wip_dept_balance")
    .where({
      branch_id: normalizedBranchId,
      sku_id: normalizedSkuId,
      dept_id: normalizedDeptId,
    })
    .update({
      qty_pairs: trx.raw("greatest(qty_pairs + ?, 0)", [Number(qtyDelta || 0)]),
      cost_value: trx.raw("greatest(cost_value + ?, 0)", [
        Number(costDelta || 0),
      ]),
      last_activity_date: activityDate || trx.raw("last_activity_date"),
    });
};

const insertWipLedgerTx = async ({
  trx,
  branchId,
  skuId,
  deptId,
  txnDate,
  direction,
  qtyPairs,
  costValue,
  sourceVoucherId,
}) => {
  const normalizedQtyPairs = Number(qtyPairs || 0);
  if (!Number.isInteger(normalizedQtyPairs) || normalizedQtyPairs <= 0) return;
  await trx("erp.wip_dept_ledger").insert({
    branch_id: Number(branchId),
    sku_id: Number(skuId),
    dept_id: Number(deptId),
    txn_date: txnDate,
    direction: Number(direction),
    qty_pairs: normalizedQtyPairs,
    cost_value: Number(Number(costValue || 0).toFixed(2)),
    source_voucher_id: Number(sourceVoucherId),
  });
};

const rollbackWipLedgerBySourceVoucherTx = async ({ trx, voucherId }) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;
  const rows = await trx("erp.wip_dept_ledger")
    .select(
      "id",
      "branch_id",
      "sku_id",
      "dept_id",
      "direction",
      "qty_pairs",
      "cost_value",
      "txn_date",
    )
    .where({ source_voucher_id: normalizedVoucherId })
    .orderBy("id", "desc");

  for (const row of rows) {
    const direction = Number(row.direction || 0);
    const qtyPairs = Number(row.qty_pairs || 0);
    const costValue = Number(row.cost_value || 0);
    if (!qtyPairs) continue;
    const qtyDelta = direction === 1 ? -qtyPairs : qtyPairs;
    const costDelta = direction === 1 ? -costValue : costValue;
    await adjustWipBalanceTx({
      trx,
      branchId: row.branch_id,
      skuId: row.sku_id,
      deptId: row.dept_id,
      qtyDelta,
      costDelta,
      activityDate: row.txn_date ? toDateOnly(row.txn_date) : null,
    });
  }

  if (rows.length) {
    await trx("erp.wip_dept_ledger")
      .where({ source_voucher_id: normalizedVoucherId })
      .del();
  }
};

const roundQty3 = (value) => Number(Number(value || 0).toFixed(3));
const roundCost2 = (value) => Number(Number(value || 0).toFixed(2));
const roundUnitCost6 = (value) => Number(Number(value || 0).toFixed(6));

const resolveUnitCost = ({ qty = 0, value = 0, wac = 0 }) => {
  const normalizedQty = Number(qty || 0);
  const normalizedValue = Number(value || 0);
  const normalizedWac = Number(wac || 0);
  if (normalizedQty > 0 && normalizedValue > 0) {
    return roundUnitCost6(normalizedValue / normalizedQty);
  }
  if (normalizedWac > 0) return roundUnitCost6(normalizedWac);
  return 0;
};

const resolveRmRateFromRows = ({
  rows = [],
  itemId,
  colorId = null,
  sizeId = null,
}) => {
  const normalizedItemId = toPositiveInt(itemId);
  if (!normalizedItemId) return 0;
  const normalizedColorId = toPositiveInt(colorId) || 0;
  const normalizedSizeId = toPositiveInt(sizeId) || 0;

  const rateByIdentity = new Map();
  (rows || []).forEach((row) => {
    const rmItemId = toPositiveInt(row?.rm_item_id);
    if (!rmItemId || rmItemId !== normalizedItemId) return;
    const keyColorId = toPositiveInt(row?.color_id) || 0;
    const keySizeId = toPositiveInt(row?.size_id) || 0;
    const avgRate = Number(row?.avg_purchase_rate || 0);
    const purchaseRate = Number(row?.purchase_rate || 0);
    const resolvedRate =
      Number.isFinite(avgRate) && avgRate > 0 ? avgRate : purchaseRate;
    if (!Number.isFinite(resolvedRate) || resolvedRate <= 0) return;
    rateByIdentity.set(
      `${Number(rmItemId)}:${Number(keyColorId)}:${Number(keySizeId)}`,
      Number(resolvedRate.toFixed(6)),
    );
  });

  const candidateKeys = [
    `${normalizedItemId}:${normalizedColorId}:${normalizedSizeId}`,
    `${normalizedItemId}:${normalizedColorId}:0`,
    `${normalizedItemId}:0:${normalizedSizeId}`,
    `${normalizedItemId}:0:0`,
  ];

  for (const key of candidateKeys) {
    const value = Number(rateByIdentity.get(key) || 0);
    if (value > 0) return Number(value.toFixed(6));
  }
  return 0;
};

const loadRmFallbackUnitCostTx = async ({
  trx,
  itemId,
  colorId = null,
  sizeId = null,
}) => {
  const normalizedItemId = toPositiveInt(itemId);
  if (!normalizedItemId) return 0;

  const hasRmPurchaseRates = await hasRmPurchaseRatesTableTx(trx);
  if (!hasRmPurchaseRates) return 0;

  const rows = await trx("erp.rm_purchase_rates as r")
    .select(
      "r.rm_item_id",
      "r.color_id",
      "r.size_id",
      "r.avg_purchase_rate",
      "r.purchase_rate",
    )
    .where({
      "r.rm_item_id": normalizedItemId,
      "r.is_active": true,
    });

  return resolveRmRateFromRows({
    rows,
    itemId: normalizedItemId,
    colorId,
    sizeId,
  });
};

const ensureLossStockInfraTx = async (
  trx,
  { requireRm = false, requireSku = false } = {},
) => {
  const hasLedger = await hasStockLedgerTableTx(trx);
  if (!hasLedger) {
    throw new HttpError(
      400,
      "Stock ledger infrastructure is unavailable for abnormal loss posting",
    );
  }

  if (requireRm) {
    const hasRmBalance = await hasStockBalanceRmTableTx(trx);
    if (!hasRmBalance) {
      throw new HttpError(
        400,
        "RM stock balance infrastructure is unavailable for abnormal loss posting",
      );
    }
  }

  if (requireSku) {
    const hasSkuBalance = await hasStockBalanceSkuTableTx(trx);
    if (!hasSkuBalance) {
      throw new HttpError(
        400,
        "SKU stock balance infrastructure is unavailable for abnormal loss posting",
      );
    }
  }
};

const insertStockLedgerTx = async ({
  trx,
  branchId,
  category,
  stockState = "ON_HAND",
  itemId = null,
  skuId = null,
  colorId = null,
  sizeId = null,
  voucherId,
  voucherLineId = null,
  txnDate,
  direction = -1,
  qty = 0,
  qtyPairs = 0,
  unitCost = 0,
  value = 0,
}) => {
  const payload = {
    branch_id: Number(branchId),
    category: String(category || "").toUpperCase(),
    stock_state: String(stockState || "ON_HAND").toUpperCase(),
    item_id: toPositiveInt(itemId),
    sku_id: toPositiveInt(skuId),
    voucher_header_id: Number(voucherId),
    voucher_line_id: toPositiveInt(voucherLineId),
    txn_date: txnDate,
    direction: Number(direction),
    qty: roundQty3(qty),
    qty_pairs: Number.isInteger(Number(qtyPairs || 0))
      ? Number(qtyPairs || 0)
      : 0,
    unit_cost: roundUnitCost6(unitCost),
    value: roundCost2(value),
  };

  if (await hasStockLedgerVariantDimensionsTx(trx)) {
    payload.color_id = normalizeRmDimensionId(colorId);
    payload.size_id = normalizeRmDimensionId(sizeId);
  }

  await trx("erp.stock_ledger").insert(payload);
};

const applyRmStockOutTx = async ({
  trx,
  branchId,
  itemId,
  colorId = null,
  sizeId = null,
  operationLabel = "RM transaction",
  qtyOut,
  voucherId,
  voucherLineId = null,
  voucherDate,
  writeLedger = true,
  allowNegativeStock = false,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedItemId = toPositiveInt(itemId);
  const normalizedQtyOut = toPositiveNumber(qtyOut, 3);
  if (!normalizedBranchId || !normalizedItemId || !normalizedQtyOut) return 0;
  const supportsRmVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);
  const supportsLedgerVariantDimensions =
    await hasStockLedgerVariantDimensionsTx(trx);

  const normalizedColorId = normalizeRmDimensionId(colorId);
  const normalizedSizeId = normalizeRmDimensionId(sizeId);
  if (
    (normalizedColorId || normalizedSizeId) &&
    (!supportsRmVariantDimensions || !supportsLedgerVariantDimensions)
  ) {
    throw new HttpError(
      400,
      "RM color/size stock tracking is unavailable. Run latest stock variant migration.",
    );
  }
  const identity = buildRmStockIdentity({
    branchId: normalizedBranchId,
    stockState: "ON_HAND",
    itemId: normalizedItemId,
    colorId: normalizedColorId,
    sizeId: normalizedSizeId,
  });
  if (normalizedColorId || normalizedSizeId) {
    const hasRmPurchaseRates = await hasRmPurchaseRatesTableTx(trx);
    if (hasRmPurchaseRates) {
      const variantExists = await trx("erp.rm_purchase_rates as r")
        .select("r.id")
        .where({
          "r.rm_item_id": normalizedItemId,
          "r.is_active": true,
        })
        .whereRaw("COALESCE(r.color_id, 0) = ?", [
          Number(normalizedColorId || 0),
        ])
        .whereRaw("COALESCE(r.size_id, 0) = ?", [Number(normalizedSizeId || 0)])
        .first();
      if (!variantExists) {
        throw new HttpError(
          400,
          `RM loss variant is invalid for item ${normalizedItemId}`,
        );
      }
    }
  }

  const balanceQuery = trx("erp.stock_balance_rm")
    .select("qty", "value", "wac")
    .forUpdate();
  applyRmStockIdentityWhere({
    query: balanceQuery,
    identity,
    supportsVariantDimensions: supportsRmVariantDimensions,
  });
  const balanceRow = await balanceQuery.first();

  const availableQty = Number(balanceRow?.qty || 0);
  const availableValue = Number(balanceRow?.value || 0);
  if (availableQty < normalizedQtyOut) {
    const requiredQty = Number(Number(normalizedQtyOut || 0).toFixed(3));
    const availableQtyRounded = Number(Number(availableQty || 0).toFixed(3));
    const normalizedOperationLabel =
      String(operationLabel || "RM transaction").trim() || "RM transaction";
    if (!allowNegativeStock) {
      // Attach machine-readable shortage metadata so save flow can queue approval with a precise reason.
      const shortageError = new HttpError(
        400,
        `${normalizedOperationLabel}: raw material stock is insufficient for item ${normalizedItemId} (required ${requiredQty}, available ${availableQtyRounded})`,
      );
      shortageError.code = RM_STOCK_SHORTAGE_ERROR_CODE;
      shortageError.shortage = {
        operationLabel: normalizedOperationLabel,
        itemId: normalizedItemId,
        colorId: normalizedColorId,
        sizeId: normalizedSizeId,
        requiredQty,
        availableQty: availableQtyRounded,
      };
      throw shortageError;
    }
  }

  let unitCost = resolveUnitCost({
    qty: availableQty,
    value: availableValue,
    wac: balanceRow?.wac,
  });
  if (!(unitCost > 0)) {
    const fallbackUnitCost = await loadRmFallbackUnitCostTx({
      trx,
      itemId: normalizedItemId,
      colorId: normalizedColorId,
      sizeId: normalizedSizeId,
    });
    if (fallbackUnitCost > 0) {
      unitCost = roundUnitCost6(fallbackUnitCost);
    }
  }
  const consumedValue = roundCost2(Number(normalizedQtyOut) * Number(unitCost));

  const nextQtyRaw = Number(availableQty) - Number(normalizedQtyOut);
  const nextValueRaw = Number(availableValue) - Number(consumedValue);
  if (!allowNegativeStock && (nextQtyRaw < -0.0005 || nextValueRaw < -0.05)) {
    throw new HttpError(
      400,
      `RM loss posting would make stock negative for item ${normalizedItemId}`,
    );
  }
  const nextQty = allowNegativeStock
    ? roundQty3(nextQtyRaw)
    : Math.max(roundQty3(nextQtyRaw), 0);
  const nextValue = allowNegativeStock
    ? roundCost2(nextValueRaw)
    : nextQty > 0
      ? Math.max(roundCost2(nextValueRaw), 0)
      : 0;
  const nextWac = nextQty !== 0 ? roundUnitCost6(nextValue / nextQty) : 0;

  const updateQuery = trx("erp.stock_balance_rm").update({
    qty: nextQty,
    value: nextValue,
    wac: nextWac,
    last_txn_at: trx.fn.now(),
  });
  applyRmStockIdentityWhere({
    query: updateQuery,
    identity,
    supportsVariantDimensions: supportsRmVariantDimensions,
  });
  await updateQuery;

  if (writeLedger) {
    await insertStockLedgerTx({
      trx,
      branchId: normalizedBranchId,
      category: "RM",
      stockState: "ON_HAND",
      itemId: normalizedItemId,
      skuId: null,
      colorId: normalizedColorId,
      sizeId: normalizedSizeId,
      voucherId,
      voucherLineId,
      txnDate: voucherDate,
      direction: -1,
      qty: normalizedQtyOut,
      qtyPairs: 0,
      unitCost,
      value: -consumedValue,
    });
  }

  return consumedValue;
};

const applySkuStockOutTx = async ({
  trx,
  branchId,
  skuId,
  category,
  qtyPairsOut,
  voucherId,
  voucherLineId = null,
  voucherDate,
  writeLedger = true,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuId = toPositiveInt(skuId);
  const normalizedCategory = String(category || "")
    .trim()
    .toUpperCase();
  const normalizedQtyPairsOut = Number(qtyPairsOut || 0);
  if (
    !normalizedBranchId ||
    !normalizedSkuId ||
    !Number.isInteger(normalizedQtyPairsOut) ||
    normalizedQtyPairsOut <= 0
  ) {
    return 0;
  }
  if (normalizedCategory !== "SFG" && normalizedCategory !== "FG") {
    throw new HttpError(
      400,
      `Unsupported stock category ${normalizedCategory} for SKU loss`,
    );
  }

  const rows = await trx("erp.stock_balance_sku")
    .select("is_packed", "qty_pairs", "value", "wac")
    .where({
      branch_id: normalizedBranchId,
      stock_state: "ON_HAND",
      category: normalizedCategory,
      sku_id: normalizedSkuId,
    })
    .orderBy("is_packed", "asc")
    .orderBy("qty_pairs", "desc")
    .forUpdate();

  const totalAvailablePairs = rows.reduce(
    (sum, row) => sum + Number(row?.qty_pairs || 0),
    0,
  );
  if (totalAvailablePairs < normalizedQtyPairsOut) {
    throw new HttpError(
      400,
      `${normalizedCategory} loss quantity exceeds available stock for SKU ${normalizedSkuId}`,
    );
  }

  let remainingPairs = Number(normalizedQtyPairsOut);
  let consumedValueTotal = 0;
  for (const row of rows) {
    const rowQtyPairs = Number(row?.qty_pairs || 0);
    if (remainingPairs <= 0 || rowQtyPairs <= 0) continue;

    const consumePairs = Math.min(rowQtyPairs, remainingPairs);
    const unitCost = resolveUnitCost({
      qty: rowQtyPairs,
      value: Number(row?.value || 0),
      wac: Number(row?.wac || 0),
    });
    const consumedValue = roundCost2(consumePairs * unitCost);

    const nextQtyPairsRaw = rowQtyPairs - consumePairs;
    const nextValueRaw = Number(row?.value || 0) - consumedValue;
    if (nextQtyPairsRaw < 0 || nextValueRaw < -0.05) {
      throw new HttpError(
        400,
        `${normalizedCategory} loss posting would make stock negative for SKU ${normalizedSkuId}`,
      );
    }

    const nextQtyPairs = Math.max(Number(nextQtyPairsRaw || 0), 0);
    const nextValue =
      nextQtyPairs > 0 ? Math.max(roundCost2(nextValueRaw), 0) : 0;
    const nextWac =
      nextQtyPairs > 0 ? roundUnitCost6(nextValue / nextQtyPairs) : 0;

    await trx("erp.stock_balance_sku")
      .where({
        branch_id: normalizedBranchId,
        stock_state: "ON_HAND",
        category: normalizedCategory,
        is_packed: row.is_packed === true,
        sku_id: normalizedSkuId,
      })
      .update({
        qty_pairs: nextQtyPairs,
        value: nextValue,
        wac: nextWac,
        last_txn_at: trx.fn.now(),
      });

    consumedValueTotal = roundCost2(consumedValueTotal + consumedValue);
    remainingPairs -= consumePairs;
  }

  if (remainingPairs > 0) {
    throw new HttpError(
      400,
      `${normalizedCategory} loss posting failed due to stock split inconsistency for SKU ${normalizedSkuId}`,
    );
  }

  if (writeLedger) {
    const avgUnitCost =
      normalizedQtyPairsOut > 0
        ? roundUnitCost6(consumedValueTotal / normalizedQtyPairsOut)
        : 0;
    await insertStockLedgerTx({
      trx,
      branchId: normalizedBranchId,
      category: normalizedCategory,
      stockState: "ON_HAND",
      itemId: null,
      skuId: normalizedSkuId,
      voucherId,
      voucherLineId,
      txnDate: voucherDate,
      direction: -1,
      qty: 0,
      qtyPairs: normalizedQtyPairsOut,
      unitCost: avgUnitCost,
      value: -consumedValueTotal,
    });
  }

  return consumedValueTotal;
};

const applySkuStockInTx = async ({
  trx,
  branchId,
  skuId,
  category,
  qtyPairsIn,
  valueIn = 0,
  voucherId,
  voucherLineId = null,
  voucherDate,
  writeLedger = true,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuId = toPositiveInt(skuId);
  const normalizedCategory = String(category || "")
    .trim()
    .toUpperCase();
  const normalizedQtyPairsIn = Number(qtyPairsIn || 0);
  const normalizedValueIn = roundCost2(Number(valueIn || 0));
  if (
    !normalizedBranchId ||
    !normalizedSkuId ||
    !Number.isInteger(normalizedQtyPairsIn) ||
    normalizedQtyPairsIn <= 0
  ) {
    return 0;
  }
  if (normalizedCategory !== "SFG" && normalizedCategory !== "FG") {
    throw new HttpError(
      400,
      `Unsupported stock category ${normalizedCategory} for SKU stock-in`,
    );
  }

  await trx("erp.stock_balance_sku")
    .insert({
      branch_id: normalizedBranchId,
      stock_state: "ON_HAND",
      category: normalizedCategory,
      is_packed: false,
      sku_id: normalizedSkuId,
      qty_pairs: 0,
      value: 0,
      wac: 0,
      last_txn_at: trx.fn.now(),
    })
    .onConflict(["branch_id", "stock_state", "category", "is_packed", "sku_id"])
    .ignore();

  const row = await trx("erp.stock_balance_sku")
    .select("qty_pairs", "value")
    .where({
      branch_id: normalizedBranchId,
      stock_state: "ON_HAND",
      category: normalizedCategory,
      is_packed: false,
      sku_id: normalizedSkuId,
    })
    .first()
    .forUpdate();

  const nextQtyPairs = Number(row?.qty_pairs || 0) + normalizedQtyPairsIn;
  const nextValue = roundCost2(Number(row?.value || 0) + normalizedValueIn);
  const nextWac =
    nextQtyPairs > 0 ? roundUnitCost6(nextValue / nextQtyPairs) : 0;

  await trx("erp.stock_balance_sku")
    .where({
      branch_id: normalizedBranchId,
      stock_state: "ON_HAND",
      category: normalizedCategory,
      is_packed: false,
      sku_id: normalizedSkuId,
    })
    .update({
      qty_pairs: nextQtyPairs,
      value: nextValue,
      wac: nextWac,
      last_txn_at: trx.fn.now(),
    });

  if (writeLedger) {
    const unitCost =
      normalizedQtyPairsIn > 0
        ? roundUnitCost6(normalizedValueIn / normalizedQtyPairsIn)
        : 0;
    await insertStockLedgerTx({
      trx,
      branchId: normalizedBranchId,
      category: normalizedCategory,
      stockState: "ON_HAND",
      itemId: null,
      skuId: normalizedSkuId,
      voucherId,
      voucherLineId,
      txnDate: voucherDate,
      direction: 1,
      qty: 0,
      qtyPairs: normalizedQtyPairsIn,
      unitCost,
      value: normalizedValueIn,
    });
  }

  return normalizedValueIn;
};

const addBackRmStockFromLedgerTx = async ({ trx, row }) => {
  const branchId = toPositiveInt(row?.branch_id);
  const itemId = toPositiveInt(row?.item_id);
  const colorId = normalizeRmDimensionId(row?.color_id);
  const sizeId = normalizeRmDimensionId(row?.size_id);
  const qty = roundQty3(Number(row?.qty || 0));
  const value = roundCost2(Math.abs(Number(row?.value || 0)));
  const stockState =
    String(row?.stock_state || "ON_HAND")
      .trim()
      .toUpperCase() || "ON_HAND";
  const supportsVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);
  const identity = buildRmStockIdentity({
    branchId,
    stockState,
    itemId,
    colorId,
    sizeId,
  });
  if (!identity.branchId || !identity.itemId || qty <= 0) return;

  await ensureRmBalanceSeedTx({
    trx,
    identity,
    supportsVariantDimensions,
  });

  const existingQuery = trx("erp.stock_balance_rm")
    .select("qty", "value")
    .forUpdate();
  applyRmStockIdentityWhere({
    query: existingQuery,
    identity,
    supportsVariantDimensions,
  });
  const existing = await existingQuery.first();
  const nextQty = roundQty3(Number(existing?.qty || 0) + qty);
  const nextValue = roundCost2(Number(existing?.value || 0) + value);
  const nextWac = nextQty > 0 ? roundUnitCost6(nextValue / nextQty) : 0;

  const updateQuery = trx("erp.stock_balance_rm").update({
    qty: nextQty,
    value: nextValue,
    wac: nextWac,
    last_txn_at: trx.fn.now(),
  });
  applyRmStockIdentityWhere({
    query: updateQuery,
    identity,
    supportsVariantDimensions,
  });
  await updateQuery;
};

const addBackSkuStockFromLedgerTx = async ({ trx, row }) => {
  const branchId = toPositiveInt(row?.branch_id);
  const skuId = toPositiveInt(row?.sku_id);
  const stockState =
    String(row?.stock_state || "ON_HAND")
      .trim()
      .toUpperCase() || "ON_HAND";
  const category = String(row?.category || "")
    .trim()
    .toUpperCase();
  const qtyPairs = Number(row?.qty_pairs || 0);
  const value = roundCost2(Math.abs(Number(row?.value || 0)));
  if (!branchId || !skuId || !Number.isInteger(qtyPairs) || qtyPairs <= 0)
    return;
  if (category !== "SFG" && category !== "FG") return;

  await trx("erp.stock_balance_sku")
    .insert({
      branch_id: branchId,
      stock_state: stockState,
      category,
      is_packed: false,
      sku_id: skuId,
      qty_pairs: 0,
      value: 0,
      wac: 0,
      last_txn_at: trx.fn.now(),
    })
    .onConflict(["branch_id", "stock_state", "category", "is_packed", "sku_id"])
    .ignore();

  const target = await trx("erp.stock_balance_sku")
    .select("is_packed", "qty_pairs", "value")
    .where({
      branch_id: branchId,
      stock_state: stockState,
      category,
      sku_id: skuId,
    })
    .orderBy("is_packed", "asc")
    .first()
    .forUpdate();
  if (!target) return;

  const nextQtyPairs = Number(target.qty_pairs || 0) + Number(qtyPairs || 0);
  const nextValue = roundCost2(Number(target.value || 0) + value);
  const nextWac =
    nextQtyPairs > 0 ? roundUnitCost6(nextValue / nextQtyPairs) : 0;

  await trx("erp.stock_balance_sku")
    .where({
      branch_id: branchId,
      stock_state: stockState,
      category,
      is_packed: target.is_packed === true,
      sku_id: skuId,
    })
    .update({
      qty_pairs: nextQtyPairs,
      value: nextValue,
      wac: nextWac,
      last_txn_at: trx.fn.now(),
    });
};

const removeRmStockFromLedgerTx = async ({ trx, row }) => {
  const branchId = toPositiveInt(row?.branch_id);
  const itemId = toPositiveInt(row?.item_id);
  const colorId = normalizeRmDimensionId(row?.color_id);
  const sizeId = normalizeRmDimensionId(row?.size_id);
  const qty = roundQty3(Number(row?.qty || 0));
  const value = roundCost2(Math.abs(Number(row?.value || 0)));
  const stockState =
    String(row?.stock_state || "ON_HAND")
      .trim()
      .toUpperCase() || "ON_HAND";
  const supportsVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);
  const identity = buildRmStockIdentity({
    branchId,
    stockState,
    itemId,
    colorId,
    sizeId,
  });
  if (!identity.branchId || !identity.itemId || qty <= 0) return;

  const existingQuery = trx("erp.stock_balance_rm")
    .select("qty", "value")
    .forUpdate();
  applyRmStockIdentityWhere({
    query: existingQuery,
    identity,
    supportsVariantDimensions,
  });
  const existing = await existingQuery.first();
  const availableQty = Number(existing?.qty || 0);
  const availableValue = Number(existing?.value || 0);
  if (availableQty < qty) {
    throw new HttpError(
      400,
      `Stock rollback failed: RM qty underflow for item ${itemId}`,
    );
  }
  if (availableValue < value - 0.05) {
    throw new HttpError(
      400,
      `Stock rollback failed: RM value underflow for item ${itemId}`,
    );
  }
  const nextQty = Math.max(roundQty3(availableQty - qty), 0);
  const nextValue =
    nextQty > 0 ? Math.max(roundCost2(availableValue - value), 0) : 0;
  const nextWac = nextQty > 0 ? roundUnitCost6(nextValue / nextQty) : 0;

  const updateQuery = trx("erp.stock_balance_rm").update({
    qty: nextQty,
    value: nextValue,
    wac: nextWac,
    last_txn_at: trx.fn.now(),
  });
  applyRmStockIdentityWhere({
    query: updateQuery,
    identity,
    supportsVariantDimensions,
  });
  await updateQuery;
};

const removeSkuStockFromLedgerTx = async ({ trx, row }) => {
  const branchId = toPositiveInt(row?.branch_id);
  const skuId = toPositiveInt(row?.sku_id);
  const stockState =
    String(row?.stock_state || "ON_HAND")
      .trim()
      .toUpperCase() || "ON_HAND";
  const category = String(row?.category || "")
    .trim()
    .toUpperCase();
  const qtyPairs = Number(row?.qty_pairs || 0);
  const value = roundCost2(Math.abs(Number(row?.value || 0)));
  if (!branchId || !skuId || !Number.isInteger(qtyPairs) || qtyPairs <= 0)
    return;
  if (category !== "SFG" && category !== "FG") return;

  const target = await trx("erp.stock_balance_sku")
    .select("is_packed", "qty_pairs", "value")
    .where({
      branch_id: branchId,
      stock_state: stockState,
      category,
      is_packed: false,
      sku_id: skuId,
    })
    .first()
    .forUpdate();
  const availableQtyPairs = Number(target?.qty_pairs || 0);
  const availableValue = Number(target?.value || 0);
  if (availableQtyPairs < qtyPairs) {
    throw new HttpError(
      400,
      `Stock rollback failed: ${category} qty underflow for SKU ${skuId}`,
    );
  }
  if (availableValue < value - 0.05) {
    throw new HttpError(
      400,
      `Stock rollback failed: ${category} value underflow for SKU ${skuId}`,
    );
  }

  const nextQtyPairs = Math.max(availableQtyPairs - qtyPairs, 0);
  const nextValue =
    nextQtyPairs > 0 ? Math.max(roundCost2(availableValue - value), 0) : 0;
  const nextWac =
    nextQtyPairs > 0 ? roundUnitCost6(nextValue / nextQtyPairs) : 0;

  await trx("erp.stock_balance_sku")
    .where({
      branch_id: branchId,
      stock_state: stockState,
      category,
      is_packed: false,
      sku_id: skuId,
    })
    .update({
      qty_pairs: nextQtyPairs,
      value: nextValue,
      wac: nextWac,
      last_txn_at: trx.fn.now(),
    });
};

const rollbackStockLedgerBySourceVoucherTx = async ({ trx, voucherId }) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;
  if (!(await hasStockLedgerTableTx(trx))) return;
  const hasVariantDimensions = await hasStockLedgerVariantDimensionsTx(trx);
  const selectColumns = [
    "id",
    "branch_id",
    "category",
    "stock_state",
    "item_id",
    "sku_id",
    "direction",
    "qty",
    "qty_pairs",
    "value",
  ];
  if (hasVariantDimensions) {
    selectColumns.splice(selectColumns.length - 1, 0, "color_id", "size_id");
  }

  const rows = await trx("erp.stock_ledger")
    .select(selectColumns)
    .where({ voucher_header_id: normalizedVoucherId })
    .orderBy("id", "desc");

  for (const row of rows) {
    const direction = Number(row?.direction || 0);
    const category = String(row?.category || "")
      .trim()
      .toUpperCase();
    if (direction === -1) {
      if (category === "RM") {
        await addBackRmStockFromLedgerTx({ trx, row });
        continue;
      }
      if (category === "SFG" || category === "FG") {
        await addBackSkuStockFromLedgerTx({ trx, row });
      }
      continue;
    }
    if (direction === 1) {
      if (category === "RM") {
        await removeRmStockFromLedgerTx({ trx, row });
        continue;
      }
      if (category === "SFG" || category === "FG") {
        await removeSkuStockFromLedgerTx({ trx, row });
      }
      continue;
    }
    throw new HttpError(
      400,
      `Unexpected stock ledger direction (${direction}) while rolling back voucher ${normalizedVoucherId}`,
    );
  }

  if (rows.length) {
    await trx("erp.stock_ledger")
      .where({ voucher_header_id: normalizedVoucherId })
      .del();
  }
};

const deleteGeneratedChildVouchersTx = async ({ trx, productionVoucherId }) => {
  const normalizedProductionVoucherId = toPositiveInt(productionVoucherId);
  if (!normalizedProductionVoucherId) return;
  const row = await trx("erp.production_generated_links")
    .select("consumption_voucher_id", "labour_voucher_id")
    .where({ production_voucher_id: normalizedProductionVoucherId })
    .first();
  if (!row) return;

  const childVoucherIds = [
    toPositiveInt(row.consumption_voucher_id),
    toPositiveInt(row.labour_voucher_id),
  ].filter(Boolean);

  await trx("erp.production_generated_links")
    .where({ production_voucher_id: normalizedProductionVoucherId })
    .del();

  if (childVoucherIds.length) {
    for (const childVoucherId of childVoucherIds) {
      await rollbackStockLedgerBySourceVoucherTx({
        trx,
        voucherId: childVoucherId,
      });
    }
    await trx("erp.voucher_header").whereIn("id", childVoucherIds).del();
  }
};

const getCurrentWipBalanceTx = async ({ trx, branchId, skuId, deptId }) =>
  trx("erp.wip_dept_balance")
    .select("qty_pairs", "cost_value")
    .where({
      branch_id: Number(branchId),
      sku_id: Number(skuId),
      dept_id: Number(deptId),
    })
    .first();

const findBetterGradeSourcePoolsTx = async ({
  trx,
  branchId,
  deptId,
  targetSkuId,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedDeptId = toPositiveInt(deptId);
  const normalizedTargetSkuId = toPositiveInt(targetSkuId);
  if (!normalizedBranchId || !normalizedDeptId || !normalizedTargetSkuId)
    return [];

  const targetRow = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.grades as g", "g.id", "v.grade_id")
    .select(
      "s.id as sku_id",
      "v.item_id",
      "v.size_id",
      "v.color_id",
      "v.packing_type_id",
      "v.grade_id",
      "g.grade_rank",
    )
    .where("s.id", normalizedTargetSkuId)
    .first();
  if (!targetRow) return [];

  const targetGradeRank = Number(targetRow.grade_rank || 0);
  // Target already at top rank: nothing better exists to convert from.
  if (!Number.isFinite(targetGradeRank) || targetGradeRank <= 1) return [];

  const pools = await trx("erp.wip_dept_balance as wb")
    .join("erp.skus as s", "s.id", "wb.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.grades as g", "g.id", "v.grade_id")
    .select(
      "wb.sku_id",
      "wb.qty_pairs",
      "wb.cost_value",
      "v.grade_id",
      "g.grade_rank",
      "s.sku_code",
    )
    .where({
      "wb.branch_id": normalizedBranchId,
      "wb.dept_id": normalizedDeptId,
      "v.item_id": Number(targetRow.item_id || 0),
    })
    .andWhere((qb) => {
      qb.whereRaw("COALESCE(v.size_id, 0) = COALESCE(?, 0)", [
        targetRow.size_id || null,
      ]);
      qb.whereRaw("COALESCE(v.color_id, 0) = COALESCE(?, 0)", [
        targetRow.color_id || null,
      ]);
      qb.whereRaw("COALESCE(v.packing_type_id, 0) = COALESCE(?, 0)", [
        targetRow.packing_type_id || null,
      ]);
    })
    .whereNot("wb.sku_id", normalizedTargetSkuId)
    // Only better grades are eligible as conversion sources.
    .andWhereRaw("COALESCE(g.grade_rank, 0) > 0")
    .andWhereRaw("g.grade_rank < ?", [targetGradeRank])
    .andWhere("wb.qty_pairs", ">", 0)
    // consume closest better grade first (e.g. B from A2 before A1 if both better)
    .orderBy("g.grade_rank", "desc")
    .orderBy("wb.qty_pairs", "desc");

  return pools.map((row) => ({
    sku_id: Number(row.sku_id),
    grade_rank: Number(row.grade_rank || 0),
    available_pairs: Number(row.qty_pairs || 0),
    available_cost: Number(row.cost_value || 0),
    sku_code: String(row.sku_code || "").trim(),
  }));
};

const allocateFromBetterGradePoolTx = async ({
  trx,
  branchId,
  deptId,
  targetSkuId,
  targetPairs,
  voucherDate,
  sourceVoucherId,
}) => {
  const normalizedTargetPairs = Number(targetPairs || 0);
  if (!Number.isInteger(normalizedTargetPairs) || normalizedTargetPairs <= 0) {
    return { consumedPairs: 0, consumedCost: 0, sources: [] };
  }

  const pools = await findBetterGradeSourcePoolsTx({
    trx,
    branchId,
    deptId,
    targetSkuId,
  });
  if (!pools.length) return { consumedPairs: 0, consumedCost: 0, sources: [] };

  let remaining = normalizedTargetPairs;
  let consumedPairs = 0;
  let consumedCost = 0;
  const sources = [];

  for (const pool of pools) {
    if (remaining <= 0) break;
    // Reuse standard WIP allocator so balance/ledger behavior stays consistent.
    const allocated = await allocateFromWipPoolTx({
      trx,
      branchId,
      skuId: Number(pool.sku_id),
      deptId,
      targetPairs: remaining,
      voucherDate,
      sourceVoucherId,
    });
    const pairs = Number(allocated.consumedPairs || 0);
    if (pairs <= 0) continue;
    const cost = Number(allocated.consumedCost || 0);
    consumedPairs += pairs;
    consumedCost += cost;
    remaining -= pairs;
    sources.push({
      source_sku_id: Number(pool.sku_id),
      source_grade_rank: Number(pool.grade_rank || 0),
      consumed_pairs: Number(pairs),
      consumed_cost: Number(cost.toFixed(2)),
      source_sku_code: String(pool.sku_code || "").trim() || null,
    });
  }

  return {
    consumedPairs: Number(consumedPairs),
    consumedCost: Number(consumedCost.toFixed(2)),
    sources,
  };
};

const allocateFromWipPoolTx = async ({
  trx,
  branchId,
  skuId,
  deptId,
  targetPairs,
  voucherDate,
  sourceVoucherId,
}) => {
  const balance = await getCurrentWipBalanceTx({
    trx,
    branchId,
    skuId,
    deptId,
  });
  const availablePairs = Number(balance?.qty_pairs || 0);
  if (availablePairs <= 0) {
    return { consumedPairs: 0, consumedCost: 0 };
  }

  const requestedPairs = Number(targetPairs || 0);
  const consumedPairs = Math.max(0, Math.min(requestedPairs, availablePairs));
  if (!consumedPairs) return { consumedPairs: 0, consumedCost: 0 };

  const availableCost = Number(balance?.cost_value || 0);
  const unitCost =
    availablePairs > 0
      ? Number((availableCost / availablePairs).toFixed(6))
      : 0;
  const consumedCost = Number((unitCost * consumedPairs).toFixed(2));

  await adjustWipBalanceTx({
    trx,
    branchId,
    skuId,
    deptId,
    qtyDelta: -consumedPairs,
    costDelta: -consumedCost,
    activityDate: voucherDate,
  });
  await insertWipLedgerTx({
    trx,
    branchId,
    skuId,
    deptId,
    txnDate: voucherDate,
    direction: -1,
    qtyPairs: consumedPairs,
    costValue: consumedCost,
    sourceVoucherId,
  });

  return { consumedPairs, consumedCost };
};

const buildProductionShortfallTx = async ({
  trx,
  branchId,
  voucherDate,
  voucherId,
  skuId,
  totalPairs,
  bomProfile,
  stageId = null,
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  const stageRoutes = Array.isArray(bomProfile?.stageRoutes)
    ? bomProfile.stageRoutes
    : [];
  const stageDeptIds = normalizedStageId
    ? [
        ...new Set(
          stageRoutes
            .filter(
              (route) => Number(route.stage_id) === Number(normalizedStageId),
            )
            .map((route) => Number(route.dept_id || 0))
            .filter((deptId) => Number.isInteger(deptId) && deptId > 0),
        ),
      ]
    : [];

  const deptIds = new Set();
  if (stageDeptIds.length) {
    stageDeptIds.forEach((deptId) => deptIds.add(Number(deptId)));
  } else {
    (bomProfile?.rmLines || []).forEach((line) =>
      deptIds.add(Number(line.dept_id)),
    );
    (bomProfile?.labourLines || []).forEach((line) =>
      deptIds.add(Number(line.dept_id)),
    );
  }

  const result = [];
  for (const deptId of deptIds) {
    const allocated = await allocateFromWipPoolTx({
      trx,
      branchId,
      skuId,
      deptId,
      targetPairs: totalPairs,
      voucherDate,
      sourceVoucherId: voucherId,
    });
    const shortfallPairs = Math.max(
      0,
      Number(totalPairs || 0) - Number(allocated.consumedPairs || 0),
    );
    result.push({
      dept_id: Number(deptId),
      shortfall_pairs: Number(shortfallPairs),
      pool_consumed_pairs: Number(allocated.consumedPairs || 0),
      pool_consumed_cost: Number(allocated.consumedCost || 0),
    });
  }
  return result;
};

const buildConsumptionLinesFromShortfall = ({
  lineNoStart = 1,
  skuLine,
  shortfallPlan,
  bomProfile,
}) => {
  const lines = [];
  let lineNo = lineNoStart;
  const outputQty =
    Number(bomProfile?.outputQty || 1) > 0 ? Number(bomProfile.outputQty) : 1;
  const outputFactorToPair =
    Number(bomProfile?.outputUomFactorToPair || 1) > 0
      ? Number(bomProfile.outputUomFactorToPair)
      : 1;
  const outputQtyInPairs =
    Number((outputQty * outputFactorToPair).toFixed(6)) > 0
      ? Number((outputQty * outputFactorToPair).toFixed(6))
      : 1;

  for (const deptPlan of shortfallPlan) {
    const shortfallPairs = Number(deptPlan.shortfall_pairs || 0);
    if (shortfallPairs <= 0) continue;
    const ratio = Number((shortfallPairs / outputQtyInPairs).toFixed(6));
    const deptRmLines = (bomProfile?.rmLines || []).filter(
      (row) => Number(row.dept_id) === Number(deptPlan.dept_id),
    );
    for (const rm of deptRmLines) {
      const override =
        bomProfile?.skuOverrideByRmDept?.get(
          `${Number(rm.rm_item_id)}:${Number(rm.dept_id)}`,
        ) || null;
      if (override?.is_excluded === true) continue;
      const hasOverrideQty =
        Number.isFinite(Number(override?.override_qty)) &&
        Number(override?.override_qty) >= 0;
      const baseQty = hasOverrideQty
        ? Number(override.override_qty)
        : Number(rm.qty || 0);
      if (baseQty <= 0) continue;
      const lossFactor = 1 + Number(rm.normal_loss_pct || 0) / 100;
      const qty = Number((baseQty * ratio * lossFactor).toFixed(3));
      if (qty <= 0) continue;
      const replacementItemId = toPositiveInt(override?.replacement_rm_item_id);
      const finalItemId = replacementItemId || Number(rm.rm_item_id);
      const finalUomId =
        toPositiveInt(override?.override_uom_id) || toPositiveInt(rm.uom_id);
      const finalColorId =
        toPositiveInt(override?.rm_color_id) || toPositiveInt(rm.color_id);
      const finalSizeId =
        toPositiveInt(override?.rm_size_id) || toPositiveInt(rm.size_id);
      const overrideApplied = Boolean(
        override &&
        (override.is_excluded === true ||
          replacementItemId ||
          (hasOverrideQty &&
            Math.abs(Number(override.override_qty) - Number(rm.qty || 0)) >
              1e-9) ||
          finalColorId !== toPositiveInt(rm.color_id) ||
          finalSizeId !== toPositiveInt(rm.size_id)),
      );
      lines.push({
        line_no: lineNo,
        line_kind: "ITEM",
        item_id: Number(finalItemId),
        uom_id: finalUomId,
        qty,
        rate: 0,
        amount: 0,
        meta: {
          department_id: Number(deptPlan.dept_id),
          source_sku_id: Number(skuLine.sku_id),
          stage_id: toPositiveInt(skuLine.stage_id),
          shortfall_pairs: shortfallPairs,
          bom_output_qty: outputQty,
          bom_output_uom_factor_to_pair: outputFactorToPair,
          bom_output_qty_pairs: outputQtyInPairs,
          auto_generated: true,
          bom_id: Number(bomProfile.bomId),
          adjusted_qty_rule_applied:
            hasOverrideQty && Math.abs(baseQty - Number(rm.qty || 0)) > 1e-9,
          replacement_rule_applied: Boolean(replacementItemId),
          sku_override_applied: overrideApplied,
          rm_color_id: finalColorId,
          rm_size_id: finalSizeId,
        },
      });
      lineNo += 1;
    }
  }

  return lines;
};

const enrichConsumptionLinesWithRmRatesTx = async ({ trx, lines = [] }) => {
  const normalizedLines = Array.isArray(lines) ? lines : [];
  if (!normalizedLines.length) return normalizedLines;

  const rmItemIds = [
    ...new Set(
      normalizedLines
        .map((line) => toPositiveInt(line?.item_id))
        .filter(Boolean),
    ),
  ];
  if (!rmItemIds.length) return normalizedLines;

  const rows = await trx("erp.rm_purchase_rates as r")
    .select(
      "r.rm_item_id",
      "r.color_id",
      "r.size_id",
      "r.purchase_rate",
      "r.avg_purchase_rate",
    )
    .whereIn("r.rm_item_id", rmItemIds)
    .andWhere("r.is_active", true);

  const rateByIdentity = new Map();
  rows.forEach((row) => {
    const rmItemId = toPositiveInt(row?.rm_item_id);
    if (!rmItemId) return;
    const colorId = toPositiveInt(row?.color_id) || 0;
    const sizeId = toPositiveInt(row?.size_id) || 0;
    const avgRate = Number(row?.avg_purchase_rate || 0);
    const purchaseRate = Number(row?.purchase_rate || 0);
    const resolvedRate =
      Number.isFinite(avgRate) && avgRate > 0 ? avgRate : purchaseRate;
    if (!Number.isFinite(resolvedRate) || resolvedRate <= 0) return;
    rateByIdentity.set(
      `${rmItemId}:${colorId}:${sizeId}`,
      Number(resolvedRate.toFixed(4)),
    );
  });

  const resolveRate = ({ itemId, colorId, sizeId }) => {
    const normalizedItemId = toPositiveInt(itemId);
    if (!normalizedItemId) return 0;
    const normalizedColorId = toPositiveInt(colorId) || 0;
    const normalizedSizeId = toPositiveInt(sizeId) || 0;
    const keys = [
      `${normalizedItemId}:${normalizedColorId}:${normalizedSizeId}`,
      `${normalizedItemId}:${normalizedColorId}:0`,
      `${normalizedItemId}:0:${normalizedSizeId}`,
      `${normalizedItemId}:0:0`,
    ];
    for (const key of keys) {
      const value = Number(rateByIdentity.get(key) || 0);
      if (value > 0) return Number(value.toFixed(4));
    }
    return 0;
  };

  return normalizedLines.map((line) => {
    const qty = Number(line?.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        ...line,
        rate: 0,
        amount: 0,
      };
    }
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const resolvedRate = resolveRate({
      itemId: line?.item_id,
      colorId: meta.rm_color_id,
      sizeId: meta.rm_size_id,
    });
    const amount =
      resolvedRate > 0 ? Number((qty * resolvedRate).toFixed(2)) : 0;
    return {
      ...line,
      rate: Number(resolvedRate.toFixed(4)),
      amount,
      meta: {
        ...meta,
        rm_rate_applied: resolvedRate > 0,
      },
    };
  });
};

const buildLabourLinesFromShortfall = ({
  lineNoStart = 1,
  skuLine,
  shortfallPlan,
  bomProfile,
}) => {
  const lines = [];
  let lineNo = lineNoStart;

  for (const deptPlan of shortfallPlan) {
    const shortfallPairs = Number(deptPlan.shortfall_pairs || 0);
    if (shortfallPairs <= 0) continue;
    const deptLabourLines = (bomProfile?.labourLines || []).filter(
      (row) => Number(row.dept_id) === Number(deptPlan.dept_id),
    );
    for (const labour of deptLabourLines) {
      const rateValue = Number(labour.rate_value || 0);
      const ratePerPair =
        String(labour.rate_type || LABOUR_RATE_TYPE.perPair).toUpperCase() ===
        LABOUR_RATE_TYPE.perDozen
          ? Number((rateValue / PAIRS_PER_DOZEN).toFixed(4))
          : Number(rateValue.toFixed(4));
      const qtyPairs = Number(shortfallPairs);
      if (!Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;
      const amount = Number((qtyPairs * ratePerPair).toFixed(2));
      lines.push({
        line_no: lineNo,
        line_kind: "LABOUR",
        labour_id: Number(labour.labour_id),
        qty: Number(qtyPairs),
        rate: Number(ratePerPair),
        amount,
        meta: {
          department_id: Number(deptPlan.dept_id),
          source_sku_id: Number(skuLine.sku_id),
          stage_id: toPositiveInt(skuLine.stage_id),
          shortfall_pairs: shortfallPairs,
          auto_generated: true,
          bom_id: Number(bomProfile.bomId),
        },
        dept_id: Number(deptPlan.dept_id),
      });
      lineNo += 1;
    }
  }

  return lines;
};

const createAutoChildVoucherTx = async ({
  trx,
  branchId,
  voucherDate,
  createdBy,
  sourceVoucherId,
  voucherNoSource,
  voucherTypeCode,
  remarks,
  lines,
  allowNegativeRm = false,
}) => {
  const voucherNo = await getNextVoucherNoTx(trx, branchId, voucherTypeCode);
  const [header] = await trx("erp.voucher_header")
    .insert({
      voucher_type_code: voucherTypeCode,
      voucher_no: voucherNo,
      branch_id: branchId,
      voucher_date: voucherDate,
      status: "APPROVED",
      created_by: createdBy,
      approved_by: createdBy,
      approved_at: trx.fn.now(),
      remarks,
    })
    .returning(["id", "voucher_no"]);

  const voucherId = Number(header.id);
  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption) {
    await trx("erp.consumption_header").insert({
      voucher_id: voucherId,
      source_production_id: sourceVoucherId,
    });
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.labourProduction) {
    await trx("erp.labour_voucher_header").insert({
      voucher_id: voucherId,
      source_production_id: sourceVoucherId,
    });
  }

  if (Array.isArray(lines) && lines.length) {
    const inserted = await insertVoucherLinesTx({
      trx,
      voucherId,
      lines,
    });

    if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.labourProduction) {
      const deptByLineNo = new Map(
        lines.map((line) => [
          Number(line.line_no),
          toPositiveInt(line.dept_id || line?.meta?.department_id),
        ]),
      );
      const extRows = inserted
        .map((line) => {
          const deptId = deptByLineNo.get(Number(line.line_no));
          if (!deptId) return null;
          return {
            voucher_line_id: Number(line.id),
            dept_id: Number(deptId),
          };
        })
        .filter(Boolean);
      if (extRows.length) {
        await trx("erp.labour_voucher_line").insert(extRows);
      }
    }
  }

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption) {
    await applyConsumptionToStockTx({
      trx,
      voucherId,
      branchId,
      voucherDate,
      allowNegativeRm,
    });
  }

  await syncVoucherGlPostingTx({ trx, voucherId });

  return {
    voucherId,
    voucherNo: Number(header.voucher_no || 0) || null,
    sourceVoucherNo: voucherNoSource,
  };
};

const applyDcvToWipTx = async ({ trx, voucherId, branchId, voucherDate }) => {
  const header = await trx("erp.dcv_header")
    .select("dept_id", "stage_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!header) return;

  const deptId = Number(header.dept_id);
  const stageId =
    toPositiveInt(header.stage_id) ||
    (await resolveActiveStageForDepartmentTx({
      trx,
      departmentId: deptId,
      allowNull: true,
    }));
  const lines = await trx("erp.voucher_line")
    .select("id", "line_no", "sku_id", "qty", "amount", "meta")
    .where({ voucher_header_id: voucherId, line_kind: "SKU" });
  if (!lines.length) return;

  const normalizedLines = lines.map((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    return {
      line_no: Number(line.line_no || 0) || null,
      sku_id: toPositiveInt(line.sku_id),
      qty: Number(line.qty || 0),
      total_pairs: Number(meta.total_pairs || line.qty || 0),
    };
  });
  await validateDcvSfgAvailabilityTx({
    trx,
    req: { branchId: Number(branchId) },
    stageId,
    lines: normalizedLines,
  });
  await validateDcvStageFlowTx({
    trx,
    req: { branchId: Number(branchId) },
    stageId,
    departmentId: deptId,
    voucherDate,
    lines: normalizedLines,
  });

  const skuDisplayMap = await loadSkuDisplayMapTx({
    trx,
    skuIds: lines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
  });
  const skuMap = await loadSkuMapTx({
    trx,
    skuIds: lines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
    itemTypes: ["FG", "SFG"],
  });
  const bomProfileBySku = new Map();

  for (const line of lines) {
    const skuId = Number(line.sku_id || 0);
    const lineNo = Number(line.line_no || 0) || 0;
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const qtyPairs = Number(meta.total_pairs || line.qty || 0);
    if (!Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;

    let bomProfile = bomProfileBySku.get(skuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(
          skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` },
        );
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomProfileBySku.set(skuId, bomProfile);
    }

    const skuLabel = buildSkuDisplayLabel(
      skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` },
    );
    const stageFlow = resolveDcvStageTransitionForBomProfile({
      bomProfile,
      stageId,
      departmentId: deptId,
    });
    const stageSfgRequirements = buildSfgRequirementsForStage({
      bomProfile,
      stageId,
      producedPairs: qtyPairs,
      lineNo,
      skuLabel,
    });

    let previousStageCost = 0;
    let stageSfgConsumedCost = 0;
    let conversionMeta = null;
    if (stageFlow.hasStageRouting && stageFlow.previousRequiredDeptId) {
      // Step 1: consume direct predecessor WIP for this SKU.
      const allocatedDirect = await allocateFromWipPoolTx({
        trx,
        branchId,
        skuId,
        deptId: stageFlow.previousRequiredDeptId,
        targetPairs: qtyPairs,
        voucherDate,
        sourceVoucherId: voucherId,
      });
      let totalConsumedPairs = Number(allocatedDirect.consumedPairs || 0);
      let totalConsumedCost = Number(allocatedDirect.consumedCost || 0);
      if (totalConsumedPairs < qtyPairs) {
        const neededPairs = Math.max(0, qtyPairs - totalConsumedPairs);
        // Step 2: cover remaining predecessor shortage via better-grade conversion.
        const converted = await allocateFromBetterGradePoolTx({
          trx,
          branchId,
          deptId: stageFlow.previousRequiredDeptId,
          targetSkuId: skuId,
          targetPairs: neededPairs,
          voucherDate,
          sourceVoucherId: voucherId,
        });
        totalConsumedPairs += Number(converted.consumedPairs || 0);
        totalConsumedCost += Number(converted.consumedCost || 0);
        if (Array.isArray(converted.sources) && converted.sources.length) {
          // Keep explicit audit metadata to trace conversion origin by source SKU/grade.
          conversionMeta = {
            conversion_applied: true,
            conversion_mode: "IN_STAGE_GRADE_CONVERSION",
            conversion_from_stage_id: toPositiveInt(
              stageFlow.previousRequiredStageId,
            ),
            conversion_from_dept_id: toPositiveInt(
              stageFlow.previousRequiredDeptId,
            ),
            conversion_sources: converted.sources,
          };
        }
      }
      if (totalConsumedPairs < qtyPairs) {
        throw new HttpError(
          400,
          `Line ${lineNo}: stage flow blocked for SKU ${skuLabel}; previous stage WIP is insufficient`,
        );
      }
      previousStageCost = Number(totalConsumedCost || 0);
    }

    // Consume stage-linked SFG stock for this FG/SFG output line and fold the
    // consumed value into current-stage WIP cost.
    for (const reqRow of stageSfgRequirements) {
      const sfgSkuId = toPositiveInt(reqRow?.sfg_sku_id);
      const requiredPairs = Number(reqRow?.required_pairs || 0);
      if (!sfgSkuId || !Number.isInteger(requiredPairs) || requiredPairs <= 0)
        continue;
      const consumedValue = await applySkuStockOutTx({
        trx,
        branchId,
        skuId: sfgSkuId,
        category: "SFG",
        qtyPairsOut: requiredPairs,
        voucherId,
        voucherLineId: toPositiveInt(line.id),
        voucherDate,
        writeLedger: true,
      });
      stageSfgConsumedCost = Number(
        (stageSfgConsumedCost + Number(consumedValue || 0)).toFixed(2),
      );
    }

    const ownStageCost = Number(Number(line.amount || 0).toFixed(2));
    const costValue = Number(
      (previousStageCost + stageSfgConsumedCost + ownStageCost).toFixed(2),
    );
    await adjustWipBalanceTx({
      trx,
      branchId,
      skuId,
      deptId,
      qtyDelta: qtyPairs,
      costDelta: costValue,
      activityDate: voucherDate,
    });
    await insertWipLedgerTx({
      trx,
      branchId,
      skuId,
      deptId,
      txnDate: voucherDate,
      direction: 1,
      qtyPairs,
      costValue,
      sourceVoucherId: voucherId,
    });

    const currentRoute = stageFlow.currentRoute || null;
    const finalRequiredRoute = stageFlow.finalRequiredRoute || null;
    const isFinalRequiredStage = Boolean(
      stageFlow.hasStageRouting &&
      currentRoute &&
      finalRequiredRoute &&
      Number(currentRoute.stage_id) === Number(finalRequiredRoute.stage_id),
    );
    if (isFinalRequiredStage) {
      const sku = skuMap.get(Number(skuId));
      const skuItemType = String(sku?.item_type || "")
        .trim()
        .toUpperCase();
      const stockCategory =
        skuItemType === "FG" ? "FG" : skuItemType === "SFG" ? "SFG" : null;
      if (stockCategory) {
        const currentBalance = await getCurrentWipBalanceTx({
          trx,
          branchId,
          skuId,
          deptId,
        });
        const availablePairs = Number(currentBalance?.qty_pairs || 0);
        const availableCost = Number(currentBalance?.cost_value || 0);
        if (availablePairs < qtyPairs) {
          throw new HttpError(
            400,
            `Final-stage stock posting failed for SKU ${skuLabel}: WIP balance is insufficient`,
          );
        }
        const unitCost =
          availablePairs > 0
            ? Number((availableCost / availablePairs).toFixed(6))
            : 0;
        const transferCost = Number((unitCost * qtyPairs).toFixed(2));

        await adjustWipBalanceTx({
          trx,
          branchId,
          skuId,
          deptId,
          qtyDelta: -qtyPairs,
          costDelta: -transferCost,
          activityDate: voucherDate,
        });
        await insertWipLedgerTx({
          trx,
          branchId,
          skuId,
          deptId,
          txnDate: voucherDate,
          direction: -1,
          qtyPairs,
          costValue: transferCost,
          sourceVoucherId: voucherId,
        });
        await applySkuStockInTx({
          trx,
          branchId,
          skuId,
          category: stockCategory,
          qtyPairsIn: qtyPairs,
          valueIn: transferCost,
          voucherId,
          voucherLineId: toPositiveInt(line.id),
          voucherDate,
          writeLedger: true,
        });
      }
    }

    if (conversionMeta && toPositiveInt(line.id)) {
      const currentMeta =
        line?.meta && typeof line.meta === "object" ? line.meta : {};
      await trx("erp.voucher_line")
        .where({ id: Number(line.id) })
        .update({
          meta: {
            ...currentMeta,
            ...conversionMeta,
          },
        });
    }
  }
};

const applyDcvToGeneratedVouchersTx = async ({
  trx,
  voucherId,
  branchId,
  voucherDate,
  createdBy,
  voucherNo,
  allowNegativeRm = false,
}) => {
  const header = await trx("erp.dcv_header")
    .select("dept_id", "stage_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!header) return;

  const deptId = toPositiveInt(header.dept_id);
  const stageId =
    toPositiveInt(header.stage_id) ||
    (await resolveActiveStageForDepartmentTx({
      trx,
      departmentId: deptId,
      allowNull: true,
    }));
  if (!deptId) return;

  const lines = await trx("erp.voucher_line")
    .select("line_no", "sku_id", "qty", "meta")
    .where({ voucher_header_id: voucherId, line_kind: "SKU" })
    .orderBy("line_no", "asc");
  if (!lines.length) return;

  const skuDisplayMap = await loadSkuDisplayMapTx({
    trx,
    skuIds: lines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
  });
  const bomBySku = new Map();
  const consumptionLines = [];
  const sfgPairsBySku = new Map();
  let consumptionLineNo = 1;

  for (const line of lines) {
    const skuId = toPositiveInt(line.sku_id);
    const lineMeta =
      line?.meta && typeof line.meta === "object" ? line.meta : {};
    const qtyPairs = Number(lineMeta.total_pairs || line.qty || 0);
    if (!skuId || !Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;

    let bomProfile = bomBySku.get(skuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(
          skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` },
        );
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomBySku.set(skuId, bomProfile);
    }

    resolveDcvStageTransitionForBomProfile({
      bomProfile,
      stageId,
      departmentId: deptId,
    });

    const skuLine = {
      line_no: Number(line.line_no || 0),
      sku_id: Number(skuId),
      stage_id: stageId,
      unit:
        String(lineMeta.unit || "")
          .trim()
          .toUpperCase() || null,
      status:
        String(lineMeta.status || "")
          .trim()
          .toUpperCase() || null,
      total_pairs: Number(qtyPairs),
    };
    const shortfallPlan = [
      {
        dept_id: Number(deptId),
        shortfall_pairs: Number(qtyPairs),
      },
    ];

    const nextConsumptionLines = buildConsumptionLinesFromShortfall({
      lineNoStart: consumptionLineNo,
      skuLine,
      shortfallPlan,
      bomProfile,
    });
    consumptionLines.push(...nextConsumptionLines);
    consumptionLineNo += nextConsumptionLines.length;

    const fgSkuLabel = buildSkuDisplayLabel(
      skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` },
    );
    const stageSfgRequirements = buildSfgRequirementsForStage({
      bomProfile,
      stageId,
      producedPairs: qtyPairs,
      lineNo: Number(line.line_no || 0) || null,
      skuLabel: fgSkuLabel,
    });
    stageSfgRequirements.forEach((reqRow) => {
      const nextPairs =
        Number(sfgPairsBySku.get(reqRow.sfg_sku_id) || 0) +
        Number(reqRow.required_pairs || 0);
      sfgPairsBySku.set(Number(reqRow.sfg_sku_id), Number(nextPairs));
    });
  }

  if (sfgPairsBySku.size) {
    const sfgSkuIds = [...sfgPairsBySku.keys()];
    const sfgSkuMap = await loadSkuMapTx({
      trx,
      skuIds: sfgSkuIds,
      itemTypes: ["SFG"],
    });
    if (sfgSkuMap.size !== sfgSkuIds.length) {
      throw new HttpError(
        400,
        "One or more SFG SKUs from BOM stage requirements are invalid",
      );
    }

    for (const sfgSkuId of sfgSkuIds) {
      const qtyPairs = Number(sfgPairsBySku.get(sfgSkuId) || 0);
      if (!Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;
      const sfgSku = sfgSkuMap.get(Number(sfgSkuId));
      consumptionLines.push({
        line_no: consumptionLineNo,
        line_kind: "SKU",
        sku_id: Number(sfgSkuId),
        uom_id: toPositiveInt(sfgSku?.base_uom_id),
        qty: Number(qtyPairs),
        rate: 0,
        amount: 0,
        meta: {
          department_id: Number(deptId),
          stage_id: toPositiveInt(stageId),
          auto_generated: true,
          source: "DCV_SFG_CONSUMPTION",
        },
      });
      consumptionLineNo += 1;
    }
  }

  const consumptionLinesWithRates = await enrichConsumptionLinesWithRmRatesTx({
    trx,
    lines: consumptionLines,
  });

  const consumptionVoucher = consumptionLinesWithRates.length
    ? await createAutoChildVoucherTx({
        trx,
        branchId,
        voucherDate,
        createdBy,
        sourceVoucherId: voucherId,
        voucherNoSource: voucherNo,
        voucherTypeCode: PRODUCTION_VOUCHER_TYPES.consumption,
        remarks: `[AUTO] Consumption from DCV #${voucherNo}`,
        lines: consumptionLinesWithRates,
        allowNegativeRm,
      })
    : null;

  if (!consumptionVoucher?.voucherId) return;

  await trx("erp.production_generated_links")
    .insert({
      production_voucher_id: voucherId,
      consumption_voucher_id: consumptionVoucher?.voucherId || null,
    })
    .onConflict("production_voucher_id")
    .merge(["consumption_voucher_id"]);
};

const applyLossToWipTx = async ({ trx, voucherId, branchId, voucherDate }) => {
  const rows = await trx("erp.abnormal_loss_line as alln")
    .join("erp.voucher_line as vl", "vl.id", "alln.voucher_line_id")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as si", "si.id", "v.item_id")
    .select(
      "alln.loss_type",
      "alln.dept_id",
      "vl.id as voucher_line_id",
      "vl.item_id",
      "vl.sku_id",
      "vl.qty",
      "vl.meta",
      "si.item_type as sku_item_type",
    )
    .where("vl.voucher_header_id", voucherId);

  if (!rows.length) return;

  const hasRmLoss = rows.some(
    (row) =>
      String(row?.loss_type || "")
        .trim()
        .toUpperCase() === "RM_LOSS",
  );
  const hasSkuLoss = rows.some((row) => {
    const lossType = String(row?.loss_type || "")
      .trim()
      .toUpperCase();
    return lossType === "SFG_LOSS" || lossType === "FG_LOSS";
  });
  if (hasRmLoss || hasSkuLoss) {
    await ensureLossStockInfraTx(trx, {
      requireRm: hasRmLoss,
      requireSku: hasSkuLoss,
    });
  }

  for (const row of rows) {
    const lossType = String(row?.loss_type || "")
      .trim()
      .toUpperCase();
    const voucherLineId = toPositiveInt(row?.voucher_line_id);
    const qty = Number(row?.qty || 0);
    if (!(qty > 0)) continue;

    if (lossType === "RM_LOSS") {
      const itemId = toPositiveInt(row?.item_id);
      const colorId = toPositiveInt(row?.meta?.rm_color_id);
      const sizeId = toPositiveInt(row?.meta?.rm_size_id);
      if (!itemId) {
        throw new HttpError(400, "RM loss line has invalid item reference");
      }
      await applyRmStockOutTx({
        trx,
        branchId,
        itemId,
        colorId,
        sizeId,
        operationLabel: "RM loss posting",
        qtyOut: qty,
        voucherId,
        voucherLineId,
        voucherDate,
        writeLedger: true,
      });
      continue;
    }

    if (lossType === "SFG_LOSS" || lossType === "FG_LOSS") {
      const skuId = toPositiveInt(row?.sku_id);
      if (!skuId) {
        throw new HttpError(400, `${lossType} line has invalid SKU reference`);
      }
      if (!Number.isInteger(qty)) {
        throw new HttpError(400, `${lossType} quantity must be whole pairs`);
      }
      const skuItemType = String(row?.sku_item_type || "")
        .trim()
        .toUpperCase();
      if (lossType === "SFG_LOSS" && skuItemType && skuItemType !== "SFG") {
        throw new HttpError(400, `SFG loss line has non-SFG SKU ${skuId}`);
      }
      if (lossType === "FG_LOSS" && skuItemType && skuItemType !== "FG") {
        throw new HttpError(400, `FG loss line has non-FG SKU ${skuId}`);
      }
      await applySkuStockOutTx({
        trx,
        branchId,
        skuId,
        category: lossType === "SFG_LOSS" ? "SFG" : "FG",
        qtyPairsOut: qty,
        voucherId,
        voucherLineId,
        voucherDate,
        writeLedger: true,
      });
      continue;
    }

    if (lossType !== "DVC_ABANDON") continue;

    const deptId = toPositiveInt(row.dept_id);
    const skuId = toPositiveInt(row.sku_id);
    const qtyPairs = Number(qty || 0);
    if (!deptId || !skuId || !Number.isInteger(qtyPairs) || qtyPairs <= 0)
      continue;

    const balance = await getCurrentWipBalanceTx({
      trx,
      branchId,
      skuId,
      deptId,
    });
    const availablePairs = Number(balance?.qty_pairs || 0);
    const availableCost = Number(balance?.cost_value || 0);
    if (availablePairs < qtyPairs) {
      throw new HttpError(
        400,
        `DVC abandon quantity exceeds pending WIP balance for SKU ${skuId}`,
      );
    }

    const unitCost =
      availablePairs > 0
        ? Number((availableCost / availablePairs).toFixed(6))
        : 0;
    const costToClear = Number((unitCost * qtyPairs).toFixed(2));
    await adjustWipBalanceTx({
      trx,
      branchId,
      skuId,
      deptId,
      qtyDelta: -qtyPairs,
      costDelta: -costToClear,
      activityDate: voucherDate,
    });
    await insertWipLedgerTx({
      trx,
      branchId,
      skuId,
      deptId,
      txnDate: voucherDate,
      direction: -1,
      qtyPairs,
      costValue: costToClear,
      sourceVoucherId: voucherId,
    });
  }
};

const applyConsumptionToStockTx = async ({
  trx,
  voucherId,
  branchId,
  voucherDate,
  allowNegativeRm = false,
}) => {
  const sourceHeader = await trx("erp.consumption_header as ch")
    .leftJoin("erp.voucher_header as src", "src.id", "ch.source_production_id")
    .select("src.voucher_type_code", "src.voucher_no")
    .where({ "ch.voucher_id": voucherId })
    .first();
  const sourceVoucherTypeCode = String(sourceHeader?.voucher_type_code || "")
    .trim()
    .toUpperCase();
  const sourceVoucherNo = Number(sourceHeader?.voucher_no || 0) || null;
  const operationLabel =
    sourceVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion
      ? `Auto-consumption from DCV${sourceVoucherNo ? ` #${sourceVoucherNo}` : ""}`
      : sourceVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction
        ? `Auto-consumption from FG production${sourceVoucherNo ? ` #${sourceVoucherNo}` : ""}`
        : sourceVoucherTypeCode ===
            PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
          ? `Auto-consumption from SFG production${sourceVoucherNo ? ` #${sourceVoucherNo}` : ""}`
          : "Consumption posting";

  const rows = await trx("erp.voucher_line as vl")
    .select("vl.id as voucher_line_id", "vl.item_id", "vl.qty", "vl.meta")
    .where({ "vl.voucher_header_id": voucherId, "vl.line_kind": "ITEM" })
    .orderBy("vl.line_no", "asc");
  if (!rows.length) return;

  await ensureLossStockInfraTx(trx, {
    requireRm: true,
    requireSku: false,
  });

  for (const row of rows) {
    const voucherLineId = toPositiveInt(row?.voucher_line_id);
    const itemId = toPositiveInt(row?.item_id);
    const qty = Number(row?.qty || 0);
    if (!(qty > 0)) continue;
    if (!itemId) {
      throw new HttpError(
        400,
        "Consumption line has invalid raw material reference",
      );
    }

    const colorId =
      toPositiveInt(row?.meta?.rm_color_id) ||
      toPositiveInt(row?.meta?.color_id);
    const sizeId =
      toPositiveInt(row?.meta?.rm_size_id) || toPositiveInt(row?.meta?.size_id);
    await applyRmStockOutTx({
      trx,
      branchId,
      itemId,
      colorId,
      sizeId,
      operationLabel,
      qtyOut: qty,
      voucherId,
      voucherLineId,
      voucherDate,
      writeLedger: true,
      allowNegativeStock: allowNegativeRm === true,
    });
  }
};

const applyProductionToGeneratedVouchersTx = async ({
  trx,
  voucherId,
  branchId,
  voucherDate,
  createdBy,
  voucherNo,
  allowNegativeRm = false,
}) => {
  const supportsProductionStage = await hasProductionLineStageColumnTx(trx);
  const productionLines = await trx("erp.voucher_line as vl")
    .join("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .select(
      "vl.id as voucher_line_id",
      "vl.line_no",
      "vl.sku_id",
      "vl.qty",
      "vl.amount",
      "pl.total_pairs",
      ...(supportsProductionStage ? ["pl.stage_id"] : []),
    )
    .where("vl.voucher_header_id", voucherId)
    .orderBy("vl.line_no", "asc");

  if (!productionLines.length) return;

  const bomBySku = new Map();
  const skuDisplayMap = await loadSkuDisplayMapTx({
    trx,
    skuIds: productionLines
      .map((line) => toPositiveInt(line?.sku_id))
      .filter(Boolean),
  });
  const skuMap = await loadSkuMapTx({
    trx,
    skuIds: productionLines
      .map((line) => toPositiveInt(line?.sku_id))
      .filter(Boolean),
    itemTypes: ["FG", "SFG"],
  });
  const consumptionLines = [];
  let consumptionLineNo = 1;

  for (const line of productionLines) {
    const skuId = Number(line.sku_id || 0);
    const totalPairs = Number(line.total_pairs || 0);
    const stageId = toPositiveInt(line.stage_id);
    if (!skuId || !Number.isInteger(totalPairs) || totalPairs <= 0) continue;

    let bomProfile = bomBySku.get(skuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(
          skuDisplayMap.get(skuId) || { sku_id: skuId },
        );
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomBySku.set(skuId, bomProfile);
    }

    const hasStageRouting =
      Array.isArray(bomProfile.stageRoutes) &&
      bomProfile.stageRoutes.length > 0;
    if (hasStageRouting && !stageId) {
      const skuLabel = buildSkuDisplayLabel(
        skuDisplayMap.get(skuId) || { sku_id: skuId },
      );
      throw new HttpError(400, `Stage is required for SKU ${skuLabel}`);
    }
    if (hasStageRouting && stageId) {
      const mappedRoutes = bomProfile.stageRoutes.filter(
        (route) => Number(route.stage_id) === Number(stageId),
      );
      const isStageMapped = mappedRoutes.length > 0;
      if (!isStageMapped) {
        const skuLabel = buildSkuDisplayLabel(
          skuDisplayMap.get(skuId) || { sku_id: skuId },
        );
        throw new HttpError(
          400,
          `Selected stage is not mapped in approved BOM for SKU ${skuLabel}`,
        );
      }
      const hasMappedDept = mappedRoutes.some((route) =>
        toPositiveInt(route.dept_id),
      );
      if (!hasMappedDept) {
        const skuLabel = buildSkuDisplayLabel(
          skuDisplayMap.get(skuId) || { sku_id: skuId },
        );
        throw new HttpError(
          400,
          `Selected stage has no production department mapped in approved BOM for SKU ${skuLabel}`,
        );
      }
    }

    const currentRoute = hasStageRouting
      ? (bomProfile.stageRoutes || []).find(
          (route) => Number(route.stage_id) === Number(stageId),
        )
      : null;
    const finalRequiredRoute = hasStageRouting
      ? [...(bomProfile.stageRoutes || [])]
          .filter((route) => route.is_required !== false)
          .sort(
            (a, b) => Number(b.sequence_no || 0) - Number(a.sequence_no || 0),
          )[0] || null
      : null;
    const isFinalRequiredStage =
      !hasStageRouting ||
      (currentRoute &&
        finalRequiredRoute &&
        Number(currentRoute.stage_id) === Number(finalRequiredRoute.stage_id));
    const sku = skuMap.get(Number(skuId));
    const skuItemType = String(sku?.item_type || "")
      .trim()
      .toUpperCase();
    if (skuItemType === "FG" && isFinalRequiredStage) {
      await applySkuStockInTx({
        trx,
        branchId,
        skuId,
        category: "FG",
        qtyPairsIn: totalPairs,
        valueIn: Number(line.amount || 0),
        voucherId,
        voucherLineId: toPositiveInt(line.voucher_line_id),
        voucherDate,
        writeLedger: true,
      });
    }

    const shortfallPlan = await buildProductionShortfallTx({
      trx,
      branchId,
      voucherDate,
      voucherId,
      skuId,
      totalPairs,
      bomProfile,
      stageId,
    });

    const nextConsumptionLines = buildConsumptionLinesFromShortfall({
      lineNoStart: consumptionLineNo,
      skuLine: line,
      shortfallPlan,
      bomProfile,
    });
    consumptionLines.push(...nextConsumptionLines);
    consumptionLineNo += nextConsumptionLines.length;
  }

  const consumptionLinesWithRates = await enrichConsumptionLinesWithRmRatesTx({
    trx,
    lines: consumptionLines,
  });

  const consumptionVoucher = await createAutoChildVoucherTx({
    trx,
    branchId,
    voucherDate,
    createdBy,
    sourceVoucherId: voucherId,
    voucherNoSource: voucherNo,
    voucherTypeCode: PRODUCTION_VOUCHER_TYPES.consumption,
    remarks: `[AUTO] Consumption from production #${voucherNo}`,
    lines: consumptionLinesWithRates,
    allowNegativeRm,
  });

  await trx("erp.production_generated_links")
    .insert({
      production_voucher_id: voucherId,
      consumption_voucher_id: consumptionVoucher?.voucherId || null,
    })
    .onConflict("production_voucher_id")
    .merge(["consumption_voucher_id"]);
};

const ensureProductionVoucherDerivedDataTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  actorUserId = null,
  allowNegativeRm = false,
}) => {
  // Admin confirm/approval paths propagate allowNegativeRm=true to keep production posting operational.
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);

  const header = await trx("erp.voucher_header")
    .select(
      "id",
      "voucher_no",
      "branch_id",
      "voucher_date",
      "status",
      "created_by",
    )
    .where({ id: normalizedVoucherId })
    .first();
  if (!header) return;
  if (String(header.status || "").toUpperCase() !== "APPROVED") return;

  if (
    normalizedVoucherTypeCode !== PRODUCTION_VOUCHER_TYPES.finishedProduction &&
    normalizedVoucherTypeCode !==
      PRODUCTION_VOUCHER_TYPES.semiFinishedProduction &&
    normalizedVoucherTypeCode !==
      PRODUCTION_VOUCHER_TYPES.departmentCompletion &&
    normalizedVoucherTypeCode !== PRODUCTION_VOUCHER_TYPES.abnormalLoss &&
    normalizedVoucherTypeCode !== PRODUCTION_VOUCHER_TYPES.consumption
  ) {
    return;
  }

  await rollbackWipLedgerBySourceVoucherTx({
    trx,
    voucherId: normalizedVoucherId,
  });
  if (
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss ||
    normalizedVoucherTypeCode ===
      PRODUCTION_VOUCHER_TYPES.departmentCompletion ||
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption
  ) {
    await rollbackStockLedgerBySourceVoucherTx({
      trx,
      voucherId: normalizedVoucherId,
    });
  }

  if (
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    normalizedVoucherTypeCode ===
      PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
  ) {
    await deleteGeneratedChildVouchersTx({
      trx,
      productionVoucherId: normalizedVoucherId,
    });
    await applyProductionToGeneratedVouchersTx({
      trx,
      voucherId: normalizedVoucherId,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
      createdBy: toPositiveInt(actorUserId) || Number(header.created_by),
      voucherNo: Number(header.voucher_no || 0),
      allowNegativeRm,
    });
    return;
  }

  if (
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion
  ) {
    await deleteGeneratedChildVouchersTx({
      trx,
      productionVoucherId: normalizedVoucherId,
    });
    await applyDcvToWipTx({
      trx,
      voucherId: normalizedVoucherId,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
    });
    await applyDcvToGeneratedVouchersTx({
      trx,
      voucherId: normalizedVoucherId,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
      createdBy: toPositiveInt(actorUserId) || Number(header.created_by),
      voucherNo: Number(header.voucher_no || 0),
      allowNegativeRm,
    });
    return;
  }

  if (normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss) {
    await applyLossToWipTx({
      trx,
      voucherId: normalizedVoucherId,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
    });
    return;
  }

  if (normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption) {
    await applyConsumptionToStockTx({
      trx,
      voucherId: normalizedVoucherId,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
      allowNegativeRm,
    });
  }
};

const saveProductionVoucherCoreTx = async ({
  trx,
  req,
  voucherTypeCode,
  scopeKey,
  payload,
  mode,
  voucherId = null,
}) => {
  assertEditableVoucherType(voucherTypeCode);
  const isCreate = mode === "create";

  const canCreate = canDo(req, "VOUCHER", scopeKey, "create");
  const canEdit = canDo(req, "VOUCHER", scopeKey, "edit");
  const canApprove = canApproveVoucherAction(req, scopeKey);
  const action = isCreate ? "create" : "edit";
  const policyRequiresApproval = await requiresApprovalForAction(
    trx,
    voucherTypeCode,
    action,
  );
  let headerId = toPositiveInt(voucherId);

  const validated = await normalizeAndValidatePayloadTx({
    trx,
    req,
    voucherTypeCode,
    voucherId: isCreate ? null : headerId,
    payload,
  });

  let voucherNo = null;
  let status = "APPROVED";

  const queuedForApproval = isCreate
    ? !canCreate || (policyRequiresApproval && !canApprove)
    : !canEdit || (policyRequiresApproval && !canApprove);

  if (isCreate) {
    voucherNo = await getNextVoucherNoTx(trx, req.branchId, voucherTypeCode);
    const [header] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: voucherTypeCode,
        voucher_no: voucherNo,
        branch_id: req.branchId,
        voucher_date: validated.voucherDate,
        book_no: validated.referenceNo,
        status: queuedForApproval ? "PENDING" : "APPROVED",
        created_by: req.user.id,
        approved_by: queuedForApproval ? null : req.user.id,
        approved_at: queuedForApproval ? null : trx.fn.now(),
        remarks: validated.remarks,
      })
      .returning(["id", "voucher_no", "status"]);

    headerId = Number(header.id);
    voucherNo = Number(header.voucher_no);
    status = String(header.status || "PENDING").toUpperCase();
  } else {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_no", "status")
      .where({
        id: headerId,
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      })
      .first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (String(existing.status || "").toUpperCase() === "REJECTED") {
      throw new HttpError(400, "Deleted voucher cannot be edited");
    }
    voucherNo = Number(existing.voucher_no);
    status = queuedForApproval
      ? String(existing.status || "PENDING").toUpperCase()
      : "APPROVED";
  }

  const approvalPayload = {
    action: isCreate ? "create" : "update",
    voucher_id: headerId,
    voucher_no: voucherNo,
    voucher_type_code: voucherTypeCode,
    voucher_date: validated.voucherDate,
    reference_no: validated.referenceNo,
    remarks: validated.remarks,
    dept_id: validated.deptId,
    labour_id: validated.labourId,
    plan_kind: validated.planKind,
    reason_code_id: validated.reasonCodeId,
    lines: validated.lines,
    permission_reroute: isCreate ? !canCreate : !canEdit,
  };
  const quantityTotals = computeLineQuantityTotals(validated.lines);
  // Admins can confirm immediately even if RM goes negative; non-admin shortage is rerouted to approval.
  const allowNegativeRmOnConfirm = req?.user?.isAdmin === true;

  if (queuedForApproval) {
    if (!isCreate) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        entityId: headerId,
        voucherTypeCode,
        summary: `UPDATE ${voucherTypeCode} #${voucherNo}`,
        oldValue: { status },
        newValue: approvalPayload,
      });
      return {
        id: headerId,
        voucherNo,
        status,
        queuedForApproval: true,
        approvalRequestId,
        permissionReroute: !canEdit,
        quantityTotals,
      };
    }

    const insertedLines = await insertVoucherLinesTx({
      trx,
      voucherId: headerId,
      lines: validated.lines,
    });
    await upsertVoucherExtensionsTx({
      trx,
      voucherId: headerId,
      voucherTypeCode,
      validated,
      insertedLines,
    });

    const approvalRequestId = await createApprovalRequestTx({
      trx,
      req,
      entityId: headerId,
      voucherTypeCode,
      summary: `${voucherTypeCode} #${voucherNo}`,
      newValue: approvalPayload,
    });

    return {
      id: headerId,
      voucherNo,
      status: "PENDING",
      queuedForApproval: true,
      approvalRequestId,
      permissionReroute: !canCreate,
      quantityTotals,
    };
  }

  await trx("erp.voucher_header").where({ id: headerId }).update({
    voucher_date: validated.voucherDate,
    book_no: validated.referenceNo,
    remarks: validated.remarks,
    status: "APPROVED",
    approved_by: req.user.id,
    approved_at: trx.fn.now(),
  });

  await trx("erp.voucher_line").where({ voucher_header_id: headerId }).del();
  const insertedLines = await insertVoucherLinesTx({
    trx,
    voucherId: headerId,
    lines: validated.lines,
  });

  await upsertVoucherExtensionsTx({
    trx,
    voucherId: headerId,
    voucherTypeCode,
    validated,
    insertedLines,
  });

  try {
    // Keep derived voucher posting and GL sync atomic to avoid partial accounting state.
    await trx.transaction(async (postingTrx) => {
      await ensureProductionVoucherDerivedDataTx({
        trx: postingTrx,
        voucherId: headerId,
        voucherTypeCode,
        actorUserId: req.user.id,
        allowNegativeRm: allowNegativeRmOnConfirm,
      });

      await syncVoucherGlPostingTx({ trx: postingTrx, voucherId: headerId });
    });
  } catch (err) {
    if (isCreate && !allowNegativeRmOnConfirm && isRmStockShortageError(err)) {
      // Non-admin create shortage path: leave voucher pending and queue a review request with shortage details.
      await trx("erp.voucher_header").where({ id: headerId }).update({
        status: "PENDING",
        approved_by: null,
        approved_at: null,
      });

      const approvalRequestPayload = {
        ...approvalPayload,
        approval_reason: String(err.message || "").trim(),
        allow_negative_rm_on_approval: true,
      };

      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        entityId: headerId,
        voucherTypeCode,
        summary: `${voucherTypeCode} #${voucherNo}`,
        newValue: approvalRequestPayload,
      });

      return {
        id: headerId,
        voucherNo,
        status: "PENDING",
        queuedForApproval: true,
        approvalRequestId,
        permissionReroute: false,
        shortageApprovalReroute: true,
        approvalReason: String(err.message || "").trim(),
        quantityTotals,
      };
    }
    throw err;
  }

  return {
    id: headerId,
    voucherNo,
    status: "APPROVED",
    queuedForApproval: false,
    approvalRequestId: null,
    permissionReroute: false,
    shortageApprovalReroute: false,
    approvalReason: null,
    quantityTotals,
  };
};

const createProductionVoucher = async ({
  req,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const result = await knex.transaction((trx) =>
    saveProductionVoucherCoreTx({
      trx,
      req,
      voucherTypeCode,
      scopeKey,
      payload,
      mode: "create",
    }),
  );

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "CREATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      queued_for_approval: result.queuedForApproval === true,
    },
  });

  return result;
};

const updateProductionVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const result = await knex.transaction((trx) =>
    saveProductionVoucherCoreTx({
      trx,
      req,
      voucherTypeCode,
      scopeKey,
      payload,
      mode: "update",
      voucherId: normalizedVoucherId,
    }),
  );

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "UPDATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      queued_for_approval: result.queuedForApproval === true,
    },
  });

  return {
    ...result,
    updated: result.queuedForApproval !== true,
  };
};

const applyProductionVoucherDeletePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  approverId,
}) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const existing = await trx("erp.voucher_header")
    .select("id", "status")
    .where({ id: normalizedVoucherId, voucher_type_code: voucherTypeCode })
    .first();
  if (!existing) throw new HttpError(404, "Voucher not found");
  if (String(existing.status || "").toUpperCase() === "REJECTED") return;

  if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion
  ) {
    await deleteGeneratedChildVouchersTx({
      trx,
      productionVoucherId: normalizedVoucherId,
    });
  }

  if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss
  ) {
    await rollbackWipLedgerBySourceVoucherTx({
      trx,
      voucherId: normalizedVoucherId,
    });
  }
  if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption
  ) {
    await rollbackStockLedgerBySourceVoucherTx({
      trx,
      voucherId: normalizedVoucherId,
    });
  }

  await trx("erp.voucher_header").where({ id: normalizedVoucherId }).update({
    status: "REJECTED",
    approved_by: approverId,
    approved_at: trx.fn.now(),
  });
  await syncVoucherGlPostingTx({ trx, voucherId: normalizedVoucherId });
};

const deleteProductionVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  if (!EDITABLE_VOUCHER_TYPES.has(voucherTypeCode)) {
    throw new HttpError(400, "This voucher cannot be deleted manually");
  }

  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const canDelete = canDo(req, "VOUCHER", scopeKey, "hard_delete");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_no", "status")
      .where({
        id: normalizedVoucherId,
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      })
      .first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (String(existing.status || "").toUpperCase() === "REJECTED") {
      throw new HttpError(400, "Voucher already deleted");
    }

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "delete",
    );
    const queuedForApproval =
      !canDelete || (policyRequiresApproval && !canApprove);

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        entityId: existing.id,
        voucherTypeCode,
        summary: `DELETE ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: { status: existing.status },
        newValue: {
          action: "delete",
          voucher_id: existing.id,
          voucher_no: existing.voucher_no,
          voucher_type_code: voucherTypeCode,
          permission_reroute: !canDelete,
        },
      });
      return {
        id: existing.id,
        voucherNo: Number(existing.voucher_no),
        status: existing.status,
        queuedForApproval: true,
        approvalRequestId,
        permissionReroute: !canDelete,
      };
    }

    await applyProductionVoucherDeletePayloadTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode,
      approverId: req.user.id,
    });
    return {
      id: existing.id,
      voucherNo: Number(existing.voucher_no),
      status: "REJECTED",
      queuedForApproval: false,
      approvalRequestId: null,
      permissionReroute: false,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "DELETE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      queued_for_approval: result.queuedForApproval === true,
    },
  });

  return {
    ...result,
    deleted: result.queuedForApproval !== true,
  };
};

const applyProductionVoucherUpdatePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  payload,
  req,
  approverId,
}) => {
  if (!EDITABLE_VOUCHER_TYPES.has(voucherTypeCode)) return;
  const validated = await normalizeAndValidatePayloadTx({
    trx,
    req,
    voucherTypeCode,
    voucherId,
    payload,
  });

  await trx("erp.voucher_header")
    .where({ id: voucherId })
    .update({
      voucher_date: validated.voucherDate,
      book_no: validated.referenceNo,
      remarks: validated.remarks,
      status: "APPROVED",
      approved_by: approverId || req?.user?.id || null,
      approved_at: trx.fn.now(),
    });

  await trx("erp.voucher_line").where({ voucher_header_id: voucherId }).del();
  const insertedLines = await insertVoucherLinesTx({
    trx,
    voucherId,
    lines: validated.lines,
  });

  await upsertVoucherExtensionsTx({
    trx,
    voucherId,
    voucherTypeCode,
    validated,
    insertedLines,
  });

  await ensureProductionVoucherDerivedDataTx({
    trx,
    voucherId,
    voucherTypeCode,
    actorUserId: approverId || req?.user?.id || null,
    // Admin approvers can apply DCV updates without blocking on RM shortage.
    allowNegativeRm: req?.user?.isAdmin === true,
  });
  await syncVoucherGlPostingTx({ trx, voucherId });
};

const getProductionVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
  const base = () =>
    knex("erp.voucher_header").where({
      branch_id: req.branchId,
      voucher_type_code: voucherTypeCode,
    });

  const [latestAny, latestActive] = await Promise.all([
    base().max({ value: "voucher_no" }).first(),
    base()
      .whereNot({ status: "REJECTED" })
      .max({ value: "voucher_no" })
      .first(),
  ]);

  return {
    latestVoucherNo: Number(latestAny?.value || 0),
    latestActiveVoucherNo: Number(latestActive?.value || 0),
  };
};

const getProductionVoucherNeighbours = async ({
  req,
  voucherTypeCode,
  cursorNo,
}) => {
  const normalized = Number(cursorNo || 0);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return { prevVoucherNo: null, nextVoucherNo: null };
  }

  const base = () =>
    knex("erp.voucher_header").where({
      branch_id: req.branchId,
      voucher_type_code: voucherTypeCode,
    });

  const [prevRow, nextRow] = await Promise.all([
    base()
      .where("voucher_no", "<", normalized)
      .max({ value: "voucher_no" })
      .first(),
    base()
      .where("voucher_no", ">", normalized)
      .min({ value: "voucher_no" })
      .first(),
  ]);

  return {
    prevVoucherNo: Number(prevRow?.value || 0) || null,
    nextVoucherNo: Number(nextRow?.value || 0) || null,
  };
};

const loadRecentProductionVouchers = async ({ req, voucherTypeCode }) => {
  const rows = await knex("erp.voucher_header")
    .select(
      "id",
      "voucher_no",
      "voucher_date",
      "status",
      "remarks",
      "created_at",
    )
    .where({
      branch_id: req.branchId,
      voucher_type_code: voucherTypeCode,
    })
    .whereNot({ status: "REJECTED" })
    .orderBy("id", "desc")
    .limit(20);
  return rows.map((row) => ({
    ...row,
    voucher_date: toDateOnly(row.voucher_date),
  }));
};

const loadProductionVoucherDetails = async ({
  req,
  voucherTypeCode,
  voucherNo,
}) => {
  const normalizedVoucherNo = parseVoucherNo(voucherNo);
  if (!normalizedVoucherNo) return null;

  const header = await knex("erp.voucher_header as vh")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status",
      "vh.remarks",
      "vh.book_no",
      "vh.voucher_type_code",
    )
    .where({
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": voucherTypeCode,
      "vh.voucher_no": normalizedVoucherNo,
    })
    .first();
  if (!header) return null;
  const supportsDcvStage = await hasDcvHeaderStageColumnTx(knex);
  const supportsProductionStage = await hasProductionLineStageColumnTx(knex);
  const supportsLossStage = await hasAbnormalLossStageColumnTx(knex);

  const lines = await knex("erp.voucher_line as vl")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as si", "si.id", "v.item_id")
    .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.line_kind",
      "vl.item_id",
      "vl.sku_id",
      "vl.labour_id",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.uom_id",
      "vl.meta",
      "i.name as item_name",
      "s.sku_code",
      "si.name as sku_item_name",
      "si.item_type as sku_item_type",
      "l.name as labour_name",
      "u.code as line_uom_code",
    )
    .where({ "vl.voucher_header_id": header.id })
    .orderBy("vl.line_no", "asc");

  const rmColorIds = [
    ...new Set(
      lines
        .map((line) => toPositiveInt(line?.meta?.rm_color_id))
        .filter(Boolean),
    ),
  ];
  const rmSizeIds = [
    ...new Set(
      lines
        .map((line) => toPositiveInt(line?.meta?.rm_size_id))
        .filter(Boolean),
    ),
  ];
  const [rmColorRows, rmSizeRows] = await Promise.all([
    rmColorIds.length
      ? knex("erp.colors").select("id", "name").whereIn("id", rmColorIds)
      : Promise.resolve([]),
    rmSizeIds.length
      ? knex("erp.sizes").select("id", "name").whereIn("id", rmSizeIds)
      : Promise.resolve([]),
  ]);
  const rmColorNameById = new Map(
    (rmColorRows || []).map((row) => [
      Number(row.id),
      String(row.name || "").trim(),
    ]),
  );
  const rmSizeNameById = new Map(
    (rmSizeRows || []).map((row) => [
      Number(row.id),
      String(row.name || "").trim(),
    ]),
  );

  let dcvHeader = null;
  let planHeader = null;
  let lossHeader = null;
  let sourceHeader = null;
  let generatedLinks = null;

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion) {
    dcvHeader = await knex("erp.dcv_header")
      .select("dept_id", "labour_id", ...(supportsDcvStage ? ["stage_id"] : []))
      .where({ voucher_id: header.id })
      .first();
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.productionPlan) {
    planHeader = await knex("erp.production_plan_header")
      .select("plan_kind")
      .where({ voucher_id: header.id })
      .first();
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss) {
    lossHeader = await knex("erp.abnormal_loss_header")
      .select("reason_code_id")
      .where({ voucher_id: header.id })
      .first();
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption) {
    sourceHeader = await knex("erp.consumption_header as ch")
      .join("erp.voucher_header as pvh", "pvh.id", "ch.source_production_id")
      .select(
        "ch.source_production_id",
        "pvh.voucher_no as source_production_no",
      )
      .where({ "ch.voucher_id": header.id })
      .first();
  } else if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion
  ) {
    generatedLinks = await knex("erp.production_generated_links as pgl")
      .leftJoin(
        "erp.voucher_header as cvh",
        "cvh.id",
        "pgl.consumption_voucher_id",
      )
      .select(
        "pgl.consumption_voucher_id",
        "cvh.voucher_no as consumption_voucher_no",
      )
      .where({ "pgl.production_voucher_id": header.id })
      .first();
  }

  let productionLineMap = new Map();
  let planLineMap = new Map();
  let lossLineMap = new Map();

  if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
  ) {
    const extRows = await knex("erp.production_line")
      .select(
        "voucher_line_id",
        "is_packed",
        "total_pairs",
        ...(supportsProductionStage ? ["stage_id"] : []),
      )
      .whereIn(
        "voucher_line_id",
        lines.map((line) => Number(line.id)),
      );
    productionLineMap = new Map(
      extRows.map((row) => [Number(row.voucher_line_id), row]),
    );
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.productionPlan) {
    const extRows = await knex("erp.production_plan_line")
      .select("voucher_line_id", "is_packed", "total_pairs")
      .whereIn(
        "voucher_line_id",
        lines.map((line) => Number(line.id)),
      );
    planLineMap = new Map(
      extRows.map((row) => [Number(row.voucher_line_id), row]),
    );
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss) {
    const extRows = await knex("erp.abnormal_loss_line")
      .select(
        "voucher_line_id",
        "loss_type",
        "dept_id",
        ...(supportsLossStage ? ["stage_id"] : []),
      )
      .whereIn(
        "voucher_line_id",
        lines.map((line) => Number(line.id)),
      );
    lossLineMap = new Map(
      extRows.map((row) => [Number(row.voucher_line_id), row]),
    );
  }

  let mappedLines = lines.map((line) => {
    const productionExt = productionLineMap.get(Number(line.id));
    const planExt = planLineMap.get(Number(line.id));
    const lossExt = lossLineMap.get(Number(line.id));
    const fallbackStatus = String(line?.meta?.status || "LOOSE").toUpperCase();
    const resolvedStatus = productionExt
      ? productionExt.is_packed
        ? "PACKED"
        : "LOOSE"
      : planExt
        ? planExt.is_packed
          ? "PACKED"
          : "LOOSE"
        : fallbackStatus;
    const fallbackUnit = String(line?.meta?.unit || "")
      .trim()
      .toUpperCase();
    const lineUomCode = String(line?.line_uom_code || "")
      .trim()
      .toUpperCase();
    const resolvedUnit =
      voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption
        ? lineUomCode || fallbackUnit || statusToUnit(resolvedStatus)
        : fallbackUnit || statusToUnit(resolvedStatus);
    const rmColorId = toPositiveInt(line?.meta?.rm_color_id);
    const rmSizeId = toPositiveInt(line?.meta?.rm_size_id);
    return {
      id: Number(line.id),
      line_no: Number(line.line_no || 0),
      line_kind: String(line.line_kind || "").toUpperCase(),
      item_id: toPositiveInt(line.item_id),
      item_name: line.item_name || "",
      rm_color_id: rmColorId,
      rm_color_name: rmColorId
        ? rmColorNameById.get(Number(rmColorId)) || ""
        : "",
      rm_size_id: rmSizeId,
      rm_size_name: rmSizeId ? rmSizeNameById.get(Number(rmSizeId)) || "" : "",
      source_sku_id: toPositiveInt(line?.meta?.source_sku_id),
      sku_id: toPositiveInt(line.sku_id),
      sku_code: line.sku_code || "",
      sku_item_name: line.sku_item_name || "",
      sku_item_type: String(line.sku_item_type || "").toUpperCase() || null,
      labour_id: toPositiveInt(line.labour_id),
      labour_name: line.labour_name || "",
      qty: Number(line.qty || 0),
      rate: Number(line.rate || 0),
      amount: Number(line.amount || 0),
      unit: resolvedUnit,
      status: resolvedStatus,
      total_pairs:
        Number(
          productionExt?.total_pairs ||
            planExt?.total_pairs ||
            line?.meta?.total_pairs ||
            0,
        ) || null,
      loss_type: String(lossExt?.loss_type || "").toUpperCase() || null,
      dept_id: toPositiveInt(lossExt?.dept_id || line?.meta?.department_id),
      stage_id: toPositiveInt(
        productionExt?.stage_id || lossExt?.stage_id || line?.meta?.stage_id,
      ),
    };
  });

  if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption &&
    mappedLines.length
  ) {
    mappedLines = await enrichConsumptionLinesWithRmRatesTx({
      trx: knex,
      lines: mappedLines,
    });
  }

  const abnormalLossType =
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss
      ? String(
          mappedLines.find((line) => String(line?.loss_type || "").trim())
            ?.loss_type || "",
        )
          .trim()
          .toUpperCase() || null
      : null;
  const abnormalLossDeptId =
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss
      ? toPositiveInt(
          mappedLines.find((line) => {
            const lineLossType = String(line?.loss_type || "")
              .trim()
              .toUpperCase();
            return (
              (lineLossType === "DVC_ABANDON" || lineLossType === "RM_LOSS") &&
              toPositiveInt(line?.dept_id)
            );
          })?.dept_id,
        )
      : null;

  return {
    id: Number(header.id),
    voucher_no: Number(header.voucher_no || 0),
    voucher_date: toDateOnly(header.voucher_date),
    status: String(header.status || "").toUpperCase(),
    remarks: header.remarks || "",
    reference_no: header.book_no || "",
    voucher_type_code: voucherTypeCode,
    dept_id:
      voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss
        ? abnormalLossDeptId
        : toPositiveInt(dcvHeader?.dept_id),
    labour_id: toPositiveInt(dcvHeader?.labour_id),
    stage_id: toPositiveInt(dcvHeader?.stage_id),
    plan_kind: String(planHeader?.plan_kind || "").toUpperCase() || null,
    reason_code_id: toPositiveInt(lossHeader?.reason_code_id),
    loss_type: abnormalLossType,
    source_production_id: toPositiveInt(sourceHeader?.source_production_id),
    source_production_no:
      Number(sourceHeader?.source_production_no || 0) || null,
    generated_links: generatedLinks
      ? {
          consumption_voucher_id: toPositiveInt(
            generatedLinks.consumption_voucher_id,
          ),
          consumption_voucher_no:
            Number(generatedLinks.consumption_voucher_no || 0) || null,
        }
      : null,
    lines: mappedLines,
  };
};

const loadProductionVoucherOptions = async (
  req,
  { voucherTypeCode, selectedVoucher = null } = {},
) => {
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);
  const isLoss =
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss;
  const isPlan =
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.productionPlan;
  const isFg =
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction;
  const isSfg =
    normalizedVoucherTypeCode ===
    PRODUCTION_VOUCHER_TYPES.semiFinishedProduction;
  const isConsumption =
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption;
  const isLabourProd =
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.labourProduction;
  const isDcv =
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion;
  const [canReadLossRmBalance, canReadLossSkuBalance] = isLoss
    ? await Promise.all([
        hasStockBalanceRmTableTx(knex),
        hasStockBalanceSkuTableTx(knex),
      ])
    : [false, false];

  const [
    departments,
    labours,
    reasonCodes,
    rmItems,
    skus,
    sourceProductions,
    productionStages,
    dcvUnits,
    lossRmBalanceRows,
    lossSkuBalanceRows,
    rmLossVariantRows,
  ] = await Promise.all([
    knex("erp.departments")
      .select("id", "name", "is_production")
      .where({ is_active: true, is_production: true })
      .orderBy("name", "asc"),
    knex("erp.labours as l")
      .select(
        "l.id",
        "l.code",
        "l.name",
        knex.raw(
          `(SELECT COALESCE(string_agg(ld.dept_id::text, ',' ORDER BY ld.dept_id), '')
            FROM erp.labour_department ld
            WHERE ld.labour_id = l.id) as dept_ids_csv`,
        ),
        "l.dept_id as default_dept_id",
      )
      .whereRaw("lower(coalesce(l.status, '')) = 'active'")
      .whereExists(function branchAccess() {
        this.select(1)
          .from("erp.labour_branch as lb")
          .whereRaw("lb.labour_id = l.id")
          .andWhere("lb.branch_id", req.branchId);
      })
      .orderBy("l.name", "asc"),
    isLoss
      ? knex("erp.reason_codes as rc")
          .select("rc.id", "rc.code", "rc.name")
          .where({ "rc.is_active": true })
          .whereNotIn(knex.raw("upper(coalesce(rc.code::text, ''))"), [
            "PILFERAGE",
            "DVC_ABANDONMENT",
          ])
          .where(function reasonScope() {
            this.whereNotExists(function noMap() {
              this.select(1)
                .from("erp.reason_code_voucher_type_map as m")
                .whereRaw("m.reason_code_id = rc.id");
            }).orWhereExists(function allowedMap() {
              this.select(1)
                .from("erp.reason_code_voucher_type_map as m")
                .whereRaw("m.reason_code_id = rc.id")
                .andWhere("m.voucher_type_code", normalizedVoucherTypeCode);
            });
          })
          .orderByRaw(
            "CASE WHEN upper(coalesce(rc.code::text, '')) = 'OTHER_LOSS' THEN 1 ELSE 0 END ASC",
          )
          .orderBy("rc.name", "asc")
      : Promise.resolve([]),
    isLoss || isConsumption
      ? knex("erp.items as i")
          .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
          .select(
            "i.id",
            "i.code",
            "i.name",
            "i.base_uom_id",
            "u.code as base_uom_code",
            "u.name as base_uom_name",
          )
          .where({ "i.is_active": true, "i.item_type": "RM" })
          .orderBy("i.name", "asc")
      : Promise.resolve([]),
    (() => {
      let itemTypes = ["FG", "SFG"];
      if (isFg) itemTypes = ["FG"];
      if (isSfg) itemTypes = ["SFG"];
      if (isPlan) {
        const planKind = String(
          selectedVoucher?.plan_kind || "FG",
        ).toUpperCase();
        itemTypes = planKind === "SFG" ? ["SFG"] : ["FG"];
      }

      return knex("erp.skus as s")
        .join("erp.variants as v", "v.id", "s.variant_id")
        .join("erp.items as i", "i.id", "v.item_id")
        .leftJoin("erp.sizes as sz", "sz.id", "v.size_id")
        .leftJoin("erp.colors as c", "c.id", "v.color_id")
        .leftJoin("erp.packing_types as pt", "pt.id", "v.packing_type_id")
        .select(
          "s.id",
          "s.sku_code",
          "i.name as item_name",
          "i.item_type",
          "sz.name as size_name",
          "c.name as color_name",
          "pt.name as packing_name",
        )
        .where({ "s.is_active": true, "i.is_active": true })
        .whereIn(knex.raw("upper(coalesce(i.item_type::text, ''))"), itemTypes)
        .orderBy("s.sku_code", "asc");
    })(),
    isConsumption || isLabourProd
      ? knex("erp.voucher_header as vh")
          .select(
            "vh.id",
            "vh.voucher_no",
            "vh.voucher_type_code",
            "vh.voucher_date",
          )
          .where({
            "vh.branch_id": req.branchId,
            "vh.status": "APPROVED",
          })
          .whereIn("vh.voucher_type_code", [
            PRODUCTION_VOUCHER_TYPES.finishedProduction,
            PRODUCTION_VOUCHER_TYPES.semiFinishedProduction,
          ])
          .orderBy("vh.voucher_no", "desc")
          .limit(200)
      : Promise.resolve([]),
    isFg ||
    isSfg ||
    normalizedVoucherTypeCode ===
      PRODUCTION_VOUCHER_TYPES.departmentCompletion ||
    isLoss
      ? loadActiveProductionStagesTx(knex)
      : Promise.resolve([]),
    isDcv ? loadPairConvertibleUomOptionsTx(knex) : Promise.resolve([]),
    isLoss && canReadLossRmBalance
      ? knex("erp.stock_balance_rm as sb")
          .select("sb.item_id")
          .sum({ total_qty: knex.raw("COALESCE(sb.qty, 0)") })
          .sum({ total_value: knex.raw("COALESCE(sb.value, 0)") })
          .where({
            "sb.branch_id": req.branchId,
            "sb.stock_state": "ON_HAND",
          })
          .groupBy("sb.item_id")
      : Promise.resolve([]),
    isLoss && canReadLossSkuBalance
      ? knex("erp.stock_balance_sku as sb")
          .select("sb.sku_id", "sb.category")
          .sum({ total_qty_pairs: knex.raw("COALESCE(sb.qty_pairs, 0)") })
          .sum({ total_value: knex.raw("COALESCE(sb.value, 0)") })
          .where({
            "sb.branch_id": req.branchId,
            "sb.stock_state": "ON_HAND",
          })
          .whereIn("sb.category", ["SFG", "FG"])
          .groupBy("sb.sku_id", "sb.category")
      : Promise.resolve([]),
    isLoss
      ? knex("erp.rm_purchase_rates as r")
          .leftJoin("erp.colors as c", "c.id", "r.color_id")
          .leftJoin("erp.sizes as sz", "sz.id", "r.size_id")
          .select(
            "r.rm_item_id",
            "r.color_id",
            "c.name as color_name",
            "r.size_id",
            "sz.name as size_name",
            "r.avg_purchase_rate",
            "r.purchase_rate",
          )
          .where("r.is_active", true)
      : Promise.resolve([]),
  ]);

  const rmDefaultRateByItemId = new Map(
    (lossRmBalanceRows || [])
      .map((row) => {
        const itemId = toPositiveInt(row?.item_id);
        const qty = Number(row?.total_qty || 0);
        const value = Number(row?.total_value || 0);
        const defaultRate =
          qty > 0 && value >= 0 ? Number((value / qty).toFixed(4)) : 0;
        if (!itemId || !(defaultRate > 0)) return null;
        return [Number(itemId), defaultRate];
      })
      .filter(Boolean),
  );

  const skuDefaultRateByIdentity = new Map();
  const skuDefaultRateBySkuId = new Map();
  (lossSkuBalanceRows || []).forEach((row) => {
    const skuId = toPositiveInt(row?.sku_id);
    const category = String(row?.category || "")
      .trim()
      .toUpperCase();
    const qtyPairs = Number(row?.total_qty_pairs || 0);
    const value = Number(row?.total_value || 0);
    const defaultRate =
      qtyPairs > 0 && value >= 0 ? Number((value / qtyPairs).toFixed(4)) : 0;
    if (!skuId || !(defaultRate > 0)) return;
    if (category === "FG" || category === "SFG") {
      skuDefaultRateByIdentity.set(`${Number(skuId)}:${category}`, defaultRate);
    }
    if (!skuDefaultRateBySkuId.has(Number(skuId))) {
      skuDefaultRateBySkuId.set(Number(skuId), defaultRate);
    }
  });

  const normalizedLabours = (labours || []).map((row) => {
    const deptIds = new Set();
    const defaultDeptId = toPositiveInt(row?.default_dept_id);
    if (defaultDeptId) deptIds.add(defaultDeptId);
    String(row?.dept_ids_csv || "")
      .split(",")
      .map((value) => toPositiveInt(value))
      .filter(Boolean)
      .forEach((deptId) => deptIds.add(Number(deptId)));
    return {
      id: Number(row.id),
      code: row.code || "",
      name: row.name || "",
      dept_ids: [...deptIds],
    };
  });

  return {
    departments,
    labours: normalizedLabours,
    reasonCodes,
    rmItems: (rmItems || []).map((row) => {
      const itemId = Number(row?.id || 0);
      const defaultRate = Number(rmDefaultRateByItemId.get(itemId) || 0);
      return {
        ...row,
        default_rate: Number(defaultRate.toFixed(4)),
      };
    }),
    skus: (skus || []).map((row) => {
      const skuId = Number(row?.id || 0);
      const itemType = String(row?.item_type || "")
        .trim()
        .toUpperCase();
      const resolvedRate = Number(
        skuDefaultRateByIdentity.get(`${skuId}:${itemType}`) ||
          skuDefaultRateBySkuId.get(skuId) ||
          0,
      );
      return {
        ...row,
        default_rate: Number(resolvedRate.toFixed(4)),
      };
    }),
    productionStages: (productionStages || []).map((row) => ({
      id: Number(row.id),
      code: String(row.code || "").trim(),
      name: String(row.name || row.code || row.id || "").trim(),
      dept_id: Number(row.dept_id || 0) || null,
    })),
    lossTypes: ["RM_LOSS", "SFG_LOSS", "FG_LOSS", "DVC_ABANDON"],
    sourceProductions,
    dcvUnits: (dcvUnits || []).map((row) => ({
      id: Number(row.id),
      code: String(row.code || "")
        .trim()
        .toUpperCase(),
      name: String(row.name || "").trim(),
      factor_to_pair: Number(row.factor_to_pair || 0),
    })),
    rmLossVariants: (rmLossVariantRows || [])
      .map((row) => {
        const itemId = toPositiveInt(row?.rm_item_id);
        if (!itemId) return null;
        return {
          item_id: Number(itemId),
          color_id: toPositiveInt(row?.color_id),
          color_name: String(row?.color_name || "").trim(),
          size_id: toPositiveInt(row?.size_id),
          size_name: String(row?.size_name || "").trim(),
          default_rate: Number(
            toNonNegativeNumber(
              row?.avg_purchase_rate ?? row?.purchase_rate,
              4,
            ) || 0,
          ),
        };
      })
      .filter(Boolean),
    isAutoGeneratedVoucher: AUTO_GENERATED_VOUCHER_TYPES.has(
      normalizedVoucherTypeCode,
    ),
  };
};

const resolveDcvRateForSku = async ({
  req,
  labourId,
  deptId,
  skuId,
  unitCode,
}) => {
  const normalizedLabourId = toPositiveInt(labourId);
  const normalizedDeptId = toPositiveInt(deptId);
  const normalizedSkuId = toPositiveInt(skuId);
  if (!normalizedLabourId || !normalizedDeptId || !normalizedSkuId) {
    return { rate: 0, found: false, reason: "MISSING_INPUT" };
  }

  await knex.transaction(async (trx) => {
    await validateLabourTx({
      trx,
      req,
      labourId: normalizedLabourId,
      allowNull: false,
    });
    await validateDepartmentForLabourTx({
      trx,
      departmentId: normalizedDeptId,
      labourId: normalizedLabourId,
      requireProduction: true,
    });
  });

  const dcvUnits = await loadPairConvertibleUomOptionsTx(knex);
  const unitMap = new Map(
    (dcvUnits || [])
      .map((row) => [
        String(row.code || "")
          .trim()
          .toUpperCase(),
        row,
      ])
      .filter(([code, row]) => code && row?.id),
  );
  const normalizedUnitCode = String(unitCode || "")
    .trim()
    .toUpperCase();
  const selectedUnit =
    unitMap.get(normalizedUnitCode) ||
    unitMap.get("PAIR") ||
    dcvUnits[0] ||
    null;
  if (!selectedUnit)
    return { rate: 0, found: false, reason: "UNIT_NOT_CONFIGURED" };

  const sku = await knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id", "i.item_type", "i.subgroup_id", "i.group_id")
    .where({
      "s.id": normalizedSkuId,
      "s.is_active": true,
      "i.is_active": true,
    })
    .first();
  if (!sku) return { rate: 0, found: false, reason: "SKU_NOT_FOUND" };

  const skuItemType = String(sku.item_type || "")
    .trim()
    .toUpperCase();
  const hasArticleTypeColumn =
    await hasLabourRateRulesArticleTypeColumnTx(knex);
  let rulesQuery = knex("erp.labour_rate_rules as r")
    .select(
      "r.id",
      "r.apply_on",
      "r.sku_id",
      "r.subgroup_id",
      "r.group_id",
      "r.rate_type",
      "r.rate_value",
    )
    .where({
      "r.labour_id": normalizedLabourId,
      "r.dept_id": normalizedDeptId,
      "r.status": "active",
      "r.applies_to_all_labours": false,
    })
    .whereIn(knex.raw("upper(coalesce(r.apply_on::text, ''))"), [
      "SKU",
      "SUBGROUP",
      "GROUP",
    ]);
  if (hasArticleTypeColumn) {
    rulesQuery = rulesQuery.select("r.article_type");
  }
  const rules = await rulesQuery.orderBy("r.id", "desc");

  const matchesArticleType = (row) => {
    if (!hasArticleTypeColumn) return true;
    const articleType = String(row?.article_type || "")
      .trim()
      .toUpperCase();
    if (!articleType || articleType === "BOTH") return true;
    return articleType === skuItemType;
  };
  const matchesScope = (row, scope) => {
    const applyOn = String(row?.apply_on || "")
      .trim()
      .toUpperCase();
    if (applyOn !== scope) return false;
    if (scope === "SKU")
      return Number(row?.sku_id || 0) === Number(normalizedSkuId);
    if (scope === "SUBGROUP")
      return Number(row?.subgroup_id || 0) === Number(sku.subgroup_id || 0);
    if (scope === "GROUP")
      return Number(row?.group_id || 0) === Number(sku.group_id || 0);
    return false;
  };

  let matchedRule = null;
  for (const scope of ["SKU", "SUBGROUP", "GROUP"]) {
    matchedRule =
      (rules || []).find(
        (row) => matchesArticleType(row) && matchesScope(row, scope),
      ) || null;
    if (matchedRule) break;
  }
  if (!matchedRule) {
    return {
      rate: 0,
      found: false,
      reason: "RATE_RULE_NOT_FOUND",
      unit_code: String(selectedUnit.code || "").toUpperCase(),
      factor_to_pair: Number(selectedUnit.factor_to_pair || 0),
    };
  }

  const sourceRateType = String(matchedRule.rate_type || "PER_PAIR")
    .trim()
    .toUpperCase();
  const sourceRateValue = Number(matchedRule.rate_value || 0);
  const factorToPair = Number(selectedUnit.factor_to_pair || 0);
  if (
    !Number.isFinite(sourceRateValue) ||
    sourceRateValue < 0 ||
    !Number.isFinite(factorToPair) ||
    factorToPair <= 0
  ) {
    return { rate: 0, found: false, reason: "INVALID_RATE_SOURCE" };
  }

  const ratePerPair =
    sourceRateType === "PER_DOZEN"
      ? Number((sourceRateValue / PAIRS_PER_DOZEN).toFixed(6))
      : Number(sourceRateValue.toFixed(6));
  const convertedRate = Number((ratePerPair * factorToPair).toFixed(4));

  return {
    found: true,
    rate: convertedRate,
    rule_id: Number(matchedRule.id),
    source_rate_type: sourceRateType,
    source_rate_value: Number(sourceRateValue.toFixed(4)),
    unit_code: String(selectedUnit.code || "").toUpperCase(),
    factor_to_pair: Number(factorToPair.toFixed(6)),
  };
};

const resolveDcvAvailabilityForLine = async ({
  req,
  labourId,
  deptId,
  stageId,
  skuId,
  qty,
  unitCode,
  voucherDate = null,
  voucherId = null,
}) =>
  knex.transaction(async (trx) => {
    const normalizedLabourId = toPositiveInt(labourId);
    const normalizedSkuId = toPositiveInt(skuId);
    if (!normalizedSkuId) {
      throw new HttpError(400, "SKU is required");
    }

    const normalizedDeptId = await validateDepartmentForLabourTx({
      trx,
      departmentId: deptId,
      labourId: normalizedLabourId,
      requireProduction: true,
    });
    const normalizedVoucherId = toPositiveInt(voucherId);

    const dcvUnits = await loadPairConvertibleUomOptionsTx(trx);
    const unitByCode = new Map(
      (dcvUnits || [])
        .map((row) => {
          const code = String(row?.code || "")
            .trim()
            .toUpperCase();
          if (!code) return null;
          return [code, row];
        })
        .filter(Boolean),
    );
    const requestedUnitCode =
      String(unitCode || "")
        .trim()
        .toUpperCase() || "PAIR";
    const selectedUnit =
      unitByCode.get(requestedUnitCode) ||
      unitByCode.get("PAIR") ||
      dcvUnits[0] ||
      null;
    if (!selectedUnit) {
      throw new HttpError(400, "Unit is invalid for PAIR conversion");
    }

    const normalizedQty = toPositiveNumber(qty, 3);
    if (!normalizedQty) {
      throw new HttpError(400, "Quantity must be greater than zero");
    }
    const factorToPair = Number(selectedUnit.factor_to_pair || 0);
    if (!(Number.isFinite(factorToPair) && factorToPair > 0)) {
      throw new HttpError(400, "Unit conversion to PAIR is missing");
    }
    const rawPairs = Number(normalizedQty) * factorToPair;
    const producedPairs = Number(rawPairs.toFixed(3));
    if (!Number.isInteger(producedPairs)) {
      throw new HttpError(400, "Quantity must convert to whole pairs");
    }

    const resolvedStageId = toPositiveInt(stageId)
      ? await validateStageTx({
          trx,
          stageId,
          departmentId: normalizedDeptId,
          allowNull: false,
        })
      : await resolveActiveStageForDepartmentTx({
          trx,
          departmentId: normalizedDeptId,
          allowNull: false,
        });

    const [skuDisplayMap, bomProfile] = await Promise.all([
      loadSkuDisplayMapTx({ trx, skuIds: [normalizedSkuId] }),
      loadBomProfileBySkuTx({ trx, skuId: normalizedSkuId }),
    ]);
    if (!bomProfile) {
      const skuLabel = buildSkuDisplayLabel(
        skuDisplayMap.get(normalizedSkuId) || {
          sku_code: `#${normalizedSkuId}`,
        },
      );
      throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
    }

    const skuLabel = buildSkuDisplayLabel(
      skuDisplayMap.get(normalizedSkuId) || { sku_code: `#${normalizedSkuId}` },
    );
    const stageFlow = resolveDcvStageTransitionForBomProfile({
      bomProfile,
      stageId: resolvedStageId,
      departmentId: normalizedDeptId,
    });

    const resolveWipAddBackBySkuTx = async ({
      deptId: targetDeptId,
      skuIds = [],
    }) => {
      const normalizedDept = toPositiveInt(targetDeptId);
      const normalizedSkuIds = [
        ...new Set(
          (Array.isArray(skuIds) ? skuIds : [])
            .map((id) => toPositiveInt(id))
            .filter(Boolean),
        ),
      ];
      if (!normalizedVoucherId || !normalizedDept || !normalizedSkuIds.length)
        return new Map();
      const rows = await trx("erp.wip_dept_ledger as wl")
        .select("wl.sku_id")
        .sum({ qty_pairs: trx.raw("COALESCE(wl.qty_pairs, 0)") })
        .where({
          "wl.branch_id": Number(req.branchId),
          "wl.source_voucher_id": Number(normalizedVoucherId),
          "wl.direction": -1,
          "wl.dept_id": Number(normalizedDept),
        })
        .whereIn("wl.sku_id", normalizedSkuIds)
        .groupBy("wl.sku_id");
      return new Map(
        rows.map((row) => [Number(row.sku_id), Number(row.qty_pairs || 0)]),
      );
    };

    let previousStage = null;
    if (stageFlow.hasStageRouting && stageFlow.previousRequiredDeptId) {
      const previousDeptId = toPositiveInt(stageFlow.previousRequiredDeptId);
      const wipAddBackBySku = await resolveWipAddBackBySkuTx({
        deptId: previousDeptId,
        skuIds: [normalizedSkuId],
      });
      // Availability panel mirrors posting logic: direct predecessor + convertible better-grade pools.
      const pool = await getCurrentWipBalanceTx({
        trx,
        branchId: req.branchId,
        skuId: normalizedSkuId,
        deptId: previousDeptId,
      });
      const addBackPairs = Number(
        wipAddBackBySku.get(Number(normalizedSkuId)) || 0,
      );
      const availablePairs = Number(
        Number(pool?.qty_pairs || 0) + addBackPairs,
      );
      const requiredPairs = Number(producedPairs);
      const directDeficitPairs = Math.max(0, requiredPairs - availablePairs);
      let convertiblePairs = 0;
      let conversionSources = [];
      if (directDeficitPairs > 0) {
        const conversionPools = await findBetterGradeSourcePoolsTx({
          trx,
          branchId: req.branchId,
          deptId: previousDeptId,
          targetSkuId: normalizedSkuId,
        });
        const conversionAddBackBySku = await resolveWipAddBackBySkuTx({
          deptId: previousDeptId,
          skuIds: conversionPools.map((row) => Number(row.sku_id)),
        });
        conversionSources = conversionPools.map((row) => ({
          source_sku_id: Number(row.sku_id),
          source_sku_label: String(row.sku_code || `#${row.sku_id}`),
          available_pairs: Number(
            Number(row.available_pairs || 0) +
              Number(conversionAddBackBySku.get(Number(row.sku_id)) || 0),
          ),
          source_grade_rank: Number(row.grade_rank || 0),
        }));
        convertiblePairs = Number(
          conversionPools.reduce(
            (sum, row) =>
              sum +
              Number(row.available_pairs || 0) +
              Number(conversionAddBackBySku.get(Number(row.sku_id)) || 0),
            0,
          ),
        );
      }
      const effectiveAvailablePairs = Number(availablePairs + convertiblePairs);
      const deficitPairs = Math.max(0, requiredPairs - effectiveAvailablePairs);
      previousStage = {
        stage_id: toPositiveInt(stageFlow.previousRequiredStageId),
        stage_name: String(
          stageFlow.requiredRoutes.find(
            (route) =>
              Number(route.stage_id) ===
              Number(stageFlow.previousRequiredStageId),
          )?.stage_name || `Stage ${stageFlow.previousRequiredStageId}`,
        ),
        dept_id: toPositiveInt(stageFlow.previousRequiredDeptId),
        available_pairs: Number(availablePairs),
        convertible_pairs: Number(convertiblePairs),
        effective_available_pairs: Number(effectiveAvailablePairs),
        required_pairs: Number(requiredPairs),
        deficit_pairs: Number(deficitPairs),
        conversion_sources: conversionSources,
      };
    }

    const sfgRequirements = buildSfgRequirementsForStage({
      bomProfile,
      stageId: resolvedStageId,
      producedPairs,
      lineNo: null,
      skuLabel,
    });
    const requiredPairsBySfgSku = new Map();
    sfgRequirements.forEach((row) => {
      const sfgSkuId = Number(row.sfg_sku_id);
      const nextRequired =
        Number(requiredPairsBySfgSku.get(sfgSkuId) || 0) +
        Number(row.required_pairs || 0);
      requiredPairsBySfgSku.set(sfgSkuId, Number(nextRequired));
    });

    let sfgRows = [];
    if (requiredPairsBySfgSku.size) {
      const requiredSfgSkuIds = [...requiredPairsBySfgSku.keys()];
      let addBackSfgBySku = new Map();
      if (normalizedVoucherId && (await hasStockLedgerTableTx(trx))) {
        const generatedLink = await trx("erp.production_generated_links")
          .select("consumption_voucher_id")
          .where({ production_voucher_id: Number(normalizedVoucherId) })
          .first();
        const addBackVoucherIds = [
          Number(normalizedVoucherId),
          toPositiveInt(generatedLink?.consumption_voucher_id),
        ].filter(Boolean);
        if (addBackVoucherIds.length) {
          const addBackRows = await trx("erp.stock_ledger as sl")
            .select("sl.sku_id")
            .sum({ qty_pairs: trx.raw("COALESCE(sl.qty_pairs, 0)") })
            .where({
              "sl.branch_id": Number(req.branchId),
              "sl.stock_state": "ON_HAND",
              "sl.category": "SFG",
              "sl.direction": -1,
            })
            .whereIn("sl.voucher_header_id", addBackVoucherIds)
            .whereIn("sl.sku_id", requiredSfgSkuIds)
            .groupBy("sl.sku_id");
          addBackSfgBySku = new Map(
            addBackRows.map((row) => [
              Number(row.sku_id),
              Number(row.qty_pairs || 0),
            ]),
          );
        }
      }
      const [availableBySku, requiredSkuDisplayMap] = await Promise.all([
        loadOnHandSfgPairsBySkuTx({
          trx,
          branchId: req.branchId,
          skuIds: requiredSfgSkuIds,
        }),
        loadSkuDisplayMapTx({ trx, skuIds: requiredSfgSkuIds }),
      ]);
      sfgRows = requiredSfgSkuIds.map((sfgSkuId) => {
        const requiredPairs = Number(requiredPairsBySfgSku.get(sfgSkuId) || 0);
        const availablePairs = Number(
          Number(availableBySku.get(sfgSkuId) || 0) +
            Number(addBackSfgBySku.get(sfgSkuId) || 0),
        );
        const deficitPairs = Math.max(0, requiredPairs - availablePairs);
        const sfgLabel = buildSkuDisplayLabel(
          requiredSkuDisplayMap.get(sfgSkuId) || { sku_code: `#${sfgSkuId}` },
        );
        return {
          sfg_sku_id: Number(sfgSkuId),
          sfg_sku_label: sfgLabel,
          required_pairs: Number(requiredPairs),
          available_pairs: Number(availablePairs),
          deficit_pairs: Number(deficitPairs),
        };
      });
    }

    const previousDeficitPairs = Number(previousStage?.deficit_pairs || 0);
    const sfgDeficitPairs = sfgRows.reduce(
      (sum, row) => sum + Number(row.deficit_pairs || 0),
      0,
    );
    const totalDeficitPairs = Number(previousDeficitPairs + sfgDeficitPairs);

    return {
      status: totalDeficitPairs > 0 ? "SHORT" : "OK",
      sku_id: Number(normalizedSkuId),
      sku_label: skuLabel,
      dept_id: Number(normalizedDeptId),
      stage_id: Number(resolvedStageId),
      produced_pairs: Number(producedPairs),
      unit_code: String(selectedUnit.code || "")
        .trim()
        .toUpperCase(),
      factor_to_pair: Number(Number(factorToPair).toFixed(6)),
      previous_stage: previousStage,
      sfg: {
        rows: sfgRows,
        total_deficit_pairs: Number(sfgDeficitPairs),
      },
      total_deficit_pairs: Number(totalDeficitPairs),
      checked_on: voucherDate || null,
    };
  });

module.exports = {
  PRODUCTION_VOUCHER_TYPES,
  parseVoucherNo,
  isProductionVoucherType,
  createProductionVoucher,
  updateProductionVoucher,
  deleteProductionVoucher,
  loadProductionVoucherOptions,
  resolveDcvRateForSku,
  resolveDcvAvailabilityForLine,
  loadRecentProductionVouchers,
  getProductionVoucherSeriesStats,
  getProductionVoucherNeighbours,
  loadProductionVoucherDetails,
  loadBomProfileBySkuTx,
  ensureProductionVoucherDerivedDataTx,
  applyProductionVoucherUpdatePayloadTx,
  applyProductionVoucherDeletePayloadTx,
};
