const knex = require("../../db/knex");

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
    } = req.auditContext;

    if (!entityType || !entityId || !action) return;

    try {
      await knex("erp.activity_log").insert({
        branch_id: branchId,
        user_id: req.user.id,
        entity_type: entityType,
        entity_id: String(entityId),
        voucher_type_code: req.auditContext.voucherTypeCode || null,
        action,
        ip_address: req.ip,
      });
    } catch (err) {
      // Avoid breaking responses if audit logging fails.
      console.error("Activity log error", err);
    }
  });

  next();
};

