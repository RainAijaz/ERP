const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { getFinancialReport, getCommonFilters, updateBankVoucherLineStatus } = require("../../services/financial/report-service");

const router = express.Router();

const REPORT_KEYS = [
  "voucher_register",
  "cash_book",
  "cash_voucher_register",
  "bank_transactions",
  "expense_analysis",
  "expense_trends",
  "production_overhead",
  "non_production_expense",
  "accrued_expenses",
  "profitability_analysis",
  "profit_and_loss",
  "journal_voucher_register",
  "account_activity_ledger",
  "trial_balance",
  "payroll_wage_balance",
];

const LEGACY_EXPENSE_REPORT_TYPES = new Set(["production_overhead", "non_production_expense", "accrued_expenses"]);

const resolveReportKey = (value, fallback = "profit_and_loss") => {
  const key = String(value || "").trim();
  return REPORT_KEYS.includes(key) ? key : fallback;
};

const normalizeFilterInput = (value) => {
  if (!value || typeof value !== "object") return {};
  return value;
};

const getReportAccounts = async ({ reportKey, req, selectedBranchId = null }) => {
  const normalized = String(reportKey || "").trim().toLowerCase();
  if (normalized !== "account_activity_ledger" && normalized !== "cash_book") {
    return [];
  }

  let query = knex("erp.accounts as a")
    .select("a.id", "a.code", "a.name")
    .where({ "a.is_active": true });

  if (normalized === "cash_book") {
    query = query
      .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
      .whereRaw("upper(COALESCE(apc.code, '')) = 'CASH'");
  }

  const branchScopeId = Number(selectedBranchId || 0) || null;
  if (branchScopeId) {
    query = query.whereExists(function whereAccountBranchMap() {
      this.select(1).from("erp.account_branch as ab").whereRaw("ab.account_id = a.id").andWhere("ab.branch_id", branchScopeId);
    });
  } else if (!req.user?.isAdmin) {
    query = query.whereExists(function whereAccountBranchMap() {
      this.select(1).from("erp.account_branch as ab").whereRaw("ab.account_id = a.id").andWhere("ab.branch_id", req.branchId);
    });
  }

  return query.orderBy("a.name", "asc");
};

const getExpenseAnalysisFilterOptions = async ({ req, filters }) => {
  const selectedBranchIds = Array.isArray(filters?.branchIds) ? filters.branchIds : [];
  const departments = await knex("erp.departments as d")
    .select("d.id", "d.name")
    .where({ "d.is_active": true })
    .orderBy("d.name", "asc");

  let cashierQuery = knex("erp.accounts as a")
    .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
    .distinct("a.id", "a.code", "a.name")
    .where({ "a.is_active": true })
    .andWhereRaw("upper(COALESCE(apc.code, '')) = 'CASH'");

  cashierQuery = cashierQuery.whereExists(function whereAccountBranchMap() {
    this.select(1).from("erp.account_branch as ab").whereRaw("ab.account_id = a.id");
    if (selectedBranchIds.length) {
      this.whereIn("ab.branch_id", selectedBranchIds);
    } else if (!req.user?.isAdmin) {
      this.andWhere("ab.branch_id", req.branchId);
    }
  });

  const cashierAccounts = await cashierQuery.orderBy("a.name", "asc");
  return { departments, cashierAccounts };
};

const getExpenseTrendFilterOptions = async ({ req, filters }) => {
  const selectedGroupId = Number(filters?.trendAccountGroupId || 0) || null;
  const branchScopeId = Number(filters?.branchId || 0) || null;

  const accountGroups = await knex("erp.account_groups as ag")
    .select("ag.id", "ag.code", "ag.name")
    .where("ag.account_type", "EXPENSE")
    .orderBy("ag.name", "asc");

  let accountsQuery = knex("erp.accounts as a")
    .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .distinct("a.id", "a.code", "a.name", "ag.id as account_group_id")
    .where({ "a.is_active": true })
    .andWhere("ag.account_type", "EXPENSE");

  if (selectedGroupId) accountsQuery = accountsQuery.where("ag.id", selectedGroupId);

  if (branchScopeId || !req.user?.isAdmin) {
    accountsQuery = accountsQuery.whereExists(function whereAccountBranchMap() {
      this.select(1).from("erp.account_branch as ab").whereRaw("ab.account_id = a.id");
      if (branchScopeId) {
        this.andWhere("ab.branch_id", branchScopeId);
      } else {
        this.andWhere("ab.branch_id", req.branchId);
      }
    });
  }

  const accounts = await accountsQuery.orderBy("a.name", "asc");
  return { accountGroups, accounts };
};

router.get("/", async (req, res) => {
  const legacyReport = resolveReportKey(req.query.report, "profit_and_loss");
  return res.redirect(`${req.baseUrl}/${legacyReport}`);
});

router.post("/:reportKey/bank-line-status", async (req, res, next) => {
  try {
    const resolvedKey = resolveReportKey(req.params.reportKey, "profit_and_loss");
    if (resolvedKey !== "voucher_register" && resolvedKey !== "bank_transactions") {
      throw new HttpError(404, res.locals.t("error_not_found"));
    }

    const canView =
      req.user?.isAdmin ||
      res.locals.can("REPORT", "voucher_register", "load") ||
      res.locals.can("REPORT", "bank_transactions", "load");
    if (!canView) {
      throw new HttpError(403, res.locals.t("permission_denied"));
    }

    const requestedVoucherType = String(req.body?.voucher_type || req.query?.voucher_type || "").trim().toLowerCase();
    if (requestedVoucherType && requestedVoucherType !== "bank") {
      throw new HttpError(400, res.locals.t("error_invalid_value"));
    }

    const result = await updateBankVoucherLineStatus({
      req,
      voucherId: req.body?.voucher_id,
      lineId: req.body?.line_id,
      nextStatus: req.body?.status,
    });

    const message = result.queuedForApproval
      ? (result.permissionReroute
        ? (res.locals.t("approval_sent") )
        : res.locals.t("approval_submitted"))
      : res.locals.t("saved_successfully");

    return res.json({
      ok: true,
      queuedForApproval: Boolean(result.queuedForApproval),
      status: result.status,
      message,
    });
  } catch (err) {
    console.error("Error in FinancialReportBankStatusService:", err);
    const statusCode = Number(err?.statusCode || err?.status || 500);
    if (statusCode >= 400 && statusCode < 600) {
      return res.status(statusCode).json({
        ok: false,
        message: err.message || res.locals.t("generic_error"),
      });
    }
    return next(err);
  }
});

const renderFinancialReportPage = async (req, res, next, options = {}) => {
  const {
    inputSource = req.query,
    allowLegacyRedirects = true,
  } = options;

  try {
    const resolvedKey = resolveReportKey(req.params.reportKey, "profit_and_loss");
    const normalizedInput = normalizeFilterInput(inputSource);
    req.reportFilterInput = normalizedInput;

    if (allowLegacyRedirects) {
      if (LEGACY_EXPENSE_REPORT_TYPES.has(resolvedKey)) {
        return res.redirect(`${req.baseUrl}/expense_analysis`);
      }
    }

    const filters = getCommonFilters(req, resolvedKey);

    const allowed = (() => {
      if (req.user?.isAdmin) return true;
      if (resolvedKey === "expense_analysis") {
        const selectedType = String(filters?.reportType || "expense_analysis");
        return res.locals.can("REPORT", "expense_analysis", "load") || res.locals.can("REPORT", selectedType, "load");
      }
      if (resolvedKey !== "voucher_register") return res.locals.can("REPORT", resolvedKey, "load");
      return (
        res.locals.can("REPORT", "voucher_register", "load") ||
        res.locals.can("REPORT", "cash_voucher_register", "load") ||
        res.locals.can("REPORT", "bank_transactions", "load") ||
        res.locals.can("REPORT", "journal_voucher_register", "load")
      );
    })();
    if (!allowed) {
      throw new HttpError(403, res.locals.t("permission_denied"));
    }

    const [report, accounts, branches, expenseFilterOptions] = await Promise.all([
      getFinancialReport(resolvedKey, req, filters),
      getReportAccounts({ reportKey: resolvedKey, req, selectedBranchId: filters.branchId }),
      req.user?.isAdmin
        ? knex("erp.branches").select("id", "name").where({ is_active: true }).orderBy("name", "asc")
        : Promise.resolve(req.branchOptions || []),
      resolvedKey === "expense_analysis"
        ? getExpenseAnalysisFilterOptions({ req, filters })
        : resolvedKey === "expense_trends"
          ? getExpenseTrendFilterOptions({ req, filters })
          : Promise.resolve({ departments: [], cashierAccounts: [], accountGroups: [], accounts: [] }),
    ]);

    const reportTitleText = res.locals.t(report.titleKey || resolvedKey);
    const financialReportsText = res.locals.t("financial_reports");

    return res.render("base/layouts/main", {
      title: `${reportTitleText} - ${financialReportsText}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../reports/accounts",
      t: res.locals.t,
      reportKey: resolvedKey,
      reportRows: report.rows || [],
      reportTitleKey: report.titleKey || resolvedKey,
      filters,
      branches,
      accounts,
      reportMeta: report.meta || null,
      expenseFilterOptions,
      reportPath: `${req.baseUrl}/${resolvedKey}`,
    });
  } catch (err) {
    console.error("Error in FinancialReportsService:", err);
    return next(err);
  } finally {
    delete req.reportFilterInput;
  }
};

router.post("/:reportKey", async (req, res, next) => {
  return renderFinancialReportPage(req, res, next, {
    inputSource: req.body,
    allowLegacyRedirects: false,
  });
});

router.get("/:reportKey", async (req, res, next) => {
  return renderFinancialReportPage(req, res, next, {
    inputSource: req.query,
    allowLegacyRedirects: true,
  });
});

module.exports = router;
