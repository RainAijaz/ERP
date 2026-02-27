const express = require("express");
const cashRoutes = require("./cash");
const bankRoutes = require("./bank");
const journalRoutes = require("./journal");
const purchaseRoutes = require("./purchase");
const goodsReceiptNoteRoutes = require("./goods-receipt-note");
const purchaseReturnRoutes = require("./purchase-return");
const voucherEngineRoutes = require("./voucher-engine");

const router = express.Router();

router.use("/cash", cashRoutes);
router.use("/bank", bankRoutes);
router.use("/journal", journalRoutes);
router.get("/purchase-order", (req, res) => {
  return res.redirect("/vouchers/goods-receipt-note?new=1");
});
router.use("/purchase", purchaseRoutes);
router.use("/goods-receipt-note", goodsReceiptNoteRoutes);
router.use("/purchase-return", purchaseReturnRoutes);
router.use("/engine", voucherEngineRoutes);

module.exports = router;
