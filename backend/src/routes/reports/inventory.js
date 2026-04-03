const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getInventoryStockAmountReportPageData,
  getInventoryStockBalancesReportPageData,
  getInventoryStockLedgerReportPageData,
  getInventoryStockMovementReportPageData,
} = require("../../services/inventory/inventory-report-service");

const router = express.Router();

const translate = (res, key, fallback) => {
  const value = res?.locals?.t?.(key);
  return value && value !== key ? value : fallback;
};

const renderStockLedgerReport = async (req, res, next, input) => {
  try {
    const pageData = await getInventoryStockLedgerReportPageData({
      req,
      input,
    });

    return res.render("base/layouts/main", {
      title: `${translate(res, "stock_ledger_report", "Stock Ledger Report")} - ${translate(res, "inventory_reports", "Inventory Reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/inventory-stock-ledger",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/stock-ledger`,
    });
  } catch (err) {
    console.error("Error in InventoryStockLedgerReportService:", err);
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

const renderStockMovementReport = async (req, res, next, input) => {
  try {
    const pageData = await getInventoryStockMovementReportPageData({
      req,
      input,
    });

    return res.render("base/layouts/main", {
      title: `${translate(res, "stock_movement_report", "Stock Movement Report")} - ${translate(res, "inventory_reports", "Inventory Reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/inventory-stock-movement",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/stock-movement`,
    });
  } catch (err) {
    console.error("Error in InventoryStockMovementReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

router.get(
  "/",
  requirePermission("REPORT", "stock_quantity", "view"),
  async (req, res) => res.redirect(`${req.baseUrl}/stock-amount`),
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
  async (req, res, next) =>
    renderStockBalancesReport(req, res, next, req.query),
);

router.post(
  "/stock-balances",
  requirePermission("REPORT", "stock_quantity", "view"),
  async (req, res, next) => renderStockBalancesReport(req, res, next, req.body),
);

router.get(
  "/stock-ledger",
  requirePermission("REPORT", "stock_ledger", "view"),
  async (req, res, next) => renderStockLedgerReport(req, res, next, req.query),
);

router.post(
  "/stock-ledger",
  requirePermission("REPORT", "stock_ledger", "view"),
  async (req, res, next) => renderStockLedgerReport(req, res, next, req.body),
);

router.get(
  "/stock-movement",
  requirePermission("REPORT", "stock_item_activity", "view"),
  async (req, res, next) =>
    renderStockMovementReport(req, res, next, req.query),
);

router.post(
  "/stock-movement",
  requirePermission("REPORT", "stock_item_activity", "view"),
  async (req, res, next) => renderStockMovementReport(req, res, next, req.body),
);

module.exports = router;
