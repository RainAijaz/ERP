/**
 * Integration tests for commission recalculation, against the real database.
 *
 * Everything runs inside ONE transaction that is always rolled back, so no
 * fixture or rule change survives the run.
 *
 * The most important assertion here is that recalculating commission leaves
 * erp.gl_entry byte-identical. Sales GL is built from sales_header plus a sum of
 * SKU line amounts only, so commission is off-ledger — this proves it rather
 * than trusting the reading.
 *
 *   npm run test:commission-recalc:db
 */
const knex = require("../db/knex");
const svc = require("../services/hr-payroll/commission-recalc-service");

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

const eq = (name, actual, expected, tolerance = 0.005) =>
  check(
    name,
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );

const ROLLBACK = Symbol("rollback");

const snapshotGl = (trx, voucherId) =>
  trx("erp.gl_entry as ge")
    .join("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .select("ge.id", "ge.account_id", "ge.dr", "ge.cr", "ge.entry_date")
    .where("gb.source_voucher_id", voucherId)
    .orderBy("ge.id", "asc");

const snapshotSkuLines = (trx, voucherId) =>
  trx("erp.voucher_line")
    .select("id", "line_no", "qty", "rate", "amount")
    .where({ voucher_header_id: voucherId, line_kind: "SKU" })
    .orderBy("line_no", "asc");

const employeeLines = (trx, voucherId) =>
  trx("erp.voucher_line")
    .select("id", "line_no", "amount", "rate", "meta")
    .where({ voucher_header_id: voucherId, line_kind: "EMPLOYEE" })
    .orderBy("line_no", "asc");

const planFor = (trx, payload) =>
  svc.buildRecalcPlan({ db: trx, input: svc.normalizeRecalcInput(payload) });

const run = async () => {
  try {
    await knex.transaction(async (trx) => {
      // A real approved sales voucher with real GL entries and a salesman.
      const target = await trx("erp.voucher_header as vh")
        .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
        .join("erp.gl_batch as gb", "gb.source_voucher_id", "vh.id")
        .select(
          "vh.id",
          "vh.voucher_no",
          trx.raw("vh.voucher_date::text as voucher_date"),
          "sh.salesman_employee_id",
        )
        .where({ "vh.voucher_type_code": "SALES_VOUCHER", "vh.status": "APPROVED" })
        .whereNotNull("sh.salesman_employee_id")
        .orderBy("vh.id", "asc")
        .first();

      if (!target) {
        console.log("  SKIP  no approved sales voucher with GL + salesman in this DB");
        throw ROLLBACK;
      }
      const voucherId = Number(target.id);
      const employeeId = Number(target.salesman_employee_id);
      const day = target.voucher_date;
      console.log(
        `\n  target: voucher id ${voucherId} (#${target.voucher_no}, ${day}), salesman ${employeeId}\n`,
      );

      const glBefore = await snapshotGl(trx, voucherId);
      const skuBefore = await snapshotSkuLines(trx, voucherId);

      // --- date range is inclusive on both ends --------------------------------
      const sameDay = await planFor(trx, {
        commission_types: "SALESMAN_SALE",
        from_date: day,
        to_date: day,
        employee_id: employeeId,
      });
      check(
        "voucher dated exactly on both range bounds is included",
        sameDay.rows.some((row) => row.voucher_id === voucherId),
        "not found in a from=to=voucher_date plan",
      );

      const dayAfter = new Date(`${day}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      const afterPlan = await planFor(trx, {
        commission_types: "SALESMAN_SALE",
        from_date: dayAfter.toISOString().slice(0, 10),
        to_date: "2999-12-31",
        employee_id: employeeId,
      });
      check(
        "voucher before from_date is excluded",
        !afterPlan.rows.some((row) => row.voucher_id === voucherId),
        "leaked into an out-of-range plan",
      );

      const baseRow = sameDay.rows.find((row) => row.voucher_id === voucherId);
      check("target voucher produced a plan row", Boolean(baseRow), "no row");
      if (!baseRow) throw ROLLBACK;
      const baseAmount = Number(baseRow.new_rate);

      // --- apply #1: inserts the auto EMPLOYEE line ---------------------------
      await svc.applyRecalcPlan({ trx, rows: sameDay.rows });

      const afterFirst = await employeeLines(trx, voucherId);
      const autoLines = afterFirst.filter((line) => line.meta?.auto_sales_commission === true);
      check("exactly one auto commission line exists", autoLines.length === 1, `got ${autoLines.length}`);
      eq("employee line carries the recomputed amount", autoLines[0]?.amount, baseAmount);
      const lineIdAfterInsert = Number(autoLines[0]?.id);

      const skuWithCommission = await trx("erp.voucher_line")
        .select("id", "meta")
        .where({ voucher_header_id: voucherId, line_kind: "SKU" });
      check(
        "SKU lines carry a commission breakdown",
        skuWithCommission.some((line) => line.meta?.commission?.total_amount != null),
        "no meta.commission written",
      );

      // --- the load-bearing assertions ---------------------------------------
      const skuAfter = await snapshotSkuLines(trx, voucherId);
      check(
        "SKU line qty/rate/amount are untouched",
        JSON.stringify(skuBefore) === JSON.stringify(skuAfter),
        "a SKU money column moved",
      );

      const glAfter = await snapshotGl(trx, voucherId);
      check(
        "GL entries are byte-identical after recalculation",
        JSON.stringify(glBefore) === JSON.stringify(glAfter),
        `before ${JSON.stringify(glBefore)} / after ${JSON.stringify(glAfter)}`,
      );

      // --- idempotence --------------------------------------------------------
      const replan = await planFor(trx, {
        commission_types: "SALESMAN_SALE",
        from_date: day,
        to_date: day,
        employee_id: employeeId,
      });
      const replanRow = replan.rows.find((row) => row.voucher_id === voucherId);
      check(
        "re-planning the same range reports unchanged",
        replanRow?.status === "unchanged" && replanRow?.will_write === false,
        `status=${replanRow?.status} will_write=${replanRow?.will_write}`,
      );

      // --- rate change flows through, updating in place -----------------------
      await trx("erp.employee_commission_rules")
        .where({ employee_id: employeeId, commission_type: "SALESMAN_SALE", status: "active" })
        .update({ value: trx.raw("value * 2") });

      const doubled = await planFor(trx, {
        commission_types: "SALESMAN_SALE",
        from_date: day,
        to_date: day,
        employee_id: employeeId,
      });
      const doubledRow = doubled.rows.find((row) => row.voucher_id === voucherId);
      check("doubling the rate reports a change", doubledRow?.status === "changed", `got ${doubledRow?.status}`);
      eq("doubled rate doubles the commission", doubledRow?.new_rate, baseAmount * 2);

      await svc.applyRecalcPlan({ trx, rows: doubled.rows });
      const afterSecond = (await employeeLines(trx, voucherId)).filter(
        (line) => line.meta?.auto_sales_commission === true,
      );
      check("still exactly one auto commission line", afterSecond.length === 1, `got ${afterSecond.length}`);
      check(
        "employee line was updated in place, not replaced",
        Number(afterSecond[0]?.id) === lineIdAfterInsert,
        `line id ${lineIdAfterInsert} -> ${afterSecond[0]?.id}`,
      );
      eq("employee line reflects the new rate", afterSecond[0]?.amount, baseAmount * 2);

      const glAfterChange = await snapshotGl(trx, voucherId);
      check(
        "GL still identical after a rate change + rewrite",
        JSON.stringify(glBefore) === JSON.stringify(glAfterChange),
        "GL moved",
      );

      // --- orphan gating ------------------------------------------------------
      await trx("erp.employee_commission_rules")
        .where({ employee_id: employeeId, commission_type: "SALESMAN_SALE" })
        .update({ status: "inactive" });

      const orphanPlan = await planFor(trx, {
        commission_types: "SALESMAN_SALE",
        from_date: day,
        to_date: day,
        employee_id: employeeId,
      });
      const orphanRow = orphanPlan.rows.find((row) => row.voucher_id === voucherId);
      check(
        "commission with no matching rule is reported as unmatched",
        orphanRow?.status === "cleared",
        `got ${orphanRow?.status}`,
      );
      check(
        "unmatched rows do NOT write by default",
        orphanRow?.will_write === false,
        "would have zeroed stored commission without opt-in",
      );

      const optIn = await planFor(trx, {
        commission_types: "SALESMAN_SALE",
        from_date: day,
        to_date: day,
        employee_id: employeeId,
        clear_orphans: true,
      });
      const optInRow = optIn.rows.find((row) => row.voucher_id === voucherId);
      check("clear_orphans opts the unmatched row in", optInRow?.will_write === true, "still skipped");

      await svc.applyRecalcPlan({ trx, rows: optIn.rows });
      const cleared = (await employeeLines(trx, voucherId)).filter(
        (line) => line.meta?.auto_sales_commission === true,
      );
      eq("cleared line zeroes amount", cleared[0]?.amount, 0);
      eq("cleared line zeroes meta.debit", cleared[0]?.meta?.debit, 0);
      eq("cleared line zeroes meta.credit", cleared[0]?.meta?.credit, 0);

      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(`failures: ${failures.join(", ")}`);
  await knex.destroy();
  process.exit(failed ? 1 : 0);
};

run().catch(async (err) => {
  console.error("test run failed:", err);
  await knex.destroy();
  process.exit(1);
});
