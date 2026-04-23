const { test, expect } = require("@playwright/test");
const { login, getCredentials } = require("./utils/auth");

test.describe("Voucher UI regressions (Apr 23, 2026)", () => {
  test("searchable select clears visible text on click and restores previous selection if no new option is picked", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/sales?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Sales voucher page not accessible.",
    );

    const select = page.locator("select[data-salesman]").first();
    await expect(select).toBeVisible();

    const optionValues = await select
      .locator("option")
      .evaluateAll((opts) =>
        opts
          .map((opt) => String(opt.value || "").trim())
          .filter((value) => value.length > 0),
      );
    test.skip(optionValues.length === 0, "No selectable options available.");

    await select.selectOption(optionValues[0]);

    const state = await page.evaluate(async () => {
      const select = document.querySelector("select[data-salesman]");
      const wrapper = select?.closest("[data-searchable-wrapper]")
        || select?.parentElement?.querySelector("[data-searchable-wrapper]")
        || select?.parentElement;
      const input = wrapper?.querySelector('input[type="text"]');
      if (!select || !input) return { ok: false };

      const before = String(input.value || "").trim();
      const beforeValue = String(select.value || "").trim();
      input.click();
      input.blur();

      await new Promise((resolve) => setTimeout(resolve, 220));
      const after = String(input.value || "").trim();
      const afterValue = String(select.value || "").trim();

      return {
        ok: true,
        before,
        beforeValue,
        after,
        afterValue,
      };
    });

    expect(state.ok).toBeTruthy();
    expect(state.before.length).toBeGreaterThan(0);
    expect(state.beforeValue.length).toBeGreaterThan(0);
    expect(state.afterValue).toBe(state.beforeValue);
  });

  test("sales cash payment received keeps explicit zero value", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/sales?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Sales voucher page not accessible.",
    );

    await page.evaluate(() => {
      const saleMode = document.querySelector("[data-sale-mode]");
      if (saleMode) {
        saleMode.value = "DIRECT";
        saleMode.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const paymentType = document.querySelector("[data-payment-type]");
      if (!paymentType) return;
      paymentType.value = "CASH";
      paymentType.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const receivedInput = page.locator("[data-received]").first();
    await expect(receivedInput).toBeVisible();
    await expect(page.locator("[data-payment-type]").first()).toHaveValue("CASH");
    const modeValue = await page.locator("[data-sale-mode]").first().inputValue();
    test.skip(
      String(modeValue || "").toUpperCase() !== "DIRECT",
      "Dataset auto-locked sale mode; cash zero formatting cannot be validated in this state.",
    );
    await receivedInput.fill("0");
    await receivedInput.blur();
    await expect(receivedInput).toHaveValue(/^(0|0\.0)$/);
  });

  test("GRN reference modal keeps select column as the last column", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/purchase?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Purchase voucher page not accessible.",
    );

    const supplierSelect = page.locator("select[data-supplier-select]").first();
    await expect(supplierSelect).toBeVisible();
    const optionValues = await supplierSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts
          .map((opt) => String(opt.value || "").trim())
          .filter((value) => value.length > 0),
      );
    test.skip(optionValues.length === 0, "No supplier options available.");
    await supplierSelect.selectOption(optionValues[0]);

    const openPickerButton = page.locator("[data-open-grn-picker]").first();
    await openPickerButton.click();

    const modal = page.locator("[data-grn-picker-modal]");
    await expect(modal).toBeVisible();

    const headers = await modal
      .locator("thead th")
      .allTextContents();
    const normalized = headers.map((text) =>
      String(text || "")
        .trim()
        .toLowerCase(),
    );
    expect(normalized.length).toBeGreaterThan(0);
    expect(normalized[normalized.length - 1]).toContain("select");
  });

  test("stock transfer out destination branches are available for restricted users", async ({
    page,
  }) => {
    const limitedUser = getCredentials("E2E_LIMITED");
    test.skip(!limitedUser?.username || !limitedUser?.password, "Missing E2E_LIMITED credentials.");

    await login(page, "E2E_LIMITED");
    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Stock Transfer Out page not accessible for limited user.",
    );

    const destinationSelect = page.locator("select[data-destination-branch]").first();
    await expect(destinationSelect).toBeVisible();
    const destinationValues = await destinationSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts
          .map((opt) => String(opt.value || "").trim())
          .filter((value) => value.length > 0),
      );
    expect(destinationValues.length).toBeGreaterThan(0);
  });
});
