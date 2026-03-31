const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Sales voucher row bootstrap", () => {
  const cases = [
    {
      name: "sales voucher view renders first editable row",
      url: "/vouchers/sales?voucher_no=1&view=1",
      skipHeading: /sales voucher/i,
      rowSkuSelector: '[data-lines-body] tr select[data-f="sku_id"]',
      rowLineSelector: "[data-lines-body] tr",
    },
    {
      name: "sales order view renders first editable row",
      url: "/vouchers/sales-order?voucher_no=1&view=1",
      skipHeading: /sales order/i,
      rowSkuSelector: '[data-lines-body] tr select[data-f="sku_id"]',
      rowLineSelector: "[data-lines-body] tr",
    },
  ];

  for (const scenario of cases) {
    test(scenario.name, async ({ page }) => {
      const browserErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") browserErrors.push(`console:${msg.text()}`);
      });
      page.on("pageerror", (err) => {
        browserErrors.push(`pageerror:${String(err?.message || err)}`);
      });

      await login(page, "E2E_ADMIN");
      const response = await page.goto(scenario.url, {
        waitUntil: "domcontentloaded",
      });
      test.skip(
        !response || response.status() !== 200,
        `${scenario.url} not accessible.`,
      );

      await expect(
        page.getByRole("heading", { name: scenario.skipHeading }),
      ).toBeVisible();

      const rowCount = await page.locator(scenario.rowLineSelector).count();
      const hasSkuInput = await page
        .locator(scenario.rowSkuSelector)
        .first()
        .isVisible()
        .catch(() => false);

      expect(
        rowCount,
        `Expected at least 1 row in tbody for ${scenario.url}. Browser errors: ${browserErrors.join(" | ")}`,
      ).toBeGreaterThan(0);
      expect(
        hasSkuInput,
        `Expected first row SKU select to be visible for ${scenario.url}. Browser errors: ${browserErrors.join(" | ")}`,
      ).toBeTruthy();

      expect(
        browserErrors,
        `Page should not have runtime script errors for ${scenario.url}`,
      ).toEqual([]);
    });
  }
});
