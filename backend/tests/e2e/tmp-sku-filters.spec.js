const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("SKU filters", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  test("shows labour-style group/subgroup filter rows and applies group query", async ({
    page,
  }) => {
    await page.goto("/master-data/products/skus", {
      waitUntil: "domcontentloaded",
    });

    await page.locator("[data-filter-toggle]").click();
    const panel = page.locator("[data-filter-panel]");
    await expect(panel).toBeVisible();

    await expect(panel.locator('[data-filter-list="group"]')).toBeVisible();
    await expect(panel.locator('[data-filter-list="subgroup"]')).toBeVisible();
    await expect(panel.locator("[data-filter-group-mode]").first()).toBeVisible();
    await expect(panel.locator("[data-filter-subgroup-mode]").first()).toBeVisible();

    const groupSelect = panel.locator("select[data-filter-group]").first();
    const groupOptions = await groupSelect
      .locator("option")
      .evaluateAll((options) =>
        options
          .map((opt) => String(opt.value || "").trim())
          .filter((value) => value),
      );

    if (!groupOptions.length) {
      test.skip(true, "No group options available to verify query apply");
    }

    await groupSelect.selectOption(groupOptions[0]);
    await panel.locator("[data-filter-apply]").click();
    await page.waitForLoadState("domcontentloaded");

    const url = new URL(page.url());
    expect(url.searchParams.getAll("group_id")).toContain(groupOptions[0]);
  });
});
