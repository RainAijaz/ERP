/**
 * Regression tests for stock-transfer (TRANSFER) commission quantity resolution.
 *
 * The bug these guard: an STN-out line stores qty in the ENTERED unit (2 dozen)
 * with the pair count in meta.transfer_qty_pairs (24). The commission math works
 * in pairs. syncStockTransferOutVoucherTx used to load the lines without uom_id,
 * so "2 dozen" was read as "2 pairs", and a PER_DOZEN rule then divided that by
 * 12 again — paying 1/144 of the correct amount (1/12 for PER_PAIR rules).
 *
 * Runs entirely in-memory against a stub knex, so it needs no database.
 *
 *   npm run test:transfer-commission
 */
const {
  computeLedgerEntriesForBranch,
  normalizeTransferLinesForCommission,
  normalizeProductionLinesForCommission,
} = require("../services/sales/commission-service");

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failed += 1;
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};

const eq = (name, actual, expected) =>
  check(
    name,
    Math.abs(Number(actual) - Number(expected)) < 0.005,
    `expected ${expected}, got ${actual}`,
  );

// --- fixtures -------------------------------------------------------------
const PAIR_UOM = 1;
const DOZEN_UOM = 2;
const SKU_ID = 501;
const BRANCH_ID = 7;
const EMPLOYEE_ID = 3;

// Chainable stub that resolves to a canned row set per table. Filters are
// ignored: each table is only queried once per run, for one known purpose.
const makeStubTrx = (dataByTable) => {
  const trx = (tableExpr) => {
    const table = String(tableExpr).split(" as ")[0].trim();
    const builder = {
      then: (resolve, reject) =>
        Promise.resolve(dataByTable[table] || []).then(resolve, reject),
    };
    [
      "select",
      "join",
      "leftJoin",
      "where",
      "whereIn",
      "andWhere",
      "whereRaw",
      "orderBy",
    ].forEach((method) => {
      builder[method] = () => builder;
    });
    return builder;
  };
  trx.raw = (sql) => ({ sql });
  return trx;
};

const buildTrx = (rule) =>
  makeStubTrx({
    "erp.employee_branch": [{ employee_id: EMPLOYEE_ID }],
    "erp.employee_commission_rules": [
      {
        id: 90,
        apply_on: "ALL",
        sku_id: null,
        subgroup_id: null,
        group_id: null,
        commission_basis: "FIXED_PER_UNIT",
        rate_type: "PER_PAIR",
        value: 0,
        reverse_on_returns: true,
        value_type: "FIXED",
        ...rule,
      },
    ],
    "erp.skus": [
      {
        sku_id: SKU_ID,
        item_id: 900,
        subgroup_id: 20,
        group_id: 10,
        base_uom_id: PAIR_UOM,
      },
    ],
    "erp.uom_conversions": [
      { from_uom_id: DOZEN_UOM, to_uom_id: PAIR_UOM, factor: 12 },
      { from_uom_id: PAIR_UOM, to_uom_id: DOZEN_UOM, factor: 0.083333 },
    ],
  });

// An STN-out SKU line as stored by insertVoucherLinesTx: 2 DOZEN = 24 pairs,
// rate/amount are per the entered unit (600/dozen -> 1200).
const transferLine = ({ includeUomId = true, includePairsMeta = true } = {}) => ({
  id: 8801,
  line_no: 1,
  line_kind: "SKU",
  item_id: null,
  sku_id: SKU_ID,
  ...(includeUomId ? { uom_id: DOZEN_UOM } : {}),
  qty: 2,
  rate: 600,
  amount: 1200,
  meta: {
    stock_type: "FG",
    row_status: "PACKED",
    uom_id: DOZEN_UOM,
    uom_factor_to_base: 12,
    ...(includePairsMeta ? { transfer_qty_pairs: 24 } : {}),
    unit_cost_base: 50,
  },
});

const computeTotal = async ({ rule, line }) => {
  const entries = await computeLedgerEntriesForBranch({
    trx: buildTrx(rule),
    lines: normalizeTransferLinesForCommission([line]),
    branchId: BRANCH_ID,
    commissionType: "TRANSFER",
    t: (key) => key,
  });
  return entries;
};

const run = async () => {
  console.log("\ntransfer commission — pair resolution\n");

  // The regression itself: even when the caller forgets uom_id (the exact shape
  // the old syncStockTransferOutVoucherTx select produced), meta.transfer_qty_pairs
  // must carry the pair count. 24 pairs / 12 = 2 dozen x 50 = 100.
  const noUom = await computeTotal({
    rule: { rate_type: "PER_DOZEN", value: 50 },
    line: transferLine({ includeUomId: false }),
  });
  eq("PER_DOZEN, uom_id absent (regression)", noUom[0]?.total_amount, 100);
  check(
    "PER_DOZEN, uom_id absent is not the 1/144 bug value",
    Math.abs(Number(noUom[0]?.total_amount) - 8.33) > 0.005,
    "got the pre-fix amount",
  );

  const withUom = await computeTotal({
    rule: { rate_type: "PER_DOZEN", value: 50 },
    line: transferLine(),
  });
  eq("PER_DOZEN, uom_id present", withUom[0]?.total_amount, 100);

  const perPair = await computeTotal({
    rule: { rate_type: "PER_PAIR", value: 5 },
    line: transferLine(),
  });
  eq("PER_PAIR pays on 24 pairs", perPair[0]?.total_amount, 120);

  // Legacy rows written before transfer_qty_pairs existed still resolve via the
  // UOM conversion fallback, so the fix must not regress them.
  const legacy = await computeTotal({
    rule: { rate_type: "PER_DOZEN", value: 50 },
    line: transferLine({ includePairsMeta: false }),
  });
  eq("PER_DOZEN, legacy line without pairs meta", legacy[0]?.total_amount, 100);

  // Guards the rate/amount columns the backfill select was missing.
  const percent = await computeTotal({
    rule: { commission_basis: "NET_SALES_PERCENT", value: 10, value_type: "PERCENT" },
    line: transferLine(),
  });
  eq("NET_SALES_PERCENT uses line amount", percent[0]?.total_amount, 120);

  // Guards the line_no column the sync select was missing.
  check(
    "ledger lines_detail carries line_no",
    Number(withUom[0]?.lines_detail?.[0]?.line_no) === 1,
    `got ${JSON.stringify(withUom[0]?.lines_detail?.[0]?.line_no)}`,
  );

  console.log("\nproduction commission — pair resolution\n");

  // Production output arrives already in pairs (24 pairs posted to stock, valued
  // 1200), so a PER_DOZEN rule owes 24/12 * 50 = 100 with no UOM step involved.
  const productionLine = {
    sku_id: SKU_ID,
    line_no: 1,
    qty: 24,
    total_pairs: 24,
    amount: 1200,
    category: "SFG",
  };

  const computeProduction = async ({ rule, commissionType, line }) =>
    computeLedgerEntriesForBranch({
      trx: buildTrx(rule),
      lines: normalizeProductionLinesForCommission([line]),
      branchId: BRANCH_ID,
      commissionType,
      t: (key) => key,
    });

  const prodSfg = await computeProduction({
    rule: { rate_type: "PER_DOZEN", value: 50 },
    commissionType: "PRODUCTION_SFG",
    line: productionLine,
  });
  eq("PRODUCTION_SFG PER_DOZEN on 24 pairs", prodSfg[0]?.total_amount, 100);
  check(
    "PRODUCTION_SFG row carries its own commission_type",
    prodSfg[0]?.commission_type === "PRODUCTION_SFG",
    `got ${prodSfg[0]?.commission_type}`,
  );

  const prodFgPerPair = await computeProduction({
    rule: { rate_type: "PER_PAIR", value: 5 },
    commissionType: "PRODUCTION_FG",
    line: { ...productionLine, category: "FG" },
  });
  eq("PRODUCTION_FG PER_PAIR on 24 pairs", prodFgPerPair[0]?.total_amount, 120);

  const prodPercent = await computeProduction({
    rule: { commission_basis: "NET_SALES_PERCENT", value: 10, value_type: "PERCENT" },
    commissionType: "PRODUCTION_FG",
    line: { ...productionLine, category: "FG" },
  });
  eq("PRODUCTION percent uses posted stock value", prodPercent[0]?.total_amount, 120);

  // Production output has no packed/loose concept; the normalizer must force the
  // flag or the shared calculator would skip every line.
  const normalized = normalizeProductionLinesForCommission([productionLine])[0];
  check("normalizer forces is_packed", normalized.meta.is_packed === true, "flag not set");
  eq("normalizer sets total_pairs", normalized.meta.total_pairs, 24);

  console.log("\nrecalculation input normalization\n");

  const { normalizeRecalcInput, COMPUTABLE_TYPES } = require("../services/hr-payroll/commission-recalc-service");

  // PARTY has no calculator anywhere, so it must be dropped rather than offered
  // and silently producing zero rows forever.
  check(
    "PARTY is excluded from the computable types",
    !COMPUTABLE_TYPES.includes("PARTY"),
    "PARTY is selectable",
  );
  eq("five computable types", COMPUTABLE_TYPES.length, 5);

  const filtered = normalizeRecalcInput({
    from_date: "2026-06-26",
    to_date: "2026-07-25",
    commission_types: ["TRANSFER", "PARTY", "NONSENSE"],
  });
  check(
    "unknown and dead types are filtered out",
    JSON.stringify(filtered.commissionTypes) === JSON.stringify(["TRANSFER"]),
    JSON.stringify(filtered.commissionTypes),
  );

  const defaulted = normalizeRecalcInput({ from_date: "2026-01-01", to_date: "2026-01-31" });
  eq("omitting types selects them all", defaulted.commissionTypes.length, 5);

  // Odd cycle boundaries are hand-typed, so a reversed range is corrected rather
  // than rejected.
  const reversed = normalizeRecalcInput({ from_date: "2026-07-25", to_date: "2026-06-26" });
  check(
    "a reversed date range is corrected, not rejected",
    reversed.fromDate === "2026-06-26" && reversed.toDate === "2026-07-25" && reversed.dateRangeCorrected,
    `${reversed.fromDate}..${reversed.toDate}`,
  );

  const noDates = normalizeRecalcInput({ commission_types: "TRANSFER" });
  check(
    "missing dates are reported rather than defaulted",
    noDates.fromDate === null && noDates.toDate === null,
    `${noDates.fromDate}..${noDates.toDate}`,
  );

  check(
    "clear_orphans defaults off",
    normalizeRecalcInput({ from_date: "2026-01-01", to_date: "2026-01-02" }).clearOrphans === false,
    "defaulted to destructive",
  );
  check(
    "clear_orphans accepts a checkbox value",
    normalizeRecalcInput({ from_date: "2026-01-01", to_date: "2026-01-02", clear_orphans: "on" }).clearOrphans === true,
    "checkbox not honoured",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failures: ${failures.join(", ")}`);
    process.exit(1);
  }
};

run().catch((err) => {
  console.error("test run failed:", err);
  process.exit(1);
});
