const express = require("express");
const { requirePermission } = require("../../middleware/access/role-permissions");
const {
  getLabourLedgerReportPageData,
  getLabourBalancesReportPageData,
  getEmployeeLedgerReportPageData,
  getEmployeeBalancesReportPageData,
} = require("../../services/hr-payroll/hr-payroll-report-service");

const router = express.Router();

const renderPage = async ({ req, res, next, pageDataLoader, input, titleKey, view, reportPath, extraLocals = {} }) => {
  try {
    const pageData = await pageDataLoader({ req, input });
    return res.render("base/layouts/main", {
      title: `${res.locals.t(titleKey)} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view,
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath,
      ...extraLocals,
    });
  } catch (err) {
    console.error("Error in HrPayrollReportsService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

router.get(
  "/labour-ledger",
  requirePermission("REPORT", "labour_ledger", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getLabourLedgerReportPageData,
      input: req.query,
      titleKey: "labour_ledger_report",
      view: "../../reports/hr-payroll/labour-ledger",
      reportPath: `${req.baseUrl}/labour-ledger`,
    }),
);

router.post(
  "/labour-ledger",
  requirePermission("REPORT", "labour_ledger", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getLabourLedgerReportPageData,
      input: req.body,
      titleKey: "labour_ledger_report",
      view: "../../reports/hr-payroll/labour-ledger",
      reportPath: `${req.baseUrl}/labour-ledger`,
    }),
);

router.get(
  "/labour-balances",
  requirePermission("REPORT", "labour_balances", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getLabourBalancesReportPageData,
      input: req.query,
      titleKey: "labour_balances_report",
      view: "../../reports/hr-payroll/labour-balances",
      reportPath: `${req.baseUrl}/labour-balances`,
      extraLocals: {
        ledgerPath: `${req.baseUrl}/labour-ledger`,
      },
    }),
);

router.post(
  "/labour-balances",
  requirePermission("REPORT", "labour_balances", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getLabourBalancesReportPageData,
      input: req.body,
      titleKey: "labour_balances_report",
      view: "../../reports/hr-payroll/labour-balances",
      reportPath: `${req.baseUrl}/labour-balances`,
      extraLocals: {
        ledgerPath: `${req.baseUrl}/labour-ledger`,
      },
    }),
);

router.get(
  "/employee-ledger",
  requirePermission("REPORT", "employee_ledger", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getEmployeeLedgerReportPageData,
      input: req.query,
      titleKey: "employee_ledger_report",
      view: "../../reports/hr-payroll/employee-ledger",
      reportPath: `${req.baseUrl}/employee-ledger`,
    }),
);

router.post(
  "/employee-ledger",
  requirePermission("REPORT", "employee_ledger", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getEmployeeLedgerReportPageData,
      input: req.body,
      titleKey: "employee_ledger_report",
      view: "../../reports/hr-payroll/employee-ledger",
      reportPath: `${req.baseUrl}/employee-ledger`,
    }),
);

router.get(
  "/employee-balances",
  requirePermission("REPORT", "employee_balances", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getEmployeeBalancesReportPageData,
      input: req.query,
      titleKey: "employee_balances_report",
      view: "../../reports/hr-payroll/employee-balances",
      reportPath: `${req.baseUrl}/employee-balances`,
      extraLocals: {
        employeeLedgerPath: `${req.baseUrl}/employee-ledger`,
      },
    }),
);

router.post(
  "/employee-balances",
  requirePermission("REPORT", "employee_balances", "load"),
  async (req, res, next) =>
    renderPage({
      req,
      res,
      next,
      pageDataLoader: getEmployeeBalancesReportPageData,
      input: req.body,
      titleKey: "employee_balances_report",
      view: "../../reports/hr-payroll/employee-balances",
      reportPath: `${req.baseUrl}/employee-balances`,
      extraLocals: {
        employeeLedgerPath: `${req.baseUrl}/employee-ledger`,
      },
    }),
);

module.exports = router;
