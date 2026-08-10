const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

// Regression spec: a negative Pair Discount must render in the line Total
// Discount cell and in the footer/summary totals.
//
// The line amount was always correct, but f1OrBlank() blanked any value <= 0,
// so a negative Total Discount rendered as an empty cell while the footer
// quietly netted it in -- making it look like the negative was never applied.
test.describe("Sales Order negative pair discount display", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  test("negative pair discount renders in Total Discount and nets into totals", async ({
    page,
  }) => {
    await page.goto("/vouchers/sales-order", {
      waitUntil: "domcontentloaded",
    });

    const firstRow = page.locator("tbody tr[data-i]").first();
    await expect(firstRow).toBeVisible();

    // Pick the first real article so rate/qty fields become live.
    const articleSelect = firstRow.locator('[data-f="sku_id"]');
    const optionValue = await articleSelect
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await articleSelect.selectOption(optionValue);

    const qty = firstRow.locator('[data-f="sale_qty"]');
    await qty.fill("1");
    await qty.dispatchEvent("input");
    await qty.dispatchEvent("change");

    const rate = firstRow.locator('[data-f="pair_rate"]');
    await rate.fill("380");
    await rate.dispatchEvent("input");
    await rate.dispatchEvent("change");

    const pairDiscount = firstRow.locator('[data-f="pair_discount"]');
    await pairDiscount.fill("-3");
    await pairDiscount.dispatchEvent("input");
    await pairDiscount.dispatchEvent("change");

    const totalDiscount = firstRow.locator('[data-f="total_discount"]');
    const totalAmount = firstRow.locator('[data-f="total_amount"]');

    const tdValue = await totalDiscount.inputValue();
    const taValue = await totalAmount.inputValue();
    const pairs = Number(taValue) / (380 - -3);

    console.log(
      `[verify] pairs=${pairs} total_discount="${tdValue}" total_amount="${taValue}"`,
    );

    // THE FIX: this cell used to render "" for any negative value.
    expect(tdValue).not.toBe("");
    expect(Number(tdValue)).toBeLessThan(0);
    expect(Number(tdValue)).toBeCloseTo(pairs * -3, 1);

    // The amount must be rate + |discount| per pair (negative discount = uplift).
    expect(Number(taValue)).toBeCloseTo(pairs * 383, 1);

    // Footer + summary must show the negative net, not hide themselves.
    const footer = page.locator("[data-lines-discount-total]");
    const summary = page.locator("[data-summary-discount]");
    const footerValue = await footer.inputValue();
    console.log(
      `[verify] footer="${footerValue}" summary="${await summary.inputValue()}"`,
    );
    expect(footerValue).not.toBe("");
    expect(Number(footerValue)).toBeCloseTo(pairs * -3, 1);
    await expect(page.locator("[data-total-discount-row]")).toBeVisible();

    // Flip to a positive discount: behaviour must be unchanged from before.
    await pairDiscount.fill("30");
    await pairDiscount.dispatchEvent("input");
    await pairDiscount.dispatchEvent("change");
    expect(Number(await totalDiscount.inputValue())).toBeCloseTo(pairs * 30, 1);
    expect(Number(await footer.inputValue())).toBeCloseTo(pairs * 30, 1);

    // Zero discount must still blank the cell and hide the summary row.
    await pairDiscount.fill("");
    await pairDiscount.dispatchEvent("input");
    await pairDiscount.dispatchEvent("change");
    expect(await totalDiscount.inputValue()).toBe("");
    expect(await footer.inputValue()).toBe("");
    await expect(page.locator("[data-total-discount-row]")).toBeHidden();
  });
});
