// audit-log.js
// Purpose: Provides a helper to queue audit log entries for entity actions (create, update, delete, etc).
// Used by routes and services to record audit context for later logging.
//
// Exports:
// - queueAuditLog: Attaches audit context to the request for later processing by audit middleware.

const queueAuditLog = (req, { entityType, entityId, action, voucherTypeCode, branchId } = {}) => {
  if (!req || typeof req.setAuditContext !== "function") return;
  if (!entityType || entityId === null || typeof entityId === "undefined" || !action) return;
  req.setAuditContext({
    entityType,
    entityId,
    action: String(action).toUpperCase(),
    voucherTypeCode: voucherTypeCode || null,
    branchId: branchId ?? req.branchId ?? null,
  });
};

module.exports = {
  queueAuditLog,
};
