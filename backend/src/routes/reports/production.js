const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getProductionConsumptionReportPageData,
  getProductionPlannedConsumptionReportPageData,
  getProductionControlReportPageData,
  getProductionDepartmentWipReportPageData,
  getProductionDepartmentWipBalancesReportPageData,
  getProductionDepartmentWipLedgerReportPageData,
} = require("../../services/production/production-report-service");

const router = express.Router();

const renderConsumptionReport = async (req, res, next, input) => {
  try {
    const pageData = await getProductionConsumptionReportPageData({
      req,
      input,
    });
    return res.render("base/layouts/main", {
      title: `${res.locals.t("consumption_report")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/production-consumption",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/consumption`,
    });
  } catch (err) {
    console.error("Error in ProductionConsumptionReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderPlannedConsumptionReport = async (req, res, next, input) => {
  try {
    const pageData = await getProductionPlannedConsumptionReportPageData({
      req,
      input,
    });
    return res.render("base/layouts/main", {
      title: `${res.locals.t("planned_consumption")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/production-planned-consumption",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/planned-consumption`,
    });
  } catch (err) {
    console.error("Error in ProductionReportsService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderProductionControlReport = async (req, res, next, input) => {
  try {
    const pageData = await getProductionControlReportPageData({ req, input });
    return res.render("base/layouts/main", {
      title: `${res.locals.t("production_control_report")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/production-control",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/control`,
    });
  } catch (err) {
    console.error("Error in ProductionControlReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderProductionDepartmentWipReport = async (req, res, next, input) => {
  try {
    const pageData = await getProductionDepartmentWipReportPageData({
      req,
      input,
    });
    const reportTitle = (() => {
      const value = res.locals.t("department_wip_report");
      return value && value !== "department_wip_report"
        ? value
        : "Department-wise Pending Production Report";
    })();
    return res.render("base/layouts/main", {
      title: `${reportTitle} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/production-department-wip",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/department-wip`,
    });
  } catch (err) {
    console.error("Error in ProductionDepartmentWipReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderProductionDepartmentWipLedgerReport = async (
  req,
  res,
  next,
  input,
) => {
  try {
    const pageData = await getProductionDepartmentWipLedgerReportPageData({
      req,
      input,
    });
    const reportTitle = (() => {
      const value = res.locals.t("department_wip_ledger_report");
      return value && value !== "department_wip_ledger_report"
        ? value
        : "Department WIP Ledger Report";
    })();
    return res.render("base/layouts/main", {
      title: `${reportTitle} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/production-department-wip-ledger",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/department-wip-ledger`,
    });
  } catch (err) {
    console.error("Error in ProductionDepartmentWipLedgerReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderProductionDepartmentWipBalancesReport = async (
  req,
  res,
  next,
  input,
) => {
  try {
    const pageData = await getProductionDepartmentWipBalancesReportPageData({
      req,
      input,
    });
    const reportTitle = (() => {
      const value = res.locals.t("department_wip_balances_report");
      return value && value !== "department_wip_balances_report"
        ? value
        : "Department WIP Balances Report";
    })();
    return res.render("base/layouts/main", {
      title: `${reportTitle} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/production-department-wip-balances",
      t: res.locals.t,
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/department-wip-balances`,
      ledgerReportPath: `${req.baseUrl}/department-wip-ledger`,
    });
  } catch (err) {
    console.error(
      "Error in ProductionDepartmentWipBalancesReportService:",
      err,
    );
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

router.get(
  "/",
  requirePermission("REPORT", "production_report", "load"),
  async (req, res) => res.redirect(`${req.baseUrl}/control`),
);

router.get(
  "/control",
  requirePermission("REPORT", "production_report", "load"),
  async (req, res, next) =>
    renderProductionControlReport(req, res, next, req.query),
);

router.post(
  "/control",
  requirePermission("REPORT", "production_report", "load"),
  async (req, res, next) =>
    renderProductionControlReport(req, res, next, req.body),
);

router.get(
  "/consumption",
  requirePermission("REPORT", "consumption_report", "load"),
  async (req, res, next) => renderConsumptionReport(req, res, next, req.query),
);

router.post(
  "/consumption",
  requirePermission("REPORT", "consumption_report", "load"),
  async (req, res, next) => renderConsumptionReport(req, res, next, req.body),
);

router.get(
  "/planned-consumption",
  requirePermission("REPORT", "planned_consumption_report", "load"),
  async (req, res, next) =>
    renderPlannedConsumptionReport(req, res, next, req.query),
);

router.post(
  "/planned-consumption",
  requirePermission("REPORT", "planned_consumption_report", "load"),
  async (req, res, next) =>
    renderPlannedConsumptionReport(req, res, next, req.body),
);

router.get(
  "/department-wip",
  requirePermission("REPORT", "department_wip_report", "load"),
  async (req, res, next) =>
    renderProductionDepartmentWipReport(req, res, next, req.query),
);

router.post(
  "/department-wip",
  requirePermission("REPORT", "department_wip_report", "load"),
  async (req, res, next) =>
    renderProductionDepartmentWipReport(req, res, next, req.body),
);

router.get(
  "/department-wip-balances",
  requirePermission("REPORT", "department_wip_balances_report", "load"),
  async (req, res, next) =>
    renderProductionDepartmentWipBalancesReport(req, res, next, req.query),
);

router.post(
  "/department-wip-balances",
  requirePermission("REPORT", "department_wip_balances_report", "load"),
  async (req, res, next) =>
    renderProductionDepartmentWipBalancesReport(req, res, next, req.body),
);

router.get(
  "/department-wip-ledger",
  requirePermission("REPORT", "department_wip_ledger_report", "load"),
  async (req, res, next) =>
    renderProductionDepartmentWipLedgerReport(req, res, next, req.query),
);

router.post(
  "/department-wip-ledger",
  requirePermission("REPORT", "department_wip_ledger_report", "load"),
  async (req, res, next) =>
    renderProductionDepartmentWipLedgerReport(req, res, next, req.body),
);

module.exports = router;
