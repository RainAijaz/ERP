const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog, queueAuditLog } = require("../../utils/audit-log");
const { toLocalDateOnly } = require("../../utils/date-only");
const { syncVoucherGlPostingTx } = require("../financial/gl-posting-service");

const PURCHASE_VOUCHER_TYPES = {
  goodsReceiptNote: "GRN",
  generalPurchase: "PI",
  purchaseReturn: "PR",
};

const PURCHASE_RETURN_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "QUALITY_ISSUE",
  "EXCESS_QTY",
  "RATE_DISPUTE",
  "LATE_DELIVERY",
  "OTHER",
];
const PURCHASE_PAYMENT_TYPES = ["CASH", "CREDIT"];
let approvalRequestHasVoucherTypeCodeColumn;
let stockBalanceRmTableSupport;
let stockLedgerTableSupport;
let stockBalanceRmColorColumnSupport;
let stockBalanceRmSizeColumnSupport;
let stockLedgerColorColumnSupport;
let stockLedgerSizeColumnSupport;

// RM stock identity in this project is branch + state + item + (color,size when schema supports it).
const RM_BALANCE_CONFLICT_TARGET_SQL =
  "(branch_id, stock_state, item_id, COALESCE(color_id, 0), COALESCE(size_id, 0))";

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

const toPositiveNumber = (value, decimals = 4) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(decimals));
};

const parseVoucherNo = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const normalizePaymentType = (value) => {
  const text = String(value || "CREDIT")
    .trim()
    .toUpperCase();
  return PURCHASE_PAYMENT_TYPES.includes(text) ? text : "CREDIT";
};

const normalizeReturnReason = (value) => {
  const text = String(value || "")
    .trim()
    .toUpperCase();
  return PURCHASE_RETURN_REASONS.includes(text) ? text : null;
};

const normalizeColorId = (value) => {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const normalizeSizeId = (value) => {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const toDateOnly = toLocalDateOnly;

const isPgUndefinedRelationError = (err, tableName = "") => {
  if (!err) return false;
  const code = String(err.code || "").trim();
  const message = String(err.message || "");
  if (code !== "42P01") return false;
  if (!tableName) return true;
  return message.toLowerCase().includes(String(tableName).toLowerCase());
};

const safeFirstMissingRelation = async (queryPromise, tableName) => {
  try {
    return await queryPromise;
  } catch (err) {
    if (isPgUndefinedRelationError(err, tableName)) {
      console.error("Error in PurchaseVoucherService:", err);
      return null;
    }
    throw err;
  }
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
    console.error("Error in PurchaseVoucherSaveService:", err);
    approvalRequestHasVoucherTypeCodeColumn = false;
    return false;
  }
};

// Stock tables/columns can differ across deployed DB versions, so detect features at runtime.
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

// Purchase stock posting is allowed only when both ledger + RM balance infrastructure exist.
const ensurePurchaseStockInfraTx = async (trx) => {
  const [hasLedger, hasRmBalance] = await Promise.all([
    hasStockLedgerTableTx(trx),
    hasStockBalanceRmTableTx(trx),
  ]);
  if (!hasLedger) {
    throw new HttpError(
      400,
      "Stock ledger infrastructure is unavailable for purchase stock posting",
    );
  }
  if (!hasRmBalance) {
    throw new HttpError(
      400,
      "RM stock balance infrastructure is unavailable for purchase stock posting",
    );
  }
};

const normalizeRmDimensionId = (value) => toPositiveInt(value);
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

// Normalize stock row identity so PI/PR always hit a single deterministic RM balance bucket.
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

// Reusable WHERE builder keeps every stock read/write scoped to the same identity rules.
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

// Upsert seed row prevents missing-balance races before we update qty/value.
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

// Every stock movement is journaled in stock_ledger; color/size is included only when supported.
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

const loadPurchaseVoucherStockLinesTx = async ({ trx, voucherId }) =>
  trx("erp.voucher_line as vl")
    .select("vl.id", "vl.item_id", "vl.qty", "vl.rate", "vl.amount", "vl.meta")
    .where({ "vl.voucher_header_id": voucherId, "vl.line_kind": "ITEM" })
    .orderBy("vl.line_no", "asc");

// Rollback helper for prior OUT rows: add qty/value back to balance.
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

// Rollback helper for prior IN rows: remove qty/value from balance.
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

// Idempotency strategy: before reposting a voucher, reverse all its previous RM ledger impact.
const rollbackPurchaseStockLedgerByVoucherTx = async ({ trx, voucherId }) => {
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
    "direction",
    "qty",
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
    const category = String(row?.category || "")
      .trim()
      .toUpperCase();
    const direction = Number(row?.direction || 0);
    if (category !== "RM") continue;
    if (direction === -1) {
      await addBackRmStockFromLedgerTx({ trx, row });
      continue;
    }
    if (direction === 1) {
      await removeRmStockFromLedgerTx({ trx, row });
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

// PI posts RM IN by item+color+size and updates WAC balance.
const applyPurchaseVoucherStockInTx = async ({
  trx,
  voucherId,
  branchId,
  voucherDate,
}) => {
  const rows = await loadPurchaseVoucherStockLinesTx({ trx, voucherId });
  if (!rows.length) return;
  const supportsVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);
  const supportsLedgerVariantDimensions =
    await hasStockLedgerVariantDimensionsTx(trx);

  for (const row of rows) {
    const voucherLineId = toPositiveInt(row?.id);
    const itemId = toPositiveInt(row?.item_id);
    const qtyIn = roundQty3(Number(row?.qty || 0));
    if (!itemId || qtyIn <= 0) continue;

    const colorId =
      normalizeRmDimensionId(row?.meta?.color_id) ||
      normalizeRmDimensionId(row?.meta?.rm_color_id);
    const sizeId =
      normalizeRmDimensionId(row?.meta?.size_id) ||
      normalizeRmDimensionId(row?.meta?.rm_size_id);
    if (
      (colorId || sizeId) &&
      (!supportsVariantDimensions || !supportsLedgerVariantDimensions)
    ) {
      throw new HttpError(
        400,
        "RM color/size stock tracking is unavailable. Run latest stock variant migration.",
      );
    }

    const identity = buildRmStockIdentity({
      branchId,
      stockState: "ON_HAND",
      itemId,
      colorId,
      sizeId,
    });
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

    const unitRate =
      Number(row?.rate || 0) > 0
        ? Number(row?.rate || 0)
        : qtyIn > 0 && Number(row?.amount || 0) > 0
          ? Number(row?.amount || 0) / qtyIn
          : 0;
    const valueIn = roundCost2(qtyIn * Number(unitRate || 0));

    const nextQty = roundQty3(Number(existing?.qty || 0) + qtyIn);
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
      supportsVariantDimensions,
    });
    await updateQuery;

    await insertRmStockLedgerTx({
      trx,
      branchId,
      itemId,
      colorId,
      sizeId,
      voucherId,
      voucherLineId,
      txnDate: voucherDate,
      direction: 1,
      qty: qtyIn,
      unitCost: unitRate,
      value: valueIn,
    });
  }
};

// PR posts RM OUT by item+color+size using current WAC and strict negative-stock protection.
const applyPurchaseVoucherStockOutTx = async ({
  trx,
  voucherId,
  branchId,
  voucherDate,
}) => {
  const rows = await loadPurchaseVoucherStockLinesTx({ trx, voucherId });
  if (!rows.length) return;
  const supportsVariantDimensions =
    await hasStockBalanceRmVariantDimensionsTx(trx);
  const supportsLedgerVariantDimensions =
    await hasStockLedgerVariantDimensionsTx(trx);

  for (const row of rows) {
    const voucherLineId = toPositiveInt(row?.id);
    const itemId = toPositiveInt(row?.item_id);
    const qtyOut = roundQty3(Number(row?.qty || 0));
    if (!itemId || qtyOut <= 0) continue;

    const colorId =
      normalizeRmDimensionId(row?.meta?.color_id) ||
      normalizeRmDimensionId(row?.meta?.rm_color_id);
    const sizeId =
      normalizeRmDimensionId(row?.meta?.size_id) ||
      normalizeRmDimensionId(row?.meta?.rm_size_id);
    if (
      (colorId || sizeId) &&
      (!supportsVariantDimensions || !supportsLedgerVariantDimensions)
    ) {
      throw new HttpError(
        400,
        "RM color/size stock tracking is unavailable. Run latest stock variant migration.",
      );
    }

    const identity = buildRmStockIdentity({
      branchId,
      stockState: "ON_HAND",
      itemId,
      colorId,
      sizeId,
    });
    const balanceQuery = trx("erp.stock_balance_rm")
      .select("qty", "value", "wac")
      .forUpdate();
    applyRmStockIdentityWhere({
      query: balanceQuery,
      identity,
      supportsVariantDimensions,
    });
    const balanceRow = await balanceQuery.first();

    const availableQty = Number(balanceRow?.qty || 0);
    const availableValue = Number(balanceRow?.value || 0);
    if (availableQty < qtyOut) {
      throw new HttpError(
        400,
        `Purchase return quantity exceeds available stock for item ${itemId}`,
      );
    }
    const unitCost = resolveUnitCost({
      qty: availableQty,
      value: availableValue,
      wac: balanceRow?.wac,
    });
    const consumedValue = roundCost2(qtyOut * unitCost);
    const nextQtyRaw = availableQty - qtyOut;
    const nextValueRaw = availableValue - consumedValue;
    if (nextQtyRaw < -0.0005 || nextValueRaw < -0.05) {
      throw new HttpError(
        400,
        `Purchase return posting would make stock negative for item ${itemId}`,
      );
    }
    const nextQty = Math.max(roundQty3(nextQtyRaw), 0);
    const nextValue = nextQty > 0 ? Math.max(roundCost2(nextValueRaw), 0) : 0;
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

    await insertRmStockLedgerTx({
      trx,
      branchId,
      itemId,
      colorId,
      sizeId,
      voucherId,
      voucherLineId,
      txnDate: voucherDate,
      direction: -1,
      qty: qtyOut,
      unitCost,
      value: -consumedValue,
    });
  }
};

// Single entrypoint for purchase stock sync:
// 1) rollback old ledger impact
// 2) if approved, re-apply PI(IN) or PR(OUT)
const syncPurchaseVoucherStockTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
}) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;
  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== PURCHASE_VOUCHER_TYPES.generalPurchase &&
    normalizedVoucherTypeCode !== PURCHASE_VOUCHER_TYPES.purchaseReturn
  ) {
    return;
  }

  const header = await trx("erp.voucher_header")
    .select("id", "branch_id", "voucher_date", "status")
    .where({ id: normalizedVoucherId })
    .first();
  if (!header) return;

  await ensurePurchaseStockInfraTx(trx);
  await rollbackPurchaseStockLedgerByVoucherTx({
    trx,
    voucherId: normalizedVoucherId,
  });
  if (String(header.status || "").toUpperCase() !== "APPROVED") return;

  if (normalizedVoucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
    await applyPurchaseVoucherStockInTx({
      trx,
      voucherId: normalizedVoucherId,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
    });
    return;
  }

  await applyPurchaseVoucherStockOutTx({
    trx,
    voucherId: normalizedVoucherId,
    branchId: Number(header.branch_id),
    voucherDate: toDateOnly(header.voucher_date),
  });
};

const validateSupplierTx = async ({ trx, req, supplierPartyId }) => {
  const normalizedSupplierId = toPositiveInt(supplierPartyId);
  if (!normalizedSupplierId) throw new HttpError(400, "Supplier is required");

  let supplierQuery = trx("erp.parties as p")
    .select("p.id", "p.name", "p.party_type")
    .where({ "p.id": normalizedSupplierId, "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','BOTH')");

  supplierQuery = supplierQuery.where(function wherePartyScope() {
    this.where("p.branch_id", req.branchId).orWhereExists(
      function wherePartyBranchMap() {
        this.select(1)
          .from("erp.party_branch as pb")
          .whereRaw("pb.party_id = p.id")
          .andWhere("pb.branch_id", req.branchId);
      },
    );
  });

  const supplier = await supplierQuery.first();
  if (!supplier)
    throw new HttpError(400, "Supplier is invalid for current branch");

  return {
    id: Number(supplier.id),
    name: supplier.name,
  };
};

const validateCashAccountTx = async ({ trx, req, cashPaidAccountId }) => {
  const normalizedAccountId = toPositiveInt(cashPaidAccountId);
  if (!normalizedAccountId)
    throw new HttpError(400, "Cash paid account is required for cash purchase");

  const account = await trx("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .select("a.id", "apc.code as posting_class_code")
    .where({ "a.id": normalizedAccountId, "a.is_active": true })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .andWhere("ab.branch_id", req.branchId);
    })
    .first();

  if (!account)
    throw new HttpError(400, "Cash paid account is invalid for current branch");

  const postingClassCode = String(account.posting_class_code || "")
    .trim()
    .toLowerCase();
  if (postingClassCode !== "cash" && postingClassCode !== "bank") {
    throw new HttpError(400, "Cash paid account must be a cash/bank account");
  }

  return Number(account.id);
};

const validateColorIdsTx = async ({ trx, colorIds = [] }) => {
  const normalized = [
    ...new Set((colorIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Set();

  const rows = await trx("erp.colors")
    .select("id")
    .whereIn("id", normalized)
    .where({ is_active: true });
  const found = new Set(rows.map((row) => Number(row.id)));
  if (found.size !== normalized.length)
    throw new HttpError(400, "One or more selected colors are invalid");

  return found;
};

const validateSizeIdsTx = async ({ trx, sizeIds = [] }) => {
  const normalized = [
    ...new Set((sizeIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Set();

  const rows = await trx("erp.sizes")
    .select("id")
    .whereIn("id", normalized)
    .where({ is_active: true });
  const found = new Set(rows.map((row) => Number(row.id)));
  if (found.size !== normalized.length)
    throw new HttpError(400, "One or more selected sizes are invalid");

  return found;
};

const fetchRmColorPolicyByItemTx = async ({ trx, itemIds = [] }) => {
  const normalizedItemIds = [
    ...new Set((itemIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalizedItemIds.length) return new Map();

  const rows = await trx("erp.rm_purchase_rates as r")
    .select("r.rm_item_id", "r.color_id")
    .whereIn("r.rm_item_id", normalizedItemIds)
    .where({ "r.is_active": true });

  const policyByItemId = new Map();
  rows.forEach((row) => {
    const itemId = Number(row.rm_item_id);
    if (!policyByItemId.has(itemId)) {
      policyByItemId.set(itemId, {
        hasAnyRate: true,
        hasColorless: false,
        colorIds: new Set(),
      });
    }
    const policy = policyByItemId.get(itemId);
    const colorId = toPositiveInt(row.color_id);
    if (colorId) {
      policy.colorIds.add(colorId);
    } else {
      policy.hasColorless = true;
    }
  });

  return policyByItemId;
};

const fetchRmSizePolicyByItemTx = async ({ trx, itemIds = [] }) => {
  const normalizedItemIds = [
    ...new Set((itemIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalizedItemIds.length) return new Map();

  const rows = await trx("erp.rm_purchase_rates as r")
    .select("r.rm_item_id", "r.size_id")
    .whereIn("r.rm_item_id", normalizedItemIds)
    .where({ "r.is_active": true });

  const policyByItemId = new Map();
  rows.forEach((row) => {
    const itemId = Number(row.rm_item_id);
    if (!policyByItemId.has(itemId)) {
      policyByItemId.set(itemId, {
        hasAnyRate: true,
        hasSizeless: false,
        sizeIds: new Set(),
      });
    }
    const policy = policyByItemId.get(itemId);
    const sizeId = toPositiveInt(row.size_id);
    if (sizeId) {
      policy.sizeIds.add(sizeId);
    } else {
      policy.hasSizeless = true;
    }
  });

  return policyByItemId;
};

const fetchRawMaterialMapTx = async ({ trx, itemIds = [] }) => {
  const normalized = [
    ...new Set((itemIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Map();

  const rows = await trx("erp.items as i")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .select(
      "i.id",
      "i.name",
      "i.item_type",
      "i.base_uom_id",
      "u.name as base_uom_name",
    )
    .whereIn("i.id", normalized)
    .where({ "i.is_active": true })
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'");

  return new Map(rows.map((row) => [Number(row.id), row]));
};

const normalizeAndValidateLinesTx = async ({
  trx,
  voucherTypeCode,
  rawLines = [],
}) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const itemIds = lines
    .map((line) => toPositiveInt(line?.item_id || line?.itemId))
    .filter(Boolean);
  const itemMap = await fetchRawMaterialMapTx({ trx, itemIds });
  if (itemMap.size !== itemIds.length)
    throw new HttpError(400, "One or more raw materials are invalid");

  const colorIds = lines
    .map((line) => normalizeColorId(line?.color_id || line?.colorId))
    .filter(Boolean);
  await validateColorIdsTx({ trx, colorIds });
  const sizeIds = lines
    .map((line) => normalizeSizeId(line?.size_id || line?.sizeId))
    .filter(Boolean);
  await validateSizeIdsTx({ trx, sizeIds });
  const rmColorPolicyByItem = await fetchRmColorPolicyByItemTx({
    trx,
    itemIds,
  });
  const rmSizePolicyByItem = await fetchRmSizePolicyByItemTx({ trx, itemIds });

  return lines.map((line, index) => {
    const lineNo = index + 1;
    const itemId = toPositiveInt(line?.item_id || line?.itemId);
    const item = itemMap.get(Number(itemId));
    if (!item)
      throw new HttpError(400, `Line ${lineNo}: raw material is invalid`);

    const qty = toPositiveNumber(line?.qty, 3);
    if (!qty)
      throw new HttpError(
        400,
        `Line ${lineNo}: quantity must be greater than zero`,
      );

    const colorId = normalizeColorId(line?.color_id || line?.colorId);
    const colorPolicy = rmColorPolicyByItem.get(Number(itemId));
    if (colorPolicy?.hasAnyRate) {
      const hasAllowedColors = colorPolicy.colorIds.size > 0;
      if (colorId) {
        if (!colorPolicy.colorIds.has(Number(colorId))) {
          throw new HttpError(
            400,
            `Line ${lineNo}: selected color is invalid for selected raw material`,
          );
        }
      } else if (hasAllowedColors && !colorPolicy.hasColorless) {
        throw new HttpError(
          400,
          `Line ${lineNo}: color is required for selected raw material`,
        );
      }
    }

    const sizeId = normalizeSizeId(line?.size_id || line?.sizeId);
    const sizePolicy = rmSizePolicyByItem.get(Number(itemId));
    if (sizePolicy?.hasAnyRate) {
      const hasAllowedSizes = sizePolicy.sizeIds.size > 0;
      if (sizeId) {
        if (!sizePolicy.sizeIds.has(Number(sizeId))) {
          throw new HttpError(
            400,
            `Line ${lineNo}: selected size is invalid for selected raw material`,
          );
        }
      } else if (hasAllowedSizes && !sizePolicy.hasSizeless) {
        throw new HttpError(
          400,
          `Line ${lineNo}: size is required for selected raw material`,
        );
      }
    }

    let rate = 0;
    if (voucherTypeCode !== PURCHASE_VOUCHER_TYPES.goodsReceiptNote) {
      rate = toPositiveNumber(line?.rate, 4);
      if (!rate)
        throw new HttpError(
          400,
          `Line ${lineNo}: rate must be greater than zero`,
        );
    }

    const baseUomId = toPositiveInt(item.base_uom_id);
    const inputUomId = toPositiveInt(line?.uom_id || line?.uomId);
    if (!baseUomId)
      throw new HttpError(400, `Line ${lineNo}: raw material has no base unit`);
    if (inputUomId && inputUomId !== baseUomId)
      throw new HttpError(
        400,
        `Line ${lineNo}: unit must match raw material base unit`,
      );

    return {
      line_no: lineNo,
      line_kind: "ITEM",
      item_id: Number(itemId),
      uom_id: baseUomId,
      qty: Number(qty.toFixed(3)),
      rate: Number(rate.toFixed(4)),
      amount: Number((qty * rate).toFixed(2)),
      meta: {
        color_id: colorId || undefined,
        size_id: sizeId || undefined,
      },
      item_name: item.name,
      color_id: colorId || null,
      size_id: sizeId || null,
    };
  });
};

const getNextVoucherNoTx = async (trx, branchId, voucherTypeCode) => {
  const latest = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .max({ value: "voucher_no" })
    .first();
  return Number(latest?.value || 0) + 1;
};
const loadOpenGrnPoolsTx = async ({
  trx,
  branchId,
  supplierPartyId = null,
  preferredGrnVoucherNo = null,
  excludePurchaseVoucherId = null,
}) => {
  try {
    let grnLinesQuery = trx("erp.voucher_header as vh")
      .join("erp.purchase_grn_header_ext as ghe", "ghe.voucher_id", "vh.id")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .select(
        "vh.id as grn_voucher_id",
        "vh.voucher_no as grn_voucher_no",
        "vh.voucher_date",
        "ghe.supplier_party_id",
        knex.raw(
          "COALESCE(NULLIF(ghe.supplier_reference_no, ''), NULLIF(vh.book_no, ''), NULL) as grn_reference_no",
        ),
        "vl.id as grn_line_id",
        "vl.line_no as grn_line_no",
        "vl.item_id",
        "vl.qty",
        knex.raw(
          "CASE WHEN coalesce(vl.meta->>'color_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'color_id')::int ELSE NULL END as color_id",
        ),
        knex.raw(
          "CASE WHEN coalesce(vl.meta->>'size_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'size_id')::int ELSE NULL END as size_id",
        ),
      )
      .where({
        "vh.branch_id": branchId,
        "vh.voucher_type_code": PURCHASE_VOUCHER_TYPES.goodsReceiptNote,
        "vh.status": "APPROVED",
        "vl.line_kind": "ITEM",
      });

    if (supplierPartyId) {
      grnLinesQuery = grnLinesQuery.andWhere(
        "ghe.supplier_party_id",
        supplierPartyId,
      );
    }

    const grnLines = await grnLinesQuery
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
    if (!grnLines.length) return [];

    const grnLineIds = grnLines.map((line) => Number(line.grn_line_id));

    let allocationQuery = trx("erp.purchase_grn_invoice_alloc as a")
      .join("erp.voucher_line as pl", "pl.id", "a.purchase_voucher_line_id")
      .join("erp.voucher_header as pvh", "pvh.id", "pl.voucher_header_id")
      .select("a.grn_voucher_line_id")
      .sum({ qty_allocated: "a.qty_allocated" })
      .whereIn("a.grn_voucher_line_id", grnLineIds)
      .where("pvh.voucher_type_code", PURCHASE_VOUCHER_TYPES.generalPurchase)
      .whereNot("pvh.status", "REJECTED")
      .groupBy("a.grn_voucher_line_id");

    const excludedVoucherId = toPositiveInt(excludePurchaseVoucherId);
    if (excludedVoucherId) {
      allocationQuery = allocationQuery.whereNot("pvh.id", excludedVoucherId);
    }

    const allocationRows = await allocationQuery;
    const allocatedByLineId = new Map(
      allocationRows.map((row) => [
        Number(row.grn_voucher_line_id),
        Number(row.qty_allocated || 0),
      ]),
    );

    const preferredVoucherNo = parseVoucherNo(preferredGrnVoucherNo);
    const pools = grnLines
      .map((line) => {
        const qty = Number(line.qty || 0);
        const allocated = Number(
          allocatedByLineId.get(Number(line.grn_line_id)) || 0,
        );
        const openQty = Number((qty - allocated).toFixed(3));
        return {
          grn_voucher_id: Number(line.grn_voucher_id),
          grn_voucher_no: Number(line.grn_voucher_no),
          grn_voucher_date: toDateOnly(line.voucher_date),
          supplier_party_id: Number(line.supplier_party_id),
          grn_reference_no: normalizeText(line.grn_reference_no, 120),
          grn_line_id: Number(line.grn_line_id),
          grn_line_no: Number(line.grn_line_no),
          item_id: Number(line.item_id),
          color_id: toPositiveInt(line.color_id),
          size_id: toPositiveInt(line.size_id),
          open_qty: openQty,
        };
      })
      .filter((line) => line.open_qty > 0);

    pools.sort((a, b) => {
      if (preferredVoucherNo) {
        const ap = a.grn_voucher_no === preferredVoucherNo ? 0 : 1;
        const bp = b.grn_voucher_no === preferredVoucherNo ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      if (a.grn_voucher_date !== b.grn_voucher_date)
        return a.grn_voucher_date.localeCompare(b.grn_voucher_date);
      if (a.grn_voucher_no !== b.grn_voucher_no)
        return a.grn_voucher_no - b.grn_voucher_no;
      return a.grn_line_no - b.grn_line_no;
    });

    return pools;
  } catch (err) {
    if (
      isPgUndefinedRelationError(err, "erp.purchase_grn_header_ext") ||
      isPgUndefinedRelationError(err, "erp.purchase_grn_invoice_alloc")
    ) {
      console.error("Error in PurchaseVoucherService:", err);
      return [];
    }
    throw err;
  }
};

const getReferencedGrnMetaTx = async ({ trx, branchId, grnVoucherNo }) => {
  const normalizedGrnVoucherNo = parseVoucherNo(grnVoucherNo);
  if (!normalizedGrnVoucherNo) return { exists: false, referenceNo: null };

  try {
    const row = await trx("erp.voucher_header as vh")
      .leftJoin("erp.purchase_grn_header_ext as ghe", "ghe.voucher_id", "vh.id")
      .select("vh.id", "vh.book_no", "ghe.supplier_reference_no")
      .where({
        "vh.branch_id": branchId,
        "vh.voucher_type_code": PURCHASE_VOUCHER_TYPES.goodsReceiptNote,
        "vh.voucher_no": normalizedGrnVoucherNo,
        "vh.status": "APPROVED",
      })
      .first();

    if (!row) return { exists: false, referenceNo: null };
    return {
      exists: true,
      referenceNo: normalizeText(row.supplier_reference_no || row.book_no, 120),
    };
  } catch (err) {
    if (!isPgUndefinedRelationError(err, "erp.purchase_grn_header_ext"))
      throw err;

    const fallback = await trx("erp.voucher_header as vh")
      .select("vh.id", "vh.book_no")
      .where({
        "vh.branch_id": branchId,
        "vh.voucher_type_code": PURCHASE_VOUCHER_TYPES.goodsReceiptNote,
        "vh.voucher_no": normalizedGrnVoucherNo,
        "vh.status": "APPROVED",
      })
      .first();

    if (!fallback) return { exists: false, referenceNo: null };
    return {
      exists: true,
      referenceNo: normalizeText(fallback.book_no, 120),
    };
  }
};

const buildGrnAllocationPlanTx = async ({
  trx,
  branchId,
  supplierPartyId,
  lines,
  preferredGrnVoucherNo = null,
  excludePurchaseVoucherId = null,
  restrictToPreferredVoucher = false,
}) => {
  const pools = await loadOpenGrnPoolsTx({
    trx,
    branchId,
    supplierPartyId,
    preferredGrnVoucherNo,
    excludePurchaseVoucherId,
  });
  const preferredVoucherNo = parseVoucherNo(preferredGrnVoucherNo);
  const scopedPools =
    preferredVoucherNo && restrictToPreferredVoucher
      ? pools.filter(
          (pool) => Number(pool.grn_voucher_no) === Number(preferredVoucherNo),
        )
      : pools;

  const mutablePools = scopedPools.map((pool) => ({ ...pool }));
  const allocationByLineNo = new Map();

  for (const line of lines) {
    let remainingQty = Number(line.qty || 0);
    const lineAllocations = [];

    for (const pool of mutablePools) {
      if (remainingQty <= 0) break;
      if (pool.item_id !== Number(line.item_id)) continue;
      if (
        line.color_id &&
        pool.color_id &&
        Number(pool.color_id) !== Number(line.color_id)
      )
        continue;
      if (line.color_id && !pool.color_id) continue;
      if (
        line.size_id &&
        pool.size_id &&
        Number(pool.size_id) !== Number(line.size_id)
      )
        continue;
      if (line.size_id && !pool.size_id) continue;
      if (pool.open_qty <= 0) continue;

      const qtyAllocated = Number(
        Math.min(remainingQty, pool.open_qty).toFixed(3),
      );
      if (qtyAllocated <= 0) continue;

      pool.open_qty = Number((pool.open_qty - qtyAllocated).toFixed(3));
      remainingQty = Number((remainingQty - qtyAllocated).toFixed(3));

      lineAllocations.push({
        grn_voucher_line_id: pool.grn_line_id,
        qty_allocated: qtyAllocated,
        unit_rate: Number(line.rate || 0),
        amount: Number((qtyAllocated * Number(line.rate || 0)).toFixed(2)),
      });
    }

    if (remainingQty > 0) {
      throw new HttpError(
        400,
        `Line ${line.line_no}: insufficient unreferenced GRN quantity for ${line.item_name || "raw material"}`,
      );
    }

    allocationByLineNo.set(Number(line.line_no), lineAllocations);
  }

  return allocationByLineNo;
};

const normalizeGrnAllocationsPayload = (raw = null) => {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw.allocations) ? raw.allocations : [];
  return {
    grn_reference_voucher_no: parseVoucherNo(raw.grn_reference_voucher_no),
    allocations: list
      .map((entry) => ({
        line_no: Number(entry?.line_no || 0),
        grn_voucher_line_id: Number(entry?.grn_voucher_line_id || 0),
        qty_allocated: Number(entry?.qty_allocated || 0),
      }))
      .filter(
        (entry) =>
          Number.isInteger(entry.line_no) &&
          entry.line_no > 0 &&
          Number.isInteger(entry.grn_voucher_line_id) &&
          entry.grn_voucher_line_id > 0 &&
          Number.isFinite(entry.qty_allocated) &&
          entry.qty_allocated > 0,
      ),
  };
};

const buildGrnAllocationPlanFromPayloadTx = async ({
  trx,
  branchId,
  supplierPartyId,
  lines,
  grnReferenceVoucherNo,
  rawGrnAllocations,
  excludePurchaseVoucherId = null,
}) => {
  const normalizedPayload = normalizeGrnAllocationsPayload(rawGrnAllocations);
  if (!normalizedPayload?.allocations?.length) return null;
  const payloadReference = parseVoucherNo(
    normalizedPayload.grn_reference_voucher_no,
  );
  if (
    payloadReference &&
    Number(payloadReference) !== Number(grnReferenceVoucherNo)
  ) {
    throw new HttpError(
      400,
      "GRN allocation payload does not match selected GRN reference",
    );
  }

  const pools = await loadOpenGrnPoolsTx({
    trx,
    branchId,
    supplierPartyId,
    preferredGrnVoucherNo: grnReferenceVoucherNo,
    excludePurchaseVoucherId,
  });

  const scopedPools = pools.filter(
    (pool) => Number(pool.grn_voucher_no) === Number(grnReferenceVoucherNo),
  );
  if (!scopedPools.length) {
    throw new HttpError(400, "Selected GRN has no open quantity");
  }

  const lineByNo = new Map(lines.map((line) => [Number(line.line_no), line]));
  const availableByGrnLineId = new Map(
    scopedPools.map((pool) => [
      Number(pool.grn_line_id),
      Number(pool.open_qty || 0),
    ]),
  );
  const allocByGrnLineId = new Map();
  const allocByPurchaseLineNo = new Map();

  normalizedPayload.allocations.forEach((entry) => {
    const purchaseLine = lineByNo.get(Number(entry.line_no));
    if (!purchaseLine) {
      throw new HttpError(
        400,
        `GRN allocation has invalid voucher line no ${entry.line_no}`,
      );
    }

    const pool = scopedPools.find(
      (row) => Number(row.grn_line_id) === Number(entry.grn_voucher_line_id),
    );
    if (!pool) {
      throw new HttpError(
        400,
        `GRN allocation references unavailable GRN line ${entry.grn_voucher_line_id}`,
      );
    }
    if (Number(pool.item_id) !== Number(purchaseLine.item_id)) {
      throw new HttpError(
        400,
        `Line ${purchaseLine.line_no}: GRN line item does not match voucher line item`,
      );
    }
    if (toPositiveInt(pool.color_id) !== toPositiveInt(purchaseLine.color_id)) {
      throw new HttpError(
        400,
        `Line ${purchaseLine.line_no}: GRN line color does not match voucher line`,
      );
    }
    if (toPositiveInt(pool.size_id) !== toPositiveInt(purchaseLine.size_id)) {
      throw new HttpError(
        400,
        `Line ${purchaseLine.line_no}: GRN line size does not match voucher line`,
      );
    }

    const qtyAllocated = Number(Number(entry.qty_allocated || 0).toFixed(3));
    const usedForGrnLine = Number(
      allocByGrnLineId.get(Number(entry.grn_voucher_line_id)) || 0,
    );
    const nextForGrnLine = Number((usedForGrnLine + qtyAllocated).toFixed(3));
    const available = Number(
      availableByGrnLineId.get(Number(entry.grn_voucher_line_id)) || 0,
    );
    if (nextForGrnLine - available > 0.0005) {
      throw new HttpError(
        400,
        `GRN line ${pool.grn_line_no}: allocated quantity exceeds open quantity`,
      );
    }
    allocByGrnLineId.set(Number(entry.grn_voucher_line_id), nextForGrnLine);

    const list = allocByPurchaseLineNo.get(Number(entry.line_no)) || [];
    list.push({
      grn_voucher_line_id: Number(entry.grn_voucher_line_id),
      qty_allocated: qtyAllocated,
      unit_rate: Number(purchaseLine.rate || 0),
      amount: Number(
        (qtyAllocated * Number(purchaseLine.rate || 0)).toFixed(2),
      ),
    });
    allocByPurchaseLineNo.set(Number(entry.line_no), list);
  });

  for (const line of lines) {
    const list = allocByPurchaseLineNo.get(Number(line.line_no)) || [];
    const allocatedQty = Number(
      list
        .reduce((sum, row) => sum + Number(row.qty_allocated || 0), 0)
        .toFixed(3),
    );
    if (Math.abs(allocatedQty - Number(line.qty || 0)) > 0.0005) {
      throw new HttpError(
        400,
        `Line ${line.line_no}: allocated GRN quantity must match line quantity`,
      );
    }
  }

  return allocByPurchaseLineNo;
};

const deletePurchaseAllocationsByVoucherTx = async ({ trx, voucherId }) => {
  const lineIds = await trx("erp.voucher_line")
    .pluck("id")
    .where({ voucher_header_id: voucherId });

  if (!lineIds.length) return;
  await trx("erp.purchase_grn_invoice_alloc")
    .whereIn("purchase_voucher_line_id", lineIds)
    .del();
};

const insertVoucherLinesTx = async ({ trx, voucherId, lines }) => {
  const lineRows = lines.map((line) => ({
    voucher_header_id: voucherId,
    line_no: line.line_no,
    line_kind: "ITEM",
    item_id: line.item_id,
    sku_id: null,
    account_id: null,
    party_id: null,
    labour_id: null,
    employee_id: null,
    uom_id: line.uom_id,
    qty: line.qty,
    rate: line.rate,
    amount: line.amount,
    meta: line.meta || {},
  }));

  return trx("erp.voucher_line").insert(lineRows).returning(["id", "line_no"]);
};

const insertPurchaseAllocationsTx = async ({
  trx,
  insertedLines,
  allocationByLineNo,
}) => {
  if (!insertedLines?.length || !allocationByLineNo?.size) return;

  const lineIdByNo = new Map(
    insertedLines.map((line) => [Number(line.line_no), Number(line.id)]),
  );
  const rows = [];

  for (const [lineNo, allocations] of allocationByLineNo.entries()) {
    const purchaseVoucherLineId = lineIdByNo.get(Number(lineNo));
    if (!purchaseVoucherLineId) continue;

    (allocations || []).forEach((allocation) => {
      rows.push({
        purchase_voucher_line_id: purchaseVoucherLineId,
        grn_voucher_line_id: Number(allocation.grn_voucher_line_id),
        qty_allocated: Number(allocation.qty_allocated),
        unit_rate: Number(allocation.unit_rate || 0),
        amount: Number(allocation.amount || 0),
      });
    });
  }

  if (!rows.length) return;
  await trx("erp.purchase_grn_invoice_alloc").insert(rows);
};

const upsertHeaderExtensionTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  supplierPartyId,
  referenceNo,
  description,
  paymentType = "CREDIT",
  cashPaidAccountId = null,
  returnReason = null,
  grnReferenceVoucherNo = null,
}) => {
  if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.goodsReceiptNote) {
    await trx("erp.purchase_grn_header_ext")
      .insert({
        voucher_id: voucherId,
        supplier_party_id: supplierPartyId,
        supplier_reference_no: referenceNo,
        description,
      })
      .onConflict("voucher_id")
      .merge({
        supplier_party_id: supplierPartyId,
        supplier_reference_no: referenceNo,
        description,
      });
    return;
  }

  if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
    await trx("erp.purchase_invoice_header_ext")
      .insert({
        voucher_id: voucherId,
        supplier_party_id: supplierPartyId,
        payment_type: paymentType,
        cash_paid_account_id: cashPaidAccountId,
        po_voucher_id: null,
        notes: null,
        grn_reference_voucher_no: grnReferenceVoucherNo,
      })
      .onConflict("voucher_id")
      .merge({
        supplier_party_id: supplierPartyId,
        payment_type: paymentType,
        cash_paid_account_id: cashPaidAccountId,
        po_voucher_id: null,
        notes: null,
        grn_reference_voucher_no: grnReferenceVoucherNo,
      });
    return;
  }

  if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.purchaseReturn) {
    await trx("erp.purchase_return_header_ext")
      .insert({
        voucher_id: voucherId,
        supplier_party_id: supplierPartyId,
        reason: returnReason,
      })
      .onConflict("voucher_id")
      .merge({
        supplier_party_id: supplierPartyId,
        reason: returnReason,
      });
  }
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

    // Schema can be older on some environments; retry without optional column.
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
      source: "purchase-voucher-service",
      new_value: newValue,
    },
  });

  return row?.id || null;
};

const validatePurchaseVoucherPayloadTx = async ({
  trx,
  req,
  voucherTypeCode,
  payload,
  excludePurchaseVoucherId = null,
}) => {
  const voucherDate = toDateOnly(payload.voucher_date);
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  let supplierPartyId = null;
  let referenceNo = normalizeText(payload.reference_no, 120);
  const description = normalizeText(
    payload.description || payload.remarks,
    1000,
  );
  const lines = await normalizeAndValidateLinesTx({
    trx,
    voucherTypeCode,
    rawLines: payload.lines || [],
  });

  let paymentType = "CREDIT";
  let cashPaidAccountId = null;
  let grnReferenceVoucherNo = null;
  let grnAllocationsPayload = null;
  let returnReason = null;
  let allocationByLineNo = new Map();

  if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
    paymentType = normalizePaymentType(payload.payment_type);
    if (paymentType === "CASH") {
      cashPaidAccountId = await validateCashAccountTx({
        trx,
        req,
        cashPaidAccountId: payload.cash_paid_account_id,
      });
    }

    const rawGrnReference = String(
      payload.grn_reference_voucher_no || "",
    ).trim();
    grnReferenceVoucherNo = parseVoucherNo(rawGrnReference);
    if (rawGrnReference && !grnReferenceVoucherNo) {
      throw new HttpError(400, "GRN reference is invalid");
    }

    const rawSupplierPartyId = toPositiveInt(payload.supplier_party_id);
    const supplierRequired =
      paymentType !== "CASH" || Boolean(grnReferenceVoucherNo);
    if (supplierRequired) {
      const supplier = await validateSupplierTx({
        trx,
        req,
        supplierPartyId: rawSupplierPartyId,
      });
      supplierPartyId = supplier.id;
    } else if (rawSupplierPartyId) {
      const supplier = await validateSupplierTx({
        trx,
        req,
        supplierPartyId: rawSupplierPartyId,
      });
      supplierPartyId = supplier.id;
    }

    if (!grnReferenceVoucherNo) {
      grnAllocationsPayload = normalizeGrnAllocationsPayload(
        payload.grn_allocations,
      );
      if (grnAllocationsPayload?.allocations?.length) {
        throw new HttpError(
          400,
          "GRN allocations require a selected GRN reference",
        );
      }
    }
    if (grnReferenceVoucherNo) {
      const grnMeta = await getReferencedGrnMetaTx({
        trx,
        branchId: req.branchId,
        grnVoucherNo: grnReferenceVoucherNo,
      });
      if (!grnMeta.exists) {
        throw new HttpError(400, "Selected GRN reference is invalid");
      }
      if (grnMeta.referenceNo) {
        referenceNo = grnMeta.referenceNo;
      }

      if (!supplierPartyId) {
        throw new HttpError(
          400,
          "Supplier is required when GRN reference is selected",
        );
      }
      grnAllocationsPayload = normalizeGrnAllocationsPayload(
        payload.grn_allocations,
      );
      const payloadPlan = await buildGrnAllocationPlanFromPayloadTx({
        trx,
        branchId: req.branchId,
        supplierPartyId,
        lines,
        grnReferenceVoucherNo,
        rawGrnAllocations: grnAllocationsPayload,
        excludePurchaseVoucherId,
      });

      allocationByLineNo =
        payloadPlan ||
        (await buildGrnAllocationPlanTx({
          trx,
          branchId: req.branchId,
          supplierPartyId,
          lines,
          preferredGrnVoucherNo: grnReferenceVoucherNo,
          excludePurchaseVoucherId,
          restrictToPreferredVoucher: true,
        }));
    }
  }

  if (!referenceNo) throw new HttpError(400, "Bill number is required");

  if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.purchaseReturn) {
    const supplier = await validateSupplierTx({
      trx,
      req,
      supplierPartyId: payload.supplier_party_id,
    });
    supplierPartyId = supplier.id;
    returnReason = normalizeReturnReason(payload.return_reason);
    if (!returnReason)
      throw new HttpError(400, "Purchase return reason is required");
  } else if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.goodsReceiptNote) {
    const supplier = await validateSupplierTx({
      trx,
      req,
      supplierPartyId: payload.supplier_party_id,
    });
    supplierPartyId = supplier.id;
  }

  return {
    voucherDate,
    supplierPartyId,
    referenceNo,
    description,
    paymentType,
    cashPaidAccountId,
    returnReason,
    grnReferenceVoucherNo,
    grnAllocationsPayload,
    lines,
    allocationByLineNo,
  };
};

const createPurchaseVoucher = async ({
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
    const validated = await validatePurchaseVoucherPayloadTx({
      trx,
      req,
      voucherTypeCode,
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
    const queuedForApproval =
      !canCreate || (policyRequiresApproval && !canApprove);

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
        remarks: validated.description,
      })
      .returning(["id", "voucher_no", "status"]);

    const insertedLines = await insertVoucherLinesTx({
      trx,
      voucherId: header.id,
      lines: validated.lines,
    });

    await upsertHeaderExtensionTx({
      trx,
      voucherId: header.id,
      voucherTypeCode,
      supplierPartyId: validated.supplierPartyId,
      referenceNo: validated.referenceNo,
      description: validated.description,
      paymentType: validated.paymentType,
      cashPaidAccountId: validated.cashPaidAccountId,
      returnReason: validated.returnReason,
      grnReferenceVoucherNo: validated.grnReferenceVoucherNo,
    });

    if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
      await insertPurchaseAllocationsTx({
        trx,
        insertedLines,
        allocationByLineNo: validated.allocationByLineNo,
      });
    }

    if (!queuedForApproval) {
      await syncVoucherGlPostingTx({ trx, voucherId: header.id });
      await syncPurchaseVoucherStockTx({
        trx,
        voucherId: header.id,
        voucherTypeCode,
      });
    }

    let approvalRequestId = null;
    if (queuedForApproval) {
      approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: header.id,
        voucherTypeCode,
        summary: `${voucherTypeCode} #${header.voucher_no}`,
        newValue: {
          voucher_type_code: voucherTypeCode,
          voucher_no: header.voucher_no,
          voucher_date: validated.voucherDate,
          reference_no: validated.referenceNo,
          description: validated.description,
          supplier_party_id: validated.supplierPartyId,
          payment_type: validated.paymentType,
          cash_paid_account_id: validated.cashPaidAccountId,
          return_reason: validated.returnReason,
          grn_reference_voucher_no: validated.grnReferenceVoucherNo,
          grn_allocations: validated.grnAllocationsPayload || null,
          lines: validated.lines,
          permission_reroute: !canCreate,
        },
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
const updatePurchaseVoucher = async ({
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
      .select(
        "id",
        "voucher_no",
        "status",
        "voucher_date",
        "book_no",
        "remarks",
      )
      .where({
        id: normalizedVoucherId,
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      })
      .first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (existing.status === "REJECTED")
      throw new HttpError(400, "Deleted voucher cannot be edited");

    const validated = await validatePurchaseVoucherPayloadTx({
      trx,
      req,
      voucherTypeCode,
      payload,
      excludePurchaseVoucherId: normalizedVoucherId,
    });

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "edit",
    );
    const queuedForApproval =
      !canEdit || (policyRequiresApproval && !canApprove);

    const updatePayload = {
      action: "update",
      voucher_id: existing.id,
      voucher_no: existing.voucher_no,
      voucher_type_code: voucherTypeCode,
      voucher_date: validated.voucherDate,
      reference_no: validated.referenceNo,
      description: validated.description,
      supplier_party_id: validated.supplierPartyId,
      payment_type: validated.paymentType,
      cash_paid_account_id: validated.cashPaidAccountId,
      return_reason: validated.returnReason,
      grn_reference_voucher_no: validated.grnReferenceVoucherNo,
      grn_allocations: validated.grnAllocationsPayload || null,
      lines: validated.lines,
      permission_reroute: !canEdit,
    };

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: existing.id,
        voucherTypeCode,
        summary: `UPDATE ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: {
          voucher_date: existing.voucher_date,
          reference_no: existing.book_no,
          description: existing.remarks,
          status: existing.status,
        },
        newValue: updatePayload,
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
      book_no: validated.referenceNo,
      remarks: validated.description,
      status: "APPROVED",
      approved_by: req.user.id,
      approved_at: trx.fn.now(),
    });

    if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
      await deletePurchaseAllocationsByVoucherTx({
        trx,
        voucherId: existing.id,
      });
    }

    await trx("erp.voucher_line")
      .where({ voucher_header_id: existing.id })
      .del();
    const insertedLines = await insertVoucherLinesTx({
      trx,
      voucherId: existing.id,
      lines: validated.lines,
    });

    await upsertHeaderExtensionTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode,
      supplierPartyId: validated.supplierPartyId,
      referenceNo: validated.referenceNo,
      description: validated.description,
      paymentType: validated.paymentType,
      cashPaidAccountId: validated.cashPaidAccountId,
      returnReason: validated.returnReason,
      grnReferenceVoucherNo: validated.grnReferenceVoucherNo,
    });

    if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
      await insertPurchaseAllocationsTx({
        trx,
        insertedLines,
        allocationByLineNo: validated.allocationByLineNo,
      });
    }

    await syncVoucherGlPostingTx({ trx, voucherId: existing.id });
    await syncPurchaseVoucherStockTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode,
    });

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

const applyPurchaseVoucherDeletePayloadTx = async ({
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
  await syncPurchaseVoucherStockTx({
    trx,
    voucherId: normalizedVoucherId,
    voucherTypeCode,
  });
};

const deletePurchaseVoucher = async ({
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

    await applyPurchaseVoucherDeletePayloadTx({
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

const loadPurchaseVoucherOptions = async (req) => {
  let supplierQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','BOTH')");
  supplierQuery = supplierQuery.where(function wherePartyScope() {
    this.where("p.branch_id", req.branchId).orWhereExists(
      function wherePartyBranchMap() {
        this.select(1)
          .from("erp.party_branch as pb")
          .whereRaw("pb.party_id = p.id")
          .andWhere("pb.branch_id", req.branchId);
      },
    );
  });

  const cashAccountQuery = knex("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .select("a.id", "a.code", "a.name", "apc.code as posting_class_code")
    .where({ "a.is_active": true })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .andWhere("ab.branch_id", req.branchId);
    })
    .whereRaw("lower(coalesce(apc.code, '')) in ('cash','bank')");

  const [
    suppliers,
    rawMaterials,
    colors,
    sizes,
    cashAccounts,
    openGrnPool,
    rmRateRows,
  ] = await Promise.all([
    supplierQuery.orderBy("p.name", "asc"),
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
    cashAccountQuery.orderBy("a.name", "asc"),
    knex.transaction(async (trx) =>
      loadOpenGrnPoolsTx({ trx, branchId: req.branchId }),
    ),
    knex("erp.rm_purchase_rates as r")
      .join("erp.items as i", "i.id", "r.rm_item_id")
      .leftJoin("erp.colors as c", "c.id", "r.color_id")
      .leftJoin("erp.sizes as s", "s.id", "r.size_id")
      .select(
        "r.rm_item_id",
        "r.color_id",
        "c.name as color_name",
        "r.size_id",
        "s.name as size_name",
        "r.purchase_rate",
      )
      .where({ "r.is_active": true, "i.is_active": true })
      .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
      .orderBy("r.rm_item_id", "asc"),
  ]);

  const masterColorNameById = new Map(
    (colors || []).map((row) => [Number(row.id), row.name || ""]),
  );
  const masterSizeNameById = new Map(
    (sizes || []).map((row) => [Number(row.id), row.name || ""]),
  );
  const rawMaterialColorPolicyByItem = {};
  const rawMaterialSizePolicyByItem = {};
  const rawMaterialRatesByItem = {};
  rmRateRows.forEach((row) => {
    const itemId = Number(row.rm_item_id);
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

    const colorId = toPositiveInt(row.color_id);
    if (!colorId) {
      rawMaterialColorPolicyByItem[key].hasColorless = true;
    } else {
      const existingColor = rawMaterialColorPolicyByItem[key].colors.some(
        (entry) => Number(entry.id) === Number(colorId),
      );
      if (!existingColor) {
        rawMaterialColorPolicyByItem[key].colors.push({
          id: Number(colorId),
          name:
            row.color_name ||
            masterColorNameById.get(Number(colorId)) ||
            String(colorId),
        });
      }
    }

    const sizeId = toPositiveInt(row.size_id);
    if (!sizeId) {
      rawMaterialSizePolicyByItem[key].hasSizeless = true;
    } else {
      const existingSize = rawMaterialSizePolicyByItem[key].sizes.some(
        (entry) => Number(entry.id) === Number(sizeId),
      );
      if (!existingSize) {
        rawMaterialSizePolicyByItem[key].sizes.push({
          id: Number(sizeId),
          name:
            row.size_name ||
            masterSizeNameById.get(Number(sizeId)) ||
            String(sizeId),
        });
      }
    }

    const purchaseRate = Number(row.purchase_rate || 0);
    if (Number.isFinite(purchaseRate) && purchaseRate > 0) {
      rawMaterialRatesByItem[key].push({
        color_id: toPositiveInt(row.color_id),
        size_id: toPositiveInt(row.size_id),
        purchase_rate: Number(purchaseRate.toFixed(4)),
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

  const supplierNameById = new Map(
    (suppliers || []).map((row) => [Number(row.id), row.name || ""]),
  );
  const rawMaterialNameById = new Map(
    (rawMaterials || []).map((row) => [Number(row.id), row.name || ""]),
  );
  const colorLabelById = new Map(
    (colors || []).map((row) => [Number(row.id), row.name || ""]),
  );
  const sizeLabelById = new Map(
    (sizes || []).map((row) => [Number(row.id), row.name || ""]),
  );
  const grnHeaderMap = new Map();
  openGrnPool.forEach((row) => {
    const key = Number(row.grn_voucher_id);
    const current = grnHeaderMap.get(key) || {
      id: Number(row.grn_voucher_id),
      voucher_no: Number(row.grn_voucher_no),
      voucher_date: row.grn_voucher_date,
      supplier_party_id: Number(row.supplier_party_id),
      open_qty: 0,
      item_open_qty_by_id: new Map(),
    };
    const openQty = Number(row.open_qty || 0);
    current.open_qty = Number((current.open_qty + openQty).toFixed(3));
    const itemId = Number(row.item_id || 0);
    if (itemId > 0 && openQty > 0) {
      const prevQty = Number(current.item_open_qty_by_id.get(itemId) || 0);
      current.item_open_qty_by_id.set(
        itemId,
        Number((prevQty + openQty).toFixed(3)),
      );
    }
    grnHeaderMap.set(key, current);
  });

  const openGrnHeaders = [...grnHeaderMap.values()]
    .map((header) => {
      const itemParts = [...header.item_open_qty_by_id.entries()]
        .sort((a, b) => {
          const nameA = String(
            rawMaterialNameById.get(Number(a[0])) || "",
          ).toLowerCase();
          const nameB = String(
            rawMaterialNameById.get(Number(b[0])) || "",
          ).toLowerCase();
          return nameA.localeCompare(nameB);
        })
        .map(([itemId, qty]) => {
          const itemName =
            rawMaterialNameById.get(Number(itemId)) || `#${Number(itemId)}`;
          return `${itemName} ${Number(qty || 0).toFixed(3)}`;
        });
      return {
        id: header.id,
        voucher_no: header.voucher_no,
        voucher_date: header.voucher_date,
        supplier_party_id: header.supplier_party_id,
        supplier_name:
          supplierNameById.get(Number(header.supplier_party_id)) || "",
        reference_no: header.grn_reference_no || "",
        open_qty: Number(header.open_qty || 0),
        items_summary: itemParts.join(", "),
      };
    })
    .sort((a, b) => b.voucher_no - a.voucher_no);

  const openGrnLines = openGrnPool
    .map((row) => ({
      grn_voucher_id: Number(row.grn_voucher_id),
      grn_voucher_no: Number(row.grn_voucher_no),
      grn_voucher_date: row.grn_voucher_date,
      supplier_party_id: Number(row.supplier_party_id),
      supplier_name: supplierNameById.get(Number(row.supplier_party_id)) || "",
      reference_no: row.grn_reference_no || "",
      grn_line_id: Number(row.grn_line_id),
      grn_line_no: Number(row.grn_line_no),
      item_id: Number(row.item_id),
      item_name:
        rawMaterialNameById.get(Number(row.item_id)) ||
        `#${Number(row.item_id)}`,
      color_id: toPositiveInt(row.color_id),
      color_name: toPositiveInt(row.color_id)
        ? colorLabelById.get(Number(row.color_id)) || ""
        : "",
      size_id: toPositiveInt(row.size_id),
      size_name: toPositiveInt(row.size_id)
        ? sizeLabelById.get(Number(row.size_id)) || ""
        : "",
      open_qty: Number(row.open_qty || 0),
    }))
    .sort((a, b) => {
      if (a.grn_voucher_no !== b.grn_voucher_no)
        return b.grn_voucher_no - a.grn_voucher_no;
      return a.grn_line_no - b.grn_line_no;
    });

  return {
    suppliers,
    rawMaterials,
    colors,
    sizes,
    rawMaterialColorPolicyByItem,
    rawMaterialSizePolicyByItem,
    rawMaterialRatesByItem,
    cashAccounts,
    purchaseReturnReasons: PURCHASE_RETURN_REASONS,
    openGrnHeaders,
    openGrnLines,
  };
};

const loadRecentPurchaseVouchers = async ({ req, voucherTypeCode }) => {
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

const getPurchaseVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
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

const getPurchaseVoucherNeighbours = async ({
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

const loadPurchaseVoucherDetails = async ({
  req,
  voucherTypeCode,
  voucherNo,
}) => {
  const targetNo = parseVoucherNo(voucherNo);
  if (!targetNo) return null;

  const header = await knex("erp.voucher_header")
    .select("id", "voucher_no", "voucher_date", "status", "book_no", "remarks")
    .where({
      branch_id: req.branchId,
      voucher_type_code: voucherTypeCode,
      voucher_no: targetNo,
    })
    .first();
  if (!header) return null;

  const lines = await knex("erp.voucher_line as vl")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.item_id",
      "i.code as item_code",
      "i.name as item_name",
      "vl.uom_id",
      "u.code as uom_code",
      "u.name as uom_name",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      knex.raw(
        "CASE WHEN coalesce(vl.meta->>'color_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'color_id')::int ELSE NULL END as color_id",
      ),
      knex.raw(
        "CASE WHEN coalesce(vl.meta->>'size_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'size_id')::int ELSE NULL END as size_id",
      ),
    )
    .where({ "vl.voucher_header_id": header.id })
    .orderBy("vl.line_no", "asc");

  const colorIds = [
    ...new Set(
      lines.map((line) => toPositiveInt(line.color_id)).filter(Boolean),
    ),
  ];
  const sizeIds = [
    ...new Set(
      lines.map((line) => toPositiveInt(line.size_id)).filter(Boolean),
    ),
  ];
  const colorMap = colorIds.length
    ? new Map(
        (
          await knex("erp.colors").select("id", "name").whereIn("id", colorIds)
        ).map((row) => [Number(row.id), row.name]),
      )
    : new Map();
  const sizeMap = sizeIds.length
    ? new Map(
        (
          await knex("erp.sizes").select("id", "name").whereIn("id", sizeIds)
        ).map((row) => [Number(row.id), row.name]),
      )
    : new Map();

  const details = {
    id: Number(header.id),
    voucher_no: Number(header.voucher_no),
    voucher_date: toDateOnly(header.voucher_date),
    status: String(header.status || "").toUpperCase(),
    reference_no: header.book_no || "",
    description: header.remarks || "",
    supplier_party_id: null,
    payment_type: "CREDIT",
    cash_paid_account_id: null,
    return_reason: null,
    grn_reference_voucher_no: null,
    grn_reference_no: null,
    lines: lines.map((line) => ({
      id: Number(line.id),
      line_no: Number(line.line_no),
      item_id: Number(line.item_id),
      item_name: line.item_name || "",
      item_code: line.item_code || "",
      uom_id: Number(line.uom_id || 0) || null,
      uom_name: line.uom_name || "",
      qty: Number(line.qty || 0),
      rate: Number(line.rate || 0),
      amount: Number(line.amount || 0),
      color_id: toPositiveInt(line.color_id),
      color_name: toPositiveInt(line.color_id)
        ? colorMap.get(Number(line.color_id)) || ""
        : "",
      size_id: toPositiveInt(line.size_id),
      size_name: toPositiveInt(line.size_id)
        ? sizeMap.get(Number(line.size_id)) || ""
        : "",
    })),
  };

  if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.goodsReceiptNote) {
    const ext = await safeFirstMissingRelation(
      knex("erp.purchase_grn_header_ext")
        .select("supplier_party_id", "supplier_reference_no", "description")
        .where({ voucher_id: header.id })
        .first(),
      "erp.purchase_grn_header_ext",
    );
    details.supplier_party_id = Number(ext?.supplier_party_id || 0) || null;
    if (!details.reference_no && ext?.supplier_reference_no)
      details.reference_no = ext.supplier_reference_no;
    if (!details.description && ext?.description)
      details.description = ext.description;
  } else if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
    const ext = await safeFirstMissingRelation(
      knex("erp.purchase_invoice_header_ext")
        .select(
          "supplier_party_id",
          "payment_type",
          "cash_paid_account_id",
          "grn_reference_voucher_no",
        )
        .where({ voucher_id: header.id })
        .first(),
      "erp.purchase_invoice_header_ext",
    );
    details.supplier_party_id = Number(ext?.supplier_party_id || 0) || null;
    details.payment_type = normalizePaymentType(ext?.payment_type || "CREDIT");
    details.cash_paid_account_id =
      Number(ext?.cash_paid_account_id || 0) || null;
    details.grn_reference_voucher_no = parseVoucherNo(
      ext?.grn_reference_voucher_no,
    );
    if (details.grn_reference_voucher_no) {
      const grnMeta = await getReferencedGrnMetaTx({
        trx: knex,
        branchId: req.branchId,
        grnVoucherNo: details.grn_reference_voucher_no,
      });
      details.grn_reference_no = grnMeta?.referenceNo || null;
    }
  } else if (voucherTypeCode === PURCHASE_VOUCHER_TYPES.purchaseReturn) {
    const ext = await safeFirstMissingRelation(
      knex("erp.purchase_return_header_ext")
        .select("supplier_party_id", "reason")
        .where({ voucher_id: header.id })
        .first(),
      "erp.purchase_return_header_ext",
    );
    details.supplier_party_id = Number(ext?.supplier_party_id || 0) || null;
    details.return_reason = normalizeReturnReason(ext?.reason);
  }

  return details;
};
const loadVoucherLinesForAllocationTx = async ({ trx, voucherId }) =>
  trx("erp.voucher_line as vl")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.item_id",
      "vl.uom_id",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "i.name as item_name",
      knex.raw(
        "CASE WHEN coalesce(vl.meta->>'color_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'color_id')::int ELSE NULL END as color_id",
      ),
      knex.raw(
        "CASE WHEN coalesce(vl.meta->>'size_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'size_id')::int ELSE NULL END as size_id",
      ),
    )
    .where({ "vl.voucher_header_id": voucherId, "vl.line_kind": "ITEM" })
    .orderBy("vl.line_no", "asc");

const ensurePurchaseVoucherDerivedDataTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  req,
}) => {
  const normalizedVoucherTypeCode = String(voucherTypeCode || "")
    .trim()
    .toUpperCase();
  if (
    normalizedVoucherTypeCode !== PURCHASE_VOUCHER_TYPES.goodsReceiptNote &&
    normalizedVoucherTypeCode !== PURCHASE_VOUCHER_TYPES.generalPurchase &&
    normalizedVoucherTypeCode !== PURCHASE_VOUCHER_TYPES.purchaseReturn
  ) {
    return;
  }

  // PI requires GRN allocation derivation + stock sync.
  if (normalizedVoucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase) {
    const ext = await safeFirstMissingRelation(
      trx("erp.purchase_invoice_header_ext")
        .select("supplier_party_id", "grn_reference_voucher_no")
        .where({ voucher_id: voucherId })
        .first(),
      "erp.purchase_invoice_header_ext",
    );
    if (!ext) {
      throw new Error(
        `Missing purchase invoice extension for voucher ${voucherId}`,
      );
    }

    await deletePurchaseAllocationsByVoucherTx({ trx, voucherId });
    if (ext?.supplier_party_id) {
      const lines = await loadVoucherLinesForAllocationTx({ trx, voucherId });
      const preferredGrnVoucherNo = parseVoucherNo(
        ext.grn_reference_voucher_no,
      );
      if (lines.length && preferredGrnVoucherNo) {
        if (!req?.branchId) {
          throw new Error(
            `Branch context is required to derive purchase allocations for voucher ${voucherId}`,
          );
        }
        const normalizedLines = lines.map((line) => ({
          line_no: Number(line.line_no),
          item_id: Number(line.item_id),
          qty: Number(line.qty || 0),
          rate: Number(line.rate || 0),
          amount: Number(line.amount || 0),
          uom_id: Number(line.uom_id),
          color_id: toPositiveInt(line.color_id),
          size_id: toPositiveInt(line.size_id),
          meta: {
            color_id: toPositiveInt(line.color_id) || undefined,
            size_id: toPositiveInt(line.size_id) || undefined,
          },
          item_name: line.item_name || "",
        }));

        const allocationByLineNo = await buildGrnAllocationPlanTx({
          trx,
          branchId: req.branchId,
          supplierPartyId: Number(ext.supplier_party_id),
          lines: normalizedLines,
          preferredGrnVoucherNo,
          excludePurchaseVoucherId: voucherId,
          restrictToPreferredVoucher: true,
        });

        const insertedLines = lines.map((line) => ({
          id: Number(line.id),
          line_no: Number(line.line_no),
        }));

        await insertPurchaseAllocationsTx({
          trx,
          insertedLines,
          allocationByLineNo,
        });
      }
    }
  }

  // Stock sync is centralized here so approval-driven updates reuse the same path.
  if (
    normalizedVoucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase ||
    normalizedVoucherTypeCode === PURCHASE_VOUCHER_TYPES.purchaseReturn
  ) {
    await syncPurchaseVoucherStockTx({
      trx,
      voucherId,
      voucherTypeCode: normalizedVoucherTypeCode,
    });
  }
};

const applyPurchaseVoucherUpdatePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  payload,
  req,
}) => {
  if (
    voucherTypeCode !== PURCHASE_VOUCHER_TYPES.goodsReceiptNote &&
    voucherTypeCode !== PURCHASE_VOUCHER_TYPES.generalPurchase &&
    voucherTypeCode !== PURCHASE_VOUCHER_TYPES.purchaseReturn
  ) {
    return;
  }

  const validated = await validatePurchaseVoucherPayloadTx({
    trx,
    req,
    voucherTypeCode,
    payload,
    excludePurchaseVoucherId: voucherId,
  });

  await upsertHeaderExtensionTx({
    trx,
    voucherId,
    voucherTypeCode,
    supplierPartyId: validated.supplierPartyId,
    referenceNo: validated.referenceNo,
    description: validated.description,
    paymentType: validated.paymentType,
    cashPaidAccountId: validated.cashPaidAccountId,
    returnReason: validated.returnReason,
    grnReferenceVoucherNo: validated.grnReferenceVoucherNo,
  });

  await ensurePurchaseVoucherDerivedDataTx({
    trx,
    voucherId,
    voucherTypeCode,
    req,
  });
};

module.exports = {
  PURCHASE_VOUCHER_TYPES,
  PURCHASE_RETURN_REASONS,
  normalizePaymentType,
  parseVoucherNo,
  createPurchaseVoucher,
  updatePurchaseVoucher,
  deletePurchaseVoucher,
  loadPurchaseVoucherOptions,
  loadRecentPurchaseVouchers,
  getPurchaseVoucherSeriesStats,
  getPurchaseVoucherNeighbours,
  loadPurchaseVoucherDetails,
  applyPurchaseVoucherUpdatePayloadTx,
  applyPurchaseVoucherDeletePayloadTx,
  ensurePurchaseVoucherDerivedDataTx,
};
