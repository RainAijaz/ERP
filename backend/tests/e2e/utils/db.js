const bcrypt = require("bcrypt");
const knexConfig = require("../../../knexfile").development;
const knex = require("knex")(knexConfig);

const logPool = (label, err) => {
  if (process.env.DEBUG_DB_POOL !== "1") return;
  const pool = knex?.client?.pool;
  const stats = pool
    ? {
        used: pool.numUsed?.(),
        free: pool.numFree?.(),
        pending: pool.numPendingAcquires?.(),
        pendingCreates: pool.numPendingCreates?.(),
        size: pool.size,
      }
    : null;
  // eslint-disable-next-line no-console
  console.log("[DB POOL]", label, stats || "no-pool", err ? { error: err.message } : "");
};

if (process.env.DEBUG_DB_POOL === "1") {
  const pool = knex?.client?.pool;
  if (pool?.on) {
    pool.on("acquireRequest", () => logPool("acquireRequest"));
    pool.on("acquireSuccess", () => logPool("acquireSuccess"));
    pool.on("acquireFail", (err) => logPool("acquireFail", err));
    pool.on("release", () => logPool("release"));
    pool.on("createFail", (err) => logPool("createFail", err));
  }
}

const getLinkedSize = async () => {
  const row = await knex("erp.variants as v")
    .join("erp.sizes as s", "s.id", "v.size_id")
    .select("s.id", "s.name")
    .whereNotNull("v.size_id")
    .first();
  return row || null;
};

const getBranch = async () => {
  const row = await knex("erp.branches").select("id").orderBy("id", "asc").first();
  return row || null;
};

const getApprovalEditFixtureData = async () => {
  const [branches, subgroup, city, partyGroup] = await Promise.all([
    knex("erp.branches").select("id").orderBy("id", "asc").limit(2),
    knex("erp.account_groups").select("id").orderBy("id", "asc").first(),
    knex("erp.cities").select("id").orderBy("id", "asc").first(),
    knex("erp.party_groups").select("id").whereIn("party_type", ["CUSTOMER", "BOTH"]).orderBy("id", "asc").first(),
  ]);
  return {
    branchIds: (branches || []).map((row) => row.id).filter(Boolean),
    accountSubgroupId: subgroup?.id || null,
    cityId: city?.id || null,
    partyGroupId: partyGroup?.id || null,
  };
};

const getUserByUsername = async (username) => {
  if (!username) return null;
  const row = await knex("erp.users").select("id", "username").whereRaw("lower(username) = lower(?)", [username]).first();
  return row || null;
};

const getTwoDistinctUsers = async (preferredUsername) => {
  const primary = await getUserByUsername(preferredUsername);
  const secondary = await knex("erp.users")
    .select("id", "username")
    .whereNot("id", primary?.id || 0)
    .orderBy("id", "asc")
    .first();
  if (!primary || !secondary) return null;
  return { primary, secondary };
};

const getVariantForSkuApproval = async () => {
  const row = await knex("erp.variants as v")
    .select(
      "v.id",
      "v.item_id",
      "v.size_id",
      "v.grade_id",
      "v.color_id",
      "v.packing_type_id",
      "v.sale_rate",
      "i.name as item_name",
      "s.name as size_name",
      "g.name as grade_name",
      "c.name as color_name",
      "p.name as packing_name"
    )
    .leftJoin("erp.items as i", "v.item_id", "i.id")
    .leftJoin("erp.sizes as s", "v.size_id", "s.id")
    .leftJoin("erp.grades as g", "v.grade_id", "g.id")
    .leftJoin("erp.colors as c", "v.color_id", "c.id")
    .leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id")
    .orderBy("v.id", "asc")
    .first();
  return row || null;
};

const createApprovalRequest = async (payload) => {
  const [created] = await knex("erp.approval_request").insert(payload).returning(["id"]);
  const id = created?.id || created;
  return id || null;
};

const deleteApprovalRequests = async (ids = []) => {
  if (!ids.length) return;
  await knex("erp.approval_request").whereIn("id", ids).del();
};

const findLatestApprovalRequest = async ({ requestedBy, status, entityType, summary } = {}) => {
  let query = knex("erp.approval_request").select("id", "status", "summary", "requested_by", "entity_type").orderBy("id", "desc");
  if (requestedBy) query = query.where("requested_by", requestedBy);
  if (status) query = query.where("status", status);
  if (entityType) query = query.where("entity_type", entityType);
  if (summary) query = query.where("summary", summary);
  return query.first();
};

const setVariantSaleRate = async (variantId, saleRate) => {
  if (!variantId) return;
  await knex("erp.variants").where({ id: Number(variantId) }).update({ sale_rate: saleRate });
};

const upsertUserWithPermissions = async ({ username, password, roleName, branchId, scopeKeys = [] }) => {
  if (!username || !password) return null;
  const roleRow = roleName
    ? await knex("erp.role_templates").select("id").whereRaw("lower(name) = lower(?)", [roleName]).first()
    : null;
  const fallbackRole = roleRow || (await knex("erp.role_templates").select("id").orderBy("id", "asc").first());
  if (!fallbackRole) return null;

  const passwordHash = await bcrypt.hash(password, 10);

  return knex.transaction(async (trx) => {
    let user = await trx("erp.users").whereRaw("lower(username) = lower(?)", [username]).first();
    if (!user) {
      const [created] = await trx("erp.users")
        .insert({
          name: username,
          username,
          password_hash: passwordHash,
          primary_role_id: fallbackRole.id,
          status: "Active",
        })
        .returning(["id"]);
      user = { id: created?.id || created };
    } else {
      await trx("erp.users").where({ id: user.id }).update({
        password_hash: passwordHash,
        status: "Active",
      });
    }

    if (branchId) {
      const exists = await trx("erp.user_branch").where({ user_id: user.id, branch_id: branchId }).first();
      if (!exists) {
        await trx("erp.user_branch").insert({ user_id: user.id, branch_id: branchId });
      }
    }

    if (scopeKeys.length) {
      const scopeRows = await trx("erp.permission_scope_registry")
        .select("id", "scope_key")
        .where({ scope_type: "SCREEN" })
        .whereIn("scope_key", scopeKeys);
      const scopeIds = scopeRows.map((row) => row.id);
      if (scopeIds.length) {
        await trx("erp.user_permissions_override").where({ user_id: user.id }).whereIn("scope_id", scopeIds).del();
        await trx("erp.user_permissions_override").insert(
          scopeIds.map((scopeId) => ({
            user_id: user.id,
            scope_id: scopeId,
            can_navigate: true,
            can_view: true,
            can_create: true,
            can_edit: true,
            can_delete: true,
            can_print: true,
            can_approve: false,
          })),
        );
      }
    }

    return user?.id || null;
  });
};

const clearUserPermissionsOverride = async ({ userId, scopeKeys = [] }) => {
  if (!userId || !scopeKeys.length) return;
  const scopeRows = await knex("erp.permission_scope_registry")
    .select("id")
    .where({ scope_type: "SCREEN" })
    .whereIn("scope_key", scopeKeys);
  const scopeIds = scopeRows.map((row) => row.id);
  if (!scopeIds.length) return;
  await knex("erp.user_permissions_override").where({ user_id: userId }).whereIn("scope_id", scopeIds).del();
};

const setUserScreenPermission = async ({ userId, scopeKey, permissions = {} }) => {
  if (!userId || !scopeKey) return;
  const scope = await knex("erp.permission_scope_registry")
    .select("id")
    .where({ scope_type: "SCREEN", scope_key: scopeKey })
    .first();
  if (!scope) return;

  await knex("erp.user_permissions_override")
    .insert({
      user_id: userId,
      scope_id: scope.id,
      can_navigate: permissions.can_navigate ?? null,
      can_view: permissions.can_view ?? null,
      can_create: permissions.can_create ?? null,
      can_edit: permissions.can_edit ?? null,
      can_delete: permissions.can_delete ?? null,
      can_hard_delete: permissions.can_hard_delete ?? null,
      can_print: permissions.can_print ?? null,
      can_approve: permissions.can_approve ?? null,
    })
    .onConflict(["user_id", "scope_id"])
    .merge({
      can_navigate: permissions.can_navigate ?? null,
      can_view: permissions.can_view ?? null,
      can_create: permissions.can_create ?? null,
      can_edit: permissions.can_edit ?? null,
      can_delete: permissions.can_delete ?? null,
      can_hard_delete: permissions.can_hard_delete ?? null,
      can_print: permissions.can_print ?? null,
      can_approve: permissions.can_approve ?? null,
    });
};

const insertActivityLogRows = async (rows = []) => {
  if (!rows.length) return [];
  const created = await knex("erp.activity_log")
    .insert(rows)
    .returning(["id"]);
  return created.map((row) => row.id || row).filter(Boolean);
};

const deleteActivityLogs = async (ids = []) => {
  if (!ids.length) return;
  await knex("erp.activity_log").whereIn("id", ids).del();
};

const getActivityLogIdsByApprovalRequestId = async (approvalRequestId) => {
  if (!approvalRequestId) return [];
  const rows = await knex("erp.activity_log")
    .select("id")
    .whereRaw("context_json ->> 'approval_request_id' = ?", [String(approvalRequestId)]);
  return rows.map((row) => row.id).filter(Boolean);
};

const getApprovalPolicy = async ({ entityType, entityKey, action }) => {
  if (!entityType || !entityKey || !action) return null;
  return knex("erp.approval_policy")
    .select("id", "requires_approval")
    .where({
      entity_type: entityType,
      entity_key: entityKey,
      action,
    })
    .first();
};

const upsertApprovalPolicy = async ({ entityType, entityKey, action, requiresApproval }) => {
  if (!entityType || !entityKey || !action) return;
  await knex("erp.approval_policy")
    .insert({
      entity_type: entityType,
      entity_key: entityKey,
      action,
      requires_approval: Boolean(requiresApproval),
    })
    .onConflict(["entity_type", "entity_key", "action"])
    .merge({
      requires_approval: Boolean(requiresApproval),
      updated_at: knex.fn.now(),
    });
};

const deleteApprovalPolicy = async ({ entityType, entityKey, action }) => {
  if (!entityType || !entityKey || !action) return;
  await knex("erp.approval_policy")
    .where({
      entity_type: entityType,
      entity_key: entityKey,
      action,
    })
    .del();
};

const createBomUiFixture = async (token) => {
  const safeToken = String(token || Date.now()).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32);
  return knex.transaction(async (trx) => {
    const createdSupport = {};

    const users = await trx("erp.users").select("id").orderBy("id", "asc").limit(2);
    if (!users.length) return null;
    const creatorId = Number(users[0].id);
    const approverId = Number(users[1]?.id || users[0].id);

    let uom = await trx("erp.uom").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    if (!uom) {
      const [inserted] = await trx("erp.uom")
        .insert({
          code: `E2EUOM${safeToken}`.slice(0, 20),
          name: `E2E UOM ${safeToken}`,
          name_ur: `E2E UOM ${safeToken}`,
          is_active: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      uom = { id: inserted?.id || inserted };
      createdSupport.uomId = Number(uom.id);
    }

    let group = await trx("erp.product_groups").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    if (!group) {
      const [inserted] = await trx("erp.product_groups")
        .insert({
          name: `E2E Group ${safeToken}`,
          name_ur: `E2E Group ${safeToken}`,
          is_active: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      group = { id: inserted?.id || inserted };
      createdSupport.groupId = Number(group.id);
      await trx("erp.product_group_item_types").insert([
        { group_id: group.id, item_type: "RM" },
        { group_id: group.id, item_type: "SFG" },
        { group_id: group.id, item_type: "FG" },
      ]);
    }

    let size = await trx("erp.sizes").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    if (!size) {
      const [inserted] = await trx("erp.sizes")
        .insert({
          name: `E2E Size ${safeToken}`,
          name_ur: `E2E Size ${safeToken}`,
          is_active: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      size = { id: inserted?.id || inserted };
      createdSupport.sizeId = Number(size.id);
    }

    let color = await trx("erp.colors").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    if (!color) {
      const [inserted] = await trx("erp.colors")
        .insert({
          name: `E2E Color ${safeToken}`,
          name_ur: `E2E Color ${safeToken}`,
          is_active: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      color = { id: inserted?.id || inserted };
      createdSupport.colorId = Number(color.id);
    }

    let packing = await trx("erp.packing_types").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    if (!packing) {
      const [inserted] = await trx("erp.packing_types")
        .insert({
          name: `E2E Packing ${safeToken}`,
          name_ur: `E2E Packing ${safeToken}`,
          is_active: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      packing = { id: inserted?.id || inserted };
      createdSupport.packingTypeId = Number(packing.id);
    }

    let dept = await trx("erp.departments").select("id").where({ is_active: true, is_production: true }).orderBy("id", "asc").first();
    if (!dept) {
      const [inserted] = await trx("erp.departments")
        .insert({
          name: `E2E Dept ${safeToken}`,
          name_ur: `E2E Dept ${safeToken}`,
          is_active: true,
          is_production: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      dept = { id: inserted?.id || inserted };
      createdSupport.deptId = Number(dept.id);
    }

    const [labourInserted] = await trx("erp.labours")
      .insert({
        code: `e2e_labour_${safeToken}`.slice(0, 80),
        name: `E2E Labour ${safeToken}`,
        name_ur: `E2E Labour ${safeToken}`,
        dept_id: dept.id,
        status: "active",
      })
      .returning(["id"]);
    const labour = { id: labourInserted?.id || labourInserted };
    createdSupport.labourId = Number(labour.id);
    const labourDeptTable = await trx.raw("SELECT to_regclass('erp.labour_department') AS reg");
    const hasLabourDeptTable = Boolean(labourDeptTable?.rows?.[0]?.reg || labourDeptTable?.[0]?.reg);
    if (hasLabourDeptTable) {
      await trx("erp.labour_department")
        .insert({
          labour_id: labour.id,
          dept_id: dept.id,
        })
        .onConflict(["labour_id", "dept_id"])
        .ignore();
    }

    const [fgInserted] = await trx("erp.items")
      .insert({
        item_type: "FG",
        code: `e2e_fg_${safeToken}`.slice(0, 80),
        name: `E2E FG ${safeToken}`,
        name_ur: `E2E FG ${safeToken}`,
        group_id: group.id,
        base_uom_id: uom.id,
        created_by: creatorId,
      })
      .returning(["id"]);
    const fgItemId = Number(fgInserted?.id || fgInserted);

    const [sfgInserted] = await trx("erp.items")
      .insert({
        item_type: "SFG",
        code: `e2e_sfg_${safeToken}`.slice(0, 80),
        name: `E2E SFG ${safeToken}`,
        name_ur: `E2E SFG ${safeToken}`,
        group_id: group.id,
        base_uom_id: uom.id,
        created_by: creatorId,
      })
      .returning(["id"]);
    const sfgItemId = Number(sfgInserted?.id || sfgInserted);

    const [rmInserted] = await trx("erp.items")
      .insert({
        item_type: "RM",
        code: `e2e_rm_${safeToken}`.slice(0, 80),
        name: `E2E RM ${safeToken}`,
        name_ur: `E2E RM ${safeToken}`,
        group_id: group.id,
        base_uom_id: uom.id,
        created_by: creatorId,
      })
      .returning(["id"]);
    const rmItemId = Number(rmInserted?.id || rmInserted);

    const [variantInserted] = await trx("erp.variants")
      .insert({
        item_id: sfgItemId,
        size_id: size.id,
        color_id: color.id,
        packing_type_id: packing.id,
        sale_rate: 100,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const sfgVariantId = Number(variantInserted?.id || variantInserted);

    const [skuInserted] = await trx("erp.skus")
      .insert({
        variant_id: sfgVariantId,
        sku_code: `E2E-SFG-${safeToken}`.slice(0, 80),
        is_active: true,
      })
      .returning(["id"]);
    const sfgSkuId = Number(skuInserted?.id || skuInserted);

    const [bomInserted] = await trx("erp.bom_header")
      .insert({
        bom_no: `E2E-BOM-SFG-${safeToken}`.slice(0, 120),
        item_id: sfgItemId,
        level: "SEMI_FINISHED",
        output_qty: 1,
        output_uom_id: uom.id,
        status: "APPROVED",
        version_no: 1,
        created_by: creatorId,
        approved_by: approverId,
        approved_at: trx.fn.now(),
      })
      .returning(["id"]);
    const approvedSfgBomId = Number(bomInserted?.id || bomInserted);

    await trx("erp.rm_purchase_rates").insert({
      rm_item_id: rmItemId,
      color_id: color.id,
      purchase_rate: 10,
      avg_purchase_rate: 10,
      is_active: true,
      created_by: creatorId,
    });

    return {
      token: safeToken,
      createdSupport,
      creatorId,
      approverId,
      uomId: Number(uom.id),
      groupId: Number(group.id),
      sizeId: Number(size.id),
      colorId: Number(color.id),
      packingTypeId: Number(packing.id),
      deptId: Number(dept.id),
      labourId: Number(labour.id),
      fgItemId,
      sfgItemId,
      rmItemId,
      sfgVariantId,
      sfgSkuId,
      approvedSfgBomId,
    };
  });
};

const createBomNegativeFixture = async (token) => {
  const safeToken = String(token || Date.now()).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32);
  const base = await createBomUiFixture(`neg${safeToken}`);
  if (!base) return null;

  return knex.transaction(async (trx) => {
    const [rmNoRateInserted] = await trx("erp.items")
      .insert({
        item_type: "RM",
        code: `e2e_rm_norate_${safeToken}`.slice(0, 80),
        name: `E2E RM NoRate ${safeToken}`,
        name_ur: `E2E RM NoRate ${safeToken}`,
        group_id: base.groupId,
        base_uom_id: base.uomId,
        created_by: base.creatorId,
      })
      .returning(["id"]);
    const rmNoRateItemId = Number(rmNoRateInserted?.id || rmNoRateInserted);

    const [sfgNoBomInserted] = await trx("erp.items")
      .insert({
        item_type: "SFG",
        code: `e2e_sfg_nobom_${safeToken}`.slice(0, 80),
        name: `E2E SFG NoBom ${safeToken}`,
        name_ur: `E2E SFG NoBom ${safeToken}`,
        group_id: base.groupId,
        base_uom_id: base.uomId,
        created_by: base.creatorId,
      })
      .returning(["id"]);
    const sfgNoApprovedItemId = Number(sfgNoBomInserted?.id || sfgNoBomInserted);

    const [variantInserted] = await trx("erp.variants")
      .insert({
        item_id: sfgNoApprovedItemId,
        size_id: base.sizeId,
        color_id: base.colorId,
        packing_type_id: base.packingTypeId,
        sale_rate: 100,
        is_active: true,
        created_by: base.creatorId,
      })
      .returning(["id"]);
    const sfgNoApprovedVariantId = Number(variantInserted?.id || variantInserted);

    const [skuInserted] = await trx("erp.skus")
      .insert({
        variant_id: sfgNoApprovedVariantId,
        sku_code: `E2E-SFG-NOBOM-${safeToken}`.slice(0, 80),
        is_active: true,
      })
      .returning(["id"]);
    const sfgNoApprovedSkuId = Number(skuInserted?.id || skuInserted);

    return {
      ...base,
      rmNoRateItemId,
      sfgNoApprovedItemId,
      sfgNoApprovedVariantId,
      sfgNoApprovedSkuId,
    };
  });
};

const getBomSnapshot = async (bomId) => {
  const id = Number(bomId);
  if (!id) return null;
  const header = await knex("erp.bom_header")
    .select("id", "bom_no", "item_id", "level", "status", "version_no", "output_qty", "output_uom_id", "approved_by")
    .where({ id })
    .first();
  if (!header) return null;

  const [rmCount, sfgCount, labourCount, ruleCount] = await Promise.all([
    knex("erp.bom_rm_line").where({ bom_id: id }).count({ count: "*" }).first(),
    knex("erp.bom_sfg_line").where({ bom_id: id }).count({ count: "*" }).first(),
    knex("erp.bom_labour_line").where({ bom_id: id }).count({ count: "*" }).first(),
    knex("erp.bom_variant_rule").where({ bom_id: id }).count({ count: "*" }).first(),
  ]);

  return {
    header,
    counts: {
      rm: Number(rmCount?.count || 0),
      sfg: Number(sfgCount?.count || 0),
      labour: Number(labourCount?.count || 0),
      rule: Number(ruleCount?.count || 0),
    },
  };
};

const cleanupBomUiFixture = async ({ fixture, bomIds = [] } = {}) => {
  if (!fixture) return;
  const fixtureItemIds = [fixture.fgItemId, fixture.sfgItemId, fixture.rmItemId, fixture.sfgNoApprovedItemId, fixture.rmNoRateItemId]
    .map((id) => Number(id))
    .filter(Boolean);

  await knex.transaction(async (trx) => {
    const itemLinkedBomRows = fixtureItemIds.length ? await trx("erp.bom_header").select("id").whereIn("item_id", fixtureItemIds) : [];
    const bomIdList = [...new Set([...bomIds, fixture.approvedSfgBomId, ...itemLinkedBomRows.map((row) => Number(row.id))].map((id) => Number(id)).filter(Boolean))];

    if (bomIdList.length) {
      await trx("erp.approval_request")
        .where({ entity_type: "BOM" })
        .whereIn("entity_id", bomIdList.map((id) => String(id)))
        .del();
      await trx("erp.bom_change_log").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_variant_rule").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_labour_line").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_sfg_line").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_rm_line").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_header").whereIn("id", bomIdList).del();
    }

    if (fixture.sfgSkuId) {
      await trx("erp.skus").where({ id: fixture.sfgSkuId }).del();
    }
    if (fixture.sfgNoApprovedSkuId) {
      await trx("erp.skus").where({ id: fixture.sfgNoApprovedSkuId }).del();
    }
    if (fixture.sfgVariantId) {
      await trx("erp.variants").where({ id: fixture.sfgVariantId }).del();
    }
    if (fixture.sfgNoApprovedVariantId) {
      await trx("erp.variants").where({ id: fixture.sfgNoApprovedVariantId }).del();
    }
    if (fixture.rmItemId) {
      await trx("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmItemId }).del();
    }
    if (fixture.rmNoRateItemId) {
      await trx("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmNoRateItemId }).del();
    }

    if (fixtureItemIds.length) {
      await trx("erp.items").whereIn("id", fixtureItemIds).del();
    }

    if (fixture.createdSupport?.labourId) {
      await trx("erp.labours").where({ id: Number(fixture.createdSupport.labourId) }).del();
    }
    if (fixture.createdSupport?.deptId) {
      await trx("erp.departments").where({ id: Number(fixture.createdSupport.deptId) }).del();
    }
    if (fixture.createdSupport?.packingTypeId) {
      await trx("erp.packing_types").where({ id: Number(fixture.createdSupport.packingTypeId) }).del();
    }
    if (fixture.createdSupport?.colorId) {
      await trx("erp.colors").where({ id: Number(fixture.createdSupport.colorId) }).del();
    }
    if (fixture.createdSupport?.sizeId) {
      await trx("erp.sizes").where({ id: Number(fixture.createdSupport.sizeId) }).del();
    }
    if (fixture.createdSupport?.groupId) {
      await trx("erp.product_group_item_types").where({ group_id: Number(fixture.createdSupport.groupId) }).del();
      await trx("erp.product_groups").where({ id: Number(fixture.createdSupport.groupId) }).del();
    }
    if (fixture.createdSupport?.uomId) {
      await trx("erp.uom").where({ id: Number(fixture.createdSupport.uomId) }).del();
    }
  });
};

const closeDb = async () => knex.destroy();

module.exports = {
  getLinkedSize,
  getBranch,
  getApprovalEditFixtureData,
  getUserByUsername,
  getTwoDistinctUsers,
  getVariantForSkuApproval,
  createApprovalRequest,
  deleteApprovalRequests,
  findLatestApprovalRequest,
  setVariantSaleRate,
  upsertUserWithPermissions,
  clearUserPermissionsOverride,
  setUserScreenPermission,
  insertActivityLogRows,
  deleteActivityLogs,
  getActivityLogIdsByApprovalRequestId,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  createBomUiFixture,
  createBomNegativeFixture,
  getBomSnapshot,
  cleanupBomUiFixture,
  closeDb,
};
