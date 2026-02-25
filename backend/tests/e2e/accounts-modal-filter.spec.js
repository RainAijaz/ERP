const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Accounts modal - type/group filtering", () => {
  test("account group options are available for EXPENSE type", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const res = await page.goto("/master-data/accounts", { waitUntil: "domcontentloaded" });
    test.skip(res.status() !== 200, "Accounts page not accessible.");

    await page.locator("[data-modal-open]").first().click();
    await expect(page.locator("[data-modal-form]")).toBeVisible();

    const allGroupSelects = await page.locator('select[data-field="subgroup_id"]').evaluateAll((nodes) =>
      nodes.map((node, idx) => ({
        idx,
        optionCount: node.options.length,
        options: Array.from(node.options).map((n) => ({
          value: n.value,
          label: (n.textContent || "").trim(),
          accountType: (n.getAttribute("data-account-type") || "").trim(),
        })),
      })),
    );

    const typeSelect = page.locator('select[data-field="account_type"]').first();
    const groupSelect = page.locator('select[data-field="subgroup_id"]').first();

    await typeSelect.selectOption("EXPENSE");

    const options = await groupSelect.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: node.value,
        label: (node.textContent || "").trim(),
        accountType: (node.getAttribute("data-account-type") || "").trim(),
      })),
    );

    const nonEmpty = options.filter((opt) => opt.value);
    expect(
      nonEmpty.length,
      `Expected at least one account group for EXPENSE. allGroupSelects=${JSON.stringify(allGroupSelects)} filteredOptions=${JSON.stringify(options)}`,
    ).toBeGreaterThan(0);
    for (const opt of nonEmpty) {
      expect(opt.accountType).toBe("EXPENSE");
    }
  });
});
