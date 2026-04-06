const { HttpError } = require("../errors/http-error");
const { navConfig } = require("../../utils/nav-config");
const { isActionApplicable } = require("../../utils/scope-action-policy");

const normalizeAction = (action) => {
  if (!action) return null;
  const key = action.toLowerCase();
  if (key === "load") return "can_load";
  if (key === "view_details") return "can_view_details";
  if (key === "export_excel_csv") return "can_export_excel_csv";
  if (key === "filter_all_branches") return "can_filter_all_branches";
  if (key === "view_cost_fields") return "can_view_cost_fields";
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
      const nextModule =
        node.scopeType === "MODULE" ? node.scopeKey : currentModule;
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

const hasRequiredAccess = (permissions, action, scopeType) => {
  if (!permissions || !action) return false;
  if (!isActionApplicable(scopeType, action)) return false;
  const allowed = Boolean(permissions[action]);
  if (!allowed) return false;
  if (action === "can_navigate") {
    return (
      isActionApplicable(scopeType, "can_view") && Boolean(permissions.can_view)
    );
  }
  if (action === "can_view_details") {
    return isActionApplicable(scopeType, "can_load") && Boolean(permissions.can_load);
  }
  if (action === "can_load") {
    return isActionApplicable(scopeType, "can_view") && Boolean(permissions.can_view);
  }
  if (
    [
      "can_edit",
      "can_delete",
      "can_hard_delete",
      "can_approve",
      "can_print",
      "can_export_excel_csv",
      "can_filter_all_branches",
      "can_view_cost_fields",
    ].includes(action)
  ) {
    if (isActionApplicable(scopeType, "can_navigate")) {
      return Boolean(permissions.can_navigate);
    }
    if (isActionApplicable(scopeType, "can_load")) {
      return Boolean(permissions.can_load);
    }
    return false;
  }
  return true;
};

const getInheritedModulePermissions = (req, required) => {
  if (!required || !required.scopeType || !required.scopeKey) return null;
  if (required.scopeType === "SCREEN") return null;
  const moduleKey =
    scopeToModuleMap.get(`${required.scopeType}:${required.scopeKey}`) ||
    getModuleKey(required.scopeKey);
  if (!moduleKey) return null;
  return req.user?.permissions?.[`MODULE:${moduleKey}`] || null;
};

const hasPermissionForRequirement = (req, required) => {
  if (!req?.user) return false;
  if (req.user.isAdmin) return true;
  if (
    !required ||
    !required.scopeType ||
    !required.scopeKey ||
    !required.action
  )
    return true;

  const key = `${required.scopeType}:${required.scopeKey}`;
  const permissions = req.user.permissions?.[key];
  if (hasRequiredAccess(permissions, required.action, required.scopeType)) {
    return true;
  }

  const legacyKey = getLegacyScopeKey(required.scopeKey);
  if (legacyKey) {
    const legacyPermissions =
      req.user.permissions?.[`${required.scopeType}:${legacyKey}`];
    if (
      hasRequiredAccess(legacyPermissions, required.action, required.scopeType)
    ) {
      return true;
    }
  }

  const inheritedModule = getInheritedModulePermissions(req, required);
  if (hasRequiredAccess(inheritedModule, required.action, required.scopeType)) {
    return true;
  }

  if (required.scopeType === "MODULE") {
    const moduleKey = getModuleKey(required.scopeKey) || required.scopeKey;
    const modulePermissions = moduleKey
      ? req.user.permissions?.[`MODULE:${moduleKey}`]
      : null;
    if (hasRequiredAccess(modulePermissions, required.action, "MODULE")) {
      return true;
    }
  }

  return false;
};

// Checks module/screen/voucher/report rights before allowing actions.
const rolePermissions = (req, res, next) => {
  if (!req.user) return next();
  if (req.path.startsWith("/auth")) return next();

  const required = resolveRequirement(req.requiredPermission);
  if (
    !required ||
    !required.scopeType ||
    !required.scopeKey ||
    !required.action
  ) {
    return next();
  }

  if (!hasPermissionForRequirement(req, required)) {
    const key = `${required.scopeType}:${required.scopeKey}`;
    const permissions = req.user.permissions?.[key];
    const legacyKey = getLegacyScopeKey(required.scopeKey);
    let legacyPermissions = null;
    if (legacyKey) {
      legacyPermissions =
        req.user.permissions?.[`${required.scopeType}:${legacyKey}`];
    }

    const inheritedModule = getInheritedModulePermissions(req, required);

    if (required.scopeType === "MODULE") {
      const moduleKey = getModuleKey(required.scopeKey) || required.scopeKey;
      const modulePermissions = moduleKey
        ? req.user.permissions?.[`MODULE:${moduleKey}`]
        : null;
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

  next();
};

const canAccessScope = (req, scopeType, scopeKey, action = "view") => {
  const required = resolveRequirement({ scopeType, scopeKey, action });
  if (
    !required ||
    !required.scopeType ||
    !required.scopeKey ||
    !required.action
  )
    return false;
  return hasPermissionForRequirement(req, required);
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
module.exports.canAccessScope = canAccessScope;
module.exports.hasPermissionForRequirement = hasPermissionForRequirement;
