// Helper used when a voucher edit/delete needs to roll back stock it previously
// posted, but current stock is already lower than what it originally added
// (because a later transaction consumed it). Produces a human-readable
// explanation naming the downstream voucher(s) responsible, instead of a bare
// "qty underflow" message.

const CATEGORY_LABELS = {
  RM: "raw material",
  SFG: "semi-finished goods",
  FG: "finished goods",
};

// Finds the later stock_ledger OUT rows (direction -1) for the same stock
// identity that were posted after the row being rolled back, accumulating
// just enough of them to explain the shortfall.
const findStockShortfallCulpritsTx = async ({
  trx,
  category,
  branchId,
  stockState,
  skuId,
  itemId,
  colorId,
  sizeId,
  afterLedgerId,
  shortfallQty,
}) => {
  const isRm = category === "RM";
  const qtyColumn = isRm ? "sl.qty" : "sl.qty_pairs";

  const query = trx("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .join("erp.voucher_type as vt", "vt.code", "vh.voucher_type_code")
    .select(
      "vh.id as voucher_id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vt.name as voucher_type_name",
      trx.raw(`${qtyColumn} as moved_qty`),
    )
    .where("sl.branch_id", branchId)
    .andWhere("sl.category", category)
    .andWhere("sl.stock_state", stockState)
    .andWhere("sl.direction", -1)
    .andWhere("sl.id", ">", afterLedgerId)
    .orderBy("sl.id", "asc");

  if (isRm) {
    query.andWhere("sl.item_id", itemId);
    query.andWhere(
      colorId
        ? { "sl.color_id": colorId }
        : (b) => b.whereNull("sl.color_id"),
    );
    query.andWhere(
      sizeId ? { "sl.size_id": sizeId } : (b) => b.whereNull("sl.size_id"),
    );
  } else {
    query.andWhere("sl.sku_id", skuId);
  }

  const rows = await query;

  const culprits = [];
  let covered = 0;
  for (const r of rows) {
    culprits.push(r);
    covered += Number(r.moved_qty || 0);
    if (covered >= shortfallQty) break;
  }
  return culprits;
};

// Nets the entire stock_ledger history for one stock identity (all vouchers,
// not just ones after a given row). Used to tell apart "a later transaction
// consumed this" from "the cached running balance has drifted from the ledger".
const computeLedgerNetQtyTx = async ({
  trx,
  category,
  branchId,
  stockState,
  skuId,
  itemId,
  colorId,
  sizeId,
}) => {
  const isRm = category === "RM";
  const qtyColumn = isRm ? "qty" : "qty_pairs";

  const query = trx("erp.stock_ledger")
    .where({ branch_id: branchId, category, stock_state: stockState })
    .select(trx.raw(`COALESCE(SUM(direction * ${qtyColumn}), 0) as net`));

  if (isRm) {
    query.andWhere("item_id", itemId);
    query.andWhere(
      colorId ? { color_id: colorId } : (b) => b.whereNull("color_id"),
    );
    query.andWhere(
      sizeId ? { size_id: sizeId } : (b) => b.whereNull("size_id"),
    );
  } else {
    query.andWhere("sku_id", skuId);
  }

  const row = await query.first();
  return Number(row?.net || 0);
};

const formatVoucherDate = (value) => {
  if (!value) return "unknown date";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
};

const formatCulpritList = (culprits, isRm) => {
  if (!culprits.length) return "";
  return culprits
    .map((c) => {
      const qty = Number(c.moved_qty || 0);
      const qtyLabel = isRm ? `${qty}` : `${qty} pair(s)`;
      return `${c.voucher_type_name} #${c.voucher_no} dated ${formatVoucherDate(c.voucher_date)} (${qtyLabel})`;
    })
    .join(", ");
};

// Builds the full user-facing message for a stock rollback shortfall.
// `subjectLabel` is a human label for the item/SKU (e.g. "RM item Cotton Yarn"
// or "SKU 4581-RED-M"). `metric` is "qty" or "value".
const buildStockShortfallMessageTx = async ({
  trx,
  category,
  branchId,
  stockState,
  skuId,
  itemId,
  colorId,
  sizeId,
  afterLedgerId,
  shortfallQty,
  availableQty,
  subjectLabel,
  metric,
}) => {
  const isRm = category === "RM";
  const categoryLabel = CATEGORY_LABELS[category] || category;

  const culprits = await findStockShortfallCulpritsTx({
    trx,
    category,
    branchId,
    stockState,
    skuId,
    itemId,
    colorId,
    sizeId,
    afterLedgerId,
    shortfallQty,
  });

  let explanation;
  if (culprits.length) {
    explanation = `This stock already appears to have been used by: ${formatCulpritList(culprits, isRm)}. Undo or adjust that transaction first, then retry this change.`;
  } else {
    const ledgerNetQty = await computeLedgerNetQtyTx({
      trx,
      category,
      branchId,
      stockState,
      skuId,
      itemId,
      colorId,
      sizeId,
    });
    const balanceMatchesLedger =
      typeof availableQty === "number" &&
      Math.abs(ledgerNetQty - availableQty) < 0.01;
    explanation = balanceMatchesLedger
      ? `No later transaction in the stock ledger touched this stock, so the shortfall isn't caused by something consuming it afterwards — it traces back to how this voucher's own quantity was originally recorded. This needs to be checked by an admin directly against the stock ledger entries for this voucher.`
      : `No later transaction in the stock ledger explains this — but the stock ledger for ${subjectLabel} in this branch nets to ${ledgerNetQty}, while the stored running balance shows ${availableQty}. These should match; the cached balance has drifted from the ledger and needs reconciliation before this change can proceed. Please share these figures with your system administrator.`;
  }

  const metricPhrase =
    metric === "value"
      ? "its recorded value has since dropped below what this voucher originally posted"
      : `its quantity has since dropped below what this voucher originally added (short by ${shortfallQty})`;

  return `Can't apply this change: ${categoryLabel} stock for ${subjectLabel} has already moved — ${metricPhrase}. ${explanation}`;
};

module.exports = {
  CATEGORY_LABELS,
  findStockShortfallCulpritsTx,
  formatCulpritList,
  buildStockShortfallMessageTx,
};
