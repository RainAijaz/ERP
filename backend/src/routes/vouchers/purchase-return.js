const { createPurchaseVoucherRouter } = require("./purchase-router-factory");

module.exports = createPurchaseVoucherRouter({
  titleKey: "purchase_return",
  subtitleKey: "purchase_return_description",
  voucherTypeCode: "PR",
  scopeKey: "PR",
});
