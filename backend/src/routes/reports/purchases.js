const express = require("express");
const knex = require("../../db/knex");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getPurchaseReportPageData,
  getSupplierBalancesReportPageData,
  getSupplierLedgerReportPageData,
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
  requirePermission("REPORT", "purchase_report", "view"),
  async (req, res, next) => {
    return renderPurchaseReportPage(req, res, next, req.query);
  },
);

router.post(
  "/",
  requirePermission("REPORT", "purchase_report", "view"),
  async (req, res, next) => {
    return renderPurchaseReportPage(req, res, next, req.body);
  },
);

router.get(
  "/supplier-listings",
  requirePermission("REPORT", "purchase_report", "view"),
  async (req, res, next) => {
    try {
      let query = knex("erp.parties as p")
        .leftJoin("erp.party_groups as pg", "pg.id", "p.group_id")
        .leftJoin("erp.cities as c", "c.id", "p.city_id")
        .select(
          "p.id",
          "p.name",
          knex.raw("COALESCE(pg.name, '') as group_name"),
          knex.raw("COALESCE(c.name, p.city, '') as city_name"),
          knex.raw(
            "COALESCE(NULLIF(p.phone1, ''), NULLIF(p.phone2, '')) as phone_primary",
          ),
          "p.created_at",
          knex.raw(
            `(SELECT COALESCE(string_agg(b.name, ', ' ORDER BY b.name), '')
              FROM erp.party_branch pb
              JOIN erp.branches b ON b.id = pb.branch_id
              WHERE pb.party_id = p.id) as branch_names`,
          ),
        )
        .where({ "p.is_active": true, "p.party_type": "SUPPLIER" })
        .orderBy("p.id", "desc");

      if (!req.user?.isAdmin && Number(req.branchId || 0) > 0) {
        query = query.whereExists(function whereSupplierBranch() {
          this.select(1)
            .from("erp.party_branch as pb")
            .whereRaw("pb.party_id = p.id")
            .andWhere("pb.branch_id", Number(req.branchId));
        });
      }

      const rows = await query;
      return res.render("base/layouts/main", {
        title: `${res.locals.t("supplier_listings")} - ${res.locals.t("reports")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../reports/purchases/supplier-listings",
        t: res.locals.t,
        rows,
      });
    } catch (err) {
      console.error("Error in PurchaseReportsService:", err);
      return next(err);
    }
  },
);

router.get(
  "/supplier-ledger",
  requirePermission("REPORT", "supplier_ledger", "view"),
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

router.get(
  "/supplier-balances",
  requirePermission("REPORT", "supplier_balances", "view"),
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

module.exports = router;
