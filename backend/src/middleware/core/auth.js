const crypto = require("crypto");
const bcrypt = require("bcrypt");
const knex = require("../../db/knex");
const { navConfig } = require("../../utils/nav-config");
const { isActionApplicable } = require("../../utils/scope-action-policy");
const { HttpError } = require("../errors/http-error");
const { parseCookies, setCookie } = require("../utils/cookies");

const PUBLIC_PATHS = ["/auth/login", "/auth/logout", "/health"];
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "erp_session";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const SESSION_TOUCH_INTERVAL_MS = Number(
  process.env.SESSION_TOUCH_INTERVAL_MS || 60000,
);
const SESSION_CACHE_TTL_MS = Number(process.env.SESSION_CACHE_TTL_MS || 15000);
const SESSION_CACHE_MAX_ENTRIES = Number(
  process.env.SESSION_CACHE_MAX_ENTRIES || 10000,
);
const USER_CONTEXT_CACHE_TTL_MS = Number(
  process.env.USER_CONTEXT_CACHE_TTL_MS || 120000,
);
const USER_CONTEXT_CACHE_MAX_ENTRIES = Number(
  process.env.USER_CONTEXT_CACHE_MAX_ENTRIES || 5000,
);
const ROLE_PERMISSIONS_CACHE_TTL_MS = Number(
  process.env.ROLE_PERMISSIONS_CACHE_TTL_MS || 300000,
);
const ROLE_PERMISSIONS_CACHE_MAX_ENTRIES = Number(
  process.env.ROLE_PERMISSIONS_CACHE_MAX_ENTRIES || 200,
);
const sessionCache = new Map();
const userContextCache = new Map();
const rolePermissionsCache = new Map();

const scryptAsync = (password, salt, keyLength) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });

const cloneSession = (session) => {
  if (!session || typeof session !== "object") return null;
  return {
    id: session.id,
    user_id: session.user_id,
    last_seen_at: session.last_seen_at,
    expires_at: session.expires_at,
    is_revoked: Boolean(session.is_revoked),
  };
};

const cloneRows = (rows = []) => rows.map((row) => ({ ...row }));

const getCachedRolePermissions = (roleId) => {
  const cacheKey = Number(roleId || 0);
  if (!cacheKey) return null;
  const cached = rolePermissionsCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    rolePermissionsCache.delete(cacheKey);
    return null;
  }
  return cloneRows(cached.rows);
};

const setCachedRolePermissions = (roleId, rows) => {
  const cacheKey = Number(roleId || 0);
  if (!cacheKey) return;
  rolePermissionsCache.set(cacheKey, {
    rows: cloneRows(rows),
    expiresAt: Date.now() + ROLE_PERMISSIONS_CACHE_TTL_MS,
  });

  if (rolePermissionsCache.size <= ROLE_PERMISSIONS_CACHE_MAX_ENTRIES) return;
  const iterator = rolePermissionsCache.keys();
  const firstKey = iterator.next()?.value;
  if (firstKey) rolePermissionsCache.delete(firstKey);
};

const loadRolePermissionRowsCached = async (roleId) => {
  const cached = getCachedRolePermissions(roleId);
  if (cached) return cached;

  const rows = await knex("erp.role_permissions")
    .join(
      "erp.permission_scope_registry",
      "erp.permission_scope_registry.id",
      "erp.role_permissions.scope_id",
    )
    .select(
      "erp.role_permissions.scope_id",
      "erp.permission_scope_registry.scope_type",
      "erp.permission_scope_registry.scope_key",
      "erp.role_permissions.can_navigate",
      "erp.role_permissions.can_view",
      "erp.role_permissions.can_load",
      "erp.role_permissions.can_view_details",
      "erp.role_permissions.can_create",
      "erp.role_permissions.can_edit",
      "erp.role_permissions.can_delete",
      "erp.role_permissions.can_hard_delete",
      "erp.role_permissions.can_print",
      "erp.role_permissions.can_export_excel_csv",
      "erp.role_permissions.can_filter_all_branches",
      "erp.role_permissions.can_view_cost_fields",
      "erp.role_permissions.can_approve",
    )
    .where({ role_id: roleId });

  setCachedRolePermissions(roleId, rows);
  return rows;
};

const getCachedSession = (tokenHash) => {
  if (!tokenHash) return null;
  const cached = sessionCache.get(tokenHash);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    sessionCache.delete(tokenHash);
    return null;
  }

  const session = cloneSession(cached.session);
  if (!session) {
    sessionCache.delete(tokenHash);
    return null;
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    sessionCache.delete(tokenHash);
    return null;
  }

  return session;
};

const setCachedSession = (tokenHash, session) => {
  if (!tokenHash || !session) return;
  sessionCache.set(tokenHash, {
    session: cloneSession(session),
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });

  if (sessionCache.size <= SESSION_CACHE_MAX_ENTRIES) return;
  const iterator = sessionCache.keys();
  const firstKey = iterator.next()?.value;
  if (firstKey) sessionCache.delete(firstKey);
};

const deleteCachedSession = (tokenHash) => {
  if (!tokenHash) return;
  sessionCache.delete(tokenHash);
};

const hashPassword = (
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) => {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
};

const verifyPassword = (password, stored) => {
  if (!stored) return false;

  if (
    stored.startsWith("$2a$") ||
    stored.startsWith("$2b$") ||
    stored.startsWith("$2y$")
  ) {
    return bcrypt.compareSync(password, stored);
  }

  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(derived, "hex"),
  );
};

const verifyPasswordAsync = async (password, stored) => {
  if (!stored) return false;

  try {
    if (
      stored.startsWith("$2a$") ||
      stored.startsWith("$2b$") ||
      stored.startsWith("$2y$")
    ) {
      return await bcrypt.compare(password, stored);
    }

    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, "hex");
    const derived = await scryptAsync(password, salt, 64);
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
  } catch (_err) {
    return false;
  }
};

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const legacyScopeMap = {
  "administration.branches": "setup:branches",
  "administration.users": "setup:users",
  "administration.roles": "setup:roles",
};

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

  setCachedSession(tokenHash, {
    ...row,
    is_revoked: false,
  });

  return { token, session: row, tokenHash };
};

const revokeSession = async (tokenHash) => {
  if (!tokenHash) return;
  deleteCachedSession(tokenHash);
  await knex("erp.user_sessions")
    .where({ token_hash: tokenHash })
    .update({ is_revoked: true, revoked_at: knex.fn.now() });
};

const cloneUserContext = (context) => {
  if (!context || typeof context !== "object") return null;
  const clonedPermissions = Object.fromEntries(
    Object.entries(context.permissions || {}).map(([key, value]) => [
      key,
      { ...(value || {}) },
    ]),
  );

  return {
    ...context,
    branchIds: Array.isArray(context.branchIds) ? [...context.branchIds] : [],
    permissions: clonedPermissions,
  };
};

const getCachedUserContext = (userId) => {
  const cacheKey = Number(userId || 0);
  if (!cacheKey) return null;
  const cached = userContextCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    userContextCache.delete(cacheKey);
    return null;
  }
  return cloneUserContext(cached.value);
};

const setCachedUserContext = (userId, context) => {
  const cacheKey = Number(userId || 0);
  if (!cacheKey || !context) return;
  userContextCache.set(cacheKey, {
    value: cloneUserContext(context),
    expiresAt: Date.now() + USER_CONTEXT_CACHE_TTL_MS,
  });

  if (userContextCache.size <= USER_CONTEXT_CACHE_MAX_ENTRIES) return;
  const iterator = userContextCache.keys();
  const firstKey = iterator.next()?.value;
  if (firstKey) userContextCache.delete(firstKey);
};

const loadUserContextCached = async (userId) => {
  const cached = getCachedUserContext(userId);
  if (cached) return cached;
  const context = await loadUserContext(userId);
  setCachedUserContext(userId, context);
  return cloneUserContext(context);
};

const loadUserContext = async (userId) => {
  const user = await knex("erp.users")
    .select("id", "name", "name_ur", "username", "status", "primary_role_id")
    .where({ id: userId })
    .first();

  if (!user) {
    throw new HttpError(401, "Invalid session");
  }

  if (user.status && user.status.toLowerCase() !== "active") {
    throw new HttpError(403, "User inactive");
  }

  const [role, branchRows, rolePermissionRows, overrideRows] =
    await Promise.all([
      knex("erp.role_templates")
        .select("id", "name")
        .where({ id: user.primary_role_id })
        .first(),
      knex("erp.user_branch").select("branch_id").where({ user_id: userId }),
      loadRolePermissionRowsCached(user.primary_role_id),
      knex("erp.user_permissions_override")
        .select(
          "scope_id",
          "can_navigate",
          "can_view",
          "can_load",
          "can_view_details",
          "can_create",
          "can_edit",
          "can_delete",
          "can_hard_delete",
          "can_print",
          "can_export_excel_csv",
          "can_filter_all_branches",
          "can_view_cost_fields",
          "can_approve",
        )
        .where({ user_id: userId }),
    ]);
  const branchIds = branchRows.map((row) => Number(row.branch_id));

  const overridesByScope = overrideRows.reduce((acc, row) => {
    acc[row.scope_id] = row;
    return acc;
  }, {});

  const roleScopeIds = new Set(rolePermissionRows.map((row) => row.scope_id));
  const overrideOnlyScopeIds = overrideRows
    .map((row) => row.scope_id)
    .filter((id) => !roleScopeIds.has(id));

  let overrideOnlyScopes = [];
  if (overrideOnlyScopeIds.length) {
    overrideOnlyScopes = await knex("erp.permission_scope_registry")
      .select("id", "scope_type", "scope_key")
      .whereIn("id", overrideOnlyScopeIds);
  }

  const basePermissions = {
    can_navigate: false,
    can_view: false,
    can_load: false,
    can_view_details: false,
    can_create: false,
    can_edit: false,
    can_delete: false,
    can_hard_delete: false,
    can_print: false,
    can_export_excel_csv: false,
    can_filter_all_branches: false,
    can_view_cost_fields: false,
    can_approve: false,
  };

  const mergePermissions = (roleRow, overrideRow) => ({
    can_navigate:
      overrideRow?.can_navigate ??
      roleRow?.can_navigate ??
      basePermissions.can_navigate,
    can_view:
      overrideRow?.can_view ?? roleRow?.can_view ?? basePermissions.can_view,
    can_load:
      overrideRow?.can_load ?? roleRow?.can_load ?? basePermissions.can_load,
    can_view_details:
      overrideRow?.can_view_details ??
      roleRow?.can_view_details ??
      basePermissions.can_view_details,
    can_create:
      overrideRow?.can_create ??
      roleRow?.can_create ??
      basePermissions.can_create,
    can_edit:
      overrideRow?.can_edit ?? roleRow?.can_edit ?? basePermissions.can_edit,
    can_delete:
      overrideRow?.can_delete ??
      roleRow?.can_delete ??
      basePermissions.can_delete,
    can_hard_delete:
      overrideRow?.can_hard_delete ??
      roleRow?.can_hard_delete ??
      basePermissions.can_hard_delete,
    can_print:
      overrideRow?.can_print ?? roleRow?.can_print ?? basePermissions.can_print,
    can_export_excel_csv:
      overrideRow?.can_export_excel_csv ??
      roleRow?.can_export_excel_csv ??
      basePermissions.can_export_excel_csv,
    can_filter_all_branches:
      overrideRow?.can_filter_all_branches ??
      roleRow?.can_filter_all_branches ??
      basePermissions.can_filter_all_branches,
    can_view_cost_fields:
      overrideRow?.can_view_cost_fields ??
      roleRow?.can_view_cost_fields ??
      basePermissions.can_view_cost_fields,
    can_approve:
      overrideRow?.can_approve ??
      roleRow?.can_approve ??
      basePermissions.can_approve,
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
    name: user.name || null,
    name_ur: user.name_ur || null,
    username: user.username,
    status: user.status,
    primaryRoleId: user.primary_role_id,
    primaryRoleName: role?.name || null,
    isAdmin:
      String(role?.name || "")
        .trim()
        .toLowerCase() === "admin",
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
    let session = getCachedSession(tokenHash);
    if (!session) {
      session = await knex("erp.user_sessions")
        .select("id", "user_id", "last_seen_at", "expires_at", "is_revoked")
        .where({ token_hash: tokenHash })
        .first();
      if (session) {
        setCachedSession(tokenHash, session);
      }
    }

    if (!session || session.is_revoked) {
      deleteCachedSession(tokenHash);
      throw new HttpError(401, "Invalid session");
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      deleteCachedSession(tokenHash);
      await revokeSession(tokenHash);
      throw new HttpError(401, "Session expired");
    }

    const sessionLastSeenAtMs = new Date(session.last_seen_at).getTime();
    if (
      Number.isFinite(sessionLastSeenAtMs) &&
      Date.now() - sessionLastSeenAtMs >= SESSION_TOUCH_INTERVAL_MS
    ) {
      knex("erp.user_sessions")
        .where({ token_hash: tokenHash })
        .update({ last_seen_at: knex.fn.now() })
        .then(() => {
          setCachedSession(tokenHash, {
            ...session,
            last_seen_at: new Date(),
          });
        })
        .catch((touchErr) => {
          console.error("Session last_seen update failed", {
            session_id: session.id,
            user_id: session.user_id,
            error: touchErr?.message || touchErr,
          });
        });
    }

    req.authSession = {
      id: session.id,
      userId: session.user_id,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.expires_at,
      tokenHash,
    };

    req.user = await loadUserContextCached(session.user_id);

    // Fix: Make user available to all views
    res.locals.user = req.user;

    const hasRequiredAccess = (permissions, actionKey, scopeType) => {
      if (!permissions || !actionKey) return false;
      if (!isActionApplicable(scopeType, actionKey)) return false;
      if (!permissions[actionKey]) return false;
      if (actionKey === "can_navigate") {
        return (
          isActionApplicable(scopeType, "can_view") &&
          Boolean(permissions.can_view)
        );
      }
      if (actionKey === "can_view_details") {
        return (
          isActionApplicable(scopeType, "can_load") &&
          Boolean(permissions.can_load)
        );
      }
      if (actionKey === "can_load") {
        return (
          isActionApplicable(scopeType, "can_view") &&
          Boolean(permissions.can_view)
        );
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
        ].includes(actionKey)
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

    res.locals.can = (scopeType, scopeKey, action) => {
      if (!req.user) return false;
      if (req.user.isAdmin) return true;
      if (!scopeType || !scopeKey || !action) return false;
      const actionKey = action.startsWith("can_") ? action : `can_${action}`;
      const scopeKeyString = `${scopeType}:${scopeKey}`;
      const direct = req.user.permissions?.[scopeKeyString];
      if (hasRequiredAccess(direct, actionKey, scopeType)) return true;
      const legacyScopeKey = legacyScopeMap[scopeKey];
      if (legacyScopeKey) {
        const legacy = req.user.permissions?.[`${scopeType}:${legacyScopeKey}`];
        if (hasRequiredAccess(legacy, actionKey, scopeType)) return true;
      }
      if (scopeType !== "SCREEN") {
        const inheritedModuleKey =
          scopeToModuleMap.get(scopeKeyString) ||
          (scopeType === "MODULE" ? scopeKey : null);
        if (inheritedModuleKey) {
          const modulePermissions =
            req.user.permissions?.[`MODULE:${inheritedModuleKey}`];
          return hasRequiredAccess(
            modulePermissions,
            actionKey,
            scopeType === "MODULE" ? "MODULE" : scopeType,
          );
        }
      }
      return false;
    };

    next();
  } catch (err) {
    deleteCachedSession(hashToken(token));
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
module.exports.verifyPasswordAsync = verifyPasswordAsync;
module.exports.loadUserContext = loadUserContext;
module.exports.createSession = createSession;
module.exports.revokeSession = revokeSession;
module.exports.hashToken = hashToken;
module.exports.SESSION_COOKIE_NAME = SESSION_COOKIE_NAME;
