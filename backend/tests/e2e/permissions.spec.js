const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { getBranch, upsertUserWithPermissions } = require("./utils/db");

const ROLE_MANAGER = process.env.E2E_ROLE_MANAGER || "Manager";
const ROLE_SALESMAN = process.env.E2E_ROLE_SALESMAN || "Salesman";
const USER_MANAGER = process.env.E2E_USER_MANAGER || "manager1";
const USER_SALESMAN = process.env.E2E_USER_SALESMAN || "ahsan";
const MANAGER_PASS = process.env.E2E_MANAGER_PASS || "Manager@123";
const LIMITED_PASS = process.env.E2E_LIMITED_PASS || "Salesman@123";

const openPermissions = async (page, mode, targetLabel) => {
  await page.goto(`/administration/permissions?type=${mode}`, { waitUntil: "domcontentloaded" });
  const selector = page.locator('select[name="target_id"]');
  await selector.selectOption({ label: targetLabel });
  await expect(page.locator("tr.permission-row").first()).toBeAttached();
  await page.getByRole("button", { name: /all modules/i }).click();
  await page.locator("#expand-all").click();
  await expect(page.locator("tr.permission-row").first()).toBeVisible();
};

const findScopeRow = (page, scopeKey) =>
  page.locator(`tr.permission-row[data-search*="${scopeKey}"]`).first();

const setAction = async (page, scopeKey, action, value) => {
  const row = findScopeRow(page, scopeKey);
  await row.scrollIntoViewIfNeeded();
  const checkbox = row.locator(`input.permission-action[data-action="${action}"]`);
  const count = await checkbox.count();
  if (count === 0) {
    if (!value) return;
    throw new Error(`Missing action ${action} for ${scopeKey}`);
  }
  const current = await checkbox.isChecked();
  if (current !== value) {
    await checkbox.click();
  }
};

const setScopePermissions = async (page, scopeKey, permissions) => {
  const values = {
    can_view: Boolean(permissions.view),
    can_navigate: Boolean(permissions.navigate),
    can_create: Boolean(permissions.create),
    can_edit: Boolean(permissions.edit),
    can_delete: Boolean(permissions.delete),
    can_hard_delete: Boolean(permissions.hardDelete),
    can_approve: Boolean(permissions.approve),
    can_print: Boolean(permissions.print),
  };

  for (const [action, value] of Object.entries(values)) {
    await setAction(page, scopeKey, action, value);
  }
};

test.describe.serial("Permissions UI - roles and users", () => {
  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;

    process.env.E2E_MANAGER_USER = USER_MANAGER;
    process.env.E2E_MANAGER_PASS = MANAGER_PASS;
    process.env.E2E_LIMITED_USER = USER_SALESMAN;
    process.env.E2E_LIMITED_PASS = LIMITED_PASS;

    await upsertUserWithPermissions({
      username: USER_MANAGER,
      password: MANAGER_PASS,
      roleName: ROLE_MANAGER,
      branchId,
      scopeKeys: [],
    });

    await upsertUserWithPermissions({
      username: USER_SALESMAN,
      password: LIMITED_PASS,
      roleName: ROLE_SALESMAN,
      branchId,
      scopeKeys: [],
    });
  });

  test("configure Manager/Salesman roles and ahsan override", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    await openPermissions(page, "role", ROLE_MANAGER);

    await setScopePermissions(page, "administration", {
      view: false,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });
    await setScopePermissions(page, "administration.users", {
      view: true,
      navigate: true,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });
    await setScopePermissions(page, "administration.branches", {
      view: true,
      navigate: true,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });
    await setScopePermissions(page, "administration.permissions", {
      view: false,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });

    await setScopePermissions(page, "master_data.basic_info.product_groups", {
      view: true,
      navigate: true,
      create: true,
      edit: true,
    });
    await setScopePermissions(page, "master_data.products.finished", {
      view: true,
      navigate: true,
      create: true,
      edit: true,
    });
    await setScopePermissions(page, "master_data.basic_info.uom_conversions", {
      view: true,
      navigate: true,
      create: true,
      edit: true,
    });
    await setScopePermissions(page, "master_data.parties", {
      view: true,
      navigate: true,
      create: true,
      edit: true,
    });

    await Promise.all([
      page.waitForURL(/\/administration\/permissions\?/i, { timeout: 30000 }),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    await openPermissions(page, "role", ROLE_SALESMAN);

    await setScopePermissions(page, "administration", {
      view: false,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });
    await setScopePermissions(page, "administration.users", {
      view: false,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });
    await setScopePermissions(page, "administration.branches", {
      view: false,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });
    await setScopePermissions(page, "administration.permissions", {
      view: false,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });

    await setScopePermissions(page, "master_data.basic_info.product_groups", {
      view: true,
      navigate: true,
      create: false,
      edit: false,
    });
    await setScopePermissions(page, "master_data.products.finished", {
      view: true,
      navigate: true,
      create: false,
      edit: false,
    });
    await setScopePermissions(page, "master_data.basic_info.uom_conversions", {
      view: true,
      navigate: true,
      create: false,
      edit: false,
    });
    await setScopePermissions(page, "master_data.parties", {
      view: true,
      navigate: true,
      create: true,
      edit: true,
    });

    await Promise.all([
      page.waitForURL(/\/administration\/permissions\?/i, { timeout: 30000 }),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    await openPermissions(page, "user", USER_SALESMAN);

    await setScopePermissions(page, "master_data.products.finished", {
      view: true,
      navigate: true,
      create: true,
      edit: true,
    });
    await setScopePermissions(page, "master_data.basic_info.uom_conversions", {
      view: true,
      navigate: true,
      create: true,
      edit: true,
    });

    await Promise.all([
      page.waitForURL(/\/administration\/permissions\?/i, { timeout: 30000 }),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);
  });

  test("dependency auto-checks view/browse for edit", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openPermissions(page, "role", ROLE_MANAGER);

    await setAction(page, "master_data.basic_info.product_groups", "can_view", false);
    await setAction(page, "master_data.basic_info.product_groups", "can_navigate", false);
    await setAction(page, "master_data.basic_info.product_groups", "can_edit", false);

    await setAction(page, "master_data.basic_info.product_groups", "can_edit", true);

    const row = findScopeRow(page, "master_data.basic_info.product_groups");
    await expect(row.locator('input[data-action="can_view"]')).toBeChecked();
    await expect(row.locator('input[data-action="can_navigate"]')).toBeChecked();
  });

  test("manager1 allowed for users/branches, salesman blocked, permissions blocked", async ({ page }) => {
    await login(page, "E2E_MANAGER");
    const usersRes = await page.goto("/administration/users", { waitUntil: "domcontentloaded" });
    expect(usersRes.status()).toBe(200);
    await expect(page.getByText(/permission denied/i)).toHaveCount(0);

    const branchesRes = await page.goto("/administration/branches", { waitUntil: "domcontentloaded" });
    expect(branchesRes.status()).toBe(200);
    await expect(page.getByText(/permission denied/i)).toHaveCount(0);

    const permsRes = await page.goto("/administration/permissions", { waitUntil: "domcontentloaded" });
    expect(permsRes.status()).toBe(403);

    await login(page, "E2E_LIMITED");
    const usersDenied = await page.goto("/administration/users", { waitUntil: "domcontentloaded" });
    expect(usersDenied.status()).toBe(403);

    const branchesDenied = await page.goto("/administration/branches", { waitUntil: "domcontentloaded" });
    expect(branchesDenied.status()).toBe(403);

    const permsDenied = await page.goto("/administration/permissions", { waitUntil: "domcontentloaded" });
    expect(permsDenied.status()).toBe(403);
  });

  test("master data access respects role/user overrides", async ({ page }) => {
    await login(page, "E2E_MANAGER");
    const productGroupsRes = await page.goto("/master-data/basic-info/product-groups", { waitUntil: "domcontentloaded" });
    expect(productGroupsRes.status()).toBe(200);

    const finishedRes = await page.goto("/master-data/products/finished", { waitUntil: "domcontentloaded" });
    expect(finishedRes.status()).toBe(200);

    await login(page, "E2E_LIMITED");
    const salesmanProductGroups = await page.goto("/master-data/basic-info/product-groups", { waitUntil: "domcontentloaded" });
    expect(salesmanProductGroups.status()).toBe(200);

    const salesmanFinished = await page.goto("/master-data/products/finished", { waitUntil: "domcontentloaded" });
    expect(salesmanFinished.status()).toBe(200);
  });

  test("access vs browse prevents data leak", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openPermissions(page, "role", ROLE_SALESMAN);

    await setScopePermissions(page, "master_data.products.finished", {
      view: true,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });

    await Promise.all([
      page.waitForURL(/\/administration\/permissions\?/i, { timeout: 30000 }),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    await openPermissions(page, "user", USER_SALESMAN);
    await setScopePermissions(page, "master_data.products.finished", {
      view: true,
      navigate: false,
      create: false,
      edit: false,
      delete: false,
      hardDelete: false,
      approve: false,
      print: false,
    });
    await Promise.all([
      page.waitForURL(/\/administration\/permissions\?/i, { timeout: 30000 }),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    await login(page, "E2E_LIMITED");
    const response = await page.goto("/master-data/products/finished", { waitUntil: "domcontentloaded" });
    expect(response.status()).toBe(200);

    await expect(page.getByText("No entries yet.", { exact: false })).toBeVisible();
    await expect(page.locator("[data-modal-open]")).toHaveCount(0);
  });
});
