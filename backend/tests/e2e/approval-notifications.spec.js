const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getTwoDistinctUsers,
  createApprovalRequest,
  deleteApprovalRequests,
  closeDb,
} = require("./utils/db");
const {
  getActiveApprovalUserIds,
} = require("../../src/utils/approval-notifications");

// Dedicated knex for asserting/cleaning the erp.notification table.
const knexConfig = require("../../knexfile").development;
const knex = require("knex")(knexConfig);

// Proves the in-ERP approval-notification feature end to end:
//  - a new pending approval request surfaces in the header bell (badge + item)
//  - the ?request_id deep-link auto-opens that request's modal
//  - mark-all-read clears the unread badge
//  - the requester is excluded and generation is idempotent (DB-level)
//  - a request created while the approver is online triggers a LIVE toast via SSE
test.describe("In-app approval notifications", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    admin: null,
    requester: null,
  };
  const createdIds = [];
  const testStart = new Date();

  const seedPending = async (summary) => {
    const id = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SIZE",
      entity_id: "NEW",
      summary,
      new_value: { _action: "create", name: summary },
      status: "PENDING",
      requested_by: ctx.requester.id,
      requested_at: new Date(),
    });
    createdIds.push(id);
    return id;
  };

  const waitForNotificationsFetch = (page) =>
    page
      .waitForResponse(
        (r) =>
          /\/notifications(\?|$)/.test(r.url()) &&
          r.request().method() === "GET" &&
          r.status() === 200,
        { timeout: 15000 },
      )
      .catch(() => null);

  test.beforeAll(async () => {
    const branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
    if (!branch || !users) {
      ctx.skipReason = `Missing branch or two distinct users (branch=${Boolean(
        branch,
      )}, users=${Boolean(users)}).`;
      return;
    }
    const recipients = await getActiveApprovalUserIds(knex);
    if (!recipients.includes(Number(users.primary.id))) {
      ctx.skipReason =
        "Logged-in admin is not an approval-notification recipient; cannot assert delivery.";
      return;
    }
    ctx.ready = true;
    ctx.branchId = branch.id;
    ctx.admin = users.primary; // logged-in approver
    ctx.requester = users.secondary; // maker (must be excluded)
  });

  test.afterAll(async () => {
    try {
      if (createdIds.filter(Boolean).length) {
        await knex("erp.notification")
          .whereIn("approval_request_id", createdIds.filter(Boolean))
          .del();
      }
      // Remove any notifications the backfill sweep generated for the approver
      // during this run so the test leaves no residue.
      if (ctx.admin?.id) {
        await knex("erp.notification")
          .where("user_id", ctx.admin.id)
          .andWhere("created_at", ">=", testStart)
          .del();
      }
      await deleteApprovalRequests(createdIds.filter(Boolean));
    } finally {
      await knex.destroy();
      await closeDb();
    }
  });

  test.beforeEach(async () => {
    test.skip(!ctx.ready, ctx.skipReason);
  });

  test("bell hydrates with unread badge + item for a new pending request", async ({
    page,
  }) => {
    const summary = `E2E Notif Hydrate ${Date.now()}`;
    await seedPending(summary);

    await login(page, "E2E_ADMIN");
    // Bell hydration performs GET /notifications (which also runs the backfill
    // sweep, generating this approver's row for the pending request).
    await waitForNotificationsFetch(page);

    const bell = page.locator("[data-notif-toggle]");
    await expect(bell).toBeVisible();

    const badge = page.locator("[data-notif-badge]");
    await expect(badge).toBeVisible({ timeout: 10000 });

    await bell.click();
    const item = page
      .locator("[data-notif-item]", { hasText: summary })
      .first();
    await expect(item).toBeVisible({ timeout: 10000 });
  });

  test("deep-link ?request_id auto-opens the request modal", async ({
    page,
  }) => {
    const summary = `E2E Notif DeepLink ${Date.now()}`;
    const id = await seedPending(summary);

    await login(page, "E2E_ADMIN");
    await page.goto(`/administration/approvals?request_id=${id}`, {
      waitUntil: "domcontentloaded",
    });

    const modal = page.locator("[data-approval-detail-modal]");
    await expect(modal).toBeVisible({ timeout: 10000 });
  });

  test("mark-all-read clears the unread badge", async ({ page }) => {
    const summary = `E2E Notif ReadAll ${Date.now()}`;
    await seedPending(summary);

    await login(page, "E2E_ADMIN");
    await waitForNotificationsFetch(page);

    const badge = page.locator("[data-notif-badge]");
    await expect(badge).toBeVisible({ timeout: 10000 });

    await page.locator("[data-notif-toggle]").click();
    const readAll = page.waitForResponse(
      (r) =>
        r.url().includes("/notifications/read-all") &&
        r.request().method() === "POST",
      { timeout: 10000 },
    );
    await page.locator("[data-notif-readall]").click();
    await readAll;

    await expect(badge).toBeHidden({ timeout: 10000 });
  });

  test("requester is excluded and generation is idempotent (DB-level)", async ({
    page,
  }) => {
    const summary = `E2E Notif Rules ${Date.now()}`;
    const id = await seedPending(summary);

    // Trigger generation via the bell hydration path.
    await login(page, "E2E_ADMIN");
    await waitForNotificationsFetch(page);
    // Second load must not create duplicates (idempotency guard).
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForNotificationsFetch(page);

    const rows = await knex("erp.notification").where({
      approval_request_id: id,
    });
    // Every recipient except the requester, exactly once each.
    const recipients = await getActiveApprovalUserIds(knex);
    const expected = recipients.filter(
      (uid) => uid !== Number(ctx.requester.id),
    ).length;
    expect(rows.length).toBe(expected);
    expect(
      rows.some((r) => Number(r.user_id) === Number(ctx.requester.id)),
    ).toBe(false);
    expect(rows.some((r) => Number(r.user_id) === Number(ctx.admin.id))).toBe(
      true,
    );
  });

  test("live: SSE pushes a notification event when a request is generated while online", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    // Open a raw SSE stream and capture 'notification' events. This proves the
    // server-side live push directly, independent of the multi-tab owner
    // election used by the header bell.
    await page.evaluate(() => {
      window.__notif = { events: [], ready: false };
      const es = new EventSource("/events/approvals");
      window.__es = es;
      es.addEventListener("ready", () => {
        window.__notif.ready = true;
      });
      es.addEventListener("notification", (e) => {
        try {
          window.__notif.events.push(JSON.parse(e.data));
        } catch (err) {
          /* ignore */
        }
      });
    });
    await page.waitForFunction(() => window.__notif && window.__notif.ready, {
      timeout: 15000,
    });

    // New request AFTER connect => no notification row yet. Trigger generation
    // (backfill sweep -> notifyPendingApproval -> live SSE push).
    const summary = `E2E Notif Live ${Date.now()}`;
    await seedPending(summary);
    await page.evaluate(() =>
      fetch("/notifications", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      }).then((r) => r.json()),
    );

    await page.waitForFunction(
      (s) =>
        (window.__notif.events || []).some((ev) =>
          String(ev.body || "").includes(s),
        ),
      summary,
      { timeout: 12000 },
    );
    const got = await page.evaluate(
      (s) =>
        (window.__notif.events || []).find((ev) =>
          String(ev.body || "").includes(s),
        ),
      summary,
    );
    expect(got).toBeTruthy();
    expect(String(got.link)).toContain("request_id=");
    await page.evaluate(() => window.__es && window.__es.close());
  });

  test("bell renders a live toast when a notification event is delivered", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await waitForNotificationsFetch(page);

    // Drive the exact hook the SSE stream calls on a live 'notification' event.
    await page.evaluate(() => {
      window.erpNotifyBell.onLive({
        id: 999999999,
        type: "APPROVAL_PENDING",
        title: "New approval request",
        body: "E2E TOAST BODY",
        link: "/administration/approvals?request_id=999999999",
        unreadCount: 1,
      });
    });

    const toast = page.locator("[data-notif-toast]");
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText("E2E TOAST BODY");
    await expect(toast.locator('a[data-notif-open]')).toHaveAttribute(
      "href",
      /request_id=999999999/,
    );
  });
});
