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

const PAGES = [
  {
    key: "accounts",
    url: "/master-data/basic-info/accounts",
    scopeKey: "master_data.accounts",
    entityType: "ACCOUNT",
    table: "erp.accounts",
  },
  {
    key: "parties",
    url: "/master-data/basic-info/parties",
    scopeKey: "master_data.parties",
    entityType: "PARTY",
    table: "erp.parties",
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

const getVisibleDatasets = async (page) =>
  page
    .locator("[data-table-body] tr[data-row]:not(.hidden)")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        name: String(row.getAttribute("data-name") || "").trim(),
        accountType: String(row.getAttribute("data-account-type") || "").trim(),
        accountGroup: String(
          row.getAttribute("data-account-group") || "",
        ).trim(),
        partyType: String(row.getAttribute("data-party-type") || "").trim(),
        partyGroup: String(row.getAttribute("data-party-group") || "").trim(),
        branch: String(row.getAttribute("data-branch") || "").trim(),
      })),
    );

const selectByValue = async (selectLocator, value) => {
  await selectLocator.evaluate((el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(value));
};

const selectMultiValues = async (selectLocator, values) => {
  await selectLocator.evaluate(
    (el, selectedValues) => {
      const wanted = new Set(
        (Array.isArray(selectedValues) ? selectedValues : []).map((v) =>
          String(v),
        ),
      );
      Array.from(el.options).forEach((opt) => {
        opt.selected = wanted.has(String(opt.value));
      });
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    values.map((v) => String(v)),
  );
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

const createAccountsSeedRows = async ({
  token,
  createdBy,
  subgroupId,
  branchId,
}) => {
  const mk = (suffix) => `${token}-ACC-${suffix}`;
  const rows = [
    {
      code: `e2e_acc_${Date.now()}_${Math.floor(Math.random() * 10000)}_a`,
      name: mk("ACTIVE-A"),
      name_ur: `${mk("ACTIVE-A")} UR`,
      subgroup_id: subgroupId,
      is_active: true,
      created_by: createdBy,
    },
    {
      code: `e2e_acc_${Date.now()}_${Math.floor(Math.random() * 10000)}_i`,
      name: mk("INACTIVE"),
      name_ur: `${mk("INACTIVE")} UR`,
      subgroup_id: subgroupId,
      is_active: false,
      created_by: createdBy,
    },
    {
      code: `e2e_acc_${Date.now()}_${Math.floor(Math.random() * 10000)}_b`,
      name: mk("ACTIVE-B"),
      name_ur: `${mk("ACTIVE-B")} UR`,
      subgroup_id: subgroupId,
      is_active: true,
      created_by: createdBy,
    },
  ];

  const inserted = await db("erp.accounts")
    .insert(rows)
    .returning(["id", "name", "is_active"]);
  const ids = inserted.map((row) => Number(row.id)).filter(Boolean);

  if (ids.length) {
    await db("erp.account_branch").insert(
      ids.map((id) => ({ account_id: id, branch_id: branchId })),
    );
  }

  const activeA = inserted.find((row) => row.name === mk("ACTIVE-A"));
  const inactive = inserted.find((row) => row.name === mk("INACTIVE"));
  const activeB = inserted.find((row) => row.name === mk("ACTIVE-B"));

  return {
    token,
    activeName: mk("ACTIVE-A"),
    inactiveName: mk("INACTIVE"),
    activeNameB: mk("ACTIVE-B"),
    activeId: Number(activeA?.id || 0),
    inactiveId: Number(inactive?.id || 0),
    activeIdB: Number(activeB?.id || 0),
    allIds: ids,
  };
};

const createPartiesSeedRows = async ({
  token,
  createdBy,
  groupId,
  cityId,
  branchId,
}) => {
  const mk = (suffix) => `${token}-PTY-${suffix}`;
  const rows = [
    {
      code: `e2e_pty_${Date.now()}_${Math.floor(Math.random() * 10000)}_a`,
      name: mk("ACTIVE-A"),
      name_ur: `${mk("ACTIVE-A")} UR`,
      party_type: "CUSTOMER",
      branch_id: branchId,
      group_id: groupId,
      city_id: cityId,
      phone1: "0300-1000001",
      is_active: true,
      credit_allowed: true,
      credit_limit: 500000,
      created_by: createdBy,
    },
    {
      code: `e2e_pty_${Date.now()}_${Math.floor(Math.random() * 10000)}_i`,
      name: mk("INACTIVE"),
      name_ur: `${mk("INACTIVE")} UR`,
      party_type: "CUSTOMER",
      branch_id: branchId,
      group_id: groupId,
      city_id: cityId,
      phone1: "0300-1000002",
      is_active: false,
      credit_allowed: true,
      credit_limit: 500000,
      created_by: createdBy,
    },
    {
      code: `e2e_pty_${Date.now()}_${Math.floor(Math.random() * 10000)}_b`,
      name: mk("ACTIVE-B"),
      name_ur: `${mk("ACTIVE-B")} UR`,
      party_type: "CUSTOMER",
      branch_id: branchId,
      group_id: groupId,
      city_id: cityId,
      phone1: "0300-1000003",
      is_active: true,
      credit_allowed: true,
      credit_limit: 500000,
      created_by: createdBy,
    },
  ];

  const inserted = await db("erp.parties")
    .insert(rows)
    .returning(["id", "name", "is_active"]);
  const ids = inserted.map((row) => Number(row.id)).filter(Boolean);

  if (ids.length) {
    await db("erp.party_branch").insert(
      ids.map((id) => ({ party_id: id, branch_id: branchId })),
    );
  }

  const activeA = inserted.find((row) => row.name === mk("ACTIVE-A"));
  const inactive = inserted.find((row) => row.name === mk("INACTIVE"));
  const activeB = inserted.find((row) => row.name === mk("ACTIVE-B"));

  return {
    token,
    activeName: mk("ACTIVE-A"),
    inactiveName: mk("INACTIVE"),
    activeNameB: mk("ACTIVE-B"),
    activeId: Number(activeA?.id || 0),
    inactiveId: Number(inactive?.id || 0),
    activeIdB: Number(activeB?.id || 0),
    allIds: ids,
  };
};

const openEditForName = async (page, name) => {
  await page.locator("[data-search-input]").fill(name);
  const row = visibleRows(page).filter({ hasText: name }).first();
  await expect(row).toContainText(name);
  const editButton = row.locator("[data-edit]").first();
  await expect(editButton).toBeVisible();
  await editButton.click();
  await expect(page.locator("[data-modal]")).toBeVisible();
};

const fillAccountsCreateForm = async (page, values) => {
  await page.locator("[data-modal-open]").first().click();
  await expect(page.locator("[data-modal]")).toBeVisible();

  await page.locator("[data-modal-form] [data-field='name']").fill(values.name);
  await page
    .locator("[data-modal-form] [data-field='name_ur']")
    .fill(values.nameUr);
  await selectByValue(
    page.locator("[data-modal-form] select[data-field='account_type']").first(),
    values.accountType,
  );
  await expect(
    page.locator(
      `[data-modal-form] select[data-field='subgroup_id'] option[value='${values.subgroupId}']`,
    ),
  ).toHaveCount(1);
  await selectByValue(
    page.locator("[data-modal-form] select[data-field='subgroup_id']").first(),
    values.subgroupId,
  );
  await selectMultiValues(
    page.locator("[data-modal-form] select[data-field='branch_ids']").first(),
    [values.branchId],
  );

  await page.locator("[data-modal-form] button[type='submit']").click();
};

const fillPartiesCreateForm = async (page, values) => {
  await page.locator("[data-modal-open]").first().click();
  await expect(page.locator("[data-modal]")).toBeVisible();

  await page.locator("[data-modal-form] [data-field='name']").fill(values.name);
  await page
    .locator("[data-modal-form] [data-field='name_ur']")
    .fill(values.nameUr);
  await selectByValue(
    page.locator("[data-modal-form] select[data-field='party_type']").first(),
    "CUSTOMER",
  );
  await selectByValue(
    page.locator("[data-modal-form] select[data-field='group_id']").first(),
    values.groupId,
  );
  await selectMultiValues(
    page.locator("[data-modal-form] select[data-field='branch_ids']").first(),
    [values.branchId],
  );
  await selectByValue(
    page.locator("[data-modal-form] select[data-field='city_id']").first(),
    values.cityId,
  );
  await page
    .locator("[data-modal-form] [data-field='phone1']")
    .fill(values.phone1);

  await page.locator("[data-modal-form] button[type='submit']").click();
};

test.describe("Master Data Accounts & Parties - filters, permissions, approvals", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    viewerUserId: null,
    operatorUserId: null,
    viewerCredentials: {
      username: `e2e_ap_view_${Date.now()}`.slice(0, 24),
      password: "Viewer@123",
    },
    operatorCredentials: {
      username: `e2e_ap_ops_${Date.now()}`.slice(0, 24),
      password: "Operator@123",
    },
    token: `E2E-ACC-PARTY-${Date.now()}`,
    approvalIds: [],
    policySnapshot: new Map(),
    fixtures: {
      accountGroupId: null,
      accountGroupName: "",
      accountType: "",
      partyGroupId: null,
      partyGroupName: "",
      cityId: null,
    },
    seeded: {
      accounts: null,
      parties: null,
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

    const [accountGroup, city, partyGroup] = await Promise.all([
      db("erp.account_groups")
        .select("id", "name", "account_type")
        .where({ is_active: true })
        .whereNotNull("account_type")
        .orderBy("id", "asc")
        .first(),
      db("erp.cities")
        .select("id", "name")
        .where({ is_active: true })
        .orderBy("id", "asc")
        .first(),
      db("erp.party_groups")
        .select("id", "name", "party_type")
        .where({ is_active: true })
        .whereIn("party_type", ["CUSTOMER", "BOTH"])
        .orderBy("id", "asc")
        .first(),
    ]);

    if (!accountGroup?.id || !city?.id || !partyGroup?.id) {
      ctx.skipReason =
        "Missing required lookup rows (account group, city, or party group).";
      return;
    }

    ctx.fixtures.accountGroupId = Number(accountGroup.id);
    ctx.fixtures.accountGroupName = String(accountGroup.name || "").trim();
    ctx.fixtures.accountType = String(accountGroup.account_type || "")
      .trim()
      .toUpperCase();
    ctx.fixtures.cityId = Number(city.id);
    ctx.fixtures.partyGroupId = Number(partyGroup.id);
    ctx.fixtures.partyGroupName = String(partyGroup.name || "").trim();

    if (!ctx.fixtures.accountType) {
      ctx.skipReason =
        "Unable to resolve an active account group with account_type.";
      return;
    }

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
      ctx.skipReason = "Unable to create E2E users for Accounts/Parties tests.";
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

    ctx.seeded.accounts = await createAccountsSeedRows({
      token: ctx.token,
      createdBy: ctx.adminUserId,
      subgroupId: ctx.fixtures.accountGroupId,
      branchId: ctx.branchId,
    });

    ctx.seeded.parties = await createPartiesSeedRows({
      token: ctx.token,
      createdBy: ctx.adminUserId,
      groupId: ctx.fixtures.partyGroupId,
      cityId: ctx.fixtures.cityId,
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

    const accountIds = (ctx.seeded.accounts?.allIds || []).filter(Boolean);
    if (accountIds.length) {
      await db("erp.account_branch").whereIn("account_id", accountIds).del();
      await db("erp.accounts").whereIn("id", accountIds).del();
    }

    const partyIds = (ctx.seeded.parties?.allIds || []).filter(Boolean);
    if (partyIds.length) {
      await db("erp.party_branch").whereIn("party_id", partyIds).del();
      await db("erp.parties").whereIn("id", partyIds).del();
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

  test("accounts: filters (search/status/modal filters) work correctly", async ({
    page,
  }) => {
    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    const response = await page.goto("/master-data/basic-info/accounts", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await page.locator("[data-page-size]").selectOption("all");
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.accounts.activeName);
    await expect(visibleRows(page).first()).toContainText(
      ctx.seeded.accounts.activeName,
    );

    await page.locator("[data-search-input]").fill("__NO_MATCH_ACCOUNTS__");
    await expect(visibleRows(page)).toHaveCount(0);

    await page.locator("[data-search-input]").fill(`${ctx.token}-ACC`);
    await page.locator("[data-status-filter]").selectOption("inactive");
    let names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.accounts.inactiveName);
    expect(names).not.toContain(ctx.seeded.accounts.activeName);

    await page.locator("[data-status-filter]").selectOption("active");
    names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.accounts.activeName);
    expect(names).toContain(ctx.seeded.accounts.activeNameB);
    expect(names).not.toContain(ctx.seeded.accounts.inactiveName);

    await page.locator("[data-filter-toggle]").click();
    await expect(page.locator("[data-filter-panel]")).toBeVisible();
    await page
      .locator("[data-filter-account-type]")
      .first()
      .selectOption(ctx.fixtures.accountType);
    await page
      .locator("[data-filter-account-group]")
      .first()
      .selectOption(ctx.fixtures.accountGroupName);
    await page.locator("[data-filter-apply]").click();

    const filtered = await getVisibleDatasets(page);
    expect(filtered.length).toBeGreaterThan(0);
    filtered.forEach((row) => {
      expect(row.accountType).toBe(ctx.fixtures.accountType);
      expect(row.accountGroup).toBe(ctx.fixtures.accountGroupName);
    });
  });

  test("parties: filters (search/status/modal filters) work correctly", async ({
    page,
  }) => {
    await loginWithCredentials(
      page,
      process.env.E2E_ADMIN_USER,
      process.env.E2E_ADMIN_PASS,
    );
    const response = await page.goto("/master-data/basic-info/parties", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await page.locator("[data-page-size]").selectOption("all");
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.parties.activeName);
    await expect(visibleRows(page).first()).toContainText(
      ctx.seeded.parties.activeName,
    );

    await page.locator("[data-search-input]").fill("__NO_MATCH_PARTIES__");
    await expect(visibleRows(page)).toHaveCount(0);

    await page.locator("[data-search-input]").fill(`${ctx.token}-PTY`);
    await page.locator("[data-status-filter]").selectOption("inactive");
    let names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.parties.inactiveName);
    expect(names).not.toContain(ctx.seeded.parties.activeName);

    await page.locator("[data-status-filter]").selectOption("active");
    names = await getVisibleNames(page);
    expect(names).toContain(ctx.seeded.parties.activeName);
    expect(names).toContain(ctx.seeded.parties.activeNameB);
    expect(names).not.toContain(ctx.seeded.parties.inactiveName);

    await page.locator("[data-filter-toggle]").click();
    await expect(page.locator("[data-filter-panel]")).toBeVisible();
    await page
      .locator("[data-filter-party-type]")
      .first()
      .selectOption("CUSTOMER");
    await page
      .locator("[data-filter-party-group]")
      .first()
      .selectOption(ctx.fixtures.partyGroupName);
    await page.locator("[data-filter-apply]").click();

    const filtered = await getVisibleDatasets(page);
    expect(filtered.length).toBeGreaterThan(0);
    filtered.forEach((row) => {
      expect(row.partyType).toBe("CUSTOMER");
      expect(row.partyGroup).toBe(ctx.fixtures.partyGroupName);
    });
  });

  test("accounts: view-only user cannot create/edit/delete", async ({
    page,
  }) => {
    await loginWithCredentials(
      page,
      ctx.viewerCredentials.username,
      ctx.viewerCredentials.password,
    );

    const response = await page.goto("/master-data/basic-info/accounts", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await expect(page.locator("[data-modal-open]")).toHaveCount(0);
    await expect(page.locator("[data-edit]")).toHaveCount(0);
    await expect(page.locator("[data-toggle]")).toHaveCount(0);
    await expect(page.locator("[data-delete]")).toHaveCount(0);
  });

  test("parties: view-only user cannot create/edit/delete", async ({
    page,
  }) => {
    await loginWithCredentials(
      page,
      ctx.viewerCredentials.username,
      ctx.viewerCredentials.password,
    );

    const response = await page.goto("/master-data/basic-info/parties", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await expect(page.locator("[data-modal-open]")).toHaveCount(0);
    await expect(page.locator("[data-edit]")).toHaveCount(0);
    await expect(page.locator("[data-toggle]")).toHaveCount(0);
    await expect(page.locator("[data-delete]")).toHaveCount(0);
  });

  test("accounts: create queues approval when create policy is enabled", async ({
    page,
  }) => {
    await setApprovalPolicies("master_data.accounts", true, false, false);

    const queuedName = `${ctx.token}-ACC-QUEUE-CREATE`;
    const beforeId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      "ACCOUNT",
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto("/master-data/basic-info/accounts", {
      waitUntil: "domcontentloaded",
    });

    await fillAccountsCreateForm(page, {
      name: queuedName,
      nameUr: `${queuedName} UR`,
      accountType: ctx.fixtures.accountType,
      subgroupId: ctx.fixtures.accountGroupId,
      branchId: ctx.branchId,
    });

    await expect(page).toHaveURL(/\/master-data\/basic-info\/accounts/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const inserted = await db("erp.accounts")
      .whereRaw("lower(name) = lower(?)", [queuedName])
      .first();
    expect(inserted).toBeFalsy();

    const pending = await waitForQueuedApproval(
      ctx.operatorUserId,
      "ACCOUNT",
      beforeId,
    );
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe("NEW");
    expect(pending.new_value?.name).toBe(queuedName);
    expect(pending.new_value?._approval_action).toBe("create");
  });

  test("accounts: edit queues approval and keeps row unchanged", async ({
    page,
  }) => {
    await setApprovalPolicies("master_data.accounts", false, true, false);

    const beforeRow = await db("erp.accounts")
      .select("id", "name", "is_active")
      .whereRaw("lower(name) = lower(?)", [ctx.seeded.accounts.activeName])
      .first();
    expect(beforeRow?.id).toBeTruthy();

    const queuedName = `${ctx.token}-ACC-QUEUE-EDIT`;
    const beforeId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      "ACCOUNT",
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto("/master-data/basic-info/accounts", {
      waitUntil: "domcontentloaded",
    });

    await openEditForName(page, ctx.seeded.accounts.activeName);
    await page
      .locator("[data-modal-form] [data-field='name']")
      .fill(queuedName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${queuedName} UR`);
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/basic-info\/accounts/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const currentRow = await db("erp.accounts")
      .select("id", "name", "is_active")
      .where({ id: beforeRow.id })
      .first();
    expect(currentRow?.name).toBe(beforeRow.name);
    expect(Boolean(currentRow?.is_active)).toBe(Boolean(beforeRow.is_active));

    const pending = await waitForQueuedApproval(
      ctx.operatorUserId,
      "ACCOUNT",
      beforeId,
    );
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe(String(beforeRow.id));
    expect(pending.new_value?.name).toBe(queuedName);
    expect(pending.new_value?._approval_action).toBe("edit");
  });

  test("accounts: toggle queues approval and keeps active state unchanged", async ({
    page,
  }) => {
    await setApprovalPolicies("master_data.accounts", false, false, true);

    const beforeRow = await db("erp.accounts")
      .select("id", "name", "is_active")
      .whereRaw("lower(name) = lower(?)", [ctx.seeded.accounts.activeName])
      .first();
    expect(beforeRow?.id).toBeTruthy();
    expect(Boolean(beforeRow?.is_active)).toBeTruthy();

    const beforeId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      "ACCOUNT",
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto("/master-data/basic-info/accounts", {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.accounts.activeName);

    const row = visibleRows(page).first();
    await expect(row).toContainText(ctx.seeded.accounts.activeName);
    await row.locator("[data-toggle]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await page
      .locator("[data-confirm-form] button[type='submit']")
      .first()
      .click();

    await expect(page).toHaveURL(/\/master-data\/basic-info\/accounts/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const currentRow = await db("erp.accounts")
      .select("id", "is_active")
      .where({ id: beforeRow.id })
      .first();
    expect(Boolean(currentRow?.is_active)).toBe(Boolean(beforeRow.is_active));

    const pending = await waitForQueuedApproval(
      ctx.operatorUserId,
      "ACCOUNT",
      beforeId,
    );
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe(String(beforeRow.id));
    expect(Boolean(pending.new_value?.is_active)).toBe(false);
    expect(pending.new_value?._approval_action).toBe("delete");
  });

  test("parties: create queues approval when create policy is enabled", async ({
    page,
  }) => {
    await setApprovalPolicies("master_data.parties", true, false, false);

    const queuedName = `${ctx.token}-PTY-QUEUE-CREATE`;
    const beforeId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      "PARTY",
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto("/master-data/basic-info/parties", {
      waitUntil: "domcontentloaded",
    });

    await fillPartiesCreateForm(page, {
      name: queuedName,
      nameUr: `${queuedName} UR`,
      groupId: ctx.fixtures.partyGroupId,
      cityId: ctx.fixtures.cityId,
      branchId: ctx.branchId,
      phone1: "0300-1000101",
    });

    await expect(page).toHaveURL(/\/master-data\/basic-info\/parties/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const inserted = await db("erp.parties")
      .whereRaw("lower(name) = lower(?)", [queuedName])
      .first();
    expect(inserted).toBeFalsy();

    const pending = await waitForQueuedApproval(
      ctx.operatorUserId,
      "PARTY",
      beforeId,
    );
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe("NEW");
    expect(pending.new_value?.name).toBe(queuedName);
    expect(pending.new_value?._approval_action).toBe("create");
  });

  test("parties: edit queues approval and keeps row unchanged", async ({
    page,
  }) => {
    await setApprovalPolicies("master_data.parties", false, true, false);

    const beforeRow = await db("erp.parties")
      .select("id", "name", "is_active")
      .whereRaw("lower(name) = lower(?)", [ctx.seeded.parties.activeName])
      .first();
    expect(beforeRow?.id).toBeTruthy();

    const queuedName = `${ctx.token}-PTY-QUEUE-EDIT`;
    const beforeId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      "PARTY",
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto("/master-data/basic-info/parties", {
      waitUntil: "domcontentloaded",
    });

    await openEditForName(page, ctx.seeded.parties.activeName);
    await page
      .locator("[data-modal-form] [data-field='name']")
      .fill(queuedName);
    await page
      .locator("[data-modal-form] [data-field='name_ur']")
      .fill(`${queuedName} UR`);
    await page.locator("[data-modal-form] button[type='submit']").click();

    await expect(page).toHaveURL(/\/master-data\/basic-info\/parties/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const currentRow = await db("erp.parties")
      .select("id", "name", "is_active")
      .where({ id: beforeRow.id })
      .first();
    expect(currentRow?.name).toBe(beforeRow.name);
    expect(Boolean(currentRow?.is_active)).toBe(Boolean(beforeRow.is_active));

    const pending = await waitForQueuedApproval(
      ctx.operatorUserId,
      "PARTY",
      beforeId,
    );
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe(String(beforeRow.id));
    expect(pending.new_value?.name).toBe(queuedName);
    expect(pending.new_value?._approval_action).toBe("edit");
  });

  test("parties: toggle queues approval and keeps active state unchanged", async ({
    page,
  }) => {
    await setApprovalPolicies("master_data.parties", false, false, true);

    const beforeRow = await db("erp.parties")
      .select("id", "name", "is_active")
      .whereRaw("lower(name) = lower(?)", [ctx.seeded.parties.activeName])
      .first();
    expect(beforeRow?.id).toBeTruthy();
    expect(Boolean(beforeRow?.is_active)).toBeTruthy();

    const beforeId = await getLatestPendingApprovalId(
      ctx.operatorUserId,
      "PARTY",
    );

    await loginWithCredentials(
      page,
      ctx.operatorCredentials.username,
      ctx.operatorCredentials.password,
    );
    await page.goto("/master-data/basic-info/parties", {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("[data-search-input]")
      .fill(ctx.seeded.parties.activeName);

    const row = visibleRows(page).first();
    await expect(row).toContainText(ctx.seeded.parties.activeName);
    await row.locator("[data-toggle]").first().click();
    await expect(page.locator("[data-confirm-modal]")).toBeVisible();
    await page
      .locator("[data-confirm-form] button[type='submit']")
      .first()
      .click();

    await expect(page).toHaveURL(/\/master-data\/basic-info\/parties/i);
    await expect(page.locator("[data-ui-notice-toast]")).toContainText(
      /approval|submitted|review/i,
    );

    const currentRow = await db("erp.parties")
      .select("id", "is_active")
      .where({ id: beforeRow.id })
      .first();
    expect(Boolean(currentRow?.is_active)).toBe(Boolean(beforeRow.is_active));

    const pending = await waitForQueuedApproval(
      ctx.operatorUserId,
      "PARTY",
      beforeId,
    );
    ctx.approvalIds.push(pending.id);
    expect(String(pending.entity_id)).toBe(String(beforeRow.id));
    expect(Boolean(pending.new_value?.is_active)).toBe(false);
    expect(pending.new_value?._approval_action).toBe("delete");
  });
});
