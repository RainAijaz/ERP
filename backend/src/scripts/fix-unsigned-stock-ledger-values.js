// Repairs erp.stock_ledger rows whose `value` sign contradicts `direction`.
//
// Why this is needed: erp.stock_ledger.value is documented in the DDL as a
// SIGNED amount (direction * qty * unit_cost) so that SUM(value) over any slice
// of the ledger is a stock valuation. The stock-transfer path
// (stock-transfer-voucher-service.js) wrote the caller's gross POSITIVE amount
// on both legs of a move, so outward rows (direction = -1) were stored positive.
// Consequences, all of which read this column raw:
//   - STN_OUT made a branch transfer ADD inventory value instead of removing it
//   - GRN_IN did the same to the IN_TRANSIT bucket
//   - RDV (returnable dispatch, which shares moveRmStockTx) did the same
//   - the Profit & Loss closing-inventory figure, the Stock Amount report, and
//     WAC recomputation were all inflated by twice the transferred value
//
// The code fix (signedLedgerValue in stock-transfer-voucher-service.js) stops
// this going forward. Existing rows still carry the wrong sign and must be
// corrected, or every historical valuation stays wrong.
//
// Only the LEDGER is repaired. erp.stock_balance_rm / erp.stock_balance_sku are
// maintained by separate arithmetic that already takes Math.abs(value) and
// applies `direction` itself, so live balances were never corrupted by this bug
// and are deliberately left untouched.
//
// Usage (from backend/):
//   node src/scripts/fix-unsigned-stock-ledger-values.js            # dry run
//   node src/scripts/fix-unsigned-stock-ledger-values.js --apply    # write
const knex = require("../db/knex");

const APPLY = process.argv.includes("--apply");

const MISSIGNED_SQL = "(direction = -1 AND value > 0) OR (direction = 1 AND value < 0)";

const main = async () => {
  const rows = await knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .whereRaw(MISSIGNED_SQL)
    .select(
      "vh.voucher_type_code",
      "sl.stock_state",
      "sl.direction",
      "sl.category",
    )
    .count("sl.id as rows")
    .sum("sl.value as value")
    .groupBy("vh.voucher_type_code", "sl.stock_state", "sl.direction", "sl.category")
    .orderBy(["voucher_type_code", "stock_state"]);

  if (!rows.length) {
    console.log("No mis-signed stock_ledger rows found. Nothing to do.");
    return;
  }

  console.log(APPLY ? "REPAIRING mis-signed rows:" : "DRY RUN - mis-signed rows found:");
  console.log("");
  console.log("voucher_type      state             dir  cat  rows  stored_value");
  let totalRows = 0;
  let totalValue = 0;
  rows.forEach((row) => {
    totalRows += Number(row.rows || 0);
    totalValue += Number(row.value || 0);
    console.log(
      `${String(row.voucher_type_code).padEnd(18)}${String(row.stock_state).padEnd(18)}` +
        `${String(row.direction).padStart(3)}  ${String(row.category).padEnd(5)}` +
        `${String(row.rows).padStart(4)}  ${Number(row.value || 0).toFixed(2).padStart(12)}`,
    );
  });
  console.log("");
  console.log(`TOTAL: ${totalRows} rows, ${totalValue.toFixed(2)} of wrongly signed value.`);
  console.log(
    `Valuation impact once corrected: ${(-2 * totalValue).toFixed(2)} ` +
      "(each row swings by twice its stored magnitude).",
  );

  if (!APPLY) {
    console.log("");
    console.log("Dry run only - re-run with --apply to write the correction.");
    return;
  }

  const updated = await knex("erp.stock_ledger")
    .whereRaw(MISSIGNED_SQL)
    .update({ value: knex.raw("-value") });

  console.log("");
  console.log(`Updated ${updated} rows.`);

  const leftover = await knex("erp.stock_ledger")
    .whereRaw(MISSIGNED_SQL)
    .count("id as rows")
    .first();
  console.log(`Remaining mis-signed rows after repair: ${leftover?.rows ?? "?"}`);
};

main()
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await knex.destroy();
  });
