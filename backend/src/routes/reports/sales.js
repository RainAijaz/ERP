const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getCustomerListingsRows,
  getCustomerLedgerReportPageData,
  getCustomerBalancesReportPageData,
  getSalesOrderReportPageData,
  getSalesReportPageData,
  getSaleReturnReportPageData,
  getSalesDiscountReportPageData,
  getCustomerContactAnalysisPageData,
} = require("../../services/sales/sales-report-service");

const router = express.Router();

const redirectReportNotConfigured = (req, res) => {
  if (typeof req.flash === "function") {
    req.flash("info", res.locals.t("report_not_configured_yet"));
  }
  return res.redirect(`${req.baseUrl}/customer-listings`);
};

const renderSalesReportPage = async (
  req,
  res,
  next,
  inputSource = req.query,
) => {
  try {
    const salesReportTitle =
      res.locals.t("sales_report") &&
      res.locals.t("sales_report") !== "sales_report"
        ? res.locals.t("sales_report")
        : "Sales Report";
    const pageData = await getSalesReportPageData({
      req,
      input: inputSource,
    });

    return res.render("base/layouts/main", {
      title: `${salesReportTitle} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/sales/sales-report",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/sales-report`,
      reportTitle: salesReportTitle,
      downloadFileName: "sales-report.csv",
      returnReasonFilter: false,
    });
  } catch (err) {
    console.error("Error in SalesReportsService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderSaleReturnReportPage = async (
  req,
  res,
  next,
  inputSource = req.query,
) => {
  try {
    const saleReturnReportTitle =
      res.locals.t("sale_return_report") &&
      res.locals.t("sale_return_report") !== "sale_return_report"
        ? res.locals.t("sale_return_report")
        : "Sale Return Report";
    const pageData = await getSaleReturnReportPageData({
      req,
      input: inputSource,
    });

    return res.render("base/layouts/main", {
      title: `${saleReturnReportTitle} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/sales/sales-report",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/sale-return-report`,
      reportTitle: saleReturnReportTitle,
      downloadFileName: "sale-return-report.csv",
      returnReasonFilter: true,
    });
  } catch (err) {
    console.error("Error in SalesReportsService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

router.get(
  "/",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res) => {
    return res.redirect(`${req.baseUrl}/customer-listings`);
  },
);

router.get(
  "/customer-listings",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const rows = await getCustomerListingsRows({ req });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("customer_listings")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/customer-listings",
        t: res.locals.t,
        rows,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.get(
  "/customer-contact-analysis",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getCustomerContactAnalysisPageData({
        req,
        input: req.query,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("customer_contact_analysis")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/customer-contact-analysis",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/customer-contact-analysis`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.post(
  "/customer-contact-analysis",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getCustomerContactAnalysisPageData({
        req,
        input: req.body,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("customer_contact_analysis")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/customer-contact-analysis",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/customer-contact-analysis`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.get(
  "/customer-ledger",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getCustomerLedgerReportPageData({
        req,
        input: req.query,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("customer_ledger_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/customer-ledger",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/customer-ledger`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.post(
  "/customer-ledger",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getCustomerLedgerReportPageData({
        req,
        input: req.body,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("customer_ledger_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/customer-ledger",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/customer-ledger`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.get(
  "/customer-balances",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getCustomerBalancesReportPageData({
        req,
        input: req.query,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("customer_balances_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/customer-balances",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/customer-balances`,
        customerLedgerPath: `${req.baseUrl}/customer-ledger`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.post(
  "/customer-balances",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getCustomerBalancesReportPageData({
        req,
        input: req.body,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("customer_balances_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/customer-balances",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/customer-balances`,
        customerLedgerPath: `${req.baseUrl}/customer-ledger`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.get(
  "/sales-order-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSalesOrderReportPageData({
        req,
        input: req.query,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("sales_order_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/sales-order-report",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/sales-order-report`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.post(
  "/sales-order-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSalesOrderReportPageData({
        req,
        input: req.body,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("sales_order_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/sales-order-report",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/sales-order-report`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.get(
  "/sales-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => renderSalesReportPage(req, res, next, req.query),
);

router.post(
  "/sales-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => renderSalesReportPage(req, res, next, req.body),
);

router.get(
  "/sale-return-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) =>
    renderSaleReturnReportPage(req, res, next, req.query),
);

router.post(
  "/sale-return-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) =>
    renderSaleReturnReportPage(req, res, next, req.body),
);

router.get(
  "/sales-discount-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSalesDiscountReportPageData({
        req,
        input: req.query,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("sales_discount_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/sales-discount-report",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/sales-discount-report`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

router.post(
  "/sales-discount-report",
  requirePermission("REPORT", "sales_report", "load"),
  async (req, res, next) => {
    try {
      const pageData = await getSalesDiscountReportPageData({
        req,
        input: req.body,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t("sales_discount_report")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/sales/sales-discount-report",
        t: res.locals.t,
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/sales-discount-report`,
      });
    } catch (err) {
      console.error("Error in SalesReportsService:", err);
      if (typeof req.flash === "function") {
        req.flash("error", res.locals.t("generic_error"));
      }
      return next(err);
    }
  },
);

module.exports = router;
