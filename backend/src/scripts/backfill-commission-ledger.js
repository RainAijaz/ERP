// CLI front-end for commission recalculation.
//
// Recomputes commission for historical approved vouchers using the commission
// rules effective on each voucher date and writes the result. All the logic lives in
// src/services/hr-payroll/commission-recalc-service.js, which is the same engine
// behind the Recalculate modal on the Sales Commission screen — this script is a
// thin wrapper so the two can never disagree.
//
// Why this is needed: commission is computed once, at voucher time, using
// whatever rules were active then. Backdated rule changes need a controlled
// recompute so stored voucher commission catches up to the effective-date rules.
//
// CAUTION: clearing unmatched commission can remove amounts already recorded
// for payroll. Review the audit CSV before --clear-orphans --apply.
//
// Writes are idempotent: ledger rows upsert on (voucher_id, employee_id,
// commission_type), and sales-voucher rewrites are recomputed from source.
//
// Usage (from backend/):
//   node src/scripts/backfill-commission-ledger.js --commission-types=TRANSFER
//   node src/scripts/backfill-commission-ledger.js --commission-types=TRANSFER,BRANCH_SALE --employee-id=3
//   node src/scripts/backfill-commission-ledger.js --commission-types=SALESMAN_SALE --from-date=2026-06-26 --to-date=2026-07-25
//   node src/scripts/backfill-commission-ledger.js --commission-types=TRANSFER --apply
//   node src/scripts/backfill-commission-ledger.js --commission-types=BRANCH_SALE --clear-orphans --apply
//
// Omitting --commission-types recalculates every computable type.
// Omitting the dates covers all time.
const fs = require("fs");
const path = require("path");
const knex = require("../db/knex");
const {
  COMPUTABLE_TYPES,
  normalizeRecalcInput,
  buildRecalcPlan,
  applyRecalcPlan,
} = require("../services/hr-payroll/commission-recalc-service");

const APPLY = process.argv.includes("--apply");
const CLEAR_ORPHANS = process.argv.includes("--clear-orphans");

const getArg = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=").trim() : null;
};

// --commission-type (singular) kept as an alias for the original interface.
const requestedTypes = getArg("commission-types") || getArg("commission-type") || "";
const invalidTypes = requestedTypes
  .split(",")
  .map((entry) => entry.trim().toUpperCase())
  .filter(Boolean)
  .filter((entry) => !COMPUTABLE_TYPES.includes(entry));
if (invalidTypes.length) {
  console.error(
    `Unknown commission type(s): ${invalidTypes.join(", ")}\nValid values: ${COMPUTABLE_TYPES.join(", ")}`,
  );
  process.exit(1);
}

const employeeIdRaw = getArg("employee-id");
if (employeeIdRaw && !(Number.isInteger(Number(employeeIdRaw)) && Number(employeeIdRaw) > 0)) {
  console.error(`Invalid --employee-id: ${employeeIdRaw}`);
  process.exit(1);
}

const input = normalizeRecalcInput({
  commission_types: requestedTypes || undefined,
  employee_id: employeeIdRaw || undefined,
  // The screen requires an explicit range; the CLI keeps its historical
  // "all time when omitted" behaviour so existing runbooks still work.
  from_date: getArg("from-date") || "1900-01-01",
  to_date: getArg("to-date") || "2999-12-31",
  clear_orphans: CLEAR_ORPHANS,
});

const run = async () => {
  console.log(
    `[commission-recalc] mode: ${APPLY ? "APPLY" : "DRY RUN"}` +
      `, types: ${input.commissionTypes.join(",")}` +
      `, range: ${input.fromDate} .. ${input.toDate}` +
      (input.employeeId ? `, employee_id: ${input.employeeId}` : "") +
      (input.clearOrphans ? ", clear-orphans: ON" : ""),
  );

  const plan = await buildRecalcPlan({ db: knex, input });

  console.log(
    `[commission-recalc] scanned ${plan.counts.scanned_vouchers} approved voucher(s) in range -> ${plan.counts.rows} commission row(s) ` +
      `(new ${plan.counts.new}, changed ${plan.counts.changed}, unchanged ${plan.counts.unchanged}, unmatched ${plan.counts.cleared})`,
  );
  if (plan.counts.scanned_vouchers > 0 && plan.counts.rows === 0) {
    console.log(
      "[commission-recalc] vouchers were found but produced no commission — usually means no active rules exist for these types/employees.",
    );
  }

  if (plan.counts.cleared) {
    console.log(
      `[commission-recalc] ${plan.counts.cleared} row(s) have stored commission that no active rule produces.` +
        (input.clearOrphans
          ? " --clear-orphans is ON: these will be zeroed."
          : " They will NOT be changed. Pass --clear-orphans to zero them."),
    );
  }

  const writes = plan.rows.filter((row) => row.will_write);
  if (!writes.length) {
    console.log("[commission-recalc] nothing to write (already up to date, or no matching vouchers/rules).");
    return;
  }

  const csvHeader =
    "voucher_id,voucher_no,voucher_date,voucher_type,employee_id,employee_name,commission_type,storage,old_amount,new_amount,delta,status";
  const csvBody = writes
    .map((row) =>
      [
        row.voucher_id,
        row.voucher_no,
        row.voucher_date,
        row.voucher_type_code,
        row.employee_id,
        `"${String(row.employee_name || "").replace(/"/g, '""')}"`,
        row.commission_type,
        row.storage,
        row.previous_rate === null ? "" : Number(row.previous_rate).toFixed(2),
        Number(row.new_rate).toFixed(2),
        (Number(row.new_rate) - Number(row.previous_rate || 0)).toFixed(2),
        row.status,
      ].join(","),
    )
    .join("\n");
  const csvPath = path.resolve(
    process.cwd(),
    `commission-recalc-${new Date().toISOString().replace(/[:.]/g, "-")}${APPLY ? "" : "-dryrun"}.csv`,
  );
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`, "utf8");

  console.log(`[commission-recalc] rows to write: ${writes.length}`);
  console.log(
    `[commission-recalc] old total: ${plan.totals.old_total.toFixed(2)}, new total: ${plan.totals.new_total.toFixed(2)}, delta: ${plan.totals.delta.toFixed(2)}`,
  );
  console.log(`[commission-recalc] audit CSV: ${csvPath}`);
  writes.slice(0, 20).forEach((row) => {
    console.log(
      `  #${row.voucher_no} (${row.voucher_date}) ${row.commission_type} employee ${row.employee_id}: ` +
        `${row.previous_rate === null ? "0.00" : Number(row.previous_rate).toFixed(2)} -> ${Number(row.new_rate).toFixed(2)} [${row.status}]`,
    );
  });
  if (writes.length > 20) console.log(`  ... and ${writes.length - 20} more (see CSV)`);

  if (!APPLY) {
    console.log("[commission-recalc] DRY RUN — no changes written. Re-run with --apply to commit.");
    return;
  }

  const provenance = {
    at: new Date().toISOString(),
    source: "backfill-commission-ledger.js",
    from_date: input.fromDate,
    to_date: input.toDate,
  };
  const result = await knex.transaction((trx) =>
    applyRecalcPlan({ trx, rows: plan.rows, provenance }),
  );
  console.log(
    `[commission-recalc] committed — ledger rows: ${result.ledgerRows}, sales vouchers: ${result.salesVouchers} ` +
      `(employee lines inserted ${result.inserted}, updated ${result.updated}; SKU lines ${result.skuLines})`,
  );
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[commission-recalc] failed:", err);
    await knex.destroy();
    process.exit(1);
  });
