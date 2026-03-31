const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getInventoryStockAmountReportPageData,
  getInventoryStockBalancesReportPageData,
} = require("../../services/inventory/inventory-report-service");

const router = express.Router();

const translate = (res, key, fallback) => {
  const value = res?.locals?.t?.(key);
  return value && value !== key ? value : fallback;
};

const renderInventoryLanding = async (req, res, next) => {
  try {
    return res.render("base/layouts/main", {
      title: `${translate(res, "inventory_reports", "Inventory Reports")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/inventory",
      t: res.locals.t,
      stockAmountPath: `${req.baseUrl}/stock-amount`,
      stockBalancesPath: `${req.baseUrl}/stock-balances`,
    });
  } catch (err) {
    console.error("Error in InventoryReportsLandingService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderStockAmountReport = async (req, res, next, input) => {
  try {
    const pageData = await getInventoryStockAmountReportPageData({
      req,
      input,
    });

    return res.render("base/layouts/main", {
      title: `${translate(res, "stock_amount_report", "Stock Amount Report")} - ${translate(res, "inventory_reports", "Inventory Reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/inventory-stock-amount",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/stock-amount`,
    });
  } catch (err) {
    console.error("Error in InventoryStockAmountReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderStockBalancesReport = async (req, res, next, input) => {
  try {
    const pageData = await getInventoryStockBalancesReportPageData({
      req,
      input,
    });

    return res.render("base/layouts/main", {
      title: `${translate(res, "stock_balances_report", "Stock Balances Report")} - ${translate(res, "inventory_reports", "Inventory Reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/inventory-stock-balances",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/stock-balances`,
    });
  } catch (err) {
    console.error("Error in InventoryStockBalancesReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

router.get(
  "/",
  requirePermission("REPORT", "stock_quantity", "view"),
  async (req, res, next) => renderInventoryLanding(req, res, next),
);

router.get(
  "/stock-amount",
  requirePermission("REPORT", "stock_amount", "view"),
  async (req, res, next) => renderStockAmountReport(req, res, next, req.query),
);

router.post(
  "/stock-amount",
  requirePermission("REPORT", "stock_amount", "view"),
  async (req, res, next) => renderStockAmountReport(req, res, next, req.body),
);

router.get(
  "/stock-balances",
  requirePermission("REPORT", "stock_quantity", "view"),
  async (req, res, next) => renderStockBalancesReport(req, res, next, req.query),
);

router.post(
  "/stock-balances",
  requirePermission("REPORT", "stock_quantity", "view"),
  async (req, res, next) => renderStockBalancesReport(req, res, next, req.body),
);

module.exports = router;
