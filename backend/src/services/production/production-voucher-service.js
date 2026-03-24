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
  PRODUCTION_VOUCHER_TYPES.finishedProduction,
  PRODUCTION_VOUCHER_TYPES.semiFinishedProduction,
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

const resolveProductionUnitAndStatus = (line = {}) => {
  const normalizedUnit = normalizeRowUnit(line?.unit || line?.entry_unit);
  const fallbackStatus = normalizeRowStatus(line?.status || line?.row_status);
  const unit = normalizedUnit || statusToUnit(fallbackStatus);
  const status = unitToStatus(unit);
  return { unit, status };
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
    .select("id", "item_id", "output_qty", "status", "version_no")
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
  const hasBomStageRouting = await hasBomStageRoutingTableTx(trx);
  const hasStagesTable = await hasProductionStagesTableTx(trx);

  const [rmLines, labourLines, stageRoutes] = await Promise.all([
    trx("erp.bom_rm_line")
      .select("id", "rm_item_id", "dept_id", "qty", "uom_id", "normal_loss_pct")
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
  ]);

  const applicableLabourLines = labourLines.filter((line) => {
    const scope = String(line.size_scope || "ALL").trim().toUpperCase();
    if (scope !== "SPECIFIC") return true;
    return Number(line.size_id || 0) === Number(sku.size_id || 0);
  });

  return {
    skuId: normalizedSkuId,
    skuSizeId: Number(sku.size_id || 0) || null,
    skuColorId: Number(sku.color_id || 0) || null,
    skuPackingTypeId: Number(sku.packing_type_id || 0) || null,
    itemId: Number(sku.item_id),
    itemType: String(sku.item_type || "").toUpperCase(),
    bomId: Number(bomHeader.id),
    outputQty: Number(bomHeader.output_qty || 1),
    rmLines: rmLines.map((row) => ({
      id: Number(row.id),
      rm_item_id: Number(row.rm_item_id),
      dept_id: Number(row.dept_id),
      qty: Number(row.qty || 0),
      uom_id: toPositiveInt(row.uom_id),
      normal_loss_pct: Number(row.normal_loss_pct || 0),
    })),
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
  const skuMap = await loadSkuMapTx({ trx, skuIds, itemTypes: [targetItemType] });
  if (skuMap.size !== skuIds.length) {
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

const checkPreviousStageCompletionTx = async ({ trx, bomId, currentSequenceNo }) => {
  if (currentSequenceNo <= 1) return { valid: true, missingStage: null };

  try {
    const dcvWithPreviousStage = await trx("erp.dcv_header as dh")
      .join("erp.voucher_header as vh", "vh.id", "dh.voucher_id")
      .join("erp.bom_stage_routing as bsr", function joinStage() {
        this.on("dh.stage_id", "bsr.stage_id")
          .andOn("bsr.bom_id", trx.raw("?", [bomId]));
      })
      .join("erp.production_stages as ps", "ps.id", "dh.stage_id")
      .select("bsr.sequence_no", "ps.name as stage_name")
      .where("vh.status", "APPROVED")
      .andWhere("bsr.sequence_no", "<", currentSequenceNo)
      .orderBy("bsr.sequence_no", "desc")
      .first();

    if (!dcvWithPreviousStage) {
      const previousStageInfo = await trx("erp.bom_stage_routing as bsr")
        .join("erp.production_stages as ps", "ps.id", "bsr.stage_id")
        .select("bsr.sequence_no", "ps.name")
        .where({ "bsr.bom_id": bomId })
        .andWhere("bsr.sequence_no", "=", currentSequenceNo - 1)
        .first();

      const missingStage = previousStageInfo
        ? { sequence: previousStageInfo.sequence_no, name: previousStageInfo.name }
        : { sequence: currentSequenceNo - 1, name: "Previous stage" };

      return { valid: false, missingStage };
    }

    return { valid: true, missingStage: null };
  } catch (err) {
    return { valid: true, missingStage: null };
  }
};

const validateDcvLinesTx = async ({ trx, rawLines = [], stageId = null }) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const skuIds = lines.map((line) => toPositiveInt(line?.sku_id || line?.skuId)).filter(Boolean);
  const skuMap = await loadSkuMapTx({ trx, skuIds, itemTypes: ["FG", "SFG"] });
  if (skuMap.size !== skuIds.length) {
    throw new HttpError(400, "One or more selected SKUs are invalid");
  }

  const normalizedStageId = toPositiveInt(stageId);

  return Promise.all(
    lines.map(async (line, index) => {
      const lineNo = Number(index + 1);
      const skuId = toPositiveInt(line?.sku_id || line?.skuId);
      const sku = skuMap.get(Number(skuId));
      if (!sku) throw new HttpError(400, `Line ${lineNo}: SKU is invalid`);

      const qty = toPositiveNumber(line?.qty, 3);
      if (!qty) throw new HttpError(400, `Line ${lineNo}: quantity must be greater than zero`);
      if (!Number.isInteger(Number(qty))) {
        throw new HttpError(400, `Line ${lineNo}: quantity must be whole pairs`);
      }

      const rate = toNonNegativeNumber(line?.rate, 4);
      if (rate === null) throw new HttpError(400, `Line ${lineNo}: rate is invalid`);
      const inputAmount = toNonNegativeNumber(line?.amount, 2);
      if (inputAmount === null) throw new HttpError(400, `Line ${lineNo}: amount is invalid`);
      const amount = Number((inputAmount > 0 ? inputAmount : Number(qty) * Number(rate)).toFixed(2));

      if (normalizedStageId) {
        const bomProfile = await loadBomProfileBySkuTx({ trx, skuId: Number(skuId) });
        if (bomProfile && bomProfile.stageRoutes && bomProfile.stageRoutes.length > 0) {
          const currentStageRoute = bomProfile.stageRoutes.find(
            (route) => Number(route.stage_id) === normalizedStageId
          );

          if (currentStageRoute) {
            const seqCheck = await checkPreviousStageCompletionTx({
              trx,
              bomId: bomProfile.bomId,
              currentSequenceNo: currentStageRoute.sequence_no,
            });

            if (!seqCheck.valid) {
              throw new HttpError(
                400,
                `Line ${lineNo}: Cannot complete stage before ${seqCheck.missingStage.name} (Stage ${seqCheck.missingStage.sequence}) is completed`
              );
            }
          }
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
        meta: {
          status: "LOOSE",
          total_pairs: Number(qty),
        },
        status: "LOOSE",
        is_packed: false,
        total_pairs: Number(qty),
      };
    })
  );
};

const validateLossLinesTx = async ({ trx, req, rawLines = [] }) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const rmItemIds = [];
  const skuIds = [];
  const deptIds = [];

  lines.forEach((line) => {
    const lossType = normalizeLossType(line?.loss_type || line?.lossType);
    if (lossType === "RM_LOSS") {
      const itemId = toPositiveInt(line?.item_id || line?.itemId);
      if (itemId) rmItemIds.push(itemId);
    } else {
      const skuId = toPositiveInt(line?.sku_id || line?.skuId);
      if (skuId) skuIds.push(skuId);
      if (lossType === "DVC_ABANDON") {
        const deptId = toPositiveInt(line?.dept_id || line?.department_id);
        if (deptId) deptIds.push(deptId);
      }
    }
  });

  const itemRows = rmItemIds.length
    ? await trx("erp.items")
        .select("id", "item_type", "name")
        .whereIn("id", [...new Set(rmItemIds)])
        .where({ is_active: true })
    : [];
  const itemMap = new Map(itemRows.map((row) => [Number(row.id), row]));

  const skuMap = await loadSkuMapTx({ trx, skuIds, itemTypes: ["FG", "SFG"] });
  const deptMap = await loadProductionDepartmentMapTx({ trx, departmentIds: deptIds });

  return Promise.all(
    lines.map(async (line, index) => {
      const lineNo = Number(index + 1);
      const lossType = normalizeLossType(line?.loss_type || line?.lossType);
      if (!lossType) throw new HttpError(400, `Line ${lineNo}: loss type is invalid`);

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
        deptId = toPositiveInt(line?.dept_id || line?.department_id);
        const dept = deptMap.get(Number(deptId || 0));
        if (!dept || dept.is_active !== true || dept.is_production !== true) {
          throw new HttpError(400, `Line ${lineNo}: production department is required for DVC abandon`);
        }

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
    const stageId = await validateStageTx({
      trx,
      stageId: payload?.stage_id || payload?.stageId,
      departmentId: deptId,
      allowNull: !(await hasDcvHeaderStageColumnTx(trx)),
    });
    const lines = await validateDcvLinesTx({
      trx,
      rawLines: payload?.lines,
      stageId,
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
    const reasonCodeId = await validateReasonCodeTx({
      trx,
      reasonCodeId: payload?.reason_code_id,
      voucherTypeCode,
    });
    const lines = await validateLossLinesTx({
      trx,
      req,
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
      planKind: null,
      reasonCodeId,
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

  for (const deptPlan of shortfallPlan) {
    const shortfallPairs = Number(deptPlan.shortfall_pairs || 0);
    if (shortfallPairs <= 0) continue;
    const ratio = Number((shortfallPairs / outputQty).toFixed(6));
    const deptRmLines = (bomProfile?.rmLines || []).filter((row) => Number(row.dept_id) === Number(deptPlan.dept_id));
    for (const rm of deptRmLines) {
      const baseQty = Number(rm.qty || 0);
      if (baseQty <= 0) continue;
      const lossFactor = 1 + Number(rm.normal_loss_pct || 0) / 100;
      const qty = Number((baseQty * ratio * lossFactor).toFixed(3));
      if (qty <= 0) continue;
      lines.push({
        line_no: lineNo,
        line_kind: "ITEM",
        item_id: Number(rm.rm_item_id),
        uom_id: toPositiveInt(rm.uom_id),
        qty,
        rate: 0,
        amount: 0,
        meta: {
          department_id: Number(deptPlan.dept_id),
          source_sku_id: Number(skuLine.sku_id),
          stage_id: toPositiveInt(skuLine.stage_id),
          shortfall_pairs: shortfallPairs,
          auto_generated: true,
          bom_id: Number(bomProfile.bomId),
          adjusted_qty_rule_applied: false,
          replacement_rule_applied: false,
          sku_override_applied: false,
          rm_color_id: null,
        },
      });
      lineNo += 1;
    }
  }

  return lines;
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
  productionVoucherId,
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
      source_production_id: productionVoucherId,
    });
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.labourProduction) {
    await trx("erp.labour_voucher_header").insert({
      voucher_id: voucherId,
      source_production_id: productionVoucherId,
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
    .select("dept_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!header) return;

  const deptId = Number(header.dept_id);
  const lines = await trx("erp.voucher_line")
    .select("sku_id", "qty", "amount")
    .where({ voucher_header_id: voucherId, line_kind: "SKU" });

  for (const line of lines) {
    const skuId = Number(line.sku_id || 0);
    const qtyPairs = Number(line.qty || 0);
    if (!Number.isInteger(qtyPairs) || qtyPairs <= 0) continue;
    const costValue = Number(Number(line.amount || 0).toFixed(2));
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
  const labourLines = [];
  let consumptionLineNo = 1;
  let labourLineNo = 1;

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

    const nextLabourLines = buildLabourLinesFromShortfall({
      lineNoStart: labourLineNo,
      skuLine: line,
      shortfallPlan,
      bomProfile,
    });
    labourLines.push(...nextLabourLines);
    labourLineNo += nextLabourLines.length;
  }

  const consumptionVoucher = await createAutoChildVoucherTx({
    trx,
    branchId,
    voucherDate,
    createdBy,
    productionVoucherId: voucherId,
    voucherNoSource: voucherNo,
    voucherTypeCode: PRODUCTION_VOUCHER_TYPES.consumption,
    remarks: `[AUTO] Consumption from production #${voucherNo}`,
    lines: consumptionLines,
  });

  const labourVoucher = await createAutoChildVoucherTx({
    trx,
    branchId,
    voucherDate,
    createdBy,
    productionVoucherId: voucherId,
    voucherNoSource: voucherNo,
    voucherTypeCode: PRODUCTION_VOUCHER_TYPES.labourProduction,
    remarks: `[AUTO] Labour from production #${voucherNo}`,
    lines: labourLines,
  });

  await trx("erp.production_generated_links")
    .insert({
      production_voucher_id: voucherId,
      consumption_voucher_id: consumptionVoucher?.voucherId || null,
      labour_voucher_id: labourVoucher?.voucherId || null,
    })
    .onConflict("production_voucher_id")
    .merge(["consumption_voucher_id", "labour_voucher_id"]);
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
    await applyDcvToWipTx({
      trx,
      voucherId: normalizedVoucherId,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
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
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
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
      "vl.meta",
      "i.name as item_name",
      "s.sku_code",
      "si.name as sku_item_name",
      "si.item_type as sku_item_type",
      "l.name as labour_name",
    )
    .where({ "vl.voucher_header_id": header.id })
    .orderBy("vl.line_no", "asc");

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
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.labourProduction) {
    sourceHeader = await knex("erp.labour_voucher_header as lh")
      .join("erp.voucher_header as pvh", "pvh.id", "lh.source_production_id")
      .select("lh.source_production_id", "pvh.voucher_no as source_production_no")
      .where({ "lh.voucher_id": header.id })
      .first();
  } else if (
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.finishedProduction ||
    voucherTypeCode === PRODUCTION_VOUCHER_TYPES.semiFinishedProduction
  ) {
    generatedLinks = await knex("erp.production_generated_links as pgl")
      .leftJoin("erp.voucher_header as cvh", "cvh.id", "pgl.consumption_voucher_id")
      .leftJoin("erp.voucher_header as lvh", "lvh.id", "pgl.labour_voucher_id")
      .select(
        "pgl.consumption_voucher_id",
        "pgl.labour_voucher_id",
        "cvh.voucher_no as consumption_voucher_no",
        "lvh.voucher_no as labour_voucher_no",
      )
      .where({ "pgl.production_voucher_id": header.id })
      .first();
  }

  let productionLineMap = new Map();
  let planLineMap = new Map();
  let lossLineMap = new Map();
  let labourLineMap = new Map();

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
  } else if (voucherTypeCode === PRODUCTION_VOUCHER_TYPES.labourProduction) {
    const extRows = await knex("erp.labour_voucher_line")
      .select("voucher_line_id", "dept_id")
      .whereIn("voucher_line_id", lines.map((line) => Number(line.id)));
    labourLineMap = new Map(extRows.map((row) => [Number(row.voucher_line_id), row]));
  }

  return {
    id: Number(header.id),
    voucher_no: Number(header.voucher_no || 0),
    voucher_date: toDateOnly(header.voucher_date),
    status: String(header.status || "").toUpperCase(),
    remarks: header.remarks || "",
    reference_no: header.book_no || "",
    voucher_type_code: voucherTypeCode,
    dept_id: toPositiveInt(dcvHeader?.dept_id),
    labour_id: toPositiveInt(dcvHeader?.labour_id),
    stage_id: toPositiveInt(dcvHeader?.stage_id),
    plan_kind: String(planHeader?.plan_kind || "").toUpperCase() || null,
    reason_code_id: toPositiveInt(lossHeader?.reason_code_id),
    source_production_id: toPositiveInt(sourceHeader?.source_production_id),
    source_production_no: Number(sourceHeader?.source_production_no || 0) || null,
    generated_links: generatedLinks
      ? {
          consumption_voucher_id: toPositiveInt(generatedLinks.consumption_voucher_id),
          consumption_voucher_no: Number(generatedLinks.consumption_voucher_no || 0) || null,
          labour_voucher_id: toPositiveInt(generatedLinks.labour_voucher_id),
          labour_voucher_no: Number(generatedLinks.labour_voucher_no || 0) || null,
        }
      : null,
    lines: lines.map((line) => {
      const productionExt = productionLineMap.get(Number(line.id));
      const planExt = planLineMap.get(Number(line.id));
      const lossExt = lossLineMap.get(Number(line.id));
      const labourExt = labourLineMap.get(Number(line.id));
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
      const resolvedUnit = statusToUnit(resolvedStatus);
      return {
        id: Number(line.id),
        line_no: Number(line.line_no || 0),
        line_kind: String(line.line_kind || "").toUpperCase(),
        item_id: toPositiveInt(line.item_id),
        item_name: line.item_name || "",
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
        dept_id: toPositiveInt(lossExt?.dept_id || labourExt?.dept_id || line?.meta?.department_id),
        stage_id: toPositiveInt(productionExt?.stage_id || lossExt?.stage_id || line?.meta?.stage_id),
      };
    }),
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

  const [departments, labours, reasonCodes, rmItems, skus, sourceProductions, productionStages] = await Promise.all([
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
    isLoss
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
    isAutoGeneratedVoucher: AUTO_GENERATED_VOUCHER_TYPES.has(normalizedVoucherTypeCode),
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
  loadRecentProductionVouchers,
  getProductionVoucherSeriesStats,
  getProductionVoucherNeighbours,
  loadProductionVoucherDetails,
  ensureProductionVoucherDerivedDataTx,
  applyProductionVoucherUpdatePayloadTx,
  applyProductionVoucherDeletePayloadTx,
};
