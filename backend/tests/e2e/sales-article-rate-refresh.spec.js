const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const toNum = (value) => {
  const normalized = String(value || "").replace(/,/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

test.describe("Sales article change rate refresh", () => {
  test("switching article updates pair rate on the same row", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/sales?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Sales voucher page not accessible.",
    );

    const firstRow = page.locator("[data-lines-body] tr[data-i]").first();
    await expect(firstRow).toBeVisible();

    const articleSelect = firstRow.locator('select[data-f="sku_id"]').first();
    await expect(articleSelect).toBeVisible();

    const articleValues = await articleSelect
      .locator("option")
      .evaluateAll((options) =>
        options
          .map((opt) => String(opt.value || "").trim())
          .filter((value) => /^\d+$/.test(value)),
      );
    const uniqueValues = [...new Set(articleValues)];
    test.skip(
      uniqueValues.length < 2,
      "Need at least two article options to validate rate refresh.",
    );

    const pairRateInput = firstRow.locator('input[data-f="pair_rate"]').first();
    await expect(pairRateInput).toBeVisible();

    await articleSelect.selectOption(uniqueValues[0]);
    await page.waitForTimeout(100);
    const firstRate = toNum(await pairRateInput.inputValue());

    await articleSelect.selectOption(uniqueValues[1]);
    await page.waitForTimeout(100);
    const secondRate = toNum(await pairRateInput.inputValue());

    expect(secondRate).not.toBe(firstRate);
  });
});
