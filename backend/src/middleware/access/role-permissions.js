const { HttpError } = require("../errors/http-error");

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
  if (!permissions || !permissions[required.action]) {
    return next(new HttpError(403, "Permission denied", { required }));
  }

  next();
};

const requirePermission = (scopeType, scopeKey, action = "view") => (req, res, next) => {
  if (typeof scopeType === "string" && scopeType.includes(":")) {
    req.requiredPermission = scopeType;
  } else {
    req.requiredPermission = { scopeType, scopeKey, action };
  }
  next();
};

module.exports = rolePermissions;
module.exports.requirePermission = requirePermission;

