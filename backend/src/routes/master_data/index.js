const express = require("express");
const { HttpError } = require("../../middleware/errors/http-error");
const {
  requirePermission,
  canAccessScope,
} = require("../../middleware/access/role-permissions");
const productsRoutes = require("./products");
const basicInfoRoutes = require("./basic-info/index");
const uomConversionsRoutes = require("./basic-info/uom-conversions");
const accountsRoutes = require("./accounts");
const partiesRoutes = require("./parties");
const bomRoutes = require("./bom");
const returnableAssetsRoutes = require("./returnable-assets");
const assetTypesRoutes = require("./asset-types");
const importRoutes = require("./import");

const router = express.Router();

const permissionDeniedMessage = (res) =>
  (typeof res?.locals?.t === "function" &&
    (res.locals.t("permission_denied") || "").trim()) ||
  "Permission denied";

const resolveHrPayrollScopeFromSuffix = (suffix) => {
  const normalized = String(suffix || "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("/employees/commissions"))
    return "hr_payroll.commissions";
  if (normalized.startsWith("/employees/allowances"))
    return "hr_payroll.allowances";
  if (normalized.startsWith("/employees")) return "hr_payroll.employees";
  if (normalized.startsWith("/labours/rates")) return "hr_payroll.labour_rates";
  if (normalized.startsWith("/labours")) return "hr_payroll.labours";
  return null;
};

const BASIC_INFO_SCOPE_MAP = {
  "groups/products/product-groups": "master_data.basic_info.product_groups",
  "groups/products/product-subgroups":
    "master_data.basic_info.product_subgroups",
  "groups/products/product-types": "master_data.basic_info.product_types",
  "groups/party-groups": "master_data.basic_info.party_groups",
  "groups/account-groups": "master_data.basic_info.account_groups",
  "groups/departments": "master_data.basic_info.departments",
  "groups/production-stages": "master_data.basic_info.production_stages",
  units: "master_data.basic_info.units",
  sizes: "master_data.basic_info.sizes",
  colors: "master_data.basic_info.colors",
  grades: "master_data.basic_info.grades",
  "packing-types": "master_data.basic_info.packing_types",
  cities: "master_data.basic_info.cities",
  "uom-conversions": "master_data.basic_info.uom_conversions",
  "product-groups": "master_data.basic_info.product_groups",
  "product-subgroups": "master_data.basic_info.product_subgroups",
  "product-types": "master_data.basic_info.product_types",
  "party-groups": "master_data.basic_info.party_groups",
  "account-groups": "master_data.basic_info.account_groups",
  departments: "master_data.basic_info.departments",
  "production-stages": "master_data.basic_info.production_stages",
};

const resolveBasicInfoScopeFromSuffix = (suffix) => {
  const normalized = String(suffix || "")
    .trim()
    .toLowerCase()
    .replace(/^\//, "");
  if (!normalized) return null;
  const direct = BASIC_INFO_SCOPE_MAP[normalized];
  if (direct) return direct;
  const [firstSegment] = normalized.split("/");
  return BASIC_INFO_SCOPE_MAP[firstSegment] || null;
};

router.use("/products", productsRoutes);
router.use("/assets", returnableAssetsRoutes);
router.use("/asset-types", assetTypesRoutes);
router.use(
  "/returnable-assets",
  requirePermission("SCREEN", "master_data.returnable_assets", "view"),
  (req, res) => {
    const suffix = req.originalUrl.replace(
      /^\/master-data\/returnable-assets/,
      "",
    );
    return res.redirect(`/master-data/assets${suffix || ""}`);
  },
);
router.use("/hr-payroll", (req, res, next) => {
  const suffix = req.originalUrl.replace(/^\/master-data\/hr-payroll/, "");
  const scopeKey = resolveHrPayrollScopeFromSuffix(suffix);
  if (scopeKey && !canAccessScope(req, "SCREEN", scopeKey, "view")) {
    return next(new HttpError(403, permissionDeniedMessage(res)));
  }
  return res.redirect(`/hr-payroll${suffix || ""}`);
});
router.use("/basic-info/accounts", accountsRoutes);
router.use("/basic-info/parties", partiesRoutes);
router.use("/basic-info/uom-conversions", uomConversionsRoutes);
router.use("/basic-info", basicInfoRoutes);
router.use("/import", importRoutes);
router.use("/basic-information", (req, res, next) => {
  const suffix = req.originalUrl.replace(
    /^\/master-data\/basic-information/,
    "",
  );
  const scopeKey = resolveBasicInfoScopeFromSuffix(suffix);
  if (scopeKey && !canAccessScope(req, "SCREEN", scopeKey, "view")) {
    return next(new HttpError(403, permissionDeniedMessage(res)));
  }
  return res.redirect(`/master-data/basic-info${suffix || ""}`);
});
router.use("/accounts", accountsRoutes);
router.use("/parties", partiesRoutes);
router.use("/bom", bomRoutes);

module.exports = router;
