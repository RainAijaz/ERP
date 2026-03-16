const { createProductionVoucherRouter } = require("./production-router-factory");

module.exports = createProductionVoucherRouter({
  titleKey: "department_completion_voucher",
  subtitleKey: "department_completion_voucher_description",
  voucherTypeCode: "DCV",
  scopeKey: "DCV",
  mode: "dcv",
  allowCreate: true,
  allowEdit: true,
  allowDelete: true,
});
