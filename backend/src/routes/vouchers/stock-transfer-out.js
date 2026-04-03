const { createStockTransferVoucherRouter } = require("./stock-transfer-router-factory");

module.exports = createStockTransferVoucherRouter({
  mode: "out",
  voucherTypeCode: "STN_OUT",
  scopeKey: "STN_OUT",
  titleKey: "stock_transfer_out_voucher",
});
