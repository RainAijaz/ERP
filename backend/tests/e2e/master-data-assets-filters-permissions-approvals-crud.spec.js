const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const {
  getBranch,
  getUserByUsername,
  upsertUserWithPermissions,
  setUserScreenPermission,
  clearUserPermissionsOverride,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  closeDb,
} = require("./utils/db");

const db = createKnex(knexConfig);

const ASSET_TYPES_PAGE = {
  key: "asset-types",
  url: "/master-data/asset-types",
  scopeKey: "master_data.asset_types",
  entityType: "ASSET_TYPE",
};

const ASSETS_PAGE = {
  key: "assets",
  url: "/master-data/assets",
  scopeKey: "master_data.returnable_assets",
  entityType: "ASSET",
};

const PAGES = [ASSET_TYPES_PAGE, ASSETS_PAGE];

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

const selectByValue = async (selectLocator, value) => {
  await selectLocator.evaluate((el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(value));
};

const setCheckboxState = async (checkboxLocator, shouldBeChecked) => {
  if (!(await checkboxLocator.count())) return;
  if (shouldBeChecked) {
    await checkboxLocator.check();
  } else {
    await checkboxLocator.uncheck();
  }
};

const submitVisibleConfirmModal = async (page) => {
  await page
    .locator(
      "[data-confirm-modal]:not(.hidden) [data-confirm-form] button[type='submit']",
    )
    .click();
};

const getLatestPendingApprovalId = async (userId, entityType) => {
  const row = await db("erp.approval_request")
    .select("id")
    .where({
      requested_by: userId,
      status: "PENDING",
      entity_type: entityType,
    })
    .orderBy("id", "desc")
    .first();
  return Number(row?.id || 0);
};

const pollLatestPendingApproval = async (userId, entityType, minId = 0) => {
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
      entity_type: entityType,
    })
    .andWhere("id", ">", minId)
    .orderBy("id", "desc")
    .first();
  return row || null;
};

const waitForQueuedApproval = async (userId, entityType, minId = 0) => {
  await expect
    .poll(async () => {
      const row = await pollLatestPendingApproval(userId, entityType, minId);
      return Number(row?.id || 0);
    })
    .toBeGreaterThan(minId);

  const latest = await pollLatestPendingApproval(userId, entityType, minId);
  if (!latest) {
    throw new Error("Expected a pending approval request but none was found.");
  }
  return latest;
};

const assertApprovalPreviewValue = async (
  page,
  approvalId,
  fieldName,
  expectedValue = null,
) => {
  await page.goto("/administration/approvals?status=PENDING", {
    waitUntil: "domcontentloaded",
  });
  const viewBtn = page
    .locator(`[data-approval-view][data-approval-id="${approvalId}"]`)
    .first();
  await expect(viewBtn).toBeVisible();
  const previewWait = page.waitForResponse(
    (res) =>
      res.url().includes(`/administration/approvals/${approvalId}/preview`) &&
      (res.status() === 200 || res.status() === 204),
    { timeout: 10000 },
  );
  await viewBtn.click();
  await previewWait.catch(() => {});

  const modal = page.locator("[data-approval-detail-modal]");
  await expect(modal).toBeVisible();
  const panel = modal.locator("[data-approval-preview]").first();
  await expect(panel).toBeVisible({ timeout: 10000 });
  const field = panel.locator(`[data-field="${fieldName}"]`).first();
  await expect(field).toBeVisible();
  if (expectedValue !== null && typeof expectedValue !== "undefined") {
    await expect(field).toHaveValue(expectedValue);
  }

  await modal.locator("[data-approval-detail-close]").first().click();
  await expect(modal).toHaveClass(/hidden/);
};

const toAssetTypeCode = (seed) =>
  String(seed || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 28);

const buildUniqueAssetTypeCode = (prefix, marker) => {
  const safePrefix = toAssetTypeCode(prefix);
  const safeMarker = toAssetTypeCode(marker);
  const entropy = `${Date.now()}${Math.floor(Math.random() * 100000)}`.slice(
    -10,
  );
  return `${safePrefix}${safeMarker}${entropy}`.slice(0, 40);
};

const buildUniqueAssetCode = (prefix, marker) => {
  const safePrefix = String(prefix || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
  const safeMarker = String(marker || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  const entropy = `${Date.now()}${Math.floor(Math.random() * 100000)}`.slice(
    -10,
  );
  return `${safePrefix}${safeMarker}${entropy}`.slice(0, 80);
};

const setApprovalPolicies = async (
  scopeKey,
  createAllowed,
  editAllowed,
  deleteAllowed,
) => {
  await upsertApprovalPolicy({
    entityType: "SCREEN",
    entityKey: scopeKey,
    action: "create",
    requiresApproval: Boolean(createAllowed),
  });
  await upsertApprovalPolicy({
    entityType: "SCREEN",
    entityKey: scopeKey,
    action: "edit",
    requiresApproval: Boolean(editAllowed),
  });
  await upsertApprovalPolicy({
    entityType: "SCREEN",
    entityKey: scopeKey,
    action: "delete",
    requiresApproval: Boolean(deleteAllowed),
  });
};

const createAssetTypeSeedRows = async ({ token, supportsNameUr }) => {
  const activeName = `${token}-AT-ACTIVE-A`;
  const inactiveName = `${token}-AT-INACTIVE`;
  const activeNameB = `${token}-AT-ACTIVE-B`;

  const activeCode = buildUniqueAssetTypeCode(token, "A");
  const inactiveCode = buildUniqueAssetTypeCode(token, "I");
  const activeCodeB = buildUniqueAssetTypeCode(token, "B");

  const rows = [
    {
      code: activeCode,
      name: activeName,
      ...(supportsNameUr ? { name_ur: `${activeName} UR` } : {}),
      description: activeName,
      is_active: true,
    },
    {
      code: inactiveCode,
      name: inactiveName,
      ...(supportsNameUr ? { name_ur: `${inactiveName} UR` } : {}),
      description: inactiveName,
      is_active: false,
    },
    {
      code: activeCodeB,
      name: activeNameB,
      ...(supportsNameUr ? { name_ur: `${activeNameB} UR` } : {}),
      description: activeNameB,
      is_active: true,
    },
  ];

  await db("erp.asset_type_registry").insert(rows);

  return {
    token,
    activeName,
    inactiveName,
    activeNameB,
    activeCode,
    inactiveCode,
    activeCodeB,
    allCodes: [activeCode, inactiveCode, activeCodeB],
  };
};

const createAssetsSeedRows = async ({
  token,
  supportsName,
  supportsNameUr,
  supportsCreatedBy,
  supportsCreatedAt,
  supportsUpdatedBy,
  supportsUpdatedAt,
  createdBy,
  assetTypeCode,
  branchId,
}) => {
  const activeName = `${token}-ASSET-ACTIVE-A`;
  const inactiveName = `${token}-ASSET-INACTIVE`;
  const activeNameB = `${token}-ASSET-ACTIVE-B`;

  const buildPayload = (name, isActive, marker) => ({
    asset_code: buildUniqueAssetCode(token, marker),
    asset_type_code: assetTypeCode,
    description: name,
    home_branch_id: branchId,
    is_active: Boolean(isActive),
    ...(supportsName ? { name } : {}),
    ...(supportsNameUr ? { name_ur: `${name} UR` } : {}),
    ...(supportsCreatedBy ? { created_by: createdBy } : {}),
    ...(supportsCreatedAt ? { created_at: db.fn.now() } : {}),
    ...(supportsUpdatedBy ? { updated_by: createdBy } : {}),
    ...(supportsUpdatedAt ? { updated_at: db.fn.now() } : {}),
  });

  const inserted = await db("erp.assets")
    .insert([
      buildPayload(activeName, true, "A"),
      buildPayload(inactiveName, false, "I"),
      buildPayload(activeNameB, true, "B"),
    ])
    .returning(["id", "description"]);

  const allIds = inserted.map((row) => Number(row.id)).filter(Boolean);

  return {
    token,
    activeName,
    inactiveName,
    activeNameB,
    activeId: Number(inserted[0]?.id || 0),
    inactiveId: Number(inserted[1]?.id || 0),
    activeIdB: Number(inserted[2]?.id || 0),
    allIds,
  };
};

const openEditForName = async (page, name) => {
  await page.locator("[data-search-input]").fill(name);
  const row = visibleRows(page).filter({ hasText: name }).first();
  await expect(row).toContainText(name);
  await row.locator("[data-edit]").first().click();
  await expect(page.locator("[data-modal]")).toBeVisible();
};

const fillAssetTypeCreateForm = async (page, values) => {
  await page.locator("[data-modal-open]").first().click();
  await expect(page.locator("[data-modal]")).toBeVisible();

  await page.locator("[data-modal-form] [data-field='name']").fill(values.name);
  await page
    .locator("[data-modal-form] [data-field='name_ur']")
    .fill(values.nameUr);
  await setCheckboxState(
    page.locator("[data-modal-form] [data-field='is_active']").first(),
    true,
  );

  await page.locator("[data-modal-form] button[type='submit']").click();
};

const fillAssetCreateForm = async (page, values) => {
  await page.locator("[data-modal-open]").first().click();
  await expect(page.locator("[data-modal]")).toBeVisible();

  await page.locator("[data-modal-form] [data-field='name']").fill(values.name);
  await page
    .locator("[data-modal-form] [data-field='name_ur']")
    .fill(values.nameUr);
  await selectByValue(
    page
      .locator("[data-modal-form] select[data-field='asset_type_code']")
      .first(),
    values.assetTypeCode,
  );
  await selectByValue(
    page
      .locator("[data-modal-form] select[data-field='home_branch_id']")
      .first(),
    values.branchId,
  );
  await setCheckboxState(
    page.locator("[data-modal-form] [data-field='is_active']").first(),
    true,
  );

  await page.locator("[data-modal-form] button[type='submit']").click();
};

test.describe("Master Data Assets - filters, permissions, approvals, CRUD", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    viewerUserId: null,
    operatorUserId: null,
    viewerCredentials: {
      username: `e2e_ast_view_${Date.now()}`.slice(0, 24),
      password: "Viewer@123",
    },
    operatorCredentials: {
      username: `e2e_ast_ops_${Date.now()}`.slice(0, 24),
      password: "Operator@123",
    },
    token: `E2E-ASSETS-${Date.now()}`,
    approvalIds: [],
    policySnapshot: new Map(),
    support: {
      assetTypeNameUr: false,
      assetsName: false,
      assetsNameUr: false,
      assetsCreatedBy: false,
      assetsCreatedAt: false,
      assetsUpdatedBy: false,
      assetsUpdatedAt: false,
    },
    fixtures: {
      existingAssetTypeCode: "",
      existingAssetTypeName: "",
    },
    seeded: {
      assetTypes: null,
      assets: null,
    },
    created: {
      assetTypeCodes: [],
      assetIds: [],
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

    ctx.support.assetTypeNameUr = await db.schema
      .withSchema("erp")
      .hasColumn("asset_type_registry", "name_ur");
    ctx.support.assetsName = await db.schema
      .withSchema("erp")
      .hasColumn("assets", "name");
    ctx.support.assetsNameUr = await db.schema
      .withSchema("erp")
      .hasColumn("assets", "name_ur");
    ctx.support.assetsCreatedBy = await db.schema
      .withSchema("erp")
      .hasColumn("assets", "created_by");
    ctx.support.assetsCreatedAt = await db.schema
      .withSchema("erp")
      .hasColumn("assets", "created_at");
    ctx.support.assetsUpdatedBy = await db.schema
      .withSchema("erp")
      .hasColumn("assets", "updated_by");
    ctx.support.assetsUpdatedAt = await db.schema
      .withSchema("erp")
      .hasColumn("assets", "updated_at");

    const existingAssetType = await db("erp.asset_type_registry")
      .select("code", "name")
      .where({ is_active: true })
      .orderBy("name", "asc")
      .first();

    if (!existingAssetType?.code) {
      ctx.skipReason = "No active asset type found for assets tests.";
      return;
    }
    ctx.fixtures.existingAssetTypeCode = String(existingAssetType.code || "")
      .trim()
      .toUpperCase();
    ctx.fixtures.existingAssetTypeName = String(
      existingAssetType.name || "",
    ).trim();

    const scopeKeys = PAGES.map((page) => page.scopeKey);

    const viewerUserId = await upsertUserWithPermissions({
      username: ctx.viewerCredentials.username,
      password: ctx.viewerCredentials.password,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId: ctx.branchId,
      scopeKeys,
    });

    const operatorUserId = await upsertUserWithPermissions({
      username: ctx.operatorCredentials.username,
      password: ctx.operatorCredentials.password,
      roleName: process.env.E2E_ROLE_MANAGER || "Manager",
      branchId: ctx.branchId,
      scopeKeys,
    });

    if (!viewerUserId || !operatorUserId) {
      ctx.skipReason = "Unable to create E2E users for assets tests.";
      return;
    }

    ctx.viewerUserId = Number(viewerUserId);
    ctx.operatorUserId = Number(operatorUserId);

    for (const page of PAGES) {
      await setUserScreenPermission({
        userId: ctx.viewerUserId,
        scopeKey: page.scopeKey,
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
        scopeKey: page.scopeKey,
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
          entityKey: page.scopeKey,
          action,
        });
        ctx.policySnapshot.set(`${page.scopeKey}|${action}`, snapshot || null);
      }

      await setApprovalPolicies(page.scopeKey, false, false, false);
    }

    ctx.seeded.assetTypes = await createAssetTypeSeedRows({
      token: ctx.token,
      supportsNameUr: ctx.support.assetTypeNameUr,
    });

    ctx.seeded.assets = await createAssetsSeedRows({
      token: ctx.token,
      supportsName: ctx.support.assetsName,
      supportsNameUr: ctx.support.assetsNameUr,
      supportsCreatedBy: ctx.support.assetsCreatedBy,
      supportsCreatedAt: ctx.support.assetsCreatedAt,
      supportsUpdatedBy: ctx.support.assetsUpdatedBy,
      supportsUpdatedAt: ctx.support.assetsUpdatedAt,
      createdBy: ctx.adminUserId,
      assetTypeCode: ctx.fixtures.existingAssetTypeCode,
      branchId: ctx.branchId,
    });

    ctx.ready = true;
  });

  test.beforeEach(async () => {
    test.skip(!ctx.ready, ctx.skipReason);
  });

  test.afterAll(async () => {
    if (ctx.approvalIds.length) {
      await db("erp.approval_request")
        .whereIn("id", [...new Set(ctx.approvalIds)])
        .del();
    }

    const allAssetIds = [
      ...new Set([
        ...(ctx.created.assetIds || []),
        ...(ctx.seeded.assets?.allIds || []),
      ]),
    ].filter(Boolean);
    if (allAssetIds.length) {
      await db("erp.assets").whereIn("id", allAssetIds).del();
    }

    const allAssetTypeCodes = [
      ...new Set([
        ...(ctx.created.assetTypeCodes || []),
        ...(ctx.seeded.assetTypes?.allCodes || []),
      ]),
    ]
      .map((code) =>
        String(code || "")
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean);
    if (allAssetTypeCodes.length) {
      await db("erp.asset_type_registry")
        .whereIn("code", allAssetTypeCodes)
        .del();
    }

    if (ctx.viewerUserId) {
      await clearUserPermissionsOverride({
        userId: ctx.viewerUserId,
        scopeKeys: PAGES.map((page) => page.scopeKey),
      });
    }

    if (ctx.operatorUserId) {
      await clearUserPermissionsOverride({
        userId: ctx.operatorUserId,
        scopeKeys: PAGES.map((page) => page.scopeKey),
      });
    }

    for (const page of PAGES) {
      for (const action of ["create", "edit", "delete"]) {
        const snapshot = ctx.policySnapshot.get(`${page.scopeKey}|${action}`);
        if (snapshot) {
          await upsertApprovalPolicy({
            entityType: "SCREEN",
            entityKey: page.scopeKey,
            action,
            requiresApproval: Boolean(snapshot.requires_approval),
          });
        } else {
          await deleteApprovalPolicy({
            entityType: "SCREEN",
            entityKey: page.scopeKey,
            action,
          });
        }
      }
    }

    await db.destroy();
    await closeDb();
  });

  test("assets: legacy route /master-data/returnable-assets redirects to /master-data/assets", async ({
    page,
  }) => {
    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    const response = await page.goto("/master-data/returnable-assets", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/master-data\/assets/i);
  });

  test("asset types: filters work (search, status, sort)", async ({ page }) => {
    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    const response = await page.goto(ASSET_TYPES_PAGE.url, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await page.locator("[data-page-size]").selectOption("all");
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.assetTypes.activeName);
    await expect(visibleRows(page).first()).toContainText(
      ctx.seeded.assetTypes.activeName,
    );

    await page.locator("[data-search-input]").fill("__NO_MATCH_ASSET_TYPES__");
    await expect(visibleRows(page)).toHaveCount(0);

    await page.locator("[data-search-input]").fill(`${ctx.token}-AT`);
    await page.locator("[data-status-filter]").selectOption("inactive");
    let names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.assetTypes.inactiveName);
    expect(names).not.toContain(ctx.seeded.assetTypes.activeName);

    await page.locator("[data-status-filter]").selectOption("active");
    names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.assetTypes.activeName);
    expect(names).toContain(ctx.seeded.assetTypes.activeNameB);
    expect(names).not.toContain(ctx.seeded.assetTypes.inactiveName);

    await page.locator("[data-status-filter]").selectOption("all");
    const sortByName = page.locator("[data-sort-key='name']").first();
    await sortByName.click();
    const asc = await getVisibleNames(page);
    const ascSorted = [...asc].sort((a, b) => a.localeCompare(b));
    expect(asc).toEqual(ascSorted);
  });

  test("assets: filters work (search, status, sort)", async ({ page }) => {
    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    const response = await page.goto(ASSETS_PAGE.url, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await page.locator("[data-page-size]").selectOption("all");
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.assets.activeName);
    await expect(visibleRows(page).first()).toContainText(
      ctx.seeded.assets.activeName,
    );

    await page.locator("[data-search-input]").fill("__NO_MATCH_ASSETS__");
    await expect(visibleRows(page)).toHaveCount(0);

    await page.locator("[data-search-input]").fill(`${ctx.token}-ASSET`);
    await page.locator("[data-status-filter]").selectOption("inactive");
    let names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.assets.inactiveName);
    expect(names).not.toContain(ctx.seeded.assets.activeName);

    await page.locator("[data-status-filter]").selectOption("active");
    names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.assets.activeName);
    expect(names).toContain(ctx.seeded.assets.activeNameB);
    expect(names).not.toContain(ctx.seeded.assets.inactiveName);

    await page.locator("[data-status-filter]").selectOption("all");
    const sortByName = page.locator("[data-sort-key='name']").first();
    await sortByName.click();
    const asc = await getVisibleNames(page);
    const ascSorted = [...asc].sort((a, b) => a.localeCompare(b));
    expect(asc).toEqual(ascSorted);
  });

  test("asset types: view-only user cannot create/edit/delete", async ({
    page,
  }) => {
    await loginWithCredentials(
      page,
      ctx.viewerCredentials.username,
      ctx.viewerCredentials.password,
    );
    const response = await page.goto(ASSET_TYPES_PAGE.url, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await expect(page.locator("[data-modal-open]")).toHaveCount(0);
    await expect(page.locator("[data-edit]")).toHaveCount(0);
    await expect(page.locator("[data-toggle]")).toHaveCount(0);
    await expect(page.locator("[data-delete]")).toHaveCount(0);
  });

  test("assets: view-only user cannot create/edit/delete", async ({ page }) => {
    await loginWithCredentials(
      page,
      ctx.viewerCredentials.username,
      ctx.viewerCredentials.password,
    );
    const response = await page.goto(ASSETS_PAGE.url, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await expect(page.locator("[data-modal-open]")).toHaveCount(0);
    await expect(page.locator("[data-edit]")).toHaveCount(0);
    await expect(page.locator("[data-toggle]")).toHaveCount(0);
    await expect(page.locator("[data-delete]")).toHaveCount(0);
  });

  test("asset types: operator actions queue approvals (create/edit/toggle)", async ({
    page,
  }) => {
    await setApprovalPolicies(ASSET_TYPES_PAGE.scopeKey, true, true, true);

    const createName = `${ctx.token}-AT-QUEUE-CREATE`;
    const beforeCreateId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      ASSET_TYPES_PAGE.entityType,
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto(ASSET_TYPES_PAGE.url, { waitUntil: "domcontentloaded" });

    await fillAssetTypeCreateForm(page, {
      name: createName,
      nameUr: `${createName} UR`,
    });

    await expect(page).toHaveURL(/\/master-data\/asset-types/i);

    const inserted = await db("erp.asset_type_registry")
      .whereRaw("lower(name) = lower(?)", [createName])
      .first();
    expect(inserted).toBeFalsy();

    const createPending = await waitForQueuedApproval(
      ctx.operatorUserId,
      ASSET_TYPES_PAGE.entityType,
      beforeCreateId,
    );
    ctx.approvalIds.push(createPending.id);
    expect(String(createPending.entity_id)).toBe("NEW");
    expect(String(createPending.new_value?.name || "")).toBe(createName);

    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    await assertApprovalPreviewValue(
      page,
      createPending.id,
      "name",
      createName,
    );
    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto(ASSET_TYPES_PAGE.url, { waitUntil: "domcontentloaded" });

    const editName = `${ctx.token}-AT-QUEUE-EDIT`;
    const beforeRow = await db("erp.asset_type_registry")
      .select("code", "name", "is_active")
      .where({ code: ctx.seeded.assetTypes.activeCode })
      .first();
    expect(beforeRow?.code).toBeTruthy();

    const beforeEditId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      ASSET_TYPES_PAGE.entityType,
    );
    await openEditForName(page, ctx.seeded.assetTypes.activeName);
    await page.locator("[data-modal-form] [data-field='name']").fill(editName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${editName} UR`);
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/asset-types/i);

    const afterEdit = await db("erp.asset_type_registry")
      .select("code", "name", "is_active")
      .where({ code: ctx.seeded.assetTypes.activeCode })
      .first();
    expect(String(afterEdit?.name || "")).toBe(String(beforeRow?.name || ""));

    const editPending = await waitForQueuedApproval(
      ctx.operatorUserId,
      ASSET_TYPES_PAGE.entityType,
      beforeEditId,
    );
    ctx.approvalIds.push(editPending.id);
    expect(String(editPending.entity_id)).toBe(
      String(ctx.seeded.assetTypes.activeCode),
    );
    expect(String(editPending.new_value?.name || "")).toBe(editName);

    const beforeToggleId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      ASSET_TYPES_PAGE.entityType,
    );
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.assetTypes.activeName);
    const row = visibleRows(page)
      .filter({ hasText: ctx.seeded.assetTypes.activeName })
      .first();
    await expect(row).toContainText(ctx.seeded.assetTypes.activeName);
    await row.locator("[data-toggle]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await submitVisibleConfirmModal(page);

    await expect(page).toHaveURL(/\/master-data\/asset-types/i);

    const afterToggle = await db("erp.asset_type_registry")
      .select("code", "is_active")
      .where({ code: ctx.seeded.assetTypes.activeCode })
      .first();
    expect(Boolean(afterToggle?.is_active)).toBe(true);

    const togglePending = await waitForQueuedApproval(
      ctx.operatorUserId,
      ASSET_TYPES_PAGE.entityType,
      beforeToggleId,
    );
    ctx.approvalIds.push(togglePending.id);
    expect(String(togglePending.entity_id)).toBe(
      String(ctx.seeded.assetTypes.activeCode),
    );
    expect(Boolean(togglePending.new_value?.is_active)).toBe(false);
    expect(togglePending.new_value?._approval_action).toBe("delete");

    await setApprovalPolicies(ASSET_TYPES_PAGE.scopeKey, false, false, false);
  });

  test("assets: operator actions queue approvals (create/edit/toggle)", async ({
    page,
  }) => {
    await setApprovalPolicies(ASSETS_PAGE.scopeKey, true, true, true);

    const createName = `${ctx.token}-ASSET-QUEUE-CREATE`;
    const beforeCreateId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      ASSETS_PAGE.entityType,
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto(ASSETS_PAGE.url, { waitUntil: "domcontentloaded" });

    await fillAssetCreateForm(page, {
      name: createName,
      nameUr: `${createName} UR`,
      assetTypeCode: ctx.fixtures.existingAssetTypeCode,
      branchId: ctx.branchId,
    });

    await expect(page).toHaveURL(/\/master-data\/assets/i);

    const inserted = await db("erp.assets")
      .whereRaw("lower(description) = lower(?)", [createName])
      .first();
    expect(inserted).toBeFalsy();

    const createPending = await waitForQueuedApproval(
      ctx.operatorUserId,
      ASSETS_PAGE.entityType,
      beforeCreateId,
    );
    ctx.approvalIds.push(createPending.id);
    expect(String(createPending.entity_id)).toBe("NEW");
    if (ctx.support.assetsName) {
      expect(String(createPending.new_value?.name || "")).toBe(createName);
    } else {
      expect(String(createPending.new_value?.description || "")).toBe(
        createName,
      );
    }

    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    await assertApprovalPreviewValue(
      page,
      createPending.id,
      "name",
      ctx.support.assetsName ? createName : null,
    );
    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto(ASSETS_PAGE.url, { waitUntil: "domcontentloaded" });

    const editName = `${ctx.token}-ASSET-QUEUE-EDIT`;
    const beforeRow = await db("erp.assets")
      .select("id", "description", "is_active")
      .where({ id: ctx.seeded.assets.activeId })
      .first();
    expect(beforeRow?.id).toBeTruthy();

    const beforeEditId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      ASSETS_PAGE.entityType,
    );
    await openEditForName(page, ctx.seeded.assets.activeName);
    await page.locator("[data-modal-form] [data-field='name']").fill(editName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${editName} UR`);
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/assets/i);

    const afterEdit = await db("erp.assets")
      .select("id", "description", "is_active")
      .where({ id: ctx.seeded.assets.activeId })
      .first();
    expect(String(afterEdit?.description || "")).toBe(
      String(beforeRow?.description || ""),
    );

    const editPending = await waitForQueuedApproval(
      ctx.operatorUserId,
      ASSETS_PAGE.entityType,
      beforeEditId,
    );
    ctx.approvalIds.push(editPending.id);
    expect(String(editPending.entity_id)).toBe(
      String(ctx.seeded.assets.activeId),
    );
    if (ctx.support.assetsName) {
      expect(String(editPending.new_value?.name || "")).toBe(editName);
    } else {
      expect(String(editPending.new_value?.description || "")).toBe(editName);
    }

    const beforeToggleId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      ASSETS_PAGE.entityType,
    );
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.assets.activeName);
    const row = visibleRows(page)
      .filter({ hasText: ctx.seeded.assets.activeName })
      .first();
    await expect(row).toContainText(ctx.seeded.assets.activeName);
    await row.locator("[data-toggle]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await submitVisibleConfirmModal(page);

    await expect(page).toHaveURL(/\/master-data\/assets/i);

    const afterToggle = await db("erp.assets")
      .select("id", "is_active")
      .where({ id: ctx.seeded.assets.activeId })
      .first();
    expect(Boolean(afterToggle?.is_active)).toBe(true);

    const togglePending = await waitForQueuedApproval(
      ctx.operatorUserId,
      ASSETS_PAGE.entityType,
      beforeToggleId,
    );
    ctx.approvalIds.push(togglePending.id);
    expect(String(togglePending.entity_id)).toBe(
      String(ctx.seeded.assets.activeId),
    );
    expect(Boolean(togglePending.new_value?.is_active)).toBe(false);
    expect(togglePending.new_value?._approval_action).toBe("delete");

    await setApprovalPolicies(ASSETS_PAGE.scopeKey, false, false, false);
  });

  test("asset types: admin CRUD create/edit/delete works as expected", async ({
    page,
  }) => {
    await setApprovalPolicies(ASSET_TYPES_PAGE.scopeKey, false, false, false);

    const createName = `${ctx.token}-AT-CRUD-CREATE`;
    const editName = `${ctx.token}-AT-CRUD-EDIT`;

    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    await page.goto(ASSET_TYPES_PAGE.url, { waitUntil: "domcontentloaded" });

    await fillAssetTypeCreateForm(page, {
      name: createName,
      nameUr: `${createName} UR`,
    });

    await expect(page).toHaveURL(/\/master-data\/asset-types/i);
    let created = await db("erp.asset_type_registry")
      .select("code", "name", "is_active")
      .whereRaw("lower(name) = lower(?)", [createName])
      .first();
    expect(created?.code).toBeTruthy();
    expect(Boolean(created?.is_active)).toBe(true);
    ctx.created.assetTypeCodes.push(String(created.code || "").toUpperCase());

    await openEditForName(page, createName);
    await page.locator("[data-modal-form] [data-field='name']").fill(editName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${editName} UR`);
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/asset-types/i);
    created = await db("erp.asset_type_registry")
      .select("code", "name", "is_active")
      .where({ code: created.code })
      .first();
    expect(String(created?.name || "")).toBe(editName);

    await page.locator("[data-search-input]").fill(editName);
    const row = visibleRows(page).filter({ hasText: editName }).first();
    await expect(row).toContainText(editName);
    await row.locator("[data-delete]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await submitVisibleConfirmModal(page);

    await expect
      .poll(async () => {
        const rowState = await db("erp.asset_type_registry")
          .select("code")
          .where({ code: created.code })
          .first();
        return Boolean(rowState);
      })
      .toBe(false);
    ctx.created.assetTypeCodes = ctx.created.assetTypeCodes.filter(
      (code) => code !== String(created.code || "").toUpperCase(),
    );
  });

  test("assets: admin CRUD create/edit/delete works as expected", async ({
    page,
  }) => {
    await setApprovalPolicies(ASSETS_PAGE.scopeKey, false, false, false);

    const createName = `${ctx.token}-ASSET-CRUD-CREATE`;
    const editName = `${ctx.token}-ASSET-CRUD-EDIT`;

    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    await page.goto(ASSETS_PAGE.url, { waitUntil: "domcontentloaded" });

    await fillAssetCreateForm(page, {
      name: createName,
      nameUr: `${createName} UR`,
      assetTypeCode: ctx.fixtures.existingAssetTypeCode,
      branchId: ctx.branchId,
    });

    await expect(page).toHaveURL(/\/master-data\/assets/i);
    let created = await db("erp.assets")
      .select("id", "description", "is_active")
      .whereRaw("lower(description) = lower(?)", [createName])
      .orderBy("id", "desc")
      .first();
    expect(created?.id).toBeTruthy();
    expect(Boolean(created?.is_active)).toBe(true);
    ctx.created.assetIds.push(Number(created.id));

    await openEditForName(page, createName);
    await page.locator("[data-modal-form] [data-field='name']").fill(editName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${editName} UR`);
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/assets/i);
    created = await db("erp.assets")
      .select("id", "description", "is_active")
      .where({ id: created.id })
      .first();
    expect(String(created?.description || "")).toBe(editName);

    await page.locator("[data-search-input]").fill(editName);
    const row = visibleRows(page).filter({ hasText: editName }).first();
    await expect(row).toContainText(editName);
    await row.locator("[data-delete]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await submitVisibleConfirmModal(page);

    await expect
      .poll(async () => {
        const rowState = await db("erp.assets")
          .select("id")
          .where({ id: created.id })
          .first();
        return Boolean(rowState);
      })
      .toBe(false);
    ctx.created.assetIds = ctx.created.assetIds.filter(
      (id) => Number(id) !== Number(created.id),
    );
  });

  test("asset types: hard delete is blocked when type is referenced by an asset", async ({
    page,
  }) => {
    await setApprovalPolicies(ASSET_TYPES_PAGE.scopeKey, false, false, false);

    const inUseName = `${ctx.token}-AT-INUSE`;
    const inUseCode = buildUniqueAssetTypeCode(ctx.token, "INUSE");

    await db("erp.asset_type_registry").insert({
      code: inUseCode,
      name: inUseName,
      ...(ctx.support.assetTypeNameUr ? { name_ur: `${inUseName} UR` } : {}),
      description: inUseName,
      is_active: true,
    });
    ctx.created.assetTypeCodes.push(inUseCode);

    const [assetInsert] = await db("erp.assets")
      .insert({
        asset_code: buildUniqueAssetCode(ctx.token, "LOCK"),
        asset_type_code: inUseCode,
        description: `${inUseName}-ASSET`,
        home_branch_id: ctx.branchId,
        is_active: true,
        ...(ctx.support.assetsName ? { name: `${inUseName}-ASSET` } : {}),
        ...(ctx.support.assetsNameUr
          ? { name_ur: `${inUseName}-ASSET UR` }
          : {}),
        ...(ctx.support.assetsCreatedBy ? { created_by: ctx.adminUserId } : {}),
        ...(ctx.support.assetsCreatedAt ? { created_at: db.fn.now() } : {}),
        ...(ctx.support.assetsUpdatedBy ? { updated_by: ctx.adminUserId } : {}),
        ...(ctx.support.assetsUpdatedAt ? { updated_at: db.fn.now() } : {}),
      })
      .returning(["id"]);
    const assetId = Number(assetInsert?.id || assetInsert || 0);
    if (assetId > 0) ctx.created.assetIds.push(assetId);

    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    await page.goto(ASSET_TYPES_PAGE.url, { waitUntil: "domcontentloaded" });

    await page.locator("[data-search-input]").fill(inUseName);
    const row = visibleRows(page).filter({ hasText: inUseName }).first();
    await expect(row).toContainText(inUseName);

    await row.locator("[data-delete]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await submitVisibleConfirmModal(page);
    await page.waitForLoadState("domcontentloaded");

    const stillThere = await db("erp.asset_type_registry")
      .select("code")
      .where({ code: inUseCode })
      .first();
    expect(stillThere?.code).toBe(inUseCode);
  });
});
