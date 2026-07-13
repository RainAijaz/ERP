const knex = require("../../db/knex");

// Per-entity access restrictions for the Employee Ledger and Labour Ledger
// reports. Mirrors account-access-service.js, but keyed polymorphically by
// (entity_type, entity_id) because employees/labours have no ledger accounts.
//
// Employee/labour ledgers have no summary-vs-details split, so restrictions are
// binary: "blocked" (both flags false) or "allow" (both flags true — a user-level
// override that lifts an inherited role block). We still store two flags so the
// same merge logic as accounts applies.

let hasUserEntityAccessTablePromise = null;
let hasRoleEntityAccessTablePromise = null;

const ENTITY_TYPES = Object.freeze({
  EMPLOYEE: {
    type: "EMPLOYEE",
    table: "erp.employees",
    statusExpr: "lower(trim(coalesce(status, ''))) = 'active'",
  },
  LABOUR: {
    type: "LABOUR",
    table: "erp.labours",
    statusExpr: "lower(trim(coalesce(status, ''))) = 'active'",
  },
});

const normalizeEntityType = (value) => {
  const upper = String(value || "").trim().toUpperCase();
  return ENTITY_TYPES[upper] ? upper : null;
};

const toPositiveInt = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// blocked -> both false; allow -> both true. Summary-only is never produced for
// employee/labour ledgers, but we normalize defensively.
const flagsToLevel = (canViewSummary, canViewDetails) => {
  if (canViewSummary && canViewDetails) return "allow";
  return "blocked";
};

const normalizeAccessFlags = (row = {}) => {
  const canViewDetails = Boolean(row.canViewDetails);
  const canViewSummary = canViewDetails || Boolean(row.canViewSummary);
  return {
    canViewSummary,
    canViewDetails: canViewSummary ? canViewDetails : false,
  };
};

const hasUserEntityAccessTable = async (db = knex) => {
  if (!hasUserEntityAccessTablePromise) {
    hasUserEntityAccessTablePromise = db.schema
      .withSchema("erp")
      .hasTable("user_entity_access")
      .catch(() => false);
  }
  return hasUserEntityAccessTablePromise;
};

const hasRoleEntityAccessTable = async (db = knex) => {
  if (!hasRoleEntityAccessTablePromise) {
    hasRoleEntityAccessTablePromise = db.schema
      .withSchema("erp")
      .hasTable("role_entity_access")
      .catch(() => false);
  }
  return hasRoleEntityAccessTablePromise;
};

// All active employees/labours — every entity the ledger report can surface. No
// branch filter: the report already handles branch scoping, and hiding out-of-
// branch entities here would silently make them unrestrictable.
const getAssignableEntities = async ({ db = knex, entityType } = {}) => {
  const normalizedType = normalizeEntityType(entityType);
  if (!normalizedType) return [];
  const cfg = ENTITY_TYPES[normalizedType];

  const rows = await db(cfg.table)
    .select("id", "code", "name")
    .whereRaw(cfg.statusExpr)
    .orderBy("name", "asc");

  return rows.map((row) => ({
    entityType: normalizedType,
    id: Number(row.id),
    code: String(row.code || ""),
    name: String(row.name || ""),
    branchNames: [],
  }));
};

const mapAccessRow = (row, entityType) => {
  const canViewSummary = Boolean(row.can_view_summary);
  const canViewDetails = Boolean(row.can_view_details);
  return {
    entityType,
    entityId: Number(row.entity_id),
    accountId: Number(row.entity_id), // legacy alias for shared view helpers
    code: String(row.code || ""),
    name: String(row.name || ""),
    canViewSummary,
    canViewDetails,
    level: flagsToLevel(canViewSummary, canViewDetails),
    branchNames: [],
  };
};

const getEntityAccessRows = async ({
  db = knex,
  ownerId,
  ownerCol,
  tableName,
  hasTableFn,
  entityType,
  restrictedOnly = false,
}) => {
  const resolvedOwnerId = toPositiveInt(ownerId);
  const normalizedType = normalizeEntityType(entityType);
  if (!resolvedOwnerId || !normalizedType) return [];
  if (!(await hasTableFn(db))) return [];
  const cfg = ENTITY_TYPES[normalizedType];

  let query = db(`erp.${tableName} as ea`)
    .join(`${cfg.table} as ent`, "ent.id", "ea.entity_id")
    .select(
      "ea.entity_id",
      "ea.can_view_summary",
      "ea.can_view_details",
      "ent.code",
      "ent.name",
    )
    .where(`ea.${ownerCol}`, resolvedOwnerId)
    .andWhere("ea.entity_type", normalizedType)
    .orderBy("ent.name", "asc");

  if (restrictedOnly) {
    query = query.andWhere(function whereRestricted() {
      this.where("ea.can_view_summary", false).orWhere(
        "ea.can_view_details",
        false,
      );
    });
  }

  const rows = await query;
  return rows.map((row) => mapAccessRow(row, normalizedType));
};

const upsertEntityAccessRows = async ({
  db = knex,
  ownerId,
  ownerCol,
  tableName,
  hasTableFn,
  actorUserId,
  entityType,
  rows = [],
  dropAllowRows = false,
}) => {
  const resolvedOwnerId = toPositiveInt(ownerId);
  const normalizedType = normalizeEntityType(entityType);
  if (!resolvedOwnerId || !normalizedType) return { upserted: 0, deleted: 0 };
  if (!(await hasTableFn(db))) return { upserted: 0, deleted: 0 };

  const assignable = await getAssignableEntities({
    db,
    entityType: normalizedType,
  });
  const assignableIds = new Set(assignable.map((row) => Number(row.id)));

  const normalizedMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((entry) => {
    const entityId = toPositiveInt(entry.entityId ?? entry.accountId);
    if (!entityId || !assignableIds.has(entityId)) return;
    const flags = normalizeAccessFlags(entry);
    // A role baseline only ever restricts, so drop explicit allow rows there.
    if (dropAllowRows && flags.canViewSummary && flags.canViewDetails) return;
    normalizedMap.set(entityId, { entityId, ...flags });
  });

  const targetIds = Array.from(normalizedMap.keys());

  const baseWhere = () =>
    db(`erp.${tableName}`)
      .where(ownerCol, resolvedOwnerId)
      .andWhere("entity_type", normalizedType);

  let deleted = 0;
  if (targetIds.length) {
    deleted = await baseWhere().whereNotIn("entity_id", targetIds).del();
  } else {
    deleted = await baseWhere().del();
    return { upserted: 0, deleted: Number(deleted || 0) };
  }

  const payload = targetIds.map((entityId) => {
    const row = normalizedMap.get(entityId);
    return {
      [ownerCol]: resolvedOwnerId,
      entity_type: normalizedType,
      entity_id: entityId,
      can_view_summary: row.canViewSummary,
      can_view_details: row.canViewDetails,
      created_by: toPositiveInt(actorUserId),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };
  });

  await db(`erp.${tableName}`)
    .insert(payload)
    .onConflict([ownerCol, "entity_type", "entity_id"])
    .merge({
      can_view_summary: db.raw("EXCLUDED.can_view_summary"),
      can_view_details: db.raw("EXCLUDED.can_view_details"),
      updated_at: db.fn.now(),
    });

  return { upserted: payload.length, deleted: Number(deleted || 0) };
};

// ---- User-level ----------------------------------------------------------

const getUserEntityAccessRows = ({ db = knex, userId, entityType }) =>
  getEntityAccessRows({
    db,
    ownerId: userId,
    ownerCol: "user_id",
    tableName: "user_entity_access",
    hasTableFn: hasUserEntityAccessTable,
    entityType,
    restrictedOnly: false,
  });

const upsertUserEntityAccessRows = ({
  db = knex,
  userId,
  actorUserId,
  entityType,
  rows = [],
}) =>
  upsertEntityAccessRows({
    db,
    ownerId: userId,
    ownerCol: "user_id",
    tableName: "user_entity_access",
    hasTableFn: hasUserEntityAccessTable,
    actorUserId,
    entityType,
    rows,
    dropAllowRows: false,
  });

// ---- Role-level ----------------------------------------------------------

const getRoleEntityAccessRows = ({ db = knex, roleId, entityType }) =>
  getEntityAccessRows({
    db,
    ownerId: roleId,
    ownerCol: "role_id",
    tableName: "role_entity_access",
    hasTableFn: hasRoleEntityAccessTable,
    entityType,
    restrictedOnly: true,
  });

const upsertRoleEntityAccessRows = ({
  db = knex,
  roleId,
  actorUserId,
  entityType,
  rows = [],
}) =>
  upsertEntityAccessRows({
    db,
    ownerId: roleId,
    ownerCol: "role_id",
    tableName: "role_entity_access",
    hasTableFn: hasRoleEntityAccessTable,
    actorUserId,
    entityType,
    rows,
    dropAllowRows: true,
  });

// ---- Enforcement ---------------------------------------------------------

const getRoleEntityBlockedSet = async ({ db = knex, roleId, entityType }) => {
  const blocked = new Set();
  const resolvedRoleId = toPositiveInt(roleId);
  const normalizedType = normalizeEntityType(entityType);
  if (!resolvedRoleId || !normalizedType) return blocked;
  if (!(await hasRoleEntityAccessTable(db))) return blocked;

  const rows = await db("erp.role_entity_access")
    .select("entity_id", "can_view_summary", "can_view_details")
    .where({ role_id: resolvedRoleId, entity_type: normalizedType })
    .andWhere(function whereRestricted() {
      this.where("can_view_summary", false).orWhere("can_view_details", false);
    });

  rows.forEach((row) => {
    const entityId = toPositiveInt(row.entity_id);
    if (entityId) blocked.add(entityId);
  });
  return blocked;
};

// Effective blocked set for a user = the user's primary-role baseline, overlaid
// by the user's own rows. A user "allow" row (both flags true) lifts a role
// block; any other user row restricts.
const getUserEntityBlockedSet = async ({ db = knex, userId, entityType }) => {
  const blocked = new Set();
  const resolvedUserId = toPositiveInt(userId);
  const normalizedType = normalizeEntityType(entityType);
  if (!resolvedUserId || !normalizedType) return blocked;

  const userRow = await db("erp.users")
    .select("primary_role_id")
    .where({ id: resolvedUserId })
    .first();
  const roleId = toPositiveInt(userRow?.primary_role_id);
  if (roleId) {
    const roleBlocked = await getRoleEntityBlockedSet({
      db,
      roleId,
      entityType: normalizedType,
    });
    roleBlocked.forEach((id) => blocked.add(id));
  }

  if (!(await hasUserEntityAccessTable(db))) return blocked;

  const rows = await db("erp.user_entity_access")
    .select("entity_id", "can_view_summary", "can_view_details")
    .where({ user_id: resolvedUserId, entity_type: normalizedType });

  rows.forEach((row) => {
    const entityId = toPositiveInt(row.entity_id);
    if (!entityId) return;
    if (Boolean(row.can_view_summary) && Boolean(row.can_view_details)) {
      blocked.delete(entityId); // explicit allow-override lifts a role block
    } else {
      blocked.add(entityId);
    }
  });

  return blocked;
};

module.exports = {
  getAssignableEntities,
  getUserEntityAccessRows,
  upsertUserEntityAccessRows,
  getRoleEntityAccessRows,
  upsertRoleEntityAccessRows,
  getRoleEntityBlockedSet,
  getUserEntityBlockedSet,
  hasUserEntityAccessTable,
  hasRoleEntityAccessTable,
  normalizeEntityType,
};
