const express = require("express");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const {
  getBomVersionHistoryReportPageData,
  getBomLifecycleStatusReportPageData,
  getBomApprovalQueueAgingReportPageData,
  getBomChangeLogReportPageData,
  getBomCostBreakdownReportPageData,
} = require("../../../services/bom/bom-report-service");

const router = express.Router();
const BOM_REPORT_SCOPE = "master_data.bom.reports";

const translateWithFallback = (t, key, fallback) => {
  const value = typeof t === "function" ? t(key) : "";
  if (!value || value === key) return fallback;
  return value;
};

const renderBomReportsLayout = (req, res, payload = {}) =>
  res.render("base/layouts/main", {
    title: payload.title,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: payload.view,
    t: res.locals.t,
    ...payload.locals,
  });

const renderVersionHistoryReport = async (req, res, next, inputSource) => {
  try {
    const pageData = await getBomVersionHistoryReportPageData({
      req,
      input: inputSource,
    });
    const title = translateWithFallback(
      res.locals.t,
      "bom_version_history_report",
      "BOM Version History",
    );
    return renderBomReportsLayout(req, res, {
      title: `${title} - ${res.locals.t("reports")}`,
      view: "../../master_data/bom/reports/version-history",
      locals: {
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/version-history`,
      },
    });
  } catch (err) {
    console.error("Error in BomVersionHistoryReportService:", err);
    if (typeof req.flash === "function") req.flash("error", res.locals.t("generic_error"));
    return next(err);
  }
};

const renderLifecycleStatusReport = async (req, res, next, inputSource) => {
  try {
    const pageData = await getBomLifecycleStatusReportPageData({
      req,
      input: inputSource,
    });
    const title = translateWithFallback(
      res.locals.t,
      "bom_lifecycle_status_report",
      "BOM Lifecycle Status",
    );
    return renderBomReportsLayout(req, res, {
      title: `${title} - ${res.locals.t("reports")}`,
      view: "../../master_data/bom/reports/lifecycle-status",
      locals: {
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/lifecycle-status`,
      },
    });
  } catch (err) {
    console.error("Error in BomLifecycleStatusReportService:", err);
    if (typeof req.flash === "function") req.flash("error", res.locals.t("generic_error"));
    return next(err);
  }
};

const renderApprovalQueueAgingReport = async (req, res, next, inputSource) => {
  try {
    const pageData = await getBomApprovalQueueAgingReportPageData({
      req,
      input: inputSource,
    });
    const title = translateWithFallback(
      res.locals.t,
      "bom_approval_queue_aging_report",
      "BOM Approval Queue Aging",
    );
    return renderBomReportsLayout(req, res, {
      title: `${title} - ${res.locals.t("reports")}`,
      view: "../../master_data/bom/reports/approval-queue-aging",
      locals: {
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/approval-queue-aging`,
      },
    });
  } catch (err) {
    console.error("Error in BomApprovalQueueAgingReportService:", err);
    if (typeof req.flash === "function") req.flash("error", res.locals.t("generic_error"));
    return next(err);
  }
};

const renderChangeLogReport = async (req, res, next, inputSource) => {
  try {
    const pageData = await getBomChangeLogReportPageData({
      req,
      input: inputSource,
    });
    const title = translateWithFallback(
      res.locals.t,
      "bom_change_log_report",
      "BOM Change Log",
    );
    return renderBomReportsLayout(req, res, {
      title: `${title} - ${res.locals.t("reports")}`,
      view: "../../master_data/bom/reports/change-log",
      locals: {
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/change-log`,
      },
    });
  } catch (err) {
    console.error("Error in BomChangeLogReportService:", err);
    if (typeof req.flash === "function")
      req.flash("error", res.locals.t("generic_error"));
    return next(err);
  }
};

const renderCostBreakdownReport = async (req, res, next, inputSource) => {
  try {
    const pageData = await getBomCostBreakdownReportPageData({
      req,
      input: inputSource,
    });
    const title = translateWithFallback(
      res.locals.t,
      "bom_cost_breakdown_report",
      "BOM Cost Breakdown",
    );
    return renderBomReportsLayout(req, res, {
      title: `${title} - ${res.locals.t("reports")}`,
      view: "../../master_data/bom/reports/cost-breakdown",
      locals: {
        filters: pageData.filters,
        options: pageData.options,
        reportData: pageData.reportData,
        reportPath: `${req.baseUrl}/cost-breakdown`,
      },
    });
  } catch (err) {
    console.error("Error in BomCostBreakdownReportService:", err);
    if (typeof req.flash === "function")
      req.flash("error", res.locals.t("generic_error"));
    return next(err);
  }
};

router.get(
  "/",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "view"),
  async (req, res, next) => {
    try {
      const reportTitle = translateWithFallback(
        res.locals.t,
        "bom_reports",
        "BOM Reports",
      );
      return renderBomReportsLayout(req, res, {
        title: `${reportTitle} - ${res.locals.t("reports")}`,
        view: "../../master_data/bom/reports/index",
        locals: {
          reportsPath: req.baseUrl,
          versionHistoryPath: `${req.baseUrl}/version-history`,
          costBreakdownPath: `${req.baseUrl}/cost-breakdown`,
          lifecycleStatusPath: `${req.baseUrl}/lifecycle-status`,
          changeLogPath: `${req.baseUrl}/change-log`,
          approvalAgingPath: `${req.baseUrl}/approval-queue-aging`,
        },
      });
    } catch (err) {
      console.error("Error in BomReportsRoute:", err);
      return next(err);
    }
  },
);

const renderStub =
  ({ titleKey, titleFallback, descriptionKey, descriptionFallback }) =>
  async (req, res, next) => {
    try {
      const title = translateWithFallback(
        res.locals.t,
        titleKey,
        titleFallback,
      );
      return renderBomReportsLayout(req, res, {
        title: `${title} - ${res.locals.t("reports")}`,
        view: "../../master_data/bom/reports/stub",
        locals: {
          reportTitleKey: titleKey,
          reportTitleFallback: titleFallback,
          reportDescriptionKey: descriptionKey,
          reportDescriptionFallback: descriptionFallback,
          reportsHomePath: req.baseUrl,
        },
      });
    } catch (err) {
      console.error("Error in BomReportsRoute:", err);
      return next(err);
    }
  };

router.get(
  "/version-history",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) => renderVersionHistoryReport(req, res, next, req.query),
);

router.post(
  "/version-history",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) => renderVersionHistoryReport(req, res, next, req.body),
);

router.get(
  "/cost-breakdown",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) =>
    renderCostBreakdownReport(req, res, next, req.query),
);

router.post(
  "/cost-breakdown",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) =>
    renderCostBreakdownReport(req, res, next, req.body),
);

router.get(
  "/lifecycle-status",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) => renderLifecycleStatusReport(req, res, next, req.query),
);

router.post(
  "/lifecycle-status",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) => renderLifecycleStatusReport(req, res, next, req.body),
);

router.get(
  "/change-log",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) => renderChangeLogReport(req, res, next, req.query),
);

router.post(
  "/change-log",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) => renderChangeLogReport(req, res, next, req.body),
);

router.get(
  "/approval-queue-aging",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) =>
    renderApprovalQueueAgingReport(req, res, next, req.query),
);

router.post(
  "/approval-queue-aging",
  requirePermission("REPORT", BOM_REPORT_SCOPE, "load"),
  async (req, res, next) =>
    renderApprovalQueueAgingReport(req, res, next, req.body),
);

module.exports = router;
