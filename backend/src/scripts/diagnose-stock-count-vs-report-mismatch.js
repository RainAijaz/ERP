// Read-only diagnostic: calls the ACTUAL Stock Balances Report function and
// the ACTUAL Stock Count Voucher article-list function directly (not a
// reimplementation of their SQL), for the same branch/group/status/date, and
// compares them SKU by SKU in raw pairs (unit-conversion-proof) plus the
// report's own converted display quantity.
//
// Why this replaced an earlier SQL-reimplementation version of this script:
// that version found zero mismatch between its two hand-written queries, but
// neither queries matched the real totals shown on screen (report=2055,
// voucher=2010) -- meaning the hand-written SQL didn't faithfully reproduce
// what the real report/voucher code do (most likely: unit conversion from
// pairs to the display unit isn't a flat /12 for every SKU -- it goes through
// a UOM conversion graph keyed by each item's own base_uom_id). Calling the
// real functions sidesteps that risk entirely.
//
// Usage (from backend/):
//   node src/scripts/diagnose-stock-count-vs-report-mismatch.js --branch-id=2 --group-id=10 --as-on=2026-07-03 --status=PACKED
const knex = require("../db/knex");
const {
  getInventoryStockBalancesReportPageData,
} = require("../services/inventory/inventory-report-service");
const {
  loadStockCountGroupArticles,
} = require("../services/inventory/inventory-voucher-service");

const getArg = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=").trim() : null;
};

const roundQty3 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 1000) / 1000;

const run = async () => {
  const branchIdArg = getArg("branch-id");
  const branchName = getArg("branch-name");
  const groupIdArg = getArg("group-id");
  const groupName = getArg("group-name");
  const asOn = getArg("as-on");
  const status = String(getArg("status") || "PACKED").toUpperCase();

  if ((!branchIdArg && !branchName) || !asOn || (!groupIdArg && !groupName)) {
    console.error(
      "Usage: node diagnose-stock-count-vs-report-mismatch.js (--branch-id=<id> | --branch-name=<name>) --as-on=YYYY-MM-DD (--group-id=<id> | --group-name=<name>) [--status=PACKED|LOOSE]",
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

  console.log(`Comparing branch=${branchId} group=${groupId} status=${status} as_on=${asOn}\n`);

  const req = {
    user: { isAdmin: true },
    branchId,
    branchOptions: [],
    locale: "en",
  };

  // 1) The real Stock Balances Report, scoped exactly like the UI form.
  const reportResult = await getInventoryStockBalancesReportPageData({
    req,
    input: {
      load_report: "1",
      as_of_date: asOn,
      stock_type: "FINISHED",
      stock_status: status,
      product_group_ids: String(groupId),
      branch_ids: String(branchId),
      order_by: "SKU",
      view_filter: "SUMMARY",
    },
  });
  const reportRows = (reportResult?.reportData?.fgSfgDetailRows || []).filter(
    (r) => Number(r.group_id) === groupId,
  );
  const reportPairTotal = roundQty3(
    reportRows.reduce((sum, r) => sum + Number(r.pairQuantity || 0), 0),
  );
  const reportDisplayTotal = roundQty3(
    reportRows.reduce((sum, r) => sum + Number(r.quantity || 0), 0),
  );

  // 2) The real voucher article-list endpoint (/vouchers/stock-count/articles).
  const voucherResult = await loadStockCountGroupArticles({
    branchId,
    groupId,
    stockType: "FG",
    asOfDate: asOn,
    status,
  });
  const voucherArticles = voucherResult?.articles || [];
  const voucherPairTotal = roundQty3(
    voucherArticles.reduce((sum, a) => sum + Number(a.system_qty_pairs || 0), 0),
  );

  console.log(`REPORT   pairQuantity total: ${reportPairTotal} pairs  (report's own converted display total: ${reportDisplayTotal})`);
  console.log(`VOUCHER  system_qty_pairs total: ${voucherPairTotal} pairs\n`);
  console.log(`Difference in PAIRS (unit-conversion-proof): ${roundQty3(reportPairTotal - voucherPairTotal)}\n`);

  const reportBySku = new Map(reportRows.map((r) => [Number(r.sku_id), r]));
  const voucherBySku = new Map(voucherArticles.map((a) => [Number(a.sku_id), a]));
  const allSkuIds = new Set([...reportBySku.keys(), ...voucherBySku.keys()]);

  const mismatches = [];
  allSkuIds.forEach((skuId) => {
    const r = reportBySku.get(skuId);
    const v = voucherBySku.get(skuId);
    const rPairs = roundQty3(r?.pairQuantity || 0);
    const vPairs = roundQty3(v?.system_qty_pairs || 0);
    if (Math.abs(rPairs - vPairs) >= 0.005) {
      mismatches.push({
        skuId,
        skuCode: r?.sku_code || "",
        inReport: Boolean(r),
        inVoucher: Boolean(v),
        rPairs,
        vPairs,
        delta: roundQty3(rPairs - vPairs),
      });
    }
  });

  if (!mismatches.length) {
    console.log("No per-SKU pair-quantity mismatches -- the two real functions agree exactly.");
  } else {
    console.log(`${mismatches.length} SKU(s) disagree (in PAIRS, unit-conversion-proof):\n`);
    mismatches
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .forEach((m) => {
        console.log(
          `  SKU ${m.skuCode || m.skuId}: report=${m.rPairs} (${m.inReport ? "present" : "MISSING from report"}) voucher=${m.vPairs} (${m.inVoucher ? "present" : "MISSING from voucher"}) delta=${m.delta}`,
        );
      });
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
