const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Expense Analysis - Department Breakdown accordion", () => {
  test("supports inline expand/collapse with plus-minus flow", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto(
      "/reports/financial/expense_analysis?report_type=department_breakdown&load_report=1",
      { waitUntil: "domcontentloaded" },
    );
    test.skip(!response || response.status() !== 200, "Department Breakdown report not accessible.");

    const tree = page.locator("[data-breakdown-tree]");
    await expect(tree).toBeVisible();

    const departmentToggle = tree.locator("[data-toggle-department]").first();
    const hasDepartment = await departmentToggle.count();
    test.skip(hasDepartment === 0, "No department rows available for accordion validation.");

    await expect(departmentToggle).toBeVisible();
    await expect(departmentToggle).toContainText("+");

    await departmentToggle.click();
    const groupToggle = tree.locator("[data-toggle-group]").first();
    await expect(groupToggle).toBeVisible();
    await expect(departmentToggle).toContainText("-");

    await expect(groupToggle).toContainText("+");
    await groupToggle.click();
    const accountToggle = tree.locator("[data-toggle-account]").first();
    await expect(accountToggle).toBeVisible();
    await expect(groupToggle).toContainText("-");

    await expect(accountToggle).toContainText("+");
    await accountToggle.click();
    const linesTable = tree.locator("table").first();
    await expect(linesTable).toBeVisible();
    await expect(accountToggle).toContainText("-");

    await accountToggle.click();
    await expect(linesTable).toHaveCount(0);
    await expect(accountToggle).toContainText("+");

    await groupToggle.click();
    await expect(accountToggle).toHaveCount(0);
    await expect(groupToggle).toContainText("+");

    await departmentToggle.click();
    await expect(groupToggle).toHaveCount(0);
    await expect(departmentToggle).toContainText("+");
  });
});
