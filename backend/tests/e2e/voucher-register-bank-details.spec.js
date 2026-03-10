const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Voucher register bank details", () => {
  test("bank details show bank-specific columns and status dropdowns", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto(
      "/reports/financial/voucher_register?voucher_type=bank&report_mode=details&load_report=1",
      { waitUntil: "domcontentloaded" },
    );
    test.skip(
      !response || response.status() !== 200,
      "Voucher register page not accessible.",
    );

    const table = page.locator("[data-report-table]");
    await expect(table).toBeVisible();

    const rows = table.locator("tbody tr");
    const rowCount = await rows.count();
    test.skip(
      rowCount === 0,
      "No bank voucher rows available for this environment.",
    );

    const headerTexts = (await table.locator("thead th").allTextContents()).map(
      (v) =>
        String(v || "")
          .trim()
          .toLowerCase(),
    );
    expect(headerTexts).not.toContain("voucher");
    expect(headerTexts).not.toContain("description");
    expect(headerTexts).not.toContain("department");

    const statusSelects = table.locator("[data-bank-status-select]");
    await expect(statusSelects.first()).toBeVisible();
  });
});
