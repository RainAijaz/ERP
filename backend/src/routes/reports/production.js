const express = require("express");
const { requirePermission } = require("../../middleware/access/role-permissions");
const {
  getProductionPlannedConsumptionReportPageData,
  getProductionControlReportPageData,
  getProductionDepartmentWipReportPageData,
  getProductionDepartmentWipLedgerReportPageData,
} = require("../../services/production/production-report-service");

const router = express.Router();

const renderProductionReportLanding = async (req, res, next) => {
  try {
    return res.render("base/layouts/main", {
      title: `${res.locals.t("production_reports")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/production",
      t: res.locals.t,
      controlReportPath: `${req.baseUrl}/control`,
      plannedConsumptionPath: `${req.baseUrl}/planned-consumption`,
      departmentWipPath: `${req.baseUrl}/department-wip`,
      departmentWipLedgerPath: `${req.baseUrl}/department-wip-ledger`,
    });
  } catch (err) {
    console.error("Error in ProductionReportsLandingService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderPlannedConsumptionReport = async (req, res, next, input) => {
  try {
    const pageData = await getProductionPlannedConsumptionReportPageData({ req, input });
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
    const pageData = await getProductionDepartmentWipReportPageData({ req, input });
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

router.get(
  "/",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) => renderProductionReportLanding(req, res, next),
);

router.get(
  "/control",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) => renderProductionControlReport(req, res, next, req.query),
);

router.post(
  "/control",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) => renderProductionControlReport(req, res, next, req.body),
);

router.get(
  "/planned-consumption",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) => renderPlannedConsumptionReport(req, res, next, req.query),
);

router.post(
  "/planned-consumption",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) => renderPlannedConsumptionReport(req, res, next, req.body),
);

router.get(
  "/department-wip",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) => renderProductionDepartmentWipReport(req, res, next, req.query),
);

router.post(
  "/department-wip",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) => renderProductionDepartmentWipReport(req, res, next, req.body),
);

router.get(
  "/department-wip-ledger",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) =>
    renderProductionDepartmentWipLedgerReport(req, res, next, req.query),
);

router.post(
  "/department-wip-ledger",
  requirePermission("REPORT", "production_report", "view"),
  async (req, res, next) =>
    renderProductionDepartmentWipLedgerReport(req, res, next, req.body),
);

module.exports = router;
