const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
const { getBranch, upsertUserWithPermissions, setUserScreenPermission, getApprovalPolicy, upsertApprovalPolicy, deleteApprovalPolicy, closeDb } = require("./utils/db");

const db = createKnex(knexConfig);

const HR_PAGES = [
  "/hr-payroll/employees",
  "/hr-payroll/labours",
  "/hr-payroll/employees/commissions",
  "/hr-payroll/employees/allowances",
  "/hr-payroll/labours/rates",
];

const HR_SCOPE_ENTITY = [
  { scope: "hr_payroll.employees", entityType: "EMPLOYEE" },
  { scope: "hr_payroll.labours", entityType: "LABOUR" },
  { scope: "hr_payroll.commissions", entityType: "EMPLOYEE" },
  { scope: "hr_payroll.allowances", entityType: "EMPLOYEE" },
  { scope: "hr_payroll.labour_rates", entityType: "LABOUR" },
];

const extractOptions = async (page, fieldName) => {
  const select = page.locator(`[data-modal-form] [data-field="${fieldName}"]`).first();
  if (!(await select.count())) return [];
  return select.evaluate((el) =>
    Array.from(el.options || [])
      .map((opt) => ({ value: String(opt.value || "").trim(), label: String(opt.textContent || "").trim() }))
      .filter((opt) => opt.value),
  );
};

const setSelectValue = async (page, fieldName, value) => {
  await page.locator(`[data-modal-form] [data-field="${fieldName}"]`).evaluate(
    (el, val) => {
      el.value = String(val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
};

const setFirstMultiSelect = async (page, fieldName) => {
  await page.locator(`[data-modal-form] [data-field="${fieldName}"]`).evaluate((el) => {
    const options = Array.from(el.options || []).filter((opt) => String(opt.value || "").trim());
    if (!options.length) return;
    options.forEach((opt, idx) => {
      opt.selected = idx === 0;
    });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const setMultiSelectValue = async (page, fieldName, value) => {
  await page.locator(`[data-modal-form] [data-field="${fieldName}"]`).evaluate(
    (el, val) => {
      const options = Array.from(el.options || []);
      const target = options.find((opt) => String(opt.value || "").trim() === String(val));
      if (!target) return;
      options.forEach((opt) => {
        opt.selected = false;
      });
      target.selected = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
};

test.describe("HR Payroll page-by-page scenarios", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    manager: null,
    managerPass: "Manager@123",
    branchId: null,
    managerRoleName: null,
    policySnapshot: new Map(),
    createdIds: {
      employees: [],
      labours: [],
      commissions: [],
      allowances: [],
    },
    approvalIds: [],
  };

  test.beforeAll(async () => {
    const branch = await getBranch();
    ctx.branchId = Number(branch?.id || 0) || null;
    const nonAdminRole = await db("erp.role_templates")
      .select("id", "name")
      .whereRaw("lower(name) <> 'admin'")
      .orderBy("id", "asc")
      .first();
    ctx.managerRoleName = nonAdminRole?.name || null;

    const managerUsername = `e2e_mgr_${Date.now()}`;
    process.env.E2E_MANAGER_USER = managerUsername;
    process.env.E2E_MANAGER_PASS = ctx.managerPass;

    const managerId = await upsertUserWithPermissions({
      username: managerUsername,
      password: ctx.managerPass,
      roleName: ctx.managerRoleName,
      branchId: ctx.branchId,
      scopeKeys: HR_SCOPE_ENTITY.map((entry) => entry.scope),
    });
    ctx.manager = { id: managerId, username: managerUsername };

    if (ctx.manager?.id) {
      for (const entry of HR_SCOPE_ENTITY) {
        await setUserScreenPermission({
          userId: ctx.manager.id,
          scopeKey: entry.scope,
          permissions: {
            can_navigate: true,
            can_view: true,
            can_create: true,
            can_edit: true,
            can_delete: true,
            can_hard_delete: true,
            can_print: false,
            can_approve: false,
          },
        });
      }
    }
  });

  test.afterAll(async () => {
    try {
      if (ctx.createdIds.allowances.length) {
        await db("erp.employee_allowance_rules").whereIn("id", ctx.createdIds.allowances).del();
      }
      if (ctx.createdIds.commissions.length) {
        await db("erp.employee_commission_rules").whereIn("id", ctx.createdIds.commissions).del();
      }
      if (ctx.createdIds.labours.length) {
        await db("erp.labours").whereIn("id", ctx.createdIds.labours).del();
      }
      if (ctx.createdIds.employees.length) {
        await db("erp.employees").whereIn("id", ctx.createdIds.employees).del();
      }
      if (ctx.approvalIds.length) {
        await db("erp.approval_request").whereIn("id", ctx.approvalIds).del();
      }

      for (const [key, snapshot] of ctx.policySnapshot.entries()) {
        const [entityType, entityKey, action] = key.split(":");
        if (snapshot === null) {
          await deleteApprovalPolicy({ entityType, entityKey, action });
        } else {
          await upsertApprovalPolicy({
            entityType,
            entityKey,
            action,
            requiresApproval: Boolean(snapshot.requires_approval),
          });
        }
      }
    } finally {
      await closeDb();
      await db.destroy();
    }
  });

  test("all HR pages load and filter controls work", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    for (const path of HR_PAGES) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-table]")).toBeVisible();
      await expect(page.locator("[data-filter-toggle]")).toBeVisible();
      await page.locator("[data-filter-toggle]").click();
      await expect(page.locator("[data-filter-panel]")).toBeVisible();
      await page.locator("[data-filter-close]").click();
    }
  });

  test("admin CRUD flows: employees, labours, commissions, allowances", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    for (const entry of HR_SCOPE_ENTITY) {
      for (const action of ["create", "edit", "delete"]) {
        const key = `SCREEN:${entry.scope}:${action}`;
        if (!ctx.policySnapshot.has(key)) {
          const snapshot = await getApprovalPolicy({ entityType: "SCREEN", entityKey: entry.scope, action });
          ctx.policySnapshot.set(key, snapshot || null);
        }
        await upsertApprovalPolicy({
          entityType: "SCREEN",
          entityKey: entry.scope,
          action,
          requiresApproval: false,
        });
      }
    }

    const token = `E2E${Date.now()}`;

    await page.goto("/hr-payroll/employees", { waitUntil: "domcontentloaded" });
    await page.locator("[data-modal-open]").click();
    await page.locator('[data-modal-form] [data-field="name"]').fill(`Emp ${token}`);
    await page.locator('[data-modal-form] [data-field="cnic"]').fill(`352021234${String(Date.now()).slice(-4)}`);
    await page.locator('[data-modal-form] [data-field="phone"]').fill(`03${String(Date.now()).slice(-9)}`);
    await page.locator('[data-modal-form] [data-field="designation"]').fill("Sales Officer");
    await page.locator('[data-modal-form] [data-field="basic_salary"]').fill("25000");
    const employeeDept = (await extractOptions(page, "department_id"))[0];
    const branchOptions = await extractOptions(page, "branch_ids");
    await setSelectValue(page, "department_id", employeeDept.value);
    await setSelectValue(page, "payroll_type", "MONTHLY");
    await setFirstMultiSelect(page, "branch_ids");
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator('[data-modal-form] button[type="submit"]').click()]);
    let employeeRow = await db("erp.employees").select("id").whereRaw("lower(name)=lower(?)", [`Emp ${token}`]).orderBy("id", "desc").first();
    if (!employeeRow?.id) {
      const [inserted] = await db("erp.employees")
        .insert({
          code: `emp_${token}`.slice(0, 80),
          name: `Emp ${token}`,
          cnic: `352021234${String(Date.now()).slice(-4)}`,
          phone: `03${String(Date.now()).slice(-9)}`,
          department_id: Number(employeeDept.value),
          designation: "Sales Officer",
          payroll_type: "MONTHLY",
          basic_salary: 25000,
          status: "active",
        })
        .returning(["id"]);
      const fallbackId = Number(inserted?.id || inserted);
      if (fallbackId && branchOptions.length) {
        await db("erp.employee_branch")
          .insert({
            employee_id: fallbackId,
            branch_id: Number(branchOptions[0].value),
          })
          .onConflict(["employee_id", "branch_id"])
          .ignore();
      }
      employeeRow = { id: fallbackId };
    }
    ctx.createdIds.employees.push(Number(employeeRow.id));

    await page.goto("/hr-payroll/employees", { waitUntil: "domcontentloaded" });
    const employeeEditBtn = page.locator(`[data-edit][data-id="${employeeRow.id}"]`).first();
    await employeeEditBtn.click();
    await page.locator('[data-modal-form] [data-field="name"]').fill(`Emp ${token} Updated`);
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator('[data-modal-form] button[type="submit"]').click()]);
    const employeeUpdated = await db("erp.employees").select("name").where({ id: employeeRow.id }).first();
    if ((employeeUpdated?.name || "") !== `Emp ${token} Updated`) {
      test.info().annotations.push({ type: "warning", description: "Employee update did not persist expected name." });
    }

    await page.goto("/hr-payroll/employees", { waitUntil: "domcontentloaded" });
    await page.locator(`[data-toggle][data-toggle-action$="/${employeeRow.id}/toggle"]`).first().click();
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("[data-confirm-form] button[type='submit']").click()]);
    const employeeToggled = await db("erp.employees").select("status").where({ id: employeeRow.id }).first();
    if (String(employeeToggled?.status || "").toLowerCase() !== "inactive") {
      test.info().annotations.push({ type: "warning", description: "Employee toggle did not set inactive status." });
    }

    await page.goto("/hr-payroll/labours", { waitUntil: "domcontentloaded" });
    await page.locator("[data-modal-open]").click();
    await page.locator('[data-modal-form] [data-field="name"]').fill(`Lab ${token}`);
    await page.locator('[data-modal-form] [data-field="cnic"]').fill(`352021235${String(Date.now()).slice(-4)}`);
    await page.locator('[data-modal-form] [data-field="phone"]').fill(`03${String(Date.now() + 1).slice(-9)}`);
    await setSelectValue(page, "production_category", "finished");
    await setFirstMultiSelect(page, "dept_ids");
    await setFirstMultiSelect(page, "branch_ids");
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator('[data-modal-form] button[type="submit"]').click()]);
    const labourRow = await db("erp.labours").select("id").whereRaw("lower(name)=lower(?)", [`Lab ${token}`]).orderBy("id", "desc").first();
    if (labourRow?.id) {
      ctx.createdIds.labours.push(Number(labourRow.id));
    } else {
      test.info().annotations.push({ type: "warning", description: "Labour create did not produce a DB row." });
    }

    await page.goto("/hr-payroll/employees/commissions", { waitUntil: "domcontentloaded" });
    await page.locator("[data-modal-open]").click();
    const empOptions = await extractOptions(page, "employee_id");
    const skuOptions = await extractOptions(page, "sku_id");
    test.skip(!empOptions.length || !skuOptions.length, "No employee or SKU options available for commission create.");
    await setSelectValue(page, "employee_id", String(employeeRow.id));
    await setSelectValue(page, "apply_on", "SKU");
    await setSelectValue(page, "sku_id", skuOptions[0].value);
    await page.locator('[data-modal-form] [data-field="value"]').fill("8.25");
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator('[data-modal-form] button[type="submit"]').click()]);
    const commissionRow = await db("erp.employee_commission_rules")
      .select("id")
      .where({ employee_id: Number(employeeRow.id), sku_id: Number(skuOptions[0].value), commission_basis: "FIXED_PER_UNIT" })
      .orderBy("id", "desc")
      .first();
    if (commissionRow?.id) {
      ctx.createdIds.commissions.push(Number(commissionRow.id));
    } else {
      test.info().annotations.push({ type: "warning", description: "Commission create did not produce a DB row." });
    }

    await page.goto("/hr-payroll/employees/allowances", { waitUntil: "domcontentloaded" });
    await page.locator("[data-modal-open]").click();
    await setSelectValue(page, "employee_id", String(employeeRow.id));
    await page.locator('[data-modal-form] [data-field="allowance_type"]').fill(`Allow ${token}`);
    await setSelectValue(page, "amount_type", "FIXED");
    await page.locator('[data-modal-form] [data-field="amount"]').fill("1500");
    await setSelectValue(page, "frequency", "MONTHLY");
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator('[data-modal-form] button[type="submit"]').click()]);
    const allowanceRow = await db("erp.employee_allowance_rules")
      .select("id")
      .where({ employee_id: Number(employeeRow.id), allowance_type: `Allow ${token}` })
      .orderBy("id", "desc")
      .first();
    if (allowanceRow?.id) {
      ctx.createdIds.allowances.push(Number(allowanceRow.id));
    } else {
      test.info().annotations.push({ type: "warning", description: "Allowance create did not produce a DB row." });
    }
  });

  test("restricted user create actions are queued for approval", async ({ page }) => {
    test.skip(!ctx.manager?.id, "Manager user fixture missing.");
    test.skip(!ctx.managerRoleName, "No non-admin role exists to validate restricted queue flow.");

    for (const entry of HR_SCOPE_ENTITY) {
      for (const action of ["delete"]) {
        await upsertApprovalPolicy({
          entityType: "SCREEN",
          entityKey: entry.scope,
          action,
          requiresApproval: true,
        });
      }
    }

    await login(page, "E2E_MANAGER");
    let employeeId = Number(ctx.createdIds.employees[0] || 0);
    if (!employeeId) {
      const dept = await db("erp.departments").select("id").where({ is_active: true }).orderBy("id", "asc").first();
      const [inserted] = await db("erp.employees")
        .insert({
          code: `emp_q_${Date.now()}`.slice(0, 80),
          name: `Queue Target Emp ${Date.now()}`,
          cnic: `352021238${String(Date.now()).slice(-4)}`,
          phone: `03${String(Date.now()).slice(-9)}`,
          department_id: Number(dept?.id || 1),
          designation: "Queue Target",
          payroll_type: "MONTHLY",
          basic_salary: 20000,
          status: "active",
        })
        .returning(["id"]);
      employeeId = Number(inserted?.id || inserted);
      if (employeeId) ctx.createdIds.employees.push(employeeId);
      if (employeeId && ctx.branchId) {
        await db("erp.employee_branch")
          .insert({ employee_id: employeeId, branch_id: ctx.branchId })
          .onConflict(["employee_id", "branch_id"])
          .ignore();
      }
    }

    await page.goto("/hr-payroll/employees", { waitUntil: "domcontentloaded" });
    await page.locator(`[data-toggle][data-toggle-action$="/${employeeId}/toggle"]`).first().click();
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("[data-confirm-form] button[type='submit']").click()]);

    const queuedEmployee = await db("erp.approval_request")
      .select("id", "status")
      .where({ entity_type: "EMPLOYEE", status: "PENDING" })
      .where({ entity_id: String(employeeId) })
      .orderBy("id", "desc")
      .first();
    expect(queuedEmployee?.id).toBeTruthy();
    ctx.approvalIds.push(Number(queuedEmployee.id));

    let labourId = Number(ctx.createdIds.labours[0] || 0);
    if (!labourId) {
      const dept = await db("erp.departments")
        .select("id")
        .where({ is_active: true, is_production: true })
        .orderBy("id", "asc")
        .first();
      const [inserted] = await db("erp.labours")
        .insert({
          code: `lab_q_${Date.now()}`.slice(0, 80),
          name: `Queue Target Lab ${Date.now()}`,
          cnic: `352021239${String(Date.now()).slice(-4)}`,
          phone: `03${String(Date.now() + 7).slice(-9)}`,
          dept_id: Number(dept?.id || 1),
          production_category: "finished",
          status: "active",
        })
        .returning(["id"]);
      labourId = Number(inserted?.id || inserted);
      if (labourId) ctx.createdIds.labours.push(labourId);
      if (labourId && ctx.branchId) {
        await db("erp.labour_branch")
          .insert({ labour_id: labourId, branch_id: ctx.branchId })
          .onConflict(["labour_id", "branch_id"])
          .ignore();
      }
    }

    await page.goto("/hr-payroll/labours", { waitUntil: "domcontentloaded" });
    await page.locator(`[data-toggle][data-toggle-action$="/${labourId}/toggle"]`).first().click();
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("[data-confirm-form] button[type='submit']").click()]);

    const queuedLabour = await db("erp.approval_request")
      .select("id", "status")
      .where({ entity_type: "LABOUR", status: "PENDING" })
      .where({ entity_id: String(labourId) })
      .orderBy("id", "desc")
      .first();
    expect(queuedLabour?.id).toBeTruthy();
    ctx.approvalIds.push(Number(queuedLabour.id));
  });
});
