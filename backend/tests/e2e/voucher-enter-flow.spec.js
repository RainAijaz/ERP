const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Voucher Enter key focus flow", () => {
  test("purchase voucher Enter flow advances row fields in sequence", async ({
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

    const rows = page.locator("[data-lines-body] tr");
    await expect(rows.first()).toBeVisible();

    const supplierSelect = page.locator("[data-supplier-select]");
    const supplierValues = await supplierSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts.map((opt) => String(opt.value || "").trim()).filter(Boolean),
      );
    test.skip(
      !supplierValues.length,
      "No supplier options available for purchase voucher Enter-flow test.",
    );
    await supplierSelect.selectOption(supplierValues[0]);

    let firstRow = rows.first();
    let itemSelect = firstRow.locator('select[data-row-field="item"]');
    const itemValues = await itemSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts.map((opt) => String(opt.value || "").trim()).filter(Boolean),
      );
    test.skip(
      !itemValues.length,
      "No raw material options available for purchase voucher Enter-flow test.",
    );

    await itemSelect.selectOption(itemValues[0]);

    firstRow = rows.first();
    const rawInput = firstRow
      .locator("td")
      .nth(0)
      .locator("[data-searchable-wrapper] input")
      .first();
    const colorInput = firstRow
      .locator("td")
      .nth(1)
      .locator("[data-searchable-wrapper] input")
      .first();
    const sizeInput = firstRow
      .locator("td")
      .nth(2)
      .locator("[data-searchable-wrapper] input")
      .first();
    const qtyInput = firstRow.locator('input[data-row-field="qty"]').first();

    await expect(rawInput).toBeVisible();
    await rawInput.focus();
    await rawInput.press("Enter");
    await expect(colorInput).toBeFocused();

    const colorMenu = firstRow.locator("td").nth(1).locator("div.z-50").first();
    await expect(colorMenu).toBeVisible();
    await colorInput.press("Enter");
    await expect(colorMenu).toBeHidden();
    await expect(colorInput).toBeFocused();
    await colorInput.press("Enter");

    const sizeSelect = firstRow
      .locator('select[data-row-field="size"]')
      .first();
    if (await sizeSelect.isDisabled()) {
      await expect(qtyInput).toBeFocused();
      return;
    }

    const sizeMenu = firstRow.locator("td").nth(2).locator("div.z-50").first();
    await expect(sizeMenu).toBeVisible();
    await sizeInput.press("Enter");
    await expect(sizeMenu).toBeHidden();
    await expect(sizeInput).toBeFocused();
    await sizeInput.press("Enter");
    await expect(qtyInput).toBeFocused();
  });

  test("cash voucher Enter on filled receipt with empty payment creates next row", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/cash?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Cash voucher page not accessible.",
    );

    const rows = page.locator("[data-lines-body] tr");
    await expect(rows).toHaveCount(1);

    const firstRow = rows.first();
    const receiptInput = firstRow.locator('input[data-field="cash_receipt"]');
    const paymentInput = firstRow.locator('input[data-field="cash_payment"]');
    await expect(receiptInput).toBeVisible();
    await expect(paymentInput).toBeVisible();

    await receiptInput.fill("5");
    await expect(paymentInput).toHaveValue("");
    await receiptInput.focus();
    await receiptInput.press("Enter");

    await expect(rows).toHaveCount(2);
    const secondRow = rows.nth(1);
    const secondRowEntityWrapper = secondRow
      .locator("td")
      .nth(1)
      .locator("[data-searchable-wrapper]")
      .first();
    await expect(secondRowEntityWrapper).toBeVisible();
    await expect(secondRowEntityWrapper.locator("input").first()).toBeFocused();
  });

  test("cash voucher Enter on empty searchable opens dropdown before moving next", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/cash", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Cash voucher page not accessible.",
    );

    const firstRow = page.locator("[data-lines-body] tr").first();
    await expect(firstRow).toBeVisible();
    const firstRowPaymentInput = firstRow.locator(
      'input[data-field="cash_payment"]',
    );
    await expect(firstRowPaymentInput).toBeVisible();
    await firstRowPaymentInput.fill("1");
    await firstRowPaymentInput.focus();
    await firstRowPaymentInput.press("Enter");

    const secondRow = page.locator("[data-lines-body] tr").nth(1);
    await expect(secondRow).toBeVisible();

    const entitySelect = secondRow.locator('select[data-field="entity_ref"]');
    const descriptionInput = secondRow.locator(
      'input[data-field="description"]',
    );

    await expect(entitySelect).toBeVisible();
    await expect(entitySelect).toHaveValue("");
    const searchableWrapper = secondRow
      .locator("td")
      .nth(1)
      .locator("[data-searchable-wrapper]")
      .first();
    await expect(searchableWrapper).toBeVisible();
    const entitySearchInput = searchableWrapper.locator("input").first();
    await expect(entitySearchInput).toBeVisible();
    const dropdownMenu = searchableWrapper.locator("div.z-50").first();

    if (await dropdownMenu.isVisible()) {
      await entitySearchInput.press("Escape");
      await expect(dropdownMenu).toBeHidden();
    }

    await entitySearchInput.focus();
    await entitySearchInput.press("Enter");
    await expect(dropdownMenu).toBeVisible();
    await expect(descriptionInput).not.toBeFocused();

    const entityOptions = searchableWrapper.locator(
      '[data-searchable-option="true"]',
    );
    const optionCount = await entityOptions.count();
    test.skip(
      optionCount < 2,
      "Not enough entity options to verify Enter selection flow.",
    );

    await entitySearchInput.press("ArrowDown");
    await entitySearchInput.press("Enter");
    await expect(entitySelect).not.toHaveValue("");
    await expect(descriptionInput).toBeFocused();
  });

  test("cash voucher Enter moves focus for optional-empty and searchable fields", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/cash?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Cash voucher page not accessible.",
    );

    const firstRow = page.locator("[data-lines-body] tr").first();
    await expect(firstRow).toBeVisible();

    const descriptionInput = firstRow.locator(
      'input[data-field="description"]',
    );
    await expect(descriptionInput).toBeVisible();

    await descriptionInput.fill("");
    await descriptionInput.focus();
    await descriptionInput.press("Enter");

    const departmentSearchInput = firstRow
      .locator("td")
      .nth(3)
      .locator("[data-searchable-wrapper] input")
      .first();
    await expect(departmentSearchInput).toBeFocused();

    const entitySearchInput = firstRow
      .locator("td")
      .nth(1)
      .locator("[data-searchable-wrapper] input")
      .first();
    await expect(entitySearchInput).toBeVisible();

    await entitySearchInput.click();
    const entityOptions = firstRow
      .locator("td")
      .nth(1)
      .locator('[data-searchable-option="true"]');
    const optionCount = await entityOptions.count();
    test.skip(
      optionCount < 2,
      "Not enough entity options to verify Enter navigation from searchable field.",
    );

    await entitySearchInput.press("ArrowDown");
    await entitySearchInput.press("Enter");
    const entitySelect = firstRow.locator('select[data-field="entity_ref"]');
    await expect(entitySelect).not.toHaveValue("");

    await expect(descriptionInput).toBeFocused();
  });

  test("sales voucher Enter after article selection focuses and opens status dropdown", async ({
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

    const firstRow = page.locator("[data-lines-body] tr").first();
    await expect(firstRow).toBeVisible();

    const articleSelect = firstRow.locator('select[data-f="sku_id"]').first();
    await expect(articleSelect).toBeVisible();
    const articleValues = await articleSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts.map((opt) => String(opt.value || "").trim()).filter(Boolean),
      );
    test.skip(
      !articleValues.length,
      "No article options available for sales voucher Enter-flow test.",
    );

    const articleInput = firstRow
      .locator("td")
      .nth(0)
      .locator("[data-searchable-wrapper] input")
      .first();
    const articleMenu = firstRow
      .locator("td")
      .nth(0)
      .locator("div.z-50")
      .first();
    const statusInput = firstRow
      .locator("td")
      .nth(1)
      .locator("[data-searchable-wrapper] input")
      .first();
    const statusMenu = firstRow
      .locator("td")
      .nth(1)
      .locator("div.z-50")
      .first();

    await expect(articleInput).toBeVisible();
    await articleInput.click();
    await expect(articleMenu).toBeVisible();
    await articleInput.press("ArrowDown");
    await articleInput.press("Enter");

    await expect(articleSelect).not.toHaveValue("");
    await articleInput.press("Enter");
    await expect(statusInput).toBeFocused();
    await expect(statusMenu).toBeVisible();
  });
});
