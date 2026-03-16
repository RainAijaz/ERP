const { createProductionVoucherRouter } = require("./production-router-factory");

module.exports = createProductionVoucherRouter({
  titleKey: "abnormal_loss_voucher",
  subtitleKey: "abnormal_loss_voucher_description",
  voucherTypeCode: "LOSS",
  scopeKey: "LOSS",
  mode: "loss",
  allowCreate: true,
  allowEdit: true,
  allowDelete: true,
});
