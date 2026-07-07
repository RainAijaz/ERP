// One-off backfill: computes BRANCH_SALE / TRANSFER commission for historical
// approved vouchers using TODAY'S active employee_commission_rules, and writes
// (upserts) the result into erp.commission_ledger.
//
// Why this is needed: BRANCH_SALE/TRANSFER commission is only ever computed and
// written once, at voucher creation/approval time, using whatever rules were
// active then (rules aren't versioned/effective-dated). A rule added after a
// voucher already existed never retroactively applies to it. This script
// recomputes from source data (the voucher's SKU lines) against current rules,
// same math as commission-service.js, so historical vouchers can catch up.
//
// erp.commission_ledger has a unique (voucher_id, employee_id, commission_type)
// constraint with an upsert-merge write, so re-running this script (including
// with --apply more than once) is safe and idempotent.
//
// Usage (from backend/):
//   node src/scripts/backfill-commission-ledger.js --commission-type=TRANSFER                     # dry run, prints + CSV only
//   node src/scripts/backfill-commission-ledger.js --commission-type=TRANSFER --employee-id=3      # scope to one employee
//   node src/scripts/backfill-commission-ledger.js --commission-type=BRANCH_SALE --apply           # writes changes in one transaction
//   node src/scripts/backfill-commission-ledger.js --commission-type=TRANSFER --from-date=2026-01-01 --to-date=2026-06-30
const fs = require("fs");
const path = require("path");
const knex = require("../db/knex");
const {
  computeLedgerEntriesForBranch,
  normalizeTransferLinesForCommission,
} = require("../services/sales/commission-service");

const APPLY = process.argv.includes("--apply");

const VOUCHER_TYPE_BY_COMMISSION_TYPE = {
  TRANSFER: "STN_OUT",
  BRANCH_SALE: "SALES_VOUCHER",
};

const getArg = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=").trim() : null;
};

const commissionType = String(getArg("commission-type") || "").toUpperCase();
if (!VOUCHER_TYPE_BY_COMMISSION_TYPE[commissionType]) {
  console.error(
    `--commission-type is required and must be one of: ${Object.keys(VOUCHER_TYPE_BY_COMMISSION_TYPE).join(", ")}`,
  );
  process.exit(1);
}
const voucherTypeCode = VOUCHER_TYPE_BY_COMMISSION_TYPE[commissionType];

const employeeIdFilter = (() => {
  const raw = getArg("employee-id");
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    console.error(`Invalid --employee-id: ${raw}`);
    process.exit(1);
  }
  return id;
})();

const fromDate = getArg("from-date");
const toDate = getArg("to-date");

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const loadEligibleVouchers = () => {
  let query = knex("erp.voucher_header")
    .select(
      "id",
      "voucher_no",
      "branch_id",
      knex.raw("to_char(voucher_date, 'YYYY-MM-DD') as voucher_date"),
    )
    .where({ voucher_type_code: voucherTypeCode, status: "APPROVED" })
    .orderBy("id", "asc");
  if (fromDate) query = query.andWhere("voucher_date", ">=", fromDate);
  if (toDate) query = query.andWhere("voucher_date", "<=", toDate);
  return query;
};

const loadSkuLines = (voucherId) =>
  knex("erp.voucher_line")
    .select("id", "line_kind", "sku_id", "qty", "uom_id", "meta", "line_no")
    .where({ voucher_header_id: voucherId, line_kind: "SKU" });

const loadExistingLedgerRows = (voucherIds) =>
  knex("erp.commission_ledger")
    .select("voucher_id", "employee_id", "total_amount")
    .where("commission_type", commissionType)
    .whereIn("voucher_id", voucherIds);

const run = async () => {
  console.log(
    `[backfill-commission-ledger] mode: ${APPLY ? "APPLY" : "DRY RUN"}, commission_type: ${commissionType}, voucher_type: ${voucherTypeCode}` +
      (employeeIdFilter ? `, employee_id: ${employeeIdFilter}` : "") +
      (fromDate ? `, from: ${fromDate}` : "") +
      (toDate ? `, to: ${toDate}` : ""),
  );

  const vouchers = await loadEligibleVouchers();
  console.log(`[backfill-commission-ledger] eligible ${voucherTypeCode} vouchers: ${vouchers.length}`);
  if (!vouchers.length) return;

  const existingRows = await loadExistingLedgerRows(vouchers.map((v) => Number(v.id)));
  const existingByKey = new Map(
    existingRows.map((row) => [
      `${Number(row.voucher_id)}:${Number(row.employee_id)}`,
      Number(row.total_amount || 0),
    ]),
  );

  const auditRows = [];
  const writes = [];

  for (const voucher of vouchers) {
    const rawLines = await loadSkuLines(Number(voucher.id));
    if (!rawLines.length) continue;
    const lines =
      commissionType === "TRANSFER"
        ? normalizeTransferLinesForCommission(rawLines)
        : rawLines;

    const entries = await computeLedgerEntriesForBranch({
      trx: knex,
      lines,
      branchId: Number(voucher.branch_id),
      commissionType,
      t: (key) => key,
    });

    const scopedEntries = employeeIdFilter
      ? entries.filter((entry) => Number(entry.employee_id) === employeeIdFilter)
      : entries;

    for (const entry of scopedEntries) {
      const key = `${Number(voucher.id)}:${Number(entry.employee_id)}`;
      const oldAmount = existingByKey.has(key) ? existingByKey.get(key) : null;
      const newAmount = toNumber(entry.total_amount, 0);
      if (oldAmount !== null && Math.abs(oldAmount - newAmount) < 0.005) continue; // already correct

      writes.push({ voucherId: Number(voucher.id), entry });
      auditRows.push({
        voucher_id: voucher.id,
        voucher_no: voucher.voucher_no,
        voucher_date: voucher.voucher_date,
        employee_id: entry.employee_id,
        commission_type: commissionType,
        old_amount: oldAmount === null ? "" : oldAmount.toFixed(2),
        new_amount: newAmount.toFixed(2),
        status: oldAmount === null ? "NEW" : "UPDATED",
      });
    }
  }

  if (!auditRows.length) {
    console.log("[backfill-commission-ledger] nothing to backfill (already up to date, or no matching vouchers/rules).");
    return;
  }

  const csvHeader = "voucher_id,voucher_no,voucher_date,employee_id,commission_type,old_amount,new_amount,status";
  const csvBody = auditRows
    .map((r) =>
      [
        r.voucher_id,
        r.voucher_no,
        r.voucher_date,
        r.employee_id,
        r.commission_type,
        r.old_amount,
        r.new_amount,
        r.status,
      ].join(","),
    )
    .join("\n");
  const csvPath = path.resolve(
    process.cwd(),
    `backfill-commission-ledger-${commissionType.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, "-")}${APPLY ? "" : "-dryrun"}.csv`,
  );
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`, "utf8");

  const totalNew = toNumber(
    auditRows.reduce((sum, r) => sum + Number(r.new_amount || 0), 0),
  );
  console.log(`[backfill-commission-ledger] entries to write: ${auditRows.length} (new: ${auditRows.filter((r) => r.status === "NEW").length}, updated: ${auditRows.filter((r) => r.status === "UPDATED").length})`);
  console.log(`[backfill-commission-ledger] total commission amount: ${totalNew.toFixed(2)}`);
  console.log(`[backfill-commission-ledger] audit CSV: ${csvPath}`);
  auditRows.slice(0, 20).forEach((r) => {
    console.log(
      `  voucher #${r.voucher_no} (${r.voucher_date}) employee ${r.employee_id}: ${r.old_amount || "0.00"} -> ${r.new_amount} [${r.status}]`,
    );
  });
  if (auditRows.length > 20) {
    console.log(`  ... and ${auditRows.length - 20} more (see CSV)`);
  }

  if (!APPLY) {
    console.log("[backfill-commission-ledger] DRY RUN — no changes written. Re-run with --apply to commit.");
    return;
  }

  await knex.transaction(async (trx) => {
    for (const { voucherId, entry } of writes) {
      await trx("erp.commission_ledger")
        .insert({
          voucher_id: voucherId,
          employee_id: entry.employee_id,
          commission_type: entry.commission_type,
          total_amount: entry.total_amount,
          lines_detail: JSON.stringify(entry.lines_detail || []),
        })
        .onConflict(["voucher_id", "employee_id", "commission_type"])
        .merge(["total_amount", "lines_detail"]);
    }
  });

  console.log("[backfill-commission-ledger] changes committed.");
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[backfill-commission-ledger] failed:", err);
    await knex.destroy();
    process.exit(1);
  });
