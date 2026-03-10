const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Navigation dropdowns", () => {
  test("financial reports submenu is scrollable and not clipped on short viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 540 });
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/cash", { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Financial page not accessible for admin.");

    const financialToggle = page.locator('[data-submenu-toggle="financial"]');
    test.skip((await financialToggle.count()) === 0, "Financial nav toggle is not present.");
    await financialToggle.click();

    const reportsToggle = page.locator('[data-submenu-toggle="financial-reports"]');
    test.skip((await reportsToggle.count()) === 0, "Financial reports nav toggle is not present.");
    await reportsToggle.click();

    const menu = page.locator('[data-submenu="financial-reports"]');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(100);

    const links = menu.locator("a");
    test.skip((await links.count()) < 8, "Not enough report links visible to validate overflow behavior.");

    const metrics = await menu.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        className: el.className || "",
        overflowY: style.overflowY,
      };
    });

    expect(metrics.className).toContain("nav-scrollable");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(["auto", "scroll"]).toContain(metrics.overflowY);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight - 2);

    await menu.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(links.last()).toBeVisible();
  });

  test("groups submenu exposes product group screens without nested products flyout", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/master-data/basic-info/units", { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Master data page not accessible for admin.");

    const moduleToggle = page.locator('[data-submenu-toggle="master_data"]');
    test.skip((await moduleToggle.count()) === 0, "Master Data nav toggle is not present.");
    await moduleToggle.click();

    const basicInfoToggle = page.locator('[data-submenu-toggle="master_data-basic_information"]');
    test.skip((await basicInfoToggle.count()) === 0, "Basic Information submenu toggle is not present.");
    await basicInfoToggle.click();
    await expect(page.locator('[data-submenu="master_data-basic_information"]')).toBeVisible();

    const groupsToggle = page.locator('[data-submenu-toggle="master_data-basic_information-groups"]');
    test.skip((await groupsToggle.count()) === 0, "Groups submenu toggle is not present.");
    await groupsToggle.click();

    const groupsMenu = page.locator('[data-submenu="master_data-basic_information-groups"]');
    await expect(groupsMenu).toBeVisible();
    await expect(page.locator('[data-submenu-toggle="master_data-basic_information-groups-products"]')).toHaveCount(0);
    await expect(groupsMenu.locator('a[href="/master-data/basic-info/product-groups"]')).toBeVisible();
    await expect(groupsMenu.locator('a[href="/master-data/basic-info/product-subgroups"]')).toBeVisible();
    await expect(groupsMenu.locator('a[href="/master-data/basic-info/product-types"]')).toBeVisible();
    await expect(groupsMenu.locator('a[href="/master-data/basic-info/sales-discount-policies"]')).toBeVisible();
  });
});
