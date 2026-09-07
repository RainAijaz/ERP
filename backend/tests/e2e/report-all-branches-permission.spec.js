const { test, expect } = require("@playwright/test");
require("dotenv").config();
const bcrypt = require("bcrypt");
const knexConfig = require("../../knexfile").development;
const knex = require("knex")(knexConfig);

const USER = {
  username:
    process.env.E2E_REPORT_ALL_BRANCHES_USER ||
    "e2e_report_all_branches_allowed",
  password: process.env.E2E_REPORT_ALL_BRANCHES_PASS || "ReportAllB@123",
};

const BASE_PERMISSIONS = {
  can_view: true,
  can_load: true,
  can_view_details: true,
  can_print: true,
  can_export_excel_csv: true,
  can_filter_all_branches: true,
  can_view_cost_fields: true,
};

const REPORT_SCOPES = [
  "purchase_report",
  "stock_transfer_report",
  "stock_ledger",
  "stock_item_activity",
  "sales_report",
  "sales_order_report",
  "sales_discount_report",
  "supplier_balances",
  "supplier_analysis",
  "production_report",
  "planned_consumption_report",
  "pending_returnables",
  "employee_balances",
];

const PAGE_CASES = [
  {
    title: "Purchase Report",
    path: "/reports/purchases/",
    scopeKey: "purchase_report",
    form: "[data-purchase-report-filter-form]",
    controls: [{ name: "branch_ids", type: "select-multi", allValue: "__ALL__" }],
  },
  {
    title: "Stock Transfer Report",
    path: "/reports/inventory/stock-transfer",
    scopeKey: "stock_transfer_report",
    form: "[data-stock-transfer-filter-form]",
    controls: [
      { name: "source_branch_ids", type: "select-multi", allValue: "__ALL__" },
      {
        name: "destination_branch_ids",
        type: "select-multi",
        allValue: "__ALL__",
      },
    ],
  },
  {
    title: "Stock Ledger Report",
    path: "/reports/inventory/stock-ledger",
    scopeKey: "stock_ledger",
    form: "[data-inventory-stock-ledger-filter-form]",
    controls: [{ name: "branch_ids", type: "select-multi", allValue: "__ALL__" }],
  },
  {
    title: "Stock Movement Report",
    path: "/reports/inventory/stock-movement",
    scopeKey: "stock_item_activity",
    form: "[data-inventory-stock-movement-filter-form]",
    controls: [{ name: "branch_ids", type: "select-multi", allValue: "__ALL__" }],
  },
  {
    title: "Sales Report",
    path: "/reports/sales/sales-report",
    scopeKey: "sales_report",
    form: "[data-sales-report-filter-form]",
    controls: [{ name: "filter_branch_id", type: "select-single", allValue: "" }],
  },
  {
    title: "Sales Order Report",
    path: "/reports/sales/sales-order-report",
    scopeKey: "sales_order_report",
    form: "[data-sales-order-report-form]",
    controls: [{ name: "branch_ids", type: "custom-multi", allValue: "__ALL__" }],
  },
  {
    title: "Sales Discount Report",
    path: "/reports/sales/sales-discount-report",
    scopeKey: "sales_discount_report",
    form: "[data-sales-discount-report-filter-form]",
    controls: [{ name: "branch_ids", type: "select-single", allValue: "__ALL__" }],
  },
  {
    title: "Supplier Balances Report",
    path: "/reports/purchases/supplier-balances",
    scopeKey: "supplier_balances",
    form: "[data-supplier-balance-filter-form]",
    controls: [{ name: "branch_ids", type: "custom-multi", allValue: "__ALL__" }],
  },
  {
    title: "Supplier Analysis Report",
    path: "/reports/purchases/supplier-analysis",
    scopeKey: "supplier_analysis",
    form: "[data-analysis-form]",
    controls: [{ name: "branch_ids", type: "select-single", allValue: "" }],
  },
  {
    title: "Production Control Report",
    path: "/reports/production/control",
    scopeKey: "production_report",
    form: "[data-production-control-filter-form]",
    controls: [{ name: "branch_ids", type: "select-multi", allValue: "__ALL__" }],
  },
  {
    title: "Planned Consumption Report",
    path: "/reports/production/planned-consumption",
    scopeKey: "planned_consumption_report",
    form: "[data-production-report-form]",
    controls: [{ name: "branch_ids", type: "select-multi", allValue: "__ALL__" }],
  },
  {
    title: "Returnables Control Report",
    path: "/reports/returnables/control",
    scopeKey: "pending_returnables",
    form: "[data-returnables-report-form]",
    controls: [{ name: "branch_ids", type: "select-multi", allValue: "__ALL__" }],
  },
  {
    title: "Employee Balances Report",
    path: "/reports/hr-payroll/employee-balances",
    scopeKey: "employee_balances",
    form: "[data-entity-balance-filter-form]",
    controls: [{ name: "branch_ids", type: "custom-multi", allValue: "__ALL__" }],
  },
];

const ctx = {
  ready: false,
  skipReason: "",
  availableScopes: new Set(),
};

const getBranch = async () =>
  knex("erp.branches").select("id").orderBy("id", "asc").first();

const getUserByUsername = async (username) =>
  knex("erp.users")
    .select("id", "username")
    .whereRaw("lower(username) = lower(?)", [username])
    .first();

const getPermissionScope = async ({ scopeType, scopeKey }) =>
  knex("erp.permission_scope_registry")
    .select("id", "scope_type", "scope_key")
    .where({
      scope_type: String(scopeType).trim().toUpperCase(),
      scope_key: String(scopeKey).trim(),
    })
    .first();

const upsertUserWithPermissions = async ({
  username,
  password,
  roleName,
  branchId,
}) => {
  const role =
    (await knex("erp.role_templates")
      .select("id")
      .whereRaw("lower(name) = lower(?)", [roleName])
      .first()) ||
    (await knex("erp.role_templates").select("id").orderBy("id", "asc").first());
  if (!role) return null;

  const passwordHash = await bcrypt.hash(password, 10);
  return knex.transaction(async (trx) => {
    let user = await trx("erp.users")
      .whereRaw("lower(username) = lower(?)", [username])
      .first();
    if (!user) {
      const [created] = await trx("erp.users")
        .insert({
          name: username,
          username,
          password_hash: passwordHash,
          primary_role_id: role.id,
          status: "Active",
        })
        .returning(["id"]);
      user = { id: created?.id || created };
    } else {
      await trx("erp.users").where({ id: user.id }).update({
        password_hash: passwordHash,
        primary_role_id: role.id,
        status: "Active",
      });
    }

    if (branchId) {
      await trx("erp.user_branch")
        .insert({ user_id: user.id, branch_id: branchId })
        .onConflict(["user_id", "branch_id"])
        .ignore();
    }
    return user.id;
  });
};

const setUserScopePermission = async ({
  userId,
  scopeType,
  scopeKey,
  permissions,
}) => {
  const scope = await getPermissionScope({ scopeType, scopeKey });
  if (!scope?.id) return;
  await knex("erp.user_permissions_override")
    .insert({
      user_id: userId,
      scope_id: scope.id,
      can_view: permissions.can_view,
      can_load: permissions.can_load,
      can_view_details: permissions.can_view_details,
      can_print: permissions.can_print,
      can_export_excel_csv: permissions.can_export_excel_csv,
      can_filter_all_branches: permissions.can_filter_all_branches,
      can_view_cost_fields: permissions.can_view_cost_fields,
    })
    .onConflict(["user_id", "scope_id"])
    .merge({
      can_view: permissions.can_view,
      can_load: permissions.can_load,
      can_view_details: permissions.can_view_details,
      can_print: permissions.can_print,
      can_export_excel_csv: permissions.can_export_excel_csv,
      can_filter_all_branches: permissions.can_filter_all_branches,
      can_view_cost_fields: permissions.can_view_cost_fields,
    });
};

const loginAsReportUser = async (page) => {
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="username"]').fill(USER.username);
  await page.locator('input[name="password"]').fill(USER.password);
  await page.locator('form[action="/auth/login"] button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/auth\/login/i);
};

const readBranchControlState = async (page, { form, name }) =>
  page.evaluate(
    ({ formSelector, controlName }) => {
      const root = document.querySelector(formSelector);
      if (!root) return { formPresent: false, present: false };

      const select = root.querySelector(`select[name="${controlName}"]`);
      if (select) {
        return {
          formPresent: true,
          present: true,
          kind: select.multiple ? "select-multi" : "select-single",
          disabled: select.disabled,
          searchable:
            select.hasAttribute("data-searchable-select") ||
            Boolean(select.closest("[data-searchable-wrapper]")),
          values: Array.from(select.options).map((option) => option.value),
          selected: Array.from(select.selectedOptions).map(
            (option) => option.value,
          ),
          optionCount: select.options.length,
        };
      }

      const multi = root.querySelector(
        `[data-multi-select][data-name="${controlName}"]`,
      );
      if (multi) {
        const trigger = multi.querySelector("[data-multi-trigger]");
        const hidden = multi.querySelector(`input[name="${controlName}"]`);
        const checks = Array.from(
          multi.querySelectorAll('[data-multi-options] input[type="checkbox"]'),
        );
        return {
          formPresent: true,
          present: true,
          kind: "custom-multi",
          disabled: Boolean(trigger?.disabled),
          searchable: true,
          values: checks.map((option) => option.value),
          selected: checks
            .filter((option) => option.checked)
            .map((option) => option.value),
          hiddenValue: hidden ? hidden.value : null,
          optionCount: checks.length,
        };
      }

      const hidden = root.querySelector(`input[name="${controlName}"]`);
      return {
        formPresent: true,
        present: false,
        kind: hidden ? "hidden-only" : "missing",
      };
    },
    { formSelector: form, controlName: name },
  );

test.describe("Report all-branches permission", () => {
  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0);
    if (!branchId) {
      ctx.skipReason = "No branch fixture";
      return;
    }

    const existingScopes = [];
    for (const scopeKey of REPORT_SCOPES) {
      const scope = await getPermissionScope({
        scopeType: "REPORT",
        scopeKey,
      });
      if (scope?.id) existingScopes.push(scopeKey);
    }

    if (!existingScopes.length) {
      ctx.skipReason = "No report permission scopes found";
      return;
    }

    process.env.E2E_REPORT_ALL_BRANCHES_USER = USER.username;
    process.env.E2E_REPORT_ALL_BRANCHES_PASS = USER.password;

    await upsertUserWithPermissions({
      username: USER.username,
      password: USER.password,
      roleName: "Salesman",
      branchId,
      scopeKeys: [],
    });

    const user = await getUserByUsername(USER.username);
    const userId = Number(user?.id || 0);
    if (!userId) {
      ctx.skipReason = "Could not prepare the report all-branches user";
      return;
    }

    for (const scopeKey of existingScopes) {
      await setUserScopePermission({
        userId,
        scopeType: "REPORT",
        scopeKey,
        permissions: BASE_PERMISSIONS,
      });
      ctx.availableScopes.add(scopeKey);
    }

    ctx.ready = true;
  });

  test.afterAll(async () => {
    await knex.destroy();
  });

  for (const pageCase of PAGE_CASES) {
    test(`${pageCase.title} exposes all-branch filtering to permitted non-admin`, async ({
      page,
    }) => {
      test.skip(!ctx.ready, ctx.skipReason);
      test.skip(
        !ctx.availableScopes.has(pageCase.scopeKey),
        `REPORT:${pageCase.scopeKey} scope missing`,
      );

      const response = await page.goto(pageCase.path, {
        waitUntil: "domcontentloaded",
      });
      if (page.url().includes("/auth/login")) {
        await loginAsReportUser(page);
        await page.goto(pageCase.path, { waitUntil: "domcontentloaded" });
      }
      expect(response?.status() || 200).toBeLessThan(500);
      await expect(page.locator(pageCase.form)).toHaveCount(1);
      await page.waitForLoadState("load");
      await page.waitForTimeout(300);

      for (const control of pageCase.controls) {
        const state = await readBranchControlState(page, {
          form: pageCase.form,
          name: control.name,
        });

        expect(state.formPresent, `${control.name} form must exist`).toBe(true);
        expect(state.present, `${control.name} must not be hidden-only`).toBe(
          true,
        );
        expect(state.kind, `${control.name} control type`).toBe(control.type);
        expect(state.disabled, `${control.name} must be usable`).toBe(false);
        expect(
          state.searchable,
          `${control.name} must use the global report select UI`,
        ).toBe(true);
        expect(state.values, `${control.name} must include All`).toContain(
          control.allValue,
        );
        expect(
          state.optionCount,
          `${control.name} should show All plus branch options`,
        ).toBeGreaterThan(1);
      }
    });
  }

  test("Stock Transfer submits source and destination branch selections", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    test.skip(
      !ctx.availableScopes.has("stock_transfer_report"),
      "REPORT:stock_transfer_report scope missing",
    );

    const posts = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/reports/inventory/stock-transfer")
      ) {
        posts.push(request.postData() || "");
      }
    });

    await loginAsReportUser(page);
    await page.goto("/reports/inventory/stock-transfer", {
      waitUntil: "domcontentloaded",
    });

    const target = await page.evaluate(() => {
      const source = document.querySelector(
        '[data-stock-transfer-filter-form] select[name="source_branch_ids"]',
      );
      const option = Array.from(source?.options || []).find(
        (entry) => entry.value && entry.value !== "__ALL__",
      );
      return option ? option.value : "";
    });
    expect(target, "at least one branch option is required").not.toBe("");

    await page
      .locator(
        '[data-stock-transfer-filter-form] select[name="source_branch_ids"]',
      )
      .selectOption([target]);
    await page
      .locator(
        '[data-stock-transfer-filter-form] select[name="destination_branch_ids"]',
      )
      .selectOption([target]);

    await page
      .locator('[data-stock-transfer-filter-form] button[type="submit"]')
      .first()
      .click();
    await page.waitForLoadState("load");

    const params = new URLSearchParams(posts[posts.length - 1] || "");
    expect(params.getAll("source_branch_ids")).toEqual([target]);
    expect(params.getAll("destination_branch_ids")).toEqual([target]);

    const sourceAfter = await readBranchControlState(page, {
      form: "[data-stock-transfer-filter-form]",
      name: "source_branch_ids",
    });
    const destinationAfter = await readBranchControlState(page, {
      form: "[data-stock-transfer-filter-form]",
      name: "destination_branch_ids",
    });
    expect(sourceAfter.selected).toEqual([target]);
    expect(destinationAfter.selected).toEqual([target]);
  });
});
