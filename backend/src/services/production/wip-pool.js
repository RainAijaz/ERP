// Department WIP pool primitives.
//
// Extracted from production-voucher-service.js so the stock-transfer service can move WIP
// between branches without the two services requiring each other. Production is still the
// only thing that CREATES or CONSUMES WIP; transfers only relocate it.
//
// The pool is keyed (branch_id, stock_state, sku_id, dept_id). stock_state mirrors the way
// stock_balance_sku models a branch-to-branch move: a dispatch takes the pairs out of the
// source branch's ON_HAND bucket and puts them in the DESTINATION branch's IN_TRANSIT
// bucket, and the receipt moves them from IN_TRANSIT to ON_HAND at that same branch.
//
// Every read that means "WIP available to work on" must pass stockState 'ON_HAND'. The
// helpers here default to it precisely so an un-migrated caller keeps its old behaviour.

const { toLocalDateOnly } = require("../../utils/date-only");
const { HttpError } = require("../../middleware/errors/http-error");

const WIP_ON_HAND = "ON_HAND";
const WIP_IN_TRANSIT = "IN_TRANSIT";
const WIP_STOCK_STATES = [WIP_ON_HAND, WIP_IN_TRANSIT];

const toPositiveInt = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const roundCost2 = (value) => Number(Number(value || 0).toFixed(2));
const roundUnitCost6 = (value) => Number(Number(value || 0).toFixed(6));

// Unknown/blank states resolve to ON_HAND rather than throwing: the column defaults that way
// and every pre-transfer caller omits it entirely.
const normalizeWipStockState = (value) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return WIP_STOCK_STATES.includes(normalized) ? normalized : WIP_ON_HAND;
};

const adjustWipBalanceTx = async ({
  trx,
  branchId,
  skuId,
  deptId,
  stockState = WIP_ON_HAND,
  qtyDelta = 0,
  costDelta = 0,
  activityDate = null,
}) => {
  const normalizedBranchId = toPositiveInt(branchId);
  const normalizedSkuId = toPositiveInt(skuId);
  const normalizedDeptId = toPositiveInt(deptId);
  const normalizedState = normalizeWipStockState(stockState);
  if (!normalizedBranchId || !normalizedSkuId || !normalizedDeptId) return;

  // The conflict target must match the table's primary key exactly. It gained stock_state in
  // 20260828_000112 -- a stale three-column target raises "there is no unique or exclusion
  // constraint matching the ON CONFLICT specification".
  await trx("erp.wip_dept_balance")
    .insert({
      branch_id: normalizedBranchId,
      stock_state: normalizedState,
      sku_id: normalizedSkuId,
      dept_id: normalizedDeptId,
      qty_pairs: 0,
      cost_value: 0,
      last_activity_date: activityDate || null,
    })
    .onConflict(["branch_id", "stock_state", "sku_id", "dept_id"])
    .ignore();

  await trx("erp.wip_dept_balance")
    .where({
      branch_id: normalizedBranchId,
      stock_state: normalizedState,
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
  stockState = WIP_ON_HAND,
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
    stock_state: normalizeWipStockState(stockState),
    sku_id: Number(skuId),
    dept_id: Number(deptId),
    txn_date: txnDate,
    direction: Number(direction),
    qty_pairs: normalizedQtyPairs,
    cost_value: roundCost2(costValue),
    source_voucher_id: Number(sourceVoucherId),
  });
};

const getCurrentWipBalanceTx = async ({
  trx,
  branchId,
  skuId,
  deptId,
  stockState = WIP_ON_HAND,
}) =>
  trx("erp.wip_dept_balance")
    .select("qty_pairs", "cost_value")
    .where({
      branch_id: Number(branchId),
      stock_state: normalizeWipStockState(stockState),
      sku_id: Number(skuId),
      dept_id: Number(deptId),
    })
    .first();

// Pool cost is carried in aggregate, so a partial move has to take its proportional share.
const resolveWipUnitCost = (pool) => {
  const availablePairs = Number(pool?.qty_pairs || 0);
  const availableCost = Number(pool?.cost_value || 0);
  if (!(availablePairs > 0)) return 0;
  return roundUnitCost6(availableCost / availablePairs);
};

const rollbackWipLedgerBySourceVoucherTx = async ({ trx, voucherId }) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) return;
  const rows = await trx("erp.wip_dept_ledger")
    .select(
      "id",
      "branch_id",
      "stock_state",
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
    // Reverse into the same bucket the row was written to, or a transfer rollback would
    // credit ON_HAND with pairs that were sitting IN_TRANSIT.
    await adjustWipBalanceTx({
      trx,
      branchId: row.branch_id,
      stockState: row.stock_state,
      skuId: row.sku_id,
      deptId: row.dept_id,
      qtyDelta,
      costDelta,
      activityDate: row.txn_date ? toLocalDateOnly(row.txn_date) : null,
    });
  }

  if (rows.length) {
    await trx("erp.wip_dept_ledger")
      .where({ source_voucher_id: normalizedVoucherId })
      .del();
  }
};

// Hard block, deliberately. adjustWipBalanceTx clamps with greatest(qty_pairs + delta, 0),
// so an over-dispatch would NOT raise the table's CHECK (qty_pairs >= 0) -- it would silently
// zero the pool and lose the discrepancy. The caller must therefore check first.
const assertWipAvailableTx = async ({
  trx,
  branchId,
  skuId,
  deptId,
  stockState = WIP_ON_HAND,
  requiredPairs,
  skuLabel = "SKU",
  stageLabel = "",
}) => {
  const pool = await getCurrentWipBalanceTx({
    trx,
    branchId,
    skuId,
    deptId,
    stockState,
  });
  const availablePairs = Number(pool?.qty_pairs || 0);
  const needed = Number(requiredPairs || 0);
  if (availablePairs >= needed) return pool;

  const atStage = stageLabel ? ` at ${stageLabel}` : "";
  throw new HttpError(
    400,
    `${skuLabel}${atStage}: requested ${needed} pair(s) but the work-in-process pool holds ${availablePairs}. Short by ${needed - availablePairs} pair(s).`,
  );
};

// Relocate pairs between (branch, state) buckets for one SKU at one department, writing both
// ledger legs. Cost follows quantity at the source pool's average, so value survives the hop
// without the caller having to know anything about WAC.
const moveWipPairsTx = async ({
  trx,
  fromBranchId,
  fromStockState = WIP_ON_HAND,
  toBranchId,
  toStockState = WIP_ON_HAND,
  skuId,
  deptId,
  qtyPairs,
  voucherId,
  txnDate,
  skuLabel = "SKU",
  stageLabel = "",
  allowNegativeSource = false,
}) => {
  const normalizedQtyPairs = Number(qtyPairs || 0);
  if (!Number.isInteger(normalizedQtyPairs) || normalizedQtyPairs <= 0) return;

  const sourcePool = allowNegativeSource
    ? await getCurrentWipBalanceTx({
        trx,
        branchId: fromBranchId,
        skuId,
        deptId,
        stockState: fromStockState,
      })
    : await assertWipAvailableTx({
        trx,
        branchId: fromBranchId,
        skuId,
        deptId,
        stockState: fromStockState,
        requiredPairs: normalizedQtyPairs,
        skuLabel,
        stageLabel,
      });

  const unitCost = resolveWipUnitCost(sourcePool);
  const moveCost = roundCost2(unitCost * normalizedQtyPairs);
  const activityDate = txnDate ? toLocalDateOnly(txnDate) : null;

  await adjustWipBalanceTx({
    trx,
    branchId: fromBranchId,
    stockState: fromStockState,
    skuId,
    deptId,
    qtyDelta: -normalizedQtyPairs,
    costDelta: -moveCost,
    activityDate,
  });
  await insertWipLedgerTx({
    trx,
    branchId: fromBranchId,
    stockState: fromStockState,
    skuId,
    deptId,
    txnDate,
    direction: -1,
    qtyPairs: normalizedQtyPairs,
    costValue: moveCost,
    sourceVoucherId: voucherId,
  });

  await adjustWipBalanceTx({
    trx,
    branchId: toBranchId,
    stockState: toStockState,
    skuId,
    deptId,
    qtyDelta: normalizedQtyPairs,
    costDelta: moveCost,
    activityDate,
  });
  await insertWipLedgerTx({
    trx,
    branchId: toBranchId,
    stockState: toStockState,
    skuId,
    deptId,
    txnDate,
    direction: 1,
    qtyPairs: normalizedQtyPairs,
    costValue: moveCost,
    sourceVoucherId: voucherId,
  });

  return { qtyPairs: normalizedQtyPairs, costValue: moveCost, unitCost };
};

module.exports = {
  WIP_ON_HAND,
  WIP_IN_TRANSIT,
  WIP_STOCK_STATES,
  normalizeWipStockState,
  adjustWipBalanceTx,
  insertWipLedgerTx,
  getCurrentWipBalanceTx,
  resolveWipUnitCost,
  rollbackWipLedgerBySourceVoucherTx,
  assertWipAvailableTx,
  moveWipPairsTx,
};
