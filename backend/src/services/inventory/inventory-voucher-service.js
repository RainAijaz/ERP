const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog, queueAuditLog } = require("../../utils/audit-log");
const { toLocalDateOnly } = require("../../utils/date-only");
const { syncVoucherGlPostingTx } = require("../financial/gl-posting-service");
const {
  resolveNegativeStockApprovalRouting,
} = require("./negative-stock-approval");

// Opening Stock service: validates lines, enforces gatekeeper flow, and keeps stock/GL synchronized.
const INVENTORY_VOUCHER_TYPES = {
  openingStock: "OPENING_STOCK",
  stockCountAdjustment: "STOCK_COUNT_ADJ",
};

const INVENTORY_VOUCHER_TYPE_SET = new Set(
  Object.values(INVENTORY_VOUCHER_TYPES),
);

const STOCK_TYPE_VALUES = ["FG", "SFG", "RM"];
const STOCK_TYPE_SET = new Set(STOCK_TYPE_VALUES);
const ROW_STATUS_VALUES = ["PACKED", "LOOSE"];

let approvalRequestHasVoucherTypeCodeColumn;
let stockBalanceRmTableSupport;
let stockBalanceSkuTableSupport;
let stockLedgerTableSupport;
let stockBalanceRmColorColumnSupport;
let stockBalanceRmSizeColumnSupport;
let stockLedgerColorColumnSupport;
let stockLedgerSizeColumnSupport;
let stockCountHeaderTableSupport;
let stockCountLineTableSupport;

const RM_BALANCE_CONFLICT_TARGET_SQL =
  "(branch_id, stock_state, item_id, COALESCE(color_id, 0), COALESCE(size_id, 0))";
const FG_PACKED_FLAG_SQL = `
CASE
  WHEN sln.is_packed IS NOT NULL THEN sln.is_packed
  WHEN pl.is_packed IS NOT NULL THEN pl.is_packed
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'PACKED' THEN true
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'LOOSE' THEN false
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('true','t','1','yes') THEN true
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('false','f','0','no') THEN false
  ELSE false
END`;

const toDateOnly = toLocalDateOnly;

const normalizeText = (value, max = 1000) => {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
};

const toPositiveInt = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const toPositiveNumber = (value, decimals = 3) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(decimals));
};

const toNonNegativeNumber = (value, decimals = 4) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(decimals));
};

const roundQty3 = (value) => Number(Number(value || 0).toFixed(3));
const roundCost2 = (value) => Number(Number(value || 0).toFixed(2));
const roundUnitCost6 = (value) => Number(Number(value || 0).toFixed(6));

const isTruthyFlag = (value) => {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "t", "yes", "y"].includes(normalized);
  }
  return Number(value) === 1;
};

const isBaseUnitOption = (option) => isTruthyFlag(option?.is_base);

const parseVoucherNo = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const normalizeStockType = (value) => {
  const text = String(value || "")
    .trim()
    .toUpperCase();
  return STOCK_TYPE_SET.has(text) ? text : null;
};

const isInventoryVoucherTypeCode = (value) => {
  const code = String(value || "")
    .trim()
    .toUpperCase();
  return INVENTORY_VOUCHER_TYPE_SET.has(code);
};

const normalizeRowStatus = (value) => {
  const text = String(value || "")
    .trim()
    .toUpperCase();
  return ROW_STATUS_VALUES.includes(text) ? text : "LOOSE";
};

// SKU dropdown label should be a complete business name: article first, then variant parts.
const buildSkuDisplayName = (row) => {
  const parts = [
    String(row?.item_name || "").trim(),
    String(row?.size_name || "").trim(),
    String(row?.color_name || "").trim(),
    String(row?.packing_name || "").trim(),
    String(row?.grade_name || "").trim(),
  ].filter(Boolean);

  if (parts.length) return parts.join(" ");
  return `SKU ${Number(row?.id || 0) || ""}`.trim();
};

// Default UOM policy: prefer non-base unit when available, otherwise use first valid option.
const pickPreferredUomOption = (unitOptions = []) => {
  const list = Array.isArray(unitOptions) ? unitOptions : [];
  if (!list.length) return null;
  const nonBase = list.find((option) => !isBaseUnitOption(option));
  return nonBase || list[0] || null;
};

// Build a bidirectional UOM graph so unit conversions can be resolved across chained mappings.
const buildUomGraph = (conversionRows = []) => {
  const graph = new Map();
  const addEdge = (fromUomId, toUomId, factor) => {
    if (!graph.has(fromUomId)) graph.set(fromUomId, []);
    graph.get(fromUomId).push({ to: toUomId, factor });
  };

  (conversionRows || []).forEach((row) => {
    const fromUomId = toPositiveInt(row?.from_uom_id);
    const toUomId = toPositiveInt(row?.to_uom_id);
    const factor = Number(row?.factor || 0);
    if (!fromUomId || !toUomId || !(factor > 0)) return;
    addEdge(Number(fromUomId), Number(toUomId), factor);
    addEdge(Number(toUomId), Number(fromUomId), 1 / factor);
  });

  return graph;
};

const collectReachableUomIds = ({ graph, sourceUomId }) => {
  const source = toPositiveInt(sourceUomId);
  if (!source || !graph.has(source))
    return [Number(source || 0)].filter(Boolean);

  const visited = new Set([Number(source)]);
  const queue = [Number(source)];
  while (queue.length) {
    const current = queue.shift();
    (graph.get(current) || []).forEach((edge) => {
      const nextId = Number(edge?.to || 0);
      if (!nextId || visited.has(nextId)) return;
      visited.add(nextId);
      queue.push(nextId);
    });
  }

  return [...visited];
};

const getConversionFactor = ({ graph, fromUomId, toUomId }) => {
  const source = toPositiveInt(fromUomId);
  const target = toPositiveInt(toUomId);
  if (!source || !target) return null;
  if (source === target) return 1;
  if (!graph.has(source)) return null;

  const visited = new Set([Number(source)]);
  const queue = [{ node: Number(source), factor: 1 }];

  while (queue.length) {
    const current = queue.shift();
    const edges = graph.get(current.node) || [];
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      const nextId = Number(edge?.to || 0);
      const nextFactor = Number(current.factor) * Number(edge?.factor || 0);
      if (!nextId || !(nextFactor > 0)) continue;
      if (nextId === Number(target)) return nextFactor;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      queue.push({ node: nextId, factor: nextFactor });
    }
  }

  return null;
};

const normalizeFactorToBase = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const nearestInteger = Math.round(numeric);
  if (Math.abs(numeric - nearestInteger) <= 0.001) {
    return Number(nearestInteger);
  }
  return Number(numeric.toFixed(6));
};

const loadUnitOptionsByBaseUomIdTx = async ({ trx, baseUomIds = [] }) => {
  const normalizedBaseIds = [
    ...new Set(
      (baseUomIds || []).map((id) => toPositiveInt(id)).filter(Boolean),
    ),
  ];
  if (!normalizedBaseIds.length) return new Map();

  const [uomRows, conversionRows] = await Promise.all([
    trx("erp.uom").select("id", "code", "name").where({ is_active: true }),
    trx("erp.uom_conversions")
      .select("from_uom_id", "to_uom_id", "factor")
      .where({ is_active: true }),
  ]);

  const graph = buildUomGraph(conversionRows);
  const uomById = new Map(
    (uomRows || []).map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        code: String(row.code || "").trim(),
        name: String(row.name || "").trim(),
      },
    ]),
  );

  const optionsByBase = new Map();
  normalizedBaseIds.forEach((baseUomId) => {
    const reachableIds = collectReachableUomIds({
      graph,
      sourceUomId: Number(baseUomId),
    });

    const options = reachableIds
      .map((uomId) => {
        const uom = uomById.get(Number(uomId));
        if (!uom) return null;
        const factorToBase = getConversionFactor({
          graph,
          fromUomId: Number(uomId),
          toUomId: Number(baseUomId),
        });
        const normalizedFactor = normalizeFactorToBase(factorToBase);
        if (!(Number(normalizedFactor || 0) > 0)) return null;
        return {
          id: Number(uom.id),
          code: String(uom.code || "").trim(),
          name: String(uom.name || "").trim(),
          factor_to_base: Number(normalizedFactor),
          is_base: Number(uom.id) === Number(baseUomId),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.is_base) return -1;
        if (b.is_base) return 1;
        return String(a.name || a.code).localeCompare(String(b.name || b.code));
      });

    optionsByBase.set(Number(baseUomId), options);
  });

  return optionsByBase;
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
    console.error("Error in InventoryVoucherService:", err);
    approvalRequestHasVoucherTypeCodeColumn = false;
    return false;
  }
};

// Cache table/column capabilities to avoid repeated schema checks in hot voucher paths.
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

const hasStockBalanceRmTableTx = async (trx) => {
  if (typeof stockBalanceRmTableSupport === "boolean")
    return stockBalanceRmTableSupport;
  stockBalanceRmTableSupport = await tableExistsTx(trx, "erp.stock_balance_rm");
  return stockBalanceRmTableSupport;
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

const hasStockLedgerTableTx = async (trx) => {
  if (typeof stockLedgerTableSupport === "boolean")
    return stockLedgerTableSupport;
  stockLedgerTableSupport = await tableExistsTx(trx, "erp.stock_ledger");
  return stockLedgerTableSupport;
};

const hasStockCountHeaderTableTx = async (trx) => {
  if (typeof stockCountHeaderTableSupport === "boolean") {
    return stockCountHeaderTableSupport;
  }
  stockCountHeaderTableSupport = await tableExistsTx(
    trx,
    "erp.stock_count_header",
  );
  return stockCountHeaderTableSupport;
};

const hasStockCountLineTableTx = async (trx) => {
  if (typeof stockCountLineTableSupport === "boolean") {
    return stockCountLineTableSupport;
  }
  stockCountLineTableSupport = await tableExistsTx(trx, "erp.stock_count_line");
  return stockCountLineTableSupport;
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

const insertRmStockLedgerTx = async ({
  trx,
  branchId,
  itemId,
  colorId = null,
  sizeId = null,
  voucherId,
  voucherLineId = null,
  txnDate,
  direction,
  qty,
  unitCost,
  value,
}) => {
  const payload = {
    branch_id: Number(branchId),
    category: "RM",
    stock_state: "ON_HAND",
    item_id: toPositiveInt(itemId),
    sku_id: null,
    voucher_header_id: Number(voucherId),
    voucher_line_id: toPositiveInt(voucherLineId),
    txn_date: txnDate,
    direction: Number(direction),
    qty: roundQty3(qty),
    qty_pairs: 0,
    unit_cost: roundUnitCost6(unitCost),
    value: roundCost2(value),
  };

  if (await hasStockLedgerVariantDimensionsTx(trx)) {
    payload.color_id = normalizeRmDimensionId(colorId);
    payload.size_id = normalizeRmDimensionId(sizeId);
  }

  await trx("erp.stock_ledger").insert(payload);
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
      `Unsupported stock category ${normalizedCategory} for opening stock`,
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
    await trx("erp.stock_ledger").insert({
      branch_id: normalizedBranchId,
      category: normalizedCategory,
      stock_state: "ON_HAND",
      item_id: null,
      sku_id: normalizedSkuId,
      voucher_header_id: Number(voucherId),
      voucher_line_id: toPositiveInt(voucherLineId),
      txn_date: voucherDate,
      direction: 1,
      qty: 0,
      qty_pairs: normalizedQtyPairsIn,
      unit_cost: unitCost,
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
  const nextQtyRaw = roundQty3(availableQty - qty);
  const nextQty = Math.abs(nextQtyRaw) <= 0.0005 ? 0 : nextQtyRaw;
  const nextValueRaw = roundCost2(availableValue - value);
  const nextValue = nextQty === 0 ? 0 : nextValueRaw;
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
  const nextQtyPairs = Number(availableQtyPairs || 0) - Number(qtyPairs || 0);
  const nextValueRaw = roundCost2(availableValue - value);
  const nextValue = nextQtyPairs === 0 ? 0 : nextValueRaw;
  const nextWac =
    nextQtyPairs !== 0 ? roundUnitCost6(nextValue / nextQtyPairs) : 0;

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

const rollbackInventoryStockLedgerByVoucherTx = async ({ trx, voucherId }) => {
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
      } else if (category === "SFG" || category === "FG") {
        await addBackSkuStockFromLedgerTx({ trx, row });
      }
      continue;
    }

    if (direction === 1) {
      if (category === "RM") {
        await removeRmStockFromLedgerTx({ trx, row });
      } else if (category === "SFG" || category === "FG") {
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

// Validate required stock infrastructure before replaying derived stock movements.
const ensureInventoryStockInfraTx = async ({ trx, needsRm, needsSku }) => {
  const hasLedger = await hasStockLedgerTableTx(trx);
  if (!hasLedger) {
    throw new HttpError(400, "Stock ledger infrastructure is unavailable");
  }

  if (needsRm) {
    const hasRm = await hasStockBalanceRmTableTx(trx);
    if (!hasRm) {
      throw new HttpError(
        400,
        "RM stock balance infrastructure is unavailable",
      );
    }
  }

  if (needsSku) {
    const hasSku = await hasStockBalanceSkuTableTx(trx);
    if (!hasSku) {
      throw new HttpError(
        400,
        "SKU stock balance infrastructure is unavailable",
      );
    }
  }
};

// Rebuild opening stock derived data: rollback prior ledger impact and replay approved lines.
const syncOpeningStockVoucherTx = async ({ trx, voucherId }) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;

  const header = await trx("erp.voucher_header")
    .select("id", "branch_id", "voucher_date", "status", "voucher_type_code")
    .where({ id: normalizedVoucherId })
    .first();
  if (!header) return;

  const normalizedVoucherTypeCode = String(header.voucher_type_code || "")
    .trim()
    .toUpperCase();
  if (normalizedVoucherTypeCode !== INVENTORY_VOUCHER_TYPES.openingStock)
    return;

  const existingLines = await trx("erp.voucher_line")
    .select(
      "id",
      "line_kind",
      "item_id",
      "sku_id",
      "qty",
      "rate",
      "amount",
      "meta",
    )
    .where({ voucher_header_id: normalizedVoucherId })
    .orderBy("line_no", "asc");

  const needsRm = existingLines.some((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType = normalizeStockType(meta.stock_type);
    if (stockType) return stockType === "RM";
    return String(line?.line_kind || "").toUpperCase() === "ITEM";
  });
  const needsSku = existingLines.some((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType = normalizeStockType(meta.stock_type);
    if (stockType) return stockType === "FG" || stockType === "SFG";
    return String(line?.line_kind || "").toUpperCase() === "SKU";
  });

  await ensureInventoryStockInfraTx({ trx, needsRm, needsSku });

  await rollbackInventoryStockLedgerByVoucherTx({
    trx,
    voucherId: normalizedVoucherId,
  });

  if (String(header.status || "").toUpperCase() !== "APPROVED") return;

  const supportsRmVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);
  const supportsLedgerVariantDimensions =
    await hasStockLedgerVariantDimensionsTx(trx);

  for (let index = 0; index < existingLines.length; index += 1) {
    const line = existingLines[index];
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const lineKind = String(line?.line_kind || "")
      .trim()
      .toUpperCase();
    const stockType =
      normalizeStockType(meta.stock_type) ||
      (lineKind === "ITEM" ? "RM" : lineKind === "SKU" ? "FG" : null);

    if (!stockType) continue;

    const qtyInput = Number(line?.qty || 0);
    const amountInput = roundCost2(Number(line?.amount || 0));
    const factorToBase = Number(meta?.uom_factor_to_base || 1);
    const safeFactor =
      Number.isFinite(factorToBase) && factorToBase > 0 ? factorToBase : 1;

    if (stockType === "RM") {
      const itemId = toPositiveInt(line?.item_id);
      if (!itemId) continue;

      const qtyBase = roundQty3(qtyInput * safeFactor);
      if (!(qtyBase > 0)) continue;

      const unitCost =
        safeFactor > 0
          ? roundUnitCost6(Number(line?.rate || 0) / safeFactor)
          : 0;
      const valueIn = amountInput;

      const colorId = normalizeRmDimensionId(meta?.color_id);
      const sizeId = normalizeRmDimensionId(meta?.size_id);
      if (
        (colorId || sizeId) &&
        (!supportsRmVariantDimensions || !supportsLedgerVariantDimensions)
      ) {
        throw new HttpError(
          400,
          "RM color/size stock tracking is unavailable. Run latest stock variant migration.",
        );
      }

      const identity = buildRmStockIdentity({
        branchId: Number(header.branch_id),
        stockState: "ON_HAND",
        itemId,
        colorId,
        sizeId,
      });

      await ensureRmBalanceSeedTx({
        trx,
        identity,
        supportsVariantDimensions: supportsRmVariantDimensions,
      });

      const existingQuery = trx("erp.stock_balance_rm")
        .select("qty", "value")
        .forUpdate();
      applyRmStockIdentityWhere({
        query: existingQuery,
        identity,
        supportsVariantDimensions: supportsRmVariantDimensions,
      });
      const existing = await existingQuery.first();

      const nextQty = roundQty3(Number(existing?.qty || 0) + qtyBase);
      const nextValue = roundCost2(Number(existing?.value || 0) + valueIn);
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
        supportsVariantDimensions: supportsRmVariantDimensions,
      });
      await updateQuery;

      await insertRmStockLedgerTx({
        trx,
        branchId: Number(header.branch_id),
        itemId,
        colorId,
        sizeId,
        voucherId: normalizedVoucherId,
        voucherLineId: toPositiveInt(line?.id),
        txnDate: toDateOnly(header.voucher_date),
        direction: 1,
        qty: qtyBase,
        unitCost,
        value: valueIn,
      });

      continue;
    }

    if (stockType !== "FG" && stockType !== "SFG") continue;

    const skuId = toPositiveInt(line?.sku_id);
    if (!skuId) continue;

    const qtyPairsRaw = Number(qtyInput) * Number(safeFactor || 0);
    const qtyPairsRounded = Math.round(Number(qtyPairsRaw || 0));
    if (
      Math.abs(qtyPairsRaw - qtyPairsRounded) > 0.0005 ||
      qtyPairsRounded <= 0
    ) {
      throw new HttpError(
        400,
        `Opening stock line #${index + 1} quantity must convert to whole pairs`,
      );
    }

    await applySkuStockInTx({
      trx,
      branchId: Number(header.branch_id),
      skuId,
      category: stockType,
      qtyPairsIn: Number(qtyPairsRounded),
      valueIn: amountInput,
      voucherId: normalizedVoucherId,
      voucherLineId: toPositiveInt(line?.id),
      voucherDate: toDateOnly(header.voucher_date),
      writeLedger: true,
    });
  }
};

const fetchSkuMapTx = async ({
  trx,
  skuIds = [],
  expectedStockType = null,
}) => {
  const normalized = [
    ...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Map();

  let query = trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .select(
      "s.id",
      "s.sku_code",
      "v.sale_rate",
      "i.name as item_name",
      "i.item_type",
      "i.base_uom_id",
      "u.code as base_uom_code",
      "u.name as base_uom_name",
    )
    .whereIn("s.id", normalized)
    .where({ "s.is_active": true, "i.is_active": true });

  if (
    expectedStockType &&
    (expectedStockType === "FG" || expectedStockType === "SFG")
  ) {
    query = query.whereRaw("upper(coalesce(i.item_type::text, '')) = ?", [
      expectedStockType,
    ]);
  }

  const rows = await query;
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const fetchRmItemMapTx = async ({ trx, itemIds = [] }) => {
  const normalized = [
    ...new Set((itemIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Map();

  const rows = await trx("erp.items as i")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .select(
      "i.id",
      "i.code",
      "i.name",
      "i.item_type",
      "i.base_uom_id",
      "u.code as base_uom_code",
      "u.name as base_uom_name",
    )
    .whereIn("i.id", normalized)
    .where({ "i.is_active": true })
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'");

  return new Map(rows.map((row) => [Number(row.id), row]));
};

const fetchColorMapTx = async ({ trx, colorIds = [] }) => {
  const normalized = [
    ...new Set((colorIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Map();
  const rows = await trx("erp.colors")
    .select("id", "name")
    .whereIn("id", normalized)
    .where({ is_active: true });
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const fetchSizeMapTx = async ({ trx, sizeIds = [] }) => {
  const normalized = [
    ...new Set((sizeIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Map();
  const rows = await trx("erp.sizes")
    .select("id", "name")
    .whereIn("id", normalized)
    .where({ is_active: true });
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const fetchRmRateRowsByItemTx = async ({ trx, itemIds = [] }) => {
  const normalized = [
    ...new Set((itemIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return [];

  return trx("erp.rm_purchase_rates as r")
    .leftJoin("erp.colors as c", "c.id", "r.color_id")
    .leftJoin("erp.sizes as s", "s.id", "r.size_id")
    .select(
      "r.rm_item_id",
      "r.color_id",
      "c.name as color_name",
      "r.size_id",
      "s.name as size_name",
      "r.avg_purchase_rate",
      "r.purchase_rate",
    )
    .whereIn("r.rm_item_id", normalized)
    .where({ "r.is_active": true });
};

const buildRmPolicyMaps = ({ rateRows = [] }) => {
  const colorPolicyByItem = new Map();
  const sizePolicyByItem = new Map();

  (rateRows || []).forEach((row) => {
    const itemId = Number(row?.rm_item_id || 0);
    if (!itemId) return;

    if (!colorPolicyByItem.has(itemId)) {
      colorPolicyByItem.set(itemId, {
        hasAnyRate: true,
        hasColorless: false,
        colorIds: new Set(),
      });
    }
    if (!sizePolicyByItem.has(itemId)) {
      sizePolicyByItem.set(itemId, {
        hasAnyRate: true,
        hasSizeless: false,
        sizeIds: new Set(),
      });
    }

    const colorId = toPositiveInt(row?.color_id);
    const sizeId = toPositiveInt(row?.size_id);

    if (!colorId) {
      colorPolicyByItem.get(itemId).hasColorless = true;
    } else {
      colorPolicyByItem.get(itemId).colorIds.add(Number(colorId));
    }

    if (!sizeId) {
      sizePolicyByItem.get(itemId).hasSizeless = true;
    } else {
      sizePolicyByItem.get(itemId).sizeIds.add(Number(sizeId));
    }
  });

  return { colorPolicyByItem, sizePolicyByItem };
};

const insertVoucherLinesTx = async ({ trx, voucherId, lines = [] }) => {
  const lineRows = lines.map((line) => ({
    voucher_header_id: voucherId,
    line_no: Number(line.line_no),
    line_kind: String(line.line_kind || "")
      .trim()
      .toUpperCase(),
    item_id: toPositiveInt(line.item_id),
    sku_id: toPositiveInt(line.sku_id),
    account_id: null,
    party_id: null,
    labour_id: null,
    employee_id: null,
    uom_id: toPositiveInt(line.uom_id),
    qty: Number(line.qty || 0),
    rate: Number(line.rate || 0),
    amount: Number(line.amount || 0),
    meta: line.meta || {},
  }));

  return trx("erp.voucher_line").insert(lineRows).returning(["id", "line_no"]);
};

// Normalize and validate incoming voucher payload by stock type (FG/SFG/RM).
const validatePayloadTx = async ({ trx, payload }) => {
  const voucherDate = toDateOnly(payload?.voucher_date);
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  const stockType = normalizeStockType(payload?.stock_type);
  if (!stockType) throw new HttpError(400, "Stock type is required");

  const remarks = normalizeText(payload?.remarks || payload?.description, 1000);
  const rawLines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (!rawLines.length) throw new HttpError(400, "Voucher lines are required");

  if (stockType === "RM") {
    const itemIds = [
      ...new Set(
        rawLines.map((line) => toPositiveInt(line?.item_id)).filter(Boolean),
      ),
    ];
    if (!itemIds.length) {
      throw new HttpError(400, "Raw material is required");
    }

    const [itemMap, rateRows] = await Promise.all([
      fetchRmItemMapTx({ trx, itemIds }),
      fetchRmRateRowsByItemTx({ trx, itemIds }),
    ]);

    const missingItem = itemIds.find((id) => !itemMap.has(Number(id)));
    if (missingItem) {
      throw new HttpError(
        400,
        `Invalid raw material on line for item ${missingItem}`,
      );
    }

    const baseUomIds = [
      ...new Set(
        [...itemMap.values()]
          .map((row) => toPositiveInt(row?.base_uom_id))
          .filter(Boolean),
      ),
    ];
    const unitOptionsByBase = await loadUnitOptionsByBaseUomIdTx({
      trx,
      baseUomIds,
    });
    const { colorPolicyByItem, sizePolicyByItem } = buildRmPolicyMaps({
      rateRows,
    });

    const colorIds = [
      ...new Set(
        rawLines.map((line) => toPositiveInt(line?.color_id)).filter(Boolean),
      ),
    ];
    const sizeIds = [
      ...new Set(
        rawLines.map((line) => toPositiveInt(line?.size_id)).filter(Boolean),
      ),
    ];
    const [colorMap, sizeMap] = await Promise.all([
      fetchColorMapTx({ trx, colorIds }),
      fetchSizeMapTx({ trx, sizeIds }),
    ]);

    const lines = rawLines.map((raw, index) => {
      const itemId = toPositiveInt(raw?.item_id);
      if (!itemId)
        throw new HttpError(400, `Line ${index + 1}: raw material is required`);

      const item = itemMap.get(Number(itemId));
      const baseUomId = toPositiveInt(item?.base_uom_id);
      const unitOptions = unitOptionsByBase.get(Number(baseUomId || 0)) || [];
      const selectedUomId = toPositiveInt(raw?.uom_id);
      const selectedUnit =
        unitOptions.find(
          (option) => Number(option.id) === Number(selectedUomId || 0),
        ) || pickPreferredUomOption(unitOptions);
      if (!selectedUnit) {
        throw new HttpError(400, `Line ${index + 1}: selected unit is invalid`);
      }

      const qty = toPositiveNumber(raw?.qty, 3);
      if (!qty) {
        throw new HttpError(
          400,
          `Line ${index + 1}: quantity must be greater than zero`,
        );
      }

      const rate = toNonNegativeNumber(raw?.rate, 4);
      if (rate === null) {
        throw new HttpError(
          400,
          `Line ${index + 1}: rate must be zero or greater`,
        );
      }

      const colorId = toPositiveInt(raw?.color_id);
      const sizeId = toPositiveInt(raw?.size_id);
      if (colorId && !colorMap.has(Number(colorId))) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected color is invalid`,
        );
      }
      if (sizeId && !sizeMap.has(Number(sizeId))) {
        throw new HttpError(400, `Line ${index + 1}: selected size is invalid`);
      }

      const colorPolicy = colorPolicyByItem.get(Number(itemId));
      if (colorPolicy?.hasAnyRate && !colorPolicy.hasColorless && !colorId) {
        throw new HttpError(
          400,
          `Line ${index + 1}: color is required for selected raw material`,
        );
      }
      if (
        colorId &&
        colorPolicy?.colorIds instanceof Set &&
        colorPolicy.colorIds.size > 0 &&
        !colorPolicy.colorIds.has(Number(colorId))
      ) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected color is not configured in active rates`,
        );
      }

      const sizePolicy = sizePolicyByItem.get(Number(itemId));
      if (sizePolicy?.hasAnyRate && !sizePolicy.hasSizeless && !sizeId) {
        throw new HttpError(
          400,
          `Line ${index + 1}: size is required for selected raw material`,
        );
      }
      if (
        sizeId &&
        sizePolicy?.sizeIds instanceof Set &&
        sizePolicy.sizeIds.size > 0 &&
        !sizePolicy.sizeIds.has(Number(sizeId))
      ) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected size is not configured in active rates`,
        );
      }

      const factorToBase = Number(selectedUnit.factor_to_base || 0);
      if (!(factorToBase > 0)) {
        throw new HttpError(
          400,
          `Line ${index + 1}: unit conversion is invalid`,
        );
      }

      const amount = roundCost2(Number(qty) * Number(rate));

      return {
        line_no: index + 1,
        line_kind: "ITEM",
        item_id: Number(itemId),
        sku_id: null,
        uom_id: Number(selectedUnit.id),
        qty: Number(qty),
        rate: Number(rate),
        amount,
        meta: {
          stock_type: "RM",
          color_id: colorId || null,
          size_id: sizeId || null,
          uom_id: Number(selectedUnit.id),
          uom_code: selectedUnit.code || null,
          uom_name: selectedUnit.name || null,
          uom_factor_to_base: Number(Number(factorToBase).toFixed(6)),
        },
      };
    });

    return {
      voucherDate,
      stockType,
      remarks,
      lines,
    };
  }

  const skuIds = [
    ...new Set(
      rawLines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
    ),
  ];
  if (!skuIds.length) throw new HttpError(400, "SKU is required");

  const skuMap = await fetchSkuMapTx({
    trx,
    skuIds,
    expectedStockType: stockType,
  });
  const missingSku = skuIds.find((id) => !skuMap.has(Number(id)));
  if (missingSku) {
    throw new HttpError(
      400,
      `Invalid SKU for selected stock type: ${missingSku}`,
    );
  }

  const baseUomIds = [
    ...new Set(
      [...skuMap.values()]
        .map((row) => toPositiveInt(row?.base_uom_id))
        .filter(Boolean),
    ),
  ];
  const unitOptionsByBase = await loadUnitOptionsByBaseUomIdTx({
    trx,
    baseUomIds,
  });

  const lines = rawLines.map((raw, index) => {
    const skuId = toPositiveInt(raw?.sku_id);
    if (!skuId) throw new HttpError(400, `Line ${index + 1}: SKU is required`);

    const sku = skuMap.get(Number(skuId));
    const baseUomId = toPositiveInt(sku?.base_uom_id);
    const unitOptions = unitOptionsByBase.get(Number(baseUomId || 0)) || [];
    const selectedUomId = toPositiveInt(raw?.uom_id);
    const selectedUnit =
      unitOptions.find(
        (option) => Number(option.id) === Number(selectedUomId || 0),
      ) || pickPreferredUomOption(unitOptions);
    if (!selectedUnit) {
      throw new HttpError(400, `Line ${index + 1}: selected unit is invalid`);
    }

    const qty = toPositiveNumber(raw?.qty, 3);
    if (!qty) {
      throw new HttpError(
        400,
        `Line ${index + 1}: quantity must be greater than zero`,
      );
    }

    const rate = toNonNegativeNumber(raw?.rate, 4);
    if (rate === null) {
      throw new HttpError(
        400,
        `Line ${index + 1}: rate must be zero or greater`,
      );
    }

    const factorToBase = Number(selectedUnit.factor_to_base || 0);
    if (!(factorToBase > 0)) {
      throw new HttpError(400, `Line ${index + 1}: unit conversion is invalid`);
    }

    const qtyPairsRaw = Number(qty) * Number(factorToBase);
    const qtyPairsRounded = Math.round(Number(qtyPairsRaw || 0));
    if (
      Math.abs(qtyPairsRaw - qtyPairsRounded) > 0.0005 ||
      qtyPairsRounded <= 0
    ) {
      throw new HttpError(
        400,
        `Line ${index + 1}: quantity must convert to whole pairs`,
      );
    }

    const derivedStatus = isBaseUnitOption(selectedUnit) ? "LOOSE" : "PACKED";
    // Status is always derived from selected unit so payload cannot force an inconsistent value.
    const rowStatus = derivedStatus;

    const amount = roundCost2(Number(qty) * Number(rate));

    return {
      line_no: index + 1,
      line_kind: "SKU",
      item_id: null,
      sku_id: Number(skuId),
      uom_id: Number(selectedUnit.id),
      qty: Number(qty),
      rate: Number(rate),
      amount,
      meta: {
        stock_type: stockType,
        row_status: rowStatus,
        uom_id: Number(selectedUnit.id),
        uom_code: selectedUnit.code || null,
        uom_name: selectedUnit.name || null,
        uom_factor_to_base: Number(Number(factorToBase).toFixed(6)),
      },
    };
  });

  return {
    voucherDate,
    stockType,
    remarks,
    lines,
  };
};

const getNextVoucherNoTx = async (trx, branchId, voucherTypeCode) => {
  const latest = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .max({ value: "voucher_no" })
    .first();
  return Number(latest?.value || 0) + 1;
};

const createApprovalRequest = async ({
  trx,
  req,
  voucherId,
  voucherTypeCode,
  summary,
  oldValue = null,
  newValue = null,
}) => {
  const approvalInsertPayload = {
    branch_id: req.branchId,
    request_type: "VOUCHER",
    entity_type: "VOUCHER",
    entity_id: String(voucherId),
    summary,
    old_value: oldValue,
    new_value: newValue,
    requested_by: req.user.id,
  };

  if (await hasApprovalRequestVoucherTypeCodeColumnTx(trx)) {
    approvalInsertPayload.voucher_type_code = voucherTypeCode;
  }

  let row;
  try {
    [row] = await trx("erp.approval_request")
      .insert(approvalInsertPayload)
      .returning(["id"]);
  } catch (err) {
    const isMissingVoucherTypeCol =
      String(err?.code || "").trim() === "42703" &&
      String(err?.message || "")
        .toLowerCase()
        .includes("voucher_type_code");
    if (!isMissingVoucherTypeCol) throw err;

    approvalRequestHasVoucherTypeCodeColumn = false;
    delete approvalInsertPayload.voucher_type_code;
    [row] = await trx("erp.approval_request")
      .insert(approvalInsertPayload)
      .returning(["id"]);
  }

  await insertActivityLog(trx, {
    branch_id: req.branchId,
    user_id: req.user.id,
    entity_type: "VOUCHER",
    entity_id: String(voucherId),
    voucher_type_code: voucherTypeCode,
    action: "SUBMIT",
    ip_address: req.ip,
    context: {
      approval_request_id: row?.id || null,
      summary,
      source: "inventory-voucher-service",
      new_value: newValue,
    },
  });

  return row?.id || null;
};

// Persist a compact payload so approvals replay can apply the same normalized values deterministically.
const toApprovalPayload = ({
  action,
  voucherTypeCode,
  voucherId,
  voucherNo,
  validated,
  permissionReroute = false,
}) => ({
  action,
  voucher_id: voucherId,
  voucher_no: voucherNo,
  voucher_type_code: voucherTypeCode,
  voucher_date: validated.voucherDate,
  stock_type: validated.stockType,
  remarks: validated.remarks,
  lines: validated.lines,
  permission_reroute: permissionReroute === true,
});

// Create flow: apply immediately when allowed, otherwise queue pending approval request.
const createOpeningStockVoucher = async ({
  req,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const canCreate = canDo(req, "VOUCHER", scopeKey, "create");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const validated = await validatePayloadTx({ trx, payload });
    const voucherNo = await getNextVoucherNoTx(
      trx,
      req.branchId,
      voucherTypeCode,
    );
    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "create",
    );
    const queuedForApproval =
      !canCreate || (policyRequiresApproval && !canApprove);

    const [header] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: voucherTypeCode,
        voucher_no: voucherNo,
        branch_id: req.branchId,
        voucher_date: validated.voucherDate,
        book_no: null,
        status: queuedForApproval ? "PENDING" : "APPROVED",
        created_by: req.user.id,
        approved_by: queuedForApproval ? null : req.user.id,
        approved_at: queuedForApproval ? null : trx.fn.now(),
        remarks: validated.remarks,
      })
      .returning(["id", "voucher_no", "status"]);

    await insertVoucherLinesTx({
      trx,
      voucherId: header.id,
      lines: validated.lines,
    });

    if (!queuedForApproval) {
      await syncVoucherGlPostingTx({ trx, voucherId: header.id });
      await syncOpeningStockVoucherTx({ trx, voucherId: header.id });
    }

    let approvalRequestId = null;
    if (queuedForApproval) {
      approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: header.id,
        voucherTypeCode,
        summary: `${voucherTypeCode} #${header.voucher_no}`,
        newValue: toApprovalPayload({
          action: "create",
          voucherTypeCode,
          voucherId: header.id,
          voucherNo: header.voucher_no,
          validated,
          permissionReroute: !canCreate,
        }),
      });
    }

    return {
      id: header.id,
      voucherNo: header.voucher_no,
      status: header.status,
      approvalRequestId,
      queuedForApproval,
      permissionReroute: !canCreate,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "CREATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
    },
  });

  return result;
};

// Update flow: same gatekeeper model as create, with full line replace on direct approval.
const updateOpeningStockVoucher = async ({
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

  const canEdit = canDo(req, "VOUCHER", scopeKey, "edit");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_no", "status", "voucher_date", "remarks")
      .where({
        id: normalizedVoucherId,
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      })
      .first();

    if (!existing) throw new HttpError(404, "Voucher not found");
    if (existing.status === "REJECTED") {
      throw new HttpError(400, "Deleted voucher cannot be edited");
    }

    const validated = await validatePayloadTx({ trx, payload });

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "edit",
    );
    const negativeStockRouting = resolveNegativeStockApprovalRouting({
      hasNegativeStockRisk: hasStockCountNegativeStockRisk(validated),
      canApproveVoucherAction: req?.user?.isAdmin === true,
      voucherTypeCode,
    });
    const queuedForApproval =
      !canEdit ||
      (policyRequiresApproval && !canApprove) ||
      negativeStockRouting.queueForApproval;

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: existing.id,
        voucherTypeCode,
        summary: `UPDATE ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: {
          voucher_date: existing.voucher_date,
          remarks: existing.remarks,
          status: existing.status,
        },
        newValue: toApprovalPayload({
          action: "update",
          voucherTypeCode,
          voucherId: existing.id,
          voucherNo: existing.voucher_no,
          validated,
          permissionReroute: !canEdit,
        }),
      });

      return {
        id: existing.id,
        voucherNo: existing.voucher_no,
        status: existing.status,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canEdit,
        updated: false,
      };
    }

    await trx("erp.voucher_header").where({ id: existing.id }).update({
      voucher_date: validated.voucherDate,
      book_no: null,
      remarks: validated.remarks,
      status: "APPROVED",
      approved_by: req.user.id,
      approved_at: trx.fn.now(),
    });

    await trx("erp.voucher_line")
      .where({ voucher_header_id: existing.id })
      .del();
    await insertVoucherLinesTx({
      trx,
      voucherId: existing.id,
      lines: validated.lines,
    });

    await syncVoucherGlPostingTx({ trx, voucherId: existing.id });
    await syncOpeningStockVoucherTx({ trx, voucherId: existing.id });

    return {
      id: existing.id,
      voucherNo: existing.voucher_no,
      status: "APPROVED",
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      updated: true,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "UPDATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      updated: result.updated === true,
    },
  });

  return result;
};

const applyInventoryVoucherDeletePayloadTx = async ({
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

  await trx("erp.voucher_header").where({ id: normalizedVoucherId }).update({
    status: "REJECTED",
    approved_by: approverId,
    approved_at: trx.fn.now(),
  });

  await syncVoucherGlPostingTx({ trx, voucherId: normalizedVoucherId });
  await ensureInventoryVoucherDerivedDataTx({
    trx,
    voucherId: normalizedVoucherId,
    voucherTypeCode,
  });
};

// Delete flow: hard delete permission or policy controls whether action is immediate or queued.
const deleteOpeningStockVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

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
    if (existing.status === "REJECTED")
      throw new HttpError(400, "Voucher already deleted");

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "delete",
    );
    const queuedForApproval =
      !canDelete || (policyRequiresApproval && !canApprove);

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: existing.id,
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
        voucherNo: existing.voucher_no,
        status: existing.status,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canDelete,
        deleted: false,
      };
    }

    await applyInventoryVoucherDeletePayloadTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode,
      approverId: req.user.id,
    });

    return {
      id: existing.id,
      voucherNo: existing.voucher_no,
      status: "REJECTED",
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      deleted: true,
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
      deleted: result.deleted === true,
    },
  });

  return result;
};

// Screen options bundle (SKU/RM + unit/rate/color/size policy) consumed by inventory voucher UI.
const loadOpeningStockVoucherOptions = async (req) => {
  const [skus, rmItems, colors, sizes, rmRateRows] = await Promise.all([
    knex("erp.skus as s")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", "i.id", "v.item_id")
      .leftJoin("erp.sizes as sz", "sz.id", "v.size_id")
      .leftJoin("erp.colors as c", "c.id", "v.color_id")
      .leftJoin("erp.packing_types as p", "p.id", "v.packing_type_id")
      .leftJoin("erp.grades as g", "g.id", "v.grade_id")
      .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
      .select(
        "s.id",
        "s.sku_code",
        "v.sale_rate",
        "i.name as item_name",
        "i.item_type",
        "sz.name as size_name",
        "c.name as color_name",
        "p.name as packing_name",
        "g.name as grade_name",
        "i.base_uom_id",
        "u.code as base_uom_code",
        "u.name as base_uom_name",
      )
      .where({ "s.is_active": true, "i.is_active": true })
      .whereIn(knex.raw("upper(coalesce(i.item_type::text, ''))"), [
        "FG",
        "SFG",
      ])
      .orderBy("i.name", "asc")
      .orderBy("s.sku_code", "asc"),
    knex("erp.items as i")
      .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
      .select(
        "i.id",
        "i.code",
        "i.name",
        "i.base_uom_id",
        "u.code as base_uom_code",
        "u.name as base_uom_name",
      )
      .where({ "i.is_active": true })
      .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
      .orderBy("i.name", "asc"),
    knex("erp.colors as c")
      .select("c.id", "c.name")
      .where({ "c.is_active": true })
      .orderBy("c.name", "asc"),
    knex("erp.sizes as s")
      .select("s.id", "s.name")
      .where({ "s.is_active": true })
      .orderBy("s.name", "asc"),
    knex("erp.rm_purchase_rates as r")
      .leftJoin("erp.colors as c", "c.id", "r.color_id")
      .leftJoin("erp.sizes as s", "s.id", "r.size_id")
      .select(
        "r.rm_item_id",
        "r.color_id",
        "c.name as color_name",
        "r.size_id",
        "s.name as size_name",
        "r.purchase_rate",
        "r.avg_purchase_rate",
      )
      .where({ "r.is_active": true }),
  ]);

  const baseUomIds = [
    ...new Set(
      [...(skus || []), ...(rmItems || [])]
        .map((row) => toPositiveInt(row?.base_uom_id))
        .filter(Boolean),
    ),
  ];
  const unitOptionsByBase = await loadUnitOptionsByBaseUomIdTx({
    trx: knex,
    baseUomIds,
  });

  const colorNameById = new Map(
    (colors || []).map((row) => [Number(row.id), row.name || ""]),
  );
  const sizeNameById = new Map(
    (sizes || []).map((row) => [Number(row.id), row.name || ""]),
  );

  const rawMaterialColorPolicyByItem = {};
  const rawMaterialSizePolicyByItem = {};
  const rawMaterialRatesByItem = {};

  (rmRateRows || []).forEach((row) => {
    const itemId = Number(row?.rm_item_id || 0);
    if (!itemId) return;

    const key = String(itemId);
    if (!rawMaterialColorPolicyByItem[key]) {
      rawMaterialColorPolicyByItem[key] = {
        hasAnyRate: true,
        hasColorless: false,
        colors: [],
      };
    }
    if (!rawMaterialSizePolicyByItem[key]) {
      rawMaterialSizePolicyByItem[key] = {
        hasAnyRate: true,
        hasSizeless: false,
        sizes: [],
      };
    }
    if (!rawMaterialRatesByItem[key]) {
      rawMaterialRatesByItem[key] = [];
    }

    const colorId = toPositiveInt(row?.color_id);
    const sizeId = toPositiveInt(row?.size_id);

    if (!colorId) {
      rawMaterialColorPolicyByItem[key].hasColorless = true;
    } else if (
      !rawMaterialColorPolicyByItem[key].colors.some(
        (entry) => Number(entry.id) === Number(colorId),
      )
    ) {
      rawMaterialColorPolicyByItem[key].colors.push({
        id: Number(colorId),
        name:
          row?.color_name ||
          colorNameById.get(Number(colorId)) ||
          String(colorId),
      });
    }

    if (!sizeId) {
      rawMaterialSizePolicyByItem[key].hasSizeless = true;
    } else if (
      !rawMaterialSizePolicyByItem[key].sizes.some(
        (entry) => Number(entry.id) === Number(sizeId),
      )
    ) {
      rawMaterialSizePolicyByItem[key].sizes.push({
        id: Number(sizeId),
        name:
          row?.size_name || sizeNameById.get(Number(sizeId)) || String(sizeId),
      });
    }

    const rate = Number(row?.avg_purchase_rate ?? row?.purchase_rate ?? 0);
    if (Number.isFinite(rate) && rate > 0) {
      rawMaterialRatesByItem[key].push({
        color_id: colorId,
        size_id: sizeId,
        purchase_rate: Number(Number(rate).toFixed(4)),
      });
    }
  });

  Object.values(rawMaterialColorPolicyByItem).forEach((entry) => {
    entry.colors.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")),
    );
  });
  Object.values(rawMaterialSizePolicyByItem).forEach((entry) => {
    entry.sizes.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")),
    );
  });

  return {
    stockTypes: [
      { value: "FG", labelKey: "finished" },
      { value: "SFG", labelKey: "semi_finished" },
      { value: "RM", labelKey: "raw_material" },
    ],
    skus: (skus || []).map((row) => ({
      ...row,
      item_type: String(row.item_type || "")
        .trim()
        .toUpperCase(),
      sku_name: buildSkuDisplayName(row),
      default_rate: Number(Number(row.sale_rate || 0).toFixed(4)),
      unit_options: unitOptionsByBase.get(Number(row.base_uom_id || 0)) || [],
    })),
    rmItems: (rmItems || []).map((row) => ({
      ...row,
      unit_options: unitOptionsByBase.get(Number(row.base_uom_id || 0)) || [],
    })),
    colors,
    sizes,
    rawMaterialColorPolicyByItem,
    rawMaterialSizePolicyByItem,
    rawMaterialRatesByItem,
  };
};

const buildRmSnapshotKey = ({ itemId, colorId = null, sizeId = null }) => {
  const normalizedItemId = Number(toPositiveInt(itemId) || 0);
  const normalizedColorId = Number(toPositiveInt(colorId) || 0);
  const normalizedSizeId = Number(toPositiveInt(sizeId) || 0);
  return `${normalizedItemId}:${normalizedColorId}:${normalizedSizeId}`;
};

const loadReasonCodesForVoucherTypeTx = async ({ trx, voucherTypeCode }) => {
  const hasReasonCodeMap = await tableExistsTx(
    trx,
    "erp.reason_code_voucher_type_map",
  );

  const toReasonRows = (query) =>
    query.orderBy("rc.name", "asc").then((rows) =>
      rows.map((row) => ({
        id: Number(row.id),
        code: String(row.code || "").trim(),
        name: String(row.name || "").trim(),
        requires_notes: row.requires_notes === true,
      })),
    );

  const baseQuery = () =>
    trx("erp.reason_codes as rc")
      .select("rc.id", "rc.code", "rc.name", "rc.requires_notes")
      .where({ "rc.is_active": true });

  if (hasReasonCodeMap) {
    const mappedRows = await toReasonRows(
      baseQuery().whereExists(
        trx("erp.reason_code_voucher_type_map as m")
          .select(trx.raw("1"))
          .whereRaw("m.reason_code_id = rc.id")
          .where({ "m.voucher_type_code": voucherTypeCode }),
      ),
    );
    // Strict scope isolation: when mapping table exists, only mapped reasons are allowed.
    return mappedRows;
  }

  // Legacy fallback only when mapping table does not exist.
  const rows = await toReasonRows(baseQuery());
  return rows.map((row) => ({
    id: Number(row.id),
    code: String(row.code || "").trim(),
    name: String(row.name || "").trim(),
    requires_notes: row.requires_notes === true,
  }));
};

const resolveSelectedReasonCodeTx = async ({
  trx,
  voucherTypeCode,
  reasonCodeId,
  reasonNotes,
}) => {
  const normalizedReasonCodeId = toPositiveInt(reasonCodeId);
  if (!normalizedReasonCodeId) {
    throw new HttpError(400, "Reason is required");
  }

  const reasons = await loadReasonCodesForVoucherTypeTx({
    trx,
    voucherTypeCode,
  });
  const selectedReason = reasons.find(
    (entry) => Number(entry.id) === Number(normalizedReasonCodeId),
  );
  if (!selectedReason) {
    throw new HttpError(400, "Invalid reason selected");
  }

  if (
    selectedReason.requires_notes &&
    !normalizeText(reasonNotes || "", 1000)
  ) {
    throw new HttpError(400, "Notes are required for selected reason");
  }

  return {
    reasonCodeId: Number(normalizedReasonCodeId),
    reasonNotes: normalizeText(reasonNotes || "", 1000),
    selectedReason,
  };
};

const loadSkuSystemSnapshotBySkuIdTx = async ({
  trx,
  branchId,
  skuIds = [],
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  if (!normalizedBranchId) return new Map();

  const normalizedSkuIds = [
    ...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];

  let query = trx("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .select("sl.sku_id", "sl.category")
    .select(trx.raw(`${FG_PACKED_FLAG_SQL} as is_packed`))
    .select(
      trx.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END), 0) as qty_pairs",
      ),
    )
    .select(trx.raw("COALESCE(SUM(COALESCE(sl.value, 0)), 0) as value"))
    .where({
      "sl.branch_id": normalizedBranchId,
      "sl.stock_state": "ON_HAND",
    })
    .whereIn("sl.category", ["FG", "SFG"])
    .groupBy("sl.sku_id", "sl.category", trx.raw(FG_PACKED_FLAG_SQL));

  if (normalizedSkuIds.length) {
    query = query.whereIn("sl.sku_id", normalizedSkuIds);
  }

  const rows = await query;
  const bySku = new Map();

  rows.forEach((row) => {
    const skuId = Number(row?.sku_id || 0);
    if (!skuId) return;

    const category = String(row?.category || "").trim().toUpperCase();
    const isPacked = category === "FG" ? isTruthyFlag(row?.is_packed) : false;
    // Preserve fractional pair balances so available quantity does not collapse to zero.
    const qtyPairs = roundQty3(Number(row?.qty_pairs || 0));
    const value = roundCost2(Number(row?.value || 0));
    const wac = Math.abs(qtyPairs) > 0 ? roundUnitCost6(value / qtyPairs) : 0;

    const current = bySku.get(skuId) || {
      qty_pairs: 0,
      value: 0,
      wac: 0,
      loose_qty_pairs: 0,
      loose_value: 0,
      loose_wac: 0,
      packed_qty_pairs: 0,
      packed_value: 0,
      packed_wac: 0,
    };

    if (isPacked) {
      current.packed_qty_pairs = qtyPairs;
      current.packed_value = value;
      current.packed_wac = wac;
    } else {
      current.loose_qty_pairs = qtyPairs;
      current.loose_value = value;
      current.loose_wac = wac;
    }

    current.qty_pairs = roundQty3(
      Number(current.loose_qty_pairs || 0) + Number(current.packed_qty_pairs || 0),
    );
    current.value = roundCost2(
      Number(current.loose_value || 0) + Number(current.packed_value || 0),
    );
    current.wac =
      Math.abs(current.qty_pairs) > 0
        ? roundUnitCost6(current.value / current.qty_pairs)
        : 0;

    bySku.set(skuId, current);
  });

  return bySku;
};

const loadSkuBucketSnapshotFromLedgerTx = async ({
  trx,
  branchId,
  stockState = "ON_HAND",
  stockType,
  skuId,
  rowStatus = "LOOSE",
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuId = toPositiveInt(skuId);
  const normalizedStockType = normalizeStockType(stockType);
  if (!normalizedBranchId || !normalizedSkuId) {
    return { qtyPairs: 0, value: 0, wac: 0 };
  }
  if (normalizedStockType !== "FG" && normalizedStockType !== "SFG") {
    return { qtyPairs: 0, value: 0, wac: 0 };
  }

  const normalizedStockState = String(stockState || "ON_HAND")
    .trim()
    .toUpperCase();
  const normalizedRowStatus = normalizeRowStatus(rowStatus);

  let query = trx("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .where({
      "sl.branch_id": normalizedBranchId,
      "sl.stock_state": normalizedStockState,
      "sl.category": normalizedStockType,
      "sl.sku_id": normalizedSkuId,
    })
    .select(
      trx.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END), 0) as qty_pairs",
      ),
    )
    .select(trx.raw("COALESCE(SUM(COALESCE(sl.value, 0)), 0) as value"));

  if (normalizedStockType === "FG") {
    query =
      normalizedRowStatus === "PACKED"
        ? query.whereRaw(`${FG_PACKED_FLAG_SQL} = true`)
        : query.whereRaw(`${FG_PACKED_FLAG_SQL} = false`);
  }

  const row = await query.first();
  const qtyPairs = roundQty3(Number(row?.qty_pairs || 0));
  const value = roundCost2(Number(row?.value || 0));
  const wac = Math.abs(qtyPairs) > 0 ? roundUnitCost6(value / qtyPairs) : 0;
  return { qtyPairs, value, wac };
};

// For FG stock-count rows, always resolve strictly from requested row status.
const resolveFgSnapshotByStatus = ({ snapshot, requestedStatus }) => {
  const normalizedRequested =
    normalizeRowStatus(requestedStatus) === "PACKED" ? "PACKED" : "LOOSE";
  const looseQty = roundQty3(Number(snapshot?.loose_qty_pairs || 0));
  const packedQty = roundQty3(Number(snapshot?.packed_qty_pairs || 0));
  const looseWac = roundUnitCost6(Number(snapshot?.loose_wac || 0));
  const packedWac = roundUnitCost6(Number(snapshot?.packed_wac || 0));

  const pickByStatus = (status) =>
    status === "PACKED"
      ? { qtyPairs: packedQty, wac: packedWac }
      : { qtyPairs: looseQty, wac: looseWac };

  const preferred = pickByStatus(normalizedRequested);
  return {
    rowStatus: normalizedRequested,
    qtyPairs: roundQty3(Number(preferred.qtyPairs || 0)),
    wac: roundUnitCost6(Number(preferred.wac || 0)),
  };
};

const loadRmSystemSnapshotByKeyTx = async ({ trx, branchId, itemIds = [] }) => {
  const normalizedBranchId = toPositiveInt(branchId);
  if (!normalizedBranchId) return new Map();

  const normalizedItemIds = [
    ...new Set((itemIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];

  const hasVariantDimensions = await hasStockBalanceRmVariantDimensionsTx(trx);
  let query = trx("erp.stock_balance_rm as sb")
    .select("sb.item_id")
    .where({ "sb.branch_id": normalizedBranchId, "sb.stock_state": "ON_HAND" });

  if (hasVariantDimensions) {
    query = query
      .select("sb.color_id", "sb.size_id")
      .sum({ qty: trx.raw("COALESCE(sb.qty, 0)") })
      .sum({ value: trx.raw("COALESCE(sb.value, 0)") })
      .groupBy("sb.item_id", "sb.color_id", "sb.size_id");
  } else {
    query = query
      .select(trx.raw("NULL::bigint as color_id"))
      .select(trx.raw("NULL::bigint as size_id"))
      .sum({ qty: trx.raw("COALESCE(sb.qty, 0)") })
      .sum({ value: trx.raw("COALESCE(sb.value, 0)") })
      .groupBy("sb.item_id");
  }

  if (normalizedItemIds.length) {
    query = query.whereIn("sb.item_id", normalizedItemIds);
  }

  const rows = await query;
  const byKey = new Map();
  rows.forEach((row) => {
    const qty = roundQty3(Number(row?.qty || 0));
    const value = roundCost2(Number(row?.value || 0));
    const wac = qty > 0 ? roundUnitCost6(value / qty) : 0;
    const key = buildRmSnapshotKey({
      itemId: row?.item_id,
      colorId: hasVariantDimensions ? row?.color_id : null,
      sizeId: hasVariantDimensions ? row?.size_id : null,
    });
    byKey.set(key, {
      qty,
      value,
      wac,
      color_id: toPositiveInt(row?.color_id),
      size_id: toPositiveInt(row?.size_id),
    });
  });

  return byKey;
};

const resolveRmDisplayRate = ({
  itemRates = [],
  colorId = null,
  sizeId = null,
}) => {
  const normalizedColorId = Number(toPositiveInt(colorId) || 0);
  const normalizedSizeId = Number(toPositiveInt(sizeId) || 0);
  const rates = Array.isArray(itemRates) ? itemRates : [];

  const exact = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === normalizedColorId &&
      Number(entry?.size_id || 0) === normalizedSizeId,
  );
  if (exact) return Number(exact.purchase_rate || 0);

  const colorOnly = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === normalizedColorId &&
      Number(entry?.size_id || 0) === 0,
  );
  if (colorOnly) return Number(colorOnly.purchase_rate || 0);

  const sizeOnly = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === 0 &&
      Number(entry?.size_id || 0) === normalizedSizeId,
  );
  if (sizeOnly) return Number(sizeOnly.purchase_rate || 0);

  const fallback = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === 0 && Number(entry?.size_id || 0) === 0,
  );
  return fallback ? Number(fallback.purchase_rate || 0) : 0;
};

// Validate stock count adjustment payload and enrich each line with immutable snapshots.
const validateStockCountAdjustmentPayloadTx = async ({ trx, req, payload }) => {
  const voucherDate = toDateOnly(payload?.voucher_date);
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  const stockType = normalizeStockType(payload?.stock_type);
  if (!stockType) throw new HttpError(400, "Stock type is required");

  const remarks = normalizeText(payload?.remarks || payload?.description, 1000);
  const { reasonCodeId, reasonNotes } = await resolveSelectedReasonCodeTx({
    trx,
    voucherTypeCode: INVENTORY_VOUCHER_TYPES.stockCountAdjustment,
    reasonCodeId: payload?.reason_code_id,
    reasonNotes: payload?.reason_notes || payload?.notes,
  });

  const rawLines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (!rawLines.length) throw new HttpError(400, "Voucher lines are required");

  if (stockType === "RM") {
    const itemIds = [
      ...new Set(
        rawLines.map((line) => toPositiveInt(line?.item_id)).filter(Boolean),
      ),
    ];
    if (!itemIds.length) throw new HttpError(400, "Raw material is required");

    const [itemMap, rateRows, rmSnapshotByKey] = await Promise.all([
      fetchRmItemMapTx({ trx, itemIds }),
      fetchRmRateRowsByItemTx({ trx, itemIds }),
      loadRmSystemSnapshotByKeyTx({ trx, branchId: req.branchId, itemIds }),
    ]);

    const missingItem = itemIds.find((id) => !itemMap.has(Number(id)));
    if (missingItem) {
      throw new HttpError(
        400,
        `Invalid raw material on line for item ${missingItem}`,
      );
    }

    const baseUomIds = [
      ...new Set(
        [...itemMap.values()]
          .map((row) => toPositiveInt(row?.base_uom_id))
          .filter(Boolean),
      ),
    ];
    const unitOptionsByBase = await loadUnitOptionsByBaseUomIdTx({
      trx,
      baseUomIds,
    });
    const { colorPolicyByItem, sizePolicyByItem } = buildRmPolicyMaps({
      rateRows,
    });

    const colorIds = [
      ...new Set(
        rawLines.map((line) => toPositiveInt(line?.color_id)).filter(Boolean),
      ),
    ];
    const sizeIds = [
      ...new Set(
        rawLines.map((line) => toPositiveInt(line?.size_id)).filter(Boolean),
      ),
    ];
    const [colorMap, sizeMap] = await Promise.all([
      fetchColorMapTx({ trx, colorIds }),
      fetchSizeMapTx({ trx, sizeIds }),
    ]);

    let hasDifference = false;
    const lines = rawLines.map((raw, index) => {
      const itemId = toPositiveInt(raw?.item_id);
      if (!itemId)
        throw new HttpError(400, `Line ${index + 1}: raw material is required`);

      const item = itemMap.get(Number(itemId));
      const baseUomId = toPositiveInt(item?.base_uom_id);
      const unitOptions = unitOptionsByBase.get(Number(baseUomId || 0)) || [];
      const selectedUomId = toPositiveInt(raw?.uom_id);
      const selectedUnit =
        unitOptions.find(
          (option) => Number(option.id) === Number(selectedUomId || 0),
        ) || pickPreferredUomOption(unitOptions);
      if (!selectedUnit) {
        throw new HttpError(400, `Line ${index + 1}: selected unit is invalid`);
      }

      const colorId = toPositiveInt(raw?.color_id);
      const sizeId = toPositiveInt(raw?.size_id);
      if (colorId && !colorMap.has(Number(colorId))) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected color is invalid`,
        );
      }
      if (sizeId && !sizeMap.has(Number(sizeId))) {
        throw new HttpError(400, `Line ${index + 1}: selected size is invalid`);
      }

      const colorPolicy = colorPolicyByItem.get(Number(itemId));
      if (colorPolicy?.hasAnyRate && !colorPolicy.hasColorless && !colorId) {
        throw new HttpError(
          400,
          `Line ${index + 1}: color is required for selected raw material`,
        );
      }
      if (
        colorId &&
        colorPolicy?.colorIds instanceof Set &&
        colorPolicy.colorIds.size > 0 &&
        !colorPolicy.colorIds.has(Number(colorId))
      ) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected color is not configured in active rates`,
        );
      }

      const sizePolicy = sizePolicyByItem.get(Number(itemId));
      if (sizePolicy?.hasAnyRate && !sizePolicy.hasSizeless && !sizeId) {
        throw new HttpError(
          400,
          `Line ${index + 1}: size is required for selected raw material`,
        );
      }
      if (
        sizeId &&
        sizePolicy?.sizeIds instanceof Set &&
        sizePolicy.sizeIds.size > 0 &&
        !sizePolicy.sizeIds.has(Number(sizeId))
      ) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected size is not configured in active rates`,
        );
      }

      const factorToBase = Number(selectedUnit.factor_to_base || 0);
      if (!(factorToBase > 0)) {
        throw new HttpError(
          400,
          `Line ${index + 1}: unit conversion is invalid`,
        );
      }

      const rmKey = buildRmSnapshotKey({ itemId, colorId, sizeId });
      const snapshot = rmSnapshotByKey.get(rmKey) || { qty: 0, wac: 0 };
      const systemQtyBase = roundQty3(Number(snapshot.qty || 0));
      const systemQty = roundQty3(systemQtyBase / factorToBase);
      // Stock adjustment uses explicit in/out quantities; legacy physical_qty is accepted for backward compatibility.
      const qtyInInput = toNonNegativeNumber(raw?.qty_in, 3);
      const qtyOutInput = toNonNegativeNumber(raw?.qty_out, 3);
      const hasSplitInput = qtyInInput !== null || qtyOutInput !== null;

      if (hasSplitInput && (qtyInInput === null || qtyOutInput === null)) {
        throw new HttpError(
          400,
          `Line ${index + 1}: quantity in/out must be zero or greater`,
        );
      }

      let qtyInDisplay = qtyInInput;
      let qtyOutDisplay = qtyOutInput;
      let differenceQty;
      let differenceQtyBase;
      let physicalQty;
      let physicalQtyBase;

      if (hasSplitInput) {
        qtyInDisplay = roundQty3(qtyInInput || 0);
        qtyOutDisplay = roundQty3(qtyOutInput || 0);
        const qtyInBase = roundQty3(Number(qtyInDisplay) * factorToBase);
        const qtyOutBase = roundQty3(Number(qtyOutDisplay) * factorToBase);
        differenceQty = roundQty3(Number(qtyInDisplay) - Number(qtyOutDisplay));
        differenceQtyBase = roundQty3(qtyInBase - qtyOutBase);
        physicalQtyBase = roundQty3(systemQtyBase + differenceQtyBase);
        physicalQty = roundQty3(systemQty + differenceQty);
      } else {
        const legacyPhysicalQty = toNonNegativeNumber(
          raw?.physical_qty ?? raw?.qty,
          3,
        );
        if (legacyPhysicalQty === null) {
          throw new HttpError(
            400,
            `Line ${index + 1}: quantity in and quantity out are required`,
          );
        }
        physicalQty = roundQty3(legacyPhysicalQty);
        physicalQtyBase = roundQty3(Number(physicalQty) * factorToBase);
        differenceQty = roundQty3(Number(physicalQty) - systemQty);
        differenceQtyBase = roundQty3(physicalQtyBase - systemQtyBase);
        qtyInDisplay = differenceQty > 0 ? roundQty3(differenceQty) : 0;
        qtyOutDisplay = differenceQty < 0 ? roundQty3(Math.abs(differenceQty)) : 0;
      }

      if (differenceQtyBase !== 0) hasDifference = true;

      const itemRates = (rateRows || [])
        .filter((entry) => Number(entry?.rm_item_id || 0) === Number(itemId))
        .map((entry) => ({
          color_id: toPositiveInt(entry?.color_id),
          size_id: toPositiveInt(entry?.size_id),
          purchase_rate: Number(
            Number(
              entry?.avg_purchase_rate ?? entry?.purchase_rate ?? 0,
            ).toFixed(4),
          ),
        }));
      const displayRateResolved = resolveRmDisplayRate({
        itemRates,
        colorId,
        sizeId,
      });
      const displayRate = roundUnitCost6(
        Number(displayRateResolved || 0) > 0
          ? Number(displayRateResolved)
          : Number(snapshot.wac || 0) * factorToBase,
      );
      const amountDifference = roundCost2(
        Number(differenceQty) * Number(displayRate),
      );

      return {
        line_no: index + 1,
        line_kind: "ITEM",
        item_id: Number(itemId),
        sku_id: null,
        uom_id: Number(selectedUnit.id),
        qty: Number(physicalQty),
        rate: Number(displayRate),
        amount: amountDifference,
        meta: {
          stock_type: "RM",
          color_id: colorId || null,
          size_id: sizeId || null,
          uom_id: Number(selectedUnit.id),
          uom_code: selectedUnit.code || null,
          uom_name: selectedUnit.name || null,
          uom_factor_to_base: Number(Number(factorToBase).toFixed(6)),
          system_qty_snapshot: systemQtyBase,
          physical_qty: physicalQtyBase,
          qty_in_display: roundQty3(Number(qtyInDisplay || 0)),
          qty_out_display: roundQty3(Number(qtyOutDisplay || 0)),
          qty_in_base: roundQty3(Number(qtyInDisplay || 0) * factorToBase),
          qty_out_base: roundQty3(Number(qtyOutDisplay || 0) * factorToBase),
          system_qty_display: systemQty,
          physical_qty_display: roundQty3(Number(physicalQty)),
          difference_qty: differenceQty,
          negative_stock_risk: Number(physicalQtyBase) < -0.0005,
          difference_qty_base: differenceQtyBase,
          selling_rate_display: roundCost2(displayRate),
        },
      };
    });

    if (!hasDifference) {
      throw new HttpError(
        400,
        "At least one line must contain stock difference",
      );
    }

    return {
      voucherDate,
      stockType,
      remarks,
      reasonCodeId,
      reasonNotes,
      lines,
    };
  }

  const skuIds = [
    ...new Set(
      rawLines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
    ),
  ];
  if (!skuIds.length) throw new HttpError(400, "SKU is required");

  const [skuMap, skuSnapshotBySkuId] = await Promise.all([
    fetchSkuMapTx({ trx, skuIds, expectedStockType: stockType }),
    loadSkuSystemSnapshotBySkuIdTx({ trx, branchId: req.branchId, skuIds }),
  ]);

  const missingSku = skuIds.find((id) => !skuMap.has(Number(id)));
  if (missingSku) {
    throw new HttpError(
      400,
      `Invalid SKU for selected stock type: ${missingSku}`,
    );
  }

  const baseUomIds = [
    ...new Set(
      [...skuMap.values()]
        .map((row) => toPositiveInt(row?.base_uom_id))
        .filter(Boolean),
    ),
  ];
  const unitOptionsByBase = await loadUnitOptionsByBaseUomIdTx({
    trx,
    baseUomIds,
  });

  let hasDifference = false;
  const lines = rawLines.map((raw, index) => {
    const skuId = toPositiveInt(raw?.sku_id);
    if (!skuId) throw new HttpError(400, `Line ${index + 1}: SKU is required`);

    const sku = skuMap.get(Number(skuId));
    const baseUomId = toPositiveInt(sku?.base_uom_id);
    const unitOptions = unitOptionsByBase.get(Number(baseUomId || 0)) || [];
    const selectedUomId = toPositiveInt(raw?.uom_id);
    const selectedUnit =
      unitOptions.find(
        (option) => Number(option.id) === Number(selectedUomId || 0),
      ) || pickPreferredUomOption(unitOptions);
    if (!selectedUnit) {
      throw new HttpError(400, `Line ${index + 1}: selected unit is invalid`);
    }

    const factorToBase = Number(selectedUnit.factor_to_base || 0);
    if (!(factorToBase > 0)) {
      throw new HttpError(400, `Line ${index + 1}: unit conversion is invalid`);
    }

    const requestedRowStatus = isBaseUnitOption(selectedUnit)
      ? "LOOSE"
      : "PACKED";
    const snapshot = skuSnapshotBySkuId.get(Number(skuId)) || {
      qty_pairs: 0,
      value: 0,
      wac: 0,
      loose_qty_pairs: 0,
      loose_value: 0,
      loose_wac: 0,
      packed_qty_pairs: 0,
      packed_value: 0,
      packed_wac: 0,
    };
    const fgResolved =
      stockType === "FG"
        ? resolveFgSnapshotByStatus({
            snapshot,
            requestedStatus: requestedRowStatus,
          })
        : null;
    const rowStatus =
      stockType === "FG"
        ? fgResolved?.rowStatus || requestedRowStatus
        : requestedRowStatus;
    const systemPairs =
      stockType === "FG"
        ? roundQty3(Number(fgResolved?.qtyPairs || 0))
        : roundQty3(Number(snapshot.qty_pairs || 0));
    const systemQty = roundQty3(systemPairs / factorToBase);

    // SKU adjustments are entered as Quantity In and Quantity Out per selected unit.
    const qtyInInput = toNonNegativeNumber(raw?.qty_in, 3);
    const qtyOutInput = toNonNegativeNumber(raw?.qty_out, 3);
    const hasSplitInput = qtyInInput !== null || qtyOutInput !== null;

    if (hasSplitInput && (qtyInInput === null || qtyOutInput === null)) {
      throw new HttpError(
        400,
        `Line ${index + 1}: quantity in/out must be zero or greater`,
      );
    }

    let qtyInDisplay = qtyInInput;
    let qtyOutDisplay = qtyOutInput;
    let qtyInPairs;
    let qtyOutPairs;
    let differencePairs;
    let differenceQty;
    let physicalPairs;
    let physicalQty;

    const toWholePairs = (qtyValue, label) => {
      const rawPairs = Number(qtyValue || 0) * factorToBase;
      const roundedPairs = Math.round(rawPairs);
      if (Math.abs(rawPairs - roundedPairs) > 0.0005) {
        throw new HttpError(
          400,
          `Line ${index + 1}: ${label} must convert to whole pairs`,
        );
      }
      return roundedPairs;
    };

    if (hasSplitInput) {
      qtyInDisplay = roundQty3(qtyInInput || 0);
      qtyOutDisplay = roundQty3(qtyOutInput || 0);
      qtyInPairs = toWholePairs(qtyInDisplay, "quantity in");
      qtyOutPairs = toWholePairs(qtyOutDisplay, "quantity out");
      differencePairs = Number(qtyInPairs) - Number(qtyOutPairs);
      differenceQty = roundQty3(Number(qtyInDisplay) - Number(qtyOutDisplay));
      physicalPairs = Number(systemPairs) + Number(differencePairs);
      physicalQty = roundQty3(systemQty + differenceQty);
    } else {
      const legacyPhysicalQty = toNonNegativeNumber(
        raw?.physical_qty ?? raw?.qty,
        3,
      );
      if (legacyPhysicalQty === null) {
        throw new HttpError(
          400,
          `Line ${index + 1}: quantity in and quantity out are required`,
        );
      }
      physicalQty = roundQty3(legacyPhysicalQty);
      const physicalPairsRaw = Number(physicalQty) * factorToBase;
      physicalPairs = Math.round(physicalPairsRaw);
      if (Math.abs(physicalPairsRaw - physicalPairs) > 0.0005) {
        throw new HttpError(
          400,
          `Line ${index + 1}: physical quantity must convert to whole pairs`,
        );
      }
      differencePairs = Number(physicalPairs) - Number(systemPairs);
      differenceQty = roundQty3(Number(physicalQty) - systemQty);
      qtyInPairs = differencePairs > 0 ? Number(differencePairs) : 0;
      qtyOutPairs = differencePairs < 0 ? Math.abs(Number(differencePairs)) : 0;
      qtyInDisplay = differenceQty > 0 ? roundQty3(differenceQty) : 0;
      qtyOutDisplay = differenceQty < 0 ? roundQty3(Math.abs(differenceQty)) : 0;
    }

    if (differencePairs !== 0) hasDifference = true;

    const statusWac =
      stockType === "FG"
        ? Number(fgResolved?.wac || 0)
        : Number(snapshot.wac || 0);
    const fallbackRateByWac = Number(statusWac || 0) * factorToBase;
    const displayRateRaw =
      Number(sku?.sale_rate || 0) > 0
        ? Number(sku.sale_rate)
        : Number(fallbackRateByWac || 0);
    const displayRate = roundUnitCost6(displayRateRaw);
    const amountDifference = roundCost2(
      Number(differenceQty) * Number(displayRate),
    );

    return {
      line_no: index + 1,
      line_kind: "SKU",
      item_id: null,
      sku_id: Number(skuId),
      uom_id: Number(selectedUnit.id),
      qty: Number(physicalQty),
      rate: Number(displayRate),
      amount: amountDifference,
      meta: {
        stock_type: stockType,
        row_status: rowStatus,
        requested_row_status: requestedRowStatus,
        uom_id: Number(selectedUnit.id),
        uom_code: selectedUnit.code || null,
        uom_name: selectedUnit.name || null,
        uom_factor_to_base: Number(Number(factorToBase).toFixed(6)),
        system_qty_pairs_snapshot: Number(systemPairs),
        physical_qty_pairs: Number(physicalPairs),
        qty_in_pairs: Number(qtyInPairs || 0),
        qty_out_pairs: Number(qtyOutPairs || 0),
        difference_qty_pairs: Number(differencePairs),
        qty_in_display: roundQty3(Number(qtyInDisplay || 0)),
        qty_out_display: roundQty3(Number(qtyOutDisplay || 0)),
        system_qty_display: systemQty,
        physical_qty_display: roundQty3(Number(physicalQty)),
        difference_qty: differenceQty,
        negative_stock_risk: Number(physicalPairs) < 0,
        selling_rate_display: roundCost2(displayRate),
      },
    };
  });

  if (!hasDifference) {
    throw new HttpError(400, "At least one line must contain stock difference");
  }

  return {
    voucherDate,
    stockType,
    remarks,
    reasonCodeId,
    reasonNotes,
    lines,
  };
};

const ensureStockCountAdjustmentInfraTx = async ({ trx }) => {
  const [hasHeader, hasLine] = await Promise.all([
    hasStockCountHeaderTableTx(trx),
    hasStockCountLineTableTx(trx),
  ]);
  if (!hasHeader || !hasLine) {
    throw new HttpError(
      400,
      "Stock count adjustment tables are unavailable. Run latest inventory migration.",
    );
  }
};

// Persist stock count extension rows tied to voucher_header/voucher_line records.
const upsertStockCountAdjustmentExtensionsTx = async ({
  trx,
  voucherId,
  stockType,
  reasonCodeId,
  reasonNotes,
  lines,
}) => {
  await ensureStockCountAdjustmentInfraTx({ trx });

  await trx("erp.stock_count_header")
    .insert({
      voucher_id: Number(voucherId),
      item_type_scope: stockType,
      reason_code_id: toPositiveInt(reasonCodeId),
      notes: normalizeText(reasonNotes || "", 1000),
    })
    .onConflict("voucher_id")
    .merge(["item_type_scope", "reason_code_id", "notes"]);

  const voucherLines = await trx("erp.voucher_line")
    .select("id", "line_no", "meta")
    .where({ voucher_header_id: Number(voucherId) });
  const byLineNo = new Map(
    (Array.isArray(lines) ? lines : []).map((line) => [
      Number(line.line_no || 0),
      line,
    ]),
  );

  const extensionRows = voucherLines.map((voucherLine) => {
    const lineNo = Number(voucherLine.line_no || 0);
    const fromInput = byLineNo.get(lineNo);
    const meta =
      fromInput?.meta && typeof fromInput.meta === "object"
        ? fromInput.meta
        : voucherLine?.meta && typeof voucherLine.meta === "object"
          ? voucherLine.meta
          : {};

    return {
      voucher_line_id: Number(voucherLine.id),
      system_qty_snapshot: roundQty3(Number(meta.system_qty_snapshot || 0)),
      physical_qty: roundQty3(
        Number(meta.physical_qty || fromInput?.meta?.physical_qty || 0),
      ),
      // Store pair snapshots with decimals to preserve precise available quantity displays.
      system_qty_pairs_snapshot: roundQty3(
        Number(meta.system_qty_pairs_snapshot || 0),
      ),
      physical_qty_pairs: roundQty3(Number(meta.physical_qty_pairs || 0)),
      selling_rate_display: roundCost2(
        Number(meta.selling_rate_display || fromInput?.rate || 0),
      ),
    };
  });

  if (extensionRows.length) {
    await trx("erp.stock_count_line")
      .insert(extensionRows)
      .onConflict("voucher_line_id")
      .merge([
        "system_qty_snapshot",
        "physical_qty",
        "system_qty_pairs_snapshot",
        "physical_qty_pairs",
        "selling_rate_display",
      ]);
  }
};

const syncStockCountAdjustmentVoucherTx = async ({ trx, voucherId }) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;

  const header = await trx("erp.voucher_header")
    .select("id", "branch_id", "voucher_date", "status", "voucher_type_code")
    .where({ id: normalizedVoucherId })
    .first();
  if (!header) return;

  const voucherTypeCode = String(header.voucher_type_code || "")
    .trim()
    .toUpperCase();
  if (voucherTypeCode !== INVENTORY_VOUCHER_TYPES.stockCountAdjustment) return;

  await ensureStockCountAdjustmentInfraTx({ trx });

  const lines = await trx("erp.voucher_line as vl")
    .leftJoin("erp.stock_count_line as scl", "scl.voucher_line_id", "vl.id")
    .select(
      "vl.id",
      "vl.line_kind",
      "vl.item_id",
      "vl.sku_id",
      "vl.qty",
      "vl.rate",
      "vl.meta",
      "scl.system_qty_snapshot",
      "scl.physical_qty",
      "scl.system_qty_pairs_snapshot",
      "scl.physical_qty_pairs",
      "scl.selling_rate_display",
    )
    .where({ "vl.voucher_header_id": normalizedVoucherId })
    .orderBy("vl.line_no", "asc");

  const needsRm = lines.some((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType = normalizeStockType(meta.stock_type);
    if (stockType) return stockType === "RM";
    return String(line?.line_kind || "").toUpperCase() === "ITEM";
  });
  const needsSku = lines.some((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType = normalizeStockType(meta.stock_type);
    if (stockType) return stockType === "FG" || stockType === "SFG";
    return String(line?.line_kind || "").toUpperCase() === "SKU";
  });

  await ensureInventoryStockInfraTx({ trx, needsRm, needsSku });

  await rollbackInventoryStockLedgerByVoucherTx({
    trx,
    voucherId: normalizedVoucherId,
  });

  if (String(header.status || "").toUpperCase() !== "APPROVED") return;

  const supportsRmVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const lineKind = String(line?.line_kind || "")
      .trim()
      .toUpperCase();
    const stockType =
      normalizeStockType(meta.stock_type) ||
      (lineKind === "ITEM" ? "RM" : lineKind === "SKU" ? "FG" : null);

    if (!stockType) continue;

    const factorToBase = Number(meta?.uom_factor_to_base || 1);
    const safeFactor =
      Number.isFinite(factorToBase) && factorToBase > 0 ? factorToBase : 1;
    const fallbackUnitCost = roundUnitCost6(
      Number(line?.rate || meta?.selling_rate_display || 0) / safeFactor,
    );

    if (stockType === "RM") {
      const itemId = toPositiveInt(line?.item_id);
      if (!itemId) continue;

      const systemQtyBase = roundQty3(
        Number(line?.system_qty_snapshot ?? meta?.system_qty_snapshot ?? 0),
      );
      const physicalQtyBase = roundQty3(
        Number(line?.physical_qty ?? meta?.physical_qty ?? 0),
      );
      const diffQtyBase = roundQty3(physicalQtyBase - systemQtyBase);
      if (diffQtyBase === 0) continue;

      const colorId = normalizeRmDimensionId(meta?.color_id);
      const sizeId = normalizeRmDimensionId(meta?.size_id);
      if ((colorId || sizeId) && !supportsRmVariantDimensions) {
        throw new HttpError(
          400,
          "RM color/size stock tracking is unavailable. Run latest stock variant migration.",
        );
      }

      const identity = buildRmStockIdentity({
        branchId: Number(header.branch_id),
        stockState: "ON_HAND",
        itemId,
        colorId,
        sizeId,
      });

      await ensureRmBalanceSeedTx({
        trx,
        identity,
        supportsVariantDimensions: supportsRmVariantDimensions,
      });

      const existingQuery = trx("erp.stock_balance_rm")
        .select("qty", "value", "wac")
        .forUpdate();
      applyRmStockIdentityWhere({
        query: existingQuery,
        identity,
        supportsVariantDimensions: supportsRmVariantDimensions,
      });
      const existing = await existingQuery.first();

      const availableQty = Number(existing?.qty || 0);
      const availableValue = Number(existing?.value || 0);
      const unitCost = roundUnitCost6(
        Number(existing?.wac || 0) > 0
          ? Number(existing.wac || 0)
          : availableQty > 0
            ? Number(availableValue || 0) / Number(availableQty || 1)
            : fallbackUnitCost,
      );

      const direction = diffQtyBase > 0 ? 1 : -1;
      const movementQty = roundQty3(Math.abs(diffQtyBase));

      const valueDelta = roundCost2(Number(diffQtyBase) * Number(unitCost));
      const nextQtyRaw =
        direction === 1
          ? roundQty3(availableQty + movementQty)
          : roundQty3(availableQty - movementQty);
      const nextQty = Math.abs(nextQtyRaw) <= 0.0005 ? 0 : nextQtyRaw;
      const provisionalValue = roundCost2(availableValue + valueDelta);
      const nextValue = nextQty === 0 ? 0 : provisionalValue;
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

      await insertRmStockLedgerTx({
        trx,
        branchId: Number(header.branch_id),
        itemId,
        colorId,
        sizeId,
        voucherId: normalizedVoucherId,
        voucherLineId: toPositiveInt(line?.id),
        txnDate: toDateOnly(header.voucher_date),
        direction,
        qty: movementQty,
        unitCost,
        value: valueDelta,
      });
      continue;
    }

    if (stockType !== "FG" && stockType !== "SFG") continue;

    const skuId = toPositiveInt(line?.sku_id);
    if (!skuId) continue;

    const systemPairs = Math.round(
      Number(
        line?.system_qty_pairs_snapshot ??
          meta?.system_qty_pairs_snapshot ??
          0,
      ),
    );
    const physicalPairs = Math.round(
      Number(line?.physical_qty_pairs ?? meta?.physical_qty_pairs ?? 0),
    );
    const diffPairs = Number(physicalPairs) - Number(systemPairs);
    if (diffPairs === 0) continue;

    const isPackedRow =
      stockType === "FG" && normalizeRowStatus(meta?.row_status) === "PACKED";

    await trx("erp.stock_balance_sku")
      .insert({
        branch_id: Number(header.branch_id),
        stock_state: "ON_HAND",
        category: stockType,
        is_packed: isPackedRow,
        sku_id: Number(skuId),
        qty_pairs: 0,
        value: 0,
        wac: 0,
        last_txn_at: trx.fn.now(),
      })
      .onConflict([
        "branch_id",
        "stock_state",
        "category",
        "is_packed",
        "sku_id",
      ])
      .ignore();

    await trx("erp.stock_balance_sku")
      .select("qty_pairs", "value", "wac")
      .where({
        branch_id: Number(header.branch_id),
        stock_state: "ON_HAND",
        category: stockType,
        is_packed: isPackedRow,
        sku_id: Number(skuId),
      })
      .first()
      .forUpdate();

    const bucketSnapshot = await loadSkuBucketSnapshotFromLedgerTx({
      trx,
      branchId: Number(header.branch_id),
      stockState: "ON_HAND",
      stockType,
      skuId: Number(skuId),
      rowStatus: isPackedRow ? "PACKED" : "LOOSE",
    });
    const availableQtyPairs = Number(bucketSnapshot?.qtyPairs || 0);
    const availableValue = Number(bucketSnapshot?.value || 0);
    const movementPairs = Math.abs(Number(diffPairs || 0));

    const unitCost = roundUnitCost6(
      Number(bucketSnapshot?.wac || 0) > 0
        ? Number(bucketSnapshot.wac || 0)
        : availableQtyPairs > 0
          ? Number(availableValue || 0) / Number(availableQtyPairs || 1)
          : fallbackUnitCost,
    );
    const valueDelta = roundCost2(Number(diffPairs) * Number(unitCost));
    const nextQtyPairs = Number(availableQtyPairs) + Number(diffPairs);
    const provisionalValue = roundCost2(Number(availableValue) + Number(valueDelta));
    const nextValue = nextQtyPairs === 0 ? 0 : provisionalValue;
    const nextWac =
      nextQtyPairs !== 0 ? roundUnitCost6(nextValue / nextQtyPairs) : 0;

    await trx("erp.stock_balance_sku")
      .where({
        branch_id: Number(header.branch_id),
        stock_state: "ON_HAND",
        category: stockType,
        is_packed: isPackedRow,
        sku_id: Number(skuId),
      })
      .update({
        qty_pairs: nextQtyPairs,
        value: nextValue,
        wac: nextWac,
        last_txn_at: trx.fn.now(),
      });

    await trx("erp.stock_ledger").insert({
      branch_id: Number(header.branch_id),
      category: stockType,
      stock_state: "ON_HAND",
      item_id: null,
      sku_id: Number(skuId),
      voucher_header_id: Number(normalizedVoucherId),
      voucher_line_id: toPositiveInt(line?.id),
      txn_date: toDateOnly(header.voucher_date),
      direction: diffPairs > 0 ? 1 : -1,
      qty: 0,
      qty_pairs: Number(movementPairs),
      unit_cost: roundUnitCost6(unitCost),
      value: roundCost2(valueDelta),
    });
  }
};

const hasStockCountNegativeStockRisk = (validated) =>
  (Array.isArray(validated?.lines) ? validated.lines : []).some((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    if (meta.negative_stock_risk === true) return true;
    if (Number(meta.physical_qty || 0) < -0.0005) return true;
    if (Number(meta.physical_qty_pairs || 0) < 0) return true;
    return false;
  });

const toStockCountApprovalPayload = ({
  action,
  voucherTypeCode,
  voucherId,
  voucherNo,
  validated,
  permissionReroute = false,
  negativeStockApprovalReroute = false,
  approvalReason = null,
}) => ({
  action,
  voucher_id: voucherId,
  voucher_no: voucherNo,
  voucher_type_code: voucherTypeCode,
  voucher_date: validated.voucherDate,
  stock_type: validated.stockType,
  remarks: validated.remarks,
  reason_code_id: validated.reasonCodeId,
  reason_notes: validated.reasonNotes,
  lines: validated.lines,
  permission_reroute: permissionReroute === true,
  negative_stock_approval_reroute: negativeStockApprovalReroute === true,
  approval_reason: approvalReason || null,
});

const createStockCountAdjustmentVoucher = async ({
  req,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const canCreate = canDo(req, "VOUCHER", scopeKey, "create");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const validated = await validateStockCountAdjustmentPayloadTx({
      trx,
      req,
      payload,
    });

    const voucherNo = await getNextVoucherNoTx(
      trx,
      req.branchId,
      voucherTypeCode,
    );
    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "create",
    );
    const negativeStockRouting = resolveNegativeStockApprovalRouting({
      hasNegativeStockRisk: hasStockCountNegativeStockRisk(validated),
      canApproveVoucherAction: req?.user?.isAdmin === true,
      voucherTypeCode,
    });
    const queuedForApproval =
      !canCreate ||
      (policyRequiresApproval && !canApprove) ||
      negativeStockRouting.queueForApproval;

    const [header] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: voucherTypeCode,
        voucher_no: voucherNo,
        branch_id: req.branchId,
        voucher_date: validated.voucherDate,
        book_no: null,
        status: queuedForApproval ? "PENDING" : "APPROVED",
        created_by: req.user.id,
        approved_by: queuedForApproval ? null : req.user.id,
        approved_at: queuedForApproval ? null : trx.fn.now(),
        remarks: validated.remarks,
      })
      .returning(["id", "voucher_no", "status"]);

    await insertVoucherLinesTx({
      trx,
      voucherId: header.id,
      lines: validated.lines,
    });

    await upsertStockCountAdjustmentExtensionsTx({
      trx,
      voucherId: header.id,
      stockType: validated.stockType,
      reasonCodeId: validated.reasonCodeId,
      reasonNotes: validated.reasonNotes,
      lines: validated.lines,
    });

    if (!queuedForApproval) {
      await syncVoucherGlPostingTx({ trx, voucherId: header.id });
      await syncStockCountAdjustmentVoucherTx({ trx, voucherId: header.id });
    }

    let approvalRequestId = null;
    if (queuedForApproval) {
      approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: header.id,
        voucherTypeCode,
        summary: `${voucherTypeCode} #${header.voucher_no}`,
        newValue: toStockCountApprovalPayload({
          action: "create",
          voucherTypeCode,
          voucherId: header.id,
          voucherNo: header.voucher_no,
          validated,
          permissionReroute: !canCreate,
          negativeStockApprovalReroute:
            negativeStockRouting.negativeStockApprovalReroute,
          approvalReason: negativeStockRouting.approvalReason,
        }),
      });
    }

    return {
      id: header.id,
      voucherNo: header.voucher_no,
      status: header.status,
      approvalRequestId,
      queuedForApproval,
      permissionReroute: !canCreate,
      negativeStockApprovalReroute:
        negativeStockRouting.negativeStockApprovalReroute,
      approvalReason: negativeStockRouting.approvalReason,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "CREATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
    },
  });

  return result;
};

const updateStockCountAdjustmentVoucher = async ({
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

  const canEdit = canDo(req, "VOUCHER", scopeKey, "edit");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const existing = await trx("erp.voucher_header as vh")
      .leftJoin("erp.stock_count_header as sch", "sch.voucher_id", "vh.id")
      .select(
        "vh.id",
        "vh.voucher_no",
        "vh.status",
        "vh.voucher_date",
        "vh.remarks",
        "sch.reason_code_id",
        "sch.notes",
      )
      .where({
        "vh.id": normalizedVoucherId,
        "vh.branch_id": req.branchId,
        "vh.voucher_type_code": voucherTypeCode,
      })
      .first();

    if (!existing) throw new HttpError(404, "Voucher not found");
    if (existing.status === "REJECTED") {
      throw new HttpError(400, "Deleted voucher cannot be edited");
    }

    const validated = await validateStockCountAdjustmentPayloadTx({
      trx,
      req,
      payload,
    });

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "edit",
    );
    const negativeStockRouting = resolveNegativeStockApprovalRouting({
      hasNegativeStockRisk: hasStockCountNegativeStockRisk(validated),
      canApproveVoucherAction: req?.user?.isAdmin === true,
      voucherTypeCode,
    });
    const queuedForApproval =
      !canEdit ||
      (policyRequiresApproval && !canApprove) ||
      negativeStockRouting.queueForApproval;

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: existing.id,
        voucherTypeCode,
        summary: `UPDATE ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: {
          voucher_date: existing.voucher_date,
          remarks: existing.remarks,
          status: existing.status,
          reason_code_id: existing.reason_code_id,
          reason_notes: existing.notes,
        },
        newValue: toStockCountApprovalPayload({
          action: "update",
          voucherTypeCode,
          voucherId: existing.id,
          voucherNo: existing.voucher_no,
          validated,
          permissionReroute: !canEdit,
          negativeStockApprovalReroute:
            negativeStockRouting.negativeStockApprovalReroute,
          approvalReason: negativeStockRouting.approvalReason,
        }),
      });

      return {
        id: existing.id,
        voucherNo: existing.voucher_no,
        status: existing.status,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canEdit,
        negativeStockApprovalReroute:
          negativeStockRouting.negativeStockApprovalReroute,
        approvalReason: negativeStockRouting.approvalReason,
        updated: false,
      };
    }

    await trx("erp.voucher_header").where({ id: existing.id }).update({
      voucher_date: validated.voucherDate,
      book_no: null,
      remarks: validated.remarks,
      status: "APPROVED",
      approved_by: req.user.id,
      approved_at: trx.fn.now(),
    });

    await trx("erp.voucher_line")
      .where({ voucher_header_id: existing.id })
      .del();
    await insertVoucherLinesTx({
      trx,
      voucherId: existing.id,
      lines: validated.lines,
    });

    await upsertStockCountAdjustmentExtensionsTx({
      trx,
      voucherId: existing.id,
      stockType: validated.stockType,
      reasonCodeId: validated.reasonCodeId,
      reasonNotes: validated.reasonNotes,
      lines: validated.lines,
    });

    await syncVoucherGlPostingTx({ trx, voucherId: existing.id });
    await syncStockCountAdjustmentVoucherTx({ trx, voucherId: existing.id });

    return {
      id: existing.id,
      voucherNo: existing.voucher_no,
      status: "APPROVED",
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      negativeStockApprovalReroute: false,
      approvalReason: null,
      updated: true,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "UPDATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      updated: result.updated === true,
    },
  });

  return result;
};

const deleteStockCountAdjustmentVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

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
    if (existing.status === "REJECTED") {
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
      const approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: existing.id,
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
        voucherNo: existing.voucher_no,
        status: existing.status,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canDelete,
        deleted: false,
      };
    }

    await applyInventoryVoucherDeletePayloadTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode,
      approverId: req.user.id,
    });

    return {
      id: existing.id,
      voucherNo: existing.voucher_no,
      status: "REJECTED",
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      deleted: true,
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
      deleted: result.deleted === true,
    },
  });

  return result;
};

const loadStockCountAdjustmentVoucherOptions = async (req) => {
  const baseOptions = await loadOpeningStockVoucherOptions(req);

  const [reasonCodes, skuSnapshots, rmSnapshots, hasRmVariantDimensions] =
    await Promise.all([
      loadReasonCodesForVoucherTypeTx({
        trx: knex,
        voucherTypeCode: INVENTORY_VOUCHER_TYPES.stockCountAdjustment,
      }),
      loadSkuSystemSnapshotBySkuIdTx({
        trx: knex,
        branchId: req.branchId,
        skuIds: (baseOptions.skus || []).map((entry) => entry.id),
      }),
      loadRmSystemSnapshotByKeyTx({
        trx: knex,
        branchId: req.branchId,
        itemIds: (baseOptions.rmItems || []).map((entry) => entry.id),
      }),
      hasStockBalanceRmVariantDimensionsTx(knex),
    ]);

  const rmSnapshotByKey = {};
  rmSnapshots.forEach((value, key) => {
    rmSnapshotByKey[key] = {
      qty: roundQty3(Number(value?.qty || 0)),
      value: roundCost2(Number(value?.value || 0)),
      wac: roundUnitCost6(Number(value?.wac || 0)),
      color_id: toPositiveInt(value?.color_id),
      size_id: toPositiveInt(value?.size_id),
    };
  });

  return {
    ...baseOptions,
    reasonCodes,
    skus: (baseOptions.skus || []).map((entry) => {
      const snapshot = skuSnapshots.get(Number(entry.id)) || {
        qty_pairs: 0,
        value: 0,
        wac: 0,
        loose_qty_pairs: 0,
        loose_value: 0,
        loose_wac: 0,
        packed_qty_pairs: 0,
        packed_value: 0,
        packed_wac: 0,
      };
      return {
        ...entry,
        system_qty_pairs: Number(snapshot.qty_pairs || 0),
        system_value: Number(snapshot.value || 0),
        system_wac: Number(snapshot.wac || 0),
        system_loose_qty_pairs: Number(snapshot.loose_qty_pairs || 0),
        system_loose_value: Number(snapshot.loose_value || 0),
        system_loose_wac: Number(snapshot.loose_wac || 0),
        system_packed_qty_pairs: Number(snapshot.packed_qty_pairs || 0),
        system_packed_value: Number(snapshot.packed_value || 0),
        system_packed_wac: Number(snapshot.packed_wac || 0),
      };
    }),
    rmSnapshotByKey,
    rmHasVariantDimensions: hasRmVariantDimensions,
  };
};

const loadStockCountAdjustmentVoucherDetails = async ({
  req,
  voucherTypeCode,
  voucherNo,
}) => {
  const targetNo = parseVoucherNo(voucherNo);
  if (!targetNo) return null;

  const header = await knex("erp.voucher_header as vh")
    .leftJoin("erp.stock_count_header as sch", "sch.voucher_id", "vh.id")
    .leftJoin("erp.reason_codes as rc", "rc.id", "sch.reason_code_id")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status",
      "vh.remarks",
      "sch.item_type_scope",
      "sch.reason_code_id",
      "sch.notes as reason_notes",
      "rc.name as reason_name",
    )
    .where({
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": voucherTypeCode,
      "vh.voucher_no": targetNo,
    })
    .first();
  if (!header) return null;

  const lines = await knex("erp.voucher_line as vl")
    .leftJoin("erp.stock_count_line as scl", "scl.voucher_line_id", "vl.id")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as si", "si.id", "v.item_id")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.line_kind",
      "vl.item_id",
      "i.name as item_name",
      "vl.sku_id",
      "s.sku_code",
      "si.name as sku_item_name",
      "si.item_type as sku_item_type",
      "vl.uom_id",
      "u.code as uom_code",
      "u.name as uom_name",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
      "scl.system_qty_snapshot",
      "scl.physical_qty",
      "scl.system_qty_pairs_snapshot",
      "scl.physical_qty_pairs",
      "scl.selling_rate_display",
    )
    .where({ "vl.voucher_header_id": header.id })
    .orderBy("vl.line_no", "asc");

  let derivedStockType = normalizeStockType(header.item_type_scope);
  const mappedLines = (lines || []).map((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType =
      normalizeStockType(meta.stock_type) ||
      (String(line.line_kind || "").toUpperCase() === "ITEM"
        ? "RM"
        : normalizeStockType(line.sku_item_type));
    if (!derivedStockType && stockType) derivedStockType = stockType;

    const safeFactor =
      Number(meta?.uom_factor_to_base || 1) > 0
        ? Number(meta?.uom_factor_to_base || 1)
        : 1;
    const systemQtyDisplay =
      stockType === "RM"
        ? roundQty3(Number(line?.system_qty_snapshot || 0) / safeFactor)
        : roundQty3(Number(line?.system_qty_pairs_snapshot || 0) / safeFactor);
    const physicalQtyDisplay =
      stockType === "RM"
        ? roundQty3(Number(line?.physical_qty || 0) / safeFactor)
        : roundQty3(Number(line?.physical_qty_pairs || 0) / safeFactor);

    return {
      id: Number(line.id),
      line_no: Number(line.line_no || 0),
      line_kind: String(line.line_kind || "").toUpperCase(),
      stock_type: stockType,
      item_id: toPositiveInt(line.item_id),
      item_name: String(line.item_name || ""),
      sku_id: toPositiveInt(line.sku_id),
      sku_code: String(line.sku_code || ""),
      sku_item_name: String(line.sku_item_name || ""),
      row_status: normalizeRowStatus(meta.row_status),
      uom_id: toPositiveInt(meta.uom_id) || toPositiveInt(line.uom_id),
      uom_code: String(meta.uom_code || line.uom_code || "").trim() || null,
      uom_name: String(meta.uom_name || line.uom_name || "").trim() || null,
      uom_factor_to_base: Number(meta.uom_factor_to_base || 0) || null,
      system_qty: systemQtyDisplay,
      physical_qty: physicalQtyDisplay,
      qty_in: roundQty3(
        Number(
          meta?.qty_in_display ??
            (physicalQtyDisplay - systemQtyDisplay > 0
              ? physicalQtyDisplay - systemQtyDisplay
              : 0),
        ),
      ),
      qty_out: roundQty3(
        Number(
          meta?.qty_out_display ??
            (physicalQtyDisplay - systemQtyDisplay < 0
              ? Math.abs(physicalQtyDisplay - systemQtyDisplay)
              : 0),
        ),
      ),
      difference_qty: roundQty3(physicalQtyDisplay - systemQtyDisplay),
      rate: Number(line?.selling_rate_display ?? line?.rate ?? 0),
      amount: roundCost2(Number(line?.amount || 0)),
      color_id: toPositiveInt(meta.color_id),
      size_id: toPositiveInt(meta.size_id),
      system_qty_pairs_snapshot: roundQty3(
        Number(line?.system_qty_pairs_snapshot || 0),
      ),
      physical_qty_pairs: roundQty3(Number(line?.physical_qty_pairs || 0)),
      system_qty_snapshot: roundQty3(Number(line?.system_qty_snapshot || 0)),
      physical_qty_snapshot: roundQty3(Number(line?.physical_qty || 0)),
    };
  });

  return {
    id: Number(header.id),
    voucher_no: Number(header.voucher_no),
    voucher_date: toDateOnly(header.voucher_date),
    status: String(header.status || "").toUpperCase(),
    stock_type: derivedStockType || "FG",
    remarks: header.remarks || "",
    reason_code_id: toPositiveInt(header.reason_code_id),
    reason_name: String(header.reason_name || ""),
    reason_notes: String(header.reason_notes || ""),
    lines: mappedLines,
  };
};

const loadRecentOpeningStockVouchers = async ({ req, voucherTypeCode }) => {
  const rows = await knex("erp.voucher_header")
    .select(
      "id",
      "voucher_no",
      "voucher_date",
      "status",
      "remarks",
      "created_at",
    )
    .where({ voucher_type_code: voucherTypeCode, branch_id: req.branchId })
    .whereNot({ status: "REJECTED" })
    .orderBy("id", "desc")
    .limit(20);

  return rows.map((row) => ({
    ...row,
    voucher_date: toDateOnly(row.voucher_date),
  }));
};

const getOpeningStockVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
  const base = () =>
    knex("erp.voucher_header").where({
      voucher_type_code: voucherTypeCode,
      branch_id: req.branchId,
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

const getOpeningStockVoucherNeighbours = async ({
  req,
  voucherTypeCode,
  cursorNo,
}) => {
  const normalized = parseVoucherNo(cursorNo);
  if (!normalized) return { prevVoucherNo: null, nextVoucherNo: null };

  const base = () =>
    knex("erp.voucher_header").where({
      voucher_type_code: voucherTypeCode,
      branch_id: req.branchId,
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

const loadOpeningStockVoucherDetails = async ({
  req,
  voucherTypeCode,
  voucherNo,
}) => {
  const targetNo = parseVoucherNo(voucherNo);
  if (!targetNo) return null;

  const header = await knex("erp.voucher_header")
    .select("id", "voucher_no", "voucher_date", "status", "remarks")
    .where({
      branch_id: req.branchId,
      voucher_type_code: voucherTypeCode,
      voucher_no: targetNo,
    })
    .first();
  if (!header) return null;

  const lines = await knex("erp.voucher_line as vl")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as si", "si.id", "v.item_id")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.line_kind",
      "vl.item_id",
      "i.code as item_code",
      "i.name as item_name",
      "vl.sku_id",
      "s.sku_code",
      "si.name as sku_item_name",
      "si.item_type as sku_item_type",
      "vl.uom_id",
      "u.code as uom_code",
      "u.name as uom_name",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
    )
    .where({ "vl.voucher_header_id": header.id })
    .orderBy("vl.line_no", "asc");

  let derivedStockType = null;
  const mappedLines = (lines || []).map((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType =
      normalizeStockType(meta.stock_type) ||
      (String(line.line_kind || "").toUpperCase() === "ITEM"
        ? "RM"
        : normalizeStockType(line.sku_item_type));

    if (!derivedStockType && stockType) derivedStockType = stockType;

    return {
      id: Number(line.id),
      line_no: Number(line.line_no || 0),
      line_kind: String(line.line_kind || "").toUpperCase(),
      stock_type: stockType,
      item_id: toPositiveInt(line.item_id),
      item_name: String(line.item_name || ""),
      item_code: String(line.item_code || ""),
      sku_id: toPositiveInt(line.sku_id),
      sku_code: String(line.sku_code || ""),
      sku_item_name: String(line.sku_item_name || ""),
      row_status: normalizeRowStatus(meta.row_status),
      uom_id: toPositiveInt(meta.uom_id) || toPositiveInt(line.uom_id),
      uom_code: String(meta.uom_code || line.uom_code || "").trim() || null,
      uom_name: String(meta.uom_name || line.uom_name || "").trim() || null,
      uom_factor_to_base: Number(meta.uom_factor_to_base || 0) || null,
      qty: Number(line.qty || 0),
      rate: Number(line.rate || 0),
      amount: Number(line.amount || 0),
      color_id: toPositiveInt(meta.color_id),
      size_id: toPositiveInt(meta.size_id),
    };
  });

  return {
    id: Number(header.id),
    voucher_no: Number(header.voucher_no),
    voucher_date: toDateOnly(header.voucher_date),
    status: String(header.status || "").toUpperCase(),
    stock_type: derivedStockType || "FG",
    remarks: header.remarks || "",
    lines: mappedLines,
  };
};

// Approval replay hook for inventory vouchers (opening stock + stock count adjustment).
const ensureInventoryVoucherDerivedDataTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
}) => {
  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (normalizedVoucherTypeCode === INVENTORY_VOUCHER_TYPES.openingStock) {
    await syncOpeningStockVoucherTx({ trx, voucherId });
    return;
  }

  if (
    normalizedVoucherTypeCode === INVENTORY_VOUCHER_TYPES.stockCountAdjustment
  ) {
    await syncStockCountAdjustmentVoucherTx({ trx, voucherId });
  }
};

const applyInventoryVoucherUpdatePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  payload = {},
}) => {
  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();

  if (
    normalizedVoucherTypeCode === INVENTORY_VOUCHER_TYPES.stockCountAdjustment
  ) {
    const existingHeader = await trx("erp.stock_count_header")
      .select("item_type_scope", "reason_code_id", "notes")
      .where({ voucher_id: Number(voucherId) })
      .first();

    const stockType =
      normalizeStockType(payload?.stock_type) ||
      normalizeStockType(existingHeader?.item_type_scope) ||
      "FG";
    const reasonCodeId =
      toPositiveInt(payload?.reason_code_id) ||
      toPositiveInt(existingHeader?.reason_code_id);
    const reasonNotes =
      normalizeText(payload?.reason_notes || payload?.notes, 1000) ||
      normalizeText(existingHeader?.notes || "", 1000);
    const payloadLines = Array.isArray(payload?.lines) ? payload.lines : [];

    if (!reasonCodeId) {
      throw new HttpError(400, "Reason is required for stock count adjustment");
    }

    await upsertStockCountAdjustmentExtensionsTx({
      trx,
      voucherId,
      stockType,
      reasonCodeId,
      reasonNotes,
      lines: payloadLines,
    });
  }

  await ensureInventoryVoucherDerivedDataTx({
    trx,
    voucherId,
    voucherTypeCode,
  });
};

module.exports = {
  INVENTORY_VOUCHER_TYPES,
  isInventoryVoucherTypeCode,
  STOCK_TYPE_VALUES,
  parseVoucherNo,
  createOpeningStockVoucher,
  updateOpeningStockVoucher,
  deleteOpeningStockVoucher,
  createStockCountAdjustmentVoucher,
  updateStockCountAdjustmentVoucher,
  deleteStockCountAdjustmentVoucher,
  loadOpeningStockVoucherOptions,
  loadStockCountAdjustmentVoucherOptions,
  loadRecentOpeningStockVouchers,
  getOpeningStockVoucherSeriesStats,
  getOpeningStockVoucherNeighbours,
  loadOpeningStockVoucherDetails,
  loadStockCountAdjustmentVoucherDetails,
  ensureInventoryVoucherDerivedDataTx,
  applyInventoryVoucherUpdatePayloadTx,
  applyInventoryVoucherDeletePayloadTx,
};
