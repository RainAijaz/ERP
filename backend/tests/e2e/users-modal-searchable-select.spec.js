const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Users modal searchable dropdown", () => {
  test("assigned branches uses searchable-select UI", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/users", { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: /add user/i }).first().click();
    const modal = page.locator("#modal-shell");
    await expect(modal).toBeVisible();

    const branchSelect = modal.locator('select[name="branch_ids"]');
    await expect(branchSelect).toHaveAttribute("data-searchable-select", "true");

    const branchSearchInput = modal
      .locator('select[name="branch_ids"]')
      .locator("xpath=ancestor::*[@data-searchable-wrapper][1]//input[@type='text']");
    await expect(branchSearchInput).toBeVisible();
  });
});
