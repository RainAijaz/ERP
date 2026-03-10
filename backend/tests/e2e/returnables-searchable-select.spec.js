const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getLatestOpenReturnableOutwardReference,
  getTwoOpenReturnableOutwardReferencesForSameVendor,
  closeDb,
} = require("./utils/db");

const toDisplayDate = (value) => {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const iso = value.toISOString().slice(0, 10);
    return `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : text;
};

const collectFormSelectState = async (page) =>
  page.evaluate(() => {
    const form = document.querySelector("[data-returnable-form]");
    if (!form) return null;

    const selects = Array.from(form.querySelectorAll("select"));
    const visibleOrWrapped = selects.filter(
      (el) => el.classList.contains("sr-only") || el.offsetParent !== null,
    );
    const missingOptIn = visibleOrWrapped
      .filter((el) => String(el.dataset.searchableSelect || "").toLowerCase() !== "true")
      .map((el) => el.getAttribute("name") || el.getAttribute("data-row-field") || "(unnamed)");
    const notReady = visibleOrWrapped
      .filter((el) => el.dataset.searchableReady !== "true")
      .map((el) => el.getAttribute("name") || el.getAttribute("data-row-field") || "(unnamed)");

    return {
      total: visibleOrWrapped.length,
      wrappers: form.querySelectorAll("[data-searchable-wrapper]").length,
      missingOptIn,
      notReady,
    };
  });

const chooseFirstSearchableValue = async (wrapper, label) => {
  const input = wrapper.locator("input").first();
  const select = wrapper.locator("select").first();

  await expect(input).toBeVisible();
  for (let i = 0; i < 4; i += 1) {
    await input.click();
    await input.press("Enter");
    const value = String((await select.inputValue()) || "").trim();
    if (value) return value;
    await input.press("ArrowDown");
    await input.press("Enter");
    const movedValue = String((await select.inputValue()) || "").trim();
    if (movedValue) return movedValue;
  }

  throw new Error(`No non-empty selectable value found for ${label}`);
};

test.describe("Returnables searchable selects", () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test("dispatch voucher uses searchable-select for all dropdowns", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Returnable dispatch page not accessible for admin.");

    await page.waitForSelector("[data-returnable-form]");
    await page.waitForSelector('select[data-row-field="asset_id"]');
    await page.waitForTimeout(200);

    const state = await collectFormSelectState(page);
    expect(state).not.toBeNull();
    expect(state.total).toBeGreaterThan(0);
    expect(state.wrappers).toBeGreaterThanOrEqual(state.total);
    expect(state.missingOptIn).toEqual([]);
    expect(state.notReady).toEqual([]);
  });

  test("dispatch Enter on last row field appends next row and focuses asset dropdown", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Returnable dispatch page not accessible for admin.");

    await page.waitForSelector("[data-returnable-form]");
    await page.waitForSelector('[data-lines-body] tr select[data-row-field="asset_id"]');

    const requiredOptions = await page.evaluate(() => {
      const findFirstOption = (selector) => {
        const select = document.querySelector(selector);
        if (!select) return null;
        const option = Array.from(select.options).find((opt) => String(opt.value || "").trim().length > 0);
        if (!option) return null;
        return {
          value: String(option.value || ""),
          label: String(option.textContent || "").trim(),
        };
      };
      return {
        asset: findFirstOption('select[data-row-field="asset_id"]'),
        condition: findFirstOption('select[data-row-field="condition_out_code"]'),
      };
    });

    test.skip(!requiredOptions?.asset || !requiredOptions?.condition, "Dispatch dropdown options not available.");

    const firstRow = page.locator("[data-lines-body] tr").first();
    const firstRowAssetInput = firstRow.locator("[data-searchable-wrapper] input").first();

    await firstRowAssetInput.click();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    const firstRowDescriptionInput = firstRow.locator('input[data-row-field="item_description"]');
    await firstRowDescriptionInput.click();
    await firstRowDescriptionInput.fill("E2E Returnable Dispatch");
    await firstRowDescriptionInput.press("Enter");

    const firstRowQtyInput = firstRow.locator('input[data-row-field="qty"]');
    await firstRowQtyInput.click();
    await firstRowQtyInput.fill("1");
    const firstRowConditionInput = firstRow
      .locator('select[data-row-field="condition_out_code"]')
      .locator("xpath=ancestor::*[@data-searchable-wrapper][1]//input");
    await firstRowConditionInput.click();
    await firstRowConditionInput.press("Enter");
    await firstRowConditionInput.press("Enter");
    await firstRowConditionInput.press("Enter");
    await expect(page.locator("[data-lines-body] tr")).toHaveCount(2);

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement)) return null;
          const row = active.closest("tr");
          const rows = row?.parentElement ? Array.from(row.parentElement.querySelectorAll("tr")) : [];
          const rowIndex = row ? rows.indexOf(row) : -1;
          const wrapper = active.closest("[data-searchable-wrapper]");
          const linkedSelect = wrapper?.querySelector("select[data-row-field]");
          return {
            rowIndex,
            fieldKey: String(linkedSelect?.dataset?.rowField || active.getAttribute("data-row-field") || ""),
          };
        }),
      )
      .toEqual({
        rowIndex: 1,
        fieldKey: "asset_id",
      });
  });

  test("dispatch missing vendor shows error without page reload or open dropdowns", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Returnable dispatch page not accessible for admin.");

    await page.waitForSelector("[data-returnable-form]");
    await page.waitForSelector('[data-lines-body] tr select[data-row-field="asset_id"]');

    const reasonWrapper = page
      .locator("[data-searchable-wrapper]")
      .filter({ has: page.locator('select[name="reason_code"]') })
      .first();
    await chooseFirstSearchableValue(reasonWrapper, "reason_code");

    const voucherDateInput = page.locator('input[name="voucher_date"]').first();
    const expectedDateInput = page.locator('input[name="expected_return_date"]').first();
    const voucherDateValue = await voucherDateInput.inputValue();
    const voucherDate = new Date(`${voucherDateValue}T00:00:00`);
    const expectedDate = new Date(voucherDate.getTime());
    expectedDate.setDate(expectedDate.getDate() + 1);
    const yyyy = expectedDate.getFullYear();
    const mm = String(expectedDate.getMonth() + 1).padStart(2, "0");
    const dd = String(expectedDate.getDate()).padStart(2, "0");
    await expectedDateInput.fill(`${yyyy}-${mm}-${dd}`);

    const firstRow = page.locator("[data-lines-body] tr").first();
    const assetWrapper = firstRow.locator("[data-searchable-wrapper]").first();
    await chooseFirstSearchableValue(assetWrapper, "asset_id");

    const updatedFirstRow = page.locator("[data-lines-body] tr").first();
    const qtyInput = updatedFirstRow.locator('input[data-row-field="qty"]').first();
    await qtyInput.fill("1");

    const conditionWrapper = updatedFirstRow.locator("[data-searchable-wrapper]").nth(1);
    await chooseFirstSearchableValue(conditionWrapper, "condition_out_code");

    const sentinel = `sentinel-${Date.now()}`;
    await page.evaluate((value) => {
      window.__voucherSubmitSentinel = value;
    }, sentinel);

    await page.locator("[data-enter-submit]").click();

    await expect(page.locator("[data-ui-error-modal]")).toBeVisible();
    await expect(page.locator("[data-ui-error-message]")).toHaveText(/Vendor is required/i);

    const postSubmitState = await page.evaluate(() => {
      const openMenus = Array.from(document.querySelectorAll("[data-searchable-wrapper] div.z-50"))
        .filter((node) => !node.classList.contains("hidden"))
        .length;
      return {
        sentinel: window.__voucherSubmitSentinel || null,
        openMenus,
      };
    });

    expect(postSubmitState.sentinel).toBe(sentinel);
    expect(postSubmitState.openMenus).toBe(0);
  });

  test("receipt voucher uses searchable-select for all dropdowns", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-receipt?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Returnable receipt page not accessible for admin.");

    await page.waitForSelector("[data-returnable-form]");
    await page.waitForTimeout(200);

    const state = await collectFormSelectState(page);
    expect(state).not.toBeNull();
    expect(state.total).toBeGreaterThan(0);
    expect(state.wrappers).toBeGreaterThanOrEqual(state.total);
    expect(state.missingOptIn).toEqual([]);
    expect(state.notReady).toEqual([]);
  });

  test("receipt outward reference modal shows voucher date for open outward rows", async ({ page }) => {
    const branch = await getBranch();
    const openOutward = await getLatestOpenReturnableOutwardReference({
      branchId: Number(branch?.id || 0) || null,
    });
    test.skip(!openOutward, "No open returnable outward reference with pending quantity found.");
    const expectedDisplayDate = toDisplayDate(openOutward.voucher_date);

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-receipt?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Returnable receipt page not accessible for admin.");

    await page.waitForSelector("[data-returnable-form]");
    await page.locator('select[name="vendor_party_id"]').selectOption(String(openOutward.vendor_party_id));
    await page.locator("[data-outward-picker-open]").click();
    await page.waitForSelector('[data-outward-picker-modal][aria-hidden="false"]');

    const matchingRow = page
      .locator("[data-outward-picker-body] tr")
      .filter({ hasText: String(openOutward.voucher_no) })
      .first();
    await expect(matchingRow).toBeVisible();
    await expect(matchingRow.locator("td").nth(1)).toHaveText(expectedDisplayDate);

    if (Number.isInteger(Number(openOutward.pending_qty || 0))) {
      const expectedQty = String(Number(openOutward.pending_qty || 0));
      await expect(matchingRow.locator("td").nth(3)).toHaveText(expectedQty);
      await expect(matchingRow.locator('input[data-picker-field="receive_qty"]')).toHaveValue(expectedQty);
    }

    await matchingRow.locator('input[data-picker-field="selected"]').check();
    await page.locator("[data-outward-picker-apply]").click();

    const receiptRow = page.locator("[data-lines-body] tr").first();
    await expect(receiptRow).toBeVisible();
    await expect(receiptRow.locator("[data-remove-row]")).toBeVisible();
  });

  test("receipt outward reference modal shows specific error when multiple vouchers are selected", async ({ page }) => {
    test.setTimeout(60000);
    const branch = await getBranch();
    const outwards = await getTwoOpenReturnableOutwardReferencesForSameVendor({
      branchId: Number(branch?.id || 0) || null,
    });
    test.skip(outwards.length < 2, "Need at least two open outward vouchers for the same vendor.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-receipt?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Returnable receipt page not accessible for admin.");

    await page.waitForSelector("[data-returnable-form]");
    await page.locator('select[name="vendor_party_id"]').selectOption(String(outwards[0].vendor_party_id));
    await page.locator("[data-outward-picker-open]").click();
    await page.waitForSelector('[data-outward-picker-modal][aria-hidden="false"]');

    const expectedMessage = "Select outward reference lines from a single voucher.";
    let dialogMessage = "";
    page.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept();
    });
    for (const row of outwards) {
      const matchingRow = page
        .locator("[data-outward-picker-body] tr")
        .filter({ hasText: String(row.voucher_no) })
        .first();
      await expect(matchingRow).toBeVisible();
      await matchingRow.locator('input[data-picker-field="selected"]').check();
    }

    await page.evaluate(() => {
      const button = document.querySelector("[data-outward-picker-apply]");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Apply button not found");
      button.click();
    });
    await expect.poll(() => dialogMessage).toBe(expectedMessage);
  });
});
