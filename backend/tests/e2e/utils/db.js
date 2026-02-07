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

const closeDb = async () => knex.destroy();

module.exports = {
  getLinkedSize,
  getBranch,
  getUserByUsername,
  getTwoDistinctUsers,
  getVariantForSkuApproval,
  createApprovalRequest,
  deleteApprovalRequests,
  setVariantSaleRate,
  upsertUserWithPermissions,
  clearUserPermissionsOverride,
  closeDb,
};
