const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog, queueAuditLog } = require("../../utils/audit-log");
const { toLocalDateOnly } = require("../../utils/date-only");
const { syncVoucherGlPostingTx } = require("../financial/gl-posting-service");
const {
  resolveNegativeStockApprovalRouting,
} = require("./negative-stock-approval");

const STOCK_TRANSFER_VOUCHER_TYPES = {
  out: "STN_OUT",
  in: "GRN_IN",
};

const STOCK_TYPE_VALUES = ["FG", "SFG", "RM"];
const STOCK_TYPE_SET = new Set(STOCK_TYPE_VALUES);
const TRANSFER_REASON_VALUES = ["REBALANCING", "DEMAND", "RETURN", "OTHER"];

let approvalRequestHasVoucherTypeCodeColumn;
let stockBalanceRmTableSupport;
let stockBalanceSkuTableSupport;
let stockLedgerTableSupport;
let stockBalanceRmColorColumnSupport;
let stockBalanceRmSizeColumnSupport;
let stockLedgerColorColumnSupport;
let stockLedgerSizeColumnSupport;
let stockTransferOutHasTransferRefColumn;
let stockTransferOutHasStockTypeColumn;
let stockTransferOutHasTransferReasonColumn;
let stockTransferOutHasTransporterNameColumn;
let stockTransferOutHasBillBookNoColumn;
let grnInHasReceivedByUserIdColumn;
let grnInHasReceivedAtColumn;

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
const roundQty3 = (value) => Number(Number(value || 0).toFixed(3));
const roundCost2 = (value) => Number(Number(value || 0).toFixed(2));
const roundUnitCost6 = (value) => Number(Number(value || 0).toFixed(6));
const computeNonNegativeWac = (qty, value) => {
  const numericQty = Number(qty || 0);
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericQty) || Math.abs(numericQty) <= 0.0005) return 0;
  if (!Number.isFinite(numericValue)) return 0;
  const ratio = Math.abs(numericValue) / Math.abs(numericQty);
  return Number.isFinite(ratio) ? roundUnitCost6(ratio) : 0;
};

const parseVoucherNo = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

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

const toNonNegativeNumber = (value, decimals = 3) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(decimals));
};

const normalizeStockType = (value) => {
  const text = String(value || "")
    .trim()
    .toUpperCase();
  return STOCK_TYPE_SET.has(text) ? text : null;
};

const normalizeRowStatus = (value) =>
  String(value || "")
    .trim()
    .toUpperCase() === "LOOSE"
    ? "LOOSE"
    : "PACKED";

const normalizeTransferReason = (value) => {
  const text = String(value || "")
    .trim()
    .toUpperCase();
  return TRANSFER_REASON_VALUES.includes(text) ? text : "OTHER";
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
    approvalRequestHasVoucherTypeCodeColumn = false;
    return false;
  }
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

const hasStockBalanceRmVariantDimensionsTx = async (trx) => {
  const [hasColor, hasSize] = await Promise.all([
    hasStockBalanceRmColorColumnTx(trx),
    hasStockBalanceRmSizeColumnTx(trx),
  ]);
  return hasColor && hasSize;
};

const hasStockLedgerVariantDimensionsTx = async (trx) => {
  const [hasColor, hasSize] = await Promise.all([
    hasStockLedgerColorColumnTx(trx),
    hasStockLedgerSizeColumnTx(trx),
  ]);
  return hasColor && hasSize;
};

const hasStockTransferOutTransferRefColumnTx = async (trx) => {
  if (typeof stockTransferOutHasTransferRefColumn === "boolean") {
    return stockTransferOutHasTransferRefColumn;
  }
  stockTransferOutHasTransferRefColumn = await hasColumnTx(
    trx,
    "erp",
    "stock_transfer_out_header",
    "transfer_ref_no",
  );
  return stockTransferOutHasTransferRefColumn;
};

const hasStockTransferOutStockTypeColumnTx = async (trx) => {
  if (typeof stockTransferOutHasStockTypeColumn === "boolean") {
    return stockTransferOutHasStockTypeColumn;
  }
  stockTransferOutHasStockTypeColumn = await hasColumnTx(
    trx,
    "erp",
    "stock_transfer_out_header",
    "stock_type",
  );
  return stockTransferOutHasStockTypeColumn;
};

const hasStockTransferOutTransferReasonColumnTx = async (trx) => {
  if (typeof stockTransferOutHasTransferReasonColumn === "boolean") {
    return stockTransferOutHasTransferReasonColumn;
  }
  stockTransferOutHasTransferReasonColumn = await hasColumnTx(
    trx,
    "erp",
    "stock_transfer_out_header",
    "transfer_reason",
  );
  return stockTransferOutHasTransferReasonColumn;
};

const hasStockTransferOutTransporterNameColumnTx = async (trx) => {
  if (typeof stockTransferOutHasTransporterNameColumn === "boolean") {
    return stockTransferOutHasTransporterNameColumn;
  }
  stockTransferOutHasTransporterNameColumn = await hasColumnTx(
    trx,
    "erp",
    "stock_transfer_out_header",
    "transporter_name",
  );
  return stockTransferOutHasTransporterNameColumn;
};

const hasStockTransferOutBillBookNoColumnTx = async (trx) => {
  if (typeof stockTransferOutHasBillBookNoColumn === "boolean") {
    return stockTransferOutHasBillBookNoColumn;
  }
  stockTransferOutHasBillBookNoColumn = await hasColumnTx(
    trx,
    "erp",
    "stock_transfer_out_header",
    "bill_book_no",
  );
  return stockTransferOutHasBillBookNoColumn;
};

const hasGrnInReceivedByUserIdColumnTx = async (trx) => {
  if (typeof grnInHasReceivedByUserIdColumn === "boolean") {
    return grnInHasReceivedByUserIdColumn;
  }
  grnInHasReceivedByUserIdColumn = await hasColumnTx(
    trx,
    "erp",
    "grn_in_header",
    "received_by_user_id",
  );
  return grnInHasReceivedByUserIdColumn;
};

const hasGrnInReceivedAtColumnTx = async (trx) => {
  if (typeof grnInHasReceivedAtColumn === "boolean") {
    return grnInHasReceivedAtColumn;
  }
  grnInHasReceivedAtColumn = await hasColumnTx(
    trx,
    "erp",
    "grn_in_header",
    "received_at",
  );
  return grnInHasReceivedAtColumn;
};

const normalizeRmDimensionId = (value) => toPositiveInt(value);

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

const ensureSkuBalanceSeedTx = async ({
  trx,
  branchId,
  stockState = "ON_HAND",
  category,
  skuId,
  isPacked = false,
}) => {
  await trx("erp.stock_balance_sku")
    .insert({
      branch_id: Number(branchId),
      stock_state: String(stockState || "ON_HAND")
        .trim()
        .toUpperCase(),
      category: String(category || "")
        .trim()
        .toUpperCase(),
      is_packed: Boolean(isPacked),
      sku_id: Number(skuId),
      qty_pairs: 0,
      value: 0,
      wac: 0,
      last_txn_at: trx.fn.now(),
    })
    .onConflict(["branch_id", "stock_state", "category", "is_packed", "sku_id"])
    .ignore();
};

const insertRmStockLedgerTx = async ({
  trx,
  branchId,
  stockState = "ON_HAND",
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
    stock_state: String(stockState || "ON_HAND")
      .trim()
      .toUpperCase(),
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

const insertSkuStockLedgerTx = async ({
  trx,
  branchId,
  stockState = "ON_HAND",
  category,
  skuId,
  voucherId,
  voucherLineId = null,
  txnDate,
  direction,
  qtyPairs,
  unitCost,
  value,
}) => {
  await trx("erp.stock_ledger").insert({
    branch_id: Number(branchId),
    category: String(category || "")
      .trim()
      .toUpperCase(),
    stock_state: String(stockState || "ON_HAND")
      .trim()
      .toUpperCase(),
    item_id: null,
    sku_id: Number(skuId),
    voucher_header_id: Number(voucherId),
    voucher_line_id: toPositiveInt(voucherLineId),
    txn_date: txnDate,
    direction: Number(direction),
    qty: 0,
    qty_pairs: Number(qtyPairs || 0),
    unit_cost: roundUnitCost6(unitCost),
    value: roundCost2(value),
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

  const supportsRmVariants = await hasStockBalanceRmVariantDimensionsTx(trx);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const direction = Number(row?.direction || 0);
    const category = String(row?.category || "")
      .trim()
      .toUpperCase();
    const stockState = String(row?.stock_state || "ON_HAND")
      .trim()
      .toUpperCase();

    if (category === "RM") {
      const identity = buildRmStockIdentity({
        branchId: row?.branch_id,
        stockState,
        itemId: row?.item_id,
        colorId: row?.color_id,
        sizeId: row?.size_id,
      });
      if (!identity.branchId || !identity.itemId) continue;
      await ensureRmBalanceSeedTx({
        trx,
        identity,
        supportsVariantDimensions: supportsRmVariants,
      });
      const targetQuery = trx("erp.stock_balance_rm")
        .select("qty", "value")
        .forUpdate();
      applyRmStockIdentityWhere({
        query: targetQuery,
        identity,
        supportsVariantDimensions: supportsRmVariants,
      });
      const target = await targetQuery.first();
      const qty = roundQty3(Number(row?.qty || 0));
      const value = roundCost2(Math.abs(Number(row?.value || 0)));
      const nextQty =
        direction === -1
          ? roundQty3(Number(target?.qty || 0) + qty)
          : roundQty3(Number(target?.qty || 0) - qty);
      const normalizedQty = Math.abs(nextQty) <= 0.0005 ? 0 : nextQty;
      const nextValueRaw =
        direction === -1
          ? roundCost2(Number(target?.value || 0) + value)
          : roundCost2(Number(target?.value || 0) - value);
      const normalizedValue = normalizedQty === 0 ? 0 : nextValueRaw;
      const normalizedWac =
        normalizedQty !== 0
          ? roundUnitCost6(normalizedValue / normalizedQty)
          : 0;
      const updateQuery = trx("erp.stock_balance_rm").update({
        qty: normalizedQty,
        value: normalizedValue,
        wac: normalizedWac,
        last_txn_at: trx.fn.now(),
      });
      applyRmStockIdentityWhere({
        query: updateQuery,
        identity,
        supportsVariantDimensions: supportsRmVariants,
      });
      await updateQuery;
      continue;
    }

    if (category !== "FG" && category !== "SFG") continue;
    const branchId = toPositiveInt(row?.branch_id);
    const skuId = toPositiveInt(row?.sku_id);
    const qtyPairs = Number(row?.qty_pairs || 0);
    const value = roundCost2(Math.abs(Number(row?.value || 0)));
    if (!branchId || !skuId || !Number.isInteger(qtyPairs) || qtyPairs <= 0)
      continue;
    await ensureSkuBalanceSeedTx({
      trx,
      branchId,
      stockState,
      category,
      skuId,
    });
    const existing = await trx("erp.stock_balance_sku")
      .select("qty_pairs", "value")
      .where({
        branch_id: branchId,
        stock_state: stockState,
        category,
        is_packed: false,
        sku_id: skuId,
      })
      .first()
      .forUpdate();
    const nextQtyPairs =
      direction === -1
        ? Number(existing?.qty_pairs || 0) + qtyPairs
        : Number(existing?.qty_pairs || 0) - qtyPairs;
    const nextValue =
      direction === -1
        ? roundCost2(Number(existing?.value || 0) + value)
        : roundCost2(Number(existing?.value || 0) - value);
    const normalizedQtyPairs = Number(nextQtyPairs || 0);
    const normalizedValue =
      normalizedQtyPairs === 0 ? 0 : Number(nextValue || 0);
    const normalizedWac = computeNonNegativeWac(
      normalizedQtyPairs,
      normalizedValue,
    );
    await trx("erp.stock_balance_sku")
      .where({
        branch_id: branchId,
        stock_state: stockState,
        category,
        is_packed: false,
        sku_id: skuId,
      })
      .update({
        qty_pairs: normalizedQtyPairs,
        value: normalizedValue,
        wac: normalizedWac,
        last_txn_at: trx.fn.now(),
      });
  }

  if (rows.length) {
    await trx("erp.stock_ledger")
      .where({ voucher_header_id: normalizedVoucherId })
      .del();
  }
};

const ensureInventoryStockInfraTx = async ({ trx, needsRm, needsSku }) => {
  const hasLedger = await hasStockLedgerTableTx(trx);
  if (!hasLedger)
    throw new HttpError(400, "Stock ledger infrastructure is unavailable");
  if (needsRm && !(await hasStockBalanceRmTableTx(trx))) {
    throw new HttpError(400, "RM stock balance infrastructure is unavailable");
  }
  if (needsSku && !(await hasStockBalanceSkuTableTx(trx))) {
    throw new HttpError(400, "SKU stock balance infrastructure is unavailable");
  }
};

const ensureRmBalanceAvailableTx = async ({
  trx,
  identity,
  qtyRequired,
  valueRequired,
  supportsVariantDimensions,
  allowNegativeSource = false,
}) => {
  await ensureRmBalanceSeedTx({ trx, identity, supportsVariantDimensions });
  const query = trx("erp.stock_balance_rm").select("qty", "value").forUpdate();
  applyRmStockIdentityWhere({ query, identity, supportsVariantDimensions });
  const row = await query.first();
  const availableQty = Number(row?.qty || 0);
  const availableValue = Number(row?.value || 0);
  if (
    !allowNegativeSource &&
    availableQty + 0.0005 < Number(qtyRequired || 0)
  ) {
    throw new HttpError(400, "Insufficient stock quantity for transfer");
  }
  if (
    !allowNegativeSource &&
    availableValue + 0.05 < Number(valueRequired || 0)
  ) {
    throw new HttpError(400, "Insufficient stock value for transfer");
  }
  return row;
};

const moveRmStockTx = async ({
  trx,
  fromIdentity,
  toIdentity,
  qty,
  unitCostBase,
  voucherId,
  voucherLineId,
  voucherDate,
  allowNegativeSource = false,
}) => {
  const normalizedQty = roundQty3(qty);
  if (!(normalizedQty > 0)) return;
  const normalizedUnitCostBase = roundUnitCost6(unitCostBase);
  const value = roundCost2(normalizedQty * normalizedUnitCostBase);
  const supportsVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);

  const fromRow = await ensureRmBalanceAvailableTx({
    trx,
    identity: fromIdentity,
    qtyRequired: normalizedQty,
    valueRequired: value,
    supportsVariantDimensions,
    allowNegativeSource,
  });

  await ensureRmBalanceSeedTx({
    trx,
    identity: toIdentity,
    supportsVariantDimensions,
  });
  const toQuery = trx("erp.stock_balance_rm")
    .select("qty", "value")
    .forUpdate();
  applyRmStockIdentityWhere({
    query: toQuery,
    identity: toIdentity,
    supportsVariantDimensions,
  });
  const toRow = await toQuery.first();

  const nextFromQtyRaw = roundQty3(Number(fromRow?.qty || 0) - normalizedQty);
  const nextFromQty = Math.abs(nextFromQtyRaw) <= 0.0005 ? 0 : nextFromQtyRaw;
  const nextFromValueRaw = roundCost2(Number(fromRow?.value || 0) - value);
  const nextFromValue = nextFromQty === 0 ? 0 : nextFromValueRaw;
  const nextFromWac =
    nextFromQty !== 0 ? roundUnitCost6(nextFromValue / nextFromQty) : 0;

  const fromUpdate = trx("erp.stock_balance_rm").update({
    qty: nextFromQty,
    value: nextFromValue,
    wac: nextFromWac,
    last_txn_at: trx.fn.now(),
  });
  applyRmStockIdentityWhere({
    query: fromUpdate,
    identity: fromIdentity,
    supportsVariantDimensions,
  });
  await fromUpdate;

  const nextToQty = roundQty3(Number(toRow?.qty || 0) + normalizedQty);
  const nextToValue = roundCost2(Number(toRow?.value || 0) + value);
  const nextToWac = nextToQty > 0 ? roundUnitCost6(nextToValue / nextToQty) : 0;
  const toUpdate = trx("erp.stock_balance_rm").update({
    qty: nextToQty,
    value: nextToValue,
    wac: nextToWac,
    last_txn_at: trx.fn.now(),
  });
  applyRmStockIdentityWhere({
    query: toUpdate,
    identity: toIdentity,
    supportsVariantDimensions,
  });
  await toUpdate;

  await insertRmStockLedgerTx({
    trx,
    branchId: fromIdentity.branchId,
    stockState: fromIdentity.stockState,
    itemId: fromIdentity.itemId,
    colorId: fromIdentity.colorId,
    sizeId: fromIdentity.sizeId,
    voucherId,
    voucherLineId,
    txnDate: voucherDate,
    direction: -1,
    qty: normalizedQty,
    unitCost: normalizedUnitCostBase,
    value,
  });

  await insertRmStockLedgerTx({
    trx,
    branchId: toIdentity.branchId,
    stockState: toIdentity.stockState,
    itemId: toIdentity.itemId,
    colorId: toIdentity.colorId,
    sizeId: toIdentity.sizeId,
    voucherId,
    voucherLineId,
    txnDate: voucherDate,
    direction: 1,
    qty: normalizedQty,
    unitCost: normalizedUnitCostBase,
    value,
  });
};

const moveSkuStockPairsTx = async ({
  trx,
  fromBranchId,
  fromStockState = "ON_HAND",
  toBranchId,
  toStockState = "IN_TRANSIT",
  category,
  skuId,
  qtyPairs,
  unitCostBase,
  rowStatus = null,
  voucherId,
  voucherLineId,
  voucherDate,
  allowNegativeSource = false,
}) => {
  const normalizedQtyPairs = Number(qtyPairs || 0);
  if (!Number.isInteger(normalizedQtyPairs) || normalizedQtyPairs <= 0) return;
  const normalizedCategory = String(category || "")
    .trim()
    .toUpperCase();
  if (normalizedCategory !== "FG" && normalizedCategory !== "SFG") {
    throw new HttpError(400, "Unsupported stock type");
  }
  const normalizedRowStatus = normalizeRowStatus(rowStatus);
  const usePackedBucket =
    normalizedCategory === "FG" ? normalizedRowStatus === "PACKED" : false;
  const normalizedUnitCostBase = roundUnitCost6(unitCostBase);
  const value = roundCost2(normalizedQtyPairs * normalizedUnitCostBase);

  await ensureSkuBalanceSeedTx({
    trx,
    branchId: fromBranchId,
    stockState: fromStockState,
    category: normalizedCategory,
    skuId,
    isPacked: usePackedBucket,
  });
  await ensureSkuBalanceSeedTx({
    trx,
    branchId: toBranchId,
    stockState: toStockState,
    category: normalizedCategory,
    skuId,
    isPacked: usePackedBucket,
  });

  await trx("erp.stock_balance_sku")
    .select("qty_pairs", "value")
    .where({
      branch_id: fromBranchId,
      stock_state: String(fromStockState || "ON_HAND")
        .trim()
        .toUpperCase(),
      category: normalizedCategory,
      is_packed: usePackedBucket,
      sku_id: skuId,
    })
    .first()
    .forUpdate();

  const fromSnapshot = await loadSkuBucketSnapshotFromLedgerTx({
    trx,
    branchId: fromBranchId,
    stockState: fromStockState,
    category: normalizedCategory,
    skuId,
    usePackedBucket,
  });
  const availableQtyPairs = Number(fromSnapshot?.qty_pairs || 0);
  const availableValue = Number(fromSnapshot?.value || 0);
  if (!allowNegativeSource && availableQtyPairs < normalizedQtyPairs) {
    throw new HttpError(400, "Insufficient stock quantity for transfer");
  }
  if (!allowNegativeSource && availableValue + 0.05 < value) {
    throw new HttpError(400, "Insufficient stock value for transfer");
  }

  await trx("erp.stock_balance_sku")
    .select("qty_pairs", "value")
    .where({
      branch_id: toBranchId,
      stock_state: String(toStockState || "IN_TRANSIT")
        .trim()
        .toUpperCase(),
      category: normalizedCategory,
      is_packed: usePackedBucket,
      sku_id: skuId,
    })
    .first()
    .forUpdate();
  const toSnapshot = await loadSkuBucketSnapshotFromLedgerTx({
    trx,
    branchId: toBranchId,
    stockState: toStockState,
    category: normalizedCategory,
    skuId,
    usePackedBucket,
  });

  const nextFromQtyPairs =
    Number(availableQtyPairs) - Number(normalizedQtyPairs);
  const nextFromValueRaw = roundCost2(availableValue - value);
  const nextFromValue =
    nextFromQtyPairs === 0
      ? 0
      : allowNegativeSource
        ? nextFromValueRaw
        : Math.max(nextFromValueRaw, 0);
  const nextFromWac = computeNonNegativeWac(nextFromQtyPairs, nextFromValue);
  await trx("erp.stock_balance_sku")
    .where({
      branch_id: fromBranchId,
      stock_state: String(fromStockState || "ON_HAND")
        .trim()
        .toUpperCase(),
      category: normalizedCategory,
      is_packed: usePackedBucket,
      sku_id: skuId,
    })
    .update({
      qty_pairs: nextFromQtyPairs,
      value: nextFromValue,
      wac: nextFromWac,
      last_txn_at: trx.fn.now(),
    });

  const nextToQtyPairs =
    Number(toSnapshot?.qty_pairs || 0) + normalizedQtyPairs;
  const nextToValue = roundCost2(Number(toSnapshot?.value || 0) + value);
  const nextToWac = computeNonNegativeWac(nextToQtyPairs, nextToValue);
  await trx("erp.stock_balance_sku")
    .where({
      branch_id: toBranchId,
      stock_state: String(toStockState || "IN_TRANSIT")
        .trim()
        .toUpperCase(),
      category: normalizedCategory,
      is_packed: usePackedBucket,
      sku_id: skuId,
    })
    .update({
      qty_pairs: nextToQtyPairs,
      value: nextToValue,
      wac: nextToWac,
      last_txn_at: trx.fn.now(),
    });

  await insertSkuStockLedgerTx({
    trx,
    branchId: fromBranchId,
    stockState: fromStockState,
    category: normalizedCategory,
    skuId,
    voucherId,
    voucherLineId,
    txnDate: voucherDate,
    direction: -1,
    qtyPairs: normalizedQtyPairs,
    unitCost: normalizedUnitCostBase,
    value,
  });
  await insertSkuStockLedgerTx({
    trx,
    branchId: toBranchId,
    stockState: toStockState,
    category: normalizedCategory,
    skuId,
    voucherId,
    voucherLineId,
    txnDate: voucherDate,
    direction: 1,
    qtyPairs: normalizedQtyPairs,
    unitCost: normalizedUnitCostBase,
    value,
  });
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

const fetchRmRateRowsByItemTx = async ({ trx, itemIds = [] }) => {
  const normalized = [
    ...new Set((itemIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return [];
  if (!(await tableExistsTx(trx, "erp.rm_purchase_rates"))) return [];

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

const resolveRmPurchaseRate = ({
  itemRates = [],
  colorId = null,
  sizeId = null,
}) => {
  const normalizedColorId = Number(toPositiveInt(colorId) || 0);
  const normalizedSizeId = Number(toPositiveInt(sizeId) || 0);
  const rates = Array.isArray(itemRates) ? itemRates : [];

  const pickRate = (entry) => {
    const rate = Number(entry?.purchase_rate ?? 0);
    return rate > 0 ? rate : 0;
  };

  const exact = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === normalizedColorId &&
      Number(entry?.size_id || 0) === normalizedSizeId,
  );
  if (exact) return pickRate(exact);

  const colorOnly = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === normalizedColorId &&
      Number(entry?.size_id || 0) === 0,
  );
  if (colorOnly) return pickRate(colorOnly);

  const sizeOnly = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === 0 &&
      Number(entry?.size_id || 0) === normalizedSizeId,
  );
  if (sizeOnly) return pickRate(sizeOnly);

  const fallback = rates.find(
    (entry) =>
      Number(entry?.color_id || 0) === 0 && Number(entry?.size_id || 0) === 0,
  );
  return fallback ? pickRate(fallback) : 0;
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

const buildStockMapKey = ({ itemId, colorId = null, sizeId = null }) =>
  `${Number(itemId || 0)}|${Number(colorId || 0)}|${Number(sizeId || 0)}`;

const loadSourceStockMapsTx = async ({ trx, sourceBranchId }) => {
  const [skuRows, rmRows] = await Promise.all([
    trx("erp.stock_ledger as sl")
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
        "sl.branch_id": sourceBranchId,
        "sl.stock_state": "ON_HAND",
      })
      .whereIn("sl.category", ["FG", "SFG"])
      .groupBy("sl.sku_id", "sl.category", trx.raw(FG_PACKED_FLAG_SQL)),
    trx("erp.stock_balance_rm")
      .select("item_id", "color_id", "size_id", "qty", "wac")
      .where({
        branch_id: sourceBranchId,
        stock_state: "ON_HAND",
      }),
  ]);

  const skuMap = {};
  (skuRows || []).forEach((row) => {
    const key = `${String(row.category || "")
      .trim()
      .toUpperCase()}:${Number(row.sku_id || 0)}`;
    if (!skuMap[key]) {
      skuMap[key] = {
        qty_pairs: 0,
        value: 0,
        wac: 0,
        has_loose_bucket: false,
        has_packed_bucket: false,
        loose_qty_pairs: 0,
        loose_value: 0,
        loose_wac: 0,
        packed_qty_pairs: 0,
        packed_value: 0,
        packed_wac: 0,
      };
    }
    const current = skuMap[key];
    const qtyPairs = Number(row.qty_pairs || 0);
    const value = Number(row.value || 0);
    const category = String(row.category || "")
      .trim()
      .toUpperCase();
    const isPacked = category === "FG" ? row.is_packed === true : false;
    if (isPacked) {
      current.has_packed_bucket = true;
      current.packed_qty_pairs += qtyPairs;
      current.packed_value += value;
    } else {
      current.has_loose_bucket = true;
      current.loose_qty_pairs += qtyPairs;
      current.loose_value += value;
    }
    current.qty_pairs =
      Number(current.loose_qty_pairs || 0) +
      Number(current.packed_qty_pairs || 0);
    current.value =
      Number(current.loose_value || 0) + Number(current.packed_value || 0);
    current.loose_wac =
      Math.abs(current.loose_qty_pairs) > 0
        ? roundUnitCost6(current.loose_value / current.loose_qty_pairs)
        : 0;
    current.packed_wac =
      Math.abs(current.packed_qty_pairs) > 0
        ? roundUnitCost6(current.packed_value / current.packed_qty_pairs)
        : 0;
    current.wac =
      Math.abs(current.qty_pairs) > 0
        ? roundUnitCost6(current.value / current.qty_pairs)
        : 0;
  });

  const rmMap = {};
  (rmRows || []).forEach((row) => {
    const key = buildStockMapKey({
      itemId: row.item_id,
      colorId: row.color_id,
      sizeId: row.size_id,
    });
    rmMap[key] = {
      qty: Number(row.qty || 0),
      wac: Number(row.wac || 0),
    };
  });

  return { skuMap, rmMap };
};

const loadSkuBucketSnapshotFromLedgerTx = async ({
  trx,
  branchId,
  stockState = "ON_HAND",
  category,
  skuId,
  usePackedBucket = false,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuId = toPositiveInt(skuId);
  const normalizedCategory = String(category || "")
    .trim()
    .toUpperCase();
  if (!normalizedBranchId || !normalizedSkuId) {
    return { qty_pairs: 0, value: 0, wac: 0 };
  }
  if (normalizedCategory !== "FG" && normalizedCategory !== "SFG") {
    return { qty_pairs: 0, value: 0, wac: 0 };
  }

  const normalizedStockState = String(stockState || "ON_HAND")
    .trim()
    .toUpperCase();

  let query = trx("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .where({
      "sl.branch_id": normalizedBranchId,
      "sl.stock_state": normalizedStockState,
      "sl.category": normalizedCategory,
      "sl.sku_id": normalizedSkuId,
    })
    .select(
      trx.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END), 0) as qty_pairs",
      ),
    )
    .select(trx.raw("COALESCE(SUM(COALESCE(sl.value, 0)), 0) as value"));

  if (normalizedCategory === "FG") {
    query = usePackedBucket
      ? query.whereRaw(`${FG_PACKED_FLAG_SQL} = true`)
      : query.whereRaw(`${FG_PACKED_FLAG_SQL} = false`);
  }

  const row = await query.first();
  const qtyPairs = Number(row?.qty_pairs || 0);
  const value = Number(row?.value || 0);
  const wac = Math.abs(qtyPairs) > 0 ? roundUnitCost6(value / qtyPairs) : 0;
  return {
    qty_pairs: Number(qtyPairs.toFixed(3)),
    value: Number(value.toFixed(2)),
    wac,
  };
};

const createApprovalRequestTx = async ({
  trx,
  req,
  voucherId,
  voucherTypeCode,
  summary,
  oldValue = null,
  newValue = null,
}) => {
  const payload = {
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
    payload.voucher_type_code = voucherTypeCode;
  }

  let row;
  try {
    [row] = await trx("erp.approval_request").insert(payload).returning(["id"]);
  } catch (err) {
    const isMissingVoucherTypeCol =
      String(err?.code || "").trim() === "42703" &&
      String(err?.message || "")
        .toLowerCase()
        .includes("voucher_type_code");
    if (!isMissingVoucherTypeCol) throw err;
    approvalRequestHasVoucherTypeCodeColumn = false;
    delete payload.voucher_type_code;
    [row] = await trx("erp.approval_request").insert(payload).returning(["id"]);
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
      source: "stock-transfer-voucher-service",
      new_value: newValue,
    },
  });

  return row?.id || null;
};

const getNextVoucherNoTx = async (trx, branchId, voucherTypeCode) => {
  const latest = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .max({ value: "voucher_no" })
    .first();
  return Number(latest?.value || 0) + 1;
};

const toLines = (payload) =>
  Array.isArray(payload?.lines) ? payload.lines : [];

const fetchTransferOutHeaderTx = async ({
  trx,
  req,
  transferRefNo = null,
  stnOutVoucherId = null,
  includeReceivedForVoucherId = null,
}) => {
  const hasBillBookNo = await hasStockTransferOutBillBookNoColumnTx(trx);
  let query = trx("erp.stock_transfer_out_header as sth")
    .join("erp.voucher_header as vh", "vh.id", "sth.voucher_id")
    .select(
      "sth.voucher_id",
      "sth.dest_branch_id",
      "sth.dispatch_date",
      "sth.status",
      "sth.received_voucher_id",
      "vh.branch_id as source_branch_id",
      "vh.voucher_no as stn_voucher_no",
      "vh.voucher_date as stn_voucher_date",
      "vh.book_no as stn_book_no",
      "vh.status as stn_header_status",
      hasBillBookNo
        ? knex.raw("sth.bill_book_no as bill_book_no")
        : knex.raw("vh.book_no as bill_book_no"),
    )
    .where({
      "vh.voucher_type_code": STOCK_TRANSFER_VOUCHER_TYPES.out,
      "sth.dest_branch_id": req.branchId,
    })
    .whereNot("vh.status", "REJECTED");

  if (stnOutVoucherId) {
    query = query.where("sth.voucher_id", Number(stnOutVoucherId));
  } else if (transferRefNo) {
    const hasTransferRef = await hasStockTransferOutTransferRefColumnTx(trx);
    if (hasTransferRef) {
      query = query.whereRaw(
        "upper(coalesce(sth.transfer_ref_no, vh.book_no, '')) = ?",
        [
          String(transferRefNo || "")
            .trim()
            .toUpperCase(),
        ],
      );
    } else {
      query = query.whereRaw("upper(coalesce(vh.book_no, '')) = ?", [
        String(transferRefNo || "")
          .trim()
          .toUpperCase(),
      ]);
    }
  }

  const row = await query.first();
  if (!row) return null;

  const status = String(row.status || "").toUpperCase();
  const linkedReceivedVoucherId = toPositiveInt(row.received_voucher_id);
  const canReuseReceived =
    linkedReceivedVoucherId &&
    includeReceivedForVoucherId &&
    Number(linkedReceivedVoucherId) === Number(includeReceivedForVoucherId);
  if (status !== "DISPATCHED" && !canReuseReceived) {
    return null;
  }

  return row;
};

const loadTransferOutLinesTx = async ({ trx, voucherId }) => {
  const lines = await trx("erp.voucher_line as vl")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as si", "si.id", "v.item_id")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .leftJoin(
      "erp.colors as c",
      "c.id",
      knex.raw("(vl.meta->>'color_id')::bigint"),
    )
    .leftJoin("erp.colors as vc", "vc.id", "v.color_id")
    .leftJoin(
      "erp.sizes as sz",
      "sz.id",
      knex.raw("(vl.meta->>'size_id')::bigint"),
    )
    .leftJoin("erp.sizes as vs", "vs.id", "v.size_id")
    .leftJoin("erp.packing_types as p", "p.id", "v.packing_type_id")
    .leftJoin("erp.grades as g", "g.id", "v.grade_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.line_kind",
      "vl.item_id",
      "vl.sku_id",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
      "i.code as item_code",
      "i.name as item_name",
      "s.sku_code",
      "si.name as sku_item_name",
      "si.item_type as sku_item_type",
      "u.code as uom_code",
      "u.name as uom_name",
      knex.raw("coalesce(c.name, vc.name, '') as color_name"),
      knex.raw("coalesce(sz.name, vs.name, '') as size_name"),
      "p.name as packing_name",
      "g.name as grade_name",
    )
    .where({ "vl.voucher_header_id": voucherId })
    .orderBy("vl.line_no", "asc");

  return (lines || []).map((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType =
      normalizeStockType(meta.stock_type) ||
      (String(line?.line_kind || "").toUpperCase() === "ITEM"
        ? "RM"
        : normalizeStockType(line?.sku_item_type));
    const lineKind = String(line?.line_kind || "").toUpperCase();
    const displayName =
      lineKind === "SKU"
        ? buildSkuDisplayName({
            id: line?.sku_id,
            sku_code: line?.sku_code,
            item_name: line?.sku_item_name || line?.item_name,
            size_name: line?.size_name,
            color_name: line?.color_name,
            packing_name: line?.packing_name,
            grade_name: line?.grade_name,
          })
        : String(line?.item_name || "");
    return {
      id: Number(line.id),
      line_no: Number(line.line_no || 0),
      line_kind: lineKind,
      stock_type: stockType,
      item_id: toPositiveInt(line.item_id),
      item_code: String(line.item_code || ""),
      item_name: String(line.item_name || ""),
      sku_id: toPositiveInt(line.sku_id),
      sku_code: String(line.sku_code || ""),
      sku_item_name: String(line.sku_item_name || ""),
      display_name: String(displayName || ""),
      qty: Number(line.qty || 0),
      rate: Number(line.rate || 0),
      amount: Number(line.amount || 0),
      uom_id: toPositiveInt(meta.uom_id) || toPositiveInt(line.uom_id),
      uom_code: String(meta.uom_code || line.uom_code || ""),
      uom_name: String(meta.uom_name || line.uom_name || ""),
      uom_factor_to_base: Number(meta.uom_factor_to_base || 1),
      color_id: toPositiveInt(meta.color_id),
      color_name: String(line.color_name || ""),
      size_id: toPositiveInt(meta.size_id),
      size_name: String(line.size_name || ""),
      packing_name: String(line.packing_name || ""),
      grade_name: String(line.grade_name || ""),
      row_status:
        String(meta.row_status || "")
          .trim()
          .toUpperCase() || null,
      available_qty: Number(meta.available_qty || 0),
      available_qty_base: Number(meta.available_qty_base || 0),
      transfer_qty_base: Number(meta.transfer_qty_base || 0),
      transfer_qty_pairs: Number(meta.transfer_qty_pairs || 0),
      unit_cost_base: Number(meta.unit_cost_base || 0),
    };
  });
};

const validateTransferOutPayloadTx = async ({
  trx,
  req,
  payload,
  transferRefNo,
  transferRefNoProvided = false,
  currentVoucherId = null,
}) => {
  const voucherDate = toDateOnly(payload?.voucher_date);
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  const stockType = normalizeStockType(payload?.stock_type);
  if (!stockType) throw new HttpError(400, "Stock type is required");

  const destinationBranchId = toPositiveInt(payload?.destination_branch_id);
  if (!destinationBranchId)
    throw new HttpError(400, "Destination branch is required");
  if (Number(destinationBranchId) === Number(req.branchId)) {
    throw new HttpError(
      400,
      "Destination branch must be different from source branch",
    );
  }
  if (
    Array.isArray(req.branchScope) &&
    req.branchScope.length &&
    !req.branchScope.includes(Number(destinationBranchId))
  ) {
    throw new HttpError(403, "Destination branch is not in your branch scope");
  }

  const transferReason = normalizeTransferReason(payload?.transfer_reason);
  const transporterName = normalizeText(payload?.transporter_name, 120);
  const billBookNo = normalizeText(payload?.bill_book_no, 120);
  if (!billBookNo) throw new HttpError(400, "Bill Book No is required");
  const remarks = normalizeText(payload?.remarks || payload?.description, 1000);
  const rawLines = toLines(payload);
  if (!rawLines.length) throw new HttpError(400, "Voucher lines are required");
  const resolvedTransferRefNo = await resolveTransferRefNoTx({
    trx,
    transferRefNo,
    fallbackTransferRefNo: transferRefNo,
    userProvided: transferRefNoProvided === true,
    exceptVoucherId: currentVoucherId,
  });

  await ensureInventoryStockInfraTx({
    trx,
    needsRm: stockType === "RM",
    needsSku: stockType === "FG" || stockType === "SFG",
  });

  if (stockType === "RM") {
    const itemIds = [
      ...new Set(
        rawLines.map((line) => toPositiveInt(line?.item_id)).filter(Boolean),
      ),
    ];
    if (!itemIds.length) throw new HttpError(400, "Raw material is required");
    const [itemMap, colorMap, sizeMap, rmRateRows] = await Promise.all([
      fetchRmItemMapTx({ trx, itemIds }),
      fetchColorMapTx({
        trx,
        colorIds: rawLines.map((line) => line?.color_id),
      }),
      fetchSizeMapTx({
        trx,
        sizeIds: rawLines.map((line) => line?.size_id),
      }),
      fetchRmRateRowsByItemTx({ trx, itemIds }),
    ]);
    const rmRatesByItem = new Map();
    // Group RM rates once to keep per-line resolution deterministic and fast.
    (rmRateRows || []).forEach((row) => {
      const itemId = Number(row?.rm_item_id || 0);
      if (!itemId) return;
      if (!rmRatesByItem.has(itemId)) rmRatesByItem.set(itemId, []);
      rmRatesByItem.get(itemId).push(row);
    });
    const missingItem = itemIds.find((id) => !itemMap.has(Number(id)));
    if (missingItem)
      throw new HttpError(400, "Invalid raw material in voucher lines");

    const baseUomIds = [
      ...new Set(
        [...itemMap.values()]
          .map((entry) => toPositiveInt(entry?.base_uom_id))
          .filter(Boolean),
      ),
    ];
    const unitOptionsByBase = await loadUnitOptionsByBaseUomIdTx({
      trx,
      baseUomIds,
    });
    const sourceStock = await loadSourceStockMapsTx({
      trx,
      sourceBranchId: req.branchId,
    });

    const lines = rawLines.map((raw, index) => {
      const lineNo = index + 1;
      const itemId = toPositiveInt(raw?.item_id);
      if (!itemId)
        throw new HttpError(400, `Line ${lineNo}: raw material is required`);
      const item = itemMap.get(Number(itemId));
      const baseUomId = toPositiveInt(item?.base_uom_id);
      const unitOptions = unitOptionsByBase.get(Number(baseUomId || 0)) || [];
      const selectedUomId = toPositiveInt(raw?.uom_id) || baseUomId;
      const selectedUnit = unitOptions.find(
        (entry) => Number(entry.id) === Number(selectedUomId),
      );
      if (!selectedUnit)
        throw new HttpError(400, `Line ${lineNo}: selected unit is invalid`);

      const transferQty = toPositiveNumber(raw?.transfer_qty ?? raw?.qty, 3);
      if (!transferQty)
        throw new HttpError(
          400,
          `Line ${lineNo}: transfer quantity is required`,
        );
      const factorToBase = Number(selectedUnit.factor_to_base || 0);
      if (!(factorToBase > 0))
        throw new HttpError(400, `Line ${lineNo}: unit conversion is invalid`);
      const transferQtyBase = roundQty3(
        Number(transferQty) * Number(factorToBase),
      );

      const colorId = toPositiveInt(raw?.color_id);
      const sizeId = toPositiveInt(raw?.size_id);
      if (colorId && !colorMap.has(Number(colorId))) {
        throw new HttpError(400, `Line ${lineNo}: selected color is invalid`);
      }
      if (sizeId && !sizeMap.has(Number(sizeId))) {
        throw new HttpError(400, `Line ${lineNo}: selected size is invalid`);
      }

      const exactKey = buildStockMapKey({ itemId, colorId, sizeId });
      const fallbackKey = buildStockMapKey({
        itemId,
        colorId: null,
        sizeId: null,
      });
      const stock =
        sourceStock.rmMap[exactKey] || sourceStock.rmMap[fallbackKey];
      const availableQtyBase = Number(stock?.qty || 0);
      const shortageQtyBase = Math.max(
        roundQty3(transferQtyBase - availableQtyBase),
        0,
      );
      const hasNegativeStockRisk = shortageQtyBase > 0.0005;
      const unitCostBase = roundUnitCost6(
        resolveRmPurchaseRate({
          itemRates: rmRatesByItem.get(Number(itemId)) || [],
          colorId,
          sizeId,
        }),
      );
      const unitCost = roundUnitCost6(unitCostBase * Number(factorToBase));
      const amount = roundCost2(Number(transferQty) * Number(unitCost));
      const availableQty =
        factorToBase > 0 ? roundQty3(availableQtyBase / factorToBase) : 0;

      return {
        line_no: lineNo,
        line_kind: "ITEM",
        item_id: Number(itemId),
        sku_id: null,
        uom_id: Number(selectedUnit.id),
        qty: Number(transferQty),
        rate: Number(unitCost),
        amount,
        meta: {
          stock_type: "RM",
          color_id: colorId || null,
          size_id: sizeId || null,
          uom_id: Number(selectedUnit.id),
          uom_code: selectedUnit.code || null,
          uom_name: selectedUnit.name || null,
          uom_factor_to_base: Number(Number(factorToBase).toFixed(6)),
          available_qty: Number(availableQty),
          available_qty_base: Number(availableQtyBase),
          transfer_qty_base: Number(transferQtyBase),
          shortage_qty_base: Number(shortageQtyBase),
          negative_stock_risk: hasNegativeStockRisk,
          unit_cost_base: Number(unitCostBase),
        },
      };
    });

    return {
      voucherDate,
      stockType,
      destinationBranchId,
      transferRefNo: resolvedTransferRefNo,
      transferReason,
      transporterName,
      billBookNo,
      remarks,
      lines,
    };
  }

  const skuIds = [
    ...new Set(
      rawLines.map((line) => toPositiveInt(line?.sku_id)).filter(Boolean),
    ),
  ];
  if (!skuIds.length) throw new HttpError(400, "Item is required");
  const skuMap = await fetchSkuMapTx({
    trx,
    skuIds,
    expectedStockType: stockType,
  });
  const missingSku = skuIds.find((id) => !skuMap.has(Number(id)));
  if (missingSku) throw new HttpError(400, "Invalid item in voucher lines");

  const baseUomIds = [
    ...new Set(
      [...skuMap.values()]
        .map((entry) => toPositiveInt(entry?.base_uom_id))
        .filter(Boolean),
    ),
  ];
  const unitOptionsByBase = await loadUnitOptionsByBaseUomIdTx({
    trx,
    baseUomIds,
  });
  const sourceStock = await loadSourceStockMapsTx({
    trx,
    sourceBranchId: req.branchId,
  });

  const lines = rawLines.map((raw, index) => {
    const lineNo = index + 1;
    const skuId = toPositiveInt(raw?.sku_id);
    if (!skuId) throw new HttpError(400, `Line ${lineNo}: item is required`);
    const sku = skuMap.get(Number(skuId));
    const baseUomId = toPositiveInt(sku?.base_uom_id);
    const unitOptions = unitOptionsByBase.get(Number(baseUomId || 0)) || [];
    const selectedUomId = toPositiveInt(raw?.uom_id) || baseUomId;
    const selectedUnit = unitOptions.find(
      (entry) => Number(entry.id) === Number(selectedUomId),
    );
    if (!selectedUnit)
      throw new HttpError(400, `Line ${lineNo}: selected unit is invalid`);

    const transferQty = toPositiveNumber(raw?.transfer_qty ?? raw?.qty, 3);
    if (!transferQty)
      throw new HttpError(400, `Line ${lineNo}: transfer quantity is required`);
    const factorToBase = Number(selectedUnit.factor_to_base || 0);
    if (!(factorToBase > 0))
      throw new HttpError(400, `Line ${lineNo}: unit conversion is invalid`);

    const qtyPairsRaw = Number(transferQty) * Number(factorToBase);
    const transferQtyPairs = Math.round(Number(qtyPairsRaw || 0));
    if (
      Math.abs(qtyPairsRaw - transferQtyPairs) > 0.0005 ||
      transferQtyPairs <= 0
    ) {
      throw new HttpError(
        400,
        `Line ${lineNo}: quantity must convert to whole pairs`,
      );
    }

    const stockKey = `${stockType}:${Number(skuId)}`;
    const stock = sourceStock.skuMap[stockKey];
    const rowStatus = selectedUnit.is_base ? "LOOSE" : "PACKED";
    const availableQtyPairs =
      stockType === "FG"
        ? Number(
            rowStatus === "LOOSE"
              ? stock?.loose_qty_pairs
              : stock?.packed_qty_pairs,
          )
        : Number(stock?.qty_pairs || 0);
    const shortageQtyPairs = Math.max(
      Number(transferQtyPairs) - Number(availableQtyPairs),
      0,
    );
    const hasNegativeStockRisk = shortageQtyPairs > 0;
    const unitCostBase = roundUnitCost6(
      stockType === "FG" && Number(sku?.sale_rate || 0) > 0
        ? Number(sku.sale_rate)
        : 0,
    );
    const unitCost = roundUnitCost6(unitCostBase * Number(factorToBase));
    const amount = roundCost2(Number(transferQty) * Number(unitCost));
    const availableQty =
      factorToBase > 0 ? roundQty3(availableQtyPairs / factorToBase) : 0;

    return {
      line_no: lineNo,
      line_kind: "SKU",
      item_id: null,
      sku_id: Number(skuId),
      uom_id: Number(selectedUnit.id),
      qty: Number(transferQty),
      rate: Number(unitCost),
      amount,
      meta: {
        stock_type: stockType,
        row_status: rowStatus,
        uom_id: Number(selectedUnit.id),
        uom_code: selectedUnit.code || null,
        uom_name: selectedUnit.name || null,
        uom_factor_to_base: Number(Number(factorToBase).toFixed(6)),
        available_qty: Number(availableQty),
        available_qty_pairs: Number(availableQtyPairs),
        shortage_qty_pairs: Number(shortageQtyPairs),
        negative_stock_risk: hasNegativeStockRisk,
        transfer_qty_pairs: Number(transferQtyPairs),
        unit_cost_base: Number(unitCostBase),
      },
    };
  });

  return {
    voucherDate,
    stockType,
    destinationBranchId,
    transferRefNo: resolvedTransferRefNo,
    transferReason,
    transporterName,
    billBookNo,
    remarks,
    lines,
  };
};

const validateTransferInPayloadTx = async ({
  trx,
  req,
  payload,
  existingVoucherId = null,
}) => {
  const voucherDate = toDateOnly(
    payload?.voucher_date || payload?.received_date_time,
  );
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  const incomingTransferRef = normalizeText(payload?.transfer_ref_no, 120);
  const stnOutVoucherId = toPositiveInt(payload?.stn_out_voucher_id);
  if (!incomingTransferRef && !stnOutVoucherId) {
    throw new HttpError(400, "Transfer reference is required");
  }

  const stnHeader = await fetchTransferOutHeaderTx({
    trx,
    req,
    transferRefNo: incomingTransferRef,
    stnOutVoucherId,
    includeReceivedForVoucherId: existingVoucherId,
  });
  if (!stnHeader) throw new HttpError(400, "Transfer reference is invalid");

  const transferRefNo =
    incomingTransferRef ||
    normalizeText(stnHeader.transfer_ref_no || stnHeader.stn_book_no, 120) ||
    `STN-${Number(stnHeader.stn_voucher_no || 0)}`;

  const stnLines = await loadTransferOutLinesTx({
    trx,
    voucherId: Number(stnHeader.voucher_id),
  });
  if (!stnLines.length) throw new HttpError(400, "Transfer has no lines");

  const stockType = normalizeStockType(
    stnLines.find((line) => normalizeStockType(line.stock_type))?.stock_type,
  );
  if (!stockType) throw new HttpError(400, "Transfer stock type is invalid");

  const stnLineMap = new Map(stnLines.map((line) => [Number(line.id), line]));
  const rawLines = toLines(payload);
  if (!rawLines.length) throw new HttpError(400, "Voucher lines are required");

  const lines = rawLines.map((raw, index) => {
    const lineNo = index + 1;
    const stnLineId = toPositiveInt(
      raw?.stn_line_id || raw?.voucher_line_id || raw?.id,
    );
    if (!stnLineId || !stnLineMap.has(Number(stnLineId))) {
      throw new HttpError(400, `Line ${lineNo}: transfer item is required`);
    }
    const stnLine = stnLineMap.get(Number(stnLineId));
    const factorToBase = Number(stnLine?.uom_factor_to_base || 1);
    if (!(factorToBase > 0))
      throw new HttpError(400, `Line ${lineNo}: unit conversion is invalid`);

    const expectedQty = Number(stnLine?.qty || 0);
    const expectedQtyBase = Number(stnLine?.transfer_qty_base || 0);
    const expectedQtyPairs = Number(stnLine?.transfer_qty_pairs || 0);
    const receivedQty = toNonNegativeNumber(raw?.received_qty, 3);
    const rejectedQty = toNonNegativeNumber(raw?.rejected_qty, 3);
    if (receivedQty === null)
      throw new HttpError(400, `Line ${lineNo}: received quantity is invalid`);
    if (rejectedQty === null)
      throw new HttpError(400, `Line ${lineNo}: rejected quantity is invalid`);

    const processedQty = roundQty3(Number(receivedQty) + Number(rejectedQty));
    if (!(processedQty > 0)) {
      throw new HttpError(400, `Line ${lineNo}: received quantity is required`);
    }
    if (processedQty > expectedQty + 0.0005) {
      throw new HttpError(
        400,
        `Line ${lineNo}: processed quantity exceeds transfer quantity`,
      );
    }
    const varianceQty = roundQty3(Number(expectedQty) - Number(processedQty));
    const varianceReason = normalizeText(raw?.variance_reason, 250);
    if (varianceQty > 0 && !varianceReason) {
      throw new HttpError(400, `Line ${lineNo}: variance reason is required`);
    }

    const unitCostBase = roundUnitCost6(Number(stnLine?.unit_cost_base || 0));
    const unitCost = roundUnitCost6(Number(stnLine?.rate || 0));
    const amount = roundCost2(Number(receivedQty) * Number(unitCost));

    const commonMeta = {
      stock_type: stockType,
      stn_line_id: Number(stnLineId),
      stn_out_voucher_id: Number(stnHeader.voucher_id),
      expected_qty: Number(expectedQty),
      received_qty: Number(receivedQty),
      rejected_qty: Number(rejectedQty),
      variance_qty: Number(varianceQty),
      variance_reason: varianceReason || null,
      uom_id: Number(stnLine?.uom_id || 0) || null,
      uom_code: stnLine?.uom_code || null,
      uom_name: stnLine?.uom_name || null,
      uom_factor_to_base: Number(Number(factorToBase).toFixed(6)),
      unit_cost_base: Number(unitCostBase),
    };

    if (stockType === "RM") {
      const expectedBase = roundQty3(
        expectedQtyBase || Number(expectedQty) * factorToBase,
      );
      const receivedBase = roundQty3(Number(receivedQty) * factorToBase);
      const rejectedBase = roundQty3(Number(rejectedQty) * factorToBase);
      return {
        line_no: lineNo,
        line_kind: "ITEM",
        item_id: Number(stnLine.item_id),
        sku_id: null,
        uom_id: Number(stnLine.uom_id || 0) || null,
        qty: Number(receivedQty),
        rate: Number(unitCost),
        amount,
        meta: {
          ...commonMeta,
          color_id: stnLine.color_id || null,
          size_id: stnLine.size_id || null,
          expected_qty_base: Number(expectedBase),
          received_qty_base: Number(receivedBase),
          rejected_qty_base: Number(rejectedBase),
        },
      };
    }

    const receivedPairsRaw = Number(receivedQty) * factorToBase;
    const receivedPairs = Math.round(receivedPairsRaw);
    if (Math.abs(receivedPairsRaw - receivedPairs) > 0.0005) {
      throw new HttpError(
        400,
        `Line ${lineNo}: received quantity must convert to whole pairs`,
      );
    }
    const rejectedPairsRaw = Number(rejectedQty) * factorToBase;
    const rejectedPairs = Math.round(rejectedPairsRaw);
    if (Math.abs(rejectedPairsRaw - rejectedPairs) > 0.0005) {
      throw new HttpError(
        400,
        `Line ${lineNo}: rejected quantity must convert to whole pairs`,
      );
    }
    const expectedPairs = Number(
      expectedQtyPairs || Math.round(Number(expectedQty) * factorToBase),
    );
    if (receivedPairs + rejectedPairs > expectedPairs) {
      throw new HttpError(
        400,
        `Line ${lineNo}: processed quantity exceeds transfer quantity`,
      );
    }
    return {
      line_no: lineNo,
      line_kind: "SKU",
      item_id: null,
      sku_id: Number(stnLine.sku_id),
      uom_id: Number(stnLine.uom_id || 0) || null,
      qty: Number(receivedQty),
      rate: Number(unitCost),
      amount,
      meta: {
        ...commonMeta,
        row_status: stnLine.row_status || null,
        expected_qty_pairs: Number(expectedPairs),
        received_qty_pairs: Number(receivedPairs),
        rejected_qty_pairs: Number(rejectedPairs),
      },
    };
  });

  return {
    voucherDate,
    transferRefNo,
    billBookNo: normalizeText(stnHeader?.bill_book_no, 120),
    stnOutVoucherId: Number(stnHeader.voucher_id),
    stockType,
    sourceBranchId: Number(stnHeader.source_branch_id),
    destinationBranchId: Number(stnHeader.dest_branch_id),
    receivedByUserId: Number(req.user.id),
    remarks: normalizeText(payload?.remarks || payload?.description, 1000),
    lines,
  };
};

const insertVoucherLinesTx = async ({ trx, voucherId, lines = [] }) => {
  const rows = lines.map((line) => ({
    voucher_header_id: Number(voucherId),
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
  return trx("erp.voucher_line").insert(rows).returning(["id", "line_no"]);
};

const buildTransferRefNo = ({ branchId, voucherNo }) =>
  `TRF-${Number(branchId)}-${Number(voucherNo)}`;

const findTransferRefConflictTx = async ({
  trx,
  transferRefNo,
  exceptVoucherId = null,
}) => {
  const normalizedTransferRefNo = normalizeText(transferRefNo, 120);
  if (!normalizedTransferRefNo) return null;
  if (!(await hasStockTransferOutTransferRefColumnTx(trx))) return null;

  const query = trx("erp.stock_transfer_out_header as sth")
    .select("sth.voucher_id")
    .whereRaw("upper(coalesce(sth.transfer_ref_no, '')) = ?", [
      String(normalizedTransferRefNo).toUpperCase(),
    ]);
  if (toPositiveInt(exceptVoucherId)) {
    query.whereNot("sth.voucher_id", Number(exceptVoucherId));
  }
  return query.first();
};

const resolveTransferRefNoTx = async ({
  trx,
  transferRefNo,
  fallbackTransferRefNo,
  userProvided = false,
  exceptVoucherId = null,
}) => {
  const normalizedProvided = normalizeText(transferRefNo, 120);
  const normalizedFallback = normalizeText(fallbackTransferRefNo, 120);
  const requested = normalizedProvided || normalizedFallback;
  if (!requested) return null;

  const conflict = await findTransferRefConflictTx({
    trx,
    transferRefNo: requested,
    exceptVoucherId,
  });
  if (!conflict) return requested;
  if (userProvided) {
    throw new HttpError(
      400,
      `Transfer reference "${requested}" already exists`,
    );
  }

  const base = requested;
  for (let suffix = 2; suffix <= 500; suffix += 1) {
    const candidate = normalizeText(`${base}-${suffix}`, 120);
    if (!candidate) continue;
    // eslint-disable-next-line no-await-in-loop
    const candidateConflict = await findTransferRefConflictTx({
      trx,
      transferRefNo: candidate,
      exceptVoucherId,
    });
    if (!candidateConflict) return candidate;
  }
  throw new HttpError(400, "Could not generate unique transfer reference");
};

const upsertStockTransferOutHeaderTx = async ({
  trx,
  voucherId,
  destinationBranchId,
  dispatchDate,
  transferRefNo,
  stockType,
  transferReason,
  transporterName,
  billBookNo,
}) => {
  const payload = {
    voucher_id: Number(voucherId),
    dest_branch_id: Number(destinationBranchId),
    dispatch_date: dispatchDate,
    status: "DISPATCHED",
  };
  const mergeColumns = ["dest_branch_id", "dispatch_date"];
  if (await hasStockTransferOutTransferRefColumnTx(trx)) {
    payload.transfer_ref_no = transferRefNo || null;
    mergeColumns.push("transfer_ref_no");
  }
  if (await hasStockTransferOutStockTypeColumnTx(trx)) {
    payload.stock_type = stockType || null;
    mergeColumns.push("stock_type");
  }
  if (await hasStockTransferOutTransferReasonColumnTx(trx)) {
    payload.transfer_reason = transferReason || null;
    mergeColumns.push("transfer_reason");
  }
  if (await hasStockTransferOutTransporterNameColumnTx(trx)) {
    payload.transporter_name = transporterName || null;
    mergeColumns.push("transporter_name");
  }
  if (await hasStockTransferOutBillBookNoColumnTx(trx)) {
    payload.bill_book_no = billBookNo || null;
    mergeColumns.push("bill_book_no");
  }

  try {
    await trx("erp.stock_transfer_out_header")
      .insert(payload)
      .onConflict("voucher_id")
      .merge(mergeColumns);
  } catch (err) {
    if (
      String(err?.code || "") === "23505" &&
      String(err?.constraint || "")
        .toLowerCase()
        .includes("transfer_ref")
    ) {
      throw new HttpError(400, "Transfer reference already exists");
    }
    throw err;
  }
};

const upsertGrnInHeaderTx = async ({
  trx,
  voucherId,
  againstStnOutId,
  receivedDate,
  remarks,
  receivedByUserId,
}) => {
  const payload = {
    voucher_id: Number(voucherId),
    against_stn_out_id: Number(againstStnOutId),
    received_date: receivedDate,
    notes: remarks || null,
  };
  const mergeColumns = ["against_stn_out_id", "received_date", "notes"];
  if (await hasGrnInReceivedByUserIdColumnTx(trx)) {
    payload.received_by_user_id = toPositiveInt(receivedByUserId);
    mergeColumns.push("received_by_user_id");
  }
  if (await hasGrnInReceivedAtColumnTx(trx)) {
    payload.received_at = trx.fn.now();
    mergeColumns.push("received_at");
  }

  await trx("erp.grn_in_header")
    .insert(payload)
    .onConflict("voucher_id")
    .merge(mergeColumns);
};

const syncStockTransferOutVoucherTx = async ({ trx, voucherId }) => {
  const header = await trx("erp.voucher_header")
    .select("id", "voucher_date", "branch_id", "status")
    .where({
      id: voucherId,
      voucher_type_code: STOCK_TRANSFER_VOUCHER_TYPES.out,
    })
    .first();
  if (!header) return;

  await rollbackInventoryStockLedgerByVoucherTx({ trx, voucherId });
  if (String(header.status || "").toUpperCase() !== "APPROVED") return;

  const ext = await trx("erp.stock_transfer_out_header")
    .select("dest_branch_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!ext?.dest_branch_id)
    throw new HttpError(400, "Transfer destination branch is required");

  const lines = await trx("erp.voucher_line")
    .select("id", "line_kind", "item_id", "sku_id", "qty", "rate", "meta")
    .where({ voucher_header_id: voucherId })
    .orderBy("line_no", "asc");
  const needsRm = lines.some(
    (line) => String(line.line_kind || "").toUpperCase() === "ITEM",
  );
  const needsSku = lines.some(
    (line) => String(line.line_kind || "").toUpperCase() === "SKU",
  );
  await ensureInventoryStockInfraTx({ trx, needsRm, needsSku });

  const voucherDate = toDateOnly(header.voucher_date);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const lineKind = String(line.line_kind || "").toUpperCase();
    const factorToBase = Number(meta.uom_factor_to_base || 1);
    const unitCostBase =
      Number(meta.unit_cost_base || 0) > 0
        ? Number(meta.unit_cost_base)
        : roundUnitCost6(
            Number(line.rate || 0) / Math.max(Number(factorToBase || 1), 1),
          );

    if (lineKind === "ITEM") {
      const qtyBase = roundQty3(
        Number(meta.transfer_qty_base || Number(line.qty || 0) * factorToBase),
      );
      await moveRmStockTx({
        trx,
        fromIdentity: buildRmStockIdentity({
          branchId: header.branch_id,
          stockState: "ON_HAND",
          itemId: line.item_id,
          colorId: meta.color_id,
          sizeId: meta.size_id,
        }),
        toIdentity: buildRmStockIdentity({
          branchId: ext.dest_branch_id,
          stockState: "IN_TRANSIT",
          itemId: line.item_id,
          colorId: meta.color_id,
          sizeId: meta.size_id,
        }),
        qty: qtyBase,
        unitCostBase,
        voucherId,
        voucherLineId: line.id,
        voucherDate,
        allowNegativeSource: true,
      });
      continue;
    }

    if (lineKind === "SKU") {
      const qtyPairs = Number(meta.transfer_qty_pairs || 0);
      await moveSkuStockPairsTx({
        trx,
        fromBranchId: header.branch_id,
        fromStockState: "ON_HAND",
        toBranchId: ext.dest_branch_id,
        toStockState: "IN_TRANSIT",
        category: meta.stock_type,
        skuId: line.sku_id,
        qtyPairs,
        unitCostBase,
        rowStatus: meta.row_status,
        voucherId,
        voucherLineId: line.id,
        voucherDate,
        allowNegativeSource: true,
      });
    }
  }
};

const consumeInTransitRemainderTx = async ({
  trx,
  branchId,
  line,
  meta,
  unitCostBase,
  voucherId,
  voucherDate,
}) => {
  if (String(line.line_kind || "").toUpperCase() === "ITEM") {
    const expectedBase = roundQty3(Number(meta.expected_qty_base || 0));
    const receivedBase = roundQty3(Number(meta.received_qty_base || 0));
    const remainderBase = roundQty3(expectedBase - receivedBase);
    if (!(remainderBase > 0)) return;
    const supportsVariants = await hasStockBalanceRmVariantDimensionsTx(trx);
    const identity = buildRmStockIdentity({
      branchId,
      stockState: "IN_TRANSIT",
      itemId: line.item_id,
      colorId: meta.color_id,
      sizeId: meta.size_id,
    });
    const remainderValue = roundCost2(remainderBase * unitCostBase);
    const source = await ensureRmBalanceAvailableTx({
      trx,
      identity,
      qtyRequired: remainderBase,
      valueRequired: remainderValue,
      supportsVariantDimensions: supportsVariants,
    });
    const nextQty = Math.max(
      roundQty3(Number(source?.qty || 0) - remainderBase),
      0,
    );
    const nextValue =
      nextQty > 0
        ? Math.max(roundCost2(Number(source?.value || 0) - remainderValue), 0)
        : 0;
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
      supportsVariantDimensions: supportsVariants,
    });
    await updateQuery;
    await insertRmStockLedgerTx({
      trx,
      branchId,
      stockState: "IN_TRANSIT",
      itemId: line.item_id,
      colorId: meta.color_id,
      sizeId: meta.size_id,
      voucherId,
      voucherLineId: line.id,
      txnDate: voucherDate,
      direction: -1,
      qty: remainderBase,
      unitCost: unitCostBase,
      value: remainderValue,
    });
    return;
  }

  const expectedPairs = Number(meta.expected_qty_pairs || 0);
  const receivedPairs = Number(meta.received_qty_pairs || 0);
  const remainderPairs = Number(expectedPairs) - Number(receivedPairs);
  if (!(remainderPairs > 0)) return;
  const rowStatus = normalizeRowStatus(meta.row_status);
  const usePackedBucket =
    String(meta.stock_type || "")
      .trim()
      .toUpperCase() === "FG"
      ? rowStatus === "PACKED"
      : false;
  await ensureSkuBalanceSeedTx({
    trx,
    branchId,
    stockState: "IN_TRANSIT",
    category: meta.stock_type,
    skuId: line.sku_id,
    isPacked: usePackedBucket,
  });
  const source = await trx("erp.stock_balance_sku")
    .select("qty_pairs", "value")
    .where({
      branch_id: branchId,
      stock_state: "IN_TRANSIT",
      category: String(meta.stock_type || "").toUpperCase(),
      is_packed: usePackedBucket,
      sku_id: Number(line.sku_id),
    })
    .first()
    .forUpdate();
  if (Number(source?.qty_pairs || 0) < remainderPairs) {
    throw new HttpError(400, "Transfer in transit balance is insufficient");
  }
  const remainderValue = roundCost2(
    Number(remainderPairs) * Number(unitCostBase || 0),
  );
  const nextQtyPairs = Number(source?.qty_pairs || 0) - remainderPairs;
  const nextValue =
    nextQtyPairs > 0
      ? Math.max(roundCost2(Number(source?.value || 0) - remainderValue), 0)
      : 0;
  const nextWac = computeNonNegativeWac(nextQtyPairs, nextValue);
  await trx("erp.stock_balance_sku")
    .where({
      branch_id: branchId,
      stock_state: "IN_TRANSIT",
      category: String(meta.stock_type || "").toUpperCase(),
      is_packed: usePackedBucket,
      sku_id: Number(line.sku_id),
    })
    .update({
      qty_pairs: nextQtyPairs,
      value: nextValue,
      wac: nextWac,
      last_txn_at: trx.fn.now(),
    });
  await insertSkuStockLedgerTx({
    trx,
    branchId,
    stockState: "IN_TRANSIT",
    category: meta.stock_type,
    skuId: line.sku_id,
    voucherId,
    voucherLineId: line.id,
    txnDate: voucherDate,
    direction: -1,
    qtyPairs: remainderPairs,
    unitCost: unitCostBase,
    value: remainderValue,
  });
};

const loadTransferInLinesTx = async ({ trx, voucherId }) => {
  const lines = await trx("erp.voucher_line as vl")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as si", "si.id", "v.item_id")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .leftJoin(
      "erp.colors as c",
      "c.id",
      knex.raw("(vl.meta->>'color_id')::bigint"),
    )
    .leftJoin("erp.colors as vc", "vc.id", "v.color_id")
    .leftJoin(
      "erp.sizes as sz",
      "sz.id",
      knex.raw("(vl.meta->>'size_id')::bigint"),
    )
    .leftJoin("erp.sizes as vs", "vs.id", "v.size_id")
    .leftJoin("erp.packing_types as p", "p.id", "v.packing_type_id")
    .leftJoin("erp.grades as g", "g.id", "v.grade_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.line_kind",
      "vl.item_id",
      "vl.sku_id",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
      "i.code as item_code",
      "i.name as item_name",
      "s.sku_code",
      "si.name as sku_item_name",
      "si.item_type as sku_item_type",
      "u.code as uom_code",
      "u.name as uom_name",
      knex.raw("coalesce(c.name, vc.name, '') as color_name"),
      knex.raw("coalesce(sz.name, vs.name, '') as size_name"),
      "p.name as packing_name",
      "g.name as grade_name",
    )
    .where({ "vl.voucher_header_id": voucherId })
    .orderBy("vl.line_no", "asc");

  return (lines || []).map((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const stockType =
      normalizeStockType(meta.stock_type) ||
      (String(line?.line_kind || "").toUpperCase() === "ITEM"
        ? "RM"
        : normalizeStockType(line?.sku_item_type));
    const lineKind = String(line?.line_kind || "").toUpperCase();
    const displayName =
      lineKind === "SKU"
        ? buildSkuDisplayName({
            id: line?.sku_id,
            sku_code: line?.sku_code,
            item_name: line?.sku_item_name || line?.item_name,
            size_name: line?.size_name,
            color_name: line?.color_name,
            packing_name: line?.packing_name,
            grade_name: line?.grade_name,
          })
        : String(line?.item_name || "");
    return {
      id: Number(line.id),
      line_no: Number(line.line_no || 0),
      line_kind: lineKind,
      stock_type: stockType,
      item_id: toPositiveInt(line.item_id),
      item_code: String(line.item_code || ""),
      item_name: String(line.item_name || ""),
      sku_id: toPositiveInt(line.sku_id),
      sku_code: String(line.sku_code || ""),
      sku_item_name: String(line.sku_item_name || ""),
      display_name: String(displayName || ""),
      qty: Number(line.qty || 0),
      rate: Number(line.rate || 0),
      amount: Number(line.amount || 0),
      uom_id: toPositiveInt(meta.uom_id) || toPositiveInt(line.uom_id),
      uom_code: String(meta.uom_code || line.uom_code || ""),
      uom_name: String(meta.uom_name || line.uom_name || ""),
      uom_factor_to_base: Number(meta.uom_factor_to_base || 1),
      color_id: toPositiveInt(meta.color_id),
      color_name: String(line.color_name || ""),
      size_id: toPositiveInt(meta.size_id),
      size_name: String(line.size_name || ""),
      packing_name: String(line.packing_name || ""),
      grade_name: String(line.grade_name || ""),
      expected_qty: Number(meta.expected_qty || 0),
      received_qty: Number(meta.received_qty || line.qty || 0),
      rejected_qty: Number(meta.rejected_qty || 0),
      variance_qty: Number(meta.variance_qty || 0),
      variance_reason: meta.variance_reason || "",
      expected_qty_base: Number(meta.expected_qty_base || 0),
      received_qty_base: Number(meta.received_qty_base || 0),
      rejected_qty_base: Number(meta.rejected_qty_base || 0),
      expected_qty_pairs: Number(meta.expected_qty_pairs || 0),
      received_qty_pairs: Number(meta.received_qty_pairs || 0),
      rejected_qty_pairs: Number(meta.rejected_qty_pairs || 0),
      stn_line_id: toPositiveInt(meta.stn_line_id),
      stn_out_voucher_id: toPositiveInt(meta.stn_out_voucher_id),
      row_status:
        String(meta.row_status || "")
          .trim()
          .toUpperCase() || null,
      unit_cost_base: Number(meta.unit_cost_base || 0),
    };
  });
};

const syncStockTransferInVoucherTx = async ({ trx, voucherId }) => {
  const header = await trx("erp.voucher_header")
    .select("id", "voucher_date", "branch_id", "status")
    .where({
      id: voucherId,
      voucher_type_code: STOCK_TRANSFER_VOUCHER_TYPES.in,
    })
    .first();
  if (!header) return;

  const ext = await trx("erp.grn_in_header")
    .select("against_stn_out_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!ext?.against_stn_out_id) {
    await rollbackInventoryStockLedgerByVoucherTx({ trx, voucherId });
    return;
  }

  await trx("erp.stock_transfer_out_header")
    .where({
      voucher_id: Number(ext.against_stn_out_id),
      received_voucher_id: voucherId,
    })
    .update({
      status: "DISPATCHED",
      received_voucher_id: null,
      received_at: null,
    });

  await rollbackInventoryStockLedgerByVoucherTx({ trx, voucherId });
  if (String(header.status || "").toUpperCase() !== "APPROVED") return;

  const stnHeader = await trx("erp.voucher_header as vh")
    .join("erp.stock_transfer_out_header as sth", "sth.voucher_id", "vh.id")
    .select("vh.id", "vh.branch_id as source_branch_id", "sth.dest_branch_id")
    .where({ "vh.id": Number(ext.against_stn_out_id) })
    .first();
  if (!stnHeader) throw new HttpError(400, "Transfer source is invalid");
  if (Number(stnHeader.dest_branch_id) !== Number(header.branch_id)) {
    throw new HttpError(400, "Transfer destination branch mismatch");
  }

  const lines = await trx("erp.voucher_line")
    .select("id", "line_kind", "item_id", "sku_id", "qty", "rate", "meta")
    .where({ voucher_header_id: voucherId })
    .orderBy("line_no", "asc");
  const needsRm = lines.some(
    (line) => String(line.line_kind || "").toUpperCase() === "ITEM",
  );
  const needsSku = lines.some(
    (line) => String(line.line_kind || "").toUpperCase() === "SKU",
  );
  await ensureInventoryStockInfraTx({ trx, needsRm, needsSku });

  const voucherDate = toDateOnly(header.voucher_date);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const lineKind = String(line.line_kind || "").toUpperCase();
    const factorToBase = Number(meta.uom_factor_to_base || 1);
    const unitCostBase =
      Number(meta.unit_cost_base || 0) > 0
        ? Number(meta.unit_cost_base)
        : roundUnitCost6(
            Number(line.rate || 0) / Math.max(Number(factorToBase || 1), 1),
          );

    if (lineKind === "ITEM") {
      const receivedBase = roundQty3(
        Number(
          meta.received_qty_base ||
            Number(meta.received_qty || line.qty || 0) * factorToBase,
        ),
      );
      if (receivedBase > 0) {
        await moveRmStockTx({
          trx,
          fromIdentity: buildRmStockIdentity({
            branchId: header.branch_id,
            stockState: "IN_TRANSIT",
            itemId: line.item_id,
            colorId: meta.color_id,
            sizeId: meta.size_id,
          }),
          toIdentity: buildRmStockIdentity({
            branchId: header.branch_id,
            stockState: "ON_HAND",
            itemId: line.item_id,
            colorId: meta.color_id,
            sizeId: meta.size_id,
          }),
          qty: receivedBase,
          unitCostBase,
          voucherId,
          voucherLineId: line.id,
          voucherDate,
        });
      }
      await consumeInTransitRemainderTx({
        trx,
        branchId: header.branch_id,
        line,
        meta,
        unitCostBase,
        voucherId,
        voucherDate,
      });
      continue;
    }

    if (lineKind === "SKU") {
      const receivedPairs = Number(meta.received_qty_pairs || 0);
      if (Number.isInteger(receivedPairs) && receivedPairs > 0) {
        await moveSkuStockPairsTx({
          trx,
          fromBranchId: header.branch_id,
          fromStockState: "IN_TRANSIT",
          toBranchId: header.branch_id,
          toStockState: "ON_HAND",
          category: meta.stock_type,
          skuId: line.sku_id,
          qtyPairs: receivedPairs,
          unitCostBase,
          rowStatus: meta.row_status,
          voucherId,
          voucherLineId: line.id,
          voucherDate,
        });
      }
      await consumeInTransitRemainderTx({
        trx,
        branchId: header.branch_id,
        line,
        meta,
        unitCostBase,
        voucherId,
        voucherDate,
      });
    }
  }

  await trx("erp.stock_transfer_out_header")
    .where({ voucher_id: Number(ext.against_stn_out_id) })
    .update({
      status: "RECEIVED",
      received_voucher_id: voucherId,
      received_at: trx.fn.now(),
    });
};

const hasTransferOutNegativeStockRisk = (validated) =>
  (Array.isArray(validated?.lines) ? validated.lines : []).some((line) => {
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    if (meta.negative_stock_risk === true) return true;
    if (Number(meta.shortage_qty_base || 0) > 0.0005) return true;
    if (Number(meta.shortage_qty_pairs || 0) > 0) return true;
    return false;
  });

const toApprovalPayload = ({
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
  stock_type: validated.stockType || null,
  destination_branch_id: validated.destinationBranchId || null,
  transfer_ref_no: validated.transferRefNo || null,
  transfer_reason: validated.transferReason || null,
  transporter_name: validated.transporterName || null,
  bill_book_no: validated.billBookNo || null,
  stn_out_voucher_id: validated.stnOutVoucherId || null,
  source_branch_id: validated.sourceBranchId || null,
  remarks: validated.remarks,
  lines: validated.lines || [],
  permission_reroute: permissionReroute === true,
  negative_stock_approval_reroute: negativeStockApprovalReroute === true,
  approval_reason: approvalReason || null,
});

const syncVoucherDerivedDataTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
}) => {
  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out) {
    await syncStockTransferOutVoucherTx({ trx, voucherId });
    return;
  }
  if (normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.in) {
    await syncStockTransferInVoucherTx({ trx, voucherId });
  }
};

const createStockTransferVoucher = async ({
  req,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.out &&
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.in
  ) {
    throw new HttpError(400, "Invalid voucher type");
  }

  const canCreate = canDo(req, "VOUCHER", scopeKey, "create");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const voucherNo = await getNextVoucherNoTx(
      trx,
      req.branchId,
      normalizedVoucherTypeCode,
    );
    const incomingTransferRefNo = normalizeText(payload?.transfer_ref_no, 120);
    const generatedTransferRefNo = buildTransferRefNo({
      branchId: req.branchId,
      voucherNo,
    });
    const legacyGeneratedTransferRefNo = normalizeText(
      `TRF-${Number(voucherNo)}`,
      120,
    );
    const transferRefNoBase =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? incomingTransferRefNo || generatedTransferRefNo
        : normalizeText(payload?.transfer_ref_no, 120);
    const transferRefNoProvided =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? Boolean(
            incomingTransferRefNo &&
            incomingTransferRefNo !== generatedTransferRefNo &&
            incomingTransferRefNo !== legacyGeneratedTransferRefNo,
          )
        : Boolean(incomingTransferRefNo);

    const validated =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? await validateTransferOutPayloadTx({
            trx,
            req,
            payload,
            transferRefNo: transferRefNoBase,
            transferRefNoProvided,
          })
        : await validateTransferInPayloadTx({
            trx,
            req,
            payload,
          });

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      normalizedVoucherTypeCode,
      "create",
    );
    const negativeStockRouting =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? resolveNegativeStockApprovalRouting({
            hasNegativeStockRisk: hasTransferOutNegativeStockRisk(validated),
            canApproveVoucherAction: canApprove,
            voucherTypeCode: normalizedVoucherTypeCode,
          })
        : resolveNegativeStockApprovalRouting({
            hasNegativeStockRisk: false,
            canApproveVoucherAction: canApprove,
            voucherTypeCode: normalizedVoucherTypeCode,
          });
    const queuedForApproval =
      !canCreate ||
      (policyRequiresApproval && !canApprove) ||
      negativeStockRouting.queueForApproval;

    const [header] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: normalizedVoucherTypeCode,
        voucher_no: voucherNo,
        branch_id: req.branchId,
        voucher_date: validated.voucherDate,
        book_no: validated.transferRefNo || null,
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

    if (normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out) {
      await upsertStockTransferOutHeaderTx({
        trx,
        voucherId: header.id,
        destinationBranchId: validated.destinationBranchId,
        dispatchDate: validated.voucherDate,
        transferRefNo: validated.transferRefNo,
        stockType: validated.stockType,
        transferReason: validated.transferReason,
        transporterName: validated.transporterName,
        billBookNo: validated.billBookNo,
      });
    } else {
      await upsertGrnInHeaderTx({
        trx,
        voucherId: header.id,
        againstStnOutId: validated.stnOutVoucherId,
        receivedDate: validated.voucherDate,
        remarks: validated.remarks,
        receivedByUserId: validated.receivedByUserId,
      });
    }

    if (!queuedForApproval) {
      await syncVoucherGlPostingTx({ trx, voucherId: header.id });
      await syncVoucherDerivedDataTx({
        trx,
        voucherId: header.id,
        voucherTypeCode: normalizedVoucherTypeCode,
      });
    }

    let approvalRequestId = null;
    if (queuedForApproval) {
      approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        voucherId: header.id,
        voucherTypeCode: normalizedVoucherTypeCode,
        summary: `${normalizedVoucherTypeCode} #${header.voucher_no}`,
        newValue: toApprovalPayload({
          action: "create",
          voucherTypeCode: normalizedVoucherTypeCode,
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
    voucherTypeCode: normalizedVoucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
    },
  });

  return result;
};

const updateStockTransferVoucher = async ({
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

  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.out &&
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.in
  ) {
    throw new HttpError(400, "Invalid voucher type");
  }

  const canEdit = canDo(req, "VOUCHER", scopeKey, "edit");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_no", "status", "voucher_date", "remarks")
      .where({
        id: normalizedVoucherId,
        branch_id: req.branchId,
        voucher_type_code: normalizedVoucherTypeCode,
      })
      .first();

    if (!existing) throw new HttpError(404, "Voucher not found");
    if (String(existing.status || "").toUpperCase() === "REJECTED") {
      throw new HttpError(400, "Deleted voucher cannot be edited");
    }

    const incomingTransferRefNo = normalizeText(payload?.transfer_ref_no, 120);
    const generatedTransferRefNo = buildTransferRefNo({
      branchId: req.branchId,
      voucherNo: existing.voucher_no,
    });
    const legacyGeneratedTransferRefNo = normalizeText(
      `TRF-${Number(existing.voucher_no)}`,
      120,
    );
    const transferRefNoBase =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? incomingTransferRefNo || generatedTransferRefNo
        : normalizeText(payload?.transfer_ref_no, 120);
    const transferRefNoProvided =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? Boolean(
            incomingTransferRefNo &&
            incomingTransferRefNo !== generatedTransferRefNo &&
            incomingTransferRefNo !== legacyGeneratedTransferRefNo,
          )
        : Boolean(incomingTransferRefNo);
    const validated =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? await validateTransferOutPayloadTx({
            trx,
            req,
            payload,
            transferRefNo: transferRefNoBase,
            transferRefNoProvided,
            currentVoucherId: existing.id,
          })
        : await validateTransferInPayloadTx({
            trx,
            req,
            payload,
            existingVoucherId: existing.id,
          });

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      normalizedVoucherTypeCode,
      "edit",
    );
    const negativeStockRouting =
      normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
        ? resolveNegativeStockApprovalRouting({
            hasNegativeStockRisk: hasTransferOutNegativeStockRisk(validated),
            canApproveVoucherAction: canApprove,
            voucherTypeCode: normalizedVoucherTypeCode,
          })
        : resolveNegativeStockApprovalRouting({
            hasNegativeStockRisk: false,
            canApproveVoucherAction: canApprove,
            voucherTypeCode: normalizedVoucherTypeCode,
          });
    const queuedForApproval =
      !canEdit ||
      (policyRequiresApproval && !canApprove) ||
      negativeStockRouting.queueForApproval;

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        voucherId: existing.id,
        voucherTypeCode: normalizedVoucherTypeCode,
        summary: `UPDATE ${normalizedVoucherTypeCode} #${existing.voucher_no}`,
        oldValue: {
          voucher_date: existing.voucher_date,
          remarks: existing.remarks,
          status: existing.status,
        },
        newValue: toApprovalPayload({
          action: "update",
          voucherTypeCode: normalizedVoucherTypeCode,
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

    await trx("erp.voucher_header")
      .where({ id: existing.id })
      .update({
        voucher_date: validated.voucherDate,
        book_no: validated.transferRefNo || null,
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

    if (normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out) {
      await upsertStockTransferOutHeaderTx({
        trx,
        voucherId: existing.id,
        destinationBranchId: validated.destinationBranchId,
        dispatchDate: validated.voucherDate,
        transferRefNo: validated.transferRefNo,
        stockType: validated.stockType,
        transferReason: validated.transferReason,
        transporterName: validated.transporterName,
        billBookNo: validated.billBookNo,
      });
    } else {
      await upsertGrnInHeaderTx({
        trx,
        voucherId: existing.id,
        againstStnOutId: validated.stnOutVoucherId,
        receivedDate: validated.voucherDate,
        remarks: validated.remarks,
        receivedByUserId: validated.receivedByUserId,
      });
    }

    await syncVoucherGlPostingTx({ trx, voucherId: existing.id });
    await syncVoucherDerivedDataTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode: normalizedVoucherTypeCode,
    });

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
    voucherTypeCode: normalizedVoucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      updated: result.updated === true,
    },
  });

  return result;
};

const applyStockTransferVoucherDeletePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  approverId,
}) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.out &&
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.in
  ) {
    return;
  }

  const existing = await trx("erp.voucher_header")
    .select("id", "status")
    .where({
      id: normalizedVoucherId,
      voucher_type_code: normalizedVoucherTypeCode,
    })
    .first();
  if (!existing) throw new HttpError(404, "Voucher not found");
  if (String(existing.status || "").toUpperCase() === "REJECTED") return;

  await trx("erp.voucher_header").where({ id: normalizedVoucherId }).update({
    status: "REJECTED",
    approved_by: approverId,
    approved_at: trx.fn.now(),
  });

  await syncVoucherGlPostingTx({ trx, voucherId: normalizedVoucherId });
  await syncVoucherDerivedDataTx({
    trx,
    voucherId: normalizedVoucherId,
    voucherTypeCode: normalizedVoucherTypeCode,
  });
};

const deleteStockTransferVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.out &&
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.in
  ) {
    throw new HttpError(400, "Invalid voucher type");
  }

  const canDelete = canDo(req, "VOUCHER", scopeKey, "hard_delete");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_no", "status")
      .where({
        id: normalizedVoucherId,
        branch_id: req.branchId,
        voucher_type_code: normalizedVoucherTypeCode,
      })
      .first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (String(existing.status || "").toUpperCase() === "REJECTED") {
      throw new HttpError(400, "Voucher already deleted");
    }

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      normalizedVoucherTypeCode,
      "delete",
    );
    const queuedForApproval =
      !canDelete || (policyRequiresApproval && !canApprove);

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        voucherId: existing.id,
        voucherTypeCode: normalizedVoucherTypeCode,
        summary: `DELETE ${normalizedVoucherTypeCode} #${existing.voucher_no}`,
        oldValue: { status: existing.status },
        newValue: {
          action: "delete",
          voucher_id: existing.id,
          voucher_no: existing.voucher_no,
          voucher_type_code: normalizedVoucherTypeCode,
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

    await applyStockTransferVoucherDeletePayloadTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode: normalizedVoucherTypeCode,
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
    voucherTypeCode: normalizedVoucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      deleted: result.deleted === true,
    },
  });

  return result;
};

const buildSkuDisplayName = (row) => {
  const parts = [
    String(row?.item_name || "").trim(),
    String(row?.size_name || "").trim(),
    String(row?.color_name || "").trim(),
    String(row?.packing_name || "").trim(),
    String(row?.grade_name || "").trim(),
  ].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return String(row?.sku_code || `SKU ${row?.id || ""}`).trim();
};

const loadPendingTransferInReferencesTx = async ({
  trx,
  req,
  includeReceivedForVoucherId = null,
}) => {
  const hasTransferRef = await hasStockTransferOutTransferRefColumnTx(trx);
  const hasStockType = await hasStockTransferOutStockTypeColumnTx(trx);
  const hasBillBookNo = await hasStockTransferOutBillBookNoColumnTx(trx);

  const rows = await trx("erp.stock_transfer_out_header as sth")
    .join("erp.voucher_header as vh", "vh.id", "sth.voucher_id")
    .leftJoin("erp.branches as sb", "sb.id", "vh.branch_id")
    .leftJoin("erp.branches as db", "db.id", "sth.dest_branch_id")
    .select(
      "sth.voucher_id",
      "sth.dest_branch_id",
      "sth.dispatch_date",
      "sth.status",
      "sth.received_voucher_id",
      "vh.branch_id as source_branch_id",
      "vh.voucher_no as stn_voucher_no",
      "vh.voucher_date as stn_voucher_date",
      "vh.book_no as stn_book_no",
      "sb.name as source_branch_name",
      "db.name as destination_branch_name",
      hasTransferRef
        ? knex.raw(
            "coalesce(sth.transfer_ref_no, vh.book_no) as transfer_ref_no",
          )
        : knex.raw("vh.book_no as transfer_ref_no"),
      hasStockType
        ? knex.raw("upper(coalesce(sth.stock_type::text, '')) as stock_type")
        : knex.raw("'' as stock_type"),
      hasBillBookNo
        ? knex.raw("sth.bill_book_no as bill_book_no")
        : knex.raw("vh.book_no as bill_book_no"),
    )
    .where({
      "vh.voucher_type_code": STOCK_TRANSFER_VOUCHER_TYPES.out,
      "sth.dest_branch_id": req.branchId,
    })
    .whereNot("vh.status", "REJECTED")
    .where((builder) => {
      builder.where("sth.status", "DISPATCHED");
      if (includeReceivedForVoucherId) {
        builder.orWhere(
          "sth.received_voucher_id",
          Number(includeReceivedForVoucherId),
        );
      }
    })
    .orderBy("vh.voucher_no", "desc")
    .limit(60);

  const transfers = await Promise.all(
    (rows || []).map(async (row) => {
      const lines = await loadTransferOutLinesTx({
        trx,
        voucherId: Number(row.voucher_id),
      });
      const totals = (lines || []).reduce(
        (acc, line) => {
          const factorToBase =
            Number(line?.uom_factor_to_base || 1) > 0
              ? Number(line.uom_factor_to_base || 1)
              : 1;
          const qty = Number(line?.qty || 0);
          const explicitBaseQty = Number(line?.transfer_qty_base || 0);
          const baseQty =
            Number.isFinite(explicitBaseQty) && explicitBaseQty !== 0
              ? explicitBaseQty
              : qty * factorToBase;

          let pairQty = Number(line?.transfer_qty_pairs || 0);
          if (
            !(pairQty > 0) &&
            String(line?.line_kind || "").toUpperCase() === "SKU"
          ) {
            pairQty = qty * factorToBase;
          }

          acc.baseQty += Number(baseQty || 0);
          acc.pairQty += Number(pairQty || 0);
          return acc;
        },
        { baseQty: 0, pairQty: 0 },
      );
      const stockType =
        normalizeStockType(row.stock_type) ||
        normalizeStockType(lines.find((line) => line.stock_type)?.stock_type) ||
        "FG";
      const transferRefNo =
        normalizeText(row.transfer_ref_no, 120) ||
        `STN-${Number(row.stn_voucher_no || 0)}`;
      return {
        stn_out_voucher_id: Number(row.voucher_id),
        transfer_ref_no: transferRefNo,
        stock_type: stockType,
        source_branch_id: Number(row.source_branch_id),
        source_branch_name: row.source_branch_name || "",
        destination_branch_id: Number(row.dest_branch_id),
        destination_branch_name: row.destination_branch_name || "",
        bill_book_no: normalizeText(row.bill_book_no, 120) || null,
        dispatch_date: toDateOnly(row.dispatch_date || row.stn_voucher_date),
        stn_voucher_no: Number(row.stn_voucher_no || 0),
        status: String(row.status || "").toUpperCase(),
        total_base_qty: roundQty3(totals.baseQty),
        total_dozen_qty: roundQty3(totals.pairQty / 12),
        lines,
      };
    }),
  );

  return transfers;
};

const loadStockTransferVoucherOptions = async ({
  req,
  voucherTypeCode,
  includeReceivedForVoucherId = null,
}) => {
  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (!req?.branchId) throw new HttpError(400, "Branch context is required");

  const [
    skus,
    rmItems,
    colors,
    sizes,
    branchRows,
    sourceStock,
    pendingTransfers,
  ] = await Promise.all([
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
    knex("erp.branches")
      .select("id", "name")
      .where({ is_active: true })
      .orderBy("name", "asc"),
    loadSourceStockMapsTx({ trx: knex, sourceBranchId: req.branchId }),
    normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.in
      ? loadPendingTransferInReferencesTx({
          trx: knex,
          req,
          includeReceivedForVoucherId,
        })
      : Promise.resolve([]),
  ]);

  const rmRateRows = await fetchRmRateRowsByItemTx({
    trx: knex,
    itemIds: (rmItems || []).map((row) => row?.id),
  });
  const rmRateRowsByItem = new Map();
  (rmRateRows || []).forEach((row) => {
    const itemId = Number(row?.rm_item_id || 0);
    if (!itemId) return;
    if (!rmRateRowsByItem.has(itemId)) rmRateRowsByItem.set(itemId, []);
    rmRateRowsByItem.get(itemId).push({
      color_id: toPositiveInt(row?.color_id),
      size_id: toPositiveInt(row?.size_id),
      purchase_rate: Number(row?.avg_purchase_rate ?? row?.purchase_rate ?? 0),
    });
  });

  const rawMaterialColorPolicyByItem = {};
  const rawMaterialSizePolicyByItem = {};
  (rmRateRows || []).forEach((row) => {
    const itemId = Number(row?.rm_item_id || 0);
    if (!itemId) return;
    const key = String(itemId);
    if (!rawMaterialColorPolicyByItem[key]) {
      rawMaterialColorPolicyByItem[key] = {
        item_id: itemId,
        hasColorless: false,
        colors: [],
      };
    }
    if (!rawMaterialSizePolicyByItem[key]) {
      rawMaterialSizePolicyByItem[key] = {
        item_id: itemId,
        hasSizeless: false,
        sizes: [],
      };
    }

    const colorId = toPositiveInt(row?.color_id);
    const colorName = String(row?.color_name || row?.color || "").trim();
    if (!colorId) {
      rawMaterialColorPolicyByItem[key].hasColorless = true;
    } else if (
      !rawMaterialColorPolicyByItem[key].colors.some(
        (entry) => Number(entry.id) === Number(colorId),
      )
    ) {
      rawMaterialColorPolicyByItem[key].colors.push({
        id: Number(colorId),
        name: colorName || String(colorId),
      });
    }

    const sizeId = toPositiveInt(row?.size_id);
    const sizeName = String(row?.size_name || row?.size || "").trim();
    if (!sizeId) {
      rawMaterialSizePolicyByItem[key].hasSizeless = true;
    } else if (
      !rawMaterialSizePolicyByItem[key].sizes.some(
        (entry) => Number(entry.id) === Number(sizeId),
      )
    ) {
      rawMaterialSizePolicyByItem[key].sizes.push({
        id: Number(sizeId),
        name: sizeName || String(sizeId),
      });
    }
  });

  const allowedBranchSet = new Set(
    Array.isArray(req.branchScope) && req.branchScope.length
      ? req.branchScope.map((id) => Number(id))
      : (branchRows || []).map((row) => Number(row.id)),
  );

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

  const destinationBranches = (branchRows || [])
    .filter(
      (row) =>
        Number(row.id) !== Number(req.branchId) &&
        (allowedBranchSet.size === 0 || allowedBranchSet.has(Number(row.id))),
    )
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name || ""),
    }));
  const sourceBranches = (branchRows || [])
    .filter((row) => Number(row.id) !== Number(req.branchId))
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name || ""),
    }));

  const currentBranch =
    (branchRows || []).find((row) => Number(row.id) === Number(req.branchId)) ||
    null;

  return {
    voucherTypes: [
      { value: STOCK_TRANSFER_VOUCHER_TYPES.out, mode: "out" },
      { value: STOCK_TRANSFER_VOUCHER_TYPES.in, mode: "in" },
    ],
    stockTypes: [
      { value: "FG", labelKey: "finished" },
      { value: "SFG", labelKey: "semi_finished" },
      { value: "RM", labelKey: "raw_material" },
    ],
    transferReasons: TRANSFER_REASON_VALUES.map((value) => ({
      value,
      labelKey: `transfer_reason_${String(value || "").toLowerCase()}`,
    })),
    branches: (branchRows || []).map((row) => ({
      id: Number(row.id),
      name: String(row.name || ""),
    })),
    destinationBranches,
    sourceBranches,
    sourceBranch: currentBranch
      ? { id: Number(currentBranch.id), name: String(currentBranch.name || "") }
      : { id: Number(req.branchId), name: String(req.branchId) },
    skus: (skus || []).map((row) => ({
      id: Number(row.id),
      sku_code: String(row.sku_code || ""),
      stock_type: String(row.item_type || "")
        .trim()
        .toUpperCase(),
      item_name: String(row.item_name || ""),
      sku_name: buildSkuDisplayName(row),
      sale_rate: Number(row.sale_rate || 0),
      base_uom_id: toPositiveInt(row.base_uom_id),
      unit_options: unitOptionsByBase.get(Number(row.base_uom_id || 0)) || [],
    })),
    rmItems: (rmItems || []).map((row) => ({
      id: Number(row.id),
      code: String(row.code || ""),
      name: String(row.name || ""),
      rate_rows: rmRateRowsByItem.get(Number(row.id)) || [],
      base_uom_id: toPositiveInt(row.base_uom_id),
      unit_options: unitOptionsByBase.get(Number(row.base_uom_id || 0)) || [],
    })),
    colors: (colors || []).map((row) => ({
      id: Number(row.id),
      name: String(row.name || ""),
    })),
    sizes: (sizes || []).map((row) => ({
      id: Number(row.id),
      name: String(row.name || ""),
    })),
    rawMaterialColorPolicyByItem,
    rawMaterialSizePolicyByItem,
    sourceStock: sourceStock || { skuMap: {}, rmMap: {} },
    pendingTransfers: pendingTransfers || [],
  };
};

const loadRecentStockTransferVouchers = async ({ req, voucherTypeCode }) => {
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

const getStockTransferVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
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

const getStockTransferVoucherNeighbours = async ({
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

const loadStockTransferVoucherDetails = async ({
  req,
  voucherTypeCode,
  voucherNo,
}) => {
  const targetNo = parseVoucherNo(voucherNo);
  if (!targetNo) return null;

  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.out &&
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.in
  ) {
    return null;
  }

  const header = await knex("erp.voucher_header")
    .select("id", "voucher_no", "voucher_date", "status", "remarks", "book_no")
    .where({
      branch_id: req.branchId,
      voucher_type_code: normalizedVoucherTypeCode,
      voucher_no: targetNo,
    })
    .first();
  if (!header) return null;

  if (normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out) {
    const hasTransferRef = await hasStockTransferOutTransferRefColumnTx(knex);
    const hasStockType = await hasStockTransferOutStockTypeColumnTx(knex);
    const hasReason = await hasStockTransferOutTransferReasonColumnTx(knex);
    const hasTransporter =
      await hasStockTransferOutTransporterNameColumnTx(knex);
    const hasBillBookNo = await hasStockTransferOutBillBookNoColumnTx(knex);
    const ext = await knex("erp.stock_transfer_out_header as sth")
      .leftJoin("erp.branches as db", "db.id", "sth.dest_branch_id")
      .select(
        "sth.dest_branch_id",
        "sth.dispatch_date",
        "sth.status as transfer_status",
        "db.name as destination_branch_name",
        hasTransferRef
          ? "sth.transfer_ref_no"
          : knex.raw("NULL::text as transfer_ref_no"),
        hasStockType ? "sth.stock_type" : knex.raw("NULL::text as stock_type"),
        hasReason
          ? "sth.transfer_reason"
          : knex.raw("NULL::text as transfer_reason"),
        hasTransporter
          ? "sth.transporter_name"
          : knex.raw("NULL::text as transporter_name"),
        hasBillBookNo
          ? "sth.bill_book_no"
          : knex.raw("NULL::text as bill_book_no"),
      )
      .where({ "sth.voucher_id": header.id })
      .first();

    const lines = await loadTransferOutLinesTx({
      trx: knex,
      voucherId: Number(header.id),
    });
    return {
      id: Number(header.id),
      voucher_no: Number(header.voucher_no),
      voucher_date: toDateOnly(header.voucher_date),
      status: String(header.status || "").toUpperCase(),
      voucher_type_code: normalizedVoucherTypeCode,
      stock_type:
        normalizeStockType(ext?.stock_type) ||
        normalizeStockType(lines.find((line) => line.stock_type)?.stock_type) ||
        "FG",
      transfer_ref_no:
        normalizeText(ext?.transfer_ref_no, 120) ||
        normalizeText(header.book_no, 120) ||
        buildTransferRefNo({
          branchId: req.branchId,
          voucherNo: header.voucher_no,
        }),
      source_branch_id: Number(req.branchId),
      destination_branch_id: toPositiveInt(ext?.dest_branch_id),
      destination_branch_name: String(ext?.destination_branch_name || ""),
      transfer_reason: normalizeTransferReason(ext?.transfer_reason),
      transporter_name: ext?.transporter_name || "",
      bill_book_no: normalizeText(ext?.bill_book_no, 120) || null,
      remarks: header.remarks || "",
      lines,
    };
  }

  const hasReceivedBy = await hasGrnInReceivedByUserIdColumnTx(knex);
  const hasReceivedAt = await hasGrnInReceivedAtColumnTx(knex);
  const hasTransferRef = await hasStockTransferOutTransferRefColumnTx(knex);
  const hasStockType = await hasStockTransferOutStockTypeColumnTx(knex);
  const hasBillBookNo = await hasStockTransferOutBillBookNoColumnTx(knex);
  const ext = await knex("erp.grn_in_header as gih")
    .join(
      "erp.stock_transfer_out_header as sth",
      "sth.voucher_id",
      "gih.against_stn_out_id",
    )
    .join("erp.voucher_header as stn", "stn.id", "sth.voucher_id")
    .leftJoin("erp.branches as sb", "sb.id", "stn.branch_id")
    .leftJoin("erp.branches as db", "db.id", "sth.dest_branch_id")
    .modify((query) => {
      if (hasReceivedBy) {
        query.leftJoin("erp.users as ru", "ru.id", "gih.received_by_user_id");
      }
    })
    .select(
      "gih.against_stn_out_id",
      "gih.received_date",
      "gih.notes",
      "sth.dest_branch_id",
      "stn.branch_id as source_branch_id",
      "sb.name as source_branch_name",
      "db.name as destination_branch_name",
      "stn.voucher_no as stn_voucher_no",
      "stn.book_no as stn_book_no",
      hasTransferRef
        ? knex.raw(
            "coalesce(sth.transfer_ref_no, stn.book_no) as transfer_ref_no",
          )
        : knex.raw("stn.book_no as transfer_ref_no"),
      hasStockType
        ? knex.raw("upper(coalesce(sth.stock_type::text, '')) as stock_type")
        : knex.raw("'' as stock_type"),
      hasBillBookNo
        ? knex.raw("sth.bill_book_no as bill_book_no")
        : knex.raw("stn.book_no as bill_book_no"),
      hasReceivedBy
        ? "gih.received_by_user_id"
        : knex.raw("NULL::bigint as received_by_user_id"),
      hasReceivedBy
        ? knex.raw(
            "coalesce(nullif(ru.name, ''), ru.username, '') as received_by_user_name",
          )
        : knex.raw("''::text as received_by_user_name"),
      hasReceivedAt
        ? "gih.received_at"
        : knex.raw("NULL::timestamptz as received_at"),
    )
    .where({ "gih.voucher_id": header.id })
    .first();

  const lines = await loadTransferInLinesTx({
    trx: knex,
    voucherId: Number(header.id),
  });
  return {
    id: Number(header.id),
    voucher_no: Number(header.voucher_no),
    voucher_date: toDateOnly(header.voucher_date),
    status: String(header.status || "").toUpperCase(),
    voucher_type_code: normalizedVoucherTypeCode,
    stock_type:
      normalizeStockType(ext?.stock_type) ||
      normalizeStockType(lines.find((line) => line.stock_type)?.stock_type) ||
      "FG",
    transfer_ref_no:
      normalizeText(ext?.transfer_ref_no, 120) ||
      normalizeText(header.book_no, 120) ||
      `STN-${Number(ext?.stn_voucher_no || 0)}`,
    source_branch_id: toPositiveInt(ext?.source_branch_id),
    source_branch_name: String(ext?.source_branch_name || ""),
    destination_branch_id:
      toPositiveInt(ext?.dest_branch_id) || Number(req.branchId),
    destination_branch_name: String(ext?.destination_branch_name || ""),
    stn_out_voucher_id: toPositiveInt(ext?.against_stn_out_id),
    bill_book_no: normalizeText(ext?.bill_book_no, 120) || null,
    received_by_user_id: toPositiveInt(ext?.received_by_user_id),
    received_by_user_name: String(ext?.received_by_user_name || ""),
    received_date_time: toDateOnly(ext?.received_at || header.voucher_date),
    remarks: header.remarks || ext?.notes || "",
    lines,
  };
};

const ensureStockTransferVoucherDerivedDataTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
}) => {
  await syncVoucherDerivedDataTx({
    trx,
    voucherId,
    voucherTypeCode,
  });
};

const applyStockTransferVoucherUpdatePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  payload,
  req,
  approverId,
}) => {
  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.out &&
    normalizedVoucherTypeCode !== STOCK_TRANSFER_VOUCHER_TYPES.in
  ) {
    return;
  }

  const existing = await trx("erp.voucher_header")
    .select("id", "voucher_no", "branch_id")
    .where({
      id: Number(voucherId),
      voucher_type_code: normalizedVoucherTypeCode,
    })
    .first();
  if (!existing) throw new HttpError(404, "Voucher not found");

  const approvalReq = {
    ...req,
    branchId: Number(existing.branch_id),
    user: { ...(req?.user || {}), id: approverId || req?.user?.id },
  };
  const incomingTransferRefNo = normalizeText(payload?.transfer_ref_no, 120);
  const generatedTransferRefNo = buildTransferRefNo({
    branchId: Number(existing.branch_id),
    voucherNo: existing.voucher_no,
  });
  const legacyGeneratedTransferRefNo = normalizeText(
    `TRF-${Number(existing.voucher_no)}`,
    120,
  );
  const transferRefNoForValidation =
    incomingTransferRefNo || generatedTransferRefNo;
  const transferRefNoProvided = Boolean(
    incomingTransferRefNo &&
    incomingTransferRefNo !== generatedTransferRefNo &&
    incomingTransferRefNo !== legacyGeneratedTransferRefNo,
  );

  const validated =
    normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out
      ? await validateTransferOutPayloadTx({
          trx,
          req: approvalReq,
          payload,
          transferRefNo: transferRefNoForValidation,
          transferRefNoProvided,
          currentVoucherId: existing.id,
        })
      : await validateTransferInPayloadTx({
          trx,
          req: approvalReq,
          payload,
          existingVoucherId: existing.id,
        });

  await trx("erp.voucher_header")
    .where({ id: existing.id })
    .update({
      voucher_date: validated.voucherDate,
      book_no: validated.transferRefNo || null,
      remarks: validated.remarks,
      status: "APPROVED",
      approved_by: approverId || approvalReq.user.id,
      approved_at: trx.fn.now(),
    });

  if (normalizedVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out) {
    await upsertStockTransferOutHeaderTx({
      trx,
      voucherId: existing.id,
      destinationBranchId: validated.destinationBranchId,
      dispatchDate: validated.voucherDate,
      transferRefNo: validated.transferRefNo,
      stockType: validated.stockType,
      transferReason: validated.transferReason,
      transporterName: validated.transporterName,
      billBookNo: validated.billBookNo,
    });
  } else {
    await upsertGrnInHeaderTx({
      trx,
      voucherId: existing.id,
      againstStnOutId: validated.stnOutVoucherId,
      receivedDate: validated.voucherDate,
      remarks: validated.remarks,
      receivedByUserId: validated.receivedByUserId,
    });
  }

  await ensureStockTransferVoucherDerivedDataTx({
    trx,
    voucherId: existing.id,
    voucherTypeCode: normalizedVoucherTypeCode,
  });
};

module.exports = {
  STOCK_TRANSFER_VOUCHER_TYPES,
  STOCK_TYPE_VALUES,
  TRANSFER_REASON_VALUES,
  parseVoucherNo,
  createStockTransferVoucher,
  updateStockTransferVoucher,
  deleteStockTransferVoucher,
  loadStockTransferVoucherOptions,
  loadRecentStockTransferVouchers,
  getStockTransferVoucherSeriesStats,
  getStockTransferVoucherNeighbours,
  loadStockTransferVoucherDetails,
  ensureStockTransferVoucherDerivedDataTx,
  applyStockTransferVoucherUpdatePayloadTx,
  applyStockTransferVoucherDeletePayloadTx,
};
