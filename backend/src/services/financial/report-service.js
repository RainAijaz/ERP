const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog } = require("../../utils/audit-log");
const { syncVoucherGlPostingTx } = require("./gl-posting-service");

const ACCOUNT_FILTER_REPORTS = new Set(["account_activity_ledger", "cash_book"]);
const REPORT_MODE_REPORTS = new Set(["account_activity_ledger", "voucher_register", "cash_book"]);
const VOUCHER_REGISTER_REPORTS = new Set(["voucher_register", "cash_voucher_register", "bank_transactions", "journal_voucher_register"]);
const EXPENSE_TREND_GRANULARITY_SET = new Set(["daily", "weekly", "monthly"]);
const EXPENSE_TREND_TOP_DRIVER_LIMIT = 6;
const EXPENSE_VOUCHER_TYPE_BY_FILTER = {
  all: null,
  cash: "CASH_VOUCHER",
  bank: "BANK_VOUCHER",
  journal: "JOURNAL_VOUCHER",
};

const VOUCHER_TYPE_BY_FILTER = {
  cash: "CASH_VOUCHER",
  bank: "BANK_VOUCHER",
  journal: "JOURNAL_VOUCHER",
};
const BANK_LINE_STATUS_SET = new Set(["PENDING", "APPROVED", "REJECTED"]);

const canDo = (req, scopeType, scopeKey, action) => {
  const check = req?.res?.locals?.can;
  if (typeof check !== "function") return false;
  return check(scopeType, scopeKey, action);
};

const resolveVoucherTypeFilter = (value, fallback = "cash") => {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VOUCHER_TYPE_BY_FILTER, key)) return key;
  return fallback;
};
const resolveExpenseVoucherTypeFilter = (value, fallback = "all") => {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EXPENSE_VOUCHER_TYPE_BY_FILTER, key)) return key;
  return fallback;
};
const resolveExpenseTrendGranularity = (value, fallback = "daily") => {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (EXPENSE_TREND_GRANULARITY_SET.has(key)) return key;
  return fallback;
};

const normalizeReportKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const supportsAccountFilter = (reportKey) => ACCOUNT_FILTER_REPORTS.has(normalizeReportKey(reportKey));
const supportsReportModeFilter = (reportKey) => REPORT_MODE_REPORTS.has(normalizeReportKey(reportKey));
const toIdList = (value) => {
  const raw = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      raw
        .flatMap((entry) => String(entry == null ? "" : entry).split(","))
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    ),
  ];
};
const toBool = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (!key) return fallback;
  return key === "1" || key === "true" || key === "yes" || key === "on";
};

const toLocalYmd = (date) => {
  const dt = date instanceof Date ? date : new Date(date);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const toDisplayDmy = (value) => {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "-";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = String(dt.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
};

const parseYmdStrict = (value) => {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isInteger(y) || !Number.isInteger(mm) || !Number.isInteger(dd)) return null;
  const dt = new Date(Date.UTC(y, mm - 1, dd));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
};

const parseDateFilter = (value, fallback) => {
  const v = String(value == null ? "" : value).trim();
  if (!v) {
    return { value: fallback, valid: true, provided: false };
  }
  const normalized = parseYmdStrict(v);
  if (!normalized) {
    return { value: fallback, valid: false, provided: true };
  }
  return { value: normalized, valid: true, provided: true };
};

const buildDateFilter = (query, column, fromDate, toDate) => {
  let q = query;
  if (fromDate) q = q.where(column, ">=", fromDate);
  if (toDate) q = q.where(column, "<=", toDate);
  return q;
};

const getCommonFilters = (req, reportKey = "") => {
  const requestInput =
    req && req.reportFilterInput && typeof req.reportFilterInput === "object"
      ? req.reportFilterInput
      : req?.query && typeof req.query === "object"
        ? req.query
        : {};
  const normalizedReportKey = normalizeReportKey(reportKey);
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 30);
  const today = toLocalYmd(now);
  const defaultFrom = toLocalYmd(fromDate);
  const parsedFrom = parseDateFilter(requestInput.from_date, defaultFrom);
  const parsedTo = parseDateFilter(requestInput.to_date, today);
  let from = parsedFrom.value;
  let to = parsedTo.value;
  const invalidFromDate = Boolean(parsedFrom.provided && !parsedFrom.valid);
  const invalidToDate = Boolean(parsedTo.provided && !parsedTo.valid);
  let invalidDateRange = false;
  if (from > to) {
    from = defaultFrom;
    to = today;
    invalidDateRange = true;
  }
  let branchId = req.branchId;
  let branchIds = [];
  const branchIdsFromQuery = toIdList(requestInput.branch_ids);
  if (req.user?.isAdmin) {
    const hasBranchParam = Object.prototype.hasOwnProperty.call(requestInput, "branch_id");
    if (branchIdsFromQuery.length) {
      branchIds = branchIdsFromQuery;
      branchId = branchIds.length === 1 ? branchIds[0] : null;
    } else if (hasBranchParam) {
      const selected = Number(requestInput.branch_id || 0);
      branchId = Number.isInteger(selected) && selected > 0 ? selected : null;
      branchIds = branchId ? [branchId] : [];
    } else {
      if (normalizedReportKey === "expense_analysis" || normalizedReportKey === "expense_trends") {
        branchId = null;
        branchIds = [];
      } else {
        branchId = Number(req.branchId || 0) || null;
        branchIds = branchId ? [branchId] : [];
      }
    }
  } else {
    branchId = Number(req.branchId || 0) || null;
    branchIds = branchId ? [branchId] : [];
  }
  const accountId = supportsAccountFilter(normalizedReportKey) ? Number(requestInput.account_id || 0) || null : null;
  const reportMode =
    supportsReportModeFilter(normalizedReportKey) &&
    String(requestInput.report_mode || "details")
      .trim()
      .toLowerCase() === "summary"
      ? "summary"
      : "details";

  let voucherType = normalizedReportKey === "expense_analysis"
    ? resolveExpenseVoucherTypeFilter(requestInput.voucher_type, "all")
    : resolveVoucherTypeFilter(requestInput.voucher_type, "cash");
  if (normalizedReportKey === "cash_voucher_register") voucherType = "cash";
  if (normalizedReportKey === "bank_transactions") voucherType = "bank";
  if (normalizedReportKey === "journal_voucher_register") voucherType = "journal";
  const reportType = normalizedReportKey === "expense_analysis" ? "department_breakdown" : null;
  const reportLoaded = (normalizedReportKey === "expense_analysis" || normalizedReportKey === "expense_trends")
    ? toBool(requestInput.load_report, false)
    : true;
  const departmentIds = normalizedReportKey === "expense_analysis" ? toIdList(requestInput.department_ids) : [];
  const breakdownStart =
    normalizedReportKey === "expense_analysis"
      ? (() => {
          const raw = String(requestInput.breakdown_start || "department")
            .trim()
            .toLowerCase();
          return raw === "group" || raw === "account" ? raw : "department";
        })()
      : "department";
  const cashierAccountId = normalizedReportKey === "expense_analysis" ? Number(requestInput.cashier_account_id || 0) || null : null;
  const trendGranularity =
    normalizedReportKey === "expense_trends" ? resolveExpenseTrendGranularity(requestInput.time_granularity, "daily") : null;
  const trendAccountGroupId = normalizedReportKey === "expense_trends" ? Number(requestInput.account_group_id || 0) || null : null;
  const trendAccountId = normalizedReportKey === "expense_trends" ? Number(requestInput.trend_account_id || 0) || null : null;

  return {
    from,
    to,
    branchId,
    branchIds,
    accountId,
    reportMode,
    voucherType,
    reportType,
    reportLoaded,
    departmentIds,
    breakdownStart,
    cashierAccountId,
    trendGranularity,
    trendAccountGroupId,
    trendAccountId,
    invalidFromDate,
    invalidToDate,
    invalidDateRange,
    invalidFilterInput: invalidFromDate || invalidToDate || invalidDateRange,
  };
};

const baseLedger = ({ from, to, branchId, accountId }) => {
  let query = knex("erp.gl_entry as ge").select("ge.entry_date", "ge.branch_id", "ge.account_id", "a.name as account_name", "vh.voucher_type_code", "vh.voucher_no", "vh.status as voucher_status", "ge.dr", "ge.cr", "ge.narration").leftJoin("erp.accounts as a", "a.id", "ge.account_id").leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id").leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id").orderBy("ge.entry_date", "desc");

  query = buildDateFilter(query, "ge.entry_date", from, to);
  if (branchId) query = query.where("ge.branch_id", branchId);
  if (accountId) query = query.where("ge.account_id", accountId);
  return query;
};

const getCashBook = async (filters) => {
  const includeBranchColumn = !filters.branchId;
  const selectedCashAccountId = Number(filters.accountId || 0) || null;

  const cashAccountScope = (queryBuilder) => {
    queryBuilder.join("erp.accounts as a", "a.id", "ge.account_id").join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id").whereRaw("upper(COALESCE(apc.code, '')) = 'CASH'");
    if (selectedCashAccountId) {
      queryBuilder.andWhere("ge.account_id", selectedCashAccountId);
    }
  };

  const openingRow = await knex("erp.gl_entry as ge")
    .leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
    .modify(cashAccountScope)
    .select(knex.raw("COALESCE(SUM(COALESCE(ge.dr, 0) - COALESCE(ge.cr, 0)), 0) as opening_balance"))
    .where(function whereApprovedOrManual() {
      this.whereNull("vh.id").orWhere("vh.status", "APPROVED");
    })
    .modify((queryBuilder) => {
      if (filters.branchId) queryBuilder.where("ge.branch_id", filters.branchId);
      if (filters.from) queryBuilder.where("ge.entry_date", "<", filters.from);
    })
    .first();

  const selectedAccount = selectedCashAccountId ? await knex("erp.accounts").select("id", "name").where({ id: selectedCashAccountId }).first() : null;
  const boundaryCashAccount = selectedAccount?.name || null;
  const openingBalance = Number(openingRow?.opening_balance || 0);

  const createBoundaryRow = (voucherTypeCode, entryDate, balance, totals = null) => {
    const payload = {
      entry_date: entryDate || null,
      voucher_type_code: voucherTypeCode,
      voucher_no: null,
      cash_account: boundaryCashAccount,
      entity: filters.reportMode === "details" ? null : undefined,
      description: null,
      dr: Number(totals?.dr || 0),
      cr: Number(totals?.cr || 0),
      running_balance: Number(balance.toFixed(2)),
    };
    if (filters.reportMode !== "details") delete payload.entity;
    if (includeBranchColumn) payload.branch = null;
    return payload;
  };

  let rows = [];
  if (filters.reportMode === "summary") {
    let summaryQuery = knex("erp.gl_entry as ge")
      .leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
      .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
      .leftJoin("erp.accounts as a", "a.id", "ge.account_id")
      .leftJoin("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
      .leftJoin("erp.branches as b", "b.id", "ge.branch_id")
      .select(knex.raw("to_char(ge.entry_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_type_code", "vh.voucher_no", "a.name as cash_account", "b.name as branch_name", knex.raw("COALESCE(MAX(NULLIF(vh.remarks,'')), MAX(NULLIF(ge.narration,''))) as description"), knex.raw("COALESCE(SUM(COALESCE(ge.dr,0)), 0) as dr"), knex.raw("COALESCE(SUM(COALESCE(ge.cr,0)), 0) as cr"))
      .where(function whereApprovedOrManual() {
        this.whereNull("vh.id").orWhere("vh.status", "APPROVED");
      })
      .whereRaw("upper(COALESCE(apc.code, '')) = 'CASH'")
      .groupBy("ge.entry_date", "vh.voucher_type_code", "vh.voucher_no", "a.name", "b.name")
      .orderBy("ge.entry_date", "asc")
      .orderBy("vh.voucher_no", "asc");

    if (selectedCashAccountId) summaryQuery = summaryQuery.where("ge.account_id", selectedCashAccountId);
    summaryQuery = buildDateFilter(summaryQuery, "ge.entry_date", filters.from, filters.to);
    if (filters.branchId) summaryQuery = summaryQuery.where("ge.branch_id", filters.branchId);
    rows = await summaryQuery;
  } else {
    // Detail mode: show voucher-line granularity for every voucher that impacts cash.
    let detailsQuery = knex("erp.voucher_header as vh")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .leftJoin("erp.accounts as ah", "ah.id", "vh.header_account_id")
      .leftJoin("erp.accounts as a", "a.id", "vl.account_id")
      .leftJoin("erp.parties as p", "p.id", "vl.party_id")
      .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
      .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
      .leftJoin("erp.account_posting_classes as apch", "apch.id", "ah.posting_class_id")
      .leftJoin("erp.account_posting_classes as apcl", "apcl.id", "a.posting_class_id")
      .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
      .select(
        knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"),
        "vh.voucher_type_code",
        "vh.voucher_no",
        knex.raw(`
          CASE
            WHEN vh.voucher_type_code IN ('CASH_VOUCHER','BANK_VOUCHER') THEN ah.name
            ELSE COALESCE((
              SELECT a2.name
              FROM erp.voucher_line vl2
              JOIN erp.accounts a2 ON a2.id = vl2.account_id
              JOIN erp.account_posting_classes apc2 ON apc2.id = a2.posting_class_id
              WHERE vl2.voucher_header_id = vh.id
                AND upper(COALESCE(apc2.code, '')) = 'CASH'
              ORDER BY vl2.line_no ASC
              LIMIT 1
            ), ah.name)
          END as cash_account
        `),
        knex.raw("COALESCE(a.name, p.name, l.name, e.name, NULL) as entity"),
        "b.name as branch_name",
        knex.raw("COALESCE(NULLIF(vl.meta->>'description', ''), NULLIF(vh.remarks, '')) as description"),
        knex.raw("COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0) as dr"),
        knex.raw("COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0) as cr"),
        "vl.id",
      )
      .where("vh.status", "APPROVED")
      .whereIn("vh.voucher_type_code", ["CASH_VOUCHER", "BANK_VOUCHER", "JOURNAL_VOUCHER"])
      .andWhere("vl.line_kind", "ACCOUNT")
      .andWhere(function excludeJournalCashRows() {
        this.whereNot("vh.voucher_type_code", "JOURNAL_VOUCHER")
          .orWhereRaw("upper(COALESCE(apcl.code, '')) <> 'CASH'");
      })
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc")
      .orderBy("vl.id", "asc");

    if (selectedCashAccountId) {
      detailsQuery = detailsQuery.where(function scopeSelectedCash() {
        this.where(function cashOrBankByHeader() {
          this.whereIn("vh.voucher_type_code", ["CASH_VOUCHER", "BANK_VOUCHER"])
            .andWhere("vh.header_account_id", selectedCashAccountId);
        }).orWhere(function journalByCashLine() {
          this.where("vh.voucher_type_code", "JOURNAL_VOUCHER")
            .whereExists(function cashLineExists() {
              this.select(1)
                .from("erp.voucher_line as jvl")
                .whereRaw("jvl.voucher_header_id = vh.id")
                .andWhere("jvl.account_id", selectedCashAccountId);
            });
        });
      });
    } else {
      detailsQuery = detailsQuery.where(function anyCashImpactVoucher() {
        this.where(function cashOrBankHeaderClass() {
          this.whereIn("vh.voucher_type_code", ["CASH_VOUCHER", "BANK_VOUCHER"])
            .whereRaw("upper(COALESCE(apch.code, '')) = 'CASH'");
        }).orWhere(function journalHasCashLine() {
          this.where("vh.voucher_type_code", "JOURNAL_VOUCHER")
            .whereExists(function cashLineExists() {
              this.select(1)
                .from("erp.voucher_line as jvl")
                .join("erp.accounts as ja", "ja.id", "jvl.account_id")
                .join("erp.account_posting_classes as japc", "japc.id", "ja.posting_class_id")
                .whereRaw("jvl.voucher_header_id = vh.id")
                .whereRaw("upper(COALESCE(japc.code, '')) = 'CASH'");
            });
        });
      });
    }

    detailsQuery = buildDateFilter(detailsQuery, "vh.voucher_date", filters.from, filters.to);
    if (filters.branchId) detailsQuery = detailsQuery.where("vh.branch_id", filters.branchId);
    rows = await detailsQuery;
  }

  let running = openingBalance;
  const detailRows = rows
    .map((row) => {
      const dr = Number(row.dr || 0);
      const cr = Number(row.cr || 0);
      running += dr - cr;
      const payload = {
        entry_date: row.entry_date,
        voucher_type_code: row.voucher_type_code,
        voucher_no: row.voucher_no,
        cash_account: row.cash_account || null,
        entity: row.entity || null,
        description: row.description || null,
        dr,
        cr,
        running_balance: Number(running.toFixed(2)),
      };
      if (includeBranchColumn) payload.branch = row.branch_name || null;
      return payload;
    })
    .filter((row) => Number(row.dr || 0) !== 0 || Number(row.cr || 0) !== 0);

  const totals = {
    dr: Number(
      detailRows.reduce((sum, row) => sum + Number(row.dr || 0), 0).toFixed(2),
    ),
    cr: Number(
      detailRows.reduce((sum, row) => sum + Number(row.cr || 0), 0).toFixed(2),
    ),
  };

  if (filters.reportMode === "details") {
    return [
      ...detailRows,
      createBoundaryRow("CLOSING_BALANCE", filters.to, running, totals),
    ];
  }

  return [
    createBoundaryRow("OPENING_BALANCE", filters.from, openingBalance),
    ...detailRows,
    createBoundaryRow("CLOSING_BALANCE", filters.to, running, totals),
  ];
};

const requiresApprovalForVoucherAction = async (trx, voucherTypeCode, action) => {
  const policy = await trx("erp.approval_policy").select("requires_approval").where({ entity_type: "VOUCHER_TYPE", entity_key: voucherTypeCode, action }).first();
  if (policy) return policy.requires_approval === true;
  return false;
};

const queueVoucherApprovalRequest = async ({ trx, req, voucherId, voucherTypeCode, summary, oldValue = null, newValue = null }) => {
  const [row] = await trx("erp.approval_request")
    .insert({
      branch_id: req.branchId,
      request_type: "VOUCHER",
      entity_type: "VOUCHER",
      entity_id: String(voucherId),
      summary,
      old_value: oldValue,
      new_value: newValue,
      requested_by: req.user.id,
    })
    .returning(["id"]);

  await insertActivityLog(trx, {
    branch_id: req.branchId,
    user_id: req.user.id,
    entity_type: "VOUCHER",
    entity_id: String(voucherId),
    voucher_type_code: voucherTypeCode,
    action: "SUBMIT",
    ip_address: req.ip,
    context: {
      approval_request_id: row?.id || null,
      summary,
      old_value: oldValue,
      new_value: newValue,
      source: "financial-report-service",
    },
  });

  return row?.id || null;
};

const updateBankVoucherLineStatus = async ({ req, voucherId, lineId, nextStatus }) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherId = Number(voucherId || 0);
  const normalizedLineId = Number(lineId || 0);
  const normalizedStatus = String(nextStatus || "")
    .trim()
    .toUpperCase();
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0) {
    throw new HttpError(400, "Invalid voucher id");
  }
  if (!Number.isInteger(normalizedLineId) || normalizedLineId <= 0) {
    throw new HttpError(400, "Invalid voucher line id");
  }
  if (!BANK_LINE_STATUS_SET.has(normalizedStatus)) {
    throw new HttpError(400, "Invalid bank status");
  }

  const canEdit = canDo(req, "VOUCHER", "BANK_VOUCHER", "edit");

  const result = await knex.transaction(async (trx) => {
    const row = await trx("erp.voucher_line as vl")
      .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
      .select("vl.id as line_id", "vl.voucher_header_id", "vl.line_no", "vl.meta", "vh.id as voucher_id", "vh.voucher_no", "vh.status as voucher_status", "vh.voucher_type_code")
      .where({
        "vh.id": normalizedVoucherId,
        "vh.branch_id": req.branchId,
        "vh.voucher_type_code": "BANK_VOUCHER",
        "vl.id": normalizedLineId,
      })
      .first();
    if (!row) throw new HttpError(404, "Bank voucher line not found");

    const currentStatus = String(row?.meta?.bank_status || row?.voucher_status || "PENDING")
      .trim()
      .toUpperCase();
    if (currentStatus === normalizedStatus) {
      return {
        voucherId: Number(row.voucher_id),
        voucherNo: Number(row.voucher_no),
        lineId: Number(row.line_id),
        lineNo: Number(row.line_no),
        status: currentStatus,
        queuedForApproval: false,
        permissionReroute: false,
        updated: false,
        approvalRequestId: null,
      };
    }

    const policyRequiresApproval = await requiresApprovalForVoucherAction(trx, "BANK_VOUCHER", "edit");
    const queuedForApproval = policyRequiresApproval || !canEdit;
    if (queuedForApproval) {
      const approvalRequestId = await queueVoucherApprovalRequest({
        trx,
        req,
        voucherId: Number(row.voucher_id),
        voucherTypeCode: "BANK_VOUCHER",
        summary: `UPDATE BANK_VOUCHER #${Number(row.voucher_no)} line ${Number(row.line_no)} status`,
        oldValue: {
          line_id: Number(row.line_id),
          line_no: Number(row.line_no),
          bank_status: currentStatus,
        },
        newValue: {
          action: "update_bank_line_status",
          voucher_id: Number(row.voucher_id),
          voucher_no: Number(row.voucher_no),
          line_id: Number(row.line_id),
          line_no: Number(row.line_no),
          bank_status: normalizedStatus,
          permission_reroute: !canEdit,
        },
      });
      return {
        voucherId: Number(row.voucher_id),
        voucherNo: Number(row.voucher_no),
        lineId: Number(row.line_id),
        lineNo: Number(row.line_no),
        status: currentStatus,
        queuedForApproval: true,
        permissionReroute: !canEdit,
        updated: false,
        approvalRequestId,
      };
    }

    await trx("erp.voucher_line")
      .where({ id: Number(row.line_id) })
      .update({
        meta: trx.raw("jsonb_set(COALESCE(meta, '{}'::jsonb), '{bank_status}', to_jsonb(?::text), true)", [normalizedStatus]),
      });

    await syncVoucherGlPostingTx({ trx, voucherId: Number(row.voucher_id) });

    await insertActivityLog(trx, {
      branch_id: req.branchId,
      user_id: req.user.id,
      entity_type: "VOUCHER",
      entity_id: String(row.voucher_id),
      voucher_type_code: "BANK_VOUCHER",
      action: "UPDATE",
      ip_address: req.ip,
      context: {
        source: "financial-report-service",
        field: "bank_status",
        line_id: Number(row.line_id),
        line_no: Number(row.line_no),
        from: currentStatus,
        to: normalizedStatus,
      },
    });

    return {
      voucherId: Number(row.voucher_id),
      voucherNo: Number(row.voucher_no),
      lineId: Number(row.line_id),
      lineNo: Number(row.line_no),
      status: normalizedStatus,
      queuedForApproval: false,
      permissionReroute: false,
      updated: true,
      approvalRequestId: null,
    };
  });

  return result;
};

const getVoucherRegister = async (filters) => {
  const voucherTypeCode = VOUCHER_TYPE_BY_FILTER[resolveVoucherTypeFilter(filters.voucherType, "cash")] || "CASH_VOUCHER";
  const includeBranchColumn = !filters.branchId;
  const includeBankStatus = voucherTypeCode === "BANK_VOUCHER";
  const includeBankReferenceNoInSummary = false;
  const includeBankReferenceNoInDetails = voucherTypeCode === "BANK_VOUCHER";
  const includeAgainstAccountInBankDetails = voucherTypeCode === "BANK_VOUCHER";
  const includeBankAccountInBankDetails = voucherTypeCode === "BANK_VOUCHER";
  const includeDescriptionInDetails = voucherTypeCode !== "BANK_VOUCHER";
  const includeDepartmentInDetails = voucherTypeCode !== "BANK_VOUCHER";

  if (voucherTypeCode === "CASH_VOUCHER" && filters.reportMode === "summary") {
    let summaryQuery = knex("erp.voucher_header as vh")
      .leftJoin("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .leftJoin("erp.accounts as ah", "ah.id", "vh.header_account_id")
      .leftJoin("erp.users as u", "u.id", "vh.created_by")
      .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
      .select(knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_no", "b.name as branch_name", knex.raw("COALESCE(NULLIF(vh.remarks, ''), NULL) as note"), "ah.name as cash_account", knex.raw("COALESCE(NULLIF(u.name, ''), u.username) as created_by"), knex.raw("COALESCE(SUM(COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)), 0) as total_dr"), knex.raw("COALESCE(SUM(COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)), 0) as total_cr"))
      .where("vh.voucher_type_code", voucherTypeCode)
      .andWhere("vh.status", "APPROVED")
      .groupBy("vh.id", "vh.voucher_date", "vh.voucher_no", "b.name", "vh.remarks", "ah.name", "u.name", "u.username")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc");

    summaryQuery = buildDateFilter(summaryQuery, "vh.voucher_date", filters.from, filters.to);
    if (filters.branchId) summaryQuery = summaryQuery.where("vh.branch_id", filters.branchId);

    const rows = await summaryQuery;
    return rows.map((row) => {
      const totalDr = Number(row.total_dr || 0);
      const totalCr = Number(row.total_cr || 0);
      const payload = {
        entry_date: row.entry_date,
        voucher_no: row.voucher_no,
        voucher_subtype: totalDr >= totalCr ? "CASH_RECEIPT" : "CASH_PAYMENT",
        note: row.note || null,
        cash_account: row.cash_account || null,
        amount: Number(Math.max(totalDr, totalCr).toFixed(2)),
        created_by: row.created_by || null,
      };
      if (includeBranchColumn) payload.branch = row.branch_name || null;
      return payload;
    });
  }

  if (voucherTypeCode === "CASH_VOUCHER" && filters.reportMode === "details") {
    let detailsQuery = knex("erp.voucher_header as vh")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .leftJoin("erp.accounts as ah", "ah.id", "vh.header_account_id")
      .leftJoin("erp.accounts as a", "a.id", "vl.account_id")
      .leftJoin("erp.parties as p", "p.id", "vl.party_id")
      .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
      .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
      .leftJoin("erp.departments as d", knex.raw("d.id = NULLIF(vl.meta->>'department_id','')::bigint"))
      .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
      .select(knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_no", "b.name as branch_name", "ah.name as cash_account", knex.raw("COALESCE(a.name, p.name, l.name, e.name, NULL) as against_account"), knex.raw("NULLIF(vl.meta->>'description','') as description"), "d.name as department", knex.raw("COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0) as dr"), knex.raw("COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0) as cr"), "vl.line_no")
      .where("vh.voucher_type_code", voucherTypeCode)
      .andWhere("vh.status", "APPROVED")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");

    detailsQuery = buildDateFilter(detailsQuery, "vh.voucher_date", filters.from, filters.to);
    if (filters.branchId) detailsQuery = detailsQuery.where("vh.branch_id", filters.branchId);

    const rows = await detailsQuery;
    return rows
      .map((row) => {
        const payload = {
          entry_date: row.entry_date,
          voucher_no: row.voucher_no,
          cash_account: row.cash_account || null,
          against_account: row.against_account || null,
          description: row.description || null,
          department: row.department || null,
          dr: Number(row.dr || 0),
          cr: Number(row.cr || 0),
        };
        if (includeBranchColumn) payload.branch = row.branch_name || null;
        return payload;
      })
      .filter((row) => Number(row.dr || 0) !== 0 || Number(row.cr || 0) !== 0);
  }

  if (voucherTypeCode === "JOURNAL_VOUCHER" && filters.reportMode === "summary") {
    let summaryQuery = knex("erp.voucher_header as vh")
      .leftJoin("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .leftJoin("erp.users as u", "u.id", "vh.created_by")
      .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
      .select(knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_no", "b.name as branch_name", knex.raw("COALESCE(NULLIF(vh.remarks, ''), NULL) as note"), knex.raw("COALESCE(NULLIF(u.name, ''), u.username) as created_by"), knex.raw("COALESCE(SUM(COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)), 0) as total_debit"), knex.raw("COALESCE(SUM(COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)), 0) as total_credit"))
      .where("vh.voucher_type_code", voucherTypeCode)
      .andWhere("vh.status", "APPROVED")
      .groupBy("vh.id", "vh.voucher_date", "vh.voucher_no", "b.name", "vh.remarks", "u.name", "u.username")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc");

    summaryQuery = buildDateFilter(summaryQuery, "vh.voucher_date", filters.from, filters.to);
    if (filters.branchId) summaryQuery = summaryQuery.where("vh.branch_id", filters.branchId);

    const rows = await summaryQuery;
    return rows.map((row) => {
      const payload = {
        entry_date: row.entry_date,
        voucher_no: row.voucher_no,
        note: row.note || null,
        total_debit: Number(row.total_debit || 0),
        total_credit: Number(row.total_credit || 0),
        created_by: row.created_by || null,
      };
      if (includeBranchColumn) payload.branch = row.branch_name || null;
      return payload;
    });
  }

  if (voucherTypeCode === "JOURNAL_VOUCHER" && filters.reportMode === "details") {
    let detailsQuery = knex("erp.voucher_header as vh")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .leftJoin("erp.accounts as a", "a.id", "vl.account_id")
      .leftJoin("erp.parties as p", "p.id", "vl.party_id")
      .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
      .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
      .leftJoin("erp.departments as d", knex.raw("d.id = NULLIF(vl.meta->>'department_id','')::bigint"))
      .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
      .select(knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_no", "b.name as branch_name", knex.raw("COALESCE(a.name, p.name, l.name, e.name, NULL) as account_name"), knex.raw("NULLIF(vl.meta->>'description','') as description"), "d.name as department", knex.raw("COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0) as dr"), knex.raw("COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0) as cr"), "vl.line_no")
      .where("vh.voucher_type_code", voucherTypeCode)
      .andWhere("vh.status", "APPROVED")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");

    detailsQuery = buildDateFilter(detailsQuery, "vh.voucher_date", filters.from, filters.to);
    if (filters.branchId) detailsQuery = detailsQuery.where("vh.branch_id", filters.branchId);

    const rows = await detailsQuery;
    return rows
      .map((row) => {
        const payload = {
          entry_date: row.entry_date,
          voucher_no: row.voucher_no,
          account_name: row.account_name || null,
          description: row.description || null,
          department: row.department || null,
          dr: Number(row.dr || 0),
          cr: Number(row.cr || 0),
        };
        if (includeBranchColumn) payload.branch = row.branch_name || null;
        return payload;
      })
      .filter((row) => Number(row.dr || 0) !== 0 || Number(row.cr || 0) !== 0);
  }

  if (filters.reportMode === "summary") {
    let summaryQuery = knex("erp.voucher_header as vh")
      .leftJoin("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
      .select(knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_type_code", "vh.voucher_no", "b.name as branch_name", knex.raw("COALESCE(SUM(COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)), 0) as dr"), knex.raw("COALESCE(SUM(COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)), 0) as cr"))
      .where("vh.voucher_type_code", voucherTypeCode)
      .groupBy("vh.id", "vh.voucher_date", "vh.voucher_type_code", "vh.voucher_no", "b.name")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc");

    if (includeBankStatus) {
      summaryQuery = summaryQuery.select(
        knex.raw(`
            CASE
              WHEN SUM(CASE WHEN upper(COALESCE(vl.meta->>'bank_status','')) = 'REJECTED' THEN 1 ELSE 0 END) > 0 THEN 'REJECTED'
              WHEN SUM(CASE WHEN upper(COALESCE(vl.meta->>'bank_status','')) = 'PENDING' THEN 1 ELSE 0 END) > 0 THEN 'PENDING'
              WHEN SUM(CASE WHEN upper(COALESCE(vl.meta->>'bank_status','')) = 'APPROVED' THEN 1 ELSE 0 END) > 0 THEN 'APPROVED'
              ELSE upper(COALESCE(vh.status::text, 'PENDING'))
            END as status
          `),
      );
    }
    if (includeBankReferenceNoInSummary) {
      summaryQuery = summaryQuery.select(knex.raw("COUNT(DISTINCT NULLIF(COALESCE(vl.reference_no, vl.meta->>'reference_no', ''), '')) as reference_count"), knex.raw("MIN(NULLIF(COALESCE(vl.reference_no, vl.meta->>'reference_no', ''), '')) as reference_first"));
    }

    summaryQuery = buildDateFilter(summaryQuery, "vh.voucher_date", filters.from, filters.to);
    if (filters.branchId) summaryQuery = summaryQuery.where("vh.branch_id", filters.branchId);

    const rows = await summaryQuery;
    return rows.map((row) => {
      const payload = {
        entry_date: row.entry_date,
        voucher_no: row.voucher_no,
      };
      if (!includeBankStatus) payload.voucher_type_code = row.voucher_type_code;
      if (includeBankReferenceNoInSummary) {
        const referenceCount = Number(row.reference_count || 0);
        payload.reference_no = referenceCount <= 0 ? null : referenceCount === 1 ? row.reference_first || null : "Multiple";
      }
      payload.dr = Number(row.dr || 0);
      payload.cr = Number(row.cr || 0);
      if (includeBankStatus) payload.status = String(row.status || "PENDING").toUpperCase();
      if (includeBranchColumn) payload.branch = row.branch_name || null;
      return payload;
    });
  }

  let detailQuery = knex("erp.voucher_header as vh")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .leftJoin("erp.accounts as bh", "bh.id", "vh.header_account_id")
    .leftJoin("erp.voucher_header as svh", knex.raw("svh.id = NULLIF(vl.meta->>'source_voucher_id','')::bigint"))
    .leftJoin("erp.accounts as sa", "sa.id", "svh.header_account_id")
    .leftJoin("erp.accounts as a", "a.id", "vl.account_id")
    .leftJoin("erp.parties as p", "p.id", "vl.party_id")
    .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
    .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
    .leftJoin("erp.departments as d", knex.raw("d.id = NULLIF(vl.meta->>'department_id','')::bigint"))
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .select(knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_no", "b.name as branch_name", "vh.id as voucher_id", "vl.id as line_id", "vl.line_no", knex.raw("COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0) as dr"), knex.raw("COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0) as cr"))
    .where("vh.voucher_type_code", voucherTypeCode)
    .orderBy("vh.voucher_date", "asc")
    .orderBy("vh.voucher_no", "asc")
    .orderBy("vl.line_no", "asc");

  if (!includeBankStatus) {
    detailQuery = detailQuery.select("vh.voucher_type_code");
  }
  if (includeDescriptionInDetails) {
    detailQuery = detailQuery.select(knex.raw("NULLIF(vl.meta->>'description','') as description"));
  }
  if (includeDepartmentInDetails) {
    detailQuery = detailQuery.select("d.name as department");
  }

  if (includeBankStatus) {
    detailQuery = detailQuery.select(knex.raw("upper(COALESCE(vl.meta->>'bank_status', vh.status::text, 'PENDING')) as status"));
  }
  if (includeBankAccountInBankDetails) {
    detailQuery = detailQuery.select(knex.raw("COALESCE(bh.name, a.name, NULL) as bank_account"));
  }
  if (includeAgainstAccountInBankDetails) {
    detailQuery = detailQuery.select(
      knex.raw(`
      CASE
        WHEN
          vh.remarks LIKE '[AUTO_BANK_SETTLEMENT]%' AND
          upper(COALESCE(NULLIF(vl.meta->>'source_voucher_type_code',''), svh.voucher_type_code, '')) = 'CASH_VOUCHER' AND
          COALESCE(vl.account_id, 0) = COALESCE(vh.header_account_id, -1) AND
          COALESCE(svh.header_account_id, 0) > 0
        THEN sa.name
        ELSE COALESCE(a.name, p.name, l.name, e.name, NULL)
      END as counterparty
    `),
    );
  }
  if (includeBankReferenceNoInDetails) {
    detailQuery = detailQuery.select(knex.raw("NULLIF(COALESCE(vl.reference_no, vl.meta->>'reference_no', ''), '') as reference_no"));
  }

  detailQuery = buildDateFilter(detailQuery, "vh.voucher_date", filters.from, filters.to);
  if (filters.branchId) detailQuery = detailQuery.where("vh.branch_id", filters.branchId);

  const rows = await detailQuery;
  return rows
    .map((row) => {
      const payload = {
        entry_date: row.entry_date,
        voucher_no: row.voucher_no,
      };
      if (!includeBankStatus) payload.voucher_type_code = row.voucher_type_code;
      if (includeBankAccountInBankDetails) payload.bank_account = row.bank_account || null;
      if (includeAgainstAccountInBankDetails) payload.counterparty = row.counterparty || null;
      if (includeBankReferenceNoInDetails) payload.reference_no = row.reference_no || null;
      if (includeDescriptionInDetails) payload.description = row.description || null;
      if (includeDepartmentInDetails) payload.department = row.department || null;
      if (includeBranchColumn) payload.branch = row.branch_name || null;
      payload.dr = Number(row.dr || 0);
      payload.cr = Number(row.cr || 0);
      if (includeBankStatus) {
        payload.status = String(row.status || "PENDING").toUpperCase();
        payload._voucher_id = Number(row.voucher_id || 0) || null;
        payload._line_id = Number(row.line_id || 0) || null;
        payload._line_no = Number(row.line_no || 0) || null;
      }
      return payload;
    })
    .filter((row) => Number(row.dr || 0) !== 0 || Number(row.cr || 0) !== 0);
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const formatYmd = (value) => {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return toLocalYmd(dt);
};
const getPreviousPeriodRange = (fromDate, toDate) => {
  const from = formatYmd(fromDate);
  const to = formatYmd(toDate);
  if (!from || !to) return null;
  const fromDt = new Date(`${from}T00:00:00`);
  const toDt = new Date(`${to}T00:00:00`);
  if (Number.isNaN(fromDt.getTime()) || Number.isNaN(toDt.getTime()) || toDt < fromDt) return null;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const spanDays = Math.max(1, Math.floor((toDt.getTime() - fromDt.getTime()) / oneDayMs) + 1);
  const prevTo = new Date(fromDt.getTime() - oneDayMs);
  const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * oneDayMs);
  return {
    from: toLocalYmd(prevFrom),
    to: toLocalYmd(prevTo),
  };
};

const parseYmdDate = (value) => {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
};
const startOfBucket = (date, granularity) => {
  const dt = new Date(date.getTime());
  dt.setHours(0, 0, 0, 0);
  if (granularity === "weekly") {
    const day = dt.getDay();
    const shift = (day + 6) % 7;
    dt.setDate(dt.getDate() - shift);
    return dt;
  }
  if (granularity === "monthly") {
    dt.setDate(1);
    return dt;
  }
  return dt;
};
const addBucketStep = (date, granularity) => {
  const dt = new Date(date.getTime());
  if (granularity === "weekly") {
    dt.setDate(dt.getDate() + 7);
    return dt;
  }
  if (granularity === "monthly") {
    dt.setMonth(dt.getMonth() + 1, 1);
    return dt;
  }
  dt.setDate(dt.getDate() + 1);
  return dt;
};
const endOfBucket = (startDate, granularity) => {
  const next = addBucketStep(startDate, granularity);
  next.setDate(next.getDate() - 1);
  next.setHours(0, 0, 0, 0);
  return next;
};
const enumerateBucketKeys = (fromDate, toDate, granularity) => {
  const from = parseYmdDate(fromDate);
  const to = parseYmdDate(toDate);
  if (!from || !to || to < from) return [];
  const keys = [];
  let cursor = startOfBucket(from, granularity);
  const maxEnd = new Date(to.getTime());
  maxEnd.setHours(0, 0, 0, 0);
  while (cursor <= maxEnd) {
    keys.push(toLocalYmd(cursor));
    cursor = addBucketStep(cursor, granularity);
  }
  return keys;
};
const getBucketSql = (granularity, dateColumn = "ge.entry_date") => {
  if (granularity === "weekly") return `to_char(date_trunc('week', ${dateColumn}), 'YYYY-MM-DD')`;
  if (granularity === "monthly") return `to_char(date_trunc('month', ${dateColumn}), 'YYYY-MM-DD')`;
  return `to_char(date_trunc('day', ${dateColumn}), 'YYYY-MM-DD')`;
};
const toTrendPeriodLabel = (bucketStartKey, granularity) => {
  const start = parseYmdDate(bucketStartKey);
  if (!start) return bucketStartKey || "-";
  const end = endOfBucket(start, granularity);
  if (granularity === "daily") return toDisplayDmy(start);
  const endKey = toLocalYmd(end);
  if (granularity === "weekly") return `${toDisplayDmy(start)} - ${toDisplayDmy(endKey)}`;
  const mm = String(start.getMonth() + 1).padStart(2, "0");
  const yyyy = String(start.getFullYear());
  return `${mm}-${yyyy}`;
};
const getExpenseTrendBuckets = async (filters, fromDate, toDate, granularity) => {
  const bucketSql = getBucketSql(granularity, "vh.voucher_date");
  let query = knex("erp.voucher_header as vh")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.accounts as a", "a.id", "vl.account_id")
    .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .select(
      knex.raw(`${bucketSql} as bucket_key`),
      knex.raw(`
        COALESCE(SUM(
          COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)
        ), 0) as gross_expense
      `),
      knex.raw(`
        COALESCE(SUM(
          COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)
        ), 0) as credits_adjustments
      `),
      knex.raw(`
        COALESCE(SUM(
          COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0) -
          COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)
        ), 0) as net_expense
      `),
    )
    .where("ag.account_type", "EXPENSE")
    .where("vh.status", "APPROVED")
    .andWhere("vl.line_kind", "ACCOUNT")
    .groupByRaw(bucketSql)
    .orderBy("bucket_key", "asc");

  query = buildDateFilter(query, "vh.voucher_date", fromDate, toDate);
  if (filters.branchId) query = query.where("vh.branch_id", filters.branchId);
  if (filters.trendAccountGroupId) query = query.where("ag.id", Number(filters.trendAccountGroupId));
  if (filters.trendAccountId) query = query.where("vl.account_id", Number(filters.trendAccountId));

  const rows = await query;
  const rawByBucket = new Map();
  rows.forEach((row) => {
    const bucketKey = String(row.bucket_key || "").trim();
    if (!bucketKey) return;
    const rawNet = roundMoney(row.net_expense);
    rawByBucket.set(bucketKey, {
      grossExpense: roundMoney(row.gross_expense),
      creditsAdjustments: roundMoney(row.credits_adjustments),
      rawNetExpense: rawNet,
      netExpense: roundMoney(rawNet),
    });
  });

  const bucketKeys = enumerateBucketKeys(fromDate, toDate, granularity);
  return bucketKeys.map((bucketKey) => {
    const data = rawByBucket.get(bucketKey) || {
      grossExpense: 0,
      creditsAdjustments: 0,
      rawNetExpense: 0,
      netExpense: 0,
    };
    return {
      bucketStart: bucketKey,
      period: toTrendPeriodLabel(bucketKey, granularity),
      grossExpense: roundMoney(data.grossExpense),
      creditsAdjustments: roundMoney(data.creditsAdjustments),
      rawNetExpense: roundMoney(data.rawNetExpense),
      netExpense: roundMoney(data.netExpense),
    };
  });
};
const getExpenseTrendGroupTotals = async (filters, fromDate, toDate) => {
  let query = knex("erp.voucher_header as vh")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.accounts as a", "a.id", "vl.account_id")
    .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .select(
      "ag.id as account_group_id",
      "ag.name as account_group_name",
      knex.raw(`
        COALESCE(SUM(
          COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0) -
          COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)
        ), 0) as raw_net_expense
      `),
    )
    .where("ag.account_type", "EXPENSE")
    .where("vh.status", "APPROVED")
    .andWhere("vl.line_kind", "ACCOUNT")
    .groupBy("ag.id", "ag.name");

  query = buildDateFilter(query, "vh.voucher_date", fromDate, toDate);
  if (filters.branchId) query = query.where("vh.branch_id", filters.branchId);
  if (filters.trendAccountGroupId) query = query.where("ag.id", Number(filters.trendAccountGroupId));
  if (filters.trendAccountId) query = query.where("vl.account_id", Number(filters.trendAccountId));

  const rows = await query;
  return rows.map((row) => {
    const rawNet = roundMoney(row.raw_net_expense);
    return {
      accountGroupId: Number(row.account_group_id || 0) || null,
      accountGroupName: String(row.account_group_name || "-"),
      rawNetExpense: rawNet,
      netExpense: roundMoney(rawNet),
    };
  });
};
const toChangePercent = (current, previous) => {
  const curr = Number(current || 0);
  const prev = Number(previous || 0);
  if (prev === 0) return curr === 0 ? 0 : null;
  return roundMoney(((curr - prev) / Math.abs(prev)) * 100);
};
const getDateRangeSpanDays = (fromDate, toDate) => {
  const from = parseYmdDate(fromDate);
  const to = parseYmdDate(toDate);
  if (!from || !to || to < from) return 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  return Math.floor((to.getTime() - from.getTime()) / oneDayMs) + 1;
};
const getExpenseTrends = async (filters) => {
  const requestedGranularity = resolveExpenseTrendGranularity(filters.trendGranularity, "daily");
  const spanDays = getDateRangeSpanDays(filters.from, filters.to);
  const monthlyShortRange = requestedGranularity === "monthly" && spanDays > 0 && spanDays < 28;
  const weeklyShortRange = requestedGranularity === "weekly" && spanDays > 0 && spanDays < 7;
  const granularity = monthlyShortRange || weeklyShortRange ? "daily" : requestedGranularity;
  const granularityAdjusted = granularity !== requestedGranularity;
  const currentBuckets = await getExpenseTrendBuckets(filters, filters.from, filters.to, granularity);

  const previousRange = getPreviousPeriodRange(filters.from, filters.to);
  const previousBuckets = previousRange ? await getExpenseTrendBuckets(filters, previousRange.from, previousRange.to, granularity) : [];
  const [currentGroupTotals, previousGroupTotals] = await Promise.all([getExpenseTrendGroupTotals(filters, filters.from, filters.to), previousRange ? getExpenseTrendGroupTotals(filters, previousRange.from, previousRange.to) : Promise.resolve([])]);

  const rows = currentBuckets.map((bucket, index) => {
    const previousNet = Number(previousBuckets[index]?.netExpense || 0);
    const changePercent = toChangePercent(bucket.netExpense, previousNet);
    return {
      period: bucket.period,
      gross_expense: roundMoney(bucket.grossExpense),
      credits_adjustments: roundMoney(bucket.creditsAdjustments),
      net_expense: roundMoney(bucket.netExpense),
      previous_net_expense: roundMoney(previousNet),
      change_percentage: changePercent,
    };
  });
  const visibleRows = rows.filter((row) => {
    const gross = Number(row.gross_expense || 0);
    const credits = Number(row.credits_adjustments || 0);
    const net = Number(row.net_expense || 0);
    const previous = Number(row.previous_net_expense || 0);
    return gross !== 0 || credits !== 0 || net !== 0 || previous !== 0;
  });

  const currentTotal = roundMoney(rows.reduce((acc, row) => acc + Number(row.net_expense || 0), 0));
  const grossTotal = roundMoney(rows.reduce((acc, row) => acc + Number(row.gross_expense || 0), 0));
  const creditsTotal = roundMoney(rows.reduce((acc, row) => acc + Number(row.credits_adjustments || 0), 0));
  const previousTotal = roundMoney(rows.reduce((acc, row) => acc + Number(row.previous_net_expense || 0), 0));
  const nonZeroBucketCount = rows.reduce((count, row) => (Number(row.net_expense || 0) !== 0 ? count + 1 : count), 0);
  const avgPerBucket = nonZeroBucketCount ? roundMoney(currentTotal / nonZeroBucketCount) : 0;
  const changeAmount = roundMoney(currentTotal - previousTotal);
  const changePercent = toChangePercent(currentTotal, previousTotal);
  const highestBucket = rows.length ? rows.reduce((best, row) => (Number(row.net_expense || 0) > Number(best.net_expense || 0) ? row : best), rows[0]) : null;
  const hasCreditHeavyPeriods = currentBuckets.some((row) => {
    const gross = Number(row.grossExpense || 0);
    const credits = Number(row.creditsAdjustments || 0);
    if (credits <= gross) return false;
    if (gross <= 0) return credits > 0;
    return credits / gross >= 1.2;
  });

  const previousGroupMap = new Map();
  previousGroupTotals.forEach((row) => {
    const key = `${Number(row.accountGroupId || 0)}:${String(row.accountGroupName || "-")}`;
    previousGroupMap.set(key, row);
  });
  const allDriverRows = currentGroupTotals
    .map((currentRow) => {
      const key = `${Number(currentRow.accountGroupId || 0)}:${String(currentRow.accountGroupName || "-")}`;
      const previousRow = previousGroupMap.get(key) || null;
      const current = Number(currentRow.netExpense || 0);
      const previous = Number(previousRow?.netExpense || 0);
      const delta = roundMoney(current - previous);
      return {
        accountGroupId: currentRow.accountGroupId,
        accountGroupName: currentRow.accountGroupName || "-",
        currentNetExpense: roundMoney(current),
        previousNetExpense: roundMoney(previous),
        deltaAmount: delta,
        deltaPercentage: toChangePercent(current, previous),
      };
    })
    .concat(
      previousGroupTotals
        .filter((previousRow) => {
          const key = `${Number(previousRow.accountGroupId || 0)}:${String(previousRow.accountGroupName || "-")}`;
          return !currentGroupTotals.some((currentRow) => {
            const currentKey = `${Number(currentRow.accountGroupId || 0)}:${String(currentRow.accountGroupName || "-")}`;
            return currentKey === key;
          });
        })
        .map((previousRow) => ({
          accountGroupId: previousRow.accountGroupId,
          accountGroupName: previousRow.accountGroupName || "-",
          currentNetExpense: 0,
          previousNetExpense: roundMoney(previousRow.netExpense || 0),
          deltaAmount: roundMoney(0 - Number(previousRow.netExpense || 0)),
          deltaPercentage: toChangePercent(0, Number(previousRow.netExpense || 0)),
        })),
    )
    .sort((a, b) => Math.abs(Number(b.deltaAmount || 0)) - Math.abs(Number(a.deltaAmount || 0)));

  let topDrivers = allDriverRows.slice(0, EXPENSE_TREND_TOP_DRIVER_LIMIT);
  if (allDriverRows.length > EXPENSE_TREND_TOP_DRIVER_LIMIT) {
    const remainingRows = allDriverRows.slice(EXPENSE_TREND_TOP_DRIVER_LIMIT);
    const rolled = remainingRows.reduce(
      (acc, row) => ({
        currentNetExpense: roundMoney(acc.currentNetExpense + Number(row.currentNetExpense || 0)),
        previousNetExpense: roundMoney(acc.previousNetExpense + Number(row.previousNetExpense || 0)),
        deltaAmount: roundMoney(acc.deltaAmount + Number(row.deltaAmount || 0)),
      }),
      { currentNetExpense: 0, previousNetExpense: 0, deltaAmount: 0 },
    );
    const hasRolledValues =
      Number(rolled.currentNetExpense || 0) !== 0 ||
      Number(rolled.previousNetExpense || 0) !== 0 ||
      Number(rolled.deltaAmount || 0) !== 0;
    if (hasRolledValues) {
      topDrivers = topDrivers.concat({
        accountGroupId: null,
        accountGroupName: "OTHERS",
        currentNetExpense: roundMoney(rolled.currentNetExpense),
        previousNetExpense: roundMoney(rolled.previousNetExpense),
        deltaAmount: roundMoney(rolled.deltaAmount),
        deltaPercentage: toChangePercent(rolled.currentNetExpense, rolled.previousNetExpense),
        isOthers: true,
        contributorsCount: remainingRows.length,
      });
    }
  }

  return {
    rows: visibleRows,
    meta: {
      granularity,
      requestedGranularity,
      granularityAdjusted,
      from: filters.from,
      to: filters.to,
      previousFrom: previousRange?.from || null,
      previousTo: previousRange?.to || null,
      summary: {
        currentTotal,
        grossTotal,
        creditsTotal,
        previousTotal,
        changeAmount,
        changePercent,
        avgPerBucket,
        bucketsCount: visibleRows.length,
        hasCreditHeavyPeriods,
        highestBucket: highestBucket
          ? {
              period: highestBucket.period,
              netExpense: roundMoney(highestBucket.net_expense),
            }
          : null,
        topDrivers,
      },
      buckets: currentBuckets.map((bucket, index) => {
        const previousNet = Number(previousBuckets[index]?.netExpense || 0);
        return {
          period: bucket.period,
          bucketStart: bucket.bucketStart,
          grossExpense: roundMoney(bucket.grossExpense),
          creditsAdjustments: roundMoney(bucket.creditsAdjustments),
          netExpense: roundMoney(bucket.netExpense),
          previousNetExpense: roundMoney(previousNet),
          changePercentage: toChangePercent(bucket.netExpense, previousNet),
        };
      }),
    },
  };
};

const applyExpenseBreakdownFilters = (query, filters, fromDate, toDate) => {
  const deptExpr = knex.raw("NULLIF(vl.meta->>'department_id','')::bigint");
  let scoped = buildDateFilter(query, "vh.voucher_date", fromDate, toDate);
  if (Array.isArray(filters.branchIds) && filters.branchIds.length) {
    scoped = scoped.whereIn("vh.branch_id", filters.branchIds);
  } else if (filters.branchId) {
    scoped = scoped.where("vh.branch_id", filters.branchId);
  }
  const voucherTypeCode = EXPENSE_VOUCHER_TYPE_BY_FILTER[String(filters.voucherType || "all")] || null;
  if (voucherTypeCode) scoped = scoped.where("vh.voucher_type_code", voucherTypeCode);
  if (filters.cashierAccountId) scoped = scoped.where("vh.header_account_id", Number(filters.cashierAccountId));

  const normalizedDeptIds = Array.isArray(filters.departmentIds) ? filters.departmentIds : [];
  if (normalizedDeptIds.length) scoped = scoped.whereIn(deptExpr, normalizedDeptIds);
  else scoped = scoped.whereRaw("NULLIF(vl.meta->>'department_id','')::bigint IS NOT NULL");
  return scoped;
};

const getExpenseBreakdownRows = async (filters, fromDate, toDate) => {
  let query = knex("erp.voucher_header as vh")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.accounts as a", "a.id", "vl.account_id")
    .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .leftJoin("erp.departments as d", knex.raw("d.id = NULLIF(vl.meta->>'department_id','')::bigint"))
    .leftJoin("erp.parties as p", "p.id", "vl.party_id")
    .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
    .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
    .leftJoin("erp.accounts as ha", "ha.id", "vh.header_account_id")
    .leftJoin("erp.users as u", "u.id", "vh.created_by")
    .select(
      "vh.id as voucher_id",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"),
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.header_account_id",
      "ha.name as cashier_name",
      knex.raw("COALESCE(NULLIF(u.name, ''), u.username, NULL) as created_by_name"),
      "vl.id as line_id",
      "vl.line_no",
      "a.id as account_id",
      "a.name as account_name",
      "ag.id as account_group_id",
      "ag.name as account_group_name",
      knex.raw("NULLIF(vl.meta->>'description', '') as narration"),
      knex.raw(`
        COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0) as dr
      `),
      knex.raw(`
        COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0) as cr
      `),
      knex.raw("NULLIF(vl.meta->>'department_id','')::bigint as department_id"),
      "d.name as department_name",
      knex.raw("COALESCE(p.name, l.name, e.name, NULL) as payee_name"),
    )
    .where("vh.status", "APPROVED")
    .andWhere("vl.line_kind", "ACCOUNT")
    .andWhere("ag.account_type", "EXPENSE")
    .orderBy("vh.voucher_date", "desc")
    .orderBy("vh.voucher_no", "desc")
    .orderBy("vl.line_no", "asc");
  query = applyExpenseBreakdownFilters(query, filters, fromDate, toDate);
  return query;
};

const getExpenseDepartmentBreakdown = async (filters) => {
  const rows = await getExpenseBreakdownRows(filters, filters.from, filters.to);
  const prevPeriod = getPreviousPeriodRange(filters.from, filters.to);
  const previousRows = prevPeriod ? await getExpenseBreakdownRows(filters, prevPeriod.from, prevPeriod.to) : [];

  const toDeptKey = (departmentId) => (Number.isInteger(Number(departmentId)) && Number(departmentId) > 0 ? `D:${Number(departmentId)}` : "NA");
  const toGroupKey = (deptKey, groupId) => `${deptKey}|G:${Number(groupId || 0)}`;
  const toAccountKey = (groupKey, accountId) => `${groupKey}|A:${Number(accountId || 0)}`;

  const previousTotalsByGroup = new Map();
  previousRows.forEach((row) => {
    const deptKey = toDeptKey(row.department_id);
    const groupKey = toGroupKey(deptKey, row.account_group_id);
    const netExpense = roundMoney(Number(row.dr || 0) - Number(row.cr || 0));
    previousTotalsByGroup.set(groupKey, roundMoney((previousTotalsByGroup.get(groupKey) || 0) + netExpense));
  });

  const departmentsMap = new Map();
  rows.forEach((row) => {
    const grossExpense = roundMoney(Number(row.dr || 0));
    const creditsAdjustments = roundMoney(Number(row.cr || 0));
    const netExpense = roundMoney(grossExpense - creditsAdjustments);
    if (grossExpense === 0 && creditsAdjustments === 0 && netExpense === 0) return;
    const deptId = Number(row.department_id || 0) || null;
    const deptKey = toDeptKey(deptId);
    if (!departmentsMap.has(deptKey)) {
      departmentsMap.set(deptKey, {
        key: deptKey,
        departmentId: deptId,
        departmentName: row.department_name || null,
        isNaDepartment: !deptId,
        grossExpense: 0,
        creditsAdjustments: 0,
        netExpense: 0,
        transactionsCount: 0,
        groupsMap: new Map(),
      });
    }
    const department = departmentsMap.get(deptKey);
    department.grossExpense = roundMoney(department.grossExpense + grossExpense);
    department.creditsAdjustments = roundMoney(department.creditsAdjustments + creditsAdjustments);
    department.netExpense = roundMoney(department.netExpense + netExpense);
    department.transactionsCount += 1;

    const groupId = Number(row.account_group_id || 0) || null;
    const groupKey = toGroupKey(deptKey, groupId);
    if (!department.groupsMap.has(groupKey)) {
      const previousNetExpense = roundMoney(previousTotalsByGroup.get(groupKey) || 0);
      department.groupsMap.set(groupKey, {
        key: groupKey,
        accountGroupId: groupId,
        accountGroupName: row.account_group_name || null,
        grossExpense: 0,
        creditsAdjustments: 0,
        netExpense: 0,
        previousNetExpense,
        trendPercentage: null,
        transactionsCount: 0,
        accountsMap: new Map(),
      });
    }
    const group = department.groupsMap.get(groupKey);
    group.grossExpense = roundMoney(group.grossExpense + grossExpense);
    group.creditsAdjustments = roundMoney(group.creditsAdjustments + creditsAdjustments);
    group.netExpense = roundMoney(group.netExpense + netExpense);
    group.transactionsCount += 1;

    const accountId = Number(row.account_id || 0) || null;
    const accountKey = toAccountKey(groupKey, accountId);
    if (!group.accountsMap.has(accountKey)) {
      group.accountsMap.set(accountKey, {
        key: accountKey,
        accountId,
        accountName: row.account_name || null,
        grossExpense: 0,
        creditsAdjustments: 0,
        netExpense: 0,
        transactionsCount: 0,
        lines: [],
      });
    }
    const account = group.accountsMap.get(accountKey);
    account.grossExpense = roundMoney(account.grossExpense + grossExpense);
    account.creditsAdjustments = roundMoney(account.creditsAdjustments + creditsAdjustments);
    account.netExpense = roundMoney(account.netExpense + netExpense);
    account.transactionsCount += 1;
    account.lines.push({
      entry_date: row.entry_date || null,
      voucher_no: Number(row.voucher_no || 0) || null,
      voucher_type_code: row.voucher_type_code || null,
      payee: row.payee_name || null,
      account_name: row.account_name || null,
      account_group_name: row.account_group_name || null,
      department_name: row.department_name || null,
      created_by: row.created_by_name || null,
      cashier: row.cashier_name || null,
      narration: row.narration || null,
      amount: netExpense,
    });
  });

  const allGroups = [];
  const departments = [...departmentsMap.values()]
    .map((department) => {
      const groups = [...department.groupsMap.values()]
        .map((group) => {
          const previousNetExpense = roundMoney(group.previousNetExpense || 0);
          if (previousNetExpense !== 0) {
            group.trendPercentage = roundMoney(((group.netExpense - previousNetExpense) / Math.abs(previousNetExpense)) * 100);
          } else if (group.netExpense === 0) {
            group.trendPercentage = 0;
          } else {
            group.trendPercentage = null;
          }
          group.percentageOfDepartment = department.netExpense !== 0 ? roundMoney((group.netExpense / department.netExpense) * 100) : 0;

          const accounts = [...group.accountsMap.values()]
            .map((account) => {
              const lines = [...account.lines].sort((a, b) => {
                const dateA = String(a.entry_date || "");
                const dateB = String(b.entry_date || "");
                if (dateA !== dateB) return dateB.localeCompare(dateA);
                return Number(b.voucher_no || 0) - Number(a.voucher_no || 0);
              });
              return {
                key: account.key,
                accountId: account.accountId,
                accountName: account.accountName,
                grossExpense: roundMoney(account.grossExpense),
                creditsAdjustments: roundMoney(account.creditsAdjustments),
                netExpense: roundMoney(account.netExpense),
                transactionsCount: Number(account.transactionsCount || 0),
                lines,
              };
            })
            .sort((a, b) => Number(b.netExpense || 0) - Number(a.netExpense || 0));

          const mapped = {
            key: group.key,
            accountGroupId: group.accountGroupId,
            accountGroupName: group.accountGroupName,
            grossExpense: roundMoney(group.grossExpense),
            creditsAdjustments: roundMoney(group.creditsAdjustments),
            netExpense: roundMoney(group.netExpense),
            previousNetExpense,
            trendPercentage: group.trendPercentage,
            percentageOfDepartment: group.percentageOfDepartment,
            transactionsCount: Number(group.transactionsCount || 0),
            accounts,
          };
          allGroups.push({
            departmentId: department.departmentId,
            departmentName: department.departmentName,
            isNaDepartment: department.isNaDepartment,
            ...mapped,
          });
          return mapped;
        })
        .sort((a, b) => Number(b.netExpense || 0) - Number(a.netExpense || 0));

      const topGroups = groups.slice(0, 2).map((group) => ({
        accountGroupId: group.accountGroupId,
        accountGroupName: group.accountGroupName,
        netExpense: roundMoney(group.netExpense),
      }));
      return {
        key: department.key,
        departmentId: department.departmentId,
        departmentName: department.departmentName,
        isNaDepartment: department.isNaDepartment,
        grossExpense: roundMoney(department.grossExpense),
        creditsAdjustments: roundMoney(department.creditsAdjustments),
        netExpense: roundMoney(department.netExpense),
        transactionsCount: Number(department.transactionsCount || 0),
        topGroups,
        groups,
      };
    })
    .sort((a, b) => Number(b.netExpense || 0) - Number(a.netExpense || 0));

  const totals = departments.reduce(
    (acc, row) => {
      acc.grossExpense = roundMoney(acc.grossExpense + Number(row.grossExpense || 0));
      acc.creditsAdjustments = roundMoney(acc.creditsAdjustments + Number(row.creditsAdjustments || 0));
      acc.netExpense = roundMoney(acc.netExpense + Number(row.netExpense || 0));
      return acc;
    },
    { grossExpense: 0, creditsAdjustments: 0, netExpense: 0 },
  );

  const departmentsWithPercent = departments.map((row) => ({
    ...row,
    percentageOfTotal: totals.netExpense !== 0 ? roundMoney((Number(row.netExpense || 0) / totals.netExpense) * 100) : 0,
  }));

  const topDepartments = departmentsWithPercent.slice(0, 3).map((row) => ({
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    isNaDepartment: row.isNaDepartment,
    netExpense: roundMoney(row.netExpense),
  }));

  const topAccountGroups = [...allGroups]
    .sort((a, b) => Number(b.netExpense || 0) - Number(a.netExpense || 0))
    .slice(0, 3)
    .map((row) => ({
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      isNaDepartment: row.isNaDepartment,
      accountGroupId: row.accountGroupId,
      accountGroupName: row.accountGroupName,
      netExpense: roundMoney(row.netExpense),
    }));

  const biggestIncrease = [...allGroups].filter((row) => Number(row.previousNetExpense || 0) !== 0 && Number(row.trendPercentage || 0) > 0).sort((a, b) => Number(b.trendPercentage || 0) - Number(a.trendPercentage || 0))[0] || null;

  return {
    mode: "department_breakdown",
    from: filters.from,
    to: filters.to,
    departments: departmentsWithPercent,
    summary: {
      grossExpense: totals.grossExpense,
      creditsAdjustments: totals.creditsAdjustments,
      netExpense: totals.netExpense,
      topDepartments,
      topAccountGroups,
      biggestIncrease: biggestIncrease
        ? {
            departmentId: biggestIncrease.departmentId,
            departmentName: biggestIncrease.departmentName,
            isNaDepartment: biggestIncrease.isNaDepartment,
            accountGroupId: biggestIncrease.accountGroupId,
            accountGroupName: biggestIncrease.accountGroupName,
            trendPercentage: roundMoney(biggestIncrease.trendPercentage),
            currentNetExpense: roundMoney(biggestIncrease.netExpense),
            previousNetExpense: roundMoney(biggestIncrease.previousNetExpense),
          }
        : null,
    },
    totals: {
      totalAmount: totals.netExpense,
      departmentsCount: departmentsWithPercent.length,
      grossExpense: totals.grossExpense,
      creditsAdjustments: totals.creditsAdjustments,
      netExpense: totals.netExpense,
    },
  };
};

const getExpenseAnalysis = async (filters) => {
  if (
    String(filters.reportType || "")
      .trim()
      .toLowerCase() === "department_breakdown"
  ) {
    const breakdown = await getExpenseDepartmentBreakdown(filters);
    return breakdown;
  }

  let query = knex("erp.gl_entry as ge").select("ag.name as account_group", "d.name as department").sum({ total_debit: "ge.dr" }).sum({ total_credit: "ge.cr" }).leftJoin("erp.accounts as a", "a.id", "ge.account_id").leftJoin("erp.account_groups as ag", "ag.id", "a.subgroup_id").leftJoin("erp.departments as d", "d.id", "ge.dept_id").groupBy("ag.name", "d.name").orderBy("ag.name", "asc");
  query = buildDateFilter(query, "ge.entry_date", filters.from, filters.to);
  if (Array.isArray(filters.branchIds) && filters.branchIds.length) query = query.whereIn("ge.branch_id", filters.branchIds);
  else if (filters.branchId) query = query.where("ge.branch_id", filters.branchId);
  return query;
};

const getTrialBalance = async (filters) => {
  const includeBranchColumn = !filters.branchId;

  let query = knex("erp.gl_entry as ge")
    .leftJoin("erp.accounts as a", "a.id", "ge.account_id")
    .leftJoin("erp.branches as b", "b.id", "ge.branch_id")
    .select(
      "a.code as account_code",
      "a.name as account_name",
      ...(includeBranchColumn ? ["b.name as branch_name"] : []),
      knex.raw(`COALESCE(SUM(CASE WHEN ge.entry_date < ? THEN COALESCE(ge.dr, 0) - COALESCE(ge.cr, 0) ELSE 0 END), 0) as opening_balance`, [filters.from]),
      knex.raw(`COALESCE(SUM(CASE WHEN ge.entry_date >= ? AND ge.entry_date <= ? THEN COALESCE(ge.dr, 0) ELSE 0 END), 0) as period_debit`, [filters.from, filters.to]),
      knex.raw(`COALESCE(SUM(CASE WHEN ge.entry_date >= ? AND ge.entry_date <= ? THEN COALESCE(ge.cr, 0) ELSE 0 END), 0) as period_credit`, [filters.from, filters.to]),
      knex.raw(`COALESCE(SUM(CASE WHEN ge.entry_date <= ? THEN COALESCE(ge.dr, 0) - COALESCE(ge.cr, 0) ELSE 0 END), 0) as closing_balance`, [filters.to]),
    )
    .groupBy("a.code", "a.name", ...(includeBranchColumn ? ["b.name"] : []))
    .orderBy("a.code", "asc");

  if (filters.branchId) query = query.where("ge.branch_id", filters.branchId);

  const rows = await query;
  const mappedRows = rows
    .map((row) => ({
      account_code: row.account_code || null,
      account_name: row.account_name || null,
      opening_balance: Number(row.opening_balance || 0),
      period_debit: Number(row.period_debit || 0),
      period_credit: Number(row.period_credit || 0),
      closing_balance: Number(row.closing_balance || 0),
      ...(includeBranchColumn ? { branch: row.branch_name || null } : {}),
    }))
    .filter((row) => {
      const opening = Number(row.opening_balance || 0);
      const dr = Number(row.period_debit || 0);
      const cr = Number(row.period_credit || 0);
      const closing = Number(row.closing_balance || 0);
      return opening !== 0 || dr !== 0 || cr !== 0 || closing !== 0;
    });

  const totals = mappedRows.reduce(
    (acc, row) => {
      acc.opening_balance += Number(row.opening_balance || 0);
      acc.period_debit += Number(row.period_debit || 0);
      acc.period_credit += Number(row.period_credit || 0);
      acc.closing_balance += Number(row.closing_balance || 0);
      return acc;
    },
    {
      opening_balance: 0,
      period_debit: 0,
      period_credit: 0,
      closing_balance: 0,
    },
  );

  mappedRows.push({
    _row_type: "TOTAL",
    account_code: null,
    account_name: "PERIOD_TOTALS",
    opening_balance: Number(totals.opening_balance.toFixed(2)),
    period_debit: Number(totals.period_debit.toFixed(2)),
    period_credit: Number(totals.period_credit.toFixed(2)),
    closing_balance: Number(totals.closing_balance.toFixed(2)),
    ...(includeBranchColumn ? { branch: null } : {}),
  });

  return mappedRows;
};

const getProfitAndLoss = async (filters) => {
  let query = knex("erp.gl_entry as ge").select("ag.account_type").sum({ debit: "ge.dr" }).sum({ credit: "ge.cr" }).leftJoin("erp.accounts as a", "a.id", "ge.account_id").leftJoin("erp.account_groups as ag", "ag.id", "a.subgroup_id").groupBy("ag.account_type");
  query = buildDateFilter(query, "ge.entry_date", filters.from, filters.to);
  if (filters.branchId) query = query.where("ge.branch_id", filters.branchId);
  return query;
};

const getAccountActivityLedger = async (filters) => {
  if (!filters.accountId) return [];

  const openingRow = await knex("erp.gl_entry as ge")
    .leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
    .select(knex.raw("COALESCE(SUM(COALESCE(ge.dr, 0) - COALESCE(ge.cr, 0)), 0) as opening_balance"))
    .where("ge.account_id", filters.accountId)
    .where("vh.status", "APPROVED")
    .modify((queryBuilder) => {
      if (filters.branchId) queryBuilder.where("ge.branch_id", filters.branchId);
      if (filters.from) queryBuilder.where("ge.entry_date", "<", filters.from);
    })
    .first();

  const openingBalance = Number(openingRow?.opening_balance || 0);
  const includeBranchColumn = !filters.branchId;
  const includeDetailsColumns = filters.reportMode === "details";
  const createBoundaryRow = (voucherTypeCode, entryDate, balance) => {
    const payload = {
      entry_date: entryDate || null,
      voucher_type_code: voucherTypeCode,
      voucher_no: null,
    };
    if (includeDetailsColumns) {
      payload.description = voucherTypeCode;
      payload.department = null;
    }
    if (includeBranchColumn) payload.branch = null;
    payload.dr = 0;
    payload.cr = 0;
    payload.running_balance = Number(balance.toFixed(2));
    return payload;
  };

  let rows = [];
  if (filters.reportMode === "details") {
    let detailQuery = knex("erp.voucher_header as vh")
      .join("erp.voucher_type as vt", "vt.code", "vh.voucher_type_code")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .leftJoin("erp.accounts as a", "a.id", "vl.account_id")
      .leftJoin("erp.parties as p", "p.id", "vl.party_id")
      .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
      .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
      .leftJoin("erp.departments as d", knex.raw("d.id = NULLIF(vl.meta->>'department_id','')::bigint"))
      .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
      .select(
        knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"),
        "vh.voucher_type_code",
        "vh.voucher_no",
        "b.name as branch_name",
        knex.raw(
          `
          CASE
            WHEN vh.voucher_type_code IN ('CASH_VOUCHER','BANK_VOUCHER') AND vh.header_account_id = ?
              THEN COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)
            ELSE COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)
          END as dr
        `,
          [filters.accountId],
        ),
        knex.raw(
          `
          CASE
            WHEN vh.voucher_type_code IN ('CASH_VOUCHER','BANK_VOUCHER') AND vh.header_account_id = ?
              THEN COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)
            ELSE COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)
          END as cr
        `,
          [filters.accountId],
        ),
        knex.raw("NULLIF(vl.meta->>'description','') as description"),
        "d.name as department",
        "vl.line_no",
      )
      .where("vh.status", "APPROVED")
      .andWhere("vt.affects_gl", true)
      .andWhere(function whereAccountInvolvement() {
        this.where(function whereHeaderAccount() {
          this.whereIn("vh.voucher_type_code", ["CASH_VOUCHER", "BANK_VOUCHER"]).andWhere("vh.header_account_id", filters.accountId);
        }).orWhere(function whereLineAccount() {
          this.where("vl.line_kind", "ACCOUNT").andWhere("vl.account_id", filters.accountId);
        });
      })
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");

    if (filters.branchId) {
      detailQuery = detailQuery.where("vh.branch_id", filters.branchId);
    }
    detailQuery = buildDateFilter(detailQuery, "vh.voucher_date", filters.from, filters.to);
    rows = await detailQuery;
  } else {
    let summaryQuery = knex("erp.gl_entry as ge")
      .leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
      .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
      .leftJoin("erp.branches as b", "b.id", "ge.branch_id")
      .select(knex.raw("to_char(ge.entry_date, 'YYYY-MM-DD') as entry_date"), "vh.voucher_type_code", "vh.voucher_no", "b.name as branch_name", "ge.dr", "ge.cr")
      .where("ge.account_id", filters.accountId)
      .where("vh.status", "APPROVED")
      .orderBy("ge.entry_date", "asc")
      .orderBy("ge.id", "asc");

    if (filters.branchId) {
      summaryQuery = summaryQuery.where("ge.branch_id", filters.branchId);
    }
    summaryQuery = buildDateFilter(summaryQuery, "ge.entry_date", filters.from, filters.to);
    rows = await summaryQuery;
  }

  let running = openingBalance;
  const detailRows = rows
    .map((row) => {
      const dr = Number(row.dr || 0);
      const cr = Number(row.cr || 0);
      running += dr - cr;
      const payload = {
        entry_date: row.entry_date,
        voucher_type_code: row.voucher_type_code,
        voucher_no: row.voucher_no,
      };
      if (filters.reportMode === "details") {
        payload.description = row.description || null;
        payload.department = row.department || null;
      }
      if (includeBranchColumn) payload.branch = row.branch_name || null;
      payload.dr = dr;
      payload.cr = cr;
      payload.running_balance = Number(running.toFixed(2));
      return payload;
    })
    .filter((row) => Number(row.dr || 0) !== 0 || Number(row.cr || 0) !== 0);

  return [createBoundaryRow("OPENING_BALANCE", filters.from, openingBalance), ...detailRows, createBoundaryRow("CLOSING_BALANCE", filters.to, running)];
};

const getPayrollWageBalance = async (filters) => {
  let query = knex("erp.gl_entry as ge")
    .select("a.name as account_name")
    .sum({ debit: "ge.dr" })
    .sum({ credit: "ge.cr" })
    .leftJoin("erp.accounts as a", "a.id", "ge.account_id")
    .where(function () {
      this.whereRaw("lower(a.name) like '%wages%'").orWhereRaw("lower(a.name) like '%salary%'");
    })
    .groupBy("a.name")
    .orderBy("a.name", "asc");
  query = buildDateFilter(query, "ge.entry_date", filters.from, filters.to);
  if (filters.branchId) query = query.where("ge.branch_id", filters.branchId);
  return query;
};

const getFinancialReport = async (reportKey, req, precomputedFilters = null) => {
  const normalizedKey = normalizeReportKey(reportKey);
  const filters = precomputedFilters || getCommonFilters(req, normalizedKey);

  if (VOUCHER_REGISTER_REPORTS.has(normalizedKey)) {
    return { rows: await getVoucherRegister(filters), titleKey: "voucher_register", filters };
  }

  switch (normalizedKey) {
    case "cash_book":
      return { rows: await getCashBook(filters), titleKey: "cash_book" };
    case "expense_analysis": {
      if (!filters.reportLoaded) {
        return { rows: [], titleKey: "expense_analysis", filters, meta: null };
      }
      const payload = await getExpenseAnalysis(filters);
      if (
        String(filters.reportType || "")
          .trim()
          .toLowerCase() === "department_breakdown"
      ) {
        const rows = (payload?.departments || []).map((row) => ({
          department: row.isNaDepartment ? "N/A" : row.departmentName || null,
          amount: Number(row.amount || 0),
        }));
        return {
          rows,
          titleKey: "expense_analysis",
          filters,
          meta: {
            departmentBreakdown: payload,
          },
        };
      }
      return { rows: payload, titleKey: "expense_analysis", filters };
    }
    case "expense_trends": {
      if (!filters.reportLoaded) {
        return { rows: [], titleKey: "expense_trends", filters, meta: null };
      }
      const payload = await getExpenseTrends(filters);
      return {
        rows: payload.rows,
        titleKey: "expense_trends",
        filters,
        meta: { expenseTrends: payload.meta },
      };
    }
    case "production_overhead":
    case "non_production_expense":
    case "accrued_expenses":
      return { rows: await getExpenseAnalysis(filters), titleKey: normalizedKey };
    case "profitability_analysis":
    case "profit_and_loss":
      return { rows: await getProfitAndLoss(filters), titleKey: reportKey };
    case "account_activity_ledger":
      return { rows: await getAccountActivityLedger(filters), titleKey: "account_activity_ledger" };
    case "trial_balance":
      return { rows: await getTrialBalance(filters), titleKey: "trial_balance" };
    case "payroll_wage_balance":
      return { rows: await getPayrollWageBalance(filters), titleKey: "payroll_wage_balance" };
    default:
      return { rows: await getTrialBalance(filters), titleKey: "financial_reports" };
  }
};

module.exports = {
  getCommonFilters,
  getFinancialReport,
  updateBankVoucherLineStatus,
};
