const { createPurchaseVoucherRouter } = require("./purchase-router-factory");

module.exports = createPurchaseVoucherRouter({
  titleKey: "goods_receipt_note",
  subtitleKey: "goods_receipt_note_description",
  voucherTypeCode: "GRN",
  scopeKey: "GRN",
});
