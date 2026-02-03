const { HttpError } = require("../errors/http-error");
const { navConfig } = require("../../utils/nav-config");

const normalizeAction = (action) => {
  if (!action) return null;
  const key = action.toLowerCase();
  if (key.startsWith("can_")) return key;
  return `can_${key}`;
};

const resolveRequirement = (required) => {
  if (!required) return null;
  if (typeof required === "string") {
    const [scopeType, scopeKey, action] = required.split(":");
    return { scopeType, scopeKey, action: normalizeAction(action) };
  }
  return {
    scopeType: required.scopeType,
    scopeKey: required.scopeKey,
    action: normalizeAction(required.action),
  };
};

const getModuleKey = (scopeKey) => {
  if (!scopeKey || typeof scopeKey !== "string") return null;
  const [moduleKey] = scopeKey.split(".");
  return moduleKey || null;
};

const legacyScopeMap = {
  "administration.branches": "setup:branches",
  "administration.users": "setup:users",
  "administration.roles": "setup:roles",
};

const getLegacyScopeKey = (scopeKey) => legacyScopeMap[scopeKey] || null;

const buildScopeToModuleMap = () => {
  const map = new Map();
  const walk = (nodes, currentModule = null) => {
    nodes.forEach((node) => {
      const nextModule = node.scopeType === "MODULE" ? node.scopeKey : currentModule;
      if (node.scopeType && node.scopeKey && nextModule) {
        map.set(`${node.scopeType}:${node.scopeKey}`, nextModule);
      }
      if (node.children && node.children.length) {
        walk(node.children, nextModule);
      }
    });
  };
  walk(navConfig);
  return map;
};

const scopeToModuleMap = buildScopeToModuleMap();

const hasRequiredAccess = (permissions, action) => {
  if (!permissions || !action) return false;
  const allowed = Boolean(permissions[action]);
  if (!allowed) return false;
  if (action === "can_navigate") {
    return Boolean(permissions.can_view);
  }
  if (["can_edit", "can_delete", "can_hard_delete", "can_approve", "can_print"].includes(action)) {
    return Boolean(permissions.can_navigate);
  }
  return true;
};

const getInheritedModulePermissions = (req, required) => {
  if (!required || !required.scopeType || !required.scopeKey) return null;
  if (required.scopeType === "SCREEN") return null;
  const moduleKey = scopeToModuleMap.get(`${required.scopeType}:${required.scopeKey}`) || getModuleKey(required.scopeKey);
  if (!moduleKey) return null;
  return req.user?.permissions?.[`MODULE:${moduleKey}`] || null;
};

// Checks module/screen/voucher/report rights before allowing actions.
const rolePermissions = (req, res, next) => {
  if (!req.user) return next();
  if (req.path.startsWith("/auth")) return next();

  const required = resolveRequirement(req.requiredPermission);
  if (!required || !required.scopeType || !required.scopeKey || !required.action) {
    return next();
  }

  if (req.user.isAdmin) return next();

  const key = `${required.scopeType}:${required.scopeKey}`;
  const permissions = req.user.permissions?.[key];
  if (!hasRequiredAccess(permissions, required.action)) {
    const legacyKey = getLegacyScopeKey(required.scopeKey);
    let legacyPermissions = null;
    if (legacyKey) {
      legacyPermissions = req.user.permissions?.[`${required.scopeType}:${legacyKey}`];
      if (hasRequiredAccess(legacyPermissions, required.action)) return next();
    }

    const inheritedModule = getInheritedModulePermissions(req, required);
    if (hasRequiredAccess(inheritedModule, required.action)) return next();

    if (required.scopeType === "MODULE") {
      const moduleKey = getModuleKey(required.scopeKey) || required.scopeKey;
      const modulePermissions = moduleKey ? req.user.permissions?.[`MODULE:${moduleKey}`] : null;
      if (!hasRequiredAccess(modulePermissions, required.action)) {
        if (process.env.DEBUG_PERMS === "1") {
          // eslint-disable-next-line no-console
          console.warn("[PERM DEBUG] deny", {
            userId: req.user?.id,
            roleId: req.user?.role_id,
            required,
            key,
            permissions,
            legacyKey,
            legacyPermissions,
            inheritedModule,
            moduleKey,
            modulePermissions,
            path: req.originalUrl,
            method: req.method,
          });
        }
        return next(new HttpError(403, "Permission denied", { required }));
      }
    } else {
      if (process.env.DEBUG_PERMS === "1") {
        // eslint-disable-next-line no-console
        console.warn("[PERM DEBUG] deny", {
          userId: req.user?.id,
          roleId: req.user?.role_id,
          required,
          key,
          permissions,
          legacyKey,
          legacyPermissions,
          inheritedModule,
          path: req.originalUrl,
          method: req.method,
        });
      }
      return next(new HttpError(403, "Permission denied", { required }));
    }
  }

  next();
};

const requirePermission =
  (scopeType, scopeKey, action = "view") =>
  (req, res, next) => {
    if (typeof scopeType === "string" && scopeType.includes(":")) {
      req.requiredPermission = scopeType;
    } else {
      req.requiredPermission = { scopeType, scopeKey, action };
    }
    return rolePermissions(req, res, next);
  };

module.exports = rolePermissions;
module.exports.requirePermission = requirePermission;
