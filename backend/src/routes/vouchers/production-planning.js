const { createProductionVoucherRouter } = require("./production-router-factory");

module.exports = createProductionVoucherRouter({
  titleKey: "production_planning_voucher",
  subtitleKey: "production_planning_voucher_description",
  voucherTypeCode: "PROD_PLAN",
  scopeKey: "PROD_PLAN",
  mode: "planning",
  allowCreate: true,
  allowEdit: true,
  allowDelete: true,
});
