const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
const {
  getBranch,
  getUserByUsername,
  upsertUserWithPermissions,
  setUserScreenPermission,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  clearUserPermissionsOverride,
  closeDb,
} = require("./utils/db");

const db = createKnex(knexConfig);

const SCOPE_KEY = "master_data.basic_info.product_groups";
const ENTITY_TYPE = "PRODUCT_GROUP";
const GROUPS_URL = "/master-data/basic-info/product-groups";
const LEGACY_GROUPS_URL =
  "/master-data/basic-information/groups/products/product-groups";

const loginWithCredentials = async (page, username, password) => {
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page
    .locator('form[action="/auth/login"] button[type="submit"]')
    .click();
  await expect(page).not.toHaveURL(/\/auth\/login/i);
  await expect(
    page.locator('form[action="/auth/logout"] button[type="submit"]'),
  ).toBeVisible();
};

const visibleRows = (page) =>
  page.locator("[data-table-body] tr[data-row]:not(.hidden)");

const getVisibleNames = async (page) =>
  page
    .locator("[data-table-body] tr[data-row]:not(.hidden)")
    .evaluateAll((rows) =>
      rows
        .map((row) => String(row.getAttribute("data-name") || "").trim())
        .filter(Boolean),
    );

const pollLatestPendingApproval = async (userId, minId = 0) => {
  const row = await db("erp.approval_request")
    .select(
      "id",
      "entity_id",
      "entity_type",
      "status",
      "requested_by",
      "summary",
      "old_value",
      "new_value",
    )
    .where({
      requested_by: userId,
      status: "PENDING",
      entity_type: ENTITY_TYPE,
    })
    .andWhere("id", ">", minId)
    .orderBy("id", "desc")
    .first();
  return row || null;
};

const getLatestPendingApprovalId = async (userId) => {
  const row = await db("erp.approval_request")
    .select("id")
    .where({
      requested_by: userId,
      status: "PENDING",
      entity_type: ENTITY_TYPE,
    })
    .orderBy("id", "desc")
    .first();
  return Number(row?.id || 0);
};

const waitForQueuedApproval = async (userId, minId = 0) => {
  await expect
    .poll(async () => {
      const row = await pollLatestPendingApproval(userId, minId);
      return Number(row?.id || 0);
    })
    .toBeGreaterThan(minId);

  const latest = await pollLatestPendingApproval(userId, minId);
  if (!latest) {
    throw new Error("Expected a pending approval request but none was found.");
  }
  return latest;
};

const createSeedGroup = async ({ name, isActive, createdBy }) => {
  const [inserted] = await db("erp.product_groups")
    .insert({
      name,
      name_ur: `${name} UR`,
      is_active: Boolean(isActive),
      created_by: createdBy,
    })
    .returning(["id"]);

  const id = Number(inserted?.id || inserted || 0);
  if (id > 0) {
    await db("erp.product_group_item_types").insert([
      { group_id: id, item_type: "RM" },
      { group_id: id, item_type: "SFG" },
      { group_id: id, item_type: "FG" },
    ]);
  }
  return id;
};

const openEditForName = async (page, name) => {
  await page.locator("[data-search-input]").fill(name);
  await expect(visibleRows(page).first()).toContainText(name);
  const row = visibleRows(page).first();
  const edit = row.locator("[data-edit]").first();
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(page.locator("[data-modal]")).toBeVisible();
};

const setApprovalPolicy = async (action, requiresApproval) => {
  await upsertApprovalPolicy({
    entityType: "SCREEN",
    entityKey: SCOPE_KEY,
    action,
    requiresApproval,
  });
};

test.describe("Basic Info Product Groups - filters, permissions, and approvals", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    viewerUserId: null,
    operatorUserId: null,
    viewerCredentials: {
      username: `e2e_grp_view_${Date.now()}`.slice(0, 24),
      password: "Viewer@123",
    },
    operatorCredentials: {
      username: `e2e_grp_ops_${Date.now()}`.slice(0, 24),
      password: "Operator@123",
    },
    token: `E2E-GRP-FILTER-${Date.now()}`,
    seedGroupIds: [],
    createdGroupIds: [],
    approvalIds: [],
    policySnapshot: new Map(),
    names: {
      activeA: "",
      inactive: "",
      activeB: "",
      paginationNames: [],
    },
  };

  test.beforeAll(async () => {
    if (!process.env.E2E_ADMIN_USER || !process.env.E2E_ADMIN_PASS) {
      ctx.skipReason = "Missing E2E_ADMIN_USER or E2E_ADMIN_PASS.";
      return;
    }

    const branch = await getBranch();
    if (!branch?.id) {
      ctx.skipReason = "No branch found for E2E setup.";
      return;
    }

    ctx.branchId = Number(branch.id);

    const admin =
      (await getUserByUsername(process.env.E2E_ADMIN_USER)) ||
      (await db("erp.users")
        .select("id", "username")
        .orderBy("id", "asc")
        .first());

    if (!admin?.id) {
      ctx.skipReason = "No admin/fallback user found for seed data.";
      return;
    }

    ctx.adminUserId = Number(admin.id);

    ctx.names.activeA = `${ctx.token}-ALPHA`;
    ctx.names.inactive = `${ctx.token}-INACTIVE`;
    ctx.names.activeB = `${ctx.token}-BETA`;
    ctx.names.paginationNames = Array.from(
      { length: 10 },
      (_, idx) => `${ctx.token}-PAGE-${String(idx + 1).padStart(2, "0")}`,
    );

    const seedNames = [
      ctx.names.activeA,
      ctx.names.inactive,
      ctx.names.activeB,
      ...ctx.names.paginationNames,
    ];
    for (const name of seedNames) {
      const isActive = name !== ctx.names.inactive;
      const id = await createSeedGroup({
        name,
        isActive,
        createdBy: ctx.adminUserId,
      });
      if (id > 0) ctx.seedGroupIds.push(id);
    }

    const viewerUserId = await upsertUserWithPermissions({
      username: ctx.viewerCredentials.username,
      password: ctx.viewerCredentials.password,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId: ctx.branchId,
      scopeKeys: [],
    });
    const operatorUserId = await upsertUserWithPermissions({
      username: ctx.operatorCredentials.username,
      password: ctx.operatorCredentials.password,
      roleName: process.env.E2E_ROLE_MANAGER || "Manager",
      branchId: ctx.branchId,
      scopeKeys: [SCOPE_KEY],
    });

    if (!viewerUserId || !operatorUserId) {
      ctx.skipReason = "Unable to create E2E users for groups test.";
      return;
    }

    ctx.viewerUserId = Number(viewerUserId);
    ctx.operatorUserId = Number(operatorUserId);

    await setUserScreenPermission({
      userId: ctx.viewerUserId,
      scopeKey: SCOPE_KEY,
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
      userId: ctx.operatorUserId,
      scopeKey: SCOPE_KEY,
      permissions: {
        can_view: true,
        can_navigate: true,
        can_create: true,
        can_edit: true,
        can_delete: true,
        can_hard_delete: false,
        can_print: true,
        can_approve: false,
      },
    });

    for (const action of ["create", "edit", "delete"]) {
      const snapshot = await getApprovalPolicy({
        entityType: "SCREEN",
        entityKey: SCOPE_KEY,
        action,
      });
      ctx.policySnapshot.set(action, snapshot || null);
      await setApprovalPolicy(action, false);
    }

    ctx.ready = true;
  });

  test.beforeEach(async () => {
    test.skip(!ctx.ready, ctx.skipReason);
  });

  test.afterAll(async () => {
    if (ctx.approvalIds.length) {
      await db("erp.approval_request").whereIn("id", ctx.approvalIds).del();
    }

    const allGroupIds = [
      ...new Set([...ctx.createdGroupIds, ...ctx.seedGroupIds]),
    ].filter(Boolean);
    if (allGroupIds.length) {
      await db("erp.product_group_item_types")
        .whereIn("group_id", allGroupIds)
        .del();
      await db("erp.product_groups").whereIn("id", allGroupIds).del();
    }

    if (ctx.viewerUserId) {
      await clearUserPermissionsOverride({
        userId: ctx.viewerUserId,
        scopeKeys: [SCOPE_KEY],
      });
    }

    if (ctx.operatorUserId) {
      await clearUserPermissionsOverride({
        userId: ctx.operatorUserId,
        scopeKeys: [SCOPE_KEY],
      });
    }

    for (const action of ["create", "edit", "delete"]) {
      const snapshot = ctx.policySnapshot.get(action);
      if (snapshot) {
        await upsertApprovalPolicy({
          entityType: "SCREEN",
          entityKey: SCOPE_KEY,
          action,
          requiresApproval: Boolean(snapshot.requires_approval),
        });
      } else {
        await deleteApprovalPolicy({
          entityType: "SCREEN",
          entityKey: SCOPE_KEY,
          action,
        });
      }
    }

    await db.destroy();
    await closeDb();
  });

  test("legacy route /basic-information/groups/products/product-groups redirects to product groups page", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto(LEGACY_GROUPS_URL, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/master-data\/basic-info\/product-groups/i);
  });

  test("filters: search and status behave correctly for product groups", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto(GROUPS_URL, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    const search = page.locator("[data-search-input]");
    const status = page.locator("[data-status-filter]");
    const pageSize = page.locator("[data-page-size]");
    await pageSize.selectOption("all");

    await search.fill(ctx.names.activeA);
    await expect(visibleRows(page).first()).toContainText(ctx.names.activeA);

    await search.fill("__NO_MATCH_FILTER_CHECK__");
    await expect(visibleRows(page)).toHaveCount(0);

    await search.fill(ctx.token);
    await status.selectOption("inactive");
    await expect(visibleRows(page).first()).toContainText(ctx.names.inactive);
    const inactiveNames = await getVisibleNames(page);
    expect(inactiveNames).toContain(ctx.names.inactive);
    expect(inactiveNames).not.toContain(ctx.names.activeA);

    await status.selectOption("active");
    const activeNames = await getVisibleNames(page);
    expect(activeNames).toContain(ctx.names.activeA);
    expect(activeNames).toContain(ctx.names.activeB);
    expect(activeNames).not.toContain(ctx.names.inactive);

    await status.selectOption("all");
    const allNames = await getVisibleNames(page);
    expect(allNames).toContain(ctx.names.activeA);
    expect(allNames).toContain(ctx.names.inactive);
  });

  test("filters: sorting and pagination work across product groups", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto(GROUPS_URL, { waitUntil: "domcontentloaded" });

    await page.locator("[data-search-input]").fill(ctx.token);
    await page.locator("[data-status-filter]").selectOption("all");

    const pageSize = page.locator("[data-page-size]");
    await pageSize.selectOption("all");

    const sortByName = page.locator('[data-sort-key="name"]').first();
    await sortByName.click();
    const asc = await getVisibleNames(page);
    expect(asc.length).toBeGreaterThan(10);
    const ascSorted = [...asc].sort((a, b) => a.localeCompare(b));
    expect(asc).toEqual(ascSorted);

    await sortByName.click();
    const desc = await getVisibleNames(page);
    const descSorted = [...desc].sort((a, b) => b.localeCompare(a));
    expect(desc).toEqual(descSorted);

    await pageSize.selectOption("10");
    await expect(visibleRows(page)).toHaveCount(10);
    await expect(page.locator("[data-page-indicator]")).toHaveText("1");

    await page.locator("[data-next-page]").click();
    await expect(page.locator("[data-page-indicator]")).toHaveText("2");
    const secondPageCount = await visibleRows(page).count();
    expect(secondPageCount).toBeGreaterThan(0);

    await page.locator("[data-prev-page]").click();
    await expect(page.locator("[data-page-indicator]")).toHaveText("1");
  });

  test("permissions: view-only user can view but cannot create or modify product groups", async ({
    page,
  }) => {
    await loginWithCredentials(
      page,
      ctx.viewerCredentials.username,
      ctx.viewerCredentials.password,
    );

    const response = await page.goto(GROUPS_URL, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await expect(page.locator("[data-modal-open]")).toHaveCount(0);
    await expect(page.locator("[data-edit]")).toHaveCount(0);
    await expect(page.locator("[data-toggle]")).toHaveCount(0);
    await expect(page.locator("[data-delete]")).toHaveCount(0);

    const newPageResponse = await page.goto(`${GROUPS_URL}/new`, {
      waitUntil: "domcontentloaded",
    });
    expect(newPageResponse?.status()).toBe(403);
  });

  test("approvals: operator create queues approval and does not insert immediately when policy is enabled", async ({
    page,
  }) => {
    await setApprovalPolicy("create", true);
    await setApprovalPolicy("edit", false);
    await setApprovalPolicy("delete", false);

    const queuedName = `${ctx.token}-QUEUE-CREATE`;
    const beforeId = await getLatestPendingApprovalId(ctx.operatorUserId);

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto(GROUPS_URL, { waitUntil: "domcontentloaded" });

    await page.locator("[data-modal-open]").click();
    await expect(page.locator("[data-modal]")).toBeVisible();
    await page
      .locator("[data-modal-form] [data-field='name']")
      .fill(queuedName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${queuedName} UR`);
    const rmCheckbox = page
      .locator(
        "[data-modal-form] input[type='checkbox'][data-field='item_types'][value='RM']",
      )
      .first();
    if (!(await rmCheckbox.isChecked())) {
      await rmCheckbox.check();
    }
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/basic-info\/product-groups/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const inserted = await db("erp.product_groups")
      .whereRaw("lower(name) = lower(?)", [queuedName])
      .first();
    expect(inserted).toBeFalsy();

    const pending = await waitForQueuedApproval(ctx.operatorUserId, beforeId);
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe("NEW");
    expect(pending.new_value?.name).toBe(queuedName);
    expect(pending.new_value?._approval_action).toBe("create");
    expect(Array.isArray(pending.new_value?.item_types)).toBeTruthy();
  });

  test("approvals: operator edit queues approval and leaves row unchanged when policy is enabled", async ({
    page,
  }) => {
    await setApprovalPolicy("create", false);
    await setApprovalPolicy("edit", true);
    await setApprovalPolicy("delete", false);

    const beforeRow = await db("erp.product_groups")
      .select("id", "name", "is_active")
      .whereRaw("lower(name) = lower(?)", [ctx.names.activeA])
      .first();
    expect(beforeRow?.id).toBeTruthy();

    const queuedName = `${ctx.token}-QUEUE-EDIT`;
    const beforeId = await getLatestPendingApprovalId(ctx.operatorUserId);

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto(GROUPS_URL, { waitUntil: "domcontentloaded" });

    await openEditForName(page, ctx.names.activeA);
    await page
      .locator("[data-modal-form] [data-field='name']")
      .fill(queuedName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${queuedName} UR`);
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/basic-info\/product-groups/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const currentRow = await db("erp.product_groups")
      .select("id", "name", "is_active")
      .where({ id: beforeRow.id })
      .first();
    expect(currentRow?.name).toBe(beforeRow.name);
    expect(Boolean(currentRow?.is_active)).toBe(Boolean(beforeRow.is_active));

    const pending = await waitForQueuedApproval(ctx.operatorUserId, beforeId);
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe(String(beforeRow.id));
    expect(pending.new_value?.name).toBe(queuedName);
    expect(pending.new_value?._approval_action).toBe("edit");
  });

  test("approvals: operator toggle queues approval and keeps active state unchanged when policy is enabled", async ({
    page,
  }) => {
    await setApprovalPolicy("create", false);
    await setApprovalPolicy("edit", false);
    await setApprovalPolicy("delete", true);

    const beforeRow = await db("erp.product_groups")
      .select("id", "name", "is_active")
      .whereRaw("lower(name) = lower(?)", [ctx.names.activeA])
      .first();
    expect(beforeRow?.id).toBeTruthy();
    expect(Boolean(beforeRow?.is_active)).toBeTruthy();

    const beforeId = await getLatestPendingApprovalId(ctx.operatorUserId);

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto(GROUPS_URL, { waitUntil: "domcontentloaded" });

    await page.locator("[data-search-input]").fill(ctx.names.activeA);
    await expect(visibleRows(page).first()).toContainText(ctx.names.activeA);

    const row = visibleRows(page).first();
    await row.locator("[data-toggle]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await page
      .locator("[data-confirm-form] button[type='submit']")
      .first()
      .click();

    await expect(page).toHaveURL(/\/master-data\/basic-info\/product-groups/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const currentRow = await db("erp.product_groups")
      .select("id", "is_active")
      .where({ id: beforeRow.id })
      .first();
    expect(Boolean(currentRow?.is_active)).toBe(Boolean(beforeRow.is_active));

    const pending = await waitForQueuedApproval(ctx.operatorUserId, beforeId);
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe(String(beforeRow.id));
    expect(Boolean(pending.new_value?.is_active)).toBe(false);
    expect(pending.new_value?._approval_action).toBe("delete");
  });
});
