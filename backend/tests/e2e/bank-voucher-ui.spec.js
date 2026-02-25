const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Bank voucher UI", () => {
  test("searchable voucher dropdown uses keyboard-active row instead of always highlighting first row", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/cash", { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Cash voucher page not accessible.");

    const wrapper = page
      .locator("[data-searchable-wrapper]")
      .filter({ has: page.locator("select[data-header-account]") })
      .first();
    await expect(wrapper).toBeVisible();

    const input = wrapper.locator("input");
    await input.click();

    const options = wrapper.locator('[data-searchable-option="true"]');
    const optionCount = await options.count();
    test.skip(optionCount < 3, "Not enough account options to verify arrow-key shifting behavior.");

    const firstOption = options.first();
    await expect(firstOption).toHaveAttribute("data-active", "false");

    const activeOption = wrapper.locator('[data-searchable-option="true"][data-active="true"]');
    await expect(activeOption).toHaveCount(1);

    const activeTextBefore = String((await activeOption.first().textContent()) || "").trim();

    await input.press("ArrowDown");
    await expect(activeOption).toHaveCount(1);
    const activeTextAfterFirstDown = String((await activeOption.first().textContent()) || "").trim();
    expect(activeTextAfterFirstDown).not.toBe(activeTextBefore);

    await input.press("ArrowDown");
    await expect(activeOption).toHaveCount(1);
    const activeTextAfterSecondDown = String((await activeOption.first().textContent()) || "").trim();
    expect(activeTextAfterSecondDown).not.toBe(activeTextAfterFirstDown);

    await input.press("Enter");
    await expect(input).toHaveValue(activeTextAfterSecondDown);
  });

  test("auto voucher rows show clean columns and neutral status styling", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/bank?voucher_no=13&view=1", { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Bank voucher page not accessible.");

    const table = page.locator("[data-lines-table]");
    await expect(table).toBeVisible();

    const headerTexts = await table.locator("thead th").allTextContents();
    const normalizedHeaders = headerTexts.map((t) =>
      String(t || "")
        .trim()
        .toLowerCase(),
    );

    expect(normalizedHeaders).not.toContain("voucher");
    expect(normalizedHeaders).not.toContain("voucher no");

    const statusSelects = table.locator('tbody select[data-field="bank_status"]');
    const statusCount = await statusSelects.count();
    for (let i = 0; i < statusCount; i += 1) {
      const className = await statusSelects.nth(i).getAttribute("class");
      expect(String(className || "")).not.toContain("text-rose-700");
      expect(String(className || "")).toContain("text-slate-700");
    }

    const noteInput = page.locator('input[name="remarks"]');
    const note = String((await noteInput.inputValue()) || "");

    if (note.includes("Cash Voucher #19")) {
      const headerAccountId = Number((await page.locator("[data-header-account-id]").inputValue()) || 0);
      const firstEntityRef = page.locator("tbody tr").first().locator('select[data-field="entity_ref"]');
      const firstEntity = String((await firstEntityRef.inputValue()) || "");
      const firstEntityAccountId = Number(firstEntity.startsWith("ACCOUNT:") ? firstEntity.split(":")[1] : 0);

      expect(firstEntityAccountId).toBeGreaterThan(0);
      expect(firstEntityAccountId).not.toBe(headerAccountId);
    }
  });
});
