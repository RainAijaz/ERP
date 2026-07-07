// Read-only diagnostic: runs the Stock Balances Report's calculation and the
// Stock Count Voucher article-list's calculation side by side, for the exact
// same branch/group/status/date, to find why their totals disagree.
//
// The two use different SQL under the hood:
//   - Report (loadFgSfgDetailRows in inventory-report-service.js): filters on
//     stock_ledger.txn_date, LEFT JOINs voucher_line.
//   - Voucher article list (loadStockCountGroupArticles in
//     inventory-voucher-service.js): filters on voucher_header.voucher_date
//     (via a join), INNER JOINs voucher_line.
// Either of those differences (txn_date vs voucher_date drifting apart, or a
// stock_ledger row with a null/dangling voucher_line_id silently dropped by
// the inner join) would produce exactly the kind of gap being investigated.
// This script surfaces which one (if either) is actually happening, per SKU.
//
// Usage (from backend/):
//   node src/scripts/diagnose-stock-count-vs-report-mismatch.js --branch-id=207 --group-name=EVA --as-on=2026-07-03 --status=PACKED
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

const roundQty3 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 1000) / 1000;

const run = async () => {
  const branchIdArg = getArg("branch-id");
  const branchName = getArg("branch-name");
  const groupName = getArg("group-name");
  const groupIdArg = getArg("group-id");
  const asOn = getArg("as-on");
  const status = String(getArg("status") || "PACKED").toUpperCase();

  if ((!branchIdArg && !branchName) || !asOn || (!groupName && !groupIdArg)) {
    console.error(
      "Usage: node diagnose-stock-count-vs-report-mismatch.js (--branch-id=<id> | --branch-name=<name>) --as-on=YYYY-MM-DD (--group-name=<name> | --group-id=<id>) [--status=PACKED|LOOSE]",
    );
    process.exit(1);
  }

  let branchId = Number(branchIdArg) || null;
  if (!branchId) {
    const branch = await knex("erp.branches")
      .select("id", "name")
      .whereRaw("lower(name) = lower(?)", [branchName])
      .first();
    if (!branch) {
      console.error(`No branch found matching "${branchName}"`);
      process.exit(1);
    }
    branchId = Number(branch.id);
    console.log(`Resolved branch "${branchName}" -> id ${branchId}`);
  }

  let groupId = Number(groupIdArg) || null;
  if (!groupId) {
    const group = await knex("erp.product_groups")
      .select("id", "name")
      .whereRaw("lower(name) = lower(?)", [groupName])
      .first();
    if (!group) {
      console.error(`No product group found matching "${groupName}"`);
      process.exit(1);
    }
    groupId = Number(group.id);
    console.log(`Resolved group "${groupName}" -> id ${groupId}`);
  }

  const isPacked = status !== "LOOSE";
  console.log(
    `Comparing branch=${branchId} group=${groupId} status=${status} as_on=${asOn}\n`,
  );

  // Method A: report-style (txn_date, LEFT JOIN voucher_line)
  const reportRows = await knex("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .join("erp.skus as s", "s.id", "sl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("sl.sku_id", "s.sku_code")
    .select(
      knex.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END), 0) as qty_pairs",
      ),
    )
    .where({
      "sl.branch_id": branchId,
      "sl.stock_state": "ON_HAND",
      "sl.category": "FG",
      "i.group_id": groupId,
    })
    .whereRaw(`${FG_PACKED_FLAG_SQL} = ?`, [isPacked])
    .where("sl.txn_date", "<=", asOn)
    .groupBy("sl.sku_id", "s.sku_code")
    .orderBy("s.sku_code", "asc");

  // Method B: voucher-article-list-style (voucher_date via join, INNER JOIN voucher_line)
  const voucherRows = await knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .join("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .join("erp.skus as s", "s.id", "sl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("sl.sku_id", "s.sku_code")
    .select(
      knex.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END), 0) as qty_pairs",
      ),
    )
    .where({
      "sl.branch_id": branchId,
      "sl.stock_state": "ON_HAND",
      "sl.category": "FG",
      "i.group_id": groupId,
    })
    .whereRaw(`${FG_PACKED_FLAG_SQL} = ?`, [isPacked])
    .where("vh.voucher_date", "<=", asOn)
    .groupBy("sl.sku_id", "s.sku_code")
    .orderBy("s.sku_code", "asc");

  const reportBySku = new Map(
    reportRows.map((r) => [Number(r.sku_id), roundQty3(r.qty_pairs)]),
  );
  const voucherBySku = new Map(
    voucherRows.map((r) => [Number(r.sku_id), roundQty3(r.qty_pairs)]),
  );
  const skuCodeById = new Map(
    [...reportRows, ...voucherRows].map((r) => [Number(r.sku_id), r.sku_code]),
  );

  const allSkuIds = new Set([...reportBySku.keys(), ...voucherBySku.keys()]);
  const reportTotal = roundQty3([...reportBySku.values()].reduce((a, b) => a + b, 0));
  const voucherTotal = roundQty3([...voucherBySku.values()].reduce((a, b) => a + b, 0));

  console.log(`REPORT-style total (txn_date, LEFT JOIN):  ${reportTotal}`);
  console.log(`VOUCHER-style total (voucher_date, INNER JOIN): ${voucherTotal}`);
  console.log(`Difference: ${roundQty3(reportTotal - voucherTotal)}\n`);

  const mismatches = [];
  allSkuIds.forEach((skuId) => {
    const r = reportBySku.get(skuId) || 0;
    const v = voucherBySku.get(skuId) || 0;
    if (Math.abs(r - v) >= 0.005) {
      mismatches.push({ skuId, skuCode: skuCodeById.get(skuId), r, v, delta: roundQty3(r - v) });
    }
  });

  if (!mismatches.length) {
    console.log("No per-SKU mismatches found -- the two totals matched. (Unexpected if you saw a gap; double check branch/group/status/date match exactly what each screen shows.)");
    await knex.destroy();
    return;
  }

  console.log(`${mismatches.length} SKU(s) disagree between the two methods:\n`);
  for (const m of mismatches) {
    console.log(`SKU ${m.skuCode || m.skuId}: report=${m.r} voucher=${m.v} delta=${m.delta}`);

    // For each mismatched SKU, show the raw contributing rows each method sees
    // but the other doesn't, to pinpoint the exact cause.
    const nullLineRows = await knex("erp.stock_ledger as sl")
      .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
      .select("sl.id", "vh.voucher_no", "vh.voucher_type_code", "vh.voucher_date", "sl.txn_date", "sl.voucher_line_id", "sl.direction", "sl.qty_pairs")
      .where({ "sl.branch_id": branchId, "sl.stock_state": "ON_HAND", "sl.category": "FG", "sl.sku_id": m.skuId })
      .whereNull("sl.voucher_line_id")
      .where("vh.voucher_date", "<=", asOn);
    if (nullLineRows.length) {
      console.log(`  -> ${nullLineRows.length} row(s) with NULL voucher_line_id (dropped by voucher's INNER JOIN, counted by report's LEFT JOIN):`);
      nullLineRows.forEach((r) => console.log(`     ${JSON.stringify(r)}`));
    }

    const dateMismatchRows = await knex("erp.stock_ledger as sl")
      .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
      .select("sl.id", "vh.voucher_no", "vh.voucher_type_code", "vh.voucher_date", "sl.txn_date", "sl.direction", "sl.qty_pairs")
      .where({ "sl.branch_id": branchId, "sl.stock_state": "ON_HAND", "sl.category": "FG", "sl.sku_id": m.skuId })
      .whereRaw("sl.txn_date != vh.voucher_date");
    if (dateMismatchRows.length) {
      console.log(`  -> ${dateMismatchRows.length} row(s) where txn_date != voucher_date (would land on different sides of an as-on cutoff):`);
      dateMismatchRows.forEach((r) => console.log(`     ${JSON.stringify(r)}`));
    }

    if (!nullLineRows.length && !dateMismatchRows.length) {
      console.log("  -> neither known cause found for this SKU -- needs a closer look at its full stock_ledger row list.");
    }
  }

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
