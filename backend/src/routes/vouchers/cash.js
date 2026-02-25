const { createFinancialVoucherRouter } = require("./financial-router-factory");

module.exports = createFinancialVoucherRouter({
  titleKey: "cash_voucher",
  subtitleKey: "cash_voucher_description",
  voucherTypeCode: "CASH_VOUCHER",
  scopeKey: "CASH_VOUCHER",
  routeView: "../../vouchers/cash/index",
  accountLabelKey: "cash_account",
  receiptLabelKey: "cash_receipt",
  paymentLabelKey: "cash_payment",
  receiptKey: "cash_receipt",
  paymentKey: "cash_payment",
});
