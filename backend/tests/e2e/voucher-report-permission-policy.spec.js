const { test, expect } = require("@playwright/test");
const { getCredentials } = require("./utils/auth");
const {
  getBranch,
  upsertUserWithPermissions,
  getUserByUsername,
  setUserScopePermission,
  getPermissionScope,
  getFirstNonAdminRole,
  closeDb,
} = require("./utils/db");

const USERS = {
  voucherList: {
    prefix: "E2E_VLIST",
    username: process.env.E2E_VLIST_USER || "e2e_voucher_list_only",
    password: process.env.E2E_VLIST_PASS || "VList@123",
  },
  reportView: {
    prefix: "E2E_RPT_VIEW",
    username: process.env.E2E_RPT_VIEW_USER || "e2e_report_view_only",
    password: process.env.E2E_RPT_VIEW_PASS || "RView@123",
  },
  reportDeny: {
    prefix: "E2E_RPT_DENY",
    username: process.env.E2E_RPT_DENY_USER || "e2e_report_deny",
    password: process.env.E2E_RPT_DENY_PASS || "RDeny@123",
  },
};

const ctx = {
  ready: false,
  skipReason: "",
  branchId: null,
  roleId: null,
  users: {
    voucherList: null,
    reportView: null,
    reportDeny: null,
  },
  scopes: {
    moduleSales: null,
    voucherSalesOrder: null,
    reportSales: null,
  },
};

const setScopePermission = async ({
  userId,
  scopeType,
  scopeKey,
  permissions,
}) => {
  await setUserScopePermission({
    userId,
    scopeType,
    scopeKey,
    permissions,
  });
};

const loginNoShellCheck = async (page, prefix) => {
  const { username, password } = getCredentials(prefix);
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page
    .locator('form[action="/auth/login"] button[type="submit"]')
    .click();
  await expect(page).not.toHaveURL(/\/auth\/login/i);
};

test.describe("Voucher/report permission policy", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;
    const role = await getFirstNonAdminRole();

    if (!branchId || !role?.id) {
      ctx.skipReason = "Missing branch or non-admin role fixture";
      return;
    }

    ctx.branchId = branchId;
    ctx.roleId = Number(role.id);

    for (const config of Object.values(USERS)) {
      process.env[`${config.prefix}_USER`] = config.username;
      process.env[`${config.prefix}_PASS`] = config.password;

      await upsertUserWithPermissions({
        username: config.username,
        password: config.password,
        roleName: "Salesman",
        branchId,
        scopeKeys: [],
      });
    }

    ctx.users.voucherList = await getUserByUsername(USERS.voucherList.username);
    ctx.users.reportView = await getUserByUsername(USERS.reportView.username);
    ctx.users.reportDeny = await getUserByUsername(USERS.reportDeny.username);

    ctx.scopes.moduleSales = await getPermissionScope({
      scopeType: "MODULE",
      scopeKey: "sales",
    });
    ctx.scopes.voucherSalesOrder = await getPermissionScope({
      scopeType: "VOUCHER",
      scopeKey: "SALES_ORDER",
    });
    ctx.scopes.reportSales = await getPermissionScope({
      scopeType: "REPORT",
      scopeKey: "sales_report",
    });

    if (
      !ctx.users.voucherList?.id ||
      !ctx.users.reportView?.id ||
      !ctx.users.reportDeny?.id
    ) {
      ctx.skipReason =
        "Failed to prepare E2E users for permission-policy tests";
      return;
    }

    if (
      !ctx.scopes.moduleSales?.id ||
      !ctx.scopes.voucherSalesOrder?.id ||
      !ctx.scopes.reportSales?.id
    ) {
      ctx.skipReason =
        "Missing required permission scopes (sales module, sales order voucher, sales report)";
      return;
    }

    ctx.ready = true;
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test("permissions matrix shows correct actions for vouchers and reports", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await loginNoShellCheck(page, "E2E_ADMIN");
    await page.goto(
      `/administration/permissions?type=role&target_id=${ctx.roleId}`,
      {
        waitUntil: "domcontentloaded",
      },
    );

    const voucherScopeId = Number(ctx.scopes.voucherSalesOrder.id);
    const reportScopeId = Number(ctx.scopes.reportSales.id);

    expect(
      await page
        .locator(`input[name="${voucherScopeId}:can_hard_delete"]`)
        .count(),
    ).toBeGreaterThan(0);
    await expect(
      page.locator(`input[name="${voucherScopeId}:can_delete"]`),
    ).toHaveCount(0);

    expect(
      await page.locator(`input[name="${reportScopeId}:can_view"]`).count(),
    ).toBeGreaterThan(0);
    expect(
      await page.locator(`input[name="${reportScopeId}:can_load"]`).count(),
    ).toBeGreaterThan(0);
    expect(
      await page
        .locator(`input[name="${reportScopeId}:can_view_details"]`)
        .count(),
    ).toBeGreaterThan(0);
    expect(
      await page.locator(`input[name="${reportScopeId}:can_print"]`).count(),
    ).toBeGreaterThan(0);
    expect(
      await page
        .locator(`input[name="${reportScopeId}:can_export_excel_csv"]`)
        .count(),
    ).toBeGreaterThan(0);
    expect(
      await page
        .locator(`input[name="${reportScopeId}:can_filter_all_branches"]`)
        .count(),
    ).toBeGreaterThan(0);
    expect(
      await page
        .locator(`input[name="${reportScopeId}:can_view_cost_fields"]`)
        .count(),
    ).toBeGreaterThan(0);

    await expect(
      page.locator(`input[name="${reportScopeId}:can_create"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`input[name="${reportScopeId}:can_edit"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`input[name="${reportScopeId}:can_delete"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`input[name="${reportScopeId}:can_hard_delete"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`input[name="${reportScopeId}:can_approve"]`),
    ).toHaveCount(0);
  });

  test("voucher list permission hides previous vouchers when navigate is denied", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await setScopePermission({
      userId: ctx.users.voucherList.id,
      scopeType: "MODULE",
      scopeKey: "sales",
      permissions: {
        can_navigate: false,
        can_view: false,
      },
    });

    await setScopePermission({
      userId: ctx.users.voucherList.id,
      scopeType: "VOUCHER",
      scopeKey: "SALES_ORDER",
      permissions: {
        can_view: true,
        can_navigate: false,
        can_create: true,
        can_edit: false,
        can_hard_delete: false,
        can_print: false,
        can_approve: false,
      },
    });

    await loginNoShellCheck(page, USERS.voucherList.prefix);
    await page.goto("/vouchers/sales-order?view=1&voucher_no=1", {
      waitUntil: "domcontentloaded",
    });

    await expect(page).toHaveURL(/\/vouchers\/sales-order\?new=1/i);
    const prevLink = page.getByRole("link", { name: /prev/i }).first();
    await expect(prevLink).toHaveClass(/pointer-events-none|opacity-40/i);
    await expect(page.locator('input[name="customer_name"]')).toHaveValue("");
  });

  test("voucher update and delete posts are blocked without edit/hard-delete permissions", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await setScopePermission({
      userId: ctx.users.voucherList.id,
      scopeType: "MODULE",
      scopeKey: "sales",
      permissions: {
        can_navigate: false,
        can_view: false,
      },
    });

    await setScopePermission({
      userId: ctx.users.voucherList.id,
      scopeType: "VOUCHER",
      scopeKey: "SALES_ORDER",
      permissions: {
        can_view: true,
        can_navigate: true,
        can_create: true,
        can_edit: false,
        can_hard_delete: false,
        can_print: false,
        can_approve: false,
      },
    });

    await loginNoShellCheck(page, USERS.voucherList.prefix);
    await page.goto("/vouchers/sales-order?new=1", {
      waitUntil: "domcontentloaded",
    });

    const csrfToken = await page
      .locator('input[name="_csrf"]')
      .first()
      .inputValue();

    const updateAttempt = await page.request.post("/vouchers/sales-order", {
      form: {
        _csrf: csrfToken,
        voucher_id: "999999",
      },
      maxRedirects: 0,
    });
    expect([302, 303]).toContain(updateAttempt.status());
    expect(String(updateAttempt.headers()["location"] || "")).toContain(
      "/vouchers/sales-order",
    );

    const deleteAttempt = await page.request.post(
      "/vouchers/sales-order/delete",
      {
        form: {
          _csrf: csrfToken,
          voucher_id: "999999",
        },
        maxRedirects: 0,
      },
    );
    expect([302, 303]).toContain(deleteAttempt.status());
    expect(String(deleteAttempt.headers()["location"] || "")).toContain(
      "/vouchers/sales-order",
    );
  });

  test("report user with view/load/print/export permissions can open sales report", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await setScopePermission({
      userId: ctx.users.reportView.id,
      scopeType: "MODULE",
      scopeKey: "sales",
      permissions: {
        can_navigate: false,
        can_view: false,
      },
    });

    await setScopePermission({
      userId: ctx.users.reportView.id,
      scopeType: "REPORT",
      scopeKey: "sales_report",
      permissions: {
        can_view: true,
        can_load: true,
        can_view_details: true,
        can_print: true,
        can_export_excel_csv: true,
        can_filter_all_branches: true,
        can_view_cost_fields: true,
      },
    });

    await loginNoShellCheck(page, USERS.reportView.prefix);
    const response = await page.goto(
      "/reports/sales/sales-discount-report?load_report=1",
      {
        waitUntil: "domcontentloaded",
      },
    );

    expect(Number(response?.status() || 0)).toBe(200);
    await expect(
      page.getByRole("heading", { name: /sales discount report/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /load/i }).first(),
    ).toBeVisible();
  });

  test("report user without view permission is blocked", async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await setScopePermission({
      userId: ctx.users.reportDeny.id,
      scopeType: "MODULE",
      scopeKey: "sales",
      permissions: {
        can_navigate: false,
        can_view: false,
      },
    });

    await setScopePermission({
      userId: ctx.users.reportDeny.id,
      scopeType: "REPORT",
      scopeKey: "sales_report",
      permissions: {
        can_view: false,
        can_load: false,
        can_view_details: false,
        can_print: false,
        can_export_excel_csv: false,
        can_filter_all_branches: false,
        can_view_cost_fields: false,
      },
    });

    await loginNoShellCheck(page, USERS.reportDeny.prefix);
    const response = await page.goto(
      "/reports/sales/sales-discount-report?load_report=1",
      {
        waitUntil: "domcontentloaded",
      },
    );

    expect([401, 403]).toContain(Number(response?.status() || 0));
    await expect(page.getByText(/permission denied|forbidden/i)).toBeVisible();
  });
});
