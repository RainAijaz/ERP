const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Supplier Balances branch dropdown", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const res = await page.goto("/reports/purchases/supplier-balances", {
      waitUntil: "domcontentloaded",
    });
    test.skip(res.status() !== 200, "Supplier balances page not accessible.");
  });

  test("branch dropdown trigger opens the panel", async ({ page }) => {
    const wrap = page.locator("[data-multi-select]").filter({
      has: page.locator("[data-multi-hidden]"),
    });
    const trigger = wrap.locator("[data-multi-trigger]");
    const panel = wrap.locator("[data-multi-panel]");

    await expect(trigger).toBeVisible();
    await expect(panel).toBeHidden();

    await trigger.click();

    await expect(panel).toBeVisible({ timeout: 3000 });
  });

  test("branch dropdown stays open after single click", async ({ page }) => {
    const wrap = page.locator("[data-multi-select]").filter({
      has: page.locator("[data-multi-hidden]"),
    });
    const trigger = wrap.locator("[data-multi-trigger]");
    const panel = wrap.locator("[data-multi-panel]");

    await trigger.click();
    // Wait a short moment to make sure a duplicate listener doesn't close it
    await page.waitForTimeout(300);

    await expect(panel).toBeVisible();
  });

  test("branch dropdown shows at least the All Branches option", async ({
    page,
  }) => {
    const wrap = page.locator("[data-multi-select]").filter({
      has: page.locator("[data-multi-hidden]"),
    });
    const trigger = wrap.locator("[data-multi-trigger]");
    const panel = wrap.locator("[data-multi-panel]");

    await trigger.click();
    await expect(panel).toBeVisible();

    const allCheckbox = panel.locator('input[type="checkbox"][value="__ALL__"]');
    await expect(allCheckbox).toBeVisible();
  });

  test("selecting a branch checkbox updates the hidden input", async ({
    page,
  }) => {
    const wrap = page.locator("[data-multi-select]").filter({
      has: page.locator("[data-multi-hidden]"),
    });
    const trigger = wrap.locator("[data-multi-trigger]");
    const panel = wrap.locator("[data-multi-panel]");
    const hidden = wrap.locator("[data-multi-hidden]");

    await trigger.click();
    await expect(panel).toBeVisible();

    const nonAllCheckboxes = panel.locator(
      'input[type="checkbox"]:not([value="__ALL__"])',
    );
    const count = await nonAllCheckboxes.count();

    if (count === 0) {
      test.skip(true, "No branch options to select (single-branch setup).");
      return;
    }

    const firstBranchCb = nonAllCheckboxes.first();
    const branchValue = await firstBranchCb.getAttribute("value");
    await firstBranchCb.click();

    // Hidden input should contain the selected branch id
    await expect(hidden).toHaveValue(branchValue, { timeout: 2000 });
  });

  test("clicking All Branches deselects individual branches", async ({
    page,
  }) => {
    const wrap = page.locator("[data-multi-select]").filter({
      has: page.locator("[data-multi-hidden]"),
    });
    const trigger = wrap.locator("[data-multi-trigger]");
    const panel = wrap.locator("[data-multi-panel]");
    const hidden = wrap.locator("[data-multi-hidden]");

    await trigger.click();
    await expect(panel).toBeVisible();

    const nonAllCheckboxes = panel.locator(
      'input[type="checkbox"]:not([value="__ALL__"])',
    );
    const count = await nonAllCheckboxes.count();
    if (count === 0) {
      test.skip(true, "No branch options (single-branch setup).");
      return;
    }

    // Select a specific branch first
    await nonAllCheckboxes.first().click();

    // Now click All Branches
    const allCb = panel.locator('input[type="checkbox"][value="__ALL__"]');
    await allCb.click();

    // Hidden input should be empty (all branches = no specific ids)
    await expect(hidden).toHaveValue("", { timeout: 2000 });
  });

  test("panel closes when clicking outside", async ({ page }) => {
    const wrap = page.locator("[data-multi-select]").filter({
      has: page.locator("[data-multi-hidden]"),
    });
    const trigger = wrap.locator("[data-multi-trigger]");
    const panel = wrap.locator("[data-multi-panel]");

    await trigger.click();
    await expect(panel).toBeVisible();

    // Click somewhere outside the dropdown
    await page.locator("h1").click();

    await expect(panel).toBeHidden({ timeout: 2000 });
  });

  test("panel closes on Escape key", async ({ page }) => {
    const wrap = page.locator("[data-multi-select]").filter({
      has: page.locator("[data-multi-hidden]"),
    });
    const trigger = wrap.locator("[data-multi-trigger]");
    const panel = wrap.locator("[data-multi-panel]");

    await trigger.click();
    await expect(panel).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(panel).toBeHidden({ timeout: 2000 });
  });
});
