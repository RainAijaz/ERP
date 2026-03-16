const { createProductionVoucherRouter } = require("./production-router-factory");

module.exports = createProductionVoucherRouter({
  titleKey: "labour_production_voucher",
  subtitleKey: "labour_production_voucher_description",
  voucherTypeCode: "LABOUR_PROD",
  scopeKey: "LABOUR_PROD",
  mode: "labour",
  allowCreate: false,
  allowEdit: false,
  allowDelete: false,
});
