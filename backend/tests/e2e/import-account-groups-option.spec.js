const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Master data import targets", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  test("shows account groups target option", async ({ page }) => {
    await page.goto("/master-data/import", { waitUntil: "domcontentloaded" });

    const target = page.locator(
      'input[name="targets"][value="account_groups"]',
    );
    await expect(target).toBeVisible();

    const targetLabel = page.locator("label").filter({ has: target }).first();
    await expect(targetLabel).toContainText(/Account Groups|اکاؤنٹ گروپس/i);
  });
});
