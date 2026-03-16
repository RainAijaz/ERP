const { createProductionVoucherRouter } = require("./production-router-factory");

module.exports = createProductionVoucherRouter({
  titleKey: "consumption_voucher",
  subtitleKey: "consumption_voucher_description",
  voucherTypeCode: "CONSUMP",
  scopeKey: "CONSUMP",
  mode: "consumption",
  allowCreate: false,
  allowEdit: false,
  allowDelete: false,
});
