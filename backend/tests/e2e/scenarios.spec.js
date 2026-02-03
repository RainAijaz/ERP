const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { getLinkedSize, closeDb } = require("./utils/db");

const USER_SALESMAN = process.env.E2E_USER_SALESMAN || "ahsan";

test.afterAll(async () => {
  await closeDb();
});

test.describe("Security and UX scenarios", () => {
  test("route access denied without permissions", async ({ page }) => {
    await login(page, "E2E_LIMITED");
    const usersRes = await page.goto("/administration/users", { waitUntil: "domcontentloaded" });
    expect(usersRes.status()).toBe(403);
    const branchesRes = await page.goto("/administration/branches", { waitUntil: "domcontentloaded" });
    expect(branchesRes.status()).toBe(403);
  });

  test("admin god mode can access core admin routes", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const permsRes = await page.goto("/administration/permissions", { waitUntil: "domcontentloaded" });
    expect(permsRes.status()).toBe(200);
    const rolesRes = await page.goto("/administration/roles", { waitUntil: "domcontentloaded" });
    expect(rolesRes.status()).toBe(200);
  });

  test("foreign key delete shows friendly error modal", async ({ page }) => {
    const linkedSize = await getLinkedSize();
    test.skip(!linkedSize, "No size linked to variants was found.");

    await login(page, "E2E_ADMIN");
    await page.goto("/master-data/basic-info/sizes", { waitUntil: "domcontentloaded" });

    const row = page.locator("tr", { hasText: linkedSize.name }).first();
    await expect(row).toBeVisible();
    const deleteBtn = row.locator("button[data-delete]").first();
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    const confirmModal = page.locator("[data-confirm-modal]");
    await expect(confirmModal).toBeVisible();
    await confirmModal.getByRole("button", { name: /continue/i }).click();
    await page.waitForLoadState("networkidle");

    const errorModal = page.locator("[data-ui-error-modal]");
    await expect(errorModal).toBeVisible();
    await expect(errorModal.getByText("This record is linked to other data and cannot be deleted", { exact: false })).toBeVisible();
  });

  test("concurrent session termination after user deactivation", async ({ browser }) => {
    test.skip(process.env.E2E_MUTATE !== "1", "Set E2E_MUTATE=1 to enable user deactivation test.");

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await login(pageA, "E2E_LIMITED");
    await login(pageB, "E2E_ADMIN");
    await pageB.goto("/administration/users", { waitUntil: "domcontentloaded" });

    const row = pageB.locator("tr", { hasText: USER_SALESMAN }).first();
    await expect(row).toBeVisible();
    const toggleBtn = row.locator("button[data-toggle]").first();
    await toggleBtn.click();
    const confirmModal = pageB.locator("[data-confirm-modal]");
    await expect(confirmModal).toBeVisible();
    await confirmModal.getByRole("button", { name: /continue/i }).click();
    await pageB.waitForLoadState("networkidle");

    await pageA.goto("/master-data/parties", { waitUntil: "domcontentloaded" });
    await expect(pageA).toHaveURL(/\/auth\/login/i);

    // Reactivate user to avoid leaving the account disabled.
    await pageB.goto("/administration/users", { waitUntil: "domcontentloaded" });
    const rowAfter = pageB.locator("tr", { hasText: USER_SALESMAN }).first();
    const toggleBtnAfter = rowAfter.locator("button[data-toggle]").first();
    await toggleBtnAfter.click();
    await confirmModal.getByRole("button", { name: /continue/i }).click();
    await pageB.waitForLoadState("networkidle");

    await ctxA.close();
    await ctxB.close();
  });

});
