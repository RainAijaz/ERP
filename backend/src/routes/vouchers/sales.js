const { createSalesVoucherRouter } = require("./sales-router-factory");

module.exports = createSalesVoucherRouter({
  titleKey: "sales_voucher",
  subtitleKey: "sales_voucher_description",
  voucherTypeCode: "SALES_VOUCHER",
  scopeKey: "SALES_VOUCHER",
});
