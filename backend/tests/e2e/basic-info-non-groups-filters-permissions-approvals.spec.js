const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
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

const NON_GROUP_PAGES = [
  {
    key: "units",
    url: "/master-data/basic-info/units",
    scopeKey: "master_data.basic_info.units",
    entityType: "UOM",
    table: "erp.uom",
    hasStatusFilter: true,
    hasNewRoute: true,
    seed: "generic",
  },
  {
    key: "sizes",
    url: "/master-data/basic-info/sizes",
    scopeKey: "master_data.basic_info.sizes",
    entityType: "SIZE",
    table: "erp.sizes",
    hasStatusFilter: true,
    hasNewRoute: true,
    seed: "generic",
  },
  {
    key: "colors",
    url: "/master-data/basic-info/colors",
    scopeKey: "master_data.basic_info.colors",
    entityType: "COLOR",
    table: "erp.colors",
    hasStatusFilter: true,
    hasNewRoute: true,
    seed: "generic",
  },
  {
    key: "grades",
    url: "/master-data/basic-info/grades",
    scopeKey: "master_data.basic_info.grades",
    entityType: "GRADE",
    table: "erp.grades",
    hasStatusFilter: true,
    hasNewRoute: true,
    seed: "generic",
  },
  {
    key: "packing-types",
    url: "/master-data/basic-info/packing-types",
    scopeKey: "master_data.basic_info.packing_types",
    entityType: "PACKING_TYPE",
    table: "erp.packing_types",
    hasStatusFilter: true,
    hasNewRoute: true,
    seed: "generic",
  },
  {
    key: "cities",
    url: "/master-data/basic-info/cities",
    scopeKey: "master_data.basic_info.cities",
    entityType: "CITY",
    table: "erp.cities",
    hasStatusFilter: true,
    hasNewRoute: true,
    seed: "generic",
  },
  {
    key: "uom-conversions",
    url: "/master-data/basic-info/uom-conversions",
    scopeKey: "master_data.basic_info.uom_conversions",
    entityType: "UOM_CONVERSION",
    table: "erp.uom_conversions",
    hasStatusFilter: false,
    hasNewRoute: false,
    seed: "uom-conversions",
  },
];

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

const getVisibleTexts = async (page) =>
  page
    .locator("[data-table-body] tr[data-row]:not(.hidden)")
    .evaluateAll((rows) =>
      rows
        .map((row) =>
          String(row.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean),
    );

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

const insertId = async (table, payload) => {
  const [inserted] = await db(table).insert(payload).returning(["id"]);
  return Number(inserted?.id || inserted || 0);
};

const createNamedSeedRows = async ({ pageKey, token, createdBy }) => {
  const activeName = `${token}-${pageKey}-ACTIVE-A`;
  const inactiveName = `${token}-${pageKey}-INACTIVE`;
  const activeNameB = `${token}-${pageKey}-ACTIVE-B`;
  let unitCodeSeq = 1;

  const insertBase = (name, isActive) => {
    const payload = {
      name,
      name_ur: `${name} UR`,
      is_active: Boolean(isActive),
      created_by: createdBy,
    };
    if (pageKey === "units") {
      const suffix = String(unitCodeSeq++).padStart(2, "0");
      const entropy = `${Date.now()}${Math.floor(Math.random() * 10000)}`.slice(
        -8,
      );
      payload.code = `U${suffix}${entropy}`.slice(0, 18);
    }
    if (pageKey === "grades") {
      payload.grade_rank = isActive ? 1 : 2;
    }
    return payload;
  };

  const tableMap = {
    units: "erp.uom",
    sizes: "erp.sizes",
    colors: "erp.colors",
    grades: "erp.grades",
    "packing-types": "erp.packing_types",
    cities: "erp.cities",
  };

  const table = tableMap[pageKey];
  const activeId = await insertId(table, insertBase(activeName, true));
  const inactiveId = await insertId(table, insertBase(inactiveName, false));
  const activeIdB = await insertId(table, insertBase(activeNameB, true));

  if (pageKey === "sizes") {
    const sizeIds = [activeId, inactiveId, activeIdB].filter(Boolean);
    const rows = [];
    sizeIds.forEach((sizeId) => {
      rows.push({ size_id: sizeId, item_type: "RM" });
      rows.push({ size_id: sizeId, item_type: "SFG" });
      rows.push({ size_id: sizeId, item_type: "FG" });
    });
    if (rows.length) {
      await db("erp.size_item_types").insert(rows);
    }
  }

  return {
    type: "generic",
    token: `${token}-${pageKey}`,
    activeName,
    inactiveName,
    activeNameB,
    activeId,
    inactiveId,
    activeIdB,
    allIds: [activeId, inactiveId, activeIdB].filter(Boolean),
  };
};

const createUomConversionSeedRows = async ({ token, createdBy }) => {
  const makeUnit = async (suffix) => {
    const cleanToken = `${token}`.replace(/[^A-Za-z0-9]/g, "");
    const code = `UC${suffix}${cleanToken.slice(-12)}`.slice(0, 18);
    const id = await insertId("erp.uom", {
      code,
      name: `${token}-${suffix}`,
      name_ur: `${token}-${suffix} UR`,
      is_active: true,
      created_by: createdBy,
    });
    return { id, code };
  };

  const u1 = await makeUnit("U1");
  const u2 = await makeUnit("U2");
  const u3 = await makeUnit("U3");
  const u4 = await makeUnit("U4");

  const activeId = await insertId("erp.uom_conversions", {
    from_uom_id: u1.id,
    to_uom_id: u2.id,
    factor: 1.5,
    is_active: true,
    created_by: createdBy,
  });
  const inactiveId = await insertId("erp.uom_conversions", {
    from_uom_id: u2.id,
    to_uom_id: u3.id,
    factor: 2.0,
    is_active: false,
    created_by: createdBy,
  });
  const activeIdB = await insertId("erp.uom_conversions", {
    from_uom_id: u3.id,
    to_uom_id: u1.id,
    factor: 3.0,
    is_active: true,
    created_by: createdBy,
  });

  return {
    type: "uom-conversions",
    token,
    activeId,
    inactiveId,
    activeIdB,
    allIds: [activeId, inactiveId, activeIdB].filter(Boolean),
    uoms: [u1, u2, u3, u4],
    searchHit: u1.code,
    activeSearch: `${u1.code} ${u2.code}`,
    searchMiss: `${token}-NO-MATCH`,
  };
};

const fillGenericCreateForm = async (page, pageKey, values) => {
  await page.locator("[data-modal-open]").click();
  await expect(page.locator("[data-modal]")).toBeVisible();

  await page.locator("[data-modal-form] [data-field='name']").fill(values.name);
  await page
    .locator("[data-modal-form] [data-field='name_ur']")
    .fill(values.nameUr);

  if (pageKey === "grades") {
    await page
      .locator("[data-modal-form] [data-field='grade_rank']")
      .fill(String(values.gradeRank || 1));
  }

  if (pageKey === "sizes") {
    const checkbox = page
      .locator(
        "[data-modal-form] input[type='checkbox'][data-field='item_types'][value='RM']",
      )
      .first();
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
  }

  await page.locator("[data-modal-form] button[type='submit']").click();
};

const fillGenericEditForm = async (page, pageKey, values) => {
  await page.locator("[data-modal-form] [data-field='name']").fill(values.name);
  await page
    .locator("[data-modal-form] [data-field='name_ur']")
    .fill(values.nameUr);

  if (pageKey === "grades") {
    await page
      .locator("[data-modal-form] [data-field='grade_rank']")
      .fill(String(values.gradeRank || 1));
  }

  if (pageKey === "sizes") {
    const checkbox = page
      .locator(
        "[data-modal-form] input[type='checkbox'][data-field='item_types'][value='RM']",
      )
      .first();
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
  }

  await page.locator("[data-modal-form] button[type='submit']").click();
};

const selectByValue = async (select, value) => {
  await select.evaluate((el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(value));
};

const fillUomConversionCreateForm = async (page, values) => {
  await page.locator("[data-modal-open]").click();
  await expect(page.locator("[data-modal]")).toBeVisible();

  await selectByValue(
    page.locator("[data-modal-form] select[data-field='from_uom_id']").first(),
    values.fromUomId,
  );
  await selectByValue(
    page.locator("[data-modal-form] select[data-field='to_uom_id']").first(),
    values.toUomId,
  );
  await page
    .locator("[data-modal-form] [data-field='factor']")
    .fill(String(values.factor));
  await page.locator("[data-modal-form] button[type='submit']").click();
};

const fillUomConversionEditForm = async (page, values) => {
  await page
    .locator("[data-modal-form] [data-field='factor']")
    .fill(String(values.factor));
  await page.locator("[data-modal-form] button[type='submit']").click();
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

test.describe("Basic Info non-groups pages - filters, permissions, approvals", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    viewerUserId: null,
    operatorUserId: null,
    viewerCredentials: {
      username: `e2e_bi_view_${Date.now()}`.slice(0, 24),
      password: "Viewer@123",
    },
    operatorCredentials: {
      username: `e2e_bi_ops_${Date.now()}`.slice(0, 24),
      password: "Operator@123",
    },
    token: `E2E-BI-NON-GRP-${Date.now()}`,
    approvalIds: [],
    policySnapshot: new Map(),
    seeded: {},
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

    const scopeKeys = NON_GROUP_PAGES.map((page) => page.scopeKey);

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
      ctx.skipReason =
        "Unable to create E2E users for Basic Info non-groups tests.";
      return;
    }

    ctx.viewerUserId = Number(viewerUserId);
    ctx.operatorUserId = Number(operatorUserId);

    for (const page of NON_GROUP_PAGES) {
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

      if (page.seed === "generic") {
        ctx.seeded[page.key] = await createNamedSeedRows({
          pageKey: page.key,
          token: ctx.token,
          createdBy: ctx.adminUserId,
        });
      } else if (page.seed === "uom-conversions") {
        ctx.seeded[page.key] = await createUomConversionSeedRows({
          token: `${ctx.token}-UC`,
          createdBy: ctx.adminUserId,
        });
      }
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

    const genericKeys = [
      "sizes",
      "units",
      "colors",
      "grades",
      "packing-types",
      "cities",
    ];
    for (const key of genericKeys) {
      const seed = ctx.seeded[key];
      if (!seed?.allIds?.length) continue;
      if (key === "sizes") {
        await db("erp.size_item_types").whereIn("size_id", seed.allIds).del();
      }
      const tableMap = {
        units: "erp.uom",
        sizes: "erp.sizes",
        colors: "erp.colors",
        grades: "erp.grades",
        "packing-types": "erp.packing_types",
        cities: "erp.cities",
      };
      await db(tableMap[key]).whereIn("id", seed.allIds).del();
    }

    const convSeed = ctx.seeded["uom-conversions"];
    if (convSeed?.allIds?.length) {
      await db("erp.uom_conversions").whereIn("id", convSeed.allIds).del();
    }
    if (convSeed?.uoms?.length) {
      await db("erp.uom")
        .whereIn(
          "id",
          convSeed.uoms.map((uom) => Number(uom.id)).filter(Boolean),
        )
        .del();
    }

    const scopeKeys = NON_GROUP_PAGES.map((page) => page.scopeKey);
    if (ctx.viewerUserId) {
      await clearUserPermissionsOverride({
        userId: ctx.viewerUserId,
        scopeKeys,
      });
    }
    if (ctx.operatorUserId) {
      await clearUserPermissionsOverride({
        userId: ctx.operatorUserId,
        scopeKeys,
      });
    }

    for (const page of NON_GROUP_PAGES) {
      for (const action of ["create", "edit", "delete"]) {
        const key = `${page.scopeKey}|${action}`;
        const snapshot = ctx.policySnapshot.get(key);
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

  for (const pageDef of NON_GROUP_PAGES) {
    test(`${pageDef.key}: filters behave correctly`, async ({ page }) => {
      const seed = ctx.seeded[pageDef.key];

      await login(page, "E2E_ADMIN");
      const response = await page.goto(pageDef.url, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBe(200);

      const search = page.locator("[data-search-input]");
      const pageSize = page.locator("[data-page-size]");

      if (seed.type === "generic") {
        await search.fill(seed.activeName);
        await expect(visibleRows(page).first()).toContainText(seed.activeName);

        await search.fill("__NO_MATCH_FILTER_CHECK__");
        await expect(visibleRows(page)).toHaveCount(0);

        await search.fill(seed.token);
      } else {
        await search.fill(seed.searchHit);
        await expect(visibleRows(page).first()).toContainText(seed.searchHit);

        await search.fill(seed.searchMiss);
        await expect(visibleRows(page)).toHaveCount(0);

        await search.fill(seed.token);
      }

      if (pageDef.hasStatusFilter) {
        const status = page.locator("[data-status-filter]");
        await status.selectOption("inactive");
        const inactiveNames = await getVisibleNames(page);
        expect(inactiveNames).toContain(seed.inactiveName);
        expect(inactiveNames).not.toContain(seed.activeName);

        await status.selectOption("active");
        const activeNames = await getVisibleNames(page);
        expect(activeNames).toContain(seed.activeName);
        expect(activeNames).toContain(seed.activeNameB);
        expect(activeNames).not.toContain(seed.inactiveName);

        await status.selectOption("all");
      }

      const sortByName = page.locator("[data-sort-key='name']").first();
      if (await sortByName.count()) {
        await search.fill(seed.token);
        await sortByName.click();
        const asc = await getVisibleNames(page);
        const ascSorted = [...asc].sort((a, b) => a.localeCompare(b));
        expect(asc).toEqual(ascSorted);

        await sortByName.click();
        const desc = await getVisibleNames(page);
        const descSorted = [...desc].sort((a, b) => b.localeCompare(a));
        expect(desc).toEqual(descSorted);
      }

      if (await pageSize.count()) {
        await pageSize.selectOption("all");
        const countAll = await visibleRows(page).count();

        await pageSize.selectOption("10");
        const countTen = await visibleRows(page).count();
        expect(countTen).toBeLessThanOrEqual(10);

        const nextPage = page.locator("[data-next-page]").first();
        const indicator = page.locator("[data-page-indicator]").first();
        if (
          countAll > 10 &&
          (await nextPage.count()) &&
          (await indicator.count())
        ) {
          await nextPage.click();
          await expect(indicator).toHaveText("2");
          await page.locator("[data-prev-page]").first().click();
          await expect(indicator).toHaveText("1");
        }
      }
    });

    test(`${pageDef.key}: view-only user can view but cannot modify`, async ({
      page,
    }) => {
      await loginWithCredentials(
        page,
        ctx.viewerCredentials.username,
        ctx.viewerCredentials.password,
      );
      const response = await page.goto(pageDef.url, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBe(200);

      await expect(page.locator("[data-modal-open]")).toHaveCount(0);
      await expect(
        page.locator("[data-edit]", { hasText: /edit/i }),
      ).toHaveCount(0);
      await expect(page.locator("[data-toggle]")).toHaveCount(0);
      await expect(page.locator("[data-delete]")).toHaveCount(0);

      if (pageDef.hasNewRoute) {
        const newPageResponse = await page.goto(`${pageDef.url}/new`, {
          waitUntil: "domcontentloaded",
        });
        expect(newPageResponse?.status()).toBe(403);
      }
    });

    test(`${pageDef.key}: operator actions are queued for approval (create/edit/toggle)`, async ({
      page,
    }) => {
      const seed = ctx.seeded[pageDef.key];
      await setApprovalPolicies(pageDef.scopeKey, true, true, true);

      await loginWithCredentials(
        page,
        ctx.operatorCredentials.username,
        ctx.operatorCredentials.password,
      );
      await page.goto(pageDef.url, { waitUntil: "domcontentloaded" });

      if (seed.type === "generic") {
        const createName = `${ctx.token}-${pageDef.key}-QUEUE-CREATE`;
        const beforeCreateId = await getLatestPendingApprovalId(
          ctx.operatorUserId,
          pageDef.entityType,
        );

        await fillGenericCreateForm(page, pageDef.key, {
          name: createName,
          nameUr: `${createName} UR`,
          gradeRank: 7,
        });

        await expect(page).toHaveURL(
          new RegExp(pageDef.url.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        );

        const inserted = await db(pageDef.table)
          .whereRaw("lower(name) = lower(?)", [createName])
          .first();
        expect(inserted).toBeFalsy();

        const createPending = await waitForQueuedApproval(
          ctx.operatorUserId,
          pageDef.entityType,
          beforeCreateId,
        );
        ctx.approvalIds.push(createPending.id);
        expect(String(createPending.entity_id)).toBe("NEW");
        expect(String(createPending.new_value?.name || "")).toBe(createName);

        const editName = `${ctx.token}-${pageDef.key}-QUEUE-EDIT`;
        const beforeEdit = await db(pageDef.table)
          .select("id", "name", "is_active")
          .where({ id: seed.activeId })
          .first();
        expect(beforeEdit?.id).toBeTruthy();

        const beforeEditId = await getLatestPendingApprovalId(
          ctx.operatorUserId,
          pageDef.entityType,
        );
        await page.locator("[data-search-input]").fill(seed.activeName);
        await expect(visibleRows(page).first()).toContainText(seed.activeName);
        await visibleRows(page).first().locator("[data-edit]").first().click();
        await expect(page.locator("[data-modal]")).toBeVisible();

        await fillGenericEditForm(page, pageDef.key, {
          name: editName,
          nameUr: `${editName} UR`,
          gradeRank: 8,
        });

        await expect(page).toHaveURL(
          new RegExp(pageDef.url.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        );

        const afterEdit = await db(pageDef.table)
          .select("id", "name", "is_active")
          .where({ id: seed.activeId })
          .first();
        expect(String(afterEdit?.name || "")).toBe(
          String(beforeEdit?.name || ""),
        );
        expect(Boolean(afterEdit?.is_active)).toBe(
          Boolean(beforeEdit?.is_active),
        );

        const editPending = await waitForQueuedApproval(
          ctx.operatorUserId,
          pageDef.entityType,
          beforeEditId,
        );
        ctx.approvalIds.push(editPending.id);
        expect(String(editPending.entity_id)).toBe(String(seed.activeId));
        expect(String(editPending.new_value?.name || "")).toBe(editName);

        const beforeToggleId = await getLatestPendingApprovalId(
          ctx.operatorUserId,
          pageDef.entityType,
        );
        await page.locator("[data-search-input]").fill(seed.activeName);
        await expect(visibleRows(page).first()).toContainText(seed.activeName);
        await visibleRows(page)
          .first()
          .locator("[data-toggle]")
          .first()
          .click();
        await expect(page.locator("[data-confirm-modal]")).toBeVisible();
        await page
          .locator("[data-confirm-form] button[type='submit']")
          .first()
          .click();
        await expect(page).toHaveURL(
          new RegExp(pageDef.url.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        );

        const afterToggle = await db(pageDef.table)
          .select("is_active")
          .where({ id: seed.activeId })
          .first();
        expect(Boolean(afterToggle?.is_active)).toBe(true);

        const togglePending = await waitForQueuedApproval(
          ctx.operatorUserId,
          pageDef.entityType,
          beforeToggleId,
        );
        ctx.approvalIds.push(togglePending.id);
        expect(String(togglePending.entity_id)).toBe(String(seed.activeId));
        expect(Boolean(togglePending.new_value?.is_active)).toBe(false);
      } else {
        const beforeCreateId = await getLatestPendingApprovalId(
          ctx.operatorUserId,
          pageDef.entityType,
        );
        const createPayload = {
          fromUomId: seed.uoms[3].id,
          toUomId: seed.uoms[1].id,
          factor: 4.25,
        };

        await fillUomConversionCreateForm(page, createPayload);
        await expect(page).toHaveURL(
          new RegExp(pageDef.url.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        );

        const inserted = await db("erp.uom_conversions")
          .where({
            from_uom_id: Number(createPayload.fromUomId),
            to_uom_id: Number(createPayload.toUomId),
          })
          .andWhere("factor", Number(createPayload.factor))
          .first();
        expect(inserted).toBeFalsy();

        const createPending = await waitForQueuedApproval(
          ctx.operatorUserId,
          pageDef.entityType,
          beforeCreateId,
        );
        ctx.approvalIds.push(createPending.id);
        expect(String(createPending.entity_id)).toBe("NEW");
        expect(Number(createPending.new_value?.from_uom_id || 0)).toBe(
          Number(createPayload.fromUomId),
        );
        expect(Number(createPending.new_value?.to_uom_id || 0)).toBe(
          Number(createPayload.toUomId),
        );

        const beforeEdit = await db("erp.uom_conversions")
          .select("id", "factor", "is_active")
          .where({ id: seed.activeId })
          .first();
        expect(beforeEdit?.id).toBeTruthy();

        const findUomRowIndexById = async (conversionId) =>
          page.locator("[data-table-body] tr[data-row]").evaluateAll(
            (rows, targetId) =>
              rows.findIndex((row) => {
                const idCell = row.querySelector("td:nth-child(2)");
                return (
                  String(idCell?.textContent || "").trim() === String(targetId)
                );
              }),
            String(conversionId),
          );

        const getUomRowById = async (conversionId) => {
          const rowIndex = await findUomRowIndexById(conversionId);
          expect(rowIndex).toBeGreaterThanOrEqual(0);
          return page.locator("[data-table-body] tr[data-row]").nth(rowIndex);
        };

        const beforeEditId = await getLatestPendingApprovalId(
          ctx.operatorUserId,
          pageDef.entityType,
        );
        const editTargetRow = await getUomRowById(seed.activeId);
        await editTargetRow.locator("[data-edit]").first().click();
        await expect(page.locator("[data-modal]")).toBeVisible();
        await fillUomConversionEditForm(page, { factor: 9.99 });
        await expect(page).toHaveURL(
          new RegExp(pageDef.url.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        );

        const afterEdit = await db("erp.uom_conversions")
          .select("id", "factor", "is_active")
          .where({ id: seed.activeId })
          .first();
        expect(Number(afterEdit?.factor || 0)).toBe(
          Number(beforeEdit?.factor || 0),
        );

        const editPending = await waitForQueuedApproval(
          ctx.operatorUserId,
          pageDef.entityType,
          beforeEditId,
        );
        ctx.approvalIds.push(editPending.id);
        expect(String(editPending.entity_id)).toBe(String(seed.activeId));
        expect(Number(editPending.new_value?.factor || 0)).toBe(9.99);

        const beforeToggleId = await getLatestPendingApprovalId(
          ctx.operatorUserId,
          pageDef.entityType,
        );
        const toggleTargetRow = await getUomRowById(seed.activeId);
        await toggleTargetRow.locator("[data-toggle]").first().click();
        await expect(page.locator("[data-confirm-modal]")).toBeVisible();
        await page
          .locator("[data-confirm-form] button[type='submit']")
          .first()
          .click();
        await expect(page).toHaveURL(
          new RegExp(pageDef.url.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        );

        const afterToggle = await db("erp.uom_conversions")
          .select("is_active")
          .where({ id: seed.activeId })
          .first();
        expect(Boolean(afterToggle?.is_active)).toBe(true);

        const togglePending = await waitForQueuedApproval(
          ctx.operatorUserId,
          pageDef.entityType,
          beforeToggleId,
        );
        ctx.approvalIds.push(togglePending.id);
        expect(String(togglePending.entity_id)).toBe(String(seed.activeId));
        expect(Boolean(togglePending.new_value?.is_active)).toBe(false);
      }

      await setApprovalPolicies(pageDef.scopeKey, false, false, false);
    });
  }
});
