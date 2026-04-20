const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  upsertUserWithPermissions,
  getUserByUsername,
  setUserScopePermission,
  getBranchScopedAccounts,
  replaceUserAccountAccess,
  clearUserAccountAccess,
  closeDb,
} = require("./utils/db");

const LIMITED_USER =
  process.env.E2E_ACCOUNT_ACCESS_USER || "e2e_account_access";
const LIMITED_PASS = process.env.E2E_ACCOUNT_ACCESS_PASS || "Salesman@123";

const fixture = {
  userId: null,
  unrestrictedAccountId: null,
  detailsBlockedAccountId: null,
  blockedAccountId: null,
};

test.describe.serial("Account activity ledger account access", () => {
  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;

    process.env.E2E_ACCOUNT_ACCESS_USER = LIMITED_USER;
    process.env.E2E_ACCOUNT_ACCESS_PASS = LIMITED_PASS;

    await upsertUserWithPermissions({
      username: LIMITED_USER,
      password: LIMITED_PASS,
      roleName: "Salesman",
      branchId,
      scopeKeys: [],
    });

    const user = await getUserByUsername(LIMITED_USER);
    fixture.userId = Number(user?.id || 0) || null;

    await setUserScopePermission({
      userId: fixture.userId,
      scopeType: "REPORT",
      scopeKey: "account_activity_ledger",
      permissions: {
        can_view: true,
        can_load: true,
        can_view_details: true,
        can_print: true,
        can_export_excel_csv: true,
      },
    });

    const accounts = await getBranchScopedAccounts({ branchId, limit: 4 });
    if (accounts.length >= 3) {
      fixture.unrestrictedAccountId = Number(accounts[0].id);
      fixture.detailsBlockedAccountId = Number(accounts[1].id);
      fixture.blockedAccountId = Number(accounts[2].id);
      await replaceUserAccountAccess({
        userId: fixture.userId,
        rows: [
          {
            accountId: fixture.detailsBlockedAccountId,
            canViewSummary: true,
            canViewDetails: false,
          },
          {
            accountId: fixture.blockedAccountId,
            canViewSummary: false,
            canViewDetails: false,
          },
        ],
      });
    }
  });

  test.afterAll(async () => {
    try {
      if (fixture.userId) {
        await clearUserAccountAccess({ userId: fixture.userId });
      }
    } finally {
      await closeDb();
    }
  });

  test("hides fully blocked accounts from dropdown", async ({ page }) => {
    test.skip(
      !fixture.unrestrictedAccountId ||
        !fixture.detailsBlockedAccountId ||
        !fixture.blockedAccountId,
      "Not enough branch-scoped accounts to run account-access test.",
    );

    await login(page, "E2E_ACCOUNT_ACCESS");
    const response = await page.goto(
      "/reports/financial/account_activity_ledger",
      {
        waitUntil: "domcontentloaded",
      },
    );
    expect(response?.status()).toBe(200);

    const accountValues = await page
      .locator('select[name="account_id"] option')
      .evaluateAll((options) =>
        options
          .map((opt) => Number(opt.getAttribute("value") || 0))
          .filter((id) => Number.isInteger(id) && id > 0),
      );

    expect(accountValues).toContain(fixture.unrestrictedAccountId);
    expect(accountValues).toContain(fixture.detailsBlockedAccountId);
    expect(accountValues).not.toContain(fixture.blockedAccountId);
  });

  test("forces summary mode when selected account has no details access", async ({
    page,
  }) => {
    test.skip(
      !fixture.detailsBlockedAccountId,
      "Summary-only account fixture is not available.",
    );

    await login(page, "E2E_ACCOUNT_ACCESS");
    const response = await page.goto(
      `/reports/financial/account_activity_ledger?account_id=${fixture.detailsBlockedAccountId}&report_mode=details&load_report=1`,
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBe(200);

    await expect(
      page.locator('input[name="report_mode"][value="details"]'),
    ).toBeDisabled();
    await expect(
      page.locator('input[name="report_mode"][value="summary"]'),
    ).toBeChecked();
  });

  test("rejects tampered account id outside user access", async ({ page }) => {
    test.skip(!fixture.blockedAccountId, "Blocked account fixture is missing.");

    await login(page, "E2E_ACCOUNT_ACCESS");
    const response = await page.goto(
      `/reports/financial/account_activity_ledger?account_id=${fixture.blockedAccountId}&report_mode=details&load_report=1`,
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBe(403);
  });
});
