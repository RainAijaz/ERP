const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getTwoDistinctUsers,
  upsertUserWithPermissions,
  updateUserProfile,
  setUserScreenPermission,
  insertActivityLogRows,
  deleteActivityLogs,
  clearUserPermissionsOverride,
  getApprovalNotificationRecipientEmails,
  closeDb,
} = require("./utils/db");

const loginWithCredentials = async (page, username, password) => {
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page).not.toHaveURL(/\/auth\/login/i);
  await expect(page.getByRole("button", { name: /logout/i })).toBeVisible();
};

test.describe("Dashboard Urdu, permission scope, and approval recipients", () => {
  test.describe.configure({ mode: "serial" });

  const stamp = Date.now();
  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUser: null,
    urUser: {
      username: `e2e_dash_ur_${stamp}`.slice(0, 28),
      password: "E2eDashUr@123",
      id: null,
    },
    ownOnlyUser: {
      username: `e2e_dash_own_${stamp}`.slice(0, 28),
      password: "E2eDashOwn@123",
      id: null,
    },
    scopedUser: {
      username: `e2e_dash_scope_${stamp}`.slice(0, 28),
      password: "E2eDashScope@123",
      id: null,
    },
    notifyUser: {
      username: `e2e_notify_${stamp}`.slice(0, 28),
      password: "E2eNotify@123",
      id: null,
      email: `n${String(stamp).slice(-10)}@e2e.com`,
    },
    seededActivityIds: [],
  };

  test.beforeAll(async () => {
    const branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
    if (!branch || !users) {
      ctx.skipReason = "Missing branch or admin users for setup.";
      return;
    }

    ctx.ready = true;
    ctx.branchId = Number(branch.id);
    ctx.adminUser = users.primary;

    ctx.urUser.id = await upsertUserWithPermissions({
      username: ctx.urUser.username,
      password: ctx.urUser.password,
      roleName: "Salesman",
      branchId: ctx.branchId,
      scopeKeys: [],
    });
    await updateUserProfile({
      userId: ctx.urUser.id,
      name: "Urdu Dashboard User",
      nameUr: "اردو ڈیش بورڈ صارف",
      status: "Active",
    });

    ctx.ownOnlyUser.id = await upsertUserWithPermissions({
      username: ctx.ownOnlyUser.username,
      password: ctx.ownOnlyUser.password,
      roleName: "Salesman",
      branchId: ctx.branchId,
      scopeKeys: [],
    });
    await setUserScreenPermission({
      userId: ctx.ownOnlyUser.id,
      scopeKey: "administration.audit_logs",
      permissions: {
        can_view: false,
        can_navigate: false,
      },
    });
    await setUserScreenPermission({
      userId: ctx.ownOnlyUser.id,
      scopeKey: "administration.users",
      permissions: {
        can_view: false,
        can_navigate: false,
      },
    });

    ctx.scopedUser.id = await upsertUserWithPermissions({
      username: ctx.scopedUser.username,
      password: ctx.scopedUser.password,
      roleName: "Salesman",
      branchId: ctx.branchId,
      scopeKeys: [],
    });
    await setUserScreenPermission({
      userId: ctx.scopedUser.id,
      scopeKey: "administration.audit_logs",
      permissions: {
        can_view: true,
        can_navigate: true,
      },
    });
    await setUserScreenPermission({
      userId: ctx.scopedUser.id,
      scopeKey: "master_data.accounts",
      permissions: {
        can_view: true,
        can_navigate: true,
      },
    });
    await setUserScreenPermission({
      userId: ctx.scopedUser.id,
      scopeKey: "master_data.parties",
      permissions: {
        can_view: false,
        can_navigate: false,
      },
    });

    ctx.notifyUser.id = await upsertUserWithPermissions({
      username: ctx.notifyUser.username,
      password: ctx.notifyUser.password,
      roleName: "Salesman",
      branchId: ctx.branchId,
      scopeKeys: [],
    });
    await updateUserProfile({
      userId: ctx.notifyUser.id,
      email: ctx.notifyUser.email,
      status: "Active",
    });
    await setUserScreenPermission({
      userId: ctx.notifyUser.id,
      scopeKey: "administration.approvals",
      permissions: {
        can_view: true,
        can_navigate: true,
      },
    });
  });

  test.afterAll(async () => {
    if (ctx.seededActivityIds.length) {
      await deleteActivityLogs(ctx.seededActivityIds);
    }

    const cleanupScopeKeys = [
      "administration.audit_logs",
      "administration.users",
      "master_data.accounts",
      "master_data.parties",
      "administration.approvals",
    ];

    await clearUserPermissionsOverride({
      userId: ctx.ownOnlyUser.id,
      scopeKeys: cleanupScopeKeys,
    });
    await clearUserPermissionsOverride({
      userId: ctx.scopedUser.id,
      scopeKeys: cleanupScopeKeys,
    });
    await clearUserPermissionsOverride({
      userId: ctx.notifyUser.id,
      scopeKeys: cleanupScopeKeys,
    });

    await closeDb();
  });

  test.beforeEach(async () => {
    test.skip(!ctx.ready, ctx.skipReason);
  });

  test("Urdu dashboard renders translated labels and Urdu signed-in name", async ({
    page,
  }) => {
    await loginWithCredentials(page, ctx.urUser.username, ctx.urUser.password);
    await page.goto("/?lang=ur", { waitUntil: "domcontentloaded" });

    await expect(page.locator("body")).toContainText("اردو ڈیش بورڈ صارف");
    await expect(page.locator("body")).toContainText("آج کے واؤچرز");
    await expect(page.locator("body")).toContainText("آج کی ماسٹر ڈیٹا تبدیلیاں");
    await expect(page.locator("body")).toContainText("آج کے کل لاگز");
    await expect(page.locator("body")).toContainText("حالیہ سرگرمی");
    await expect(page.locator("body")).toContainText("قسم");
  });

  test("non-admin without audit permission sees own-only activity and no active-users card", async ({
    page,
  }) => {
    const ownEntityId = `self-${Date.now()}`;
    const otherEntityId = `other-${Date.now()}`;

    const ids = await insertActivityLogRows([
      {
        branch_id: ctx.branchId,
        user_id: ctx.ownOnlyUser.id,
        entity_type: "ACCOUNT",
        entity_id: ownEntityId,
        action: "UPDATE",
        created_at: new Date().toISOString(),
        context_json: { marker: ownEntityId },
      },
      {
        branch_id: ctx.branchId,
        user_id: ctx.urUser.id,
        entity_type: "PARTY",
        entity_id: otherEntityId,
        action: "CREATE",
        created_at: new Date().toISOString(),
        context_json: { marker: otherEntityId },
      },
    ]);
    ctx.seededActivityIds.push(...ids);

    await loginWithCredentials(
      page,
      ctx.ownOnlyUser.username,
      ctx.ownOnlyUser.password,
    );
    await page.goto("/?lang=ur", { waitUntil: "domcontentloaded" });

    await expect(page.locator("body")).toContainText(ctx.ownOnlyUser.username);
    await expect(page.locator("body")).not.toContainText("اردو ڈیش بورڈ صارف");
    await expect(page.locator("body")).not.toContainText("فعال صارفین");
    await expect(page.locator("body")).not.toContainText("Active Users");
  });

  test("non-admin with audit access only sees activity for screens they can navigate", async ({
    page,
  }) => {
    const accountEntityId = `acct-${Date.now()}`;
    const partyEntityId = `party-${Date.now()}`;

    const ids = await insertActivityLogRows([
      {
        branch_id: ctx.branchId,
        user_id: ctx.notifyUser.id,
        entity_type: "ACCOUNT",
        entity_id: accountEntityId,
        action: "UPDATE",
        created_at: new Date().toISOString(),
        context_json: { marker: accountEntityId },
      },
      {
        branch_id: ctx.branchId,
        user_id: ctx.urUser.id,
        entity_type: "PARTY",
        entity_id: partyEntityId,
        action: "CREATE",
        created_at: new Date().toISOString(),
        context_json: { marker: partyEntityId },
      },
    ]);
    ctx.seededActivityIds.push(...ids);

    await loginWithCredentials(
      page,
      ctx.scopedUser.username,
      ctx.scopedUser.password,
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.locator("body")).toContainText(ctx.notifyUser.username);
    await expect(page.locator("body")).not.toContainText("اردو ڈیش بورڈ صارف");
  });

  test("approval notification recipient resolution includes approvals-access users", async () => {
    const recipients = await getApprovalNotificationRecipientEmails();
    expect(recipients).toContain(ctx.notifyUser.email);
    expect(recipients).toContain("admin@example.com");
  });

  test("admin can still access dashboard and approvals after changes", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /dashboard/i }),
    ).toBeVisible();

    await page.goto("/administration/approvals", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("body")).toContainText(/approvals|pending/i);
  });
});
