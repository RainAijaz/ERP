const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Voucher Enter key focus flow", () => {
	test("cash voucher Enter on filled receipt with empty payment creates next row", async ({ page }) => {
		await login(page, "E2E_ADMIN");

		const response = await page.goto("/vouchers/cash?new=1", { waitUntil: "domcontentloaded" });
		test.skip(!response || response.status() !== 200, "Cash voucher page not accessible.");

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
		const secondRowEntityWrapper = secondRow.locator("td").nth(1).locator("[data-searchable-wrapper]").first();
		await expect(secondRowEntityWrapper).toBeVisible();
		await expect(secondRowEntityWrapper.locator("input").first()).toBeFocused();
	});

	test("cash voucher Enter on empty searchable opens dropdown before moving next", async ({ page }) => {
		await login(page, "E2E_ADMIN");

		const response = await page.goto("/vouchers/cash", { waitUntil: "domcontentloaded" });
		test.skip(!response || response.status() !== 200, "Cash voucher page not accessible.");

		const firstRow = page.locator("[data-lines-body] tr").first();
		await expect(firstRow).toBeVisible();
		const firstRowPaymentInput = firstRow.locator('input[data-field="cash_payment"]');
		await expect(firstRowPaymentInput).toBeVisible();
		await firstRowPaymentInput.fill("1");
		await firstRowPaymentInput.focus();
		await firstRowPaymentInput.press("Enter");

		const secondRow = page.locator("[data-lines-body] tr").nth(1);
		await expect(secondRow).toBeVisible();

		const entitySelect = secondRow.locator('select[data-field="entity_ref"]');
		const descriptionInput = secondRow.locator('input[data-field="description"]');

		await expect(entitySelect).toBeVisible();
		await expect(entitySelect).toHaveValue("");
		const searchableWrapper = secondRow.locator("td").nth(1).locator("[data-searchable-wrapper]").first();
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

		const entityOptions = searchableWrapper.locator('[data-searchable-option="true"]');
		const optionCount = await entityOptions.count();
		test.skip(optionCount < 2, "Not enough entity options to verify Enter selection flow.");

		await entitySearchInput.press("ArrowDown");
		await entitySearchInput.press("Enter");
		await expect(entitySelect).not.toHaveValue("");
		await expect(descriptionInput).toBeFocused();
	});

	test("cash voucher Enter moves focus for optional-empty and searchable fields", async ({ page }) => {
		await login(page, "E2E_ADMIN");

		const response = await page.goto("/vouchers/cash?new=1", { waitUntil: "domcontentloaded" });
		test.skip(!response || response.status() !== 200, "Cash voucher page not accessible.");

		const firstRow = page.locator("[data-lines-body] tr").first();
		await expect(firstRow).toBeVisible();

		const descriptionInput = firstRow.locator('input[data-field="description"]');
		await expect(descriptionInput).toBeVisible();

		await descriptionInput.fill("");
		await descriptionInput.focus();
		await descriptionInput.press("Enter");

		const departmentSearchInput = firstRow.locator('td').nth(3).locator('[data-searchable-wrapper] input').first();
		await expect(departmentSearchInput).toBeFocused();

		const entitySearchInput = firstRow.locator('td').nth(1).locator('[data-searchable-wrapper] input').first();
		await expect(entitySearchInput).toBeVisible();

		await entitySearchInput.click();
		const entityOptions = firstRow.locator('td').nth(1).locator('[data-searchable-option="true"]');
		const optionCount = await entityOptions.count();
		test.skip(optionCount < 2, "Not enough entity options to verify Enter navigation from searchable field.");

		await entitySearchInput.press("ArrowDown");
		await entitySearchInput.press("Enter");
		const entitySelect = firstRow.locator('select[data-field="entity_ref"]');
		await expect(entitySelect).not.toHaveValue("");

		await expect(descriptionInput).toBeFocused();
	});
});

