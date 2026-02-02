const crypto = require("crypto");
const bcrypt = require("bcrypt");
const knex = require("../../db/knex");
const { navConfig } = require("../../utils/nav-config");
const { HttpError } = require("../errors/http-error");
const { parseCookies, setCookie } = require("../utils/cookies");

const PUBLIC_PATHS = ["/auth/login", "/auth/logout", "/health"];
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "erp_session";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
};

const verifyPassword = (password, stored) => {
  if (!stored) return false;

  if (stored.startsWith("$2a$") || stored.startsWith("$2b$") || stored.startsWith("$2y$")) {
    return bcrypt.compareSync(password, stored);
  }

  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
};

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const legacyScopeMap = {
  "administration.branches": "setup:branches",
  "administration.users": "setup:users",
  "administration.roles": "setup:roles",
};

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

const createSession = async ({ userId, ipAddress, userAgent }) => {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  const [row] = await knex("erp.user_sessions")
    .insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
    })
    .returning(["id", "user_id", "last_seen_at", "expires_at"]);

  return { token, session: row, tokenHash };
};

const revokeSession = async (tokenHash) => {
  if (!tokenHash) return;
  await knex("erp.user_sessions").where({ token_hash: tokenHash }).update({ is_revoked: true, revoked_at: knex.fn.now() });
};

const loadUserContext = async (userId) => {
  const user = await knex("erp.users").select("id", "username", "status", "primary_role_id").where({ id: userId }).first();

  if (!user) {
    throw new HttpError(401, "Invalid session");
  }

  if (user.status && user.status.toLowerCase() !== "active") {
    throw new HttpError(403, "User inactive");
  }

  const role = await knex("erp.role_templates").select("id", "name").where({ id: user.primary_role_id }).first();
  const branchRows = await knex("erp.user_branch").select("branch_id").where({ user_id: userId });
  const branchIds = branchRows.map((row) => Number(row.branch_id));

  const rolePermissionRows = await knex("erp.role_permissions")
    .join("erp.permission_scope_registry", "erp.permission_scope_registry.id", "erp.role_permissions.scope_id")
    .select(
      "erp.role_permissions.scope_id",
      "erp.permission_scope_registry.scope_type",
      "erp.permission_scope_registry.scope_key",
      "erp.role_permissions.can_navigate",
      "erp.role_permissions.can_view",
      "erp.role_permissions.can_create",
      "erp.role_permissions.can_edit",
      "erp.role_permissions.can_delete",
      "erp.role_permissions.can_hard_delete",
      "erp.role_permissions.can_print",
      "erp.role_permissions.can_approve"
    )
    .where({ role_id: user.primary_role_id });

  const overrideRows = await knex("erp.user_permissions_override")
    .select("scope_id", "can_navigate", "can_view", "can_create", "can_edit", "can_delete", "can_hard_delete", "can_print", "can_approve")
    .where({ user_id: userId });

  const overridesByScope = overrideRows.reduce((acc, row) => {
    acc[row.scope_id] = row;
    return acc;
  }, {});

  const roleScopeIds = new Set(rolePermissionRows.map((row) => row.scope_id));
  const overrideOnlyScopeIds = overrideRows.map((row) => row.scope_id).filter((id) => !roleScopeIds.has(id));

  let overrideOnlyScopes = [];
  if (overrideOnlyScopeIds.length) {
    overrideOnlyScopes = await knex("erp.permission_scope_registry").select("id", "scope_type", "scope_key").whereIn("id", overrideOnlyScopeIds);
  }

  const basePermissions = {
    can_navigate: false,
    can_view: false,
    can_create: false,
    can_edit: false,
    can_delete: false,
    can_hard_delete: false,
    can_print: false,
    can_approve: false,
  };

  const mergePermissions = (roleRow, overrideRow) => ({
    can_navigate: overrideRow?.can_navigate ?? roleRow?.can_navigate ?? basePermissions.can_navigate,
    can_view: overrideRow?.can_view ?? roleRow?.can_view ?? basePermissions.can_view,
    can_create: overrideRow?.can_create ?? roleRow?.can_create ?? basePermissions.can_create,
    can_edit: overrideRow?.can_edit ?? roleRow?.can_edit ?? basePermissions.can_edit,
    can_delete: overrideRow?.can_delete ?? roleRow?.can_delete ?? basePermissions.can_delete,
    can_hard_delete: overrideRow?.can_hard_delete ?? roleRow?.can_hard_delete ?? basePermissions.can_hard_delete,
    can_print: overrideRow?.can_print ?? roleRow?.can_print ?? basePermissions.can_print,
    can_approve: overrideRow?.can_approve ?? roleRow?.can_approve ?? basePermissions.can_approve,
  });

  const permissions = rolePermissionRows.reduce((acc, row) => {
    const override = overridesByScope[row.scope_id];
    const key = `${row.scope_type}:${row.scope_key}`;
    acc[key] = mergePermissions(row, override);
    return acc;
  }, {});

  overrideOnlyScopes.forEach((scope) => {
    const override = overridesByScope[scope.id];
    const key = `${scope.scope_type}:${scope.scope_key}`;
    permissions[key] = mergePermissions(null, override);
  });

  return {
    id: user.id,
    username: user.username,
    status: user.status,
    primaryRoleId: user.primary_role_id,
    primaryRoleName: role?.name || null,
    isAdmin: String(role?.name || "").toLowerCase() === "admin",
    branchIds,
    permissions,
  };
};

const auth = async (req, res, next) => {
  // Initialize user in locals to null to prevent ReferenceError in views for public paths
  res.locals.user = null;
  res.locals.can = () => false;

  if (PUBLIC_PATHS.some((path) => req.path.startsWith(path))) {
    return next();
  }

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) {
    if (req.accepts("html")) {
      return res.redirect("/auth/login");
    }
    return next(new HttpError(401, "Authentication required"));
  }

  try {
    const tokenHash = hashToken(token);
    const session = await knex("erp.user_sessions").select("id", "user_id", "last_seen_at", "expires_at", "is_revoked").where({ token_hash: tokenHash }).first();

    if (!session || session.is_revoked) {
      throw new HttpError(401, "Invalid session");
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await revokeSession(tokenHash);
      throw new HttpError(401, "Session expired");
    }

    await knex("erp.user_sessions").where({ token_hash: tokenHash }).update({ last_seen_at: knex.fn.now() });

    req.authSession = {
      id: session.id,
      userId: session.user_id,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.expires_at,
      tokenHash,
    };

    req.user = await loadUserContext(session.user_id);

    // Fix: Make user available to all views
    res.locals.user = req.user;

    const hasRequiredAccess = (permissions, actionKey) => {
      if (!permissions || !actionKey) return false;
      if (!permissions[actionKey]) return false;
      if (actionKey === "can_navigate") return Boolean(permissions.can_view);
      if (["can_edit", "can_delete", "can_hard_delete", "can_approve", "can_print"].includes(actionKey)) {
        return Boolean(permissions.can_navigate);
      }
      return true;
    };

    res.locals.can = (scopeType, scopeKey, action) => {
      if (!req.user) return false;
      if (req.user.isAdmin) return true;
      if (!scopeType || !scopeKey || !action) return false;
      const actionKey = action.startsWith("can_") ? action : `can_${action}`;
      const scopeKeyString = `${scopeType}:${scopeKey}`;
      const direct = req.user.permissions?.[scopeKeyString];
      if (hasRequiredAccess(direct, actionKey)) return true;
      const legacyScopeKey = legacyScopeMap[scopeKey];
      if (legacyScopeKey) {
        const legacy = req.user.permissions?.[`${scopeType}:${legacyScopeKey}`];
        if (hasRequiredAccess(legacy, actionKey)) return true;
      }
      if (scopeType !== "SCREEN") {
        const inheritedModuleKey = scopeToModuleMap.get(scopeKeyString) || (scopeType === "MODULE" ? scopeKey : null);
        if (inheritedModuleKey) {
          const modulePermissions = req.user.permissions?.[`MODULE:${inheritedModuleKey}`];
          return hasRequiredAccess(modulePermissions, actionKey);
        }
      }
      return false;
    };

    next();
  } catch (err) {
    setCookie(res, SESSION_COOKIE_NAME, "", {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 0,
    });
    next(err);
  }
};

module.exports = auth;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.loadUserContext = loadUserContext;
module.exports.createSession = createSession;
module.exports.revokeSession = revokeSession;
module.exports.hashToken = hashToken;
module.exports.SESSION_COOKIE_NAME = SESSION_COOKIE_NAME;
