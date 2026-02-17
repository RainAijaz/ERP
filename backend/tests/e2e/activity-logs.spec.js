const { test, expect } = require("@playwright/test");
const {
  getBranch,
  getTwoDistinctUsers,
  upsertUserWithPermissions,
  setUserScreenPermission,
  insertActivityLogRows,
  deleteActivityLogs,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  findLatestApprovalRequest,
  deleteApprovalRequests,
  getActivityLogIdsByApprovalRequestId,
  clearUserPermissionsOverride,
  closeDb,
} = require("./utils/db");

const loginWithCredentials = async (page, username, password) => {
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByRole("button", { name: /logout/i })).toBeVisible();
};

const selectFirstOption = async (page, selector) => {
  const value = await page.$eval(selector, (select) => {
    const option = Array.from(select.options).find((entry) => entry.value && String(entry.value).trim() !== "");
    return option ? option.value : "";
  });
  if (!value) return null;
  await page.selectOption(selector, value);
  return value;
};

test.describe("Activity log scenarios", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUser: null,
    actorUser: null,
    deniedUser: null,
    actorCredentials: {
      username: `e2e_audit_actor_${Date.now()}`.slice(0, 24),
      password: "AuditActor@123",
    },
    deniedCredentials: {
      username: `e2e_audit_denied_${Date.now()}`.slice(0, 24),
      password: "AuditDenied@123",
    },
    seededActivityIds: [],
    workflowApprovalId: null,
    workflowActivityIds: [],
    policySnapshot: null,
  };

  test.beforeAll(async () => {
    const branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
    if (!branch || !users) {
      ctx.skipReason = "Missing branch or users for E2E setup.";
      return;
    }

    ctx.ready = true;
    ctx.branchId = branch.id;
    ctx.adminUser = users.primary;

    const actorId = await upsertUserWithPermissions({
      username: ctx.actorCredentials.username,
      password: ctx.actorCredentials.password,
      roleName: "Manager",
      branchId: ctx.branchId,
      scopeKeys: ["master_data.accounts", "administration.audit_logs", "administration.approvals"],
    });
    const deniedId = await upsertUserWithPermissions({
      username: ctx.deniedCredentials.username,
      password: ctx.deniedCredentials.password,
      roleName: "Salesman",
      branchId: ctx.branchId,
      scopeKeys: [],
    });
    ctx.actorUser = { id: actorId, username: ctx.actorCredentials.username };
    ctx.deniedUser = { id: deniedId, username: ctx.deniedCredentials.username };

    await setUserScreenPermission({
      userId: ctx.actorUser.id,
      scopeKey: "administration.audit_logs",
      permissions: {
        can_view: true,
        can_navigate: true,
        can_create: false,
        can_edit: false,
        can_delete: false,
        can_hard_delete: false,
        can_print: false,
        can_approve: false,
      },
    });

    await setUserScreenPermission({
      userId: ctx.deniedUser.id,
      scopeKey: "administration.audit_logs",
      permissions: {
        can_view: false,
        can_navigate: false,
        can_create: false,
        can_edit: false,
        can_delete: false,
        can_hard_delete: false,
        can_print: false,
        can_approve: false,
      },
    });

    ctx.policySnapshot = await getApprovalPolicy({
      entityType: "SCREEN",
      entityKey: "master_data.accounts",
      action: "create",
    });
    await upsertApprovalPolicy({
      entityType: "SCREEN",
      entityKey: "master_data.accounts",
      action: "create",
      requiresApproval: true,
    });

    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const seedRows = [
      {
        branch_id: ctx.branchId,
        user_id: ctx.adminUser.id,
        entity_type: "ACCOUNT",
        entity_id: "seed-1",
        action: "CREATE",
        created_at: today,
        context_json: { marker: "seed-marker-1", source: "seed", page: "accounts" },
      },
      {
        branch_id: ctx.branchId,
        user_id: ctx.actorUser.id,
        entity_type: "PARTY",
        entity_id: "seed-2",
        action: "UPDATE",
        created_at: today,
        context_json: {
          marker: "seed-marker-2",
          source: "seed",
          page: "parties",
          changed_fields: [{ field: "name", old_value: "Old Party", new_value: "New Party" }],
          old_values: { name: "Old Party" },
          new_values: { name: "New Party" },
        },
      },
      {
        branch_id: ctx.branchId,
        user_id: ctx.actorUser.id,
        entity_type: "UOM",
        entity_id: "seed-3",
        action: "SUBMIT",
        created_at: yesterday,
        context_json: { marker: "seed-marker-3", source: "seed", approval_request_id: "seed-approval-3" },
      },
    ];

    for (let i = 0; i < 40; i += 1) {
      seedRows.push({
        branch_id: ctx.branchId,
        user_id: i % 2 === 0 ? ctx.actorUser.id : ctx.adminUser.id,
        entity_type: i % 2 === 0 ? "ACCOUNT" : "PARTY",
        entity_id: `seed-page-${i}`,
        action: i % 3 === 0 ? "CREATE" : i % 3 === 1 ? "UPDATE" : "SUBMIT",
        created_at: today,
        context_json: { marker: `seed-page-marker-${i}`, source: "seed-pagination" },
      });
    }
    ctx.seededActivityIds = await insertActivityLogRows(seedRows);
  });

  test.afterAll(async () => {
    if (ctx.workflowActivityIds.length) {
      await deleteActivityLogs(ctx.workflowActivityIds);
    }
    if (ctx.workflowApprovalId) {
      await deleteApprovalRequests([ctx.workflowApprovalId]);
    }
    if (ctx.seededActivityIds.length) {
      await deleteActivityLogs(ctx.seededActivityIds);
    }

    if (ctx.policySnapshot) {
      await upsertApprovalPolicy({
        entityType: "SCREEN",
        entityKey: "master_data.accounts",
        action: "create",
        requiresApproval: ctx.policySnapshot.requires_approval,
      });
    } else {
      await deleteApprovalPolicy({
        entityType: "SCREEN",
        entityKey: "master_data.accounts",
        action: "create",
      });
    }

    await clearUserPermissionsOverride({
      userId: ctx.actorUser?.id,
      scopeKeys: ["master_data.accounts", "administration.audit_logs", "administration.approvals"],
    });
    await clearUserPermissionsOverride({
      userId: ctx.deniedUser?.id,
      scopeKeys: ["administration.audit_logs"],
    });
    await closeDb();
  });

  test.beforeEach(async () => {
    test.skip(!ctx.ready, ctx.skipReason);
  });

  test("denied user cannot access activity logs", async ({ page }) => {
    await loginWithCredentials(page, ctx.deniedCredentials.username, ctx.deniedCredentials.password);
    const response = await page.goto("/administration/audit-logs", { waitUntil: "domcontentloaded" });
    expect(response.status()).toBe(403);
  });

  test("non-admin can access activity logs but cannot see details column", async ({ page }) => {
    await loginWithCredentials(page, ctx.actorCredentials.username, ctx.actorCredentials.password);
    const date = new Date().toISOString().slice(0, 10);
    await page.goto(`/administration/audit-logs?start_date=${date}&end_date=${date}&entity_type=ACCOUNT&entity_mode=include`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("columnheader", { name: /details/i })).toHaveCount(0);
    await expect(page.locator("[data-audit-details-btn]")).toHaveCount(0);
    await expect(page.locator("[data-audit-details-modal]")).toHaveCount(0);
  });

  test("non-admin DOM does not leak context json markers", async ({ page }) => {
    await loginWithCredentials(page, ctx.actorCredentials.username, ctx.actorCredentials.password);
    const date = new Date().toISOString().slice(0, 10);
    await page.goto(`/administration/audit-logs?start_date=${date}&end_date=${date}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).not.toContainText("seed-marker-1");
    await expect(page.locator("body")).not.toContainText("seed-marker-2");
    await expect(page.locator("[data-audit-details]")).toHaveCount(0);
  });

  test("admin can view details modal with context JSON", async ({ page }) => {
    await loginWithCredentials(page, process.env.E2E_ADMIN_USER, process.env.E2E_ADMIN_PASS);
    const date = new Date().toISOString().slice(0, 10);
    await page.goto(`/administration/audit-logs?start_date=${date}&end_date=${date}&entity_type=ACCOUNT&entity_mode=include`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("columnheader", { name: /details/i })).toBeVisible();
    const row = page.locator("tbody tr", { hasText: "seed-1" }).first();
    await expect(row).toBeVisible();
    await row.locator("[data-audit-details-btn]").click();
    await expect(page.locator("[data-audit-details-modal]")).toBeVisible();
    await expect(page.locator("[data-audit-details-content]")).toContainText("seed-marker-1");
  });

  test("admin details modal shows changed fields with old and new values for updates", async ({ page }) => {
    await loginWithCredentials(page, process.env.E2E_ADMIN_USER, process.env.E2E_ADMIN_PASS);
    const date = new Date().toISOString().slice(0, 10);
    await page.goto(`/administration/audit-logs?start_date=${date}&end_date=${date}&entity_type=PARTY&entity_mode=include`, { waitUntil: "domcontentloaded" });
    const row = page.locator("tbody tr", { hasText: "seed-2" }).first();
    await expect(row).toBeVisible();
    await row.locator("[data-audit-details-btn]").click();
    await expect(page.locator("[data-audit-details-modal]")).toBeVisible();
    await expect(page.locator("[data-audit-details-content]")).toContainText(/changed_fields/i);
    await expect(page.locator("[data-audit-details-content]")).toContainText(/old_value/i);
    await expect(page.locator("[data-audit-details-content]")).toContainText(/new_value/i);
    await expect(page.locator("[data-audit-details-content]")).toContainText("Old Party");
    await expect(page.locator("[data-audit-details-content]")).toContainText("New Party");
  });

  test("filters by user and action through query parameters", async ({ page }) => {
    await loginWithCredentials(page, ctx.actorCredentials.username, ctx.actorCredentials.password);
    const date = new Date().toISOString().slice(0, 10);
    const url = `/administration/audit-logs?start_date=${date}&end_date=${date}&user_ids=${ctx.actorUser.id}&user_mode=include&action=UPDATE&action_mode=include`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page.locator("tbody tr", { hasText: "seed-2" }).first()).toBeVisible();
    await expect(page.locator("tbody tr", { hasText: "seed-1" })).toHaveCount(0);
  });

  test("pagination renders and navigates for large log sets", async ({ page }) => {
    await loginWithCredentials(page, ctx.actorCredentials.username, ctx.actorCredentials.password);
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await page.goto(`/administration/audit-logs?start_date=${startDate}&end_date=${endDate}&page_size=25`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/showing/i)).toBeVisible();
    await expect(page.getByText(/page 1\//i)).toBeVisible();
    const nextLink = page.locator('a[href*="page=2"]').first();
    await expect(nextLink).toBeVisible();
    await nextLink.click();
    await expect(page.getByText(/page 2\//i)).toBeVisible();
    await expect(page.locator('a[href*="page=1"]').first()).toBeVisible();
  });

  test("logs are written from different pages/users and approval decisions", async ({ page }) => {
    await loginWithCredentials(page, ctx.actorCredentials.username, ctx.actorCredentials.password);
    await page.goto("/master-data/accounts", { waitUntil: "domcontentloaded" });

    await expect(page.locator("[data-modal-open]")).toBeVisible();
    await page.locator("[data-modal-open]").click();
    const modal = page.locator("[data-modal-form]");
    await expect(modal).toBeVisible();
    const uniqueName = `E2E Audit Account ${Date.now()}`;
    await modal.locator('[data-field="name"]').fill(uniqueName);
    await modal.locator('[data-field="name_ur"]').fill(uniqueName);
    await selectFirstOption(page, 'select[data-field="subgroup_id"]');
    await selectFirstOption(page, 'select[data-field="branch_ids"]');

    await modal.getByRole("button", { name: /save/i }).click();
    await expect(page.locator("[data-ui-notice-toast]")).toBeVisible();
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(/approval/i);

    const pending = await findLatestApprovalRequest({
      requestedBy: ctx.actorUser.id,
      status: "PENDING",
      entityType: "ACCOUNT",
      summary: "Create Accounts",
    });
    expect(pending?.id).toBeTruthy();
    ctx.workflowApprovalId = pending.id;

    await loginWithCredentials(page, process.env.E2E_ADMIN_USER, process.env.E2E_ADMIN_PASS);
    await page.goto("/administration/approvals?status=PENDING", { waitUntil: "domcontentloaded" });
    const row = page.locator("tbody tr", { hasText: ctx.actorCredentials.username }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /reject/i }).click();
    await page.waitForURL(/administration\/approvals/);

    const date = new Date().toISOString().slice(0, 10);
    await page.goto(
      `/administration/audit-logs?start_date=${date}&end_date=${date}&action=SUBMIT&action_mode=include&user_ids=${ctx.actorUser.id}&user_mode=include`,
      { waitUntil: "domcontentloaded" },
    );
    const submitRow = page.locator("tbody tr", { hasText: "ACCOUNT" }).first();
    await expect(submitRow).toBeVisible();
    await submitRow.locator("[data-audit-details-btn]").click();
    await expect(page.locator("[data-audit-details-content]")).toContainText("screen-approval");

    await page.goto(
      `/administration/audit-logs?start_date=${date}&end_date=${date}&action=REJECT&action_mode=include&user_ids=${ctx.adminUser.id}&user_mode=include`,
      { waitUntil: "domcontentloaded" },
    );
    const rejectRow = page.locator("tbody tr", { hasText: "ACCOUNT" }).first();
    await expect(rejectRow).toBeVisible();
    await rejectRow.locator("[data-audit-details-btn]").click();
    await expect(page.locator("[data-audit-details-content]")).toContainText("approval-decision");

    const workflowLogIds = await getActivityLogIdsByApprovalRequestId(ctx.workflowApprovalId);
    ctx.workflowActivityIds = workflowLogIds;
  });
});
