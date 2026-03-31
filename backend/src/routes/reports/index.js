const express = require("express");
const financialRoutes = require("./financial");
const purchaseRoutes = require("./purchases");
const salesRoutes = require("./sales");
const returnablesRoutes = require("./returnables");
const hrPayrollRoutes = require("./hr-payroll");
const productionRoutes = require("./production");
const inventoryRoutes = require("./inventory");

const router = express.Router();

router.use("/financial", financialRoutes);
router.use("/purchases", purchaseRoutes);
router.use("/sales", salesRoutes);
router.use("/returnables", returnablesRoutes);
router.use("/hr-payroll", hrPayrollRoutes);
router.use("/production", productionRoutes);
router.use("/inventory", inventoryRoutes);

module.exports = router;
