const knex = require("../../db/knex");
const { buildAuditContext } = require("../../utils/activity-log-context");
const { insertActivityLog } = require("../../utils/audit-log");

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

