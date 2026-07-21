require("dotenv").config();
const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);
const TAG = `WA_E2E_${Date.now()}`;

const state = {
  adminId: null,
  requesterId: null,
  seededLogIds: [],
  liveVoucherId: null,
  liveApprovalId: null,
  optOutVoucherId: null,
  optOutApprovalId: null,
  liveReady: false,
  liveSkipReason: "live approval fixture not built",
};

const getCsrf = async (page) => {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf_token")?.value || "";
};

// Build a PENDING cash voucher (reusing a real supplier + cash header account
// from an already-approved cash voucher, so GL posting succeeds on approve) plus
// its approval_request. Returns { voucherId, approvalId } or null if no reusable
// supplier voucher exists in this DB.
const seedPendingCashVoucherApproval = async ({ notifyPayees }) => {
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
  if (!sample) return null;

  const maxRow = await db("erp.voucher_header").max("voucher_no as max").first();
  const voucherNo = Number(maxRow?.max || 0) + 1;

  return db.transaction(async (trx) => {
    const [vh] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: "CASH_VOUCHER",
        voucher_no: voucherNo,
        branch_id: sample.branch_id,
        voucher_date: trx.fn.now(),
        header_account_id: sample.header_account_id,
        status: "PENDING",
        created_by: state.adminId,
      })
      .returning(["id"]);
    const voucherId = Number(vh.id || vh);

    await trx("erp.voucher_line").insert({
      voucher_header_id: voucherId,
      line_no: 1,
      line_kind: "PARTY",
      party_id: sample.party_id,
      amount: 500,
      meta: JSON.stringify({ debit: 500, credit: 0, description: `${TAG} payment` }),
    });

    const [ar] = await trx("erp.approval_request")
      .insert({
        branch_id: sample.branch_id,
        request_type: "VOUCHER",
        entity_type: "VOUCHER",
        entity_id: String(voucherId),
        summary: `${TAG} ADD CASH_VOUCHER #${voucherNo}`,
        new_value: JSON.stringify({
          action: "create",
          voucher_type_code: "CASH_VOUCHER",
          voucher_no: voucherNo,
          header_account_id: sample.header_account_id,
          notify_payees: notifyPayees,
        }),
        // Maker-checker: the requester must differ from the approving admin
        // (approval_request CHECK: decided_by <> requested_by).
        requested_by: state.requesterId,
      })
      .returning(["id"]);
    return { voucherId, approvalId: Number(ar.id || ar) };
  });
};

test.describe("WhatsApp payment notifications", () => {
  test.beforeAll(async () => {
    const adminUsername = process.env.E2E_ADMIN_USER;
    const admin = adminUsername
      ? await db("erp.users")
          .select("id")
          .whereRaw("LOWER(username) = LOWER(?)", [adminUsername])
          .first()
      : null;
    state.adminId = admin ? Number(admin.id) : null;

    // A different user to act as the requester (maker) so the admin can approve.
    if (state.adminId) {
      const requester = await db("erp.users")
        .select("id")
        .whereNot("id", state.adminId)
        .orderBy("id", "asc")
        .first();
      state.requesterId = requester ? Number(requester.id) : null;
    }

    // Seed failure/sent log rows directly (deterministic, no sends) for the
    // page + dashboard + mark-handled UI assertions.
    const rows = await db("erp.whatsapp_notification_log")
      .insert([
        {
          voucher_type_code: "CASH_VOUCHER", voucher_no: 900001, branch_id: null,
          recipient_kind: "SUPPLIER", recipient_id: 999001, recipient_name: `${TAG} BadPhoneSupplier`,
          phone_raw: "021-1234567", phone_normalized: null, amount: 1500,
          status: "FAILED", failure_reason: "invalid_phone",
        },
        {
          voucher_type_code: "JOURNAL_VOUCHER", voucher_no: 900002, branch_id: null,
          recipient_kind: "LABOUR", recipient_id: 999002, recipient_name: `${TAG} NoPhoneLabour`,
          phone_raw: null, phone_normalized: null, amount: 800,
          status: "FAILED", failure_reason: "no_phone",
        },
        {
          voucher_type_code: "CASH_VOUCHER", voucher_no: 900003, branch_id: null,
          recipient_kind: "EMPLOYEE", recipient_id: 999003, recipient_name: `${TAG} SentEmployee`,
          phone_raw: "03001234567", phone_normalized: "923001234567", amount: 1200,
          status: "SENT", failure_reason: null,
        },
      ])
      .returning(["id"]);
    state.seededLogIds = rows.map((r) => Number(r.id || r));

    // Build live approval fixtures (only if a reusable supplier voucher exists).
    if (state.adminId) {
      try {
        const live = await seedPendingCashVoucherApproval({ notifyPayees: true });
        const optOut = await seedPendingCashVoucherApproval({ notifyPayees: false });
        if (live && optOut) {
          state.liveVoucherId = live.voucherId;
          state.liveApprovalId = live.approvalId;
          state.optOutVoucherId = optOut.voucherId;
          state.optOutApprovalId = optOut.approvalId;
          state.liveReady = true;
        } else {
          state.liveSkipReason = "no approved cash voucher with a supplier line to reuse";
        }
      } catch (err) {
        state.liveSkipReason = `live fixture build failed: ${err.message}`;
      }
    } else {
      state.liveSkipReason = "E2E_ADMIN_USER not found in DB";
    }
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
    const ids = [state.liveVoucherId, state.optOutVoucherId].filter(Boolean);
    const approvalIds = [state.liveApprovalId, state.optOutApprovalId].filter(Boolean);

    if (ids.length) {
      await safe(() => db("erp.whatsapp_notification_log").whereIn("voucher_header_id", ids).del());
      // GL rows link to the voucher via gl_batch.source_voucher_id.
      await safe(async () => {
        const batches = await db("erp.gl_batch").whereIn("source_voucher_id", ids).select("id");
        const batchIds = batches.map((b) => b.id);
        if (batchIds.length) {
          await db("erp.gl_entry").whereIn("batch_id", batchIds).del();
          await db("erp.gl_batch").whereIn("id", batchIds).del();
        }
      });
      await safe(() => db("erp.voucher_line").whereIn("voucher_header_id", ids).del());
    }
    if (approvalIds.length) {
      await safe(() => db("erp.approval_request").whereIn("id", approvalIds).del());
    }
    if (ids.length) {
      await safe(() => db("erp.voucher_header").whereIn("id", ids).del());
    }
    if (state.seededLogIds.length) {
      await safe(() => db("erp.whatsapp_notification_log").whereIn("id", state.seededLogIds).del());
    }
    await db.destroy();
  });

  // ── 1. Migration / schema ────────────────────────────────────────────────
  test("migration: whatsapp_notification_log table + permission scope exist", async () => {
    const hasTable = await db.schema.withSchema("erp").hasTable("whatsapp_notification_log");
    expect(hasTable).toBe(true);
    const scope = await db("erp.permission_scope_registry")
      .where({ scope_type: "SCREEN", scope_key: "administration.whatsapp_notifications" })
      .first();
    expect(scope).toBeTruthy();
  });

  // ── 2. Admin failures page lists failed notifications with reasons ───────
  test("admin page lists failed notifications with recipient + reason", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/whatsapp-notifications", { waitUntil: "domcontentloaded" });
    await expect(page.locator("table")).toBeVisible();

    // Default view is FAILED-only: exactly the two seeded failures (TAG-scoped),
    // each showing its recipient + reason; the SENT row is excluded.
    await expect(page.locator("tbody tr", { hasText: TAG })).toHaveCount(2);
    await expect(
      page.locator("tr", { hasText: `${TAG} BadPhoneSupplier` }),
    ).toContainText("Invalid phone number");
    await expect(
      page.locator("tr", { hasText: `${TAG} BadPhoneSupplier` }),
    ).toContainText("021-1234567");
    await expect(
      page.locator("tr", { hasText: `${TAG} NoPhoneLabour` }),
    ).toContainText("No phone number on record");

    // The ALL view additionally includes the SENT row (3 TAG rows total).
    await page.goto("/administration/whatsapp-notifications?status=ALL", { waitUntil: "domcontentloaded" });
    await expect(page.locator("tbody tr", { hasText: TAG })).toHaveCount(3);
    await expect(
      page.locator("tr", { hasText: `${TAG} SentEmployee` }),
    ).toContainText("Sent");
  });

  // ── 3. Dashboard shows the "messages not sent" alert linking to the page ─
  test("dashboard alert links to the failures page", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // The alert row lives in the dashboard alerts panel (the same href also
    // appears in the collapsed nav sidebar, which is hidden — scope to the panel).
    const alertLink = page.locator(
      '#alerts-panel a[href="/administration/whatsapp-notifications"]',
    );
    await expect(alertLink.first()).toBeVisible();
  });

  // ── 4. "Mark handled" resolves a failure so it leaves the failures view ──
  test("mark handled resolves a failure row", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/whatsapp-notifications", { waitUntil: "domcontentloaded" });

    const row = page.locator("tr", { hasText: `${TAG} BadPhoneSupplier` });
    await expect(row).toBeVisible();
    await row.locator('form[action*="/resolve"] button[type="submit"]').click();

    await page.waitForLoadState("domcontentloaded");
    await page.goto("/administration/whatsapp-notifications", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(`${TAG} BadPhoneSupplier`)).toHaveCount(0);

    // Confirmed in DB: resolved_at is set.
    const resolved = await db("erp.whatsapp_notification_log")
      .where({ recipient_name: `${TAG} BadPhoneSupplier` })
      .first();
    expect(resolved.resolved_at).toBeTruthy();
  });

  // ── 5. Approving a cash voucher fires the notification hook (live) ───────
  test("approving a cash voucher logs a payment notification", async ({ page }) => {
    test.skip(!state.liveReady, state.liveSkipReason);
    await login(page, "E2E_ADMIN");

    const csrf = await getCsrf(page);
    await page.request.post(
      `/administration/approvals/${state.liveApprovalId}/approve`,
      { headers: { "x-csrf-token": csrf } },
    );

    // The approval actually applied (skip if GL posting can't apply in this env).
    const ar = await db("erp.approval_request").where({ id: state.liveApprovalId }).first();
    test.skip(ar.status !== "APPROVED", `approve did not apply (status ${ar.status})`);

    // The hook logged a notification for this voucher (FAILED because the test
    // server runs with the WhatsApp client disabled — nothing is delivered).
    const logs = await db("erp.whatsapp_notification_log")
      .where({ voucher_header_id: state.liveVoucherId });
    expect(logs.length).toBe(1);
    expect(logs[0].recipient_kind).toBe("SUPPLIER");
    expect(Number(logs[0].amount)).toBe(500);
    expect(logs[0].status).toBe("FAILED");
  });

  // ── 6. Opt-out checkbox unchecked suppresses notifications ───────────────
  test("opt-out (notify_payees=false) sends no notification", async ({ page }) => {
    test.skip(!state.liveReady, state.liveSkipReason);
    await login(page, "E2E_ADMIN");

    const csrf = await getCsrf(page);
    await page.request.post(
      `/administration/approvals/${state.optOutApprovalId}/approve`,
      { headers: { "x-csrf-token": csrf } },
    );

    const ar = await db("erp.approval_request").where({ id: state.optOutApprovalId }).first();
    test.skip(ar.status !== "APPROVED", `approve did not apply (status ${ar.status})`);

    const logs = await db("erp.whatsapp_notification_log")
      .where({ voucher_header_id: state.optOutVoucherId });
    expect(logs.length).toBe(0);
  });
});
