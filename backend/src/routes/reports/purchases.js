const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getPurchaseReportPageData,
  getSupplierListingsReportPageData,
  getSupplierBalancesReportPageData,
  getSupplierLedgerReportPageData,
  getPendingGrnReportPageData,
  getSupplierAnalysisReportPageData,
} = require("../../services/purchase/purchase-report-service");

const router = express.Router();

const renderPurchaseReportPage = async (
  req,
  res,
  next,
  inputSource = req.query,
) => {
  try {
    const pageData = await getPurchaseReportPageData({
      req,
      input: inputSource,
    });
    return res.render("base/layouts/main", {
      title: `${res.locals.t("purchase_reports")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/purchases",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: req.baseUrl,
    });
  } catch (err) {
    console.error("Error in PurchaseReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderSupplierReportStub =
  ({ titleKey, descriptionKey }) =>
  async (req, res, next) => {
    try {
      return res.render("base/layouts/main", {
        title: `${res.locals.t(titleKey)} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/supplier-report-stub",
        t: res.locals.t,
        reportTitleKey: titleKey,
        reportDescriptionKey: descriptionKey,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  };

router.get(
  "/",
  requirePermission("REPORT", "purchase_report", "load"),
  async (req, res, next) => {
    return renderPurchaseReportPage(req, res, next, req.query);
  },
);

router.post(
  "/",
  requirePermission("REPORT", "purchase_report", "load"),
  async (req, res, next) => {
    return renderPurchaseReportPage(req, res, next, req.body);
  },
);

router.get(
  "/supplier-listings",
  requirePermission("REPORT", "supplier_listings_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSupplierListingsReportPageData({ req, input: req.query });
      return res.render("base/layouts/main", {
        title: `${res.locals.t("supplier_listings")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/supplier-listings",
        t: res.locals.t,
        ...pageData,
        reportPath: `${req.baseUrl}/supplier-listings`,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      if (typeof req.flash === "function") req.flash("error", res.locals.t("generic_error"));
      return next(err);
    }
  },
);

const renderSupplierAnalysisPage = async (req, res, next, inputSource) => {
  try {
    const pageData = await getSupplierAnalysisReportPageData({
      req,
      input: inputSource,
    });
    return res.render("base/layouts/main", {
      title: `${res.locals.t("supplier_analysis")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/purchases/supplier-analysis",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/supplier-analysis`,
    });
  } catch (err) {
    console.error("Error in PurchaseReportsService:", err);
    return next(err);
  }
};

router.get(
  "/supplier-analysis",
  requirePermission("REPORT", "supplier_analysis", "load"),
  async (req, res, next) =>
    renderSupplierAnalysisPage(req, res, next, req.query),
);

router.post(
  "/supplier-analysis",
  requirePermission("REPORT", "supplier_analysis", "load"),
  async (req, res, next) => renderSupplierAnalysisPage(req, res, next, req.body),
);

router.get(
  "/supplier-ledger",
  requirePermission("REPORT", "supplier_ledger", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSupplierLedgerReportPageData({
        req,
        input: req.query,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("supplier_ledger_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/supplier-ledger",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/supplier-ledger`,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  },
);

router.post(
  "/supplier-ledger",
  requirePermission("REPORT", "supplier_ledger", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSupplierLedgerReportPageData({
        req,
        input: req.body,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("supplier_ledger_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/supplier-ledger",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/supplier-ledger`,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  },
);

router.get(
  "/supplier-balances",
  requirePermission("REPORT", "supplier_balances", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSupplierBalancesReportPageData({
        req,
        input: req.query,
      });
      return res.render("base/layouts/main", {
        title: `${res.locals.t("supplier_balances_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/supplier-balances",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/supplier-balances`,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  },
);

router.post(
  "/supplier-balances",
  requirePermission("REPORT", "supplier_balances", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSupplierBalancesReportPageData({
        req,
        input: req.body,
      });
      return res.render("base/layouts/main", {
        title: `${res.locals.t("supplier_balances_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/supplier-balances",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/supplier-balances`,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  },
);

router.get(
  "/pending-grn",
  requirePermission("REPORT", "pending_grn", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getPendingGrnReportPageData({
        req,
        input: req.query,
      });
      return res.render("base/layouts/main", {
        title: `${res.locals.t("pending_grn_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/pending-grn",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/pending-grn`,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  },
);

router.post(
  "/pending-grn",
  requirePermission("REPORT", "pending_grn", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getPendingGrnReportPageData({
        req,
        input: req.body,
      });
      return res.render("base/layouts/main", {
        title: `${res.locals.t("pending_grn_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/pending-grn",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/pending-grn`,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  },
);

module.exports = router;
