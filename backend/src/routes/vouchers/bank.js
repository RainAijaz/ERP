const { createFinancialVoucherRouter } = require("./financial-router-factory");

module.exports = createFinancialVoucherRouter({
  titleKey: "bank_voucher",
  subtitleKey: "bank_voucher_description",
  voucherTypeCode: "BANK_VOUCHER",
  scopeKey: "BANK_VOUCHER",
  routeView: "../../vouchers/bank/index",
  accountLabelKey: "bank_account",
  receiptLabelKey: "bank_receipt",
  paymentLabelKey: "bank_payment",
  receiptKey: "bank_receipt",
  paymentKey: "bank_payment",
});
