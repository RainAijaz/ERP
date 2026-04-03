const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const cashRoutes = require("./cash");
const bankRoutes = require("./bank");
const journalRoutes = require("./journal");
const inventoryRoutes = require("./inventory");
const stockCountRoutes = require("./stock-count");
const purchaseRoutes = require("./purchase");
const goodsReceiptNoteRoutes = require("./goods-receipt-note");
const purchaseReturnRoutes = require("./purchase-return");
const salesRoutes = require("./sales");
const salesOrderRoutes = require("./sales-order");
const returnablesLegacyRoutes = require("./returnables");
const {
  createReturnableVoucherRouter,
} = require("./returnable-router-factory");
const voucherEngineRoutes = require("./voucher-engine");
const departmentCompletionRoutes = require("./department-completion");
const productionPlanningRoutes = require("./production-planning");
const consumptionRoutes = require("./consumption");
const abnormalLossRoutes = require("./abnormal-loss");
const stockTransferRoutes = require("./stn");
const stockTransferOutRoutes = require("./stock-transfer-out");
const stockTransferInRoutes = require("./stock-transfer-in");

const router = express.Router();

const returnableDispatchRoutes = createReturnableVoucherRouter({
  voucherTypeCode: "RDV",
  scopeKey: "RDV",
  dispatchPath: "/vouchers/returnable-dispatch",
  receiptPath: "/vouchers/returnable-receipt",
});

const returnableReceiptRoutes = createReturnableVoucherRouter({
  voucherTypeCode: "RRV",
  scopeKey: "RRV",
  dispatchPath: "/vouchers/returnable-dispatch",
  receiptPath: "/vouchers/returnable-receipt",
});

router.use("/cash", cashRoutes);
router.use("/bank", bankRoutes);
router.use("/journal", journalRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/stock-count", stockCountRoutes);
router.use("/stn", stockTransferRoutes);
router.use("/stock-transfer-out", stockTransferOutRoutes);
router.use("/stock-transfer-in", stockTransferInRoutes);
router.get(
  "/purchase-order",
  requirePermission("VOUCHER", "GRN", "view"),
  (req, res) => {
    return res.redirect("/vouchers/goods-receipt-note?new=1");
  },
);
router.use("/purchase", purchaseRoutes);
router.use("/goods-receipt-note", goodsReceiptNoteRoutes);
router.use("/purchase-return", purchaseReturnRoutes);
router.use("/sales", salesRoutes);
router.use("/sales-order", salesOrderRoutes);
router.use("/returnable-dispatch", returnableDispatchRoutes);
router.use("/returnable-receipt", returnableReceiptRoutes);
router.use("/returnables", returnablesLegacyRoutes);
router.use("/department-completion", departmentCompletionRoutes);
router.use("/production-planning", productionPlanningRoutes);
router.use("/consumption", consumptionRoutes);
router.use("/abnormal-loss", abnormalLossRoutes);
router.use("/engine", voucherEngineRoutes);

module.exports = router;
