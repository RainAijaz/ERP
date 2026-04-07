/**
 * screen-approval.js
 * ------------------
 * Middleware and utilities for handling screen-level approval workflows in the ERP system.
 *
 * - Checks user permissions for screen actions (create, update, delete, etc.) using a robust permission model.
 * - If the user lacks direct permission or if policy requires approval, serializes the intended change and queues it in the approval system.
 * - Notifies administrators of pending approvals and logs all actions for audit purposes.
 * - Ensures all business logic is separated from route handlers, enforcing security and maintainability.
 */
const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");
const { navConfig } = require("../../utils/nav-config");
const { setCookie } = require("../utils/cookies");
const { UI_NOTICE_COOKIE } = require("../core/ui-notice");
const { insertActivityLog } = require("../../utils/audit-log");
const { notifyPendingApprovalAdmins } = require("../../utils/approval-notifications");

const resolveRequestBaseUrl = (req) => {
  if (!req || typeof req.get !== "function") return null;
  const host = String(req.get("host") || "").trim();
  if (!host) return null;
  const protocol = String(req.protocol || "http").trim() || "http";
  return `${protocol}://${host}`;
};

const debugApproval = (...args) => {
  if (process.env.DEBUG_SCREEN_APPROVAL === "1") {
    console.log(...args);
  }
};

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

const queueApproval = async ({ req, scopeKey, action, entityType, entityId, summary, oldValue, newValue, reason, t }) => {
  try {
    const enrichedNewValue =
      newValue && typeof newValue === "object" && !Array.isArray(newValue)
        ? {
            ...newValue,
            _scope_key: scopeKey || null,
            _approval_action: action || null,
          }
        : newValue;
    const normalizedEntityId = String(entityId || "NEW");
    const approvalAction = String(enrichedNewValue?._action || action || "").trim().toLowerCase();
    let requestId = null;

    if (entityType === "BOM" && approvalAction) {
      let duplicateQuery = knex("erp.approval_request as ar")
        .select("ar.id")
        .where({
          "ar.entity_type": "BOM",
          "ar.entity_id": normalizedEntityId,
          "ar.status": "PENDING",
        })
        .andWhereRaw("COALESCE(ar.new_value ->> '_action', '') = ?", [approvalAction])
        .orderBy("ar.id", "desc");

      if (approvalAction === "approve_draft" && normalizedEntityId !== "NEW") {
        duplicateQuery = knex("erp.approval_request as ar")
          .select("ar.id")
          .joinRaw("JOIN erp.bom_header bh ON ar.entity_id ~ '^[0-9]+$' AND bh.id = ar.entity_id::bigint")
          .where({
            "ar.entity_type": "BOM",
            "ar.status": "PENDING",
          })
          .andWhereRaw("COALESCE(ar.new_value ->> '_action', '') = ?", [approvalAction])
          .andWhereRaw(
            "bh.item_id = (SELECT item_id FROM erp.bom_header WHERE id = ?)",
            [Number(normalizedEntityId)],
          )
          .orderBy("ar.id", "desc");
      }

      const duplicate = await duplicateQuery.first();
      if (duplicate?.id) {
        return duplicate.id;
      }
    }

    const [created] = await knex("erp.approval_request")
      .insert({
        branch_id: req.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: entityType,
        entity_id: normalizedEntityId,
        summary: summary || null,
        old_value: oldValue || null,
        new_value: enrichedNewValue || null,
        requested_by: req.user?.id || null,
      })
      .returning(["id"]);
    requestId = created?.id || null;
    await insertActivityLog(knex, {
      branch_id: req.branchId,
      user_id: req.user?.id || null,
      entity_type: entityType,
      entity_id: String(entityId || "NEW"),
      action: "SUBMIT",
      ip_address: req.ip,
      context: {
        approval_request_id: requestId,
        summary: summary || null,
        old_value: oldValue || null,
        new_value: enrichedNewValue || null,
        source: "screen-approval",
        reason: reason || null,
      },
    });
    notifyPendingApprovalAdmins({
      knex,
      approvalRequestId: requestId,
      requestType: "MASTER_DATA_CHANGE",
      entityType,
      entityId: String(entityId || "NEW"),
      summary,
      oldValue,
      newValue,
      requestedByName: req.user?.username || null,
      branchId: req.branchId,
      baseUrl: resolveRequestBaseUrl(req),
      t,
    }).catch((err) => {
      console.error("[screen-approval] admin email notify failed", {
        requestId,
        entityType,
        error: err?.message || err,
      });
    });
    return requestId;
  } catch (err) {
    console.error("[screen-approval] enqueue failed", { entityType, entityId, error: err.message });
    throw err;
  }
};

const handleScreenApproval = async ({
  req,
  scopeKey,
  action,
  entityType,
  entityId,
  summary,
  oldValue,
  newValue,
  t,
  forceQueue = false,
}) => {
  try {
    debugApproval("[screen-approval] handleScreenApproval called", {
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
  if (!forceQueue && req.user?.isAdmin) {
    debugApproval("[screen-approval] user is admin, bypassing approval queue");
    return { queued: false };
  }
  const allowed = hasPermission(req.user, scopeKey, action);
  debugApproval("[screen-approval] hasPermission result", { allowed });
  let approvalRequired = Boolean(forceQueue);
  try {
    if (!approvalRequired) {
      approvalRequired = await requiresApproval(scopeKey, action);
    }
    debugApproval("[screen-approval] requiresApproval result", { approvalRequired });
  } catch (err) {
    console.error("[screen-approval] requiresApproval threw error", err);
    throw err;
  }

  if (!allowed && !approvalRequired) {
    debugApproval("[screen-approval] permission missing; routing action to approval queue");
    approvalRequired = true;
  }

  if (approvalRequired) {
    let requestId = null;
    const res = req.res;
    const translator = typeof t === "function" ? t : res?.locals?.t;
    try {
      requestId = await queueApproval({
        req,
        scopeKey,
        action,
        entityType,
        entityId,
        summary,
        oldValue,
        newValue,
        reason: allowed ? "policy_requires_approval" : "permission_reroute",
        t: translator,
      });
      debugApproval("[screen-approval] approval queued", { requestId });
    } catch (err) {
      console.error("[screen-approval] queueApproval threw error", err);
      throw err;
    }
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
          sticky: false,
        }),
        { path: "/", maxAge: 30, sameSite: "Lax" },
      );
    }
    return { queued: true, requestId };
  }

  debugApproval("[screen-approval] approval not required, proceeding without queue");
  return { queued: false };
};

module.exports = {
  handleScreenApproval,
  hasPermission,
  requiresApproval,
};
