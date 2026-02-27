const express = require("express");
const financialRoutes = require("./financial");
const purchaseRoutes = require("./purchases");

const router = express.Router();

router.use("/financial", financialRoutes);
router.use("/purchases", purchaseRoutes);

module.exports = router;
