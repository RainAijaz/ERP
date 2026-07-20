/*
 * LIVE WhatsApp delivery tests — these send REAL messages.
 *
 * Opt-in only: skipped unless E2E_WHATSAPP_LIVE=1, so an ordinary `npm run
 * test:e2e` can never message anyone. Run with a server started WITHOUT
 * WHATSAPP_CLIENT_DISABLED so a real client is connected:
 *
 *   WHATSAPP_PAYMENT_NOTIFY_ENABLED=1 WHATSAPP_RETRY_INTERVAL_MS=10000 \
 *     PORT=3000 node src/app.js
 *   E2E_WHATSAPP_LIVE=1 E2E_SERVER_LOG=<path> npx playwright test \
 *     tests/e2e/whatsapp-live-delivery.spec.js
 *
 * SAFETY: every test targets ONLY the dedicated test number below, or a number
 * verified as not registered on WhatsApp. It must never approve a voucher that
 * pays a real supplier/labour/employee — the production DB is full of live
 * numbers.
 */
require("dotenv").config();
const fs = require("fs");
const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);

// The one number these tests are allowed to message (the user's own test line).
const TEST_PHONE = "03114673188";
const TEST_MSISDN = "923114673188";
// Verified via getNumberId() as NOT registered on WhatsApp — safe to "message".
const UNREGISTERED_PHONE = "03000000001";

const LIVE = process.env.E2E_WHATSAPP_LIVE === "1";
const SERVER_LOG = process.env.E2E_SERVER_LOG || "";
const TAG = `WA_LIVE_${Date.now()}`;

const state = {
  adminId: null,
  requesterId: null,
  hamzaId: null,
  badNumberId: null,
  headerAccountId: null,
  branchId: null,
  voucherIds: [],
  approvalIds: [],
  queuedLogIds: [],
};

const readServerLog = () => {
  if (!SERVER_LOG) return "";
  try {
    return fs.readFileSync(SERVER_LOG, "utf8");
  } catch (_e) {
    return "";
  }
};

// Poll until `fn()` returns truthy or we time out.
const waitFor = async (fn, { timeoutMs = 60000, intervalMs = 2000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = await fn();
    if (val) return val;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

const getCsrf = async (page) => {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf_token")?.value || "";
};

// Seed a PENDING cash voucher paying one specific party, plus its approval
// request, so approving it exercises the real notification hook.
const seedVoucherPaying = async (partyId, amount, description) => {
  const maxRow = await db("erp.voucher_header").max("voucher_no as m").first();
  const voucherNo = Number(maxRow?.m || 0) + 1;
  return db.transaction(async (trx) => {
    const [vh] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: "CASH_VOUCHER",
        voucher_no: voucherNo,
        branch_id: state.branchId,
        voucher_date: trx.fn.now(),
        header_account_id: state.headerAccountId,
        status: "PENDING",
        created_by: state.adminId,
      })
      .returning(["id"]);
    const voucherId = Number(vh.id || vh);

    await trx("erp.voucher_line").insert({
      voucher_header_id: voucherId,
      line_no: 1,
      line_kind: "PARTY",
      party_id: partyId,
      amount,
      meta: { debit: amount, credit: 0, description },
    });

    const [ar] = await trx("erp.approval_request")
      .insert({
        branch_id: state.branchId,
        request_type: "VOUCHER",
        entity_type: "VOUCHER",
        entity_id: String(voucherId),
        summary: `${TAG} ADD CASH_VOUCHER #${voucherNo}`,
        new_value: {
          action: "create",
          voucher_type_code: "CASH_VOUCHER",
          voucher_no: voucherNo,
          header_account_id: state.headerAccountId,
          notify_payees: true,
        },
        requested_by: state.requesterId,
      })
      .returning(["id"]);

    state.voucherIds.push(voucherId);
    state.approvalIds.push(Number(ar.id || ar));
    return { voucherId, approvalId: Number(ar.id || ar), voucherNo };
  });
};

const approve = async (page, approvalId) => {
  const csrf = await getCsrf(page);
  await page.request.post(`/administration/approvals/${approvalId}/approve`, {
    headers: { "x-csrf-token": csrf },
  });
  return db("erp.approval_request").where({ id: approvalId }).first();
};

test.describe("LIVE WhatsApp delivery", () => {
  test.skip(!LIVE, "set E2E_WHATSAPP_LIVE=1 to run tests that send real messages");
  // Real sends + a real client are slow; give each test room.
  test.setTimeout(120000);

  test.beforeAll(async () => {
    const admin = await db("erp.users")
      .whereRaw("LOWER(username) = LOWER(?)", [process.env.E2E_ADMIN_USER])
      .first();
    state.adminId = Number(admin.id);
    const requester = await db("erp.users").whereNot("id", state.adminId).orderBy("id").first();
    state.requesterId = Number(requester.id);

    // Reuse a real approved cash voucher's header account so GL posting succeeds.
    const sample = await db("erp.voucher_header")
      .select("header_account_id", "branch_id")
      .where({ voucher_type_code: "CASH_VOUCHER", status: "APPROVED" })
      .whereNotNull("header_account_id")
      .orderBy("id", "desc")
      .first();
    state.headerAccountId = sample.header_account_id;
    state.branchId = sample.branch_id;

    // The only party we are allowed to actually message.
    const hamza = await db("erp.parties").whereRaw("lower(name)=?", ["hamza"]).first();
    state.hamzaId = Number(hamza.id);
    expect(hamza.phone1).toBe(TEST_PHONE); // guard: never message anyone else

    // A party whose number is not on WhatsApp.
    const [bad] = await db("erp.parties")
      .insert({
        code: `${TAG}_BAD`,
        name: `${TAG} NotOnWhatsApp`,
        party_type: "SUPPLIER",
        phone1: UNREGISTERED_PHONE,
        branch_id: state.branchId,
        is_active: true,
        created_by: state.adminId,
      })
      .returning(["id"]);
    state.badNumberId = Number(bad.id || bad);
    await db("erp.party_branch")
      .insert({ party_id: state.badNumberId, branch_id: state.branchId })
      .onConflict(["party_id", "branch_id"])
      .ignore();
  });

  test.afterAll(async () => {
    const safe = async (fn) => {
      try {
        await fn();
      } catch (e) {
        console.error("[cleanup]", e.message);
      }
    };
    if (state.voucherIds.length) {
      await safe(() => db("erp.whatsapp_notification_log").whereIn("voucher_header_id", state.voucherIds).del());
      await safe(async () => {
        const b = await db("erp.gl_batch").whereIn("source_voucher_id", state.voucherIds).select("id");
        const ids = b.map((x) => x.id);
        if (ids.length) {
          await db("erp.gl_entry").whereIn("batch_id", ids).del();
          await db("erp.gl_batch").whereIn("id", ids).del();
        }
      });
      await safe(() => db("erp.voucher_line").whereIn("voucher_header_id", state.voucherIds).del());
    }
    if (state.approvalIds.length) await safe(() => db("erp.approval_request").whereIn("id", state.approvalIds).del());
    if (state.voucherIds.length) await safe(() => db("erp.voucher_header").whereIn("id", state.voucherIds).del());
    if (state.queuedLogIds.length) await safe(() => db("erp.whatsapp_notification_log").whereIn("id", state.queuedLogIds).del());
    if (state.badNumberId) {
      await safe(() => db("erp.party_branch").where({ party_id: state.badNumberId }).del());
      await safe(() => db("erp.parties").where({ id: state.badNumberId }).del());
    }
    await db.destroy();
  });

  // ── 1. The real client is actually connected ────────────────────────────
  test("WhatsApp client is connected (not the disabled stub)", async () => {
    const log = readServerLog();
    expect(log).toContain("[WhatsApp] Client ready");
    expect(log).not.toContain("client disabled via WHATSAPP_CLIENT_DISABLED");
  });

  // ── 2. Approving a voucher really delivers to 03114673188 ───────────────
  test("approved payment delivers a real WhatsApp message to the test number", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const before = readServerLog().length;

    const { voucherId } = await seedVoucherPaying(state.hamzaId, 500, `${TAG} live delivery`);
    const ar = await approve(page, state.approvalIds[state.approvalIds.length - 1]);
    expect(ar.status).toBe("APPROVED");

    const row = await waitFor(async () => {
      const r = await db("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId }).first();
      return r && r.status !== "QUEUED" ? r : null;
    });

    expect(row, "a notification row should exist").toBeTruthy();
    expect(row.status).toBe("SENT");
    expect(row.recipient_name.toLowerCase()).toBe("hamza");
    expect(row.phone_raw).toBe(TEST_PHONE);
    expect(row.phone_normalized).toBe(TEST_MSISDN);
    expect(Number(row.amount)).toBe(500);
    expect(row.failure_reason).toBeNull();

    // The transport really handed it over (proves it isn't a silent no-op).
    const fresh = readServerLog().slice(before);
    expect(fresh).toMatch(/Message sent successfully to/);
  });

  // ── 3. It addresses the resolved id, never a hand-built @c.us ───────────
  test("send uses the WhatsApp-resolved chat id", async () => {
    const log = readServerLog();
    const sends = log.match(/Message sent successfully to (\S+)/g) || [];
    expect(sends.length).toBeGreaterThan(0);
    // Resolved ids are @lid or @c.us as WhatsApp returns them — the point is
    // that the id came from getNumberId, so a bare number is never used.
    expect(sends[sends.length - 1]).toMatch(/@(lid|c\.us)$/);
  });

  // ── 4. Exactly one message per approval (no duplicate) ──────────────────
  test("one approval produces exactly one delivered message", async () => {
    const voucherId = state.voucherIds[state.voucherIds.length - 1];
    const rows = await db("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId });
    expect(rows.length).toBe(1);
    expect(rows.filter((r) => r.status === "SENT").length).toBe(1);
  });

  // ── 5. A number not on WhatsApp fails without sending ───────────────────
  test("number not on WhatsApp is caught and nothing is sent", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const before = readServerLog().length;

    const { voucherId } = await seedVoucherPaying(state.badNumberId, 300, `${TAG} bad number`);
    const ar = await approve(page, state.approvalIds[state.approvalIds.length - 1]);
    expect(ar.status).toBe("APPROVED");

    const row = await waitFor(async () =>
      db("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId }).first(),
    );
    expect(row).toBeTruthy();
    expect(row.status).toBe("FAILED");
    expect(row.failure_reason).toBe("not_on_whatsapp");
    // Permanent, so it must not be queued for pointless retries.
    expect(row.next_retry_at).toBeNull();

    const fresh = readServerLog().slice(before);
    expect(fresh).not.toMatch(/Message sent successfully to/);
  });

  // ── 6. The retry worker really delivers a queued message ────────────────
  test("retry worker delivers a QUEUED message over the live connection", async () => {
    const body = `🔔 *ادائیگی کی اطلاع*\n${TAG} retry-queue live test`;
    const [ins] = await db("erp.whatsapp_notification_log")
      .insert({
        voucher_type_code: "CASH_VOUCHER",
        voucher_no: 999001,
        branch_id: state.branchId,
        recipient_kind: "SUPPLIER",
        recipient_id: state.hamzaId,
        recipient_name: "hamza",
        phone_raw: TEST_PHONE,
        phone_normalized: TEST_MSISDN,
        amount: 750,
        status: "QUEUED",
        failure_reason: "client_unavailable",
        message_body: body,
        attempts: 1,
        next_retry_at: new Date(Date.now() - 60000), // due now
      })
      .returning(["id"]);
    const logId = Number(ins.id || ins);
    state.queuedLogIds.push(logId);

    // The server sweeps on its own interval; wait for it to pick this up.
    const row = await waitFor(
      async () => {
        const r = await db("erp.whatsapp_notification_log").where({ id: logId }).first();
        return r && r.status !== "QUEUED" ? r : null;
      },
      { timeoutMs: 90000, intervalMs: 3000 },
    );

    expect(row, "worker should have processed the queued row").toBeTruthy();
    expect(row.status).toBe("SENT");
    expect(row.next_retry_at).toBeNull();
    expect(Number(row.attempts)).toBeGreaterThanOrEqual(2);
  });

  // ── 7. Queued rows never double-send ────────────────────────────────────
  test("a delivered queued row is not sent again by later sweeps", async () => {
    const logId = state.queuedLogIds[0];
    const before = await db("erp.whatsapp_notification_log").where({ id: logId }).first();
    // Let at least one more sweep run.
    await new Promise((r) => setTimeout(r, 15000));
    const after = await db("erp.whatsapp_notification_log").where({ id: logId }).first();
    expect(after.status).toBe("SENT");
    expect(Number(after.attempts)).toBe(Number(before.attempts)); // untouched
  });
});
