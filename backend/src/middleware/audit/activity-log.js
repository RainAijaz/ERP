const knex = require("../../db/knex");
const { buildAuditContext } = require("../../utils/activity-log-context");
const { insertActivityLog } = require("../../utils/audit-log");
const {
  notifyPendingApprovalPostCommit,
} = require("../../utils/in-app-notifications");

// Writes audit logs for sensitive events (rates, stock, vouchers, permissions).
module.exports = (req, res, next) => {
  req.setAuditContext = (context) => {
    req.auditContext = context;
  };

  res.on("finish", async () => {
    if (!req.user || !req.auditContext) return;
    if (res.statusCode >= 400) return;

    const {
      entityType,
      entityId,
      action,
      branchId = req.branchId || null,
      context,
    } = req.auditContext;

    if (!entityType || !entityId || !action) return;

    // If this audited action created a pending approval request, fan out an
    // in-ERP notification to the approvers. Runs post-response (post-commit)
    // so the request row is visible; the notifier self-guards on
    // status='PENDING' and idempotency, so decisions / re-audits are no-ops.
    const approvalRequestId = context?.approval_request_id;
    if (approvalRequestId) {
      notifyPendingApprovalPostCommit({ knex, approvalRequestId });
    }

    try {
      await insertActivityLog(knex, {
        branch_id: branchId,
        user_id: req.user.id,
        entity_type: entityType,
        entity_id: entityId,
        voucher_type_code: req.auditContext.voucherTypeCode || null,
        action,
        ip_address: req.ip,
        context: buildAuditContext(req, context),
      });
    } catch (err) {
      // Avoid breaking responses if audit logging fails.
      console.error("Activity log error", err);
    }
  });

  next();
};

