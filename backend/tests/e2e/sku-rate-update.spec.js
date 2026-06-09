const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const skuPageUrl = "/master-data/products/skus?item_type=FG";

const parseRate = (value) => {
  const numeric = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(numeric) ? numeric : null;
};

test.describe("SKU rate updates", () => {
  test("admin can save a rate change from the SKU page", async ({ page }) => {
    test.setTimeout(120000);
    await login(page, "E2E_ADMIN");

    await page.goto(skuPageUrl, { waitUntil: "domcontentloaded" });

    const editButtons = page.locator('[data-modal-open][data-mode="edit_rates"]');
    await expect(editButtons.first()).toBeVisible();

    const modal = page.locator("#modal-shell");
    await editButtons.first().click();
    await expect(modal).toBeVisible();
    await expect(page.locator("#edit-rates-container")).toBeVisible();

    const firstRateInput = page
      .locator("#bulk-edit-list input[name='new_rates']")
      .first();
    await expect(firstRateInput).toBeVisible();

    const originalRateRaw = await firstRateInput.inputValue();
    const originalRate = parseRate(originalRateRaw);
    test.skip(originalRate === null, "No editable SKU rate found on the page.");

    const updatedRate = Number((originalRate + 1).toFixed(2));
    await firstRateInput.fill(String(updatedRate));

    const submitButton = modal.getByRole("button", { name: /save/i });
    await expect(submitButton).toBeVisible();
    await submitButton.click();

    await expect(page).toHaveURL(/success=true/);
    await page.reload({ waitUntil: "domcontentloaded" });

    await editButtons.first().click();
    await expect(page.locator("#edit-rates-container")).toBeVisible();

    const refreshedRateInput = page
      .locator("#bulk-edit-list input[name='new_rates']")
      .first();
    await expect(refreshedRateInput).toHaveValue(String(updatedRate));

    await refreshedRateInput.fill(String(originalRate));
    await modal.getByRole("button", { name: /save/i }).click();
    await expect(page).toHaveURL(/success=true/);
  });
});