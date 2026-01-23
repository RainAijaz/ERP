const express = require("express");
const finishedRoutes = require("./finished");
const rawMaterialsRoutes = require("./raw-materials");
const semiFinishedRoutes = require("./semi-finished");
const skusRoutes = require("./skus");

const router = express.Router();

router.use("/finished", finishedRoutes);
router.use("/raw-materials", rawMaterialsRoutes);
router.use("/semi-finished", semiFinishedRoutes);
router.use("/skus", skusRoutes);

module.exports = router;
