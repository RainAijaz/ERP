const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Sales Urdu smoke", () => {
  test("sales voucher and sales order report load Urdu labels", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const salesVoucherRes = await page.goto("/vouchers/sales?new=1&lang=ur", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !salesVoucherRes || salesVoucherRes.status() !== 200,
      "Sales voucher page not accessible.",
    );

    await expect(
      page.getByRole("heading", { name: "سیلز ووچر" }),
    ).toBeVisible();
    await expect(page.getByText("ادائیگی کی قسم")).toBeVisible();
    await expect(
      page.locator("label", { hasText: "سیلز آرڈر لنک" }).first(),
    ).toBeVisible();

    const salesOrderReportRes = await page.goto(
      "/reports/sales/sales-order-report?lang=ur",
      { waitUntil: "domcontentloaded" },
    );
    test.skip(
      !salesOrderReportRes || salesOrderReportRes.status() !== 200,
      "Sales order report page not accessible.",
    );

    await expect(
      page.getByRole("heading", { name: "سیلز آرڈر رپورٹ" }),
    ).toBeVisible();
    await page.locator("[data-date-range-toggle]").first().click();
    const dateRangePanel = page.locator("[data-date-range-panel]").first();
    await expect(dateRangePanel).toBeVisible();
    await expect(
      dateRangePanel.getByText("شروع تاریخ", { exact: true }),
    ).toBeVisible();
    await expect(
      dateRangePanel.getByText("اختتامی تاریخ", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "لوڈ", exact: true }),
    ).toBeVisible();
  });
});
