const { test, expect } = require("@playwright/test");
const { login, getCredentials } = require("./utils/auth");
const {
  getBranch,
  getTwoDistinctUsers,
  getUserByUsername,
  createApprovalRequest,
  deleteApprovalRequests,
  upsertUserWithPermissions,
  clearUserPermissionsOverride,
  closeDb,
} = require("./utils/db");

// A requester may pull back their own PENDING request without an approver.
// The row is closed as WITHDRAWN (never deleted), so admins keep seeing it.
const MAKER_USER = process.env.E2E_WITHDRAW_USER || "e2e_withdraw";
const MAKER_PASS = process.env.E2E_WITHDRAW_PASSWORD || "Withdraw@123";
const APPROVALS_SCOPE = "administration.approvals";

const OWN_SUMMARY = "E2E Withdraw Own Request";
const OTHER_SUMMARY = "E2E Withdraw Other Request";

test.describe("Approval withdraw (requester cancels own pending request)", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    makerId: null,
    otherUserId: null,
    ownRequestId: null,
    otherRequestId: null,
  };

  const seedRequests = async () => {
    // Recreated per test so each one starts from a PENDING row.
    await deleteApprovalRequests(
      [ctx.ownRequestId, ctx.otherRequestId].filter(Boolean),
    );
    ctx.ownRequestId = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "ITEM",
      entity_id: "NEW",
      summary: OWN_SUMMARY,
      status: "PENDING",
      requested_by: ctx.makerId,
    });
    ctx.otherRequestId = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "ITEM",
      entity_id: "NEW",
      summary: OTHER_SUMMARY,
      status: "PENDING",
      requested_by: ctx.otherUserId,
    });
  };

  test.beforeAll(async () => {
    const branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
    if (!branch || !users) {
      ctx.skipReason = `Missing branch or users. hasBranch=${Boolean(branch)} hasUsers=${Boolean(users)}`;
      return;
    }
    ctx.branchId = branch.id;
    ctx.otherUserId = users.primary.id;

    // Non-admin maker: can open the approvals screen, cannot approve.
    await upsertUserWithPermissions({
      username: MAKER_USER,
      password: MAKER_PASS,
      roleName: "Salesman",
      branchId: branch.id,
      scopeKeys: [APPROVALS_SCOPE],
    });
    const maker = await getUserByUsername(MAKER_USER);
    if (!maker) {
      ctx.skipReason = `Could not create maker user ${MAKER_USER}`;
      return;
    }
    ctx.makerId = maker.id;
    ctx.ready = true;
  });

  test.afterAll(async () => {
    await deleteApprovalRequests(
      [ctx.ownRequestId, ctx.otherRequestId].filter(Boolean),
    );
    if (ctx.makerId) {
      await clearUserPermissionsOverride({
        userId: ctx.makerId,
        scopeKeys: [APPROVALS_SCOPE],
      });
    }
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await seedRequests();
    // login() resolves credentials from <PREFIX>_USER / <PREFIX>_PASSWORD, so
    // publish the maker's (which default to a user this spec creates itself).
    process.env.E2E_WITHDRAW_USER = MAKER_USER;
    process.env.E2E_WITHDRAW_PASSWORD = MAKER_PASS;
    await login(page, "E2E_WITHDRAW");
  });

  const gotoApprovals = async (page, status) => {
    await page.goto(`/administration/approvals?status=${status}`, {
      waitUntil: "domcontentloaded",
    });
  };

  // Withdraw confirms through the layout's shared modal, not a native dialog.
  const clickWithdraw = async (page, requestId) => {
    await page
      .locator(`form[action$="/${requestId}/withdraw"] button`)
      .first()
      .click();
    const yesBtn = page.locator("[data-global-delete-confirm-yes]");
    await expect(yesBtn).toBeVisible();
    await Promise.all([
      page.waitForURL(/approvals/i, { timeout: 30000 }),
      yesBtn.click(),
    ]);
  };

  test("maker sees a withdraw button on their own pending request", async ({
    page,
  }) => {
    await gotoApprovals(page, "PENDING");
    const withdrawBtn = page.locator(
      `form[action$="/${ctx.ownRequestId}/withdraw"] button`,
    );
    await expect(withdrawBtn).toBeVisible();
    // A maker is not a checker: no approve/reject controls anywhere.
    await expect(page.locator('form[action*="/approve"]')).toHaveCount(0);
    await expect(page.locator('form[action*="/reject"]')).toHaveCount(0);
  });

  test("maker never sees another user's pending request", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    await expect(page.locator("tbody")).not.toContainText(OTHER_SUMMARY);
    await expect(
      page.locator(`form[action$="/${ctx.otherRequestId}/withdraw"]`),
    ).toHaveCount(0);
  });

  test("confirm prompt talks about withdrawing, not deleting", async ({
    page,
  }) => {
    await gotoApprovals(page, "PENDING");
    await page
      .locator(`form[action$="/${ctx.ownRequestId}/withdraw"] button`)
      .first()
      .click();
    const modal = page.locator("[data-global-delete-confirm-modal]");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(/withdraw/i);
    // The global delete interceptor must not have claimed this form.
    await expect(modal).not.toContainText(/permanently deletes/i);
    await expect(modal).not.toContainText(/confirm delete/i);
  });

  test("withdraw moves the request off pending and onto the withdrawn tab", async ({
    page,
  }) => {
    await gotoApprovals(page, "PENDING");
    await clickWithdraw(page, ctx.ownRequestId);

    const toast = page.locator("[data-ui-notice-toast]");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/withdraw/i);

    await gotoApprovals(page, "PENDING");
    await expect(page.locator("tbody")).not.toContainText(OWN_SUMMARY);

    await gotoApprovals(page, "WITHDRAWN");
    const row = page.locator("tbody tr", { hasText: OWN_SUMMARY }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/withdraw/i);
  });

  test("maker cannot withdraw another user's request by posting directly", async ({
    page,
  }) => {
    await gotoApprovals(page, "PENDING");
    const csrf = await page
      .locator('input[name="_csrf"]')
      .first()
      .inputValue();
    const res = await page.request.post(
      `/administration/approvals/${ctx.otherRequestId}/withdraw`,
      { form: { _csrf: csrf } },
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    // The other user's request must still be waiting for a checker.
    await gotoApprovals(page, "WITHDRAWN");
    await expect(page.locator("tbody")).not.toContainText(OTHER_SUMMARY);
  });

  test("admin still sees the maker's withdrawn request", async ({ page }) => {
    // Withdraw as the maker first, then check the admin's view of the same row.
    await gotoApprovals(page, "PENDING");
    await clickWithdraw(page, ctx.ownRequestId);

    await page.locator('form[action="/auth/logout"] button[type="submit"]').click();
    getCredentials("E2E_ADMIN");
    await login(page, "E2E_ADMIN");

    await gotoApprovals(page, "WITHDRAWN");
    const row = page.locator("tbody tr", { hasText: OWN_SUMMARY }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/withdraw/i);
    // An admin cannot re-decide a closed request.
    await expect(
      page.locator(`form[action$="/${ctx.ownRequestId}/approve"]`),
    ).toHaveCount(0);
  });
});
