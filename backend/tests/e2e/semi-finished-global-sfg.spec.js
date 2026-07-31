// Covers the "Global" toggle on the Semi-Finished master screen.
//
// A global SFG is a shared component available to every article. It must carry NO
// item_usage rows, because syncSfgVariantsFromFinished mirrors a linked article's
// sizes/colours onto the SFG and would generate one SKU per size per colour per
// article. The server enforces this independently; these tests pin the UI so the
// rule is visible to whoever is filling the form in.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const openCreateModal = async (page) => {
  await page.goto("/master-data/products/semi-finished", { waitUntil: "domcontentloaded" });
  const addButton = page
    .locator('[data-modal-open], button:has-text("Add"), a:has-text("Add")')
    .first();
  await addButton.click({ force: true });
  await page.waitForTimeout(500);
};

test.describe("Semi-finished Global toggle", () => {
  test.describe.configure({ mode: "serial" });

  test("ticking Global disables and clears the Usage picker", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openCreateModal(page);

    const toggle = page.locator("[data-global-sfg-toggle]");
    const usage = page.locator('[data-field="fg_ids"]');
    await expect(toggle).toHaveCount(1);
    await expect(usage).toHaveCount(1);

    // Usage starts editable for a normal (non-global) semi-finished item.
    expect(await usage.isDisabled()).toBe(false);

    // Pick something first, so we can prove ticking Global clears it.
    const firstValue = await usage.evaluate((node) => {
      const opt = Array.from(node.options || []).find((o) => String(o.value || "").trim());
      return opt ? String(opt.value) : "";
    });
    if (firstValue) await usage.selectOption(firstValue, { force: true });

    await toggle.check({ force: true });
    await page.waitForTimeout(400);

    expect(await usage.isDisabled()).toBe(true);
    const stillSelected = await usage.evaluate((node) =>
      Array.from(node.options || []).filter((o) => o.selected).length,
    );
    expect(stillSelected).toBe(0);
  });

  test("unticking Global makes the Usage picker editable again", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openCreateModal(page);

    const toggle = page.locator("[data-global-sfg-toggle]");
    const usage = page.locator('[data-field="fg_ids"]');

    await toggle.check({ force: true });
    await page.waitForTimeout(300);
    expect(await usage.isDisabled()).toBe(true);

    await toggle.uncheck({ force: true });
    await page.waitForTimeout(300);
    expect(await usage.isDisabled()).toBe(false);
  });
});
