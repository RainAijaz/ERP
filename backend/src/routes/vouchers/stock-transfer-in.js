const { createStockTransferVoucherRouter } = require("./stock-transfer-router-factory");

module.exports = createStockTransferVoucherRouter({
  mode: "in",
  voucherTypeCode: "GRN_IN",
  scopeKey: "GRN_IN",
  titleKey: "stock_transfer_in_voucher",
});
