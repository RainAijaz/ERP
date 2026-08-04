/**
 * Exercises the COMMISSION_RECALC approval path end to end — the path an admin
 * never reaches, because handleScreenApproval lets admins write directly.
 *
 *   npm run test:commission-recalc:approval
 *
 * Covered: a real approval_request insert (which proves the entity_type FK), the
 * applyMasterDataChange -> inferHrTarget -> commission_recalc dispatch, the writes
 * and their provenance stamp, refusal of rows whose recomputed amount no longer
 * matches what was approved, and the preview partial actually rendering with a
 * [data-field] element — without one the approvals modal dumps the raw payload as
 * <pre> underneath the table.
 *
 * All database work is inside one transaction that is always rolled back.
 */
const path = require("path");
const ejs = require("ejs");
const knex = require("../db/knex");
const svc = require("../services/hr-payroll/commission-recalc-service");
const { applyMasterDataChange } = require("../utils/approval-applier");
require("../routes/hr-payroll/commissions"); // registers the preview provider
const { resolveApprovalPreview } = require("../utils/approval-preview-registry");

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const TEST_SUMMARY = "Recalculate Commission - approval path test";
const ROLLBACK = Symbol("rollback");

const run = async () => {
  let captured = null;

  try {
    await knex.transaction(async (trx) => {
      const target = await trx("erp.voucher_header as vh")
        .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
        .select("vh.id", trx.raw("vh.voucher_date::text as d"), "sh.salesman_employee_id")
        .where({ "vh.voucher_type_code": "SALES_VOUCHER", "vh.status": "APPROVED" })
        .whereNotNull("sh.salesman_employee_id")
        .orderBy("vh.id", "asc")
        .first();

      if (!target) {
        console.log("  SKIP  no approved sales voucher with a salesman in this DB");
        throw ROLLBACK;
      }

      const input = svc.normalizeRecalcInput({
        commission_types: "SALESMAN_SALE",
        from_date: target.d,
        to_date: target.d,
        employee_id: target.salesman_employee_id,
      });
      const plan = await svc.buildRecalcPlan({ db: trx, input });
      const writes = plan.rows.filter((row) => row.will_write);
      check("plan produced writable rows to approve", writes.length > 0, "none");
      if (!writes.length) throw ROLLBACK;

      const employeeNames = {};
      writes.forEach((row) => {
        employeeNames[row.employee_id] = row.employee_name;
      });
      const newValue = {
        mode: "COMMISSION_RECALC",
        // queueApproval always injects these two; included so the test exercises
        // the same shape the real queue produces.
        _scope_key: "hr_payroll.commissions",
        _approval_action: "edit",
        from_date: input.fromDate,
        to_date: input.toDate,
        commission_types: input.commissionTypes,
        employee_id: input.employeeId,
        clear_orphans: false,
        employee_names: employeeNames,
        totals: plan.totals,
        counts: plan.counts,
        rows: writes.map((row) => ({
          v: row.voucher_id,
          n: row.voucher_no,
          d: row.voucher_date,
          e: row.employee_id,
          t: row.commission_type,
          o: row.previous_rate,
          w: row.new_rate,
          s: row.status,
        })),
      };

      const requester = await trx("erp.users").select("id").orderBy("id").first();
      const branch = await trx("erp.branches").select("id").orderBy("id").first();
      const [reqRow] = await trx("erp.approval_request")
        .insert({
          branch_id: branch.id,
          request_type: "MASTER_DATA_CHANGE",
          entity_type: "EMPLOYEE",
          entity_id: String(target.salesman_employee_id),
          summary: TEST_SUMMARY,
          old_value: null,
          new_value: JSON.stringify(newValue),
          status: "PENDING",
          requested_by: requester.id,
        })
        .returning(["id", "entity_type", "entity_id", "new_value", "summary"]);
      check("approval_request row inserted (entity_type FK ok)", Boolean(reqRow?.id), "insert failed");

      const request = {
        id: reqRow.id,
        entity_type: reqRow.entity_type,
        entity_id: reqRow.entity_id,
        summary: reqRow.summary,
        new_value:
          typeof reqRow.new_value === "string" ? JSON.parse(reqRow.new_value) : reqRow.new_value,
        old_value: null,
      };

      const result = await applyMasterDataChange(trx, request, requester.id);
      check(
        "applier returned truthy (a falsy return rolls back the whole decision)",
        Boolean(result),
        JSON.stringify(result),
      );
      check("applier reports applied", result?.applied === true, JSON.stringify(result));
      check(
        "applier wrote every approved row",
        Number(result?.written) === writes.length,
        `${result?.written} vs ${writes.length}`,
      );
      check("nothing skipped on an unchanged plan", Number(result?.skipped) === 0, `skipped ${result?.skipped}`);

      const lines = await trx("erp.voucher_line")
        .select("amount", "meta")
        .where({ voucher_header_id: writes[0].voucher_id, line_kind: "EMPLOYEE" });
      const auto = lines.filter((line) => line.meta?.auto_sales_commission === true);
      check("employee commission line written by the approval", auto.length === 1, `got ${auto.length}`);
      check(
        "provenance stamped for auditability",
        Boolean(auto[0]?.meta?.commission_recalc?.approval_request_id),
        JSON.stringify(auto[0]?.meta?.commission_recalc),
      );

      // Drift guard: the approver authorised specific numbers. If the recompute no
      // longer produces them, the row must be refused rather than silently written.
      const tampered = {
        ...request,
        new_value: {
          ...newValue,
          rows: newValue.rows.map((row) => ({ ...row, w: Number(row.w) + 999 })),
        },
      };
      const tamperResult = await applyMasterDataChange(trx, tampered, requester.id);
      check(
        "rows whose recomputed amount no longer matches are refused",
        tamperResult === false,
        JSON.stringify(tamperResult),
      );

      captured = { request, newValue };
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  if (captured) {
    // Render the preview exactly as the approvals modal would.
    const res = {
      locals: {
        t: (key) => key,
        formatNumberDisplay: (value) => Number(value || 0).toFixed(2),
      },
    };
    const payload = await resolveApprovalPreview({
      req: { locale: "en" },
      res,
      request: captured.request,
      side: "new",
    });
    check(
      "preview provider claimed the request",
      payload?.previewType === "commission-recalc",
      String(payload?.previewType),
    );

    const partial = path.resolve(
      __dirname,
      "../views/administration/approvals/commission-recalc-preview.ejs",
    );
    const html = await ejs.renderFile(
      partial,
      {
        modalValues: payload.previewValues,
        t: res.locals.t,
        formatNumberDisplay: res.locals.formatNumberDisplay,
      },
      { filename: partial },
    );
    check("preview partial renders", html.length > 200, `only ${html.length} chars`);
    check(
      "preview contains a [data-field] element (no raw-JSON fallback)",
      /data-field=/.test(html),
      "modal would dump the raw payload",
    );
    check(
      "preview shows the today's-rates warning",
      html.includes("commission_recalc_today_rates_warning"),
      "warning missing",
    );
    check(
      "preview lists every approved row",
      (html.match(/<tr class="border-b border-slate-100">/g) || []).length ===
        captured.newValue.rows.length,
      "row count mismatch",
    );
  }

  const leaked = await knex("erp.approval_request").where({ summary: TEST_SUMMARY }).count("* as n").first();
  check("no approval_request leaked", Number(leaked.n) === 0, `found ${leaked.n}`);

  console.log(`\n${failed ? "FAILED" : "OK"} — ${failed} failure(s)`);
  await knex.destroy();
  process.exit(failed ? 1 : 0);
};

run().catch(async (err) => {
  console.error("test run failed:", err?.message || err);
  await knex.destroy();
  process.exit(1);
});
