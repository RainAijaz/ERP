// Single source of truth for "is this role the admin role?".
//
// This used to be answered independently in six places by lowercasing the role's
// NAME and comparing it to "admin" -- and the places disagreed: auth.js accepted
// only 'admin', while approval-notifications.js accepted 'admin' or
// 'administrator'. Because req.user.isAdmin is what every permission check
// short-circuits on, renaming the role or adding a second admin role silently
// stripped the account of every bypass with no error surfaced anywhere: buttons
// simply render disabled and clicking them does nothing.
//
// erp.role_templates.is_admin (migration 20260903_000115) makes it a stored fact.
// The name comparison survives only as a fallback for a database where that
// migration has not run yet -- without it, deploying this code ahead of the
// migration would lock the admin out of the entire application.

const knex = require("../db/knex");

// What auth.js treated as admin before is_admin existed. Used ONLY when the
// column is missing.
const LEGACY_ADMIN_ROLE_NAMES = ["admin"];

// approval-notifications.js historically cast a wider net than auth.js. Kept
// separate so deploying ahead of the migration does not silently stop e-mailing
// a role named "Administrator". After the migration, is_admin governs both --
// flip the flag explicitly for any such role that is meant to be an admin.
const LEGACY_ADMIN_NOTIFY_ROLE_NAMES = ["admin", "administrator"];

let adminFlagSupported = null;

// Cached: the answer cannot change while the process is running, short of a
// migration, and this is called on every login.
const roleTemplatesHaveAdminFlag = async () => {
  if (adminFlagSupported !== null) return adminFlagSupported;
  try {
    adminFlagSupported = await knex.schema
      .withSchema("erp")
      .hasColumn("role_templates", "is_admin");
  } catch (err) {
    console.error("role_templates.is_admin probe failed", err?.message || err);
    adminFlagSupported = false;
  }
  return adminFlagSupported;
};

const matchesLegacyAdminName = (role, names) =>
  names.includes(
    String(role?.name || "")
      .trim()
      .toLowerCase(),
  );

// Pass a role_templates row. Trusts is_admin whenever the column was selected;
// falls back to the legacy name match only when it was not.
const isAdminRoleRow = (role) => {
  if (!role) return false;
  if (typeof role.is_admin === "boolean") return role.is_admin;
  return matchesLegacyAdminName(role, LEGACY_ADMIN_ROLE_NAMES);
};

// Columns to SELECT when the caller needs to answer isAdminRoleRow(). Drops
// is_admin on an un-migrated database so the query does not throw.
const adminRoleColumns = async (extra = ["id", "name"]) => {
  const columns = [...extra];
  if (await roleTemplatesHaveAdminFlag()) columns.push("is_admin");
  return columns;
};

// A raw SQL predicate for queries that filter admins in the database rather than
// in JS. `notify: true` selects the wider legacy list described above.
const adminRoleSqlPredicate = async ({
  table = "erp.role_templates",
  notify = false,
} = {}) => {
  if (await roleTemplatesHaveAdminFlag()) return `${table}.is_admin = true`;
  const names = notify
    ? LEGACY_ADMIN_NOTIFY_ROLE_NAMES
    : LEGACY_ADMIN_ROLE_NAMES;
  const quoted = names.map((name) => `'${name}'`).join(", ");
  return `lower(trim(${table}.name)) in (${quoted})`;
};

// Test seam: forces the next probe to re-read the schema.
const resetAdminFlagProbe = () => {
  adminFlagSupported = null;
};

module.exports = {
  roleTemplatesHaveAdminFlag,
  isAdminRoleRow,
  adminRoleColumns,
  adminRoleSqlPredicate,
  resetAdminFlagProbe,
  LEGACY_ADMIN_ROLE_NAMES,
  LEGACY_ADMIN_NOTIFY_ROLE_NAMES,
};
