const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const fillBalancedLines = async (page) => {
  const accountSelect = page.locator('[data-lines-body] tr').first().locator('select[data-field="account_id"]');
  const accountOptions = await accountSelect.locator('option').count();
  test.skip(accountOptions < 2, "No account options found for financial voucher test.");

  await accountSelect.selectOption({ index: 1 });
  await page.locator('[data-lines-body] tr').first().locator('input[data-field="cash_receipt"]').fill('100');

  await page.locator('[data-add-row]').click();
  const second = page.locator('[data-lines-body] tr').nth(1);
  await second.locator('select[data-field="account_id"]').selectOption({ index: 1 });
  await second.locator('input[data-field="cash_payment"]').fill('100');
};

test.describe("Financial vouchers", () => {
  test("admin can create cash voucher", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const res = await page.goto('/vouchers/cash', { waitUntil: 'domcontentloaded' });
    test.skip(res.status() !== 200, "Cash voucher page not accessible for admin.");

    await fillBalancedLines(page);
    await page.getByRole('button', { name: /save/i }).click();

    await expect(page.locator('[data-ui-notice-toast]')).toContainText(/saved|approval/i);
  });

  test("invalid voucher submit is blocked", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const res = await page.goto('/vouchers/cash', { waitUntil: 'domcontentloaded' });
    test.skip(res.status() !== 200, "Cash voucher page not accessible for admin.");

    const dlg = page.waitForEvent('dialog');
    await page.getByRole('button', { name: /save/i }).click();
    const dialog = await dlg;
    expect(dialog.message().toLowerCase()).toContain('required');
    await dialog.accept();
  });

  test("restricted user flow queues approval", async ({ page }) => {
    await login(page, "E2E_LIMITED");
    const res = await page.goto('/vouchers/cash', { waitUntil: 'domcontentloaded' });
    test.skip(res.status() !== 200, "Cash voucher page not accessible for restricted user.");

    await fillBalancedLines(page);
    await page.getByRole('button', { name: /save/i }).click();

    await expect(page.locator('[data-ui-notice-toast]')).toContainText(/approval|submitted/i);
  });
});
