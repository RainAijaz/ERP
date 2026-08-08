const { test, expect } = require("@playwright/test");
const knexConfig = require("../../knexfile").development;
const knex = require("knex")(knexConfig);
const { login } = require("./utils/auth");
const {
  getBranch,
  upsertUserWithPermissions,
  getUserByUsername,
} = require("./utils/db");

// The "Account / Employee / Labour" picker on Permissions > Account Activity Ledger
// lists all three entity kinds in one <select>. Accounts, employees and labours each
// number their ids from 1, so an employee whose id also belongs to an account used to
// be added as THAT ACCOUNT instead — silently, because the searchable-select layer
// commits a pick with `select.value = id`, which resolves to the first option holding
// that value (always an account, they are rendered first). Labours only appeared to
// work because most of their ids sit past the end of the account id range.
//
// Every case here deliberately uses an entity that DOES collide with an account id,
// so the spec fails on the pre-fix build rather than passing by luck.

const TARGET_USER = process.env.E2E_ENTITY_ACCESS_USER || "e2e_entity_access";
const TARGET_PASS = process.env.E2E_ENTITY_ACCESS_PASS || "Salesman@123";
const TARGET_ROLE = "Salesman";

const fixture = {
  userId: null,
  roleId: null,
  employee: null,
  labour: null,
  tripleId: null,
};

// ---- fixtures / assertions straight against the DB -------------------------
// Deliberately local to this spec rather than added to utils/db.js: that file is a
// shared 2.6k-line helper, and these queries are only meaningful here.

const findEntityCollidingWithAccount = async (entityType) => {
  const table = entityType === "LABOUR" ? "erp.labours" : "erp.employees";
  const row = await knex(`${table} as ent`)
    .join("erp.accounts as a", "a.id", "ent.id")
    .select("ent.id", "ent.code", "ent.name")
    .where("a.is_active", true)
    .whereRaw("lower(trim(coalesce(ent.status, ''))) = 'active'")
    .orderBy("ent.id", "asc")
    .first();
  if (!row) return null;
  return {
    entityType,
    id: Number(row.id),
    code: String(row.code || ""),
    name: String(row.name || ""),
  };
};

// An id owned by an active account AND an active employee AND an active labour —
// the worst case for the picker, and for the route splitting one payload by type.
const findTripleCollisionId = async () => {
  const row = await knex("erp.accounts as a")
    .join("erp.employees as e", "e.id", "a.id")
    .join("erp.labours as l", "l.id", "a.id")
    .select("a.id", "a.name as account_name", "e.name as employee_name", "l.name as labour_name")
    .where("a.is_active", true)
    .whereRaw("lower(trim(coalesce(e.status, ''))) = 'active'")
    .whereRaw("lower(trim(coalesce(l.status, ''))) = 'active'")
    .orderBy("a.id", "asc")
    .first();
  if (!row) return null;
  return {
    id: Number(row.id),
    accountName: String(row.account_name || ""),
    employeeName: String(row.employee_name || ""),
    labourName: String(row.labour_name || ""),
  };
};

const hasTable = async (name) =>
  knex.schema.withSchema("erp").hasTable(name).catch(() => false);

const clearAccess = async ({ userId, roleId }) => {
  if (userId && (await hasTable("user_account_access"))) {
    await knex("erp.user_account_access").where({ user_id: userId }).del();
  }
  if (userId && (await hasTable("user_entity_access"))) {
    await knex("erp.user_entity_access").where({ user_id: userId }).del();
  }
  if (roleId && (await hasTable("role_account_access"))) {
    await knex("erp.role_account_access").where({ role_id: roleId }).del();
  }
  if (roleId && (await hasTable("role_entity_access"))) {
    await knex("erp.role_entity_access").where({ role_id: roleId }).del();
  }
};

const readEntityAccess = async ({ table, ownerCol, ownerId }) => {
  if (!(await hasTable(table))) return [];
  const rows = await knex(`erp.${table}`)
    .select("entity_type", "entity_id", "can_view_summary", "can_view_details")
    .where(ownerCol, ownerId)
    .orderBy(["entity_type", "entity_id"]);
  return rows.map((row) => ({
    entityType: String(row.entity_type || ""),
    entityId: Number(row.entity_id),
    canViewSummary: Boolean(row.can_view_summary),
    canViewDetails: Boolean(row.can_view_details),
  }));
};

const readAccountAccess = async ({ table, ownerCol, ownerId }) => {
  if (!(await hasTable(table))) return [];
  const rows = await knex(`erp.${table}`)
    .select("account_id", "can_view_summary", "can_view_details")
    .where(ownerCol, ownerId)
    .orderBy("account_id");
  return rows.map((row) => ({
    accountId: Number(row.account_id),
    canViewSummary: Boolean(row.can_view_summary),
    canViewDetails: Boolean(row.can_view_details),
  }));
};

// ---- UI helpers ------------------------------------------------------------

const openAccountAccessPanel = async (page, { type, targetId }) => {
  const response = await page.goto(
    `/administration/permissions?type=${type}&target_id=${targetId}`,
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.status()).toBe(200);

  const scopePath = await page.evaluate(() =>
    typeof ACCOUNT_ACCESS_SCOPE_PATH === "string"
      ? ACCOUNT_ACCESS_SCOPE_PATH
      : "",
  );
  expect(scopePath, "Account Activity Ledger scope row missing").not.toBe("");

  await page.locator(`.category-btn[data-cat="${scopePath}"]`).click();
  await expect(page.locator("#account-access-shell")).toBeVisible();
};

// Drive the control the admin actually uses: type into the searchable input, click
// the option in the dropdown, then press "+". Playwright's selectOption() would
// bypass the bug entirely, because it assigns option.selected directly instead of
// going through the `select.value = …` assignment that misresolved.
const pickThroughSearchableMenu = async (page, { entityType, name }) => {
  const label = await page.evaluate(
    ({ type, entityName }) => {
      const select = document.querySelector("[data-account-access-add]");
      const option = Array.from(select?.options || []).find(
        (opt) =>
          String(opt.getAttribute("data-entity-type") || "").toLowerCase() ===
            type && String(opt.getAttribute("data-name") || "") === entityName,
      );
      return option ? option.textContent.trim() : "";
    },
    { type: entityType.toLowerCase(), entityName: name },
  );
  expect(label, `No picker option for ${entityType} ${name}`).not.toBe("");

  const control = page.locator(
    "#account-access-shell [data-searchable-wrapper] input[type='text']",
  );
  await control.click();
  await control.fill(label);
  await page.locator(`[data-searchable-option][title="${label}"]`).click();
  await page.locator("[data-account-access-add-btn]").click();
};

const savePanel = async (page, type) =>
  Promise.all([
    page.waitForURL(
      new RegExp(`/administration/permissions\\?type=${type}&target_id=`, "i"),
    ),
    page.locator("[data-account-access-save]").click(),
  ]);

const rowLocator = (page, entityType, id) =>
  page.locator(
    `[data-account-access-row][data-entity-type="${entityType}"][data-account-id="${id}"]`,
  );

// ---- suite -----------------------------------------------------------------

test.describe.serial("Permissions employee/labour access UI", () => {
  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;

    await upsertUserWithPermissions({
      username: TARGET_USER,
      password: TARGET_PASS,
      roleName: TARGET_ROLE,
      branchId,
      scopeKeys: [],
    });

    const user = await getUserByUsername(TARGET_USER);
    fixture.userId = Number(user?.id || 0) || null;

    const role = await knex("erp.role_templates")
      .select("id")
      .whereRaw("lower(name) = lower(?)", [TARGET_ROLE])
      .first();
    fixture.roleId = Number(role?.id || 0) || null;

    [fixture.employee, fixture.labour, fixture.tripleId] = await Promise.all([
      findEntityCollidingWithAccount("EMPLOYEE"),
      findEntityCollidingWithAccount("LABOUR"),
      findTripleCollisionId(),
    ]);
  });

  test.beforeEach(async () => {
    await clearAccess({ userId: fixture.userId, roleId: fixture.roleId });
  });

  test.afterAll(async () => {
    try {
      await clearAccess({ userId: fixture.userId, roleId: fixture.roleId });
    } finally {
      await knex.destroy();
    }
  });

  for (const kind of ["EMPLOYEE", "LABOUR"]) {
    test(`user mode: blocks a ${kind.toLowerCase()} whose id collides with an account id`, async ({
      page,
    }) => {
      const entity = kind === "EMPLOYEE" ? fixture.employee : fixture.labour;
      test.skip(
        !fixture.userId || !entity,
        `No active ${kind.toLowerCase()} shares an id with an active account.`,
      );

      const type = kind.toLowerCase();
      await login(page, "E2E_ADMIN");
      await openAccountAccessPanel(page, {
        type: "user",
        targetId: fixture.userId,
      });
      await pickThroughSearchableMenu(page, {
        entityType: type,
        name: entity.name,
      });

      // The row must carry the entity's own type, not the account sharing its id.
      await expect(rowLocator(page, type, entity.id)).toHaveCount(1);
      await expect(
        rowLocator(page, type, entity.id).locator("[data-account-name]"),
      ).toContainText(entity.name);
      await expect(
        rowLocator(page, "account", entity.id),
        `Picking the ${type} must not add the account sharing its id`,
      ).toHaveCount(0);

      await savePanel(page, "user");

      expect(
        await readEntityAccess({
          table: "user_entity_access",
          ownerCol: "user_id",
          ownerId: fixture.userId,
        }),
      ).toEqual([
        {
          entityType: kind,
          entityId: entity.id,
          canViewSummary: false,
          canViewDetails: false,
        },
      ]);

      // No stray account restriction was written as a side effect.
      expect(
        await readAccountAccess({
          table: "user_account_access",
          ownerCol: "user_id",
          ownerId: fixture.userId,
        }),
      ).toEqual([]);

      // And it survives a reload rendered from the DB.
      await openAccountAccessPanel(page, {
        type: "user",
        targetId: fixture.userId,
      });
      await expect(rowLocator(page, type, entity.id)).toHaveCount(1);
    });
  }

  test("role mode: blocks an employee whose id collides with an account id", async ({
    page,
  }) => {
    test.skip(
      !fixture.roleId || !fixture.employee,
      "Missing role fixture or colliding employee.",
    );

    await login(page, "E2E_ADMIN");
    await openAccountAccessPanel(page, {
      type: "role",
      targetId: fixture.roleId,
    });
    await pickThroughSearchableMenu(page, {
      entityType: "employee",
      name: fixture.employee.name,
    });
    await expect(rowLocator(page, "employee", fixture.employee.id)).toHaveCount(
      1,
    );

    await savePanel(page, "role");

    expect(
      await readEntityAccess({
        table: "role_entity_access",
        ownerCol: "role_id",
        ownerId: fixture.roleId,
      }),
    ).toEqual([
      {
        entityType: "EMPLOYEE",
        entityId: fixture.employee.id,
        canViewSummary: false,
        canViewDetails: false,
      },
    ]);
  });

  test("one save routes an account, an employee and a labour sharing the same id to three different tables", async ({
    page,
  }) => {
    test.skip(
      !fixture.userId || !fixture.tripleId,
      "No id is shared by an active account, employee and labour.",
    );
    const { id, accountName, employeeName, labourName } = fixture.tripleId;

    await login(page, "E2E_ADMIN");
    await openAccountAccessPanel(page, {
      type: "user",
      targetId: fixture.userId,
    });

    await pickThroughSearchableMenu(page, {
      entityType: "account",
      name: accountName,
    });
    await pickThroughSearchableMenu(page, {
      entityType: "employee",
      name: employeeName,
    });
    await pickThroughSearchableMenu(page, {
      entityType: "labour",
      name: labourName,
    });

    // Three distinct rows, all with the same numeric id.
    await expect(rowLocator(page, "account", id)).toHaveCount(1);
    await expect(rowLocator(page, "employee", id)).toHaveCount(1);
    await expect(rowLocator(page, "labour", id)).toHaveCount(1);

    await savePanel(page, "user");

    expect(
      await readAccountAccess({
        table: "user_account_access",
        ownerCol: "user_id",
        ownerId: fixture.userId,
      }),
    ).toEqual([
      { accountId: id, canViewSummary: false, canViewDetails: false },
    ]);

    expect(
      await readEntityAccess({
        table: "user_entity_access",
        ownerCol: "user_id",
        ownerId: fixture.userId,
      }),
    ).toEqual([
      {
        entityType: "EMPLOYEE",
        entityId: id,
        canViewSummary: false,
        canViewDetails: false,
      },
      {
        entityType: "LABOUR",
        entityId: id,
        canViewSummary: false,
        canViewDetails: false,
      },
    ]);
  });

  test("removing an employee row deletes only that restriction", async ({
    page,
  }) => {
    test.skip(
      !fixture.userId || !fixture.employee || !fixture.labour,
      "Missing colliding employee/labour fixtures.",
    );

    await login(page, "E2E_ADMIN");
    await openAccountAccessPanel(page, {
      type: "user",
      targetId: fixture.userId,
    });
    await pickThroughSearchableMenu(page, {
      entityType: "employee",
      name: fixture.employee.name,
    });
    await pickThroughSearchableMenu(page, {
      entityType: "labour",
      name: fixture.labour.name,
    });
    await savePanel(page, "user");

    await openAccountAccessPanel(page, {
      type: "user",
      targetId: fixture.userId,
    });
    await rowLocator(page, "employee", fixture.employee.id)
      .locator("[data-account-remove]")
      .click();
    await expect(rowLocator(page, "employee", fixture.employee.id)).toHaveCount(
      0,
    );
    await savePanel(page, "user");

    expect(
      await readEntityAccess({
        table: "user_entity_access",
        ownerCol: "user_id",
        ownerId: fixture.userId,
      }),
    ).toEqual([
      {
        entityType: "LABOUR",
        entityId: fixture.labour.id,
        canViewSummary: false,
        canViewDetails: false,
      },
    ]);
  });
});
