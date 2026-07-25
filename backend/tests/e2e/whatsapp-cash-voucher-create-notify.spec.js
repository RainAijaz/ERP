require("dotenv").config();
const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);
const TAG = `WA_CV_${Date.now()}`;

// Regression guard for the create-and-auto-approve cash-voucher path.
//
// The other WhatsApp spec drives the *approvals page* path (a hand-seeded PENDING
// voucher that an admin later approves). It never exercises the path a real admin
// actually takes on the Cash Voucher screen: fill the grid, hit Confirm, and —
// because an admin is both maker and checker — the voucher is APPROVED on the spot
// (createVoucher -> maybeNotifyPayeesPostCommit). That post-commit hook is what
// fires the per-payee WhatsApp notification for a directly-approved voucher, and
// until now nothing tested it. This reproduces the exact user report: "paid an
// employee and a supplier in one cash voucher, no WhatsApp went out."
//
// The test server runs with WHATSAPP_CLIENT_DISABLED=1, so nothing is delivered;
// each payee is logged QUEUED (client_unavailable) instead. The point of the test
// is that a log row is produced for BOTH the supplier and the employee — i.e. the
// hook fires and the notifier detects both payees — not that a message is sent.

const state = {
  adminId: null,
  branchId: null,
  headerAccountId: null,
  supplierId: null,
  employeeId: null,
  supplierOriginalPhone: undefined,
  employeeOriginalPhone: undefined,
  createdVoucherId: null,
  ready: false,
  skipReason: "create-notify fixture not built",
};

const getCsrf = async (page) => {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf_token")?.value || "";
};

test.describe("WhatsApp cash-voucher create+approve notification", () => {
  test.beforeAll(async () => {
    const adminUsername = process.env.E2E_ADMIN_USER;
    const admin = adminUsername
      ? await db("erp.users")
          .select("id")
          .whereRaw("LOWER(username) = LOWER(?)", [adminUsername])
          .first()
      : null;
    state.adminId = admin ? Number(admin.id) : null;
    if (!state.adminId) {
      state.skipReason = "E2E_ADMIN_USER not found in DB";
      return;
    }

    // Reuse a supplier + cash header account from an already-approved cash voucher
    // so the new voucher's GL posting is guaranteed to apply in this DB.
    const sample = await db("erp.voucher_header as vh")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .join("erp.parties as p", "p.id", "vl.party_id")
      .where("vh.voucher_type_code", "CASH_VOUCHER")
      .where("vh.status", "APPROVED")
      .whereNotNull("vh.header_account_id")
      .whereIn("p.party_type", ["SUPPLIER", "BOTH"])
      .select("p.id as party_id", "vh.header_account_id", "vh.branch_id")
      .orderBy("vh.id", "desc")
      .first();
    if (!sample) {
      state.skipReason = "no approved cash voucher with a supplier line to reuse";
      return;
    }
    state.branchId = Number(sample.branch_id);
    state.headerAccountId = Number(sample.header_account_id);
    state.supplierId = Number(sample.party_id);

    // An active employee mapped to the same branch (so the grid would offer it).
    const employee = await db("erp.employees as e")
      .join("erp.employee_branch as eb", "eb.employee_id", "e.id")
      .whereRaw("lower(e.status) = 'active'")
      .andWhere("eb.branch_id", state.branchId)
      .select("e.id", "e.phone")
      .orderBy("e.id", "asc")
      .first();
    if (!employee) {
      state.skipReason = "no active employee mapped to the branch";
      return;
    }
    state.employeeId = Number(employee.id);

    // Give both payees a well-formed PK mobile so the outcome is deterministic
    // (QUEUED via client_unavailable, not FAILED no_phone). Snapshot + restore.
    const supplier = await db("erp.parties")
      .select("phone1")
      .where({ id: state.supplierId })
      .first();
    state.supplierOriginalPhone = supplier ? supplier.phone1 : undefined;
    state.employeeOriginalPhone = employee.phone;

    await db("erp.parties")
      .where({ id: state.supplierId })
      .update({ phone1: "03001112223" });
    await db("erp.employees")
      .where({ id: state.employeeId })
      .update({ phone: "03004445556" });

    state.ready = true;
  });

  test.afterAll(async () => {
    const safe = async (fn) => {
      try {
        await fn();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[E2E cleanup]", err.message);
      }
    };

    if (state.createdVoucherId) {
      await safe(() =>
        db("erp.whatsapp_notification_log")
          .where({ voucher_header_id: state.createdVoucherId })
          .del(),
      );
      await safe(async () => {
        const batches = await db("erp.gl_batch")
          .where({ source_voucher_id: state.createdVoucherId })
          .select("id");
        const batchIds = batches.map((b) => b.id);
        if (batchIds.length) {
          await db("erp.gl_entry").whereIn("batch_id", batchIds).del();
          await db("erp.gl_batch").whereIn("id", batchIds).del();
        }
      });
      await safe(() =>
        db("erp.approval_request")
          .where({ entity_type: "VOUCHER", entity_id: String(state.createdVoucherId) })
          .del(),
      );
      await safe(() =>
        db("erp.voucher_line").where({ voucher_header_id: state.createdVoucherId }).del(),
      );
      await safe(() =>
        db("erp.voucher_header").where({ id: state.createdVoucherId }).del(),
      );
    }

    // Restore payee phones to their original values.
    if (state.supplierId && state.supplierOriginalPhone !== undefined) {
      await safe(() =>
        db("erp.parties")
          .where({ id: state.supplierId })
          .update({ phone1: state.supplierOriginalPhone }),
      );
    }
    if (state.employeeId && state.employeeOriginalPhone !== undefined) {
      await safe(() =>
        db("erp.employees")
          .where({ id: state.employeeId })
          .update({ phone: state.employeeOriginalPhone }),
      );
    }

    await db.destroy();
  });

  test("directly-approved cash voucher notifies both the supplier and the employee", async ({
    page,
  }) => {
    test.skip(!state.ready, state.skipReason);
    await login(page, "E2E_ADMIN");

    const csrf = await getCsrf(page);
    const lines = [
      {
        party_id: String(state.supplierId),
        cash_receipt: "0",
        cash_payment: "700",
        description: `${TAG} supplier`,
      },
      {
        employee_id: String(state.employeeId),
        cash_receipt: "0",
        cash_payment: "500",
        description: `${TAG} employee`,
      },
    ];

    const resp = await page.request.post("/vouchers/cash", {
      headers: { "x-csrf-token": csrf },
      form: {
        _csrf: csrf,
        voucher_id: "",
        voucher_date: new Date().toISOString().slice(0, 10),
        header_account_id: String(state.headerAccountId),
        remarks: `${TAG} note`,
        notify_payees_present: "1",
        notify_payees: "1",
        lines_json: JSON.stringify(lines),
      },
    });
    expect(resp.ok()).toBeTruthy();

    // Find the voucher just created in this branch.
    const header = await db("erp.voucher_header")
      .where({ voucher_type_code: "CASH_VOUCHER", branch_id: state.branchId })
      .orderBy("id", "desc")
      .first();
    state.createdVoucherId = Number(header.id);

    // Admin is maker+checker, so the voucher must be APPROVED immediately — that
    // is the branch of createVoucher that fires the post-commit notify hook.
    expect(String(header.status).toUpperCase()).toBe("APPROVED");

    // The hook runs fire-and-forget after the commit; give it a moment to land.
    const readLogs = async () =>
      db("erp.whatsapp_notification_log")
        .where({ voucher_header_id: state.createdVoucherId })
        .orderBy("recipient_kind", "asc");
    let logs = await readLogs();
    for (let i = 0; i < 20 && logs.length < 2; i++) {
      await page.waitForTimeout(250);
      logs = await readLogs();
    }

    // Both payees must have produced a notification row — this is what was missing
    // in the bug report. (Client disabled => QUEUED, not delivered.)
    expect(logs.length).toBe(2);

    const supplierRow = logs.find((r) => r.recipient_kind === "SUPPLIER");
    const employeeRow = logs.find((r) => r.recipient_kind === "EMPLOYEE");
    expect(supplierRow).toBeTruthy();
    expect(employeeRow).toBeTruthy();
    expect(Number(supplierRow.amount)).toBe(700);
    expect(Number(employeeRow.amount)).toBe(500);
    // With the WhatsApp client disabled the transient outcome is QUEUED (a durable
    // retry row carrying the rendered message), never silently dropped.
    expect(["QUEUED", "SENT"]).toContain(supplierRow.status);
    expect(["QUEUED", "SENT"]).toContain(employeeRow.status);
  });
});
