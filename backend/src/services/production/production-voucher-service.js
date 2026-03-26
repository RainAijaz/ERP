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

const PRODUCTION_VOUCHER_TYPE_SET = new Set(Object.values(PRODUCTION_VOUCHER_TYPES));
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
const LOSS_TYPE_VALUES = new Set(["RM_LOSS", "SFG_LOSS", "FG_LOSS", "DVC_ABANDON"]);
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
let bomSkuOverrideTableSupport;
let labourRateRulesArticleTypeColumnSupport;

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
  if (typeof productionStagesTableSupport === "boolean") return productionStagesTableSupport;
  productionStagesTableSupport = await tableExistsTx(trx, "erp.production_stages");
  return productionStagesTableSupport;
};

const hasBomStageRoutingTableTx = async (trx) => {
  if (typeof bomStageRoutingTableSupport === "boolean") return bomStageRoutingTableSupport;
  bomStageRoutingTableSupport = await tableExistsTx(trx, "erp.bom_stage_routing");
  return bomStageRoutingTableSupport;
};

const hasBomSkuOverrideTableTx = async (trx) => {
  if (typeof bomSkuOverrideTableSupport === "boolean") return bomSkuOverrideTableSupport;
  bomSkuOverrideTableSupport = await tableExistsTx(trx, "erp.bom_sku_override_line");
  return bomSkuOverrideTableSupport;
};

const hasProductionLineStageColumnTx = async (trx) => {
  if (typeof productionLineStageColumnSupport === "boolean") return productionLineStageColumnSupport;
  productionLineStageColumnSupport = await hasColumnTx(trx, "erp", "production_line", "stage_id");
  return productionLineStageColumnSupport;
};

const hasDcvHeaderStageColumnTx = async (trx) => {
  if (typeof dcvHeaderStageColumnSupport === "boolean") return dcvHeaderStageColumnSupport;
  dcvHeaderStageColumnSupport = await hasColumnTx(trx, "erp", "dcv_header", "stage_id");
  return dcvHeaderStageColumnSupport;
};

const hasAbnormalLossStageColumnTx = async (trx) => {
  if (typeof abnormalLossStageColumnSupport === "boolean") return abnormalLossStageColumnSupport;
  abnormalLossStageColumnSupport = await hasColumnTx(trx, "erp", "abnormal_loss_line", "stage_id");
  return abnormalLossStageColumnSupport;
};

const hasLabourRateRulesArticleTypeColumnTx = async (trx) => {
  if (typeof labourRateRulesArticleTypeColumnSupport === "boolean") return labourRateRulesArticleTypeColumnSupport;
  labourRateRulesArticleTypeColumnSupport = await hasColumnTx(trx, "erp", "labour_rate_rules", "article_type");
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

const parseVoucherNo = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const normalizeVoucherTypeCode = (value) => String(value || "").trim().toUpperCase();

const normalizeRowStatus = (value) => {
  const status = String(value || "LOOSE").trim().toUpperCase();
  return ROW_STATUS_VALUES.includes(status) ? status : "LOOSE";
};

const normalizeRowUnit = (value) => {
  const unit = String(value || "").trim().toUpperCase();
  return ROW_UNIT_VALUES.includes(unit) ? unit : null;
};

const unitToStatus = (unit) => (String(unit || "").toUpperCase() === "DZN" ? "PACKED" : "LOOSE");

const statusToUnit = (status) => (String(status || "").toUpperCase() === "PACKED" ? "DZN" : "PAIR");
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
    .select(
      "from_u.id",
      "from_u.code",
      "from_u.name",
      "uc.factor",
    )
    .where({ "uc.to_uom_id": pairId, "uc.is_active": true, "from_u.is_active": true });

  const reverseRows = await trx("erp.uom_conversions as uc")
    .join("erp.uom as to_u", "to_u.id", "uc.to_uom_id")
    .select(
      "to_u.id",
      "to_u.code",
      "to_u.name",
      "uc.factor",
    )
    .where({ "uc.from_uom_id": pairId, "uc.is_active": true, "to_u.is_active": true });

  const byCode = new Map();
  const upsertOption = (row, factorToPair) => {
    const id = toPositiveInt(row?.id);
    const code = String(row?.code || "").trim().toUpperCase();
    const name = String(row?.name || "").trim();
    const factor = Number(factorToPair);
    if (!id || !code || !name || !Number.isFinite(factor) || factor <= 0) return;
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
  const lossType = String(value || "").trim().toUpperCase();
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
    throw new HttpError(400, "This voucher is auto-generated and cannot be created manually");
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
      String(err?.message || "").toLowerCase().includes("voucher_type_code");
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
  const normalizedSkuIds = [...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean))];
  if (!normalizedSkuIds.length) return new Map();

  const normalizedTypes = [...new Set((itemTypes || []).map((type) => String(type || "").trim().toUpperCase()).filter(Boolean))];

  let query = trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.sizes as sz", "sz.id", "v.size_id")
    .leftJoin("erp.colors as c", "c.id", "v.color_id")
    .leftJoin("erp.packing_types as pt", "pt.id", "v.packing_type_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .select(
      "s.id",
      "s.sku_code",
      "v.id as variant_id",
      "v.size_id",
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
  const normalizedSkuIds = [...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean))];
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
    .select("id", "item_id", "output_qty", "output_uom_id", "status", "version_no")
    .where({ item_id: normalizedItemId, status: "APPROVED" })
    .orderBy("version_no", "desc")
    .first();
};

const ensureApprovedBomExistsForSkusTx = async ({ trx, skuIds = [] }) => {
  const normalizedSkuIds = [...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean))];
  if (!normalizedSkuIds.length) return;

  const missingRows = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.bom_header as bh", function joinApprovedBom() {
      this.on("bh.item_id", "=", "i.id").andOn("bh.status", "=", trx.raw("?", ["APPROVED"]));
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
    .select("s.id", "v.size_id", "v.color_id", "v.packing_type_id", "i.id as item_id", "i.item_type")
    .where({ "s.id": normalizedSkuId, "s.is_active": true, "i.is_active": true })
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
  const hasStagesTable = await hasProductionStagesTableTx(trx);
  const hasBomSkuOverrideTable = await hasBomSkuOverrideTableTx(trx);

  const [rmLines, labourLines, stageRoutes, skuOverrides] = await Promise.all([
    trx("erp.bom_rm_line")
      .select("id", "rm_item_id", "color_id", "size_id", "dept_id", "qty", "uom_id", "normal_loss_pct")
      .where({ bom_id: bomHeader.id }),
    trx("erp.bom_labour_line")
      .select("id", "dept_id", "labour_id", "rate_type", "rate_value", "size_scope", "size_id")
      .where({ bom_id: bomHeader.id }),
    hasBomStageRouting && hasStagesTable
      ? trx("erp.bom_stage_routing as bsr")
          .join("erp.production_stages as ps", "ps.id", "bsr.stage_id")
          .select(
            "bsr.stage_id",
            "bsr.sequence_no",
            "bsr.is_required",
            "ps.dept_id",
            "ps.name as stage_name",
          )
          .where({ "bsr.bom_id": bomHeader.id })
          .andWhere("ps.is_active", true)
          .orderBy("bsr.sequence_no", "asc")
      : Promise.resolve([]),
    hasBomSkuOverrideTable
      ? trx("erp.bom_sku_override_line")
          .select("sku_id", "target_rm_item_id", "dept_id", "is_excluded", "override_qty", "override_uom_id", "replacement_rm_item_id", "rm_color_id", "rm_size_id")
          .where({ bom_id: bomHeader.id, sku_id: normalizedSkuId })
      : Promise.resolve([]),
  ]);

  const applicableLabourLines = labourLines.filter((line) => {
    const scope = String(line.size_scope || "ALL").trim().toUpperCase();
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
      rate_type: String(row.rate_type || LABOUR_RATE_TYPE.perPair).toUpperCase(),
      rate_value: Number(row.rate_value || 0),
    })),
    stageRoutes: (stageRoutes || []).map((row) => ({
      stage_id: Number(row.stage_id),
      sequence_no: Number(row.sequence_no || 0),
      is_required: row.is_required !== false,
      dept_id: Number(row.dept_id || 0) || null,
      stage_name: String(row.stage_name || ""),
    })),
  };
};

const resolveDcvStageTransitionForBomProfile = ({
  bomProfile,
  stageId,
  departmentId,
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  const normalizedDepartmentId = toPositiveInt(departmentId);
  const stageRoutes = Array.isArray(bomProfile?.stageRoutes) ? bomProfile.stageRoutes : [];
  if (!stageRoutes.length || !normalizedStageId) {
    return {
      hasStageRouting: false,
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
    throw new HttpError(400, "Selected stage does not match selected department in approved BOM");
  }

  const currentSeq = Number(currentRoute.sequence_no || 0);
  const previousRequiredRoute = [...orderedRoutes]
    .filter(
      (route) =>
        route.is_required !== false && Number(route.sequence_no || 0) < currentSeq,
    )
    .sort((a, b) => Number(b.sequence_no || 0) - Number(a.sequence_no || 0))[0];

  return {
    hasStageRouting: true,
    previousRequiredStageId: toPositiveInt(previousRequiredRoute?.stage_id),
    previousRequiredDeptId: toPositiveInt(previousRequiredRoute?.dept_id),
  };
};

const loadProductionDepartmentMapTx = async ({ trx, departmentIds = [] }) => {
  const normalizedDepartmentIds = [...new Set((departmentIds || []).map((id) => toPositiveInt(id)).filter(Boolean))];
  if (!normalizedDepartmentIds.length) return new Map();
  const rows = await trx("erp.departments")
    .select("id", "name", "is_production", "is_active")
    .whereIn("id", normalizedDepartmentIds);
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const validateDepartmentTx = async ({ trx, departmentId, requireProduction = true }) => {
  const normalizedDepartmentId = toPositiveInt(departmentId);
  if (!normalizedDepartmentId) throw new HttpError(400, "Department is required");
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
    throw new HttpError(400, "Selected stage does not belong to selected department");
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
    throw new HttpError(400, "No active production stage is mapped to the selected department");
  }
  if (rows.length > 1) {
    throw new HttpError(400, "Multiple active stages are mapped to the selected department");
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
    throw new HttpError(400, "Selected department is not allowed for this labour");
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
    .where({ reason_code_id: normalizedReasonCodeId, voucher_type_code: voucherTypeCode })
    .first();
  const hasMapping = Boolean(mapping);
  const mappingCountRow = await trx("erp.reason_code_voucher_type_map")
    .count({ value: "*" })
    .where({ reason_code_id: normalizedReasonCodeId })
    .first();
  const mappingCount = Number(mappingCountRow?.value || 0);
  if (mappingCount > 0 && !hasMapping) {
    throw new HttpError(400, "Reason code is not allowed for this voucher type");
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

  const skuIds = lines.map((line) => toPositiveInt(line?.sku_id || line?.skuId)).filter(Boolean);
  const uniqueSkuIds = [...new Set(skuIds)];
  const skuMap = await loadSkuMapTx({ trx, skuIds: uniqueSkuIds, itemTypes: [targetItemType] });
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
    if (!qty) throw new HttpError(400, `Line ${lineNo}: quantity must be greater than zero`);

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
    if (rate === null) throw new HttpError(400, `Line ${lineNo}: rate is invalid`);
    const inputAmount = toNonNegativeNumber(line?.amount, 2);
    if (inputAmount === null) throw new HttpError(400, `Line ${lineNo}: amount is invalid`);
    const amount = Number((inputAmount > 0 ? inputAmount : Number(qty) * Number(rate)).toFixed(2));
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

  const skuIds = lines.map((line) => toPositiveInt(line?.sku_id || line?.skuId)).filter(Boolean);
  const uniqueSkuIds = [...new Set(skuIds)];
  const skuMap = await loadSkuMapTx({ trx, skuIds: uniqueSkuIds, itemTypes: ["FG", "SFG"] });
  if (skuMap.size !== uniqueSkuIds.length) {
    throw new HttpError(400, "One or more selected SKUs are invalid");
  }

  const unitByCode = new Map(
    (Array.isArray(dcvUnits) ? dcvUnits : [])
      .map((row) => {
        const code = String(row?.code || "").trim().toUpperCase();
        const id = toPositiveInt(row?.id);
        const factor = Number(row?.factor_to_pair || 0);
        if (!code || !id || !Number.isFinite(factor) || factor <= 0) return null;
        return [code, { id, code, factorToPair: factor }];
      })
      .filter(Boolean),
  );

  if (!unitByCode.has("PAIR")) {
    throw new HttpError(400, "PAIR unit is not configured for production");
  }

  const t = req?.res?.locals?.t;

  return Promise.all(lines.map(async (line, index) => {
    const lineNo = Number(index + 1);
    const skuId = toPositiveInt(line?.sku_id || line?.skuId);
    const sku = skuMap.get(Number(skuId));
    if (!sku) throw new HttpError(400, `Line ${lineNo}: SKU is invalid`);

    const requestedUnitCode = String(line?.unit || line?.entry_unit || statusToUnit(line?.status)).trim().toUpperCase() || "PAIR";
    const resolvedUnit = unitByCode.get(requestedUnitCode);
    if (!resolvedUnit) {
      throw new HttpError(400, `Line ${lineNo}: selected unit is invalid for Pair conversion`);
    }

    const qty = toPositiveNumber(line?.qty, 3);
    if (!qty) throw new HttpError(400, `Line ${lineNo}: quantity must be greater than zero`);

    const rawPairs = Number(qty) * Number(resolvedUnit.factorToPair);
    const totalPairs = Number(rawPairs.toFixed(3));
    if (!Number.isInteger(totalPairs)) {
      throw new HttpError(400, `Line ${lineNo}: quantity must convert to whole pairs`);
    }

    const resolvedRatePayload = await resolveDcvRateForSku({
      req,
      labourId,
      deptId,
      skuId: Number(skuId),
      unitCode: resolvedUnit.code,
    });
    if (!resolvedRatePayload?.found || Number(resolvedRatePayload?.rate || 0) <= 0) {
      const skuLabel = buildSkuDisplayLabel(sku);
      const fallback = `Line ${lineNo}: Labour rate is missing for ${skuLabel}. Please add Labour+Department+SKU rate in Labour Rates.`;
      const localizedTemplate = typeof t === "function" ? t("error_dcv_missing_labour_rate_for_sku") : "";
      const message =
        String(localizedTemplate || "").trim()
          ? String(localizedTemplate).replace("{line}", String(lineNo)).replace("{sku}", String(skuLabel))
          : fallback;
      throw new HttpError(400, message);
    }
    const rate = Number(resolvedRatePayload?.rate || 0);
    const safeRate = Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(4)) : 0;
    const amount = Number((Number(qty) * safeRate).toFixed(2));
    const normalizedStatus = isDozenEquivalentFactor(resolvedUnit.factorToPair) ? "PACKED" : "LOOSE";

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
  }));
};

const validateDcvStageFlowTx = async ({
  trx,
  req,
  stageId,
  departmentId,
  lines = [],
}) => {
  const normalizedStageId = toPositiveInt(stageId);
  const normalizedDepartmentId = toPositiveInt(departmentId);
  if (!normalizedStageId || !normalizedDepartmentId || !Array.isArray(lines) || !lines.length) {
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
  const [skuDisplayMap] = await Promise.all([
    loadSkuDisplayMapTx({ trx, skuIds }),
  ]);
  const bomProfileBySku = new Map();

  for (const skuId of skuIds) {
    let bomProfile = bomProfileBySku.get(skuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` });
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomProfileBySku.set(skuId, bomProfile);
    }

    const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` });
    const stageFlow = resolveDcvStageTransitionForBomProfile({
      bomProfile,
      stageId: normalizedStageId,
      departmentId: normalizedDepartmentId,
    });

    if (!stageFlow.hasStageRouting || !stageFlow.previousRequiredDeptId) continue;

    const requiredPairs = Number(linePairsBySku.get(skuId) || 0);
    const pool = await getCurrentWipBalanceTx({
      trx,
      branchId: req.branchId,
      skuId,
      deptId: stageFlow.previousRequiredDeptId,
    });
    const availablePairs = Number(pool?.qty_pairs || 0);
    if (availablePairs < requiredPairs) {
      throw new HttpError(
        400,
        `Stage flow blocked for SKU ${skuLabel}: previous stage WIP is insufficient`,
      );
    }
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

  if (normalizedLossType === "DVC_ABANDON") {
    const dept = await trx("erp.departments")
      .select("id", "is_active", "is_production")
      .where({ id: normalizedHeaderDeptId })
      .first();
    if (!dept || dept.is_active !== true || dept.is_production !== true) {
      throw new HttpError(400, "Production department is required for DVC abandon");
    }
  }

  const rmItemIds = [];
  const skuIds = [];
  lines.forEach((line) => {
    if (normalizedLossType === "RM_LOSS") {
      const itemId = toPositiveInt(line?.item_id || line?.itemId);
      if (itemId) rmItemIds.push(itemId);
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

  const skuMap = await loadSkuMapTx({ trx, skuIds, itemTypes: ["FG", "SFG"] });

  return Promise.all(
    lines.map(async (line, index) => {
      const lineNo = Number(index + 1);
      const lossType = normalizedLossType;

      const qty = toPositiveNumber(line?.qty, 3);
      if (!qty) throw new HttpError(400, `Line ${lineNo}: quantity must be greater than zero`);
      const rate = toNonNegativeNumber(line?.rate, 4);
      if (rate === null) throw new HttpError(400, `Line ${lineNo}: rate is invalid`);
      const inputAmount = toNonNegativeNumber(line?.amount, 2);
      if (inputAmount === null) throw new HttpError(400, `Line ${lineNo}: amount is invalid`);
      const amount = Number((inputAmount > 0 ? inputAmount : Number(qty) * Number(rate)).toFixed(2));

      if (lossType === "RM_LOSS") {
        const itemId = toPositiveInt(line?.item_id || line?.itemId);
        const item = itemMap.get(Number(itemId || 0));
        if (!item || String(item.item_type || "").toUpperCase() !== "RM") {
          throw new HttpError(400, `Line ${lineNo}: raw material is invalid`);
        }
        return {
          line_no: lineNo,
          line_kind: "ITEM",
          item_id: Number(itemId),
          uom_id: toPositiveInt(line?.uom_id || line?.uomId),
          qty: Number(qty.toFixed(3)),
          rate: Number(rate.toFixed(4)),
          amount,
          meta: {},
          loss_type: lossType,
          dept_id: null,
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
        throw new HttpError(400, `Line ${lineNo}: SFG loss requires an SFG SKU`);
      }

      let deptId = null;
      if (lossType === "DVC_ABANDON") {
        deptId = normalizedHeaderDeptId;
        if (!deptId) throw new HttpError(400, "Production department is required for DVC abandon");

        const pool = await trx("erp.wip_dept_balance")
          .select("qty_pairs")
          .where({
            branch_id: req.branchId,
            sku_id: Number(skuId),
            dept_id: Number(deptId),
          })
          .first();

        if (Number(pool?.qty_pairs || 0) < Number(qty)) {
          throw new HttpError(400, `Line ${lineNo}: abandon quantity exceeds pending WIP balance`);
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
    const stageId = toPositiveInt(line?.stage_id || line?.stageId || line?.meta?.stage_id);
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
  payload = {},
}) => {
  const voucherDate = toDateOnly(payload?.voucher_date || payload?.voucherDate);
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  const remarks = normalizeText(payload?.remarks || payload?.description, 1000);
  const referenceNo = normalizeText(payload?.reference_no || payload?.referenceNo, 120);

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction || voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction) {
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
    const requestedStageId = toPositiveInt(payload?.stage_id || payload?.stageId);
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
    const planKind = String(payload?.plan_kind || payload?.planKind || "FG").trim().toUpperCase();
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
    .returning(["id", "line_no", "line_kind", "item_id", "sku_id", "labour_id"]);
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
    if (supportsDcvStage) dcvPayload.stage_id = toPositiveInt(validated.stageId);
    await trx("erp.dcv_header")
      .insert(dcvPayload)
      .onConflict("voucher_id")
      .merge(supportsDcvStage ? ["dept_id", "labour_id", "stage_id"] : ["dept_id", "labour_id"]);
    return;
  }

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction || voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction) {
    const productionLineRows = validated.lines
      .map((line) => {
        const voucherLineId = lineByNo.get(Number(line.line_no));
        if (!voucherLineId) return null;
        return {
          voucher_line_id: Number(voucherLineId),
          is_packed: line.is_packed === true,
          total_pairs: Number(line.total_pairs || 0),
          ...(supportsProductionStage ? { stage_id: toPositiveInt(line.stage_id) } : {}),
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
          ...(supportsLossStage ? { stage_id: toPositiveInt(line.stage_id) } : {}),
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
      cost_value: trx.raw("greatest(cost_value + ?, 0)", [Number(costDelta || 0)]),
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
    .select("id", "branch_id", "sku_id", "dept_id", "direction", "qty_pairs", "cost_value", "txn_date")
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
  const unitCost = availablePairs > 0 ? Number((availableCost / availablePairs).toFixed(6)) : 0;
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
  const stageRoutes = Array.isArray(bomProfile?.stageRoutes) ? bomProfile.stageRoutes : [];
  const stageDeptIds = normalizedStageId
    ? [...new Set(
        stageRoutes
          .filter((route) => Number(route.stage_id) === Number(normalizedStageId))
          .map((route) => Number(route.dept_id || 0))
          .filter((deptId) => Number.isInteger(deptId) && deptId > 0),
      )]
    : [];

  const deptIds = new Set();
  if (stageDeptIds.length) {
    stageDeptIds.forEach((deptId) => deptIds.add(Number(deptId)));
  } else {
    (bomProfile?.rmLines || []).forEach((line) => deptIds.add(Number(line.dept_id)));
    (bomProfile?.labourLines || []).forEach((line) => deptIds.add(Number(line.dept_id)));
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
    const shortfallPairs = Math.max(0, Number(totalPairs || 0) - Number(allocated.consumedPairs || 0));
    result.push({
      dept_id: Number(deptId),
      shortfall_pairs: Number(shortfallPairs),
      pool_consumed_pairs: Number(allocated.consumedPairs || 0),
      pool_consumed_cost: Number(allocated.consumedCost || 0),
    });
  }
  return result;
};

const buildConsumptionLinesFromShortfall = ({ lineNoStart = 1, skuLine, shortfallPlan, bomProfile }) => {
  const lines = [];
  let lineNo = lineNoStart;
  const outputQty = Number(bomProfile?.outputQty || 1) > 0 ? Number(bomProfile.outputQty) : 1;
  const outputFactorToPair = Number(bomProfile?.outputUomFactorToPair || 1) > 0
    ? Number(bomProfile.outputUomFactorToPair)
    : 1;
  const outputQtyInPairs = Number((outputQty * outputFactorToPair).toFixed(6)) > 0
    ? Number((outputQty * outputFactorToPair).toFixed(6))
    : 1;

  for (const deptPlan of shortfallPlan) {
    const shortfallPairs = Number(deptPlan.shortfall_pairs || 0);
    if (shortfallPairs <= 0) continue;
    const ratio = Number((shortfallPairs / outputQtyInPairs).toFixed(6));
    const deptRmLines = (bomProfile?.rmLines || []).filter((row) => Number(row.dept_id) === Number(deptPlan.dept_id));
    for (const rm of deptRmLines) {
      const override = bomProfile?.skuOverrideByRmDept?.get(`${Number(rm.rm_item_id)}:${Number(rm.dept_id)}`) || null;
      if (override?.is_excluded === true) continue;
      const hasOverrideQty = Number.isFinite(Number(override?.override_qty)) && Number(override?.override_qty) >= 0;
      const baseQty = hasOverrideQty ? Number(override.override_qty) : Number(rm.qty || 0);
      if (baseQty <= 0) continue;
      const lossFactor = 1 + Number(rm.normal_loss_pct || 0) / 100;
      const qty = Number((baseQty * ratio * lossFactor).toFixed(3));
      if (qty <= 0) continue;
      const replacementItemId = toPositiveInt(override?.replacement_rm_item_id);
      const finalItemId = replacementItemId || Number(rm.rm_item_id);
      const finalUomId = toPositiveInt(override?.override_uom_id) || toPositiveInt(rm.uom_id);
      const finalColorId = toPositiveInt(override?.rm_color_id) || toPositiveInt(rm.color_id);
      const finalSizeId = toPositiveInt(override?.rm_size_id) || toPositiveInt(rm.size_id);
      const overrideApplied = Boolean(
        override
        && (
          override.is_excluded === true
          || replacementItemId
          || (hasOverrideQty && Math.abs(Number(override.override_qty) - Number(rm.qty || 0)) > 1e-9)
          || finalColorId !== toPositiveInt(rm.color_id)
          || finalSizeId !== toPositiveInt(rm.size_id)
        )
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
          adjusted_qty_rule_applied: hasOverrideQty && Math.abs(baseQty - Number(rm.qty || 0)) > 1e-9,
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

  const rmItemIds = [...new Set(
    normalizedLines
      .map((line) => toPositiveInt(line?.item_id))
      .filter(Boolean),
  )];
  if (!rmItemIds.length) return normalizedLines;

  const rows = await trx("erp.rm_purchase_rates as r")
    .select("r.rm_item_id", "r.color_id", "r.size_id", "r.purchase_rate", "r.avg_purchase_rate")
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
    const resolvedRate = Number.isFinite(avgRate) && avgRate > 0 ? avgRate : purchaseRate;
    if (!Number.isFinite(resolvedRate) || resolvedRate <= 0) return;
    rateByIdentity.set(`${rmItemId}:${colorId}:${sizeId}`, Number(resolvedRate.toFixed(4)));
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
    const amount = resolvedRate > 0 ? Number((qty * resolvedRate).toFixed(2)) : 0;
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

const buildLabourLinesFromShortfall = ({ lineNoStart = 1, skuLine, shortfallPlan, bomProfile }) => {
  const lines = [];
  let lineNo = lineNoStart;

  for (const deptPlan of shortfallPlan) {
    const shortfallPairs = Number(deptPlan.shortfall_pairs || 0);
    if (shortfallPairs <= 0) continue;
    const deptLabourLines = (bomProfile?.labourLines || []).filter((row) => Number(row.dept_id) === Number(deptPlan.dept_id));
    for (const labour of deptLabourLines) {
      const rateValue = Number(labour.rate_value || 0);
      const ratePerPair =
        String(labour.rate_type || LABOUR_RATE_TYPE.perPair).toUpperCase() === LABOUR_RATE_TYPE.perDozen
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
        lines.map((line) => [Number(line.line_no), toPositiveInt(line.dept_id || line?.meta?.department_id)]),
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
  const stageId = toPositiveInt(header.stage_id) || await resolveActiveStageForDepartmentTx({
    trx,
    departmentId: deptId,
    allowNull: true,
  });
  const lines = await trx("erp.voucher_line")
    .select("line_no", "sku_id", "qty", "amount")
    .where({ voucher_header_id: voucherId, line_kind: "SKU" });

  const skuDisplayMap = await loadSkuDisplayMapTx({
    trx,
    skuIds: lines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
  });
  const bomProfileBySku = new Map();

  for (const line of lines) {
    const skuId = Number(line.sku_id || 0);
    const lineNo = Number(line.line_no || 0) || 0;
    const qtyPairs = Number(line.qty || 0);
    if (!Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;

    let bomProfile = bomProfileBySku.get(skuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` });
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomProfileBySku.set(skuId, bomProfile);
    }

    const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` });
    const stageFlow = resolveDcvStageTransitionForBomProfile({
      bomProfile,
      stageId,
      departmentId: deptId,
    });

    let previousStageCost = 0;
    if (stageFlow.hasStageRouting && stageFlow.previousRequiredDeptId) {
      const allocated = await allocateFromWipPoolTx({
        trx,
        branchId,
        skuId,
        deptId: stageFlow.previousRequiredDeptId,
        targetPairs: qtyPairs,
        voucherDate,
        sourceVoucherId: voucherId,
      });
      if (Number(allocated.consumedPairs || 0) < qtyPairs) {
        throw new HttpError(
          400,
          `Line ${lineNo}: stage flow blocked for SKU ${skuLabel}; previous stage WIP is insufficient`,
        );
      }
      previousStageCost = Number(allocated.consumedCost || 0);
    }

    const ownStageCost = Number(Number(line.amount || 0).toFixed(2));
    const costValue = Number((previousStageCost + ownStageCost).toFixed(2));
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
  }
};

const applyDcvToGeneratedVouchersTx = async ({
  trx,
  voucherId,
  branchId,
  voucherDate,
  createdBy,
  voucherNo,
}) => {
  const header = await trx("erp.dcv_header")
    .select("dept_id", "stage_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!header) return;

  const deptId = toPositiveInt(header.dept_id);
  const stageId = toPositiveInt(header.stage_id) || await resolveActiveStageForDepartmentTx({
    trx,
    departmentId: deptId,
    allowNull: true,
  });
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
  let consumptionLineNo = 1;

  for (const line of lines) {
    const skuId = toPositiveInt(line.sku_id);
    const lineMeta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const qtyPairs = Number(lineMeta.total_pairs || line.qty || 0);
    if (!skuId || !Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;

    let bomProfile = bomBySku.get(skuId);
    if (!bomProfile) {
      bomProfile = await loadBomProfileBySkuTx({ trx, skuId });
      if (!bomProfile) {
        const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_code: `#${skuId}` });
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
      unit: String(lineMeta.unit || "").trim().toUpperCase() || null,
      status: String(lineMeta.status || "").trim().toUpperCase() || null,
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
    .select("alln.loss_type", "alln.dept_id", "vl.sku_id", "vl.qty")
    .where("vl.voucher_header_id", voucherId)
    .andWhere("alln.loss_type", "DVC_ABANDON");

  for (const row of rows) {
    const deptId = toPositiveInt(row.dept_id);
    const skuId = toPositiveInt(row.sku_id);
    const qtyPairs = Number(row.qty || 0);
    if (!deptId || !skuId || !Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;

    const balance = await getCurrentWipBalanceTx({
      trx,
      branchId,
      skuId,
      deptId,
    });
    const availablePairs = Number(balance?.qty_pairs || 0);
    const availableCost = Number(balance?.cost_value || 0);
    if (availablePairs < qtyPairs) {
      throw new HttpError(400, `DVC abandon quantity exceeds pending WIP balance for SKU ${skuId}`);
    }

    const unitCost = availablePairs > 0 ? Number((availableCost / availablePairs).toFixed(6)) : 0;
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

const applyProductionToGeneratedVouchersTx = async ({
  trx,
  voucherId,
  branchId,
  voucherDate,
  createdBy,
  voucherNo,
}) => {
  const supportsProductionStage = await hasProductionLineStageColumnTx(trx);
  const productionLines = await trx("erp.voucher_line as vl")
    .join("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .select("vl.line_no", "vl.sku_id", "vl.qty", "pl.total_pairs", ...(supportsProductionStage ? ["pl.stage_id"] : []))
    .where("vl.voucher_header_id", voucherId)
    .orderBy("vl.line_no", "asc");

  if (!productionLines.length) return;

  const bomBySku = new Map();
  const skuDisplayMap = await loadSkuDisplayMapTx({
    trx,
    skuIds: productionLines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
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
        const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_id: skuId });
        throw new HttpError(400, `Approved BOM not found for SKU ${skuLabel}`);
      }
      bomBySku.set(skuId, bomProfile);
    }

    const hasStageRouting = Array.isArray(bomProfile.stageRoutes) && bomProfile.stageRoutes.length > 0;
    if (hasStageRouting && !stageId) {
      const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_id: skuId });
      throw new HttpError(400, `Stage is required for SKU ${skuLabel}`);
    }
    if (hasStageRouting && stageId) {
      const mappedRoutes = bomProfile.stageRoutes.filter((route) => Number(route.stage_id) === Number(stageId));
      const isStageMapped = mappedRoutes.length > 0;
      if (!isStageMapped) {
        const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_id: skuId });
        throw new HttpError(400, `Selected stage is not mapped in approved BOM for SKU ${skuLabel}`);
      }
      const hasMappedDept = mappedRoutes.some((route) => toPositiveInt(route.dept_id));
      if (!hasMappedDept) {
        const skuLabel = buildSkuDisplayLabel(skuDisplayMap.get(skuId) || { sku_id: skuId });
        throw new HttpError(400, `Selected stage has no production department mapped in approved BOM for SKU ${skuLabel}`);
      }
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
}) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);

  const header = await trx("erp.voucher_header")
    .select("id", "voucher_no", "branch_id", "voucher_date", "status", "created_by")
    .where({ id: normalizedVoucherId })
    .first();
  if (!header) return;
  if (String(header.status || "").toUpperCase() !== "APPROVED") return;

  if (
    normalizedVoucherTypeCode !== PRODUCTION_VOUCHER_TYPES.finishedProduction &&
    normalizedVoucherTypeCode !== PRODUCTION_VOUCHER_TYPES.semiFinishedProduction &&
    normalizedVoucherTypeCode !== PRODUCTION_VOUCHER_TYPES.departmentCompletion &&
    normalizedVoucherTypeCode !== PRODUCTION_VOUCHER_TYPES.abnormalLoss
  ) {
    return;
  }

  await rollbackWipLedgerBySourceVoucherTx({ trx, voucherId: normalizedVoucherId });

  if (
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
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
    });
    return;
  }

  if (normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion) {
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
  const policyRequiresApproval = await requiresApprovalForAction(trx, voucherTypeCode, action);

  const validated = await normalizeAndValidatePayloadTx({
    trx,
    req,
    voucherTypeCode,
    payload,
  });

  let headerId = toPositiveInt(voucherId);
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
    status = queuedForApproval ? String(existing.status || "PENDING").toUpperCase() : "APPROVED";
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

  await trx("erp.voucher_header")
    .where({ id: headerId })
    .update({
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

  await ensureProductionVoucherDerivedDataTx({
    trx,
    voucherId: headerId,
    voucherTypeCode,
    actorUserId: req.user.id,
  });

  await syncVoucherGlPostingTx({ trx, voucherId: headerId });

  return {
    id: headerId,
    voucherNo,
    status: "APPROVED",
    queuedForApproval: false,
    approvalRequestId: null,
    permissionReroute: false,
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
    await rollbackWipLedgerBySourceVoucherTx({ trx, voucherId: normalizedVoucherId });
  }

  await trx("erp.voucher_header")
    .where({ id: normalizedVoucherId })
    .update({
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

  const canDelete = canDo(req, "VOUCHER", scopeKey, "delete");
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

    const policyRequiresApproval = await requiresApprovalForAction(trx, voucherTypeCode, "delete");
    const queuedForApproval = !canDelete || (policyRequiresApproval && !canApprove);

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
  });
  await syncVoucherGlPostingTx({ trx, voucherId });
};

const getProductionVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
  const base = () =>
    knex("erp.voucher_header")
      .where({
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      });

  const [latestAny, latestActive] = await Promise.all([
    base().max({ value: "voucher_no" }).first(),
    base().whereNot({ status: "REJECTED" }).max({ value: "voucher_no" }).first(),
  ]);

  return {
    latestVoucherNo: Number(latestAny?.value || 0),
    latestActiveVoucherNo: Number(latestActive?.value || 0),
  };
};

const getProductionVoucherNeighbours = async ({ req, voucherTypeCode, cursorNo }) => {
  const normalized = Number(cursorNo || 0);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return { prevVoucherNo: null, nextVoucherNo: null };
  }

  const base = () =>
    knex("erp.voucher_header")
      .where({
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      });

  const [prevRow, nextRow] = await Promise.all([
    base().where("voucher_no", "<", normalized).max({ value: "voucher_no" }).first(),
    base().where("voucher_no", ">", normalized).min({ value: "voucher_no" }).first(),
  ]);

  return {
    prevVoucherNo: Number(prevRow?.value || 0) || null,
    nextVoucherNo: Number(nextRow?.value || 0) || null,
  };
};

const loadRecentProductionVouchers = async ({ req, voucherTypeCode }) => {
  const rows = await knex("erp.voucher_header")
    .select("id", "voucher_no", "voucher_date", "status", "remarks", "created_at")
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

const loadProductionVoucherDetails = async ({ req, voucherTypeCode, voucherNo }) => {
  const normalizedVoucherNo = parseVoucherNo(voucherNo);
  if (!normalizedVoucherNo) return null;

  const header = await knex("erp.voucher_header as vh")
    .select("vh.id", "vh.voucher_no", "vh.voucher_date", "vh.status", "vh.remarks", "vh.book_no", "vh.voucher_type_code")
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

  const rmColorIds = [...new Set(
    lines
      .map((line) => toPositiveInt(line?.meta?.rm_color_id))
      .filter(Boolean),
  )];
  const rmSizeIds = [...new Set(
    lines
      .map((line) => toPositiveInt(line?.meta?.rm_size_id))
      .filter(Boolean),
  )];
  const [rmColorRows, rmSizeRows] = await Promise.all([
    rmColorIds.length
      ? knex("erp.colors").select("id", "name").whereIn("id", rmColorIds)
      : Promise.resolve([]),
    rmSizeIds.length
      ? knex("erp.sizes").select("id", "name").whereIn("id", rmSizeIds)
      : Promise.resolve([]),
  ]);
  const rmColorNameById = new Map((rmColorRows || []).map((row) => [Number(row.id), String(row.name || "").trim()]));
  const rmSizeNameById = new Map((rmSizeRows || []).map((row) => [Number(row.id), String(row.name || "").trim()]));

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
      .select("ch.source_production_id", "pvh.voucher_no as source_production_no")
      .where({ "ch.voucher_id": header.id })
      .first();
  } else if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion
  ) {
    generatedLinks = await knex("erp.production_generated_links as pgl")
      .leftJoin("erp.voucher_header as cvh", "cvh.id", "pgl.consumption_voucher_id")
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

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction || voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction) {
    const extRows = await knex("erp.production_line")
      .select("voucher_line_id", "is_packed", "total_pairs", ...(supportsProductionStage ? ["stage_id"] : []))
      .whereIn("voucher_line_id", lines.map((line) => Number(line.id)));
    productionLineMap = new Map(extRows.map((row) => [Number(row.voucher_line_id), row]));
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.productionPlan) {
    const extRows = await knex("erp.production_plan_line")
      .select("voucher_line_id", "is_packed", "total_pairs")
      .whereIn("voucher_line_id", lines.map((line) => Number(line.id)));
    planLineMap = new Map(extRows.map((row) => [Number(row.voucher_line_id), row]));
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss) {
    const extRows = await knex("erp.abnormal_loss_line")
      .select("voucher_line_id", "loss_type", "dept_id", ...(supportsLossStage ? ["stage_id"] : []))
      .whereIn("voucher_line_id", lines.map((line) => Number(line.id)));
    lossLineMap = new Map(extRows.map((row) => [Number(row.voucher_line_id), row]));
  }

  let mappedLines = lines.map((line) => {
    const productionExt = productionLineMap.get(Number(line.id));
    const planExt = planLineMap.get(Number(line.id));
    const lossExt = lossLineMap.get(Number(line.id));
    const fallbackStatus = String(line?.meta?.status || "LOOSE").toUpperCase();
    const resolvedStatus =
      productionExt
        ? productionExt.is_packed
          ? "PACKED"
          : "LOOSE"
        : planExt
          ? planExt.is_packed
            ? "PACKED"
            : "LOOSE"
          : fallbackStatus;
    const fallbackUnit = String(line?.meta?.unit || "").trim().toUpperCase();
    const lineUomCode = String(line?.line_uom_code || "").trim().toUpperCase();
    const resolvedUnit = voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption
      ? (lineUomCode || fallbackUnit || statusToUnit(resolvedStatus))
      : (fallbackUnit || statusToUnit(resolvedStatus));
    const rmColorId = toPositiveInt(line?.meta?.rm_color_id);
    const rmSizeId = toPositiveInt(line?.meta?.rm_size_id);
    return {
      id: Number(line.id),
      line_no: Number(line.line_no || 0),
      line_kind: String(line.line_kind || "").toUpperCase(),
      item_id: toPositiveInt(line.item_id),
      item_name: line.item_name || "",
      rm_color_id: rmColorId,
      rm_color_name: rmColorId ? (rmColorNameById.get(Number(rmColorId)) || "") : "",
      rm_size_id: rmSizeId,
      rm_size_name: rmSizeId ? (rmSizeNameById.get(Number(rmSizeId)) || "") : "",
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
      total_pairs: Number(productionExt?.total_pairs || planExt?.total_pairs || line?.meta?.total_pairs || 0) || null,
      loss_type: String(lossExt?.loss_type || "").toUpperCase() || null,
      dept_id: toPositiveInt(lossExt?.dept_id || line?.meta?.department_id),
      stage_id: toPositiveInt(productionExt?.stage_id || lossExt?.stage_id || line?.meta?.stage_id),
    };
  });

  if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption && mappedLines.length) {
    mappedLines = await enrichConsumptionLinesWithRmRatesTx({
      trx: knex,
      lines: mappedLines,
    });
  }

  const abnormalLossType =
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss
      ? String(
          mappedLines.find((line) => String(line?.loss_type || "").trim())?.loss_type || "",
        )
          .trim()
          .toUpperCase() || null
      : null;
  const abnormalLossDeptId =
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss
      ? toPositiveInt(
          mappedLines.find((line) => toPositiveInt(line?.dept_id))?.dept_id,
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
    source_production_no: Number(sourceHeader?.source_production_no || 0) || null,
    generated_links: generatedLinks
      ? {
          consumption_voucher_id: toPositiveInt(generatedLinks.consumption_voucher_id),
          consumption_voucher_no: Number(generatedLinks.consumption_voucher_no || 0) || null,
        }
      : null,
    lines: mappedLines,
  };
};

const loadProductionVoucherOptions = async (req, { voucherTypeCode, selectedVoucher = null } = {}) => {
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);
  const isLoss = normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.abnormalLoss;
  const isPlan = normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.productionPlan;
  const isFg = normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction;
  const isSfg = normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction;
  const isConsumption = normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.consumption;
  const isLabourProd = normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.labourProduction;
  const isDcv = normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion;

  const [departments, labours, reasonCodes, rmItems, skus, sourceProductions, productionStages, dcvUnits] = await Promise.all([
    knex("erp.departments")
      .select("id", "name")
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
          .where(function reasonScope() {
            this.whereNotExists(function noMap() {
              this.select(1).from("erp.reason_code_voucher_type_map as m").whereRaw("m.reason_code_id = rc.id");
            }).orWhereExists(function allowedMap() {
              this.select(1)
                .from("erp.reason_code_voucher_type_map as m")
                .whereRaw("m.reason_code_id = rc.id")
                .andWhere("m.voucher_type_code", normalizedVoucherTypeCode);
            });
          })
          .orderBy("rc.name", "asc")
      : Promise.resolve([]),
    (isLoss || isConsumption)
      ? knex("erp.items")
          .select("id", "code", "name")
          .where({ is_active: true, item_type: "RM" })
          .orderBy("name", "asc")
      : Promise.resolve([]),
    (() => {
      let itemTypes = ["FG", "SFG"];
      if (isFg) itemTypes = ["FG"];
      if (isSfg) itemTypes = ["SFG"];
      if (isPlan) {
        const planKind = String(selectedVoucher?.plan_kind || "FG").toUpperCase();
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
          .select("vh.id", "vh.voucher_no", "vh.voucher_type_code", "vh.voucher_date")
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
    (isFg || isSfg || normalizedVoucherTypeCode === PRODUCTION_VOUCHER_TYPES.departmentCompletion || isLoss)
      ? loadActiveProductionStagesTx(knex)
      : Promise.resolve([]),
    isDcv ? loadPairConvertibleUomOptionsTx(knex) : Promise.resolve([]),
  ]);

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
    rmItems,
    skus,
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
      code: String(row.code || "").trim().toUpperCase(),
      name: String(row.name || "").trim(),
      factor_to_pair: Number(row.factor_to_pair || 0),
    })),
    isAutoGeneratedVoucher: AUTO_GENERATED_VOUCHER_TYPES.has(normalizedVoucherTypeCode),
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
    await validateLabourTx({ trx, req, labourId: normalizedLabourId, allowNull: false });
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
      .map((row) => [String(row.code || "").trim().toUpperCase(), row])
      .filter(([code, row]) => code && row?.id),
  );
  const normalizedUnitCode = String(unitCode || "").trim().toUpperCase();
  const selectedUnit = unitMap.get(normalizedUnitCode) || unitMap.get("PAIR") || (dcvUnits[0] || null);
  if (!selectedUnit) return { rate: 0, found: false, reason: "UNIT_NOT_CONFIGURED" };

  const sku = await knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id", "i.item_type", "i.subgroup_id", "i.group_id")
    .where({ "s.id": normalizedSkuId, "s.is_active": true, "i.is_active": true })
    .first();
  if (!sku) return { rate: 0, found: false, reason: "SKU_NOT_FOUND" };

  const skuItemType = String(sku.item_type || "").trim().toUpperCase();
  const hasArticleTypeColumn = await hasLabourRateRulesArticleTypeColumnTx(knex);
  let rulesQuery = knex("erp.labour_rate_rules as r")
    .select("r.id", "r.apply_on", "r.sku_id", "r.subgroup_id", "r.group_id", "r.rate_type", "r.rate_value")
    .where({
      "r.labour_id": normalizedLabourId,
      "r.dept_id": normalizedDeptId,
      "r.status": "active",
      "r.applies_to_all_labours": false,
    })
    .whereIn(knex.raw("upper(coalesce(r.apply_on::text, ''))"), ["SKU", "SUBGROUP", "GROUP"]);
  if (hasArticleTypeColumn) {
    rulesQuery = rulesQuery.select("r.article_type");
  }
  const rules = await rulesQuery.orderBy("r.id", "desc");

  const matchesArticleType = (row) => {
    if (!hasArticleTypeColumn) return true;
    const articleType = String(row?.article_type || "").trim().toUpperCase();
    if (!articleType || articleType === "BOTH") return true;
    return articleType === skuItemType;
  };
  const matchesScope = (row, scope) => {
    const applyOn = String(row?.apply_on || "").trim().toUpperCase();
    if (applyOn !== scope) return false;
    if (scope === "SKU") return Number(row?.sku_id || 0) === Number(normalizedSkuId);
    if (scope === "SUBGROUP") return Number(row?.subgroup_id || 0) === Number(sku.subgroup_id || 0);
    if (scope === "GROUP") return Number(row?.group_id || 0) === Number(sku.group_id || 0);
    return false;
  };

  let matchedRule = null;
  for (const scope of ["SKU", "SUBGROUP", "GROUP"]) {
    matchedRule = (rules || []).find((row) => matchesArticleType(row) && matchesScope(row, scope)) || null;
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

  const sourceRateType = String(matchedRule.rate_type || "PER_PAIR").trim().toUpperCase();
  const sourceRateValue = Number(matchedRule.rate_value || 0);
  const factorToPair = Number(selectedUnit.factor_to_pair || 0);
  if (!Number.isFinite(sourceRateValue) || sourceRateValue < 0 || !Number.isFinite(factorToPair) || factorToPair <= 0) {
    return { rate: 0, found: false, reason: "INVALID_RATE_SOURCE" };
  }

  const ratePerPair = sourceRateType === "PER_DOZEN"
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

module.exports = {
  PRODUCTION_VOUCHER_TYPES,
  parseVoucherNo,
  isProductionVoucherType,
  createProductionVoucher,
  updateProductionVoucher,
  deleteProductionVoucher,
  loadProductionVoucherOptions,
  resolveDcvRateForSku,
  loadRecentProductionVouchers,
  getProductionVoucherSeriesStats,
  getProductionVoucherNeighbours,
  loadProductionVoucherDetails,
  ensureProductionVoucherDerivedDataTx,
  applyProductionVoucherUpdatePayloadTx,
  applyProductionVoucherDeletePayloadTx,
};
