const { test, expect } = require("@playwright/test");
const { getCredentials } = require("./utils/auth");
const {
  getBranch,
  upsertUserWithPermissions,
  getUserByUsername,
  setUserScopePermission,
  closeDb,
} = require("./utils/db");

const USERS = {
  withCost: {
    prefix: "E2E_SRPT_COST",
    username: process.env.E2E_SRPT_COST_USER || "e2e_sales_rpt_with_cost",
    password: process.env.E2E_SRPT_COST_PASS || "SRptCost@123",
  },
  noCost: {
    prefix: "E2E_SRPT_NOCOST",
    username: process.env.E2E_SRPT_NOCOST_USER || "e2e_sales_rpt_no_cost",
    password: process.env.E2E_SRPT_NOCOST_PASS || "SRptNoCost@123",
  },
};

const COST_COLUMN_HEADERS = ["Pair Rate", "Gross Amount", "Total Discount", "Net Amount"];

const ctx = {
  ready: false,
  skipReason: "",
  branchId: null,
  users: { withCost: null, noCost: null },
};

const loginAs = async (page, prefix) => {
  const { username, password } = getCredentials(prefix);
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[action="/auth/login"] button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/auth\/login/i);
};

const loadSalesReport = async (page) => {
  await page.goto(
    "/reports/sales/sales-report?load_report=1&from_date=2020-01-01&to_date=2030-12-31",
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.getByRole("heading", { name: /sales report/i })).toBeVisible();
};

test.describe("Sales Report: view_cost_fields permission gate", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;
    if (!branchId) {
      ctx.skipReason = "No branch found in database";
      return;
    }
    ctx.branchId = branchId;

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

    ctx.users.withCost = await getUserByUsername(USERS.withCost.username);
    ctx.users.noCost = await getUserByUsername(USERS.noCost.username);

    if (!ctx.users.withCost?.id || !ctx.users.noCost?.id) {
      ctx.skipReason = "Failed to create E2E test users";
      return;
    }

    // Grant sales module navigate to both users so they can reach reports
    for (const user of Object.values(ctx.users)) {
      await setUserScopePermission({
        userId: user.id,
        scopeType: "MODULE",
        scopeKey: "sales",
        permissions: { can_navigate: true, can_view: true },
      });
    }

    // User WITH view_cost_fields
    await setUserScopePermission({
      userId: ctx.users.withCost.id,
      scopeType: "REPORT",
      scopeKey: "sales_report",
      permissions: {
        can_view: true,
        can_load: true,
        can_view_details: true,
        can_view_cost_fields: true,
        can_print: false,
        can_export_excel_csv: false,
        can_filter_all_branches: false,
      },
    });

    // User WITHOUT view_cost_fields
    await setUserScopePermission({
      userId: ctx.users.noCost.id,
      scopeType: "REPORT",
      scopeKey: "sales_report",
      permissions: {
        can_view: true,
        can_load: true,
        can_view_details: true,
        can_view_cost_fields: false,
        can_print: false,
        can_export_excel_csv: false,
        can_filter_all_branches: false,
      },
    });

    ctx.ready = true;
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test("user WITHOUT view_cost_fields sees no cost column headers in sales report", async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await loginAs(page, USERS.noCost.prefix);
    await loadSalesReport(page);

    // Cost column headers must be completely absent from the page DOM —
    // the server does not render them when canViewCostFields is false.
    for (const header of COST_COLUMN_HEADERS) {
      await expect(
        page.locator(`th:has-text("${header}")`),
        `Expected "${header}" column header to be absent for user without view_cost_fields`,
      ).toHaveCount(0);
    }

    // The Quantity column must still be visible (it is not a cost field)
    const qtyHeaders = await page.locator('th').filter({ hasText: /^quantity$/i }).count();
    // Quantity header only appears when report table renders (i.e. data loaded).
    // If no data, the table isn't rendered — we can't check qty here, but the absence
    // of cost headers is the critical assertion regardless of data.
    // If the table IS present, also assert quantity is there.
    const tablePresent = await page.locator("[data-report-table]").count();
    if (tablePresent > 0) {
      expect(qtyHeaders).toBeGreaterThan(0);
    }
  });

  test("user WITH view_cost_fields sees cost column headers in sales report", async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await loginAs(page, USERS.withCost.prefix);
    await loadSalesReport(page);

    const tablePresent = await page.locator("[data-report-table]").count();
    if (tablePresent === 0) {
      test.skip(true, "No sales data in database — cannot verify cost column headers appear");
      return;
    }

    for (const header of COST_COLUMN_HEADERS) {
      await expect(
        page.locator(`th:has-text("${header}")`).first(),
        `Expected "${header}" column header to be visible for user with view_cost_fields`,
      ).toBeVisible();
    }
  });

  test("cost columns absent even when no-cost user explicitly passes load_report=1 via GET", async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);

    await loginAs(page, USERS.noCost.prefix);

    // Attempt to force-load the report via GET — server still checks permission server-side
    const response = await page.goto(
      "/reports/sales/sales-report?load_report=1&from_date=2020-01-01&to_date=2030-12-31",
      { waitUntil: "domcontentloaded" },
    );

    expect(Number(response?.status() || 0)).toBe(200);

    // Regardless of how the page is accessed, the server never renders cost columns
    // for this user, so they must be absent from the HTML.
    const html = await page.content();
    for (const header of COST_COLUMN_HEADERS) {
      expect(
        html,
        `Page HTML must not contain "${header}" th element for user without view_cost_fields`,
      ).not.toContain(`>${header}<`);
    }
  });

  test("admin always sees cost column headers in sales report", async ({ page }) => {
    const { username, password } = getCredentials("E2E_ADMIN");
    await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form[action="/auth/login"] button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/auth\/login/i);

    await loadSalesReport(page);

    const tablePresent = await page.locator("[data-report-table]").count();
    if (tablePresent === 0) {
      test.skip(true, "No sales data in database — cannot verify admin sees cost column headers");
      return;
    }

    for (const header of COST_COLUMN_HEADERS) {
      await expect(
        page.locator(`th:has-text("${header}")`).first(),
        `Admin must always see "${header}" cost column header`,
      ).toBeVisible();
    }
  });
});
