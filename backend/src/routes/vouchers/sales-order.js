const { createSalesVoucherRouter } = require("./sales-router-factory");

module.exports = createSalesVoucherRouter({
  titleKey: "sales_order",
  subtitleKey: "sales_order_description",
  voucherTypeCode: "SALES_ORDER",
  scopeKey: "SALES_ORDER",
});
