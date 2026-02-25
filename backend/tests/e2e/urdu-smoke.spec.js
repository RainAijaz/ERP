const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Urdu localization smoke", () => {
  test("shows core Urdu labels on financial and permissions pages", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    await page.goto("/reports/financial/voucher_register?lang=ur&voucher_type=cash&report_mode=details", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("شروع تاریخ")).toBeVisible();
    await expect(page.getByText("اختتامی تاریخ")).toBeVisible();
    await expect(page.getByRole("button", { name: "لوڈ", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "پرنٹ" })).toBeVisible();
    await expect(page.getByRole("button", { name: "ڈاؤن لوڈ" })).toBeVisible();

    await page.goto("/vouchers/bank?lang=ur", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "بینک ووچر" })).toBeVisible();

    await page.goto("/administration/permissions?lang=ur", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "اجازتیں" })).toBeVisible();
  });
});
