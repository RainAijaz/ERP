const { createFinancialVoucherRouter } = require("./financial-router-factory");

module.exports = createFinancialVoucherRouter({
  titleKey: "journal_voucher",
  subtitleKey: "journal_voucher_description",
  voucherTypeCode: "JOURNAL_VOUCHER",
  scopeKey: "JOURNAL_VOUCHER",
  routeView: "../../vouchers/journal/index",
  accountLabelKey: "journal_type",
  receiptLabelKey: "debit",
  paymentLabelKey: "credit",
  receiptKey: "debit",
  paymentKey: "credit",
});
