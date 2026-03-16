const { createProductionVoucherRouter } = require("./production-router-factory");

module.exports = createProductionVoucherRouter({
  titleKey: "semi_finished_production_voucher",
  subtitleKey: "semi_finished_production_voucher_description",
  voucherTypeCode: "PROD_SFG",
  scopeKey: "PROD_SFG",
  mode: "production",
  allowCreate: true,
  allowEdit: true,
  allowDelete: true,
});
