const express = require("express");
const cashRoutes = require("./cash");
const bankRoutes = require("./bank");
const journalRoutes = require("./journal");
const voucherEngineRoutes = require("./voucher-engine");

const router = express.Router();

router.use("/cash", cashRoutes);
router.use("/bank", bankRoutes);
router.use("/journal", journalRoutes);
router.use("/engine", voucherEngineRoutes);

module.exports = router;
