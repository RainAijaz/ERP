const express = require("express");
const knex = require("../../db/knex");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { navConfig } = require("../../utils/nav-config");
const { parseCookies, setCookie } = require("../../middleware/utils/cookies");
const { queueAuditLog } = require("../../utils/audit-log");
const router = express.Router();

const FLASH_COOKIE = "permissions_flash";

const clearFlash = (res, path) => {
  setCookie(res, FLASH_COOKIE, "", { path, maxAge: 0, sameSite: "Lax" });
};

const readFlash = (req, res, path) => {
  const cookies = parseCookies(req);
  if (!cookies[FLASH_COOKIE]) return null;
  let payload = null;
  try {
    payload = JSON.parse(cookies[FLASH_COOKIE]);
  } catch (err) {
    payload = null;
  }
  clearFlash(res, path);
  return payload;
};

const writeFlash = (res, path, payload) => {
  setCookie(res, FLASH_COOKIE, JSON.stringify(payload), {
    path,
    maxAge: 60,
    sameSite: "Lax",
  });
};

// -------------------------------------------------------------------------
// PERMISSION MATRIX
// -------------------------------------------------------------------------
router.get("/", requirePermission("SCREEN", "administration.permissions", "view"), async (req, res, next) => {
  try {
    const { type } = req.query; // type = 'role' or 'user'
    const isUserMode = type === "user";
    const actionKeys = ["can_navigate", "can_view", "can_create", "can_edit", "can_delete", "can_hard_delete", "can_print", "can_approve"];
    const flash = readFlash(req, res, req.baseUrl);
    const canBrowsePermissions = res.locals.can("SCREEN", "administration.permissions", "navigate");

    // 1. Determine Target ID (User or Role)
    // We do NOT default to the first user/role anymore.
    let target_id = req.query.target_id || null;

    let targetName = "";

    // Only fetch details if a target is actually selected
    if (target_id) {
      if (isUserMode) {
        const u = await knex("erp.users").where({ id: target_id }).first();
        if (u) targetName = u.username;
      } else {
        const r = await knex("erp.role_templates").where({ id: target_id }).first();
        if (r) targetName = r.name;
        if (r && String(r.name || "").toLowerCase() === "admin") {
          writeFlash(res, req.baseUrl, {
            type: "error",
            message: "Admin role permissions cannot be modified.",
          });
          return res.redirect("/administration/permissions?type=role");
        }
      }
    }

    // Fetch lists for the dropdowns
    const roles = (await knex("erp.role_templates").select("id", "name").orderBy("name")).filter((role) => String(role.name || "").toLowerCase() !== "admin");
    const users = await knex("erp.users").select("id", "username").orderBy("username");

    // 2. Fetch All Scopes
    const allScopes = await knex("erp.permission_scope_registry").orderBy("module_group", "asc").orderBy("scope_type", "asc").orderBy("description", "asc");

    const legacyScopeMap = {
      "setup:branches": "administration.branches",
      "setup:users": "administration.users",
      "setup:roles": "administration.roles",
    };

    const scopeKeySet = new Set(allScopes.map((scope) => `${scope.scope_type}:${scope.scope_key}`));
    const filteredScopes = allScopes.filter((scope) => {
      if (scope.scope_type !== "SCREEN") return true;
      const mapped = legacyScopeMap[scope.scope_key];
      if (!mapped) return true;
      return !scopeKeySet.has(`SCREEN:${mapped}`) ? true : false;
    });

    // 3. Fetch Existing Permissions (Only if target_id is present)
    let permissionsMap = {};
    let basePermissionsMap = {};
    let overridePermissionsMap = {};

    if (target_id && canBrowsePermissions) {
      if (isUserMode) {
        const userRow = await knex("erp.users").select("primary_role_id").where({ id: target_id }).first();
        const roleId = userRow?.primary_role_id;
        const roleRows = roleId ? await knex("erp.role_permissions").where({ role_id: roleId }) : [];
        const rawPerms = await knex("erp.user_permissions_override").where({ user_id: target_id });

        basePermissionsMap = roleRows.reduce((acc, p) => {
          acc[p.scope_id] = p;
          return acc;
        }, {});

        overridePermissionsMap = rawPerms.reduce((acc, p) => {
          acc[p.scope_id] = p;
          return acc;
        }, {});

        const staleScopeIds = Object.entries(overridePermissionsMap)
          .filter(([scopeId, overrideRow]) => {
            const baseRow = basePermissionsMap[scopeId] || {};
            return actionKeys.every((action) => {
              const overrideValue = overrideRow[action];
              if (overrideValue === null || overrideValue === undefined) return true;
              const baseValue = Boolean(baseRow[action]);
              return Boolean(overrideValue) === baseValue;
            });
          })
          .map(([scopeId]) => scopeId);

        if (staleScopeIds.length > 0) {
          await knex("erp.user_permissions_override").where({ user_id: target_id }).whereIn("scope_id", staleScopeIds).del();
          staleScopeIds.forEach((scopeId) => {
            delete overridePermissionsMap[scopeId];
          });
        }

        const scopeIds = new Set([...Object.keys(basePermissionsMap), ...Object.keys(overridePermissionsMap)]);
        scopeIds.forEach((scopeId) => {
          const baseRow = basePermissionsMap[scopeId] || {};
          const overrideRow = overridePermissionsMap[scopeId] || {};
          const effective = {};
          actionKeys.forEach((action) => {
            const baseValue = Boolean(baseRow[action]);
            const overrideValue = overrideRow[action];
            if (overrideValue === null || overrideValue === undefined) {
              effective[action] = baseValue;
            } else {
              effective[action] = Boolean(overrideValue);
            }
          });
          permissionsMap[scopeId] = effective;
        });
      } else {
        const rawPerms = await knex("erp.role_permissions").where({ role_id: target_id });
        permissionsMap = rawPerms.reduce((acc, p) => {
          acc[p.scope_id] = p;
          return acc;
        }, {});
      }

      if (target_id && canBrowsePermissions && !isUserMode) {
        basePermissionsMap = {};
        overridePermissionsMap = {};
      }
    }

    // 4. Structure Data for View (nav-driven)
    const scopeByKey = new Map(filteredScopes.map((scope) => [`${scope.scope_type}:${scope.scope_key}`, scope]));

    const navRows = [];
    const walk = (nodes, parentPath = "", depth = 0) => {
      nodes.forEach((node) => {
        const path = parentPath ? `${parentPath}.${node.key}` : node.key;
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        const scope = node.scopeType && node.scopeKey ? scopeByKey.get(`${node.scopeType}:${node.scopeKey}`) : null;
        navRows.push({
          key: node.key,
          path,
          parentPath: parentPath || null,
          depth,
          hasChildren,
          scopeType: node.scopeType || null,
          scopeKey: node.scopeKey || null,
          description: node.labelKey,
          moduleGroup: node.moduleGroup || null,
          scopeId: scope ? scope.id : null,
          rights: scope ? permissionsMap[scope.id] || {} : {},
          baseRights: scope ? basePermissionsMap[scope.id] || {} : {},
          overrideRights: scope ? overridePermissionsMap[scope.id] || {} : {},
          missing: !!(node.scopeType && node.scopeKey && !scope),
        });
        if (hasChildren) {
          walk(node.children, path, depth + 1);
        }
      });
    };

    walk(navConfig);

    res.render("base/layouts/main", {
      view: "../../administration/permissions/index",
      title: res.locals.t("manage_permissions"),
      roles,
      users,
      navRows,
      target_id: target_id || "", // Ensure empty string if null
      targetId: target_id || "", // Backwards compatibility for view if needed
      isUserMode,
      flash,
      modalOpen: false,
      modalMode: null,
      modalValues: null,
      permissions: target_id && canBrowsePermissions ? permissionsMap : {}, // Send empty object if no target or no browse access
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// UPDATE PERMISSIONS
// -------------------------------------------------------------------------
router.post("/update", requirePermission("SCREEN", "administration.permissions", "edit"), async (req, res, next) => {
  const trx = await knex.transaction();
  let committed = false;
  let lockoutGuarded = false;
  try {
    const { target_id, type, ...rights } = req.body;
    const isUserMode = type === "user";

    if (!target_id) throw new Error("Target ID is required");

    if (!isUserMode) {
      const roleRow = await trx("erp.role_templates").select("name").where({ id: target_id }).first();
      if (roleRow && String(roleRow.name || "").toLowerCase() === "admin") {
        writeFlash(res, req.baseUrl, {
          type: "error",
          message: "Admin role permissions cannot be modified.",
        });
        return res.redirect("/administration/permissions?type=role");
      }
    }

    const actionKeys = ["can_navigate", "can_view", "can_create", "can_edit", "can_delete", "can_hard_delete", "can_print", "can_approve"];

    const normalizeValue = (value) => {
      const raw = Array.isArray(value) ? value[value.length - 1] : value;
      if (raw === undefined || raw === null) return false;
      if (typeof raw === "string") {
        const lowered = raw.toLowerCase();
        if (["true", "on", "1", "yes"].includes(lowered)) return true;
        if (["false", "0", "no"].includes(lowered)) return false;
      }
      return Boolean(raw);
    };

    // 1. Clear existing permissions for this target
    if (isUserMode) {
      await trx("erp.user_permissions_override").where({ user_id: target_id }).del();
    } else {
      await trx("erp.role_permissions").where({ role_id: target_id }).del();
    }

    // 2. Process Form Data
    // Form sends checkboxes as: "scopeId:action" = "on"
    const insertMap = {};

    Object.keys(rights).forEach((key) => {
      if (!key.includes(":")) return;
      const [scopeId, action] = key.split(":");
      if (!actionKeys.includes(action)) return;

      const value = normalizeValue(rights[key]);

      if (!insertMap[scopeId]) {
        insertMap[scopeId] = isUserMode ? { user_id: target_id, scope_id: scopeId } : { role_id: target_id, scope_id: scopeId };
      }

      if (isUserMode) {
        insertMap[scopeId][action] = value;
      } else if (value) {
        insertMap[scopeId][action] = true;
      }
    });

    const requireNavigate = ["can_edit", "can_delete", "can_hard_delete", "can_approve", "can_print"];
    const requireView = ["can_navigate", "can_create", "can_edit", "can_delete", "can_hard_delete", "can_approve", "can_print"];

    Object.values(insertMap).forEach((permRow) => {
      // Check if any "advanced" action is true
      const needsNavigate = requireNavigate.some((act) => permRow[act] === true);
      const needsView = requireView.some((act) => permRow[act] === true);

      if (needsNavigate) {
        permRow["can_navigate"] = true;
        permRow["can_view"] = true; // Navigate implies View usually
      }
      if (needsView) {
        permRow["can_view"] = true;
      }
    });

    if (!isUserMode && req.user?.primaryRoleId && String(req.user.primaryRoleId) === String(target_id)) {
      const scopeRow = await trx("erp.permission_scope_registry").select("id").where({ scope_type: "SCREEN", scope_key: "administration.permissions" }).first();

      if (scopeRow?.id) {
        const scopeId = String(scopeRow.id);
        const existing = insertMap[scopeId] || { role_id: target_id, scope_id: scopeId };
        const hasNavigate = existing.can_navigate === true;
        const hasView = existing.can_view === true;
        if (!hasNavigate || !hasView) {
          lockoutGuarded = true;
          existing.can_view = true;
          existing.can_navigate = true;
          insertMap[scopeId] = existing;
        }
      }
    }

    if (isUserMode && Object.keys(insertMap).length > 0) {
      const userRow = await trx("erp.users").select("primary_role_id").where({ id: target_id }).first();
      const roleId = userRow?.primary_role_id;
      const roleRows = roleId
        ? await trx("erp.role_permissions")
            .select("scope_id", ...actionKeys)
            .where({ role_id: roleId })
        : [];

      const roleByScope = roleRows.reduce((acc, row) => {
        acc[row.scope_id] = row;
        return acc;
      }, {});

      Object.entries(insertMap).forEach(([scopeId, row]) => {
        const baseRow = roleByScope[scopeId] || null;
        let hasOverride = false;
        actionKeys.forEach((action) => {
          const baseValue = baseRow ? Boolean(baseRow[action]) : false;
          if (row[action] === baseValue) {
            row[action] = null;
          } else {
            hasOverride = true;
          }
        });
        if (!hasOverride) {
          delete insertMap[scopeId];
        }
      });
    }

    // 3. Bulk Insert
    const inserts = Object.values(insertMap);
    if (inserts.length > 0) {
      const table = isUserMode ? "erp.user_permissions_override" : "erp.role_permissions";
      await trx(table).insert(inserts);
    }

    queueAuditLog(req, {
      entityType: "PERMISSION",
      entityId: `${type}:${target_id}`,
      action: "UPDATE",
    });

    await trx.commit();
    committed = true;

    // Using simple redirect as this page submits a large form, distinct from the modal pattern
    const flashMessage = lockoutGuarded ? "Permissions saved. Access to Permissions was kept to avoid locking out your session." : "Permissions saved.";
    writeFlash(res, req.baseUrl, {
      type: "success",
      message: flashMessage,
    });
    res.redirect(`/administration/permissions?type=${type}&target_id=${target_id}`);
  } catch (err) {
    if (!committed) {
      await trx.rollback();
      writeFlash(res, req.baseUrl, {
        type: "error",
        message: "Failed to save permissions.",
      });
      return res.redirect(`/administration/permissions?type=${req.body?.type || "role"}&target_id=${req.body?.target_id || ""}`);
    }
    next(err);
  }
});

module.exports = router;
