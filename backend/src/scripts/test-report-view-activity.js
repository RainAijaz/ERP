// Tests for the two Activity Log additions:
//
//   1. Report views/loads are recorded for every user. The risky part is not
//      the insert -- it is deciding WHICH requests count as a report view.
//      Over-matching would log write endpoints that merely live under a report
//      path (`/reports/financial/voucher_register/bank-line-status`) as if
//      someone had read a report.
//   2. Editing an approval request that is already PENDING is distinguishable
//      from the original submission. Both write to the same voucher/entity, so
//      without the source tag the two rows read identically.
//
// DB writes happen inside a transaction that always rolls back.
//
//   node src/scripts/test-report-view-activity.js

const assert = require("assert");

const knex = require("../db/knex");
const reportViewLog = require("../middleware/audit/report-view-log");
const {
  presentActivityRows,
} = require("../services/administration/activity-log-presenter");
const {
  buildActivityAccessScope,
} = require("../services/administration/activity-access-service");
const { insertActivityLog } = require("../utils/audit-log");
const {
  logPendingApprovalEditTx,
  logVoucherApprovalWriteTx,
} = require("../utils/approval-activity-log");

const { resolveReportScope, collectFilters, markReportView } = reportViewLog;

const results = [];

const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
};

const inRollback = async (fn) => {
  let caught = null;
  try {
    await knex.transaction(async (trx) => {
      try {
        await fn(trx);
      } catch (error) {
        caught = error;
      }
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!/__rollback__/.test(String(error?.message || ""))) throw error;
  }
  if (caught) throw caught;
};

// Identity translator: assertions then read the raw key, which keeps them
// independent of the wording in locale.js.
const rawT = (key) => key;

const fakeReq = ({ method = "GET", url, requiredPermission = null, query = {}, body = {} }) => ({
  method,
  originalUrl: url,
  path: String(url).split("?")[0],
  requiredPermission,
  query,
  body,
});

const run = async () => {
  console.log("\nReport view detection");

  await check("route guarded by requirePermission('REPORT', ...) is a view", async () => {
    const scope = resolveReportScope(
      fakeReq({
        url: "/reports/inventory/stock-amount",
        requiredPermission: {
          scopeType: "REPORT",
          scopeKey: "stock_amount",
          action: "load",
        },
      }),
    );
    assert.strictEqual(scope?.scopeKey, "stock_amount");
    assert.strictEqual(scope?.labelKey, "stock_amount_report");
  });

  await check("report with no route guard is matched by its nav path", async () => {
    // Financial reports check permissions inside the handler, so the only
    // signal is the path.
    const scope = resolveReportScope(
      fakeReq({ url: "/reports/financial/cash_book?start_date=2026-07-01" }),
    );
    assert.strictEqual(scope?.scopeKey, "cash_book");
  });

  await check("a route may declare its report explicitly", async () => {
    // Financial serves 15 report keys off one `/:reportKey` route; six of them
    // (bank_transactions, cash_voucher_register, journal_voucher_register and
    // the legacy expense aliases) are not nav entries, so neither automatic
    // signal can see them.
    const req = fakeReq({ url: "/reports/financial/bank_transactions" });
    assert.strictEqual(
      resolveReportScope(req),
      null,
      "not resolvable before the route declares it",
    );
    markReportView(req, "bank_transactions");
    assert.strictEqual(resolveReportScope(req)?.scopeKey, "bank_transactions");
  });

  await check("an empty declaration is ignored", async () => {
    const req = fakeReq({ url: "/reports/financial/bank_transactions" });
    markReportView(req, "");
    assert.strictEqual(resolveReportScope(req), null);
  });

  await check("a write endpoint under a report path is NOT a view", async () => {
    const scope = resolveReportScope(
      fakeReq({
        method: "POST",
        url: "/reports/financial/voucher_register/bank-line-status",
      }),
    );
    assert.strictEqual(scope, null);
  });

  await check("a non-report screen is NOT a view", async () => {
    const scope = resolveReportScope(
      fakeReq({
        url: "/master-data/bom",
        requiredPermission: {
          scopeType: "SCREEN",
          scopeKey: "master_data.bom",
          action: "navigate",
        },
      }),
    );
    assert.strictEqual(scope, null);
  });

  await check("longest matching report route wins", async () => {
    // /reports/purchases is itself a report, and a prefix of the others.
    const nested = resolveReportScope(
      fakeReq({ url: "/reports/purchases/supplier-ledger" }),
    );
    assert.strictEqual(nested?.scopeKey, "supplier_ledger");
    const base = resolveReportScope(fakeReq({ url: "/reports/purchases" }));
    assert.strictEqual(base?.scopeKey, "purchase_report");
  });

  await check("filters are captured, request plumbing is not", async () => {
    const filters = collectFilters(
      fakeReq({
        method: "POST",
        url: "/reports/inventory/stock-amount",
        body: {
          _csrf: "should-not-be-logged",
          page: "2",
          start_date: "2026-07-01",
          branch_id: "",
          category: "FG",
        },
      }),
    );
    assert.deepStrictEqual(filters, { start_date: "2026-07-01", category: "FG" });
  });

  console.log("\nReport view rendering");

  await check("a REPORT row renders as a named report, not a scope key", async () => {
    const [row] = presentActivityRows({
      rows: [
        {
          id: 1,
          created_at: new Date(),
          entity_type: "REPORT",
          entity_id: "stock_amount",
          voucher_type_code: null,
          action: "VIEW",
          user_name: "hoorain",
          context_json: {
            source: "report-view",
            scope_type: "REPORT",
            scope_key: "stock_amount",
            report_label_key: "stock_amount_report",
            access_mode: "load",
            filters: { start_date: "2026-07-01" },
          },
        },
      ],
      t: rawT,
    });
    assert.strictEqual(row.display_action, "loaded");
    // rawT leaves the key untranslated, so the presenter's humanising fallback
    // kicks in -- the same path a report whose label key lost its translation
    // would take. With the real translator this reads "Stock Amount".
    assert.strictEqual(row.entity_label, "Stock Amount Report");
    // No record id exists for a report view; the entity column carries the name.
    assert.strictEqual(row.entity_id_label, "-");
    assert.ok(
      row.summary.includes("Stock Amount Report"),
      `summary should name the report, got: ${row.summary}`,
    );
    const filterSection = row.details_model.sections.find(
      (section) => section.title === "report_filters",
    );
    assert.ok(filterSection, "details should include a report filters section");
    assert.ok(
      filterSection.rows.some((r) => r.value === "2026-07-01"),
      "filters used should be visible in the details pane",
    );
  });

  await check("opening a report reads differently from running it", async () => {
    const [opened] = presentActivityRows({
      rows: [
        {
          id: 2,
          created_at: new Date(),
          entity_type: "REPORT",
          entity_id: "cash_book",
          action: "VIEW",
          context_json: { scope_type: "REPORT", scope_key: "cash_book", access_mode: "open" },
        },
      ],
      t: rawT,
    });
    assert.strictEqual(opened.display_action, "viewed");
  });

  console.log("\nPending approval edits");

  await check("editing a queued request is not labelled a plain update", async () => {
    const [row] = presentActivityRows({
      rows: [
        {
          id: 3,
          created_at: new Date(),
          entity_type: "BOM",
          entity_id: "42",
          action: "UPDATE",
          context_json: {
            source: "pending-approval-edit",
            approval_request_id: 77,
            request_status: "PENDING",
            summary: "BOM #42",
            original_requested_by: 5,
            edited_by: 1,
          },
        },
      ],
      t: rawT,
    });
    assert.strictEqual(row.display_action, "pending_approval_updated");
    assert.ok(
      row.summary.includes("#77"),
      `summary should name the approval request, got: ${row.summary}`,
    );
  });

  await check("a re-submitted voucher does not read like the first submission", async () => {
    const rows = [null, { id: 9, requested_by: 5 }].map((existingPending, idx) => ({
      id: 10 + idx,
      created_at: new Date(),
      entity_type: "VOUCHER",
      entity_id: "500",
      voucher_type_code: "STOCK_COUNT_ADJ",
      action: existingPending ? "UPDATE" : "SUBMIT",
      context_json: {
        source: existingPending ? "pending-approval-edit" : "inventory-voucher-service",
        approval_request_id: 9,
        summary: "STOCK_COUNT_ADJ #12",
        refreshed_existing_request: Boolean(existingPending),
      },
    }));
    const [first, refreshed] = presentActivityRows({ rows, t: rawT });
    assert.strictEqual(first.display_action, "submitted_for_approval");
    assert.strictEqual(refreshed.display_action, "pending_approval_updated");
    assert.notStrictEqual(
      first.summary,
      refreshed.summary,
      "the two events must not render identically",
    );
  });

  console.log("\nDatabase writes");

  const branch = await knex("erp.branches").select("id").orderBy("id").first();
  const user = await knex("erp.users").select("id").orderBy("id").first();

  await check("a report view persists with the REPORT/VIEW registry codes", async () => {
    assert.ok(branch && user, "needs at least one branch and one user");
    await inRollback(async (trx) => {
      await insertActivityLog(trx, {
        branch_id: branch.id,
        user_id: user.id,
        entity_type: "REPORT",
        entity_id: "stock_amount",
        action: "VIEW",
        context: { source: "report-view", scope_key: "stock_amount" },
      });
      const saved = await trx("erp.activity_log")
        .where({ entity_type: "REPORT", action: "VIEW", entity_id: "stock_amount" })
        .orderBy("id", "desc")
        .first();
      assert.ok(saved, "row should be readable inside the transaction");
      assert.strictEqual(saved.user_id, user.id);
    });
  });

  await check("logVoucherApprovalWriteTx: refresh writes UPDATE, first write SUBMIT", async () => {
    await inRollback(async (trx) => {
      const req = { user: { id: user.id }, branchId: branch.id, ip: "127.0.0.1" };
      await logVoucherApprovalWriteTx({
        trx,
        req,
        voucherId: 987654,
        voucherTypeCode: "STOCK_COUNT_ADJ",
        summary: "STOCK_COUNT_ADJ #1",
        approvalRequestId: 1,
        existingPending: null,
        source: "inventory-voucher-service",
      });
      await logVoucherApprovalWriteTx({
        trx,
        req,
        voucherId: 987654,
        voucherTypeCode: "STOCK_COUNT_ADJ",
        summary: "STOCK_COUNT_ADJ #1",
        approvalRequestId: 1,
        existingPending: { id: 1, requested_by: 4242 },
        source: "inventory-voucher-service",
      });

      const rows = await trx("erp.activity_log")
        .where({ entity_type: "VOUCHER", entity_id: "987654" })
        .orderBy("id", "asc");
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].action, "SUBMIT");
      assert.strictEqual(rows[1].action, "UPDATE");
      assert.strictEqual(rows[1].context_json.source, "pending-approval-edit");
      // The maker is preserved on a refresh, so the log is the only place the
      // editor's identity survives.
      assert.strictEqual(rows[1].context_json.original_requested_by, 4242);
      assert.strictEqual(rows[1].context_json.edited_by, user.id);
    });
  });

  await check("logPendingApprovalEditTx records the editor and the diff", async () => {
    await inRollback(async (trx) => {
      await logPendingApprovalEditTx({
        db: trx,
        req: { user: { id: user.id }, branchId: branch.id, ip: "127.0.0.1" },
        request: {
          id: 555,
          branch_id: branch.id,
          entity_type: "BOM",
          entity_id: "987655",
          request_type: "BOM",
          status: "PENDING",
          summary: "BOM #987655",
          requested_by: 4242,
          new_value: { output_qty: 10 },
        },
        changedFields: [{ field: "output_qty", old_value: 10, new_value: 12 }],
        newValue: { output_qty: 12 },
      });
      const saved = await trx("erp.activity_log")
        .where({ entity_type: "BOM", entity_id: "987655" })
        .orderBy("id", "desc")
        .first();
      assert.strictEqual(saved.action, "UPDATE");
      assert.strictEqual(saved.context_json.approval_request_id, 555);
      assert.strictEqual(saved.context_json.original_requested_by, 4242);
      assert.strictEqual(saved.context_json.edited_by, user.id);
      assert.strictEqual(saved.context_json.changed_fields[0].new_value, 12);
    });
  });

  console.log("\nNon-admin visibility");

  await check("REPORT joins the entity-type filter only with report access", async () => {
    const withReports = buildActivityAccessScope({
      can: (scopeType) => scopeType === "REPORT" || scopeType === "SCREEN",
      user: { isAdmin: false },
    });
    assert.ok(
      withReports.allowedEntityTypes.includes("REPORT"),
      "a user who can open reports should be able to filter by REPORT",
    );

    const withoutReports = buildActivityAccessScope({
      can: (scopeType, scopeKey) =>
        scopeType === "SCREEN" && scopeKey === "administration.audit_logs",
      user: { isAdmin: false },
    });
    assert.ok(
      !withoutReports.allowedEntityTypes.includes("REPORT"),
      "a user with no report access should not see the REPORT filter",
    );
  });

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed${failed.length ? ` (${failed.length} failed)` : ""}\n`,
  );
  await knex.destroy();
  process.exit(failed.length ? 1 : 0);
};

run().catch(async (error) => {
  console.error(error);
  await knex.destroy();
  process.exit(1);
});
