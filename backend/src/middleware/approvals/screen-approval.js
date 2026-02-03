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
  if (req.user?.isAdmin) {
    return { queued: false };
  }
  const allowed = hasPermission(req.user, scopeKey, action);
  const approvalRequired = await requiresApproval(scopeKey, action);

  if (!allowed && !approvalRequired) {
    throw new HttpError(403, t("permission_denied"));
  }

  if (approvalRequired) {
    const requestId = await queueApproval({ req, entityType, entityId, summary, oldValue, newValue });
    const res = req.res;
    if (res && typeof t === "function") {
      setCookie(
        res,
        UI_NOTICE_COOKIE,
        JSON.stringify({
          message: t("approval_sent") || t("approval_submitted") || "Change request sent for approval. It will be applied once reviewed.",
        }),
        { path: "/", maxAge: 30, sameSite: "Lax" },
      );
    }
    return { queued: true, requestId };
  }

  return { queued: false };
};

module.exports = {
  handleScreenApproval,
  hasPermission,
  requiresApproval,
};
