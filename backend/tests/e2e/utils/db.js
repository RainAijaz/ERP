const bcrypt = require("bcrypt");
const knexConfig = require("../../../knexfile").development;
const knex = require("knex")(knexConfig);
const {
  getActiveAdminEmails,
} = require("../../../src/utils/approval-notifications");
const bomService = require("../../../src/services/bom/service");

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
  console.log(
    "[DB POOL]",
    label,
    stats || "no-pool",
    err ? { error: err.message } : "",
  );
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
  const row = await knex("erp.branches")
    .select("id")
    .orderBy("id", "asc")
    .first();
  return row || null;
};

const getBranchScopedAccounts = async ({
  branchId,
  limit = 10,
  excludeIds = [],
} = {}) => {
  const normalizedBranchId = Number(branchId || 0) || null;
  if (!normalizedBranchId) return [];
  const excluded = Array.from(
    new Set(
      (excludeIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  );
  let query = knex("erp.accounts as a")
    .join("erp.account_branch as ab", "ab.account_id", "a.id")
    .distinct("a.id", "a.code", "a.name")
    .where({ "a.is_active": true, "ab.branch_id": normalizedBranchId })
    .orderBy("a.name", "asc")
    .limit(Math.max(1, Number(limit || 10)));
  if (excluded.length) {
    query = query.whereNotIn("a.id", excluded);
  }
  return query;
};

const replaceUserAccountAccess = async ({
  userId,
  rows = [],
  createdBy = null,
} = {}) => {
  const normalizedUserId = Number(userId || 0);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return;
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("user_account_access");
  if (!hasTable) return;

  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      accountId: Number(row?.accountId || 0),
      canViewSummary: Boolean(row?.canViewSummary),
      canViewDetails: Boolean(row?.canViewDetails),
    }))
    .filter((row) => Number.isInteger(row.accountId) && row.accountId > 0)
    .map((row) => ({
      accountId: row.accountId,
      canViewDetails: row.canViewDetails,
      canViewSummary: row.canViewDetails || row.canViewSummary,
    }));

  await knex.transaction(async (trx) => {
    await trx("erp.user_account_access")
      .where({ user_id: normalizedUserId })
      .del();
    if (!normalizedRows.length) return;
    await trx("erp.user_account_access").insert(
      normalizedRows.map((row) => ({
        user_id: normalizedUserId,
        account_id: row.accountId,
        can_view_summary: row.canViewSummary,
        can_view_details: row.canViewSummary ? row.canViewDetails : false,
        created_by: Number(createdBy || 0) || null,
      })),
    );
  });
};

const clearUserAccountAccess = async ({ userId } = {}) => {
  const normalizedUserId = Number(userId || 0);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return;
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("user_account_access");
  if (!hasTable) return;
  await knex("erp.user_account_access")
    .where({ user_id: normalizedUserId })
    .del();
};

const getApprovalEditFixtureData = async () => {
  const [branches, subgroup, city, partyGroup] = await Promise.all([
    knex("erp.branches").select("id").orderBy("id", "asc").limit(2),
    knex("erp.account_groups").select("id").orderBy("id", "asc").first(),
    knex("erp.cities").select("id").orderBy("id", "asc").first(),
    knex("erp.party_groups")
      .select("id")
      .whereIn("party_type", ["CUSTOMER", "BOTH"])
      .orderBy("id", "asc")
      .first(),
  ]);
  return {
    branchIds: (branches || []).map((row) => row.id).filter(Boolean),
    accountSubgroupId: subgroup?.id || null,
    cityId: city?.id || null,
    partyGroupId: partyGroup?.id || null,
  };
};

const getFirstParty = async () => {
  const row = await knex("erp.parties")
    .select(
      "id",
      "code",
      "name",
      "name_ur",
      "party_type",
      "phone1",
      "phone2",
      "credit_allowed",
      "credit_limit",
    )
    .orderBy("id", "asc")
    .first();
  return row || null;
};

const getUserByUsername = async (username) => {
  if (!username) return null;
  const row = await knex("erp.users")
    .select("id", "username", "primary_role_id")
    .whereRaw("lower(username) = lower(?)", [username])
    .first();
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
      "p.name as packing_name",
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
  const [created] = await knex("erp.approval_request")
    .insert(payload)
    .returning(["id"]);
  const id = created?.id || created;
  return id || null;
};

const deleteApprovalRequests = async (ids = []) => {
  if (!ids.length) return;
  await knex("erp.approval_request").whereIn("id", ids).del();
};

const findLatestApprovalRequest = async ({
  requestedBy,
  status,
  entityType,
  summary,
} = {}) => {
  let query = knex("erp.approval_request")
    .select("id", "status", "summary", "requested_by", "entity_type")
    .orderBy("id", "desc");
  if (requestedBy) query = query.where("requested_by", requestedBy);
  if (status) query = query.where("status", status);
  if (entityType) query = query.where("entity_type", entityType);
  if (summary) query = query.where("summary", summary);
  return query.first();
};

const getLatestVoucherHeader = async ({
  voucherTypeCode,
  createdBy,
  branchId,
} = {}) => {
  let query = knex("erp.voucher_header")
    .select(
      "id",
      "voucher_no",
      "voucher_type_code",
      "status",
      "created_by",
      "branch_id",
      "created_at",
    )
    .orderBy("id", "desc");
  if (voucherTypeCode)
    query = query.where("voucher_type_code", voucherTypeCode);
  if (createdBy) query = query.where("created_by", createdBy);
  if (branchId) query = query.where("branch_id", branchId);
  return query.first();
};

const getLatestOpenReturnableOutwardReference = async ({ branchId } = {}) => {
  let query = knex("erp.rgp_outward as ro")
    .join("erp.voucher_header as vh", "vh.id", "ro.voucher_id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "vl.id")
    .leftJoin(
      knex("erp.rgp_inward_line as ril")
        .join("erp.rgp_inward as ri", "ri.voucher_id", "ril.rgp_in_voucher_id")
        .join("erp.voucher_header as rvh", "rvh.id", "ri.voucher_id")
        .select("ril.rgp_out_voucher_line_id")
        .sum({ returned_qty: "ril.returned_qty" })
        .whereNot("rvh.status", "REJECTED")
        .groupBy("ril.rgp_out_voucher_line_id")
        .as("ret"),
      "ret.rgp_out_voucher_line_id",
      "vl.id",
    )
    .select(
      "ro.vendor_party_id",
      "vh.voucher_no",
      "vh.voucher_date",
      knex.raw(
        "GREATEST(rol.qty - COALESCE(ret.returned_qty, 0), 0) as pending_qty",
      ),
    )
    .where("vh.voucher_type_code", "RDV")
    .whereNot("vh.status", "REJECTED")
    .whereNot("ro.status", "CLOSED")
    .whereRaw("GREATEST(rol.qty - COALESCE(ret.returned_qty, 0), 0) > 0")
    .orderBy("vh.voucher_no", "desc");

  if (branchId) query = query.where("vh.branch_id", branchId);

  return query.first();
};

const getTwoOpenReturnableOutwardReferencesForSameVendor = async ({
  branchId,
} = {}) => {
  let query = knex("erp.rgp_outward as ro")
    .join("erp.voucher_header as vh", "vh.id", "ro.voucher_id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "vl.id")
    .leftJoin(
      knex("erp.rgp_inward_line as ril")
        .join("erp.rgp_inward as ri", "ri.voucher_id", "ril.rgp_in_voucher_id")
        .join("erp.voucher_header as rvh", "rvh.id", "ri.voucher_id")
        .select("ril.rgp_out_voucher_line_id")
        .sum({ returned_qty: "ril.returned_qty" })
        .whereNot("rvh.status", "REJECTED")
        .groupBy("ril.rgp_out_voucher_line_id")
        .as("ret"),
      "ret.rgp_out_voucher_line_id",
      "vl.id",
    )
    .select("ro.vendor_party_id", "vh.voucher_no")
    .where("vh.voucher_type_code", "RDV")
    .whereNot("vh.status", "REJECTED")
    .whereNot("ro.status", "CLOSED")
    .whereRaw("GREATEST(rol.qty - COALESCE(ret.returned_qty, 0), 0) > 0")
    .groupBy("ro.vendor_party_id", "vh.voucher_no")
    .orderBy("ro.vendor_party_id", "asc")
    .orderBy("vh.voucher_no", "desc");

  if (branchId) query = query.where("vh.branch_id", branchId);

  const rows = await query;
  const grouped = new Map();
  rows.forEach((row) => {
    const vendorId = Number(row.vendor_party_id || 0);
    if (!vendorId) return;
    const list = grouped.get(vendorId) || [];
    list.push({
      vendor_party_id: vendorId,
      voucher_no: Number(row.voucher_no || 0),
    });
    grouped.set(vendorId, list);
  });

  for (const list of grouped.values()) {
    const distinct = list.filter((row) => Number(row.voucher_no || 0) > 0);
    if (distinct.length >= 2) return distinct.slice(0, 2);
  }

  return [];
};

const getVoucherLineCount = async (voucherId) => {
  const id = Number(voucherId || 0);
  if (!id) return 0;
  const row = await knex("erp.voucher_line")
    .where({ voucher_header_id: id })
    .count({ count: "*" })
    .first();
  return Number(row?.count || 0);
};

const getPurchaseAllocationCountByVoucher = async (voucherId) => {
  const id = Number(voucherId || 0);
  if (!id) return 0;
  const row = await knex("erp.purchase_grn_invoice_alloc as a")
    .join("erp.voucher_line as vl", "vl.id", "a.purchase_voucher_line_id")
    .where("vl.voucher_header_id", id)
    .count({ count: "*" })
    .first();
  return Number(row?.count || 0);
};

const setVariantSaleRate = async (variantId, saleRate) => {
  if (!variantId) return;
  await knex("erp.variants")
    .where({ id: Number(variantId) })
    .update({ sale_rate: saleRate });
};

// Find variants carrying a distinctive marker sale_rate. Used by the new-article
// WhatsApp approval spec to locate the variant an approved SKU-create produced so
// it can be cleaned up (there is no unique attribute tuple to match on).
const findVariantsBySaleRate = async (saleRate) => {
  const rows = await knex("erp.variants")
    .select("id")
    .where({ sale_rate: saleRate })
    .orderBy("id", "asc");
  return rows.map((row) => row.id);
};

// Insert a throwaway color and return its id. The new-article WhatsApp spec uses
// this to guarantee a variant attribute tuple that ux_variants_identity has never
// seen, so an approved SKU-create actually applies instead of colliding.
const createThrowawayColor = async (name) => {
  const [row] = await knex("erp.colors")
    .insert({ name, name_ur: name, is_active: true })
    .returning("id");
  return row.id || row;
};

const deleteColorById = async (colorId) => {
  const id = Number(colorId);
  if (!Number.isInteger(id) || id <= 0) return;
  await knex("erp.colors").where({ id }).del();
};

// Delete a variant and its dependent sku row (skus.variant_id is ON DELETE
// RESTRICT, so the sku must go first). Safe no-op for a missing id.
const deleteVariantCascadeById = async (variantId) => {
  const id = Number(variantId);
  if (!Number.isInteger(id) || id <= 0) return;
  await knex("erp.skus").where({ variant_id: id }).del();
  await knex("erp.variants").where({ id }).del();
};

const setVariantRateEditable = async (variantId, rateEditable) => {
  if (!variantId) return;
  await knex("erp.variants")
    .where({ id: Number(variantId) })
    .update({ rate_editable: Boolean(rateEditable) });
};

const getFirstFgVariantWithRate = async () => {
  const row = await knex("erp.variants as v")
    .join("erp.skus as s", "s.variant_id", "v.id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select(
      "v.id as variant_id",
      "v.sale_rate",
      "v.rate_editable",
      "s.id as sku_id",
      "s.sku_code",
      "i.name as item_name",
    )
    .where({
      "i.item_type": "FG",
      "i.is_active": true,
      "v.is_active": true,
      "s.is_active": true,
    })
    .where("v.sale_rate", ">", 0)
    .orderBy("v.id", "asc")
    .first();
  return row || null;
};

const upsertUserWithPermissions = async ({
  username,
  password,
  roleName,
  branchId,
  scopeKeys = [],
}) => {
  if (!username || !password) return null;
  const roleRow = roleName
    ? await knex("erp.role_templates")
        .select("id")
        .whereRaw("lower(name) = lower(?)", [roleName])
        .first()
    : null;
  const fallbackRole =
    roleRow ||
    (await knex("erp.role_templates")
      .select("id")
      .orderBy("id", "asc")
      .first());
  if (!fallbackRole) return null;

  const passwordHash = await bcrypt.hash(password, 10);

  return knex.transaction(async (trx) => {
    let user = await trx("erp.users")
      .whereRaw("lower(username) = lower(?)", [username])
      .first();
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
      const exists = await trx("erp.user_branch")
        .where({ user_id: user.id, branch_id: branchId })
        .first();
      if (!exists) {
        await trx("erp.user_branch").insert({
          user_id: user.id,
          branch_id: branchId,
        });
      }
    }

    if (scopeKeys.length) {
      const scopeRows = await trx("erp.permission_scope_registry")
        .select("id", "scope_key")
        .where({ scope_type: "SCREEN" })
        .whereIn("scope_key", scopeKeys);
      const scopeIds = scopeRows.map((row) => row.id);
      if (scopeIds.length) {
        await trx("erp.user_permissions_override")
          .where({ user_id: user.id })
          .whereIn("scope_id", scopeIds)
          .del();
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

const updateUserProfile = async ({
  userId,
  name,
  nameUr,
  email,
  status,
} = {}) => {
  const normalizedUserId = Number(userId || 0);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return;

  const payload = {};
  if (typeof name !== "undefined") payload.name = name;
  if (typeof nameUr !== "undefined") payload.name_ur = nameUr;
  if (typeof email !== "undefined") payload.email = email;
  if (typeof status !== "undefined") payload.status = status;
  if (!Object.keys(payload).length) return;

  await knex("erp.users").where({ id: normalizedUserId }).update(payload);
};

const getApprovalNotificationRecipientEmails = async () =>
  getActiveAdminEmails(knex);

const clearUserPermissionsOverride = async ({ userId, scopeKeys = [] }) => {
  if (!userId || !scopeKeys.length) return;
  const scopeRows = await knex("erp.permission_scope_registry")
    .select("id")
    .where({ scope_type: "SCREEN" })
    .whereIn("scope_key", scopeKeys);
  const scopeIds = scopeRows.map((row) => row.id);
  if (!scopeIds.length) return;
  await knex("erp.user_permissions_override")
    .where({ user_id: userId })
    .whereIn("scope_id", scopeIds)
    .del();
};

const setUserScreenPermission = async ({
  userId,
  scopeKey,
  permissions = {},
}) => {
  return setUserScopePermission({
    userId,
    scopeType: "SCREEN",
    scopeKey,
    permissions,
  });
};

const setUserScopePermission = async ({
  userId,
  scopeType,
  scopeKey,
  permissions = {},
}) => {
  if (!userId || !scopeKey) return;
  const scope = await knex("erp.permission_scope_registry")
    .select("id")
    .where({ scope_type: scopeType || "SCREEN", scope_key: scopeKey })
    .first();
  if (!scope) return;

  await knex("erp.user_permissions_override")
    .insert({
      user_id: userId,
      scope_id: scope.id,
      can_navigate: permissions.can_navigate ?? null,
      can_view: permissions.can_view ?? null,
      can_load: permissions.can_load ?? null,
      can_view_details: permissions.can_view_details ?? null,
      can_create: permissions.can_create ?? null,
      can_edit: permissions.can_edit ?? null,
      can_delete: permissions.can_delete ?? null,
      can_hard_delete: permissions.can_hard_delete ?? null,
      can_print: permissions.can_print ?? null,
      can_export_excel_csv: permissions.can_export_excel_csv ?? null,
      can_filter_all_branches: permissions.can_filter_all_branches ?? null,
      can_view_cost_fields: permissions.can_view_cost_fields ?? null,
      can_approve: permissions.can_approve ?? null,
    })
    .onConflict(["user_id", "scope_id"])
    .merge({
      can_navigate: permissions.can_navigate ?? null,
      can_view: permissions.can_view ?? null,
      can_load: permissions.can_load ?? null,
      can_view_details: permissions.can_view_details ?? null,
      can_create: permissions.can_create ?? null,
      can_edit: permissions.can_edit ?? null,
      can_delete: permissions.can_delete ?? null,
      can_hard_delete: permissions.can_hard_delete ?? null,
      can_print: permissions.can_print ?? null,
      can_export_excel_csv: permissions.can_export_excel_csv ?? null,
      can_filter_all_branches: permissions.can_filter_all_branches ?? null,
      can_view_cost_fields: permissions.can_view_cost_fields ?? null,
      can_approve: permissions.can_approve ?? null,
    });
};

const clearUserScopePermission = async ({ userId, scopeType, scopeKey }) => {
  if (!userId || !scopeKey) return;
  const scope = await knex("erp.permission_scope_registry")
    .select("id")
    .where({ scope_type: scopeType || "SCREEN", scope_key: scopeKey })
    .first();
  if (!scope) return;
  await knex("erp.user_permissions_override")
    .where({ user_id: userId, scope_id: scope.id })
    .del();
};

const getPermissionScope = async ({ scopeType, scopeKey }) => {
  if (!scopeType || !scopeKey) return null;
  return knex("erp.permission_scope_registry")
    .select("id", "scope_type", "scope_key")
    .where({
      scope_type: String(scopeType).trim().toUpperCase(),
      scope_key: String(scopeKey).trim(),
    })
    .first();
};

const getFirstNonAdminRole = async () =>
  knex("erp.role_templates")
    .select("id", "name")
    .whereRaw("lower(name) <> 'admin'")
    .orderBy("id", "asc")
    .first();

const insertActivityLogRows = async (rows = []) => {
  if (!rows.length) return [];
  const created = await knex("erp.activity_log").insert(rows).returning(["id"]);
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
    .whereRaw("context_json ->> 'approval_request_id' = ?", [
      String(approvalRequestId),
    ]);
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

const upsertApprovalPolicy = async ({
  entityType,
  entityKey,
  action,
  requiresApproval,
}) => {
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

const hasInventoryNegativeStockOverrideTable = async () =>
  knex.schema
    .withSchema("erp")
    .hasTable("inventory_negative_stock_override");

const normalizeVoucherTypeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeSubjectType = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const listInventoryNegativeStockOverrides = async ({ voucherTypeCode } = {}) => {
  const hasTable = await hasInventoryNegativeStockOverrideTable();
  if (!hasTable) return [];
  let query = knex("erp.inventory_negative_stock_override")
    .select(
      "id",
      "voucher_type_code",
      "subject_type",
      "subject_id",
      "is_enabled",
    )
    .orderBy("id", "asc");
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);
  if (normalizedVoucherTypeCode) {
    query = query.where({ voucher_type_code: normalizedVoucherTypeCode });
  }
  return query;
};

const clearInventoryNegativeStockOverrides = async ({ voucherTypeCode } = {}) => {
  const hasTable = await hasInventoryNegativeStockOverrideTable();
  if (!hasTable) return;
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);
  if (!normalizedVoucherTypeCode) {
    await knex("erp.inventory_negative_stock_override").del();
    return;
  }
  await knex("erp.inventory_negative_stock_override")
    .where({ voucher_type_code: normalizedVoucherTypeCode })
    .del();
};

const upsertInventoryNegativeStockOverride = async ({
  voucherTypeCode,
  subjectType,
  subjectId,
  isEnabled = true,
  updatedBy = null,
}) => {
  const hasTable = await hasInventoryNegativeStockOverrideTable();
  if (!hasTable) return;
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);
  const normalizedSubjectType = normalizeSubjectType(subjectType);
  const normalizedSubjectId = Number(subjectId || 0);
  if (!normalizedVoucherTypeCode) return;
  if (!["ROLE", "USER"].includes(normalizedSubjectType)) return;
  if (!Number.isInteger(normalizedSubjectId) || normalizedSubjectId <= 0) return;

  await knex("erp.inventory_negative_stock_override")
    .insert({
      voucher_type_code: normalizedVoucherTypeCode,
      subject_type: normalizedSubjectType,
      subject_id: normalizedSubjectId,
      is_enabled: Boolean(isEnabled),
      created_by: Number(updatedBy || 0) || null,
      updated_by: Number(updatedBy || 0) || null,
    })
    .onConflict(["voucher_type_code", "subject_type", "subject_id"])
    .merge({
      is_enabled: Boolean(isEnabled),
      updated_by: Number(updatedBy || 0) || null,
      updated_at: knex.fn.now(),
    });
};

const replaceInventoryNegativeStockOverrides = async ({
  voucherTypeCode,
  rows = [],
  updatedBy = null,
}) => {
  const hasTable = await hasInventoryNegativeStockOverrideTable();
  if (!hasTable) return;

  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);
  if (!normalizedVoucherTypeCode) return;

  await knex.transaction(async (trx) => {
    await trx("erp.inventory_negative_stock_override")
      .where({ voucher_type_code: normalizedVoucherTypeCode })
      .del();

    const insertRows = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const subjectType = normalizeSubjectType(row?.subject_type);
        const subjectId = Number(row?.subject_id || 0);
        if (!["ROLE", "USER"].includes(subjectType)) return null;
        if (!Number.isInteger(subjectId) || subjectId <= 0) return null;
        return {
          voucher_type_code: normalizedVoucherTypeCode,
          subject_type: subjectType,
          subject_id: subjectId,
          is_enabled: row?.is_enabled !== false,
          created_by: Number(updatedBy || 0) || null,
          updated_by: Number(updatedBy || 0) || null,
        };
      })
      .filter(Boolean);

    if (insertRows.length) {
      await trx("erp.inventory_negative_stock_override").insert(insertRows);
    }
  });
};

const createBomUiFixture = async (token) => {
  const safeToken = String(token || Date.now())
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 32);
  return knex.transaction(async (trx) => {
    const createdSupport = {};

    const users = await trx("erp.users")
      .select("id")
      .orderBy("id", "asc")
      .limit(2);
    if (!users.length) return null;
    const creatorId = Number(users[0].id);
    const approverId = Number(users[1]?.id || users[0].id);

    let uom = await trx("erp.uom")
      .select("id")
      .where({ is_active: true })
      .orderBy("id", "asc")
      .first();
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

    const pairUom = await trx("erp.uom")
      .select("id")
      .whereRaw(
        "is_active = true AND (UPPER(code) = 'PAIR' OR UPPER(name) = 'PAIR')",
      )
      .orderBy("id", "asc")
      .first();
    const productionUomId = Number(pairUom?.id || uom.id);

    let group = await trx("erp.product_groups")
      .select("id")
      .where({ is_active: true })
      .orderBy("id", "asc")
      .first();
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

    let size = await trx("erp.sizes")
      .select("id")
      .where({ is_active: true })
      .orderBy("id", "asc")
      .first();
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

    let color = await trx("erp.colors")
      .select("id")
      .where({ is_active: true })
      .orderBy("id", "asc")
      .first();
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

    let packing = await trx("erp.packing_types")
      .select("id")
      .where({ is_active: true })
      .orderBy("id", "asc")
      .first();
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

    let dept = await trx("erp.departments")
      .select("id")
      .where({ is_active: true, is_production: true })
      .orderBy("id", "asc")
      .first();
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
    const productionStagesReg = await trx.raw(
      "SELECT to_regclass('erp.production_stages') AS reg",
    );
    const hasProductionStagesTable = Boolean(
      productionStagesReg?.rows?.[0]?.reg || productionStagesReg?.[0]?.reg,
    );
    if (hasProductionStagesTable) {
      const existingActiveStage = await trx("erp.production_stages")
        .select("id")
        .where({ dept_id: dept.id, is_active: true })
        .orderBy("id", "asc")
        .first();
      if (!existingActiveStage) {
        const stageCode = `E2E-STAGE-${safeToken}`.slice(0, 80);
        const stageName = `E2E Stage ${safeToken}`.slice(0, 120);
        const insertStageResult = await trx.raw(
          `
            INSERT INTO erp.production_stages (code, name, name_ur, dept_id, is_active, created_by)
            VALUES (?, ?, ?, ?, true, ?)
            ON CONFLICT (dept_id) WHERE is_active DO NOTHING
            RETURNING id
          `,
          [stageCode, stageName, stageName, dept.id, creatorId],
        );
        const insertedStageId = Number(
          insertStageResult?.rows?.[0]?.id || insertStageResult?.[0]?.id || 0,
        );
        if (insertedStageId) {
          createdSupport.productionStageId = insertedStageId;
        }
      }
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
    const labourDeptTable = await trx.raw(
      "SELECT to_regclass('erp.labour_department') AS reg",
    );
    const hasLabourDeptTable = Boolean(
      labourDeptTable?.rows?.[0]?.reg || labourDeptTable?.[0]?.reg,
    );
    if (hasLabourDeptTable) {
      await trx("erp.labour_department")
        .insert({
          labour_id: labour.id,
          dept_id: dept.id,
        })
        .onConflict(["labour_id", "dept_id"])
        .ignore();
    }
    const labourBranchTable = await trx.raw(
      "SELECT to_regclass('erp.labour_branch') AS reg",
    );
    const hasLabourBranchTable = Boolean(
      labourBranchTable?.rows?.[0]?.reg || labourBranchTable?.[0]?.reg,
    );
    if (hasLabourBranchTable) {
      // Link labour to at least one branch so DCV labour dropdown is populated under branch scoping.
      const fallbackBranch = await trx("erp.branches")
        .select("id")
        .orderBy("id", "asc")
        .first();
      const branchId = Number(fallbackBranch?.id || 0) || null;
      if (branchId) {
        await trx("erp.labour_branch")
          .insert({
            labour_id: labour.id,
            branch_id: branchId,
          })
          .onConflict(["labour_id", "branch_id"])
          .ignore();
      }
    }

    const [fgInserted] = await trx("erp.items")
      .insert({
        item_type: "FG",
        code: `e2e_fg_${safeToken}`.slice(0, 80),
        name: `E2E FG ${safeToken}`,
        name_ur: `E2E FG ${safeToken}`,
        group_id: group.id,
        base_uom_id: productionUomId,
        uses_sfg: true,
        sfg_part_type: "STEP",
        created_by: creatorId,
      })
      .returning(["id"]);
    const fgItemId = Number(fgInserted?.id || fgInserted);

    const [fgVariantInserted] = await trx("erp.variants")
      .insert({
        item_id: fgItemId,
        size_id: size.id,
        color_id: color.id,
        packing_type_id: packing.id,
        sale_rate: 100,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const fgVariantId = Number(fgVariantInserted?.id || fgVariantInserted);

    const [fgSkuInserted] = await trx("erp.skus")
      .insert({
        variant_id: fgVariantId,
        sku_code: `E2E-FG-${safeToken}`.slice(0, 80),
        is_active: true,
      })
      .returning(["id"]);
    const fgSkuId = Number(fgSkuInserted?.id || fgSkuInserted);

    const labourRateRuleTable = await trx.raw(
      "SELECT to_regclass('erp.labour_rate_rules') AS reg",
    );
    const hasLabourRateRuleTable = Boolean(
      labourRateRuleTable?.rows?.[0]?.reg || labourRateRuleTable?.[0]?.reg,
    );
    if (hasLabourRateRuleTable) {
      const hasArticleTypeColumn = await trx.schema
        .withSchema("erp")
        .hasColumn("labour_rate_rules", "article_type");
      const labourRatePayload = {
        labour_id: labour.id,
        dept_id: dept.id,
        apply_on: "GROUP",
        sku_id: null,
        subgroup_id: null,
        group_id: group.id,
        rate_type: "PER_PAIR",
        rate_value: 15,
        status: "active",
      };
      if (hasArticleTypeColumn) labourRatePayload.article_type = "FG";
      await trx("erp.labour_rate_rules")
        .where({
          labour_id: labour.id,
          dept_id: dept.id,
          apply_on: "GROUP",
          group_id: group.id,
        })
        .del();
      await trx("erp.labour_rate_rules").insert(labourRatePayload);
    }

    const [sfgInserted] = await trx("erp.items")
      .insert({
        item_type: "SFG",
        code: `e2e_sfg_${safeToken}`.slice(0, 80),
        name: `E2E SFG ${safeToken}`,
        name_ur: `E2E SFG ${safeToken}`,
        group_id: group.id,
        base_uom_id: productionUomId,
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
        output_uom_id: productionUomId,
        status: "APPROVED",
        version_no: 1,
        created_by: creatorId,
        approved_by: approverId,
        approved_at: trx.fn.now(),
      })
      .returning(["id"]);
    const approvedSfgBomId = Number(bomInserted?.id || bomInserted);

    await trx("erp.bom_rm_line")
      .insert({
        bom_id: approvedSfgBomId,
        rm_item_id: rmItemId,
        color_id: null,
        size_id: null,
        dept_id: dept.id,
        qty: 1,
        uom_id: uom.id,
        normal_loss_pct: 0,
      })
      // Seed deterministic RM consumption so DCV shortage path is exercised in E2E.
      .onConflict(["bom_id", "rm_item_id", "dept_id", "color_id", "size_id"])
      .ignore();

    await trx("erp.item_usage").insert({
      fg_item_id: fgItemId,
      sfg_item_id: sfgItemId,
    });

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
      uomId: productionUomId,
      groupId: Number(group.id),
      sizeId: Number(size.id),
      colorId: Number(color.id),
      packingTypeId: Number(packing.id),
      deptId: Number(dept.id),
      labourId: Number(labour.id),
      fgItemId,
      sfgItemId,
      rmItemId,
      fgVariantId,
      fgSkuId,
      sfgVariantId,
      sfgSkuId,
      approvedSfgBomId,
    };
  });
};

const createBomNegativeFixture = async (token) => {
  const safeToken = String(token || Date.now())
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 32);
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
    const sfgNoApprovedItemId = Number(
      sfgNoBomInserted?.id || sfgNoBomInserted,
    );

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
    const sfgNoApprovedVariantId = Number(
      variantInserted?.id || variantInserted,
    );

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
    .select(
      "id",
      "bom_no",
      "item_id",
      "level",
      "status",
      "version_no",
      "output_qty",
      "output_uom_id",
      "approved_by",
    )
    .where({ id })
    .first();
  if (!header) return null;

  const [rmCount, sfgCount, labourCount] = await Promise.all([
    knex("erp.bom_rm_line").where({ bom_id: id }).count({ count: "*" }).first(),
    knex("erp.bom_sfg_line")
      .where({ bom_id: id })
      .count({ count: "*" })
      .first(),
    knex("erp.bom_labour_line")
      .where({ bom_id: id })
      .count({ count: "*" })
      .first(),
  ]);

  return {
    header,
    counts: {
      rm: Number(rmCount?.count || 0),
      sfg: Number(sfgCount?.count || 0),
      labour: Number(labourCount?.count || 0),
      rule: 0,
    },
  };
};

const cleanupBomUiFixture = async ({ fixture, bomIds = [] } = {}) => {
  if (!fixture) return;
  const fixtureItemIds = [
    fixture.fgItemId,
    fixture.sfgItemId,
    fixture.rmItemId,
    fixture.sfgNoApprovedItemId,
    fixture.rmNoRateItemId,
  ]
    .map((id) => Number(id))
    .filter(Boolean);
  const fixtureSkuIds = [
    fixture.fgSkuId,
    fixture.sfgSkuId,
    fixture.sfgNoApprovedSkuId,
  ]
    .map((id) => Number(id))
    .filter(Boolean);

  await knex.transaction(async (trx) => {
    const itemLinkedBomRows = fixtureItemIds.length
      ? await trx("erp.bom_header")
          .select("id")
          .whereIn("item_id", fixtureItemIds)
      : [];
    const bomIdList = [
      ...new Set(
        [
          ...bomIds,
          fixture.approvedSfgBomId,
          ...itemLinkedBomRows.map((row) => Number(row.id)),
        ]
          .map((id) => Number(id))
          .filter(Boolean),
      ),
    ];

    if (bomIdList.length) {
      const bomVariantRuleExists = await trx.raw(
        "SELECT to_regclass('erp.bom_variant_rule') AS reg",
      );
      const hasBomVariantRule = Boolean(
        bomVariantRuleExists?.rows?.[0]?.reg || bomVariantRuleExists?.[0]?.reg,
      );
      await trx("erp.approval_request")
        .where({ entity_type: "BOM" })
        .whereIn(
          "entity_id",
          bomIdList.map((id) => String(id)),
        )
        .del();
      await trx("erp.bom_change_log").whereIn("bom_id", bomIdList).del();
      if (hasBomVariantRule) {
        await trx("erp.bom_variant_rule").whereIn("bom_id", bomIdList).del();
      }
      await trx("erp.bom_labour_line").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_sfg_line").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_rm_line").whereIn("bom_id", bomIdList).del();
      await trx("erp.bom_header").whereIn("id", bomIdList).del();
    }

    const labourRateRuleTableReg = await trx.raw(
      "SELECT to_regclass('erp.labour_rate_rules') AS reg",
    );
    const hasLabourRateRuleTable = Boolean(
      labourRateRuleTableReg?.rows?.[0]?.reg ||
      labourRateRuleTableReg?.[0]?.reg,
    );
    if (hasLabourRateRuleTable && fixtureSkuIds.length) {
      await trx("erp.labour_rate_rules").whereIn("sku_id", fixtureSkuIds).del();
    }
    if (
      hasLabourRateRuleTable &&
      fixture?.labourId &&
      fixture?.deptId &&
      fixture?.groupId
    ) {
      await trx("erp.labour_rate_rules")
        .where({
          labour_id: Number(fixture.labourId),
          dept_id: Number(fixture.deptId),
          apply_on: "GROUP",
          group_id: Number(fixture.groupId),
        })
        .del();
    }

    if (fixture.sfgSkuId) {
      await trx("erp.skus").where({ id: fixture.sfgSkuId }).del();
    }
    if (fixture.fgSkuId) {
      await trx("erp.skus").where({ id: fixture.fgSkuId }).del();
    }
    if (fixture.sfgNoApprovedSkuId) {
      await trx("erp.skus").where({ id: fixture.sfgNoApprovedSkuId }).del();
    }
    if (fixture.sfgVariantId) {
      await trx("erp.variants").where({ id: fixture.sfgVariantId }).del();
    }
    if (fixture.fgVariantId) {
      await trx("erp.variants").where({ id: fixture.fgVariantId }).del();
    }
    if (fixture.sfgNoApprovedVariantId) {
      await trx("erp.variants")
        .where({ id: fixture.sfgNoApprovedVariantId })
        .del();
    }
    if (fixture.rmItemId) {
      await trx("erp.rm_purchase_rates")
        .where({ rm_item_id: fixture.rmItemId })
        .del();
    }
    if (fixture.rmNoRateItemId) {
      await trx("erp.rm_purchase_rates")
        .where({ rm_item_id: fixture.rmNoRateItemId })
        .del();
    }

    if (fixtureItemIds.length) {
      await trx("erp.item_usage")
        .whereIn("fg_item_id", fixtureItemIds)
        .orWhereIn("sfg_item_id", fixtureItemIds)
        .del();
      await trx("erp.items").whereIn("id", fixtureItemIds).del();
    }

    if (fixture.createdSupport?.labourId) {
      await trx("erp.labours")
        .where({ id: Number(fixture.createdSupport.labourId) })
        .del();
    }
    if (fixture.createdSupport?.productionStageId) {
      await trx("erp.production_stages")
        .where({ id: Number(fixture.createdSupport.productionStageId) })
        .del();
    }
    if (fixture.createdSupport?.deptId) {
      await trx("erp.departments")
        .where({ id: Number(fixture.createdSupport.deptId) })
        .del();
    }
    if (fixture.createdSupport?.packingTypeId) {
      await trx("erp.packing_types")
        .where({ id: Number(fixture.createdSupport.packingTypeId) })
        .del();
    }
    if (fixture.createdSupport?.colorId) {
      await trx("erp.colors")
        .where({ id: Number(fixture.createdSupport.colorId) })
        .del();
    }
    if (fixture.createdSupport?.sizeId) {
      await trx("erp.sizes")
        .where({ id: Number(fixture.createdSupport.sizeId) })
        .del();
    }
    if (fixture.createdSupport?.groupId) {
      await trx("erp.product_group_item_types")
        .where({ group_id: Number(fixture.createdSupport.groupId) })
        .del();
      await trx("erp.product_groups")
        .where({ id: Number(fixture.createdSupport.groupId) })
        .del();
    }
    if (fixture.createdSupport?.uomId) {
      await trx("erp.uom")
        .where({ id: Number(fixture.createdSupport.uomId) })
        .del();
    }
  });
};

// Fixture for BOM "copy from approved BOM" regression tests. Builds:
//  - Article A: source, APPROVED FINISHED BOM with 1 RM line and TWO SKUs
//    (skuA1, skuA2) sharing the identical size/color/packing variant - this
//    engineers the "ambiguous same-variant source SKUs" scenario. It also
//    carries an sku_override row referencing an RM item never added to this
//    BOM's rm_lines ("orphaned" combo), used to prove the missing-rm-line
//    check fires even when a copy request excludes the "rm" section.
//  - Article B: target, no BOM yet, with ONE SKU sharing that same variant
//    (unambiguous target for the missing-rm-line test).
// Size/color/packing get distinct Urdu names so locale-handling can be
// asserted on directly.
const createBomCopyFixture = async (token) => {
  const safeToken = String(token || Date.now())
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 32);
  return knex.transaction(async (trx) => {
    const users = await trx("erp.users")
      .select("id")
      .orderBy("id", "asc")
      .limit(2);
    if (!users.length) return null;
    const creatorId = Number(users[0].id);
    const approverId = Number(users[1]?.id || users[0].id);

    const branch = await trx("erp.branches").select("id").orderBy("id", "asc").first();
    if (!branch) return null;

    const uom = await trx("erp.uom")
      .select("id")
      .where({ is_active: true })
      .orderBy("id", "asc")
      .first();
    if (!uom) return null;

    // FG/SFG items must use PAIR as their base UOM (DB-enforced, see
    // 095_production_uom_pair_enforcement.sql); RM items and the BOM's own
    // RM lines can use any active UOM.
    const pairUom = await trx("erp.uom")
      .select("id")
      .whereRaw(
        "is_active = true AND (UPPER(code) = 'PAIR' OR UPPER(name) = 'PAIR')",
      )
      .orderBy("id", "asc")
      .first();
    const productionUomId = Number(pairUom?.id || uom.id);

    const dept = await trx("erp.departments")
      .select("id")
      .where({ is_active: true, is_production: true })
      .orderBy("id", "asc")
      .first();
    if (!dept) return null;

    const createdSupport = {};
    let group = await trx("erp.product_groups")
      .select("id")
      .where({ is_active: true })
      .orderBy("id", "asc")
      .first();
    if (!group) {
      const [inserted] = await trx("erp.product_groups")
        .insert({
          name: `E2E Copy Group ${safeToken}`,
          name_ur: `E2E Copy Group ${safeToken}`,
          is_active: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      group = { id: inserted?.id || inserted };
      createdSupport.groupId = Number(group.id);
      await trx("erp.product_group_item_types").insert([
        { group_id: group.id, item_type: "RM" },
        { group_id: group.id, item_type: "FG" },
      ]);
    }

    const [sizeInserted] = await trx("erp.sizes")
      .insert({
        name: `E2E Copy Size ${safeToken}`,
        name_ur: `اردو سائز ${safeToken}`,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const sizeId = Number(sizeInserted?.id || sizeInserted);

    const [colorInserted] = await trx("erp.colors")
      .insert({
        name: `E2E Copy Color ${safeToken}`,
        name_ur: `اردو رنگ ${safeToken}`,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const colorId = Number(colorInserted?.id || colorInserted);

    const [packingInserted] = await trx("erp.packing_types")
      .insert({
        name: `E2E Copy Packing ${safeToken}`,
        name_ur: `اردو پیکنگ ${safeToken}`,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const packingTypeId = Number(packingInserted?.id || packingInserted);

    // A second packing type for Article B's second SKU (same size/color,
    // different packaging - the realistic Feature 2 "copy SKU values to a
    // different packaging" scenario).
    const [packing2Inserted] = await trx("erp.packing_types")
      .insert({
        name: `E2E Copy Packing2 ${safeToken}`,
        name_ur: `اردو پیکنگ 2 ${safeToken}`,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const packingType2Id = Number(packing2Inserted?.id || packing2Inserted);

    let stage = await trx("erp.production_stages")
      .select("id")
      .where({ dept_id: dept.id, is_active: true })
      .orderBy("id", "asc")
      .first();
    if (!stage) {
      const stageCode = `E2E-CP-STAGE-${safeToken}`.slice(0, 80);
      const stageName = `E2E Copy Stage ${safeToken}`.slice(0, 120);
      const [stageInserted] = await trx("erp.production_stages")
        .insert({
          code: stageCode,
          name: stageName,
          name_ur: stageName,
          dept_id: dept.id,
          is_active: true,
          created_by: creatorId,
        })
        .returning(["id"]);
      stage = { id: stageInserted?.id || stageInserted };
      createdSupport.productionStageId = Number(stage.id);
    }
    const stageId = Number(stage.id);

    const [rmInserted] = await trx("erp.items")
      .insert({
        item_type: "RM",
        code: `e2e_cprm_${safeToken}`.slice(0, 80),
        name: `E2E Copy RM ${safeToken}`,
        name_ur: `E2E Copy RM ${safeToken}`,
        group_id: group.id,
        base_uom_id: uom.id,
        created_by: creatorId,
      })
      .returning(["id"]);
    const rmItemId = Number(rmInserted?.id || rmInserted);
    await trx("erp.rm_purchase_rates").insert({
      rm_item_id: rmItemId,
      color_id: null,
      purchase_rate: 10,
      avg_purchase_rate: 10,
      is_active: true,
      created_by: creatorId,
    });

    const [rmOrphanInserted] = await trx("erp.items")
      .insert({
        item_type: "RM",
        code: `e2e_cporm_${safeToken}`.slice(0, 80),
        name: `E2E Copy Orphan RM ${safeToken}`,
        name_ur: `E2E Copy Orphan RM ${safeToken}`,
        group_id: group.id,
        base_uom_id: uom.id,
        created_by: creatorId,
      })
      .returning(["id"]);
    const rmOrphanItemId = Number(rmOrphanInserted?.id || rmOrphanInserted);
    await trx("erp.rm_purchase_rates").insert({
      rm_item_id: rmOrphanItemId,
      color_id: null,
      purchase_rate: 5,
      avg_purchase_rate: 5,
      is_active: true,
      created_by: creatorId,
    });

    const [articleAInserted] = await trx("erp.items")
      .insert({
        item_type: "FG",
        code: `e2e_cpa_${safeToken}`.slice(0, 80),
        name: `E2E Copy Article A ${safeToken}`,
        name_ur: `E2E Copy Article A ${safeToken}`,
        group_id: group.id,
        base_uom_id: productionUomId,
        uses_sfg: false,
        created_by: creatorId,
      })
      .returning(["id"]);
    const articleAId = Number(articleAInserted?.id || articleAInserted);

    // erp.variants enforces one row per unique (item_id, size_id, grade_id,
    // color_id, packing_type_id) identity - so "two SKUs sharing the same
    // variant identity" (the real-world case this fixture engineers) means
    // two erp.skus rows on the SAME variant row, not two variant rows.
    const [variantAInserted] = await trx("erp.variants")
      .insert({
        item_id: articleAId,
        size_id: sizeId,
        color_id: colorId,
        packing_type_id: packingTypeId,
        sale_rate: 100,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const variantA1Id = Number(variantAInserted?.id || variantAInserted);
    const variantA2Id = variantA1Id;
    const [skuA1Inserted] = await trx("erp.skus")
      .insert({
        variant_id: variantA1Id,
        sku_code: `E2E-CPA1-${safeToken}`.slice(0, 80),
        is_active: true,
      })
      .returning(["id"]);
    const skuA1Id = Number(skuA1Inserted?.id || skuA1Inserted);

    const [skuA2Inserted] = await trx("erp.skus")
      .insert({
        variant_id: variantA2Id,
        sku_code: `E2E-CPA2-${safeToken}`.slice(0, 80),
        is_active: true,
      })
      .returning(["id"]);
    const skuA2Id = Number(skuA2Inserted?.id || skuA2Inserted);

    const [bomAInserted] = await trx("erp.bom_header")
      .insert({
        bom_no: `E2E-CPBOM-A-${safeToken}`.slice(0, 120),
        item_id: articleAId,
        level: "FINISHED",
        output_qty: 1,
        output_uom_id: productionUomId,
        status: "APPROVED",
        version_no: 1,
        created_by: creatorId,
        approved_by: approverId,
        approved_at: trx.fn.now(),
      })
      .returning(["id"]);
    const bomAId = Number(bomAInserted?.id || bomAInserted);

    await trx("erp.bom_rm_line").insert({
      bom_id: bomAId,
      rm_item_id: rmItemId,
      color_id: null,
      size_id: null,
      dept_id: dept.id,
      qty: 10,
      uom_id: uom.id,
      normal_loss_pct: 0,
    });

    await trx("erp.bom_stage_routing").insert({
      bom_id: bomAId,
      stage_id: stageId,
      sequence_no: 1,
      is_required: true,
      enforce_sequence: true,
    });

    await trx("erp.bom_sku_override_line").insert([
      {
        bom_id: bomAId,
        sku_id: skuA1Id,
        target_rm_item_id: rmItemId,
        dept_id: dept.id,
        is_excluded: false,
        override_qty: 5,
        override_uom_id: uom.id,
      },
      {
        bom_id: bomAId,
        sku_id: skuA2Id,
        target_rm_item_id: rmItemId,
        dept_id: dept.id,
        is_excluded: false,
        override_qty: 9,
        override_uom_id: uom.id,
      },
      // Orphaned combo: target_rm_item_id is never added as a bom_rm_line on
      // this BOM. Proves missing_rm_line still fires when a copy request
      // only asks for sections=sku_overrides (excluding "rm").
      {
        bom_id: bomAId,
        sku_id: skuA1Id,
        target_rm_item_id: rmOrphanItemId,
        dept_id: dept.id,
        is_excluded: false,
        override_qty: 3,
        override_uom_id: uom.id,
      },
    ]);

    const [articleBInserted] = await trx("erp.items")
      .insert({
        item_type: "FG",
        code: `e2e_cpb_${safeToken}`.slice(0, 80),
        name: `E2E Copy Article B ${safeToken}`,
        name_ur: `E2E Copy Article B ${safeToken}`,
        group_id: group.id,
        base_uom_id: productionUomId,
        uses_sfg: false,
        created_by: creatorId,
      })
      .returning(["id"]);
    const articleBId = Number(articleBInserted?.id || articleBInserted);

    const [variantBInserted] = await trx("erp.variants")
      .insert({
        item_id: articleBId,
        size_id: sizeId,
        color_id: colorId,
        packing_type_id: packingTypeId,
        sale_rate: 100,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const variantBId = Number(variantBInserted?.id || variantBInserted);
    const [skuBInserted] = await trx("erp.skus")
      .insert({
        variant_id: variantBId,
        sku_code: `E2E-CPB-${safeToken}`.slice(0, 80),
        is_active: true,
      })
      .returning(["id"]);
    const skuBId = Number(skuBInserted?.id || skuBInserted);

    // A second SKU on Article B: same size/color, different packaging - the
    // realistic target pair for the in-article "copy SKU values" feature.
    const [variantB2Inserted] = await trx("erp.variants")
      .insert({
        item_id: articleBId,
        size_id: sizeId,
        color_id: colorId,
        packing_type_id: packingType2Id,
        sale_rate: 100,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const variantB2Id = Number(variantB2Inserted?.id || variantB2Inserted);
    const [skuB2Inserted] = await trx("erp.skus")
      .insert({
        variant_id: variantB2Id,
        sku_code: `E2E-CPB2-${safeToken}`.slice(0, 80),
        is_active: true,
      })
      .returning(["id"]);
    const skuB2Id = Number(skuB2Inserted?.id || skuB2Inserted);

    return {
      token: safeToken,
      createdSupport,
      creatorId,
      approverId,
      branchId: Number(branch.id),
      uomId: Number(uom.id),
      productionUomId,
      groupId: Number(group.id),
      sizeId,
      colorId,
      packingTypeId,
      deptId: Number(dept.id),
      stageId,
      packingType2Id,
      rmItemId,
      rmOrphanItemId,
      articleAId,
      bomAId,
      skuA1Id,
      skuA2Id,
      variantA1Id,
      variantA2Id,
      articleBId,
      skuBId,
      variantBId,
      skuB2Id,
      variantB2Id,
    };
  });
};

// Seeds a DRAFT bom_header for Article B copied from Article A (with its own
// RM line + a single SKU override matching skuA1's value exactly), then
// wraps it in a PENDING approval_request the same shape saveBomDraft/
// send-for-approval would produce, so the admin preview screen can be
// exercised directly without driving the whole multi-step UI flow.
const seedBomCopyPendingApproval = async (fixture) => {
  const draftBomNo = `E2E-CPBOM-B-${fixture.token}`.slice(0, 120);
  const [bomBInserted] = await knex("erp.bom_header")
    .insert({
      bom_no: draftBomNo,
      item_id: fixture.articleBId,
      level: "FINISHED",
      output_qty: 1,
      output_uom_id: fixture.productionUomId,
      status: "DRAFT",
      version_no: 1,
      created_by: fixture.creatorId,
      copied_from_bom_id: fixture.bomAId,
    })
    .returning(["id"]);
  const bomBId = Number(bomBInserted?.id || bomBInserted);

  await knex("erp.bom_rm_line").insert({
    bom_id: bomBId,
    rm_item_id: fixture.rmItemId,
    color_id: null,
    size_id: null,
    dept_id: fixture.deptId,
    qty: 5,
    uom_id: fixture.uomId,
    normal_loss_pct: 0,
  });

  await knex("erp.bom_sku_override_line").insert({
    bom_id: bomBId,
    sku_id: fixture.skuBId,
    target_rm_item_id: fixture.rmItemId,
    dept_id: fixture.deptId,
    is_excluded: false,
    // Matches skuA1's override_qty (5) exactly - if the ambiguous source-SKU
    // fix were absent, this could be silently matched to skuA1 and shown as
    // "Copied as-is" even though it's genuinely unresolvable (skuA1 and
    // skuA2 share the same variant identity).
    override_qty: 5,
    override_uom_id: fixture.uomId,
  });

  const snapshot = await bomService.getBomSnapshot(knex, bomBId);
  const payload = bomService.buildApproveDraftPayload({ bomId: bomBId, snapshot });

  const [approvalInserted] = await knex("erp.approval_request")
    .insert({
      branch_id: fixture.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "BOM",
      entity_id: String(bomBId),
      summary: `Approve BOM #${draftBomNo}`,
      old_value: null,
      new_value: payload,
      status: "PENDING",
      requested_by: fixture.creatorId,
    })
    .returning(["id"]);
  const approvalRequestId = Number(approvalInserted?.id || approvalInserted);

  return { bomBId, approvalRequestId };
};

const cleanupBomCopyFixture = async (fixture, extraBomIds = []) => {
  if (!fixture) return;
  await knex.transaction(async (trx) => {
    const bomIds = [
      ...new Set(
        [fixture.bomAId, ...extraBomIds].map((id) => Number(id)).filter(Boolean),
      ),
    ];
    if (bomIds.length) {
      await trx("erp.approval_request")
        .where({ entity_type: "BOM" })
        .whereIn(
          "entity_id",
          bomIds.map((id) => String(id)),
        )
        .del();
      await trx("erp.bom_change_log").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_sku_override_line").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_stage_routing").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_rm_line").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_header").whereIn("id", bomIds).del();
    }

    const skuIds = [fixture.skuA1Id, fixture.skuA2Id, fixture.skuBId, fixture.skuB2Id]
      .map((id) => Number(id))
      .filter(Boolean);
    if (skuIds.length) await trx("erp.skus").whereIn("id", skuIds).del();

    const variantIds = [
      fixture.variantA1Id,
      fixture.variantA2Id,
      fixture.variantBId,
      fixture.variantB2Id,
    ]
      .map((id) => Number(id))
      .filter(Boolean);
    if (variantIds.length) await trx("erp.variants").whereIn("id", variantIds).del();

    if (fixture.rmItemId)
      await trx("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmItemId }).del();
    if (fixture.rmOrphanItemId)
      await trx("erp.rm_purchase_rates")
        .where({ rm_item_id: fixture.rmOrphanItemId })
        .del();

    const itemIds = [
      fixture.articleAId,
      fixture.articleBId,
      fixture.rmItemId,
      fixture.rmOrphanItemId,
    ]
      .map((id) => Number(id))
      .filter(Boolean);
    if (itemIds.length) await trx("erp.items").whereIn("id", itemIds).del();

    if (fixture.createdSupport?.groupId) {
      await trx("erp.product_group_item_types")
        .where({ group_id: Number(fixture.createdSupport.groupId) })
        .del();
      await trx("erp.product_groups")
        .where({ id: Number(fixture.createdSupport.groupId) })
        .del();
    }
    if (fixture.createdSupport?.productionStageId) {
      await trx("erp.production_stages")
        .where({ id: Number(fixture.createdSupport.productionStageId) })
        .del();
    }
    if (fixture.sizeId) await trx("erp.sizes").where({ id: fixture.sizeId }).del();
    if (fixture.colorId) await trx("erp.colors").where({ id: fixture.colorId }).del();
    if (fixture.packingTypeId)
      await trx("erp.packing_types").where({ id: fixture.packingTypeId }).del();
    if (fixture.packingType2Id)
      await trx("erp.packing_types").where({ id: fixture.packingType2Id }).del();
  });
};

// Deletes a single BOM draft (and its lines/change-log rows, via
// ON DELETE CASCADE) immediately, so an article it was drafted for becomes
// eligible again for the "/new" article dropdown within the same test file.
const deleteBomHeaderById = async (bomId) => {
  const id = Number(bomId || 0);
  if (!id) return;
  await knex("erp.approval_request")
    .where({ entity_type: "BOM", entity_id: String(id) })
    .del();
  await knex("erp.bom_header").where({ id }).del();
};

// Builds a parent article (A, APPROVED v1) copied into a dependent article
// (B, APPROVED v1, copied_from_bom_id = A's v1). B is then given an
// independent local edit (simulating a real hand-edit + save + re-approve),
// and A gets a new APPROVED v2 with: a safe change to a shared material
// (distinct from B's edit value, so "conflict correctly left alone" and
// "safe change correctly applied" are never indistinguishable), a change to
// the SAME material B independently edited (a genuine conflict for B), and
// a brand-new material + matching SKU override (a safe add). A third,
// always-untouched material keeps every section "eligible" throughout (see
// backend/src/scripts/test-bom-cascade.js for why a fully-edited section
// with zero remaining 'copied' rows looks indistinguishable from "never
// copied" - a documented v1 limitation of the cascade feature).
const createBomCascadeFixture = async (token) => {
  const safeToken = String(token || Date.now())
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 32);
  return knex.transaction(async (trx) => {
    const admin = await trx("erp.users").select("id").where({ username: "admin" }).first();
    if (!admin) return null;
    const uomRows = await trx("erp.uom").select("id").where({ is_active: true }).orderBy("id", "asc").limit(3);
    if (uomRows.length < 3) return null;
    const [uom, uom2, uom3] = uomRows;
    const pairUom = await trx("erp.uom")
      .select("id")
      .whereRaw("is_active = true AND (UPPER(code) = 'PAIR' OR UPPER(name) = 'PAIR')")
      .first();
    const productionUomId = Number(pairUom?.id || uom.id);
    const dept = await trx("erp.departments")
      .select("id")
      .where({ is_active: true, is_production: true })
      .orderBy("id", "asc")
      .first();
    if (!dept) return null;

    const createdSupport = {};
    let group = await trx("erp.product_groups").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    if (!group) {
      const [inserted] = await trx("erp.product_groups")
        .insert({ name: `E2E Cascade Group ${safeToken}`, name_ur: `E2E Cascade Group ${safeToken}`, is_active: true, created_by: admin.id })
        .returning(["id"]);
      group = { id: inserted?.id || inserted };
      createdSupport.groupId = Number(group.id);
      await trx("erp.product_group_item_types").insert([
        { group_id: group.id, item_type: "RM" },
        { group_id: group.id, item_type: "FG" },
      ]);
    }
    const size = await trx("erp.sizes").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    const color = await trx("erp.colors").select("id").where({ is_active: true }).orderBy("id", "asc").first();
    const packing = await trx("erp.packing_types").select("id").where({ is_active: true }).orderBy("id", "asc").first();

    const insertRmItem = async (suffix, rate) => {
      const [inserted] = await trx("erp.items")
        .insert({
          item_type: "RM",
          code: `e2e_casc_rm_${suffix}_${safeToken}`.slice(0, 80),
          name: `E2E Cascade RM ${suffix} ${safeToken}`,
          group_id: group.id,
          base_uom_id: uom.id,
          created_by: admin.id,
        })
        .returning(["id"]);
      const id = Number(inserted?.id || inserted);
      await trx("erp.rm_purchase_rates").insert({
        rm_item_id: id,
        color_id: null,
        purchase_rate: rate,
        avg_purchase_rate: rate,
        is_active: true,
        created_by: admin.id,
      });
      return id;
    };
    const rmShared = await insertRmItem("shared", 10);
    const rmNew = await insertRmItem("new", 4);
    const rmStable = await insertRmItem("stable", 2);

    const insertArticle = async (suffix) => {
      const [itemInserted] = await trx("erp.items")
        .insert({
          item_type: "FG",
          code: `e2e_casc_${suffix}_${safeToken}`.slice(0, 80),
          name: `E2E Cascade ${suffix} ${safeToken}`,
          group_id: group.id,
          base_uom_id: productionUomId,
          uses_sfg: false,
          created_by: admin.id,
        })
        .returning(["id"]);
      const itemId = Number(itemInserted?.id || itemInserted);
      const [variantInserted] = await trx("erp.variants")
        .insert({
          item_id: itemId,
          size_id: size.id,
          color_id: color.id,
          packing_type_id: packing.id,
          sale_rate: 100,
          is_active: true,
          created_by: admin.id,
        })
        .returning(["id"]);
      const variantId = Number(variantInserted?.id || variantInserted);
      const [skuInserted] = await trx("erp.skus")
        .insert({ variant_id: variantId, sku_code: `E2E-CASC-${suffix}-${safeToken}`.slice(0, 80), is_active: true })
        .returning(["id"]);
      const skuId = Number(skuInserted?.id || skuInserted);
      return { itemId, variantId, skuId };
    };
    const articleA = await insertArticle("A");
    const articleB = await insertArticle("B");

    const insertApprovedBom = async ({ itemId, bomNoSuffix, rmLines, skuOverrides, copiedFromBomId = null, versionNo = 1 }) => {
      const [bomInserted] = await trx("erp.bom_header")
        .insert({
          bom_no: `E2E-CASCBOM-${bomNoSuffix}-${safeToken}`.slice(0, 120),
          item_id: itemId,
          level: "FINISHED",
          output_qty: 1,
          output_uom_id: productionUomId,
          status: "APPROVED",
          version_no: versionNo,
          created_by: admin.id,
          approved_by: admin.id,
          approved_at: trx.fn.now(),
          copied_from_bom_id: copiedFromBomId,
        })
        .returning(["id"]);
      const bomId = Number(bomInserted?.id || bomInserted);
      if (rmLines.length) {
        await trx("erp.bom_rm_line").insert(rmLines.map((line) => ({ bom_id: bomId, color_id: null, size_id: null, ...line })));
      }
      if (skuOverrides.length) {
        await trx("erp.bom_sku_override_line").insert(
          skuOverrides.map((row) => ({ bom_id: bomId, is_excluded: false, override_uom_id: uom.id, ...row })),
        );
      }
      return bomId;
    };

    const bomA1 = await insertApprovedBom({
      itemId: articleA.itemId,
      bomNoSuffix: "A1",
      rmLines: [
        { rm_item_id: rmShared, dept_id: dept.id, qty: 10, uom_id: uom.id, normal_loss_pct: 0 },
        { rm_item_id: rmStable, dept_id: dept.id, qty: 1, uom_id: uom.id, normal_loss_pct: 0 },
      ],
      skuOverrides: [
        { sku_id: articleA.skuId, target_rm_item_id: rmShared, dept_id: dept.id, override_qty: 5 },
        { sku_id: articleA.skuId, target_rm_item_id: rmStable, dept_id: dept.id, override_qty: 1 },
      ],
    });
    const bomB1 = await insertApprovedBom({
      itemId: articleB.itemId,
      bomNoSuffix: "B1",
      rmLines: [
        { rm_item_id: rmShared, dept_id: dept.id, qty: 5, uom_id: uom.id, normal_loss_pct: 0 },
        { rm_item_id: rmStable, dept_id: dept.id, qty: 1, uom_id: uom.id, normal_loss_pct: 0 },
      ],
      skuOverrides: [
        { sku_id: articleB.skuId, target_rm_item_id: rmShared, dept_id: dept.id, override_qty: 5 },
        { sku_id: articleB.skuId, target_rm_item_id: rmStable, dept_id: dept.id, override_qty: 1 },
      ],
      copiedFromBomId: bomA1,
    });

    // Simulate "the maker independently edited B's copy" - distinct from
    // whatever the parent later changes to, so the conflict is verifiable.
    await trx("erp.bom_rm_line")
      .where({ bom_id: bomB1, rm_item_id: rmShared, dept_id: dept.id })
      .update({ uom_id: uom3.id });
    await trx("erp.bom_sku_override_line")
      .where({ bom_id: bomB1, sku_id: articleB.skuId, target_rm_item_id: rmShared, dept_id: dept.id })
      .update({ override_qty: 99 });

    const bomA2 = await insertApprovedBom({
      itemId: articleA.itemId,
      bomNoSuffix: "A2",
      versionNo: 2,
      rmLines: [
        { rm_item_id: rmShared, dept_id: dept.id, qty: 10, uom_id: uom2.id, normal_loss_pct: 0 },
        { rm_item_id: rmStable, dept_id: dept.id, qty: 1, uom_id: uom.id, normal_loss_pct: 0 },
        { rm_item_id: rmNew, dept_id: dept.id, qty: 3, uom_id: uom.id, normal_loss_pct: 0 },
      ],
      skuOverrides: [
        { sku_id: articleA.skuId, target_rm_item_id: rmShared, dept_id: dept.id, override_qty: 8 },
        { sku_id: articleA.skuId, target_rm_item_id: rmStable, dept_id: dept.id, override_qty: 1 },
        { sku_id: articleA.skuId, target_rm_item_id: rmNew, dept_id: dept.id, override_qty: 3 },
      ],
    });

    return {
      token: safeToken,
      createdSupport,
      admin,
      dept: Number(dept.id),
      rmShared,
      rmNew,
      rmStable,
      articleA,
      articleB,
      bomA1,
      bomA2,
      bomB1,
      createdItemIds: [articleA.itemId, articleB.itemId, rmShared, rmNew, rmStable],
      createdSkuIds: [articleA.skuId, articleB.skuId],
      createdVariantIds: [articleA.variantId, articleB.variantId],
      createdBomIds: [bomA1, bomA2, bomB1],
    };
  });
};

// Full state (header including copied_from_bom_id + rm_lines + sku_overrides)
// for a cascade-created draft, used to verify apply results at the DB level
// (equivalent detail isn't exposed via the generic getBomSnapshot helper).
const getBomCascadeState = async (bomId) => {
  const id = Number(bomId || 0);
  if (!id) return null;
  const header = await knex("erp.bom_header")
    .select("id", "status", "version_no", "copied_from_bom_id")
    .where({ id })
    .first();
  if (!header) return null;
  const rmLines = await knex("erp.bom_rm_line").where({ bom_id: id });
  const skuOverrides = await knex("erp.bom_sku_override_line").where({ bom_id: id });
  return { header, rmLines, skuOverrides };
};

const cleanupBomCascadeFixture = async (fixture, extraBomIds = []) => {
  if (!fixture) return;
  await knex.transaction(async (trx) => {
    const bomIds = [...new Set([...(fixture.createdBomIds || []), ...extraBomIds].map((id) => Number(id)).filter(Boolean))];
    if (bomIds.length) {
      await trx("erp.approval_request")
        .where({ entity_type: "BOM" })
        .whereIn("entity_id", bomIds.map((id) => String(id)))
        .del();
      await trx("erp.bom_change_log").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_sku_override_line").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_stage_routing").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_rm_line").whereIn("bom_id", bomIds).del();
      await trx("erp.bom_header").whereIn("id", bomIds).del();
    }
    if (fixture.createdSkuIds?.length) await trx("erp.skus").whereIn("id", fixture.createdSkuIds).del();
    if (fixture.createdVariantIds?.length) await trx("erp.variants").whereIn("id", fixture.createdVariantIds).del();
    if (fixture.rmShared) await trx("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmShared }).del();
    if (fixture.rmNew) await trx("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmNew }).del();
    if (fixture.rmStable) await trx("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmStable }).del();
    if (fixture.createdItemIds?.length) await trx("erp.items").whereIn("id", fixture.createdItemIds).del();
    if (fixture.createdSupport?.groupId) {
      await trx("erp.product_group_item_types").where({ group_id: Number(fixture.createdSupport.groupId) }).del();
      await trx("erp.product_groups").where({ id: Number(fixture.createdSupport.groupId) }).del();
    }
  });
};

// Fixture for SFG purchase-line variant validation. Finds a real, active SFG
// item that already has an active variant + SKU and NO rm_purchase_rates (so the
// rate-based color/size policy is skipped and the SFG-variant check is the rule
// that fires). Also returns a "bogus" active color that is not part of any of
// that item's variants, so (bogusColor, validSize) is guaranteed not to resolve
// to a defined SKU. Returns null when the dev DB lacks suitable data.
const getSfgPurchaseValidationFixture = async () => {
  const variant = await knex("erp.variants as v")
    .join("erp.items as i", "i.id", "v.item_id")
    .join("erp.skus as k", "k.variant_id", "v.id")
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'SFG'")
    .where({ "v.is_active": true, "k.is_active": true, "i.is_active": true })
    .whereNotExists(function noRmRates() {
      this.select(1)
        .from("erp.rm_purchase_rates as r")
        .whereRaw("r.rm_item_id = v.item_id")
        .andWhere("r.is_active", true);
    })
    .select(
      "v.item_id as item_id",
      "v.color_id as color_id",
      "v.size_id as size_id",
      "i.name as item_name",
      "k.id as sku_id",
    )
    .orderBy("v.id", "asc")
    .first();
  if (!variant) return null;

  const usedColorRows = await knex("erp.variants")
    .where({ item_id: variant.item_id })
    .whereNotNull("color_id")
    .distinct("color_id");
  const usedColorIds = usedColorRows
    .map((r) => Number(r.color_id))
    .filter(Boolean);

  const bogusColor = await knex("erp.colors")
    .where({ is_active: true })
    .modify((q) => {
      if (usedColorIds.length) q.whereNotIn("id", usedColorIds);
    })
    .select("id", "name")
    .orderBy("id", "asc")
    .first();

  const usedSizeRows = await knex("erp.variants")
    .where({ item_id: variant.item_id })
    .whereNotNull("size_id")
    .distinct("size_id");
  const usedSizeIds = usedSizeRows.map((r) => Number(r.size_id)).filter(Boolean);

  const bogusSize = await knex("erp.sizes")
    .where({ is_active: true })
    .modify((q) => {
      if (usedSizeIds.length) q.whereNotIn("id", usedSizeIds);
    })
    .select("id", "name")
    .orderBy("id", "asc")
    .first();

  return {
    itemId: Number(variant.item_id),
    itemName: variant.item_name || "",
    skuId: variant.sku_id ? Number(variant.sku_id) : null,
    validColorId: variant.color_id ? Number(variant.color_id) : null,
    validSizeId: variant.size_id ? Number(variant.size_id) : null,
    bogusColorId: bogusColor ? Number(bogusColor.id) : null,
    bogusSizeId: bogusSize ? Number(bogusSize.id) : null,
    variantColorIds: usedColorIds,
    variantSizeIds: usedSizeIds,
  };
};

// Sum of SFG SKU on-hand pairs for a given sku across branches (stock_balance_sku).
const sumSfgSkuQtyPairs = async (skuId) => {
  const normalizedSkuId = Number(skuId || 0);
  if (!normalizedSkuId) return 0;
  const row = await knex("erp.stock_balance_sku")
    .where({ sku_id: normalizedSkuId, category: "SFG" })
    .sum({ total: "qty_pairs" })
    .first();
  return Number(row?.total || 0);
};

// The category='SFG' IN ledger row (if any) for a sku on a specific voucher.
const getSfgInLedgerRow = async ({ skuId, voucherHeaderId }) => {
  const normalizedSkuId = Number(skuId || 0);
  const normalizedVoucherId = Number(voucherHeaderId || 0);
  if (!normalizedSkuId || !normalizedVoucherId) return null;
  const row = await knex("erp.stock_ledger")
    .where({
      sku_id: normalizedSkuId,
      voucher_header_id: normalizedVoucherId,
      category: "SFG",
      direction: 1,
    })
    .select("qty", "qty_pairs", "unit_cost", "value", "item_id")
    .first();
  return row || null;
};

const closeDb = async () => knex.destroy();

module.exports = {
  getLinkedSize,
  getBranch,
  getBranchScopedAccounts,
  getApprovalEditFixtureData,
  getFirstParty,
  getUserByUsername,
  getTwoDistinctUsers,
  getVariantForSkuApproval,
  createApprovalRequest,
  deleteApprovalRequests,
  findLatestApprovalRequest,
  getLatestVoucherHeader,
  getLatestOpenReturnableOutwardReference,
  getTwoOpenReturnableOutwardReferencesForSameVendor,
  getVoucherLineCount,
  getPurchaseAllocationCountByVoucher,
  setVariantSaleRate,
  findVariantsBySaleRate,
  createThrowawayColor,
  deleteColorById,
  deleteVariantCascadeById,
  setVariantRateEditable,
  getFirstFgVariantWithRate,
  upsertUserWithPermissions,
  updateUserProfile,
  getApprovalNotificationRecipientEmails,
  clearUserPermissionsOverride,
  setUserScreenPermission,
  setUserScopePermission,
  clearUserScopePermission,
  getPermissionScope,
  getFirstNonAdminRole,
  insertActivityLogRows,
  deleteActivityLogs,
  getActivityLogIdsByApprovalRequestId,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  listInventoryNegativeStockOverrides,
  clearInventoryNegativeStockOverrides,
  upsertInventoryNegativeStockOverride,
  replaceInventoryNegativeStockOverrides,
  replaceUserAccountAccess,
  clearUserAccountAccess,
  createBomUiFixture,
  createBomNegativeFixture,
  getBomSnapshot,
  cleanupBomUiFixture,
  createBomCopyFixture,
  seedBomCopyPendingApproval,
  cleanupBomCopyFixture,
  deleteBomHeaderById,
  createBomCascadeFixture,
  cleanupBomCascadeFixture,
  getBomCascadeState,
  getSfgPurchaseValidationFixture,
  sumSfgSkuQtyPairs,
  getSfgInLedgerRow,
  closeDb,
};
