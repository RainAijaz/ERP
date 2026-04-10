const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  upsertUserWithPermissions,
  getUserByUsername,
  getBranchScopedAccounts,
  clearUserAccountAccess,
  closeDb,
} = require("./utils/db");

const TARGET_USER = process.env.E2E_ACCOUNT_UI_USER || "e2e_account_ui";
const TARGET_PASS = process.env.E2E_ACCOUNT_UI_PASS || "Salesman@123";

const fixture = {
  userId: null,
  accountId: null,
};

test.describe.serial("Permissions account access UI", () => {
  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;

    await upsertUserWithPermissions({
      username: TARGET_USER,
      password: TARGET_PASS,
      roleName: "Salesman",
      branchId,
      scopeKeys: [],
    });

    const user = await getUserByUsername(TARGET_USER);
    fixture.userId = Number(user?.id || 0) || null;

    const accounts = await getBranchScopedAccounts({ branchId, limit: 1 });
    fixture.accountId = Number(accounts?.[0]?.id || 0) || null;

    if (fixture.userId) {
      await clearUserAccountAccess({ userId: fixture.userId });
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

  test("new account row defaults summary/details to true and enforces toggle rules", async ({
    page,
  }) => {
    test.skip(
      !fixture.userId || !fixture.accountId,
      "Missing fixture user/account for UI test.",
    );

    await login(page, "E2E_ADMIN");
    const response = await page.goto(
      `/administration/permissions?type=user&target_id=${fixture.userId}`,
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBe(200);

    const addSelect = page.locator("[data-account-access-add]");
    const addButton = page.locator("[data-account-access-add-btn]");
    await expect(addSelect).toBeVisible();

    await addSelect.selectOption(String(fixture.accountId));
    await addButton.click();

    const row = page
      .locator(
        `[data-account-access-row][data-account-id="${fixture.accountId}"]`,
      )
      .first();
    await expect(row).toBeVisible();

    const summaryToggle = row.locator("[data-account-summary]");
    const detailsToggle = row.locator("[data-account-details]");

    await expect(summaryToggle).toBeChecked();
    await expect(detailsToggle).toBeChecked();

    await summaryToggle.uncheck();
    await expect(detailsToggle).not.toBeChecked();

    await detailsToggle.check();
    await expect(summaryToggle).toBeChecked();
    await expect(detailsToggle).toBeChecked();

    await Promise.all([
      page.waitForURL(/\/administration\/permissions\?type=user&target_id=/i),
      page.locator("[data-account-access-form] button[type='submit']").click(),
    ]);

    const persistedRow = page
      .locator(
        `[data-account-access-row][data-account-id="${fixture.accountId}"]`,
      )
      .first();
    await expect(persistedRow.locator("[data-account-summary]")).toBeChecked();
    await expect(persistedRow.locator("[data-account-details]")).toBeChecked();
  });
});
