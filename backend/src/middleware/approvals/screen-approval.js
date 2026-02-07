const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");
const { navConfig } = require("../../utils/nav-config");
const { setCookie } = require("../utils/cookies");
const { UI_NOTICE_COOKIE } = require("../core/ui-notice");

const actionToPermission = (action) => (action && action.startsWith("can_") ? action : `can_${action}`);

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

const hasRequiredAccess = (permissions, actionKey) => {
  if (!permissions || !actionKey) return false;
  if (!permissions[actionKey]) return false;
  if (actionKey === "can_navigate") return Boolean(permissions.can_view);
  if (["can_edit", "can_delete", "can_hard_delete", "can_approve", "can_print"].includes(actionKey)) {
    return Boolean(permissions.can_navigate);
  }
  return true;
};

const hasPermission = (user, scopeKey, action) => {
  if (!user) return false;
  if (user.isAdmin) return true;
  const actionKey = actionToPermission(action);
  const permKey = `SCREEN:${scopeKey}`;
  const direct = user.permissions?.[permKey];
  if (hasRequiredAccess(direct, actionKey)) return true;

  const legacyScopeKey = legacyScopeMap[scopeKey];
  if (legacyScopeKey) {
    const legacy = user.permissions?.[`SCREEN:${legacyScopeKey}`];
    if (hasRequiredAccess(legacy, actionKey)) return true;
  }

  const inheritedModule = scopeToModuleMap.get(permKey);
  if (inheritedModule) {
    const modulePerm = user.permissions?.[`MODULE:${inheritedModule}`];
    if (hasRequiredAccess(modulePerm, actionKey)) return true;
  }

  return false;
};

const requiresApproval = async (scopeKey, action) => {
  try {
    const row = await knex("erp.approval_policy").select("requires_approval").where({ entity_type: "SCREEN", entity_key: scopeKey, action }).first();
    return row?.requires_approval === true;
  } catch (err) {
    console.error("[screen-approval] policy lookup failed", { scopeKey, action, error: err.message });
    throw err;
  }
};

const queueApproval = async ({ req, entityType, entityId, summary, oldValue, newValue }) => {
  try {
    const [created] = await knex("erp.approval_request")
      .insert({
        branch_id: req.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: entityType,
        entity_id: String(entityId || "NEW"),
        summary: summary || null,
        old_value: oldValue || null,
        new_value: newValue || null,
        requested_by: req.user?.id || null,
      })
      .returning(["id"]);
    return created?.id || null;
  } catch (err) {
    console.error("[screen-approval] enqueue failed", { entityType, entityId, error: err.message });
    throw err;
  }
};

const handleScreenApproval = async ({ req, scopeKey, action, entityType, entityId, summary, oldValue, newValue, t }) => {
  // --- DEBUG LOGGING START ---
  try {
    console.log("[screen-approval] handleScreenApproval called", {
      user: req.user && { id: req.user.id, username: req.user.username, isAdmin: req.user.isAdmin },
      scopeKey,
      action,
      entityType,
      entityId,
      summary,
      oldValue,
      newValue,
      path: req.path,
      method: req.method,
    });
  } catch (e) {}
  if (req.user?.isAdmin) {
    console.log("[screen-approval] user is admin, bypassing approval queue");
    return { queued: false };
  }
  const allowed = hasPermission(req.user, scopeKey, action);
  console.log("[screen-approval] hasPermission result", { allowed });
  let approvalRequired;
  try {
    approvalRequired = await requiresApproval(scopeKey, action);
    console.log("[screen-approval] requiresApproval result", { approvalRequired });
  } catch (err) {
    console.error("[screen-approval] requiresApproval threw error", err);
    throw err;
  }

  if (!allowed && !approvalRequired) {
    console.log("[screen-approval] neither allowed nor approval required, throwing 403");
    throw new HttpError(403, t("permission_denied"));
  }

  if (approvalRequired) {
    let requestId = null;
    try {
      requestId = await queueApproval({ req, entityType, entityId, summary, oldValue, newValue });
      console.log("[screen-approval] approval queued", { requestId });
    } catch (err) {
      console.error("[screen-approval] queueApproval threw error", err);
      throw err;
    }
    const res = req.res;
    const translator = typeof t === "function" ? t : res?.locals?.t;
    if (res && typeof translator === "function") {
      if (process.env.DEBUG_UI_NOTICE === "1") {
        console.log("[UI NOTICE] set from screen-approval", {
          path: req.path,
          scopeKey,
          action,
          entityType,
          entityId,
        });
      }
      setCookie(
        res,
        UI_NOTICE_COOKIE,
        JSON.stringify({
          message: translator("approval_sent") || translator("approval_submitted") || "Change request sent for approval. It will be applied once reviewed.",
          autoClose: true,
        }),
        { path: "/", maxAge: 30, sameSite: "Lax" },
      );
    }
    return { queued: true, requestId };
  }

  console.log("[screen-approval] approval not required, proceeding without queue");
  return { queued: false };
};

module.exports = {
  handleScreenApproval,
  hasPermission,
  requiresApproval,
};
