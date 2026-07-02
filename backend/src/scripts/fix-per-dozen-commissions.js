// One-off backfill: corrects historical FIXED_PER_UNIT commissions that were stored
// with wrong amounts. Two historical bugs are covered:
//   a) rules with rate_type PER_DOZEN were paid per PAIR (12x overpay)
//   b) qty in pairs was double-converted through the dozen UOM (12x overpay,
//      affected PER_PAIR rules too — see comment in commission-service.js)
//
// Instead of guessing multipliers, each stored breakdown entry is RECOMPUTED from
// source truth: correct = pairs x rate (PER_PAIR) or (pairs / 12) x rate (PER_DOZEN),
// where pairs comes from the voucher line (meta.total_pairs, falling back to qty —
// sales voucher SKU lines store qty in pairs). Entries already storing the correct
// amount are skipped, which also makes re-runs safe.
//
// Fixes, per affected voucher:
//   1. SKU voucher_line meta.commission entries + total_amount (salesman breakdown)
//   2. The auto EMPLOYEE voucher_line (meta.auto_sales_commission) amount/debit/credit
//      — this is the row that drives the employee ledger and balances reports
//   3. erp.commission_ledger rows (BRANCH_SALE / TRANSFER) total_amount + lines_detail
//
// The rule's rate_type is read from erp.employee_commission_rules. Entries whose rule
// has since been DELETED cannot be classified automatically; they are skipped and
// reported unless --assume-deleted-rules=per-dozen or per-pair is passed.
//
// Usage (from backend/):
//   node src/scripts/fix-per-dozen-commissions.js                 # dry run, prints + CSV only
//   node src/scripts/fix-per-dozen-commissions.js --apply         # writes changes in one transaction
//   node src/scripts/fix-per-dozen-commissions.js --assume-deleted-rules=per-dozen
const fs = require("fs");
const path = require("path");
const knex = require("../db/knex");

const PAIRS_PER_DOZEN = 12;
const APPLY = process.argv.includes("--apply");
const DELETED_RULE_MODE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--assume-deleted-rules="));
  const value = arg ? arg.split("=")[1].trim().toLowerCase() : "skip";
  if (!["skip", "per-dozen", "per-pair"].includes(value)) {
    console.error(`Invalid --assume-deleted-rules value: ${value} (use skip | per-dozen | per-pair)`);
    process.exit(1);
  }
  return value;
})();

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// rate_type per rule id for ALL rules that still exist (any status — a disabled
// rule still tells us how its historical entries were meant to be computed).
const loadRuleRateTypes = async () => {
  const rows = await knex("erp.employee_commission_rules as ecr").select(
    "id",
    knex.raw(`upper(COALESCE(NULLIF(to_jsonb(ecr)->>'rate_type', ''), 'PER_PAIR')) as rate_type`),
  );
  return new Map(rows.map((row) => [Number(row.id), String(row.rate_type)]));
};

// Recomputes one entry list in place against the true pair quantity.
// Returns { delta, deletedRuleIds } — delta is (stored - correct), i.e. how much
// the stored total must decrease.
const correctEntries = ({ entries, pairs, ruleRateTypes, deletedRuleHits }) => {
  let delta = 0;
  for (const entry of entries) {
    if (String(entry.basis) !== "FIXED_PER_UNIT") continue;

    const ruleId = Number(entry.rule_id);
    let rateType = ruleRateTypes.get(ruleId);
    if (!rateType) {
      if (DELETED_RULE_MODE === "skip") {
        deletedRuleHits.add(ruleId);
        continue;
      }
      rateType = DELETED_RULE_MODE === "per-dozen" ? "PER_DOZEN" : "PER_PAIR";
    }

    const stored = toNumber(entry.computed_amount, 0);
    if (stored === 0) continue;
    const sign = stored > 0 ? 1 : -1;
    const rate = toNumber(entry.rate, 0);
    const unitQty =
      rateType === "PER_DOZEN"
        ? Number((toNumber(pairs, 0) / PAIRS_PER_DOZEN).toFixed(6))
        : toNumber(pairs, 0);
    const correct = roundMoney(unitQty * rate * sign);
    if (Math.abs(stored - correct) < 0.005) continue;

    entry.computed_amount = correct;
    entry.rate_type = rateType;
    entry.per_dozen_backfill = { old_amount: stored };
    delta = roundMoney(delta + (stored - correct));
  }
  return delta;
};

const loadFixedPerUnitSkuLines = () =>
  knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .select(
      "vl.id",
      "vl.voucher_header_id",
      "vl.line_no",
      "vl.qty",
      "vl.meta",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.status",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
    )
    .where("vl.line_kind", "SKU")
    .whereRaw(
      `EXISTS (
        SELECT 1 FROM jsonb_array_elements(vl.meta->'commission'->'entries') e
        WHERE e->>'basis' = 'FIXED_PER_UNIT'
      )`,
    )
    .orderBy("vl.voucher_header_id", "asc")
    .orderBy("vl.line_no", "asc");

const loadEmployeeCommissionLines = (voucherIds) =>
  knex("erp.voucher_line as vl")
    .join("erp.employees as e", "e.id", "vl.employee_id")
    .select("vl.id", "vl.voucher_header_id", "vl.employee_id", "vl.amount", "vl.meta", "e.name as employee_name")
    .where("vl.line_kind", "EMPLOYEE")
    .whereRaw(`(vl.meta->>'auto_sales_commission')::boolean IS TRUE`)
    .whereIn("vl.voucher_header_id", voucherIds);

const loadFixedPerUnitCommissionLedgerRows = () =>
  knex("erp.commission_ledger as cl")
    .join("erp.voucher_header as vh", "vh.id", "cl.voucher_id")
    .join("erp.employees as e", "e.id", "cl.employee_id")
    .select(
      "cl.id",
      "cl.voucher_id",
      "cl.employee_id",
      "cl.commission_type",
      "cl.total_amount",
      "cl.lines_detail",
      "e.name as employee_name",
      "vh.voucher_no",
      "vh.voucher_type_code",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
    )
    .whereRaw(
      `EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cl.lines_detail) ld,
             jsonb_array_elements(ld->'entries') e
        WHERE e->>'basis' = 'FIXED_PER_UNIT'
      )`,
    )
    .orderBy("cl.voucher_id", "asc");

// Pair quantity for a voucher line: sales voucher SKU lines store qty in pairs;
// meta.total_pairs is authoritative when present.
const resolvePairs = (line) => {
  const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
  const fromMeta = meta.total_pairs;
  return fromMeta != null ? toNumber(fromMeta, 0) : toNumber(line.qty, 0);
};

const run = async () => {
  console.log(`[fix-per-dozen-commissions] mode: ${APPLY ? "APPLY" : "DRY RUN"}, deleted-rule handling: ${DELETED_RULE_MODE}`);

  const ruleRateTypes = await loadRuleRateTypes();
  const [skuLines, ledgerRows] = await Promise.all([
    loadFixedPerUnitSkuLines(),
    loadFixedPerUnitCommissionLedgerRows(),
  ]);

  const auditRows = [];
  const deletedRuleHits = new Set();
  const skuLineUpdates = [];
  const voucherInfoById = new Map();
  const salesmanDeltaByVoucher = new Map();

  // 1) SKU line breakdowns (salesman commission detail).
  for (const row of skuLines) {
    const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
    const commission = meta.commission && typeof meta.commission === "object" ? meta.commission : null;
    const entries = Array.isArray(commission?.entries) ? commission.entries : [];
    if (!entries.length) continue;

    const pairs = resolvePairs(row);
    const oldTotal = toNumber(commission.total_amount, 0);
    const delta = correctEntries({ entries, pairs, ruleRateTypes, deletedRuleHits });
    if (delta === 0) continue;

    commission.total_amount = roundMoney(oldTotal - delta);
    meta.commission = commission;

    skuLineUpdates.push({ id: row.id, meta });
    auditRows.push({
      kind: "SKU_LINE_DETAIL",
      voucher_id: Number(row.voucher_header_id),
      voucher_no: row.voucher_no,
      voucher_type: row.voucher_type_code,
      voucher_date: row.voucher_date,
      voucher_status: row.status,
      employee_id: "",
      employee_name: `line ${row.line_no} (${pairs} pairs)`,
      old_amount: oldTotal,
      new_amount: commission.total_amount,
      delta,
    });
    const voucherId = Number(row.voucher_header_id);
    voucherInfoById.set(voucherId, row);
    salesmanDeltaByVoucher.set(voucherId, roundMoney((salesmanDeltaByVoucher.get(voucherId) || 0) + delta));
  }

  // 2) The auto EMPLOYEE line per voucher — the row the employee ledger/balance reads.
  const employeeLineUpdates = [];
  const voucherIds = [...salesmanDeltaByVoucher.keys()];
  if (voucherIds.length) {
    const employeeLines = await loadEmployeeCommissionLines(voucherIds);
    const employeeLineByVoucher = new Map(employeeLines.map((l) => [Number(l.voucher_header_id), l]));

    for (const [voucherId, delta] of salesmanDeltaByVoucher) {
      const line = employeeLineByVoucher.get(voucherId);
      const info = voucherInfoById.get(voucherId);
      if (!line) {
        console.warn(
          `[fix-per-dozen-commissions] WARNING: voucher ${voucherId} (${info?.voucher_type_code} #${info?.voucher_no}) has corrected SKU entries but no auto EMPLOYEE commission line — ledger delta of ${delta.toFixed(2)} NOT applied. Review manually.`,
        );
        continue;
      }

      const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
      const oldDebit = toNumber(meta.debit, 0);
      const oldCredit = toNumber(meta.credit, 0);
      // Storage convention (sales-voucher-service): positive commission → meta.debit,
      // negative → meta.credit, amount always holds the absolute value.
      const oldNet = oldDebit > 0 ? oldDebit : oldCredit > 0 ? -oldCredit : toNumber(line.amount, 0);
      const newNet = roundMoney(oldNet - delta);
      const newAbs = roundMoney(Math.abs(newNet));

      meta.debit = newNet > 0 ? newAbs : 0;
      meta.credit = newNet < 0 ? newAbs : 0;
      meta.per_dozen_backfill = { old_net: oldNet, delta, corrected_at: new Date().toISOString() };

      employeeLineUpdates.push({ id: line.id, amount: newAbs, rate: newAbs, meta });
      auditRows.push({
        kind: "SALESMAN_COMMISSION",
        voucher_id: voucherId,
        voucher_no: info?.voucher_no || "",
        voucher_type: info?.voucher_type_code || "",
        voucher_date: info?.voucher_date || "",
        voucher_status: info?.status || "",
        employee_id: line.employee_id,
        employee_name: line.employee_name,
        old_amount: oldNet,
        new_amount: newNet,
        delta,
      });
    }
  }

  // 3) commission_ledger rows (BRANCH_SALE / TRANSFER). lines_detail entries reference
  //    the voucher's SKU lines by line_no — fetch those lines to resolve pair qty.
  const ledgerUpdates = [];
  if (ledgerRows.length) {
    const ledgerVoucherIds = [...new Set(ledgerRows.map((r) => Number(r.voucher_id)))];
    const ledgerVoucherLines = await knex("erp.voucher_line")
      .select("voucher_header_id", "line_no", "qty", "meta")
      .where("line_kind", "SKU")
      .whereIn("voucher_header_id", ledgerVoucherIds);
    const pairsByVoucherLine = new Map(
      ledgerVoucherLines.map((l) => [`${Number(l.voucher_header_id)}:${Number(l.line_no)}`, resolvePairs(l)]),
    );

    for (const row of ledgerRows) {
      const linesDetail = Array.isArray(row.lines_detail) ? row.lines_detail : [];
      let rowDelta = 0;
      for (const lineDetail of linesDetail) {
        const entries = Array.isArray(lineDetail?.entries) ? lineDetail.entries : [];
        if (!entries.length) continue;
        const pairs = pairsByVoucherLine.get(`${Number(row.voucher_id)}:${Number(lineDetail.line_no)}`);
        if (pairs == null) {
          console.warn(
            `[fix-per-dozen-commissions] WARNING: commission_ledger ${row.id} references voucher ${row.voucher_id} line ${lineDetail.line_no} which was not found — skipped.`,
          );
          continue;
        }
        const delta = correctEntries({ entries, pairs, ruleRateTypes, deletedRuleHits });
        if (delta === 0) continue;
        lineDetail.total_amount = roundMoney(toNumber(lineDetail.total_amount, 0) - delta);
        rowDelta = roundMoney(rowDelta + delta);
      }
      if (rowDelta === 0) continue;

      const oldTotal = toNumber(row.total_amount, 0);
      const newTotal = roundMoney(oldTotal - rowDelta);
      ledgerUpdates.push({ id: row.id, total_amount: newTotal, lines_detail: linesDetail });
      auditRows.push({
        kind: row.commission_type,
        voucher_id: row.voucher_id,
        voucher_no: row.voucher_no,
        voucher_type: row.voucher_type_code,
        voucher_date: row.voucher_date,
        voucher_status: "",
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        old_amount: oldTotal,
        new_amount: newTotal,
        delta: rowDelta,
      });
    }
  }

  if (deletedRuleHits.size) {
    console.warn(
      `[fix-per-dozen-commissions] WARNING: ${deletedRuleHits.size} rule id(s) referenced by stored entries no longer exist: ${[...deletedRuleHits].join(", ")}.\n` +
        `  Their entries were SKIPPED. Decide whether those rules were per-dozen or per-pair, then re-run with --assume-deleted-rules=per-dozen or --assume-deleted-rules=per-pair.`,
    );
  }

  if (!skuLineUpdates.length && !ledgerUpdates.length) {
    console.log("[fix-per-dozen-commissions] nothing to correct (already fixed or no affected vouchers).");
    return;
  }

  // Audit CSV.
  const csvHeader = "kind,voucher_id,voucher_no,voucher_type,voucher_date,voucher_status,employee_id,employee_name,old_amount,new_amount,delta";
  const csvBody = auditRows
    .map((r) =>
      [
        r.kind,
        r.voucher_id,
        r.voucher_no,
        r.voucher_type,
        r.voucher_date,
        r.voucher_status,
        r.employee_id,
        `"${String(r.employee_name || "").replace(/"/g, '""')}"`,
        r.old_amount.toFixed(2),
        r.new_amount.toFixed(2),
        r.delta.toFixed(2),
      ].join(","),
    )
    .join("\n");
  const csvPath = path.resolve(
    process.cwd(),
    `per-dozen-commission-fix-${new Date().toISOString().replace(/[:.]/g, "-")}${APPLY ? "" : "-dryrun"}.csv`,
  );
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`, "utf8");

  const ledgerDelta = roundMoney(
    auditRows.filter((r) => r.kind !== "SKU_LINE_DETAIL").reduce((sum, r) => sum + r.delta, 0),
  );
  console.log(`[fix-per-dozen-commissions] SKU lines to correct: ${skuLineUpdates.length}`);
  console.log(`[fix-per-dozen-commissions] employee commission lines to adjust: ${employeeLineUpdates.length}`);
  console.log(`[fix-per-dozen-commissions] commission_ledger rows to adjust: ${ledgerUpdates.length}`);
  console.log(`[fix-per-dozen-commissions] total over-credited commission to remove: ${ledgerDelta.toFixed(2)}`);
  console.log(`[fix-per-dozen-commissions] audit CSV: ${csvPath}`);
  for (const r of auditRows.filter((row) => row.kind === "SALESMAN_COMMISSION")) {
    console.log(
      `  ${r.voucher_type} #${r.voucher_no} (${r.voucher_date}) ${r.employee_name}: ${r.old_amount.toFixed(2)} -> ${r.new_amount.toFixed(2)} (delta ${r.delta.toFixed(2)})`,
    );
  }

  if (!APPLY) {
    console.log("[fix-per-dozen-commissions] DRY RUN — no changes written. Re-run with --apply to commit.");
    return;
  }

  await knex.transaction(async (trx) => {
    for (const update of skuLineUpdates) {
      await trx("erp.voucher_line")
        .where({ id: update.id })
        .update({ meta: JSON.stringify(update.meta) });
    }
    for (const update of employeeLineUpdates) {
      await trx("erp.voucher_line")
        .where({ id: update.id })
        .update({ amount: update.amount, rate: update.rate, meta: JSON.stringify(update.meta) });
    }
    for (const update of ledgerUpdates) {
      await trx("erp.commission_ledger")
        .where({ id: update.id })
        .update({ total_amount: update.total_amount, lines_detail: JSON.stringify(update.lines_detail) });
    }
  });

  console.log("[fix-per-dozen-commissions] changes committed.");
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[fix-per-dozen-commissions] failed:", err);
    await knex.destroy();
    process.exit(1);
  });
