const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const viewports = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

test.describe("Branch multi-select stays open in modals", () => {
  for (const viewport of viewports) {
    test(`master data accounts modal keeps branch menu open on ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await login(page, "E2E_ADMIN");
      await page.goto("/master-data/accounts", {
        waitUntil: "domcontentloaded",
      });

      await page.locator("[data-modal-open]").first().click();
      await expect(page.locator("[data-modal]")).toBeVisible();

      const branchWrap = page
        .locator("[data-modal-form] [data-multi-select]")
        .filter({ has: page.locator('select[name="branch_ids"]') })
        .first();
      await expect(branchWrap).toBeVisible();

      const trigger = branchWrap.locator("[data-multi-trigger]");
      const menu = branchWrap.locator("[data-multi-menu]");

      await trigger.click();
      await expect(menu).toBeVisible();

      const firstOption = menu.locator("button").first();
      await expect(firstOption).toBeVisible();
      await firstOption.click();

      await expect(menu).toBeVisible();
    });

    test(`hr payroll employee modal keeps branch menu open on ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await login(page, "E2E_ADMIN");
      await page.goto("/hr-payroll/employees", {
        waitUntil: "domcontentloaded",
      });

      await page.locator("[data-modal-open]").first().click();
      await expect(page.locator("[data-modal]")).toBeVisible();

      const branchWrapper = page
        .locator("[data-modal-form] [data-searchable-wrapper]")
        .filter({ has: page.locator('select[name="branch_ids"]') })
        .first();
      await expect(branchWrapper).toBeVisible();

      const input = branchWrapper.locator('input[type="text"]');
      await input.click();

      const menu = branchWrapper.locator("div.fixed").first();
      await expect(menu).toBeVisible();

      const firstOption = menu.locator("[data-searchable-option]").first();
      await expect(firstOption).toBeVisible();
      await firstOption.click();

      await expect(menu).toBeVisible();
    });
  }
});
