const knex = require("../../db/knex");

let hasUserAccountAccessTablePromise = null;

const toPositiveInt = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeAccessFlags = (row = {}) => {
  const canViewDetails = Boolean(row.canViewDetails);
  const canViewSummary = canViewDetails || Boolean(row.canViewSummary);
  return {
    canViewSummary,
    canViewDetails: canViewSummary ? canViewDetails : false,
  };
};

const hasUserAccountAccessTable = async (db = knex) => {
  if (!hasUserAccountAccessTablePromise) {
    hasUserAccountAccessTablePromise = db.schema
      .withSchema("erp")
      .hasTable("user_account_access")
      .catch(() => false);
  }
  return hasUserAccountAccessTablePromise;
};

const getUserBranchIds = async ({ db = knex, userId }) => {
  const resolvedUserId = toPositiveInt(userId);
  if (!resolvedUserId) return [];
  const rows = await db("erp.user_branch")
    .select("branch_id")
    .where({ user_id: resolvedUserId });
  return rows
    .map((row) => toPositiveInt(row.branch_id))
    .filter((id) => Number.isInteger(id) && id > 0);
};

const getAccountBranchNames = async ({
  db = knex,
  accountIds = [],
  branchIds = [],
}) => {
  const normalizedAccountIds = Array.from(
    new Set(accountIds.map(toPositiveInt).filter(Boolean)),
  );
  if (!normalizedAccountIds.length) return new Map();

  let query = db("erp.account_branch as ab")
    .join("erp.branches as b", "b.id", "ab.branch_id")
    .select("ab.account_id", "b.name")
    .whereIn("ab.account_id", normalizedAccountIds);

  const normalizedBranchIds = Array.from(
    new Set(branchIds.map(toPositiveInt).filter(Boolean)),
  );
  if (normalizedBranchIds.length) {
    query = query.whereIn("ab.branch_id", normalizedBranchIds);
  }

  const rows = await query.orderBy("b.name", "asc");
  const byAccount = new Map();
  rows.forEach((row) => {
    const accountId = toPositiveInt(row.account_id);
    if (!accountId) return;
    const current = byAccount.get(accountId) || [];
    const branchName = String(row.name || "").trim();
    if (branchName && !current.includes(branchName)) current.push(branchName);
    byAccount.set(accountId, current);
  });
  return byAccount;
};

const getAssignableAccountsForUser = async ({ db = knex, userId }) => {
  const resolvedUserId = toPositiveInt(userId);
  if (!resolvedUserId) return [];

  const branchIds = await getUserBranchIds({ db, userId: resolvedUserId });

  let query = db("erp.accounts as a")
    .distinct("a.id", "a.code", "a.name")
    .where({ "a.is_active": true });

  if (branchIds.length) {
    query = query.whereExists(function whereBranchMapping() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .whereIn("ab.branch_id", branchIds);
    });
  }

  const accounts = await query.orderBy("a.name", "asc");
  const branchNamesByAccount = await getAccountBranchNames({
    db,
    accountIds: accounts.map((row) => row.id),
    branchIds,
  });

  return accounts.map((row) => ({
    id: Number(row.id),
    code: String(row.code || ""),
    name: String(row.name || ""),
    branchNames: branchNamesByAccount.get(Number(row.id)) || [],
  }));
};

const getUserAccountAccessRows = async ({ db = knex, userId }) => {
  const resolvedUserId = toPositiveInt(userId);
  if (!resolvedUserId) return [];
  if (!(await hasUserAccountAccessTable(db))) return [];

  const rows = await db("erp.user_account_access as uaa")
    .join("erp.accounts as a", "a.id", "uaa.account_id")
    .select(
      "uaa.account_id",
      "uaa.can_view_summary",
      "uaa.can_view_details",
      "a.code",
      "a.name",
    )
    .where({ "uaa.user_id": resolvedUserId })
    .orderBy("a.name", "asc");

  const branchIds = await getUserBranchIds({ db, userId: resolvedUserId });
  const branchNamesByAccount = await getAccountBranchNames({
    db,
    accountIds: rows.map((row) => row.account_id),
    branchIds,
  });

  return rows.map((row) => ({
    accountId: Number(row.account_id),
    code: String(row.code || ""),
    name: String(row.name || ""),
    canViewSummary: Boolean(row.can_view_summary),
    canViewDetails: Boolean(row.can_view_details),
    branchNames: branchNamesByAccount.get(Number(row.account_id)) || [],
  }));
};

const upsertUserAccountAccessRows = async ({
  db = knex,
  userId,
  actorUserId,
  rows = [],
}) => {
  const resolvedUserId = toPositiveInt(userId);
  if (!resolvedUserId) return { upserted: 0, deleted: 0 };
  if (!(await hasUserAccountAccessTable(db)))
    return { upserted: 0, deleted: 0 };

  const assignable = await getAssignableAccountsForUser({
    db,
    userId: resolvedUserId,
  });
  const assignableIds = new Set(assignable.map((row) => Number(row.id)));

  const normalizedMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((entry) => {
    const accountId = toPositiveInt(entry.accountId);
    if (!accountId || !assignableIds.has(accountId)) return;
    const normalizedFlags = normalizeAccessFlags(entry);
    normalizedMap.set(accountId, {
      accountId,
      ...normalizedFlags,
    });
  });

  const targetIds = Array.from(normalizedMap.keys());

  let deleted = 0;
  if (targetIds.length) {
    deleted = await db("erp.user_account_access")
      .where({ user_id: resolvedUserId })
      .whereNotIn("account_id", targetIds)
      .del();
  } else {
    deleted = await db("erp.user_account_access")
      .where({ user_id: resolvedUserId })
      .del();
  }

  if (!targetIds.length) {
    return { upserted: 0, deleted: Number(deleted || 0) };
  }

  const payload = targetIds.map((accountId) => {
    const row = normalizedMap.get(accountId);
    return {
      user_id: resolvedUserId,
      account_id: accountId,
      can_view_summary: row.canViewSummary,
      can_view_details: row.canViewDetails,
      created_by: toPositiveInt(actorUserId),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };
  });

  await db("erp.user_account_access")
    .insert(payload)
    .onConflict(["user_id", "account_id"])
    .merge({
      can_view_summary: db.raw("EXCLUDED.can_view_summary"),
      can_view_details: db.raw("EXCLUDED.can_view_details"),
      updated_at: db.fn.now(),
    });

  return { upserted: payload.length, deleted: Number(deleted || 0) };
};

const getUserAccountAccessMap = async ({ db = knex, userId }) => {
  const resolvedUserId = toPositiveInt(userId);
  const accessMap = new Map();
  if (!resolvedUserId) return accessMap;
  if (!(await hasUserAccountAccessTable(db))) return accessMap;

  const rows = await db("erp.user_account_access")
    .select("account_id", "can_view_summary", "can_view_details")
    .where({ user_id: resolvedUserId, can_view_summary: true });

  rows.forEach((row) => {
    const accountId = toPositiveInt(row.account_id);
    if (!accountId) return;
    accessMap.set(accountId, {
      canViewSummary: Boolean(row.can_view_summary),
      canViewDetails: Boolean(row.can_view_details),
    });
  });

  return accessMap;
};

const filterAccountsByAccess = ({ accounts = [], accessMap = new Map() }) => {
  if (!(accessMap instanceof Map) || accessMap.size === 0) return [];
  return accounts.filter((row) => accessMap.has(Number(row.id)));
};

const canUserViewAccountDetails = ({ accessMap = new Map(), accountId }) => {
  const resolvedId = toPositiveInt(accountId);
  if (!resolvedId) return false;
  const row = accessMap.get(resolvedId);
  return Boolean(row && row.canViewDetails);
};

module.exports = {
  getAssignableAccountsForUser,
  getUserAccountAccessRows,
  upsertUserAccountAccessRows,
  getUserAccountAccessMap,
  filterAccountsByAccess,
  canUserViewAccountDetails,
  hasUserAccountAccessTable,
};
