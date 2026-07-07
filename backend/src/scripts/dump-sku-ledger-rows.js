// Read-only: dumps every ON_HAND stock_ledger row for one SKU/branch, up to
// a date, with the exact fields both the Stock Balances Report and the Stock
// Count Voucher article-list use to classify packed/loose and to decide
// whether the row counts at all -- so a per-row disagreement between the two
// is visible directly instead of inferred from totals.
//
// Usage (from backend/):
//   node src/scripts/dump-sku-ledger-rows.js --sku-code="701 7/10" --branch-id=2 --as-on=2026-07-03
const knex = require("../db/knex");

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

const getArg = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=").trim() : null;
};

const run = async () => {
  const skuCode = getArg("sku-code");
  const skuIdArg = getArg("sku-id");
  const branchId = Number(getArg("branch-id"));
  const asOn = getArg("as-on");

  if ((!skuCode && !skuIdArg) || !branchId || !asOn) {
    console.error(
      'Usage: node dump-sku-ledger-rows.js (--sku-code="..." | --sku-id=<id>) --branch-id=<id> --as-on=YYYY-MM-DD',
    );
    process.exit(1);
  }

  let skuId = Number(skuIdArg) || null;
  if (!skuId) {
    const matches = await knex("erp.skus").select("id", "sku_code").whereILike("sku_code", `%${skuCode}%`);
    if (matches.length === 0) {
      console.error(`No SKU found matching "${skuCode}"`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.log(`${matches.length} SKUs match "${skuCode}" -- pass --sku-id to pick one:`);
      matches.forEach((m) => console.log(`  id=${m.id} sku_code=${m.sku_code}`));
      process.exit(1);
    }
    skuId = Number(matches[0].id);
    console.log(`Resolved SKU "${skuCode}" -> id ${skuId} (${matches[0].sku_code})`);
  }

  const rows = await knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .select(
      "sl.id as ledger_id",
      "sl.voucher_line_id",
      "vh.id as voucher_id",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.status as voucher_status",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
      knex.raw("to_char(sl.txn_date, 'YYYY-MM-DD') as txn_date"),
      "sl.direction",
      "sl.qty_pairs",
      knex.raw(`${FG_PACKED_FLAG_SQL} as is_packed`),
      "sln.is_packed as sales_line_is_packed",
      "pl.is_packed as production_line_is_packed",
      "vl.meta",
    )
    .where({ "sl.branch_id": branchId, "sl.stock_state": "ON_HAND", "sl.category": "FG", "sl.sku_id": skuId })
    .orderBy("vh.voucher_date", "asc")
    .orderBy("sl.id", "asc");

  console.log(`\n${rows.length} total ON_HAND FG stock_ledger row(s) for sku_id=${skuId}, branch=${branchId} (no date filter yet, showing all history):\n`);

  let reportSumUpToDate = 0; // txn_date <= asOn, packed only
  let voucherSumUpToDate = 0; // voucher_date <= asOn, packed only, AND has a voucher_line (inner join)

  rows.forEach((r) => {
    const signedQty = Number(r.direction) === 1 ? Number(r.qty_pairs) : -Number(r.qty_pairs);
    const inReportWindow = r.txn_date <= asOn;
    const inVoucherWindow = r.voucher_date <= asOn;
    const hasVoucherLine = r.voucher_line_id != null;
    const countsInReport = inReportWindow && r.is_packed === true;
    const countsInVoucher = inVoucherWindow && hasVoucherLine && r.is_packed === true;
    if (countsInReport) reportSumUpToDate += signedQty;
    if (countsInVoucher) voucherSumUpToDate += signedQty;

    const flags = [];
    if (r.txn_date !== r.voucher_date) flags.push("TXN_DATE!=VOUCHER_DATE");
    if (!hasVoucherLine) flags.push("NULL_VOUCHER_LINE_ID");
    if (countsInReport !== countsInVoucher) flags.push("*** COUNTED DIFFERENTLY ***");

    console.log(
      `  ledger#${r.ledger_id} voucher=${r.voucher_type_code}#${r.voucher_no} (id ${r.voucher_id}, status=${r.voucher_status}) ` +
        `voucher_date=${r.voucher_date} txn_date=${r.txn_date} dir=${r.direction} qty_pairs=${r.qty_pairs} ` +
        `is_packed=${r.is_packed} (sales_line=${r.sales_line_is_packed} prod_line=${r.production_line_is_packed} meta_status=${r?.meta?.row_status || r?.meta?.status || ""}) ` +
        `voucher_line_id=${r.voucher_line_id} ${flags.length ? "  <<< " + flags.join(", ") : ""}`,
    );
  });

  console.log(`\nSum where txn_date<=${asOn} AND is_packed (report method):    ${reportSumUpToDate}`);
  console.log(`Sum where voucher_date<=${asOn} AND is_packed AND has voucher_line (voucher method): ${voucherSumUpToDate}`);
  console.log(`Difference: ${reportSumUpToDate - voucherSumUpToDate}`);

  await knex.destroy();
};

run()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("failed:", err);
    try {
      await knex.destroy();
    } catch (e) {}
    process.exit(1);
  });
