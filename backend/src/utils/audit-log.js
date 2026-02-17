// audit-log.js
// Shared helpers to queue and persist activity logs.

const normalizeContext = (context) => {
  if (!context) return null;
  if (typeof context === "object") return context;
  return { value: String(context) };
};

const queueAuditLog = (req, { entityType, entityId, action, voucherTypeCode, branchId, context } = {}) => {
  if (!req || typeof req.setAuditContext !== "function") return;
  if (!entityType || entityId === null || typeof entityId === "undefined" || !action) return;
  req.setAuditContext({
    entityType,
    entityId,
    action: String(action).toUpperCase(),
    voucherTypeCode: voucherTypeCode || null,
    branchId: branchId ?? req.branchId ?? null,
    context: normalizeContext(context),
  });
};

const insertActivityLog = async (db, payload = {}) => {
  const entityType = payload.entity_type || payload.entityType;
  const entityId = payload.entity_id || payload.entityId;
  const action = payload.action;
  if (!db || !entityType || entityId === null || typeof entityId === "undefined" || !action) return;

  await db("erp.activity_log").insert({
    branch_id: payload.branch_id ?? payload.branchId ?? null,
    user_id: payload.user_id ?? payload.userId ?? null,
    entity_type: entityType,
    entity_id: String(entityId),
    voucher_type_code: payload.voucher_type_code ?? payload.voucherTypeCode ?? null,
    action: String(action).toUpperCase(),
    ip_address: payload.ip_address ?? payload.ipAddress ?? null,
    context_json: normalizeContext(payload.context_json ?? payload.context),
  });
};

module.exports = {
  queueAuditLog,
  insertActivityLog,
};
