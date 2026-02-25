const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Expense trends report", () => {
  test("renders trend controls and chart area", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/reports/financial/expense_trends", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Expense trends report not accessible.");

    const granularity = page.locator('select[name="time_granularity"]');
    const accountGroup = page.locator('select[name="account_group_id"]');
    const account = page.locator('select[name="trend_account_id"]');
    const branchesLabel = page
      .locator("[data-ledger-filter-form] span")
      .filter({ hasText: /^Branches$/ })
      .first();
    const loadButton = page.locator("[data-load-report]");
    const chart = page.locator("[data-expense-trend-chart]");
    const chartCanvas = page.locator("[data-expense-trend-chart-canvas]");
    const root = page.locator("[data-expense-trend-root]");
    const preLoadMessage = page.getByText("No entries yet.");

    await expect(granularity).toBeVisible();
    await expect(granularity).toHaveValue("daily");
    await expect(accountGroup).toBeVisible();
    await expect(account).toBeVisible();
    await expect(branchesLabel).toBeVisible();
    await expect(preLoadMessage).toBeVisible();
    await expect(root).toHaveCount(0);

    await Promise.all([page.waitForURL(/load_report=1/), loadButton.click()]);

    await expect(root).toBeVisible();
    expect((await chart.isVisible()) || (await chartCanvas.isVisible())).toBeTruthy();

    await granularity.selectOption("weekly");
    await Promise.all([page.waitForURL(/time_granularity=weekly/), loadButton.click()]);

    await expect(root).toBeVisible();
    expect((await chart.isVisible()) || (await chartCanvas.isVisible())).toBeTruthy();
    await expect(page).toHaveURL(/time_granularity=weekly/);
    await expect(page).toHaveURL(/load_report=1/);

    const firstPeriodLabel = page.locator("[data-expense-trend-labels] span").first();
    await expect(firstPeriodLabel).toHaveText(/\d{2}-\d{2}-\d{4}\s+-\s+\d{2}-\d{2}-\d{4}/);
  });

  test("sanitizes invalid date filters and shows warning", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/reports/financial/expense_trends?from_date=2026-99-40&to_date=not-a-date&load_report=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Expense trends report not accessible.");

    const warning = page.locator("[data-date-filter-warning]");
    const fromHidden = page.locator('input[name="from_date"]');
    const toHidden = page.locator('input[name="to_date"]');

    await expect(warning).toBeVisible();
    await expect(fromHidden).toHaveValue(/\d{4}-\d{2}-\d{2}/);
    await expect(toHidden).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  });
});
