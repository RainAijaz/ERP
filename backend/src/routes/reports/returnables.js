const express = require("express");
const { HttpError } = require("../../middleware/errors/http-error");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getReturnablesControlReportPageData,
  getReturnablesVendorPerformancePageData,
} = require("../../services/returnables/returnable-report-service");

const router = express.Router();

const requireReturnablesVendorAccess = (req, res, next) => {
  const canCheck = typeof res.locals.can === "function" ? res.locals.can : null;
  if (!canCheck) {
    return next(
      new HttpError(403, "Permission denied", {
        required: {
          scopeType: "REPORT",
          scopeKey: "overdue_returnables_report",
          action: "view",
        },
      }),
    );
  }

  const canViewVendorReport =
    canCheck("REPORT", "overdue_returnables_report", "load") ||
    canCheck("REPORT", "overdue_returnables", "load");

  if (canViewVendorReport) return next();
  return next(
    new HttpError(403, "Permission denied", {
      required: {
        scopeType: "REPORT",
        scopeKey: "overdue_returnables_report",
        action: "view",
      },
    }),
  );
};

const renderControlReport = async (req, res, next, inputSource = req.query) => {
  try {
    const pageData = await getReturnablesControlReportPageData({
      req,
      input: inputSource,
    });

    return res.render("base/layouts/main", {
      title: `${res.locals.t("pending_returnables")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/returnables",
      t: res.locals.t,
      reportMode: "control",
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/control`,
      controlPath: `${req.baseUrl}/control`,
      vendorPath: `${req.baseUrl}/vendor-performance`,
      downloadFileName: "returnables-control-dashboard.csv",
    });
  } catch (err) {
    console.error("Error in ReturnablesControlReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

const renderVendorReport = async (req, res, next, inputSource = req.query) => {
  try {
    const pageData = await getReturnablesVendorPerformancePageData({
      req,
      input: inputSource,
    });

    return res.render("base/layouts/main", {
      title: `${res.locals.t("overdue_returnables")} - ${res.locals.t("reports")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/returnables",
      t: res.locals.t,
      reportMode: "vendor",
      filters: pageData.filters,
      options: pageData.options,
      reportData: pageData.reportData,
      reportPath: `${req.baseUrl}/vendor-performance`,
      controlPath: `${req.baseUrl}/control`,
      vendorPath: `${req.baseUrl}/vendor-performance`,
      downloadFileName: "returnables-vendor-performance.csv",
    });
  } catch (err) {
    console.error("Error in ReturnablesVendorReportService:", err);
    if (typeof req.flash === "function") {
      req.flash("error", res.locals.t("generic_error"));
    }
    return next(err);
  }
};

router.get(
  "/",
  requirePermission("REPORT", "pending_returnables", "load"),
  async (req, res) => {
    return res.redirect(`${req.baseUrl}/control`);
  },
);

router.get(
  "/control",
  requirePermission("REPORT", "pending_returnables", "load"),
  async (req, res, next) => {
    return renderControlReport(req, res, next, req.query);
  },
);

router.post(
  "/control",
  requirePermission("REPORT", "pending_returnables", "load"),
  async (req, res, next) => {
    return renderControlReport(req, res, next, req.body);
  },
);

router.get(
  "/vendor-performance",
  requireReturnablesVendorAccess,
  async (req, res, next) => {
    return renderVendorReport(req, res, next, req.query);
  },
);

router.post(
  "/vendor-performance",
  requireReturnablesVendorAccess,
  async (req, res, next) => {
    return renderVendorReport(req, res, next, req.body);
  },
);

module.exports = router;
