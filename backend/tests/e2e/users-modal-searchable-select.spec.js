const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Users modal searchable dropdown", () => {
  test("assigned branches uses searchable-select UI", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/users", { waitUntil: "domcontentloaded" });

    await page
      .getByRole("button", { name: /add user/i })
      .first()
      .click();
    const modal = page.locator("#modal-shell");
    await expect(modal).toBeVisible();

    const branchSelect = modal.locator('select[name="branch_ids"]');
    await expect(branchSelect).toHaveAttribute(
      "data-searchable-select",
      "true",
    );

    const branchSearchInput = modal
      .locator('select[name="branch_ids"]')
      .locator(
        "xpath=ancestor::*[@data-searchable-wrapper][1]//input[@type='text']",
      );
    await expect(branchSearchInput).toBeVisible();
  });

  test("multiselect searchable field toggles open/close on repeated clicks and stays stable on option picks", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/users", { waitUntil: "domcontentloaded" });

    await page
      .getByRole("button", { name: /add user/i })
      .first()
      .click();
    const modal = page.locator("#modal-shell");
    await expect(modal).toBeVisible();

    const branchWrapper = modal
      .locator('select[name="branch_ids"]')
      .locator("xpath=ancestor::*[@data-searchable-wrapper][1]");
    const branchSearchInput = branchWrapper.locator('input[type="text"]');
    const branchMenu = branchWrapper
      .locator(
        "xpath=.//div[contains(@class,'fixed') and contains(@class,'z-50')]",
      )
      .first();

    await branchSearchInput.click();
    await expect(branchMenu).toBeVisible();

    await branchSearchInput.click();
    await expect(branchMenu).toBeHidden();

    await branchSearchInput.click();
    await expect(branchMenu).toBeVisible();

    const firstOption = branchMenu.locator("[data-searchable-option]").first();
    await firstOption.click();
    await expect(branchMenu).toBeVisible();

    const selectedCount = await modal
      .locator('select[name="branch_ids"] option:checked')
      .count();
    expect(selectedCount).toBeGreaterThan(0);

    await page.mouse.click(1, 1);
    await expect(branchMenu).toBeHidden();
  });

  test("sales commission employee multiselect toggles open/close on repeated clicks", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/hr-payroll/employees/commissions", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Sales commission page not accessible for admin.",
    );

    await page.locator("[data-modal-open]").click();
    const modalForm = page.locator("[data-modal-form]");
    await expect(modalForm).toBeVisible();

    const employeeWrapper = modalForm
      .locator('select[name="employee_id"]')
      .locator("xpath=ancestor::*[@data-searchable-wrapper][1]");
    const employeeSearchInput = employeeWrapper.locator('input[type="text"]');
    const employeeMenu = employeeWrapper
      .locator(
        "xpath=.//div[contains(@class,'fixed') and contains(@class,'z-50')]",
      )
      .first();

    await employeeSearchInput.click();
    await expect(employeeMenu).toBeVisible();

    await employeeSearchInput.click();
    await expect(employeeMenu).toBeHidden();

    await employeeSearchInput.click();
    await expect(employeeMenu).toBeVisible();

    await page.mouse.click(1, 1);
    await expect(employeeMenu).toBeHidden();
  });
});
