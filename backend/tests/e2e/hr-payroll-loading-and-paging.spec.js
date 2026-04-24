const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("HR Payroll loading and paging", () => {
  test("labour rates rate header follows rate view selector", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/labours/rates", {
      waitUntil: "domcontentloaded",
    });

    const rateHeader = page.locator(
      'button[data-sort-key="rate_value"] > span:first-child',
    );
    await expect(rateHeader).toBeVisible();

    const rateViewSelect = page.locator('[name="rate_view"]').first();
    test.skip(
      (await rateViewSelect.count()) < 1,
      "Rate view selector is unavailable.",
    );
    const filterToggle = page.locator("[data-filter-toggle]").first();
    await expect(filterToggle).toBeVisible();
    await filterToggle.click();
    const filterPanel = page.locator("[data-filter-panel]").first();
    await expect(filterPanel).toBeVisible();

    await rateViewSelect.selectOption("PER_DOZEN");
    await expect(rateHeader).toContainText(/dozen/i);

    await rateViewSelect.selectOption("PER_PAIR");
    await expect(rateHeader).toContainText(/pair/i);
  });

  test("labour rates supports server next page when show all is selected", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/labours/rates", {
      waitUntil: "domcontentloaded",
    });

    const table = page.locator("[data-table]").first();
    await expect(table).toBeVisible();

    const serverPagination = await table.getAttribute("data-server-pagination");
    const hasNext = await table.getAttribute("data-server-has-next");
    test.skip(
      serverPagination !== "true" || hasNext !== "true",
      "Dataset does not exceed the server cap in this environment.",
    );

    const pageSizeSelect = page.locator("[data-page-size]").first();
    await pageSizeSelect.selectOption("all");

    const nextButton = page.locator("[data-next-page]").first();
    await expect(nextButton).toBeEnabled();

    await Promise.all([
      page.waitForURL(/list_page=2/),
      nextButton.click(),
    ]);

    const firstSerialCell = page.locator("[data-table-body] tr[data-row] td").first();
    await expect(firstSerialCell).toBeVisible();
    const serialValue = Number(String(await firstSerialCell.innerText()).trim());
    expect(Number.isFinite(serialValue)).toBeTruthy();
    expect(serialValue).toBeGreaterThan(500);
  });

  test("global loading overlay shows table/report contexts", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    await page.goto("/hr-payroll/labours/rates", {
      waitUntil: "domcontentloaded",
    });

    await page.evaluate(() => {
      window.erpLoadingOverlay?.show({ context: "table" });
    });
    const tableOverlay = page.locator(
      '[data-global-loading-overlay="true"][data-context="table"]',
    );
    await expect(tableOverlay).toBeVisible();
    await page.evaluate(() => {
      window.erpLoadingOverlay?.hide();
    });
    await expect(tableOverlay).toHaveCount(0);

    await page.goto("/reports/hr-payroll/labour-ledger", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(() => {
      window.erpLoadingOverlay?.show({ context: "report" });
    });
    const reportOverlay = page.locator(
      '[data-global-loading-overlay="true"][data-context="report"]',
    );
    await expect(reportOverlay).toBeVisible();
    await page.evaluate(() => {
      window.erpLoadingOverlay?.hide();
    });
    await expect(reportOverlay).toHaveCount(0);
  });
});
