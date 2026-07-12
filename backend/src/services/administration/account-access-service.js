const knex = require("../../db/knex");

let hasUserAccountAccessTablePromise = null;
let hasRoleAccountAccessTablePromise = null;

const toPositiveInt = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Map access flags to the UI restriction level.
//   allow   -> full access (used at user level to override a role restriction)
//   summary -> can view summary, details blocked ("Block Details Only")
//   details -> summary + details blocked ("Block Summary + Details")
const flagsToLevel = (canViewSummary, canViewDetails) => {
  if (canViewSummary && canViewDetails) return "allow";
  if (canViewSummary) return "summary";
  return "details";
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

const hasRoleAccountAccessTable = async (db = knex) => {
  if (!hasRoleAccountAccessTablePromise) {
    hasRoleAccountAccessTablePromise = db.schema
      .withSchema("erp")
      .hasTable("role_account_access")
      .catch(() => false);
  }
  return hasRoleAccountAccessTablePromise;
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

// Assignable = every active account the Account Activity Ledger can surface.
// We intentionally do NOT filter by branch here: individual employee/labour ledger
// accounts (and other control accounts) frequently have no account_branch mapping,
// and the per-account access guards apply regardless of branch. Branch-scoping this
// list silently hid those accounts from restriction. Role- and user-level assignment
// both draw from the same universe.
const getAssignableAccounts = async ({ db = knex } = {}) => {
  const accounts = await db("erp.accounts as a")
    .distinct("a.id", "a.code", "a.name")
    .where({ "a.is_active": true })
    .orderBy("a.name", "asc");

  const branchNamesByAccount = await getAccountBranchNames({
    db,
    accountIds: accounts.map((row) => row.id),
    branchIds: [],
  });

  return accounts.map((row) => ({
    id: Number(row.id),
    code: String(row.code || ""),
    name: String(row.name || ""),
    branchNames: branchNamesByAccount.get(Number(row.id)) || [],
  }));
};

const getAssignableAccountsForUser = async ({ db = knex, userId }) => {
  const resolvedUserId = toPositiveInt(userId);
  if (!resolvedUserId) return [];
  return getAssignableAccounts({ db });
};

const getAssignableAccountsForRole = async ({ db = knex, roleId }) => {
  const resolvedRoleId = toPositiveInt(roleId);
  if (!resolvedRoleId) return [];
  return getAssignableAccounts({ db });
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

  return rows.map((row) => {
    const canViewSummary = Boolean(row.can_view_summary);
    const canViewDetails = Boolean(row.can_view_details);
    return {
      accountId: Number(row.account_id),
      code: String(row.code || ""),
      name: String(row.name || ""),
      canViewSummary,
      canViewDetails,
      level: flagsToLevel(canViewSummary, canViewDetails),
      branchNames: branchNamesByAccount.get(Number(row.account_id)) || [],
    };
  });
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

const getRoleAccountAccessRows = async ({ db = knex, roleId }) => {
  const resolvedRoleId = toPositiveInt(roleId);
  if (!resolvedRoleId) return [];
  if (!(await hasRoleAccountAccessTable(db))) return [];

  const rows = await db("erp.role_account_access as raa")
    .join("erp.accounts as a", "a.id", "raa.account_id")
    .select(
      "raa.account_id",
      "raa.can_view_summary",
      "raa.can_view_details",
      "a.code",
      "a.name",
    )
    .where({ "raa.role_id": resolvedRoleId })
    .andWhere(function whereRestrictedRows() {
      this.where("raa.can_view_summary", false).orWhere(
        "raa.can_view_details",
        false,
      );
    })
    .orderBy("a.name", "asc");

  const branchNamesByAccount = await getAccountBranchNames({
    db,
    accountIds: rows.map((row) => row.account_id),
    branchIds: [],
  });

  return rows.map((row) => {
    const canViewSummary = Boolean(row.can_view_summary);
    const canViewDetails = Boolean(row.can_view_details);
    return {
      accountId: Number(row.account_id),
      code: String(row.code || ""),
      name: String(row.name || ""),
      canViewSummary,
      canViewDetails,
      level: flagsToLevel(canViewSummary, canViewDetails),
      branchNames: branchNamesByAccount.get(Number(row.account_id)) || [],
    };
  });
};

const upsertRoleAccountAccessRows = async ({
  db = knex,
  roleId,
  actorUserId,
  rows = [],
}) => {
  const resolvedRoleId = toPositiveInt(roleId);
  if (!resolvedRoleId) return { upserted: 0, deleted: 0 };
  if (!(await hasRoleAccountAccessTable(db)))
    return { upserted: 0, deleted: 0 };

  const assignable = await getAssignableAccountsForRole({
    db,
    roleId: resolvedRoleId,
  });
  const assignableIds = new Set(assignable.map((row) => Number(row.id)));

  const normalizedMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((entry) => {
    const accountId = toPositiveInt(entry.accountId);
    if (!accountId || !assignableIds.has(accountId)) return;
    const normalizedFlags = normalizeAccessFlags(entry);
    // A role baseline only ever restricts. "Full access" at the role level is the
    // absence of a row, so drop any explicit allow rows here.
    if (normalizedFlags.canViewSummary && normalizedFlags.canViewDetails) return;
    normalizedMap.set(accountId, {
      accountId,
      ...normalizedFlags,
    });
  });

  const targetIds = Array.from(normalizedMap.keys());

  let deleted = 0;
  if (targetIds.length) {
    deleted = await db("erp.role_account_access")
      .where({ role_id: resolvedRoleId })
      .whereNotIn("account_id", targetIds)
      .del();
  } else {
    deleted = await db("erp.role_account_access")
      .where({ role_id: resolvedRoleId })
      .del();
    return { upserted: 0, deleted: Number(deleted || 0) };
  }

  const payload = targetIds.map((accountId) => {
    const row = normalizedMap.get(accountId);
    return {
      role_id: resolvedRoleId,
      account_id: accountId,
      can_view_summary: row.canViewSummary,
      can_view_details: row.canViewDetails,
      created_by: toPositiveInt(actorUserId),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };
  });

  await db("erp.role_account_access")
    .insert(payload)
    .onConflict(["role_id", "account_id"])
    .merge({
      can_view_summary: db.raw("EXCLUDED.can_view_summary"),
      can_view_details: db.raw("EXCLUDED.can_view_details"),
      updated_at: db.fn.now(),
    });

  return { upserted: payload.length, deleted: Number(deleted || 0) };
};

const getRoleAccountAccessMap = async ({ db = knex, roleId }) => {
  const resolvedRoleId = toPositiveInt(roleId);
  const accessMap = new Map();
  if (!resolvedRoleId) return accessMap;
  if (!(await hasRoleAccountAccessTable(db))) return accessMap;

  const rows = await db("erp.role_account_access")
    .select("account_id", "can_view_summary", "can_view_details")
    .where({ role_id: resolvedRoleId })
    .andWhere(function whereRestrictedRows() {
      this.where("can_view_summary", false).orWhere("can_view_details", false);
    });

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

// Effective restriction for a user = the user's primary role baseline, overlaid by
// the user's own overrides. A user override on an account fully replaces the role's
// setting for that account (it can tighten, loosen, or lift the restriction). An
// explicit "allow" override (full access) lifts a role restriction entirely.
const getUserAccountAccessMap = async ({ db = knex, userId }) => {
  const resolvedUserId = toPositiveInt(userId);
  const accessMap = new Map();
  if (!resolvedUserId) return accessMap;

  const userRow = await db("erp.users")
    .select("primary_role_id")
    .where({ id: resolvedUserId })
    .first();
  const roleId = toPositiveInt(userRow?.primary_role_id);
  if (roleId) {
    const roleMap = await getRoleAccountAccessMap({ db, roleId });
    roleMap.forEach((value, accountId) => accessMap.set(accountId, value));
  }

  if (!(await hasUserAccountAccessTable(db))) return accessMap;

  const rows = await db("erp.user_account_access")
    .select("account_id", "can_view_summary", "can_view_details")
    .where({ user_id: resolvedUserId });

  rows.forEach((row) => {
    const accountId = toPositiveInt(row.account_id);
    if (!accountId) return;
    const canViewSummary = Boolean(row.can_view_summary);
    const canViewDetails = Boolean(row.can_view_details);
    if (canViewSummary && canViewDetails) {
      // Explicit user allow-override: lift any inherited role restriction.
      accessMap.delete(accountId);
    } else {
      accessMap.set(accountId, { canViewSummary, canViewDetails });
    }
  });

  return accessMap;
};

const filterAccountsByAccess = ({ accounts = [], accessMap = new Map() }) => {
  if (!(accessMap instanceof Map) || accessMap.size === 0) return accounts;
  return accounts.filter((row) => {
    const restriction = accessMap.get(Number(row.id));
    if (!restriction) return true;
    return Boolean(restriction.canViewSummary);
  });
};

const canUserViewAccountDetails = ({ accessMap = new Map(), accountId }) => {
  const resolvedId = toPositiveInt(accountId);
  if (!resolvedId) return false;
  const row = accessMap.get(resolvedId);
  if (!row) return true;
  return Boolean(row.canViewSummary && row.canViewDetails);
};

module.exports = {
  getAssignableAccountsForUser,
  getAssignableAccountsForRole,
  getUserAccountAccessRows,
  upsertUserAccountAccessRows,
  getUserAccountAccessMap,
  getRoleAccountAccessRows,
  upsertRoleAccountAccessRows,
  getRoleAccountAccessMap,
  filterAccountsByAccess,
  canUserViewAccountDetails,
  hasUserAccountAccessTable,
  hasRoleAccountAccessTable,
};
