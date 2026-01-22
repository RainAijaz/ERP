const express = require("express");
const productsRoutes = require("./products");
const basicInfoRoutes = require("./basic-info");
const basicInformationRoutes = require("./basic-information");
const uomConversionsRoutes = require("./products/uom-conversions");
const accountsRoutes = require("./accounts-parties/accounts");
const partiesRoutes = require("./accounts-parties/parties");
const bomRoutes = require("./bom");

const router = express.Router();

router.use("/products", productsRoutes);
router.use("/basic-information", basicInformationRoutes);
router.use("/basic-information/uom-conversions", uomConversionsRoutes);
router.use("/basic-info", basicInfoRoutes);
router.use("/accounts", accountsRoutes);
router.use("/parties", partiesRoutes);
router.use("/bom", bomRoutes);

module.exports = router;
