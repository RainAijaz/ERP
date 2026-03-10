const express = require("express");
const productsRoutes = require("./products");
const basicInfoRoutes = require("./basic-info/index");
const uomConversionsRoutes = require("./basic-info/uom-conversions");
const accountsRoutes = require("./accounts");
const partiesRoutes = require("./parties");
const bomRoutes = require("./bom");
const returnableAssetsRoutes = require("./returnable-assets");
const assetTypesRoutes = require("./asset-types");

const router = express.Router();

router.use("/products", productsRoutes);
router.use("/assets", returnableAssetsRoutes);
router.use("/asset-types", assetTypesRoutes);
router.use("/returnable-assets", (req, res) => {
  const suffix = req.originalUrl.replace(/^\/master-data\/returnable-assets/, "");
  return res.redirect(`/master-data/assets${suffix || ""}`);
});
router.use("/hr-payroll", (req, res) => {
  const suffix = req.originalUrl.replace(/^\/master-data\/hr-payroll/, "");
  return res.redirect(`/hr-payroll${suffix || ""}`);
});
router.use("/basic-info/accounts", accountsRoutes);
router.use("/basic-info/parties", partiesRoutes);
router.use("/basic-info/uom-conversions", uomConversionsRoutes);
router.use("/basic-info", basicInfoRoutes);
router.use("/basic-information", (req, res) => {
  const suffix = req.originalUrl.replace(/^\/master-data\/basic-information/, "");
  return res.redirect(`/master-data/basic-info${suffix || ""}`);
});
router.use("/accounts", accountsRoutes);
router.use("/parties", partiesRoutes);
router.use("/bom", bomRoutes);

module.exports = router;
