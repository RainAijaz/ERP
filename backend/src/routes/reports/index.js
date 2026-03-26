const express = require("express");
const financialRoutes = require("./financial");
const purchaseRoutes = require("./purchases");
const salesRoutes = require("./sales");
const returnablesRoutes = require("./returnables");
const hrPayrollRoutes = require("./hr-payroll");

const router = express.Router();

router.use("/financial", financialRoutes);
router.use("/purchases", purchaseRoutes);
router.use("/sales", salesRoutes);
router.use("/returnables", returnablesRoutes);
router.use("/hr-payroll", hrPayrollRoutes);

module.exports = router;
