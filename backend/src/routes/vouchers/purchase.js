const { createPurchaseVoucherRouter } = require("./purchase-router-factory");

module.exports = createPurchaseVoucherRouter({
  titleKey: "general_purchase",
  subtitleKey: "general_purchase_description",
  voucherTypeCode: "PI",
  scopeKey: "PI",
});
