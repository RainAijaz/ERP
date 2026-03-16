const { createProductionVoucherRouter } = require("./production-router-factory");

module.exports = createProductionVoucherRouter({
  titleKey: "finished_production_voucher",
  subtitleKey: "finished_production_voucher_description",
  voucherTypeCode: "PROD_FG",
  scopeKey: "PROD_FG",
  mode: "production",
  allowCreate: true,
  allowEdit: true,
  allowDelete: true,
});
