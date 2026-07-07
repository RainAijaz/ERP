"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const { toBoolean, toIdList } = require("../../utils/report-filter-types");

const ALL_MULTI_FILTER_VALUE = "__ALL__";
const DEBIT_META_SQL = "COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)";
const CREDIT_META_SQL = "COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)";
const RESOLVED_DEBIT_SQL = `CASE WHEN ${DEBIT_META_SQL} = 0 AND ${CREDIT_META_SQL} = 0 THEN COALESCE(vl.amount, 0) ELSE ${DEBIT_META_SQL} END`;
const RESOLVED_CREDIT_SQL = `CASE WHEN ${DEBIT_META_SQL} = 0 AND ${CREDIT_META_SQL} = 0 THEN 0 ELSE ${CREDIT_META_SQL} END`;
const DIR_VERSION_SQL = "COALESCE(NULLIF(vl.meta->>'direction_version','')::int, 1)";
// HR ledgers are payable-oriented: payment = debit, payable increase = credit.
// direction_version=2 (cash/bank vouchers): meta.debit/credit carry explicit direction — use directly.
// direction_version=1 or legacy (sales vouchers, old data): amount lives in vl.amount → RESOLVED_DEBIT;
// the old convention treats that amount as a credit to the employee's account.
const LEDGER_DEBIT_SQL = `CASE WHEN ${DIR_VERSION_SQL} = 2 THEN ${DEBIT_META_SQL} ELSE ${CREDIT_META_SQL} END`;
const LEDGER_CREDIT_SQL = `CASE WHEN ${DIR_VERSION_SQL} = 2 THEN ${CREDIT_META_SQL} ELSE ${RESOLVED_DEBIT_SQL} END`;
const LEDGER_NET_SQL = `(${LEDGER_CREDIT_SQL}) - (${LEDGER_DEBIT_SQL})`;
// Salesman's Sale commission is posted as a plain EMPLOYEE voucher_line row on the
// sale itself (never through erp.commission_ledger — see commission-service.js /
// sales-voucher-service.js), tagged with this meta flag so reports can pull it out
// of the generic ledger bucket and show it as its own commission-type row.
const IS_SALES_COMMISSION_LINE_SQL =
  "COALESCE((vl.meta->>'auto_sales_commission')::boolean, false)";
const LABOUR_ENTITY_SQL =
  "CASE WHEN vh.voucher_type_code = 'DCV' THEN dcv.labour_id ELSE vl.labour_id END";
const AUTO_PAYROLL_VOUCHER_TYPE = "PAYROLL_ACCRUAL";
const AUTO_PAYROLL_DESCRIPTION = "Monthly salary accrual";
const AUTO_PAYROLL_DAILY_DESCRIPTION =
  "Daily salary accrual (excluding Sundays)";
const COMMISSION_TYPE_DESCRIPTIONS = {
  SALESMAN_SALE: "Sales Commission (Salesman's Sale)",
  BRANCH_SALE: "Sales Commission (Branch Sale)",
  TRANSFER: "Sales Commission (Transfer)",
  PARTY: "Sales Commission (Party)",
};

const toPositiveId = (value) => {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const toAmount = (value, precision = 2) => {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(precision));
};

const toQty = (value, precision = 3) => {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(precision));
};

const toUtcDateFromYmd = (value) => {
  const normalized = parseYmdStrict(value);
  if (!normalized) return null;
  const [y, m, d] = normalized.split("-").map((token) => Number(token));
  return new Date(Date.UTC(y, m - 1, d));
};

const toYmd = (value) => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const monthStartUtc = (value) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));

const monthEndUtc = (value) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));

const addMonthsUtc = (value, months) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));

const addDaysUtc = (value, days) =>
  new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate() + Number(days || 0),
    ),
  );

const monthDiff = (fromDate, toDate) =>
  (toDate.getUTCFullYear() - fromDate.getUTCFullYear()) * 12 +
  (toDate.getUTCMonth() - fromDate.getUTCMonth());

const getFirstAccrualDateYmd = (employmentStartYmd) => {
  const startDate = toUtcDateFromYmd(employmentStartYmd);
  if (!startDate) return null;
  return toYmd(monthEndUtc(startDate));
};

const getLastAccrualMonthStartUtc = (asOnYmd) => {
  const asOnDate = toUtcDateFromYmd(asOnYmd);
  if (!asOnDate) return null;
  const currentMonthEnd = monthEndUtc(asOnDate);
  if (toYmd(asOnDate) >= toYmd(currentMonthEnd)) {
    return monthStartUtc(asOnDate);
  }
  return addMonthsUtc(monthStartUtc(asOnDate), -1);
};

const countDaysExcludingSundays = ({ fromYmd, toYmdValue }) => {
  const fromDate = toUtcDateFromYmd(fromYmd);
  const toDate = toUtcDateFromYmd(toYmdValue);
  if (!fromDate || !toDate) return 0;
  if (toDate < fromDate) return 0;

  const msInDay = 24 * 60 * 60 * 1000;
  const totalDays =
    Math.floor((toDate.getTime() - fromDate.getTime()) / msInDay) + 1;
  if (totalDays <= 0) return 0;

  const fullWeeks = Math.floor(totalDays / 7);
  const remainderDays = totalDays % 7;
  let sundayCount = fullWeeks;
  const startDow = fromDate.getUTCDay();

  for (let dayIndex = 0; dayIndex < remainderDays; dayIndex += 1) {
    if ((startDow + dayIndex) % 7 === 0) {
      sundayCount += 1;
    }
  }

  return Math.max(0, totalDays - sundayCount);
};

const countDailyAccrualDaysUpTo = ({ employmentStartYmd, asOnYmd }) => {
  const startDate = toUtcDateFromYmd(employmentStartYmd);
  const asOnDate = toUtcDateFromYmd(asOnYmd);
  if (!startDate || !asOnDate) return 0;
  if (asOnDate < startDate) return 0;
  return countDaysExcludingSundays({
    fromYmd: toYmd(startDate),
    toYmdValue: toYmd(asOnDate),
  });
};

const countMonthlyAccrualsUpTo = ({ employmentStartYmd, asOnYmd }) => {
  const firstAccrualYmd = getFirstAccrualDateYmd(employmentStartYmd);
  if (!firstAccrualYmd || asOnYmd < firstAccrualYmd) return 0;
  const firstAccrualMonthStart = monthStartUtc(
    toUtcDateFromYmd(firstAccrualYmd),
  );
  const lastAccrualMonthStart = getLastAccrualMonthStartUtc(asOnYmd);
  if (!firstAccrualMonthStart || !lastAccrualMonthStart) return 0;
  if (lastAccrualMonthStart < firstAccrualMonthStart) return 0;
  return monthDiff(firstAccrualMonthStart, lastAccrualMonthStart) + 1;
};

const buildMonthlyAccrualRowsInRange = ({
  employmentStartYmd,
  fromYmd,
  toYmdValue,
  monthlyAmount,
  idSeed = 0,
}) => {
  const rows = [];
  const firstAccrualYmd = getFirstAccrualDateYmd(employmentStartYmd);
  if (!firstAccrualYmd) return rows;
  const firstAccrualMonthStart = monthStartUtc(
    toUtcDateFromYmd(firstAccrualYmd),
  );
  const lastAccrualMonthStart = getLastAccrualMonthStartUtc(toYmdValue);
  if (!firstAccrualMonthStart || !lastAccrualMonthStart) return rows;
  if (lastAccrualMonthStart < firstAccrualMonthStart) return rows;
  let cursor = firstAccrualMonthStart;
  let index = 0;
  while (cursor <= lastAccrualMonthStart) {
    const accrualDate = toYmd(monthEndUtc(cursor));
    if (accrualDate >= fromYmd && accrualDate <= toYmdValue) {
      rows.push({
        id: -1 * (idSeed * 1000 + index + 1),
        voucher_id: null,
        entry_date: accrualDate,
        voucher_no: null,
        bill_number: "",
        voucher_type: AUTO_PAYROLL_VOUCHER_TYPE,
        description: AUTO_PAYROLL_DESCRIPTION,
        qty: 0,
        debit: 0,
        credit: toAmount(monthlyAmount, 2),
        branch_name: "",
      });
    }
    cursor = addMonthsUtc(cursor, 1);
    index += 1;
  }
  return rows;
};

const buildDailyAccrualRowsInRange = ({
  employmentStartYmd,
  fromYmd,
  toYmdValue,
  dailyAmount,
  idSeed = 0,
}) => {
  const rows = [];
  const startDate = toUtcDateFromYmd(employmentStartYmd);
  const fromDate = toUtcDateFromYmd(fromYmd);
  const toDate = toUtcDateFromYmd(toYmdValue);
  if (!startDate || !fromDate || !toDate) return rows;
  if (dailyAmount <= 0) return rows;

  let cursor = fromDate > startDate ? fromDate : startDate;
  let index = 0;
  while (cursor <= toDate) {
    if (cursor.getUTCDay() !== 0) {
      rows.push({
        id: -1 * (idSeed * 100000 + index + 1),
        voucher_id: null,
        entry_date: toYmd(cursor),
        voucher_no: null,
        bill_number: "",
        voucher_type: AUTO_PAYROLL_VOUCHER_TYPE,
        description: AUTO_PAYROLL_DAILY_DESCRIPTION,
        qty: 0,
        debit: 0,
        credit: toAmount(dailyAmount, 2),
        branch_name: "",
      });
      index += 1;
    }
    cursor = addDaysUtc(cursor, 1);
  }

  return rows;
};

const loadEmployeeAccrualProfiles = async ({ entityIds = [] }) => {
  const normalizedIds = [
    ...new Set(
      (entityIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!normalizedIds.length) return new Map();
  const employeeRows = await knex("erp.employees as e")
    .select("e.id", "e.basic_salary", "e.created_at", "e.payroll_type")
    .whereIn("e.id", normalizedIds)
    .whereIn("e.payroll_type", ["MONTHLY", "DAILY"])
    .whereRaw("lower(trim(coalesce(e.status, ''))) = 'active'");

  const allowanceRows = await knex("erp.employee_allowance_rules as ar")
    .select("ar.employee_id")
    .select(knex.raw("upper(coalesce(ar.frequency, '')) as frequency"))
    .sum({
      fixed_amount: knex.raw(
        "CASE WHEN ar.amount_type = 'FIXED' THEN COALESCE(ar.amount, 0) ELSE 0 END",
      ),
    })
    .sum({
      percent_amount: knex.raw(
        "CASE WHEN ar.amount_type = 'PERCENT_BASIC' THEN COALESCE(ar.amount, 0) ELSE 0 END",
      ),
    })
    .whereIn("ar.employee_id", normalizedIds)
    .whereRaw("upper(coalesce(ar.frequency, '')) IN ('MONTHLY', 'DAILY')")
    .whereRaw("lower(trim(coalesce(ar.status, ''))) = 'active'")
    .groupBy("ar.employee_id")
    .groupByRaw("upper(coalesce(ar.frequency, ''))");

  const allowanceByEmployee = new Map();
  (allowanceRows || []).forEach((row) => {
    const employeeId = Number(row.employee_id || 0);
    if (!employeeId) return;
    const frequency = String(row.frequency || "")
      .trim()
      .toUpperCase();
    if (frequency !== "MONTHLY" && frequency !== "DAILY") return;

    const current = allowanceByEmployee.get(employeeId) || {
      MONTHLY: { fixedAmount: 0, percentAmount: 0 },
      DAILY: { fixedAmount: 0, percentAmount: 0 },
    };

    current[frequency] = {
      fixedAmount: Number(row.fixed_amount || 0),
      percentAmount: Number(row.percent_amount || 0),
    };

    allowanceByEmployee.set(employeeId, current);
  });

  const result = new Map();
  (employeeRows || []).forEach((row) => {
    const employeeId = Number(row.id || 0);
    if (!employeeId) return;

    const payrollType = String(row.payroll_type || "")
      .trim()
      .toUpperCase();
    const basicSalary = Number(row.basic_salary || 0);
    const allowance = allowanceByEmployee.get(employeeId) || {
      MONTHLY: { fixedAmount: 0, percentAmount: 0 },
      DAILY: { fixedAmount: 0, percentAmount: 0 },
    };

    const monthlyAllowance = allowance.MONTHLY || {
      fixedAmount: 0,
      percentAmount: 0,
    };
    const dailyAllowance = allowance.DAILY || {
      fixedAmount: 0,
      percentAmount: 0,
    };

    const monthlyAllowanceOnly = Number(
      (
        Number(monthlyAllowance.fixedAmount || 0) +
        (basicSalary * Number(monthlyAllowance.percentAmount || 0)) / 100
      ).toFixed(2),
    );
    const dailyAllowanceOnly = Number(
      (
        Number(dailyAllowance.fixedAmount || 0) +
        (basicSalary * Number(dailyAllowance.percentAmount || 0)) / 100
      ).toFixed(2),
    );

    const monthlyAmount = Number(
      (basicSalary + monthlyAllowanceOnly).toFixed(2),
    );
    const dailyAmount = Number((basicSalary + dailyAllowanceOnly).toFixed(2));

    result.set(employeeId, {
      payrollType,
      monthlyAmount:
        Number.isFinite(monthlyAmount) && monthlyAmount > 0 ? monthlyAmount : 0,
      dailyAmount:
        Number.isFinite(dailyAmount) && dailyAmount > 0 ? dailyAmount : 0,
      monthlySalaryOnly: basicSalary > 0 ? basicSalary : 0,
      dailySalaryOnly: basicSalary > 0 ? basicSalary : 0,
      monthlyAllowanceOnly:
        Number.isFinite(monthlyAllowanceOnly) && monthlyAllowanceOnly > 0
          ? monthlyAllowanceOnly
          : 0,
      dailyAllowanceOnly:
        Number.isFinite(dailyAllowanceOnly) && dailyAllowanceOnly > 0
          ? dailyAllowanceOnly
          : 0,
      employmentStartYmd:
        toLocalDateOnly(row.created_at || new Date()) ||
        toLocalDateOnly(new Date()),
    });
  });
  return result;
};

const parseYmdStrict = (value) => {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isInteger(y) || !Number.isInteger(mm) || !Number.isInteger(dd))
    return null;
  const dt = new Date(Date.UTC(y, mm - 1, dd));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mm - 1 ||
    dt.getUTCDate() !== dd
  )
    return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
};

const parseDateFilter = (value, fallback) => {
  const v = String(value == null ? "" : value).trim();
  if (!v) return { value: fallback, valid: true, provided: false };
  const normalized = parseYmdStrict(v);
  if (!normalized) return { value: fallback, valid: false, provided: true };
  return { value: normalized, valid: true, provided: true };
};

const toIdListWithAll = (value) => {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : [value];
  const tokens = raw
    .flatMap((entry) => String(entry == null ? "" : entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasAll = tokens.some(
    (entry) =>
      entry.toLowerCase() === String(ALL_MULTI_FILTER_VALUE).toLowerCase() ||
      entry.toLowerCase() === "all",
  );
  if (hasAll) return [];
  return toIdList(tokens);
};

const parseEntityBalanceFilters = ({ req, input = {} }) => {
  const today = toLocalDateOnly(new Date());
  const parsedAsOn = parseDateFilter(input.as_on, today);
  let asOn = parsedAsOn.value;
  if (!asOn) asOn = today;

  const branchIdsFromInput = toIdList(input.branch_ids);
  const branchIds = req.user?.isAdmin
    ? branchIdsFromInput
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const viewMode =
    String(input.view_mode || "summary")
      .trim()
      .toLowerCase() === "detail"
      ? "detail"
      : "summary";

  return {
    asOn,
    branchIds,
    viewMode,
    reportLoaded: toBoolean(input.load_report, false),
    invalidAsOnDate: Boolean(parsedAsOn.provided && !parsedAsOn.valid),
    invalidFilterInput: Boolean(parsedAsOn.provided && !parsedAsOn.valid),
  };
};

const parseEntityLedgerFilters = ({ req, input = {} }) => {
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 30);
  const today = toLocalDateOnly(now);
  const defaultFrom = toLocalDateOnly(fromDate);

  const parsedFrom = parseDateFilter(input.from_date, defaultFrom);
  const parsedTo = parseDateFilter(input.to_date, today);
  let from = parsedFrom.value;
  let to = parsedTo.value;
  let invalidDateRange = false;

  if (from > to) {
    from = defaultFrom;
    to = today;
    invalidDateRange = true;
  }

  const branchIdsFromInput = toIdListWithAll(input.branch_ids);
  const ledgerView =
    String(input.ledger_view || "summary")
      .trim()
      .toLowerCase() === "detail"
      ? "detail"
      : "summary";
  const branchIds = req.user?.isAdmin
    ? branchIdsFromInput
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  return {
    from,
    to,
    entityId: toPositiveId(input.entity_id),
    ledgerView,
    branchIds,
    reportLoaded: toBoolean(input.load_report, false),
    invalidFromDate: Boolean(parsedFrom.provided && !parsedFrom.valid),
    invalidToDate: Boolean(parsedTo.provided && !parsedTo.valid),
    invalidDateRange,
    invalidFilterInput: Boolean(
      (parsedFrom.provided && !parsedFrom.valid) ||
      (parsedTo.provided && !parsedTo.valid) ||
      invalidDateRange,
    ),
  };
};

const ENTITY_CONFIG = Object.freeze({
  labour: {
    table: "erp.labours",
    alias: "l",
    idCol: "id",
    codeCol: "code",
    nameCol: "name",
    nameUrCol: "name_ur",
    statusExpr: "lower(trim(coalesce(l.status, ''))) = 'active'",
    branchMapTable: "erp.labour_branch",
    branchMapEntityCol: "labour_id",
    vlEntityCol: "labour_id",
    lineKind: "LABOUR",
    buyerCol: "buyer_labour_id",
  },
  employee: {
    table: "erp.employees",
    alias: "e",
    idCol: "id",
    codeCol: "code",
    nameCol: "name",
    nameUrCol: "name_ur",
    statusExpr: "lower(trim(coalesce(e.status, ''))) = 'active'",
    branchMapTable: "erp.employee_branch",
    branchMapEntityCol: "employee_id",
    vlEntityCol: "employee_id",
    lineKind: "EMPLOYEE",
    buyerCol: "buyer_employee_id",
  },
});

// Credit sales to an employee/labour buyer (sales_header.buyer_employee_id /
// buyer_labour_id) never produce an EMPLOYEE/LABOUR voucher_line row — the sale's
// article lines are all line_kind='SKU'. So these vouchers are invisible to the
// voucher_line-based ledger/balance queries above unless we also pull them in
// from the already-posted GL entries (reusing the posted numbers avoids
// re-deriving the net-sale math, which has extra_discount/SO-discount/
// payment-received adjustments baked in).
const STAFF_RECEIVABLE_GROUP_CODES = [
  "staff_receivable_control",
  "accounts_receivable_control",
];

const buildStaffCreditSaleQuery = ({ cfg, scopedBranchIds }) => {
  let q = knex("erp.gl_entry as ge")
    .join("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .join("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
    .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
    .where("vh.voucher_type_code", "SALES_VOUCHER")
    .andWhere("vh.status", "APPROVED")
    .whereNotNull(`sh.${cfg.buyerCol}`)
    .whereIn("ge.account_id", function inAccountGroup() {
      this.select("a.id")
        .from("erp.accounts as a")
        .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
        .whereIn("ag.code", STAFF_RECEIVABLE_GROUP_CODES);
    });
  if (scopedBranchIds.length) q = q.whereIn("vh.branch_id", scopedBranchIds);
  return q;
};

// Sales commission is earned/posted separately from the EMPLOYEE voucher_line
// ledger above (erp.commission_ledger, keyed by commission_type), so it needs
// its own query to be folded into the employee payable balance and ledger.
const buildCommissionQuery = ({ scopedBranchIds }) => {
  let q = knex("erp.commission_ledger as cl")
    .join("erp.voucher_header as vh", "vh.id", "cl.voucher_id")
    .andWhere("vh.status", "APPROVED");
  if (scopedBranchIds.length) q = q.whereIn("vh.branch_id", scopedBranchIds);
  return q;
};

const getEntityConfig = (kind) => {
  const cfg = ENTITY_CONFIG[kind];
  if (!cfg) throw new Error("Invalid report entity kind");
  return cfg;
};

const applyEntityVoucherScope = ({
  query,
  cfg,
  entityId,
  includeEntitySelect = false,
}) => {
  if (cfg.lineKind !== "LABOUR") {
    return query
      .modify((qb) => {
        if (includeEntitySelect)
          qb.select(`vl.${cfg.vlEntityCol} as entity_id`);
      })
      .where("vl.line_kind", cfg.lineKind)
      .modify((qb) => {
        if (entityId != null) qb.andWhere(`vl.${cfg.vlEntityCol}`, entityId);
      });
  }

  return query
    .leftJoin("erp.dcv_header as dcv", "dcv.voucher_id", "vh.id")
    .modify((qb) => {
      if (includeEntitySelect)
        qb.select(knex.raw(`${LABOUR_ENTITY_SQL} as entity_id`));
    })
    .where(function whereLabourRows() {
      this.where(function whereDirectLabourLine() {
        this.where("vl.line_kind", "LABOUR").whereNotNull("vl.labour_id");
      }).orWhere(function whereDcvSkuLine() {
        this.where("vh.voucher_type_code", "DCV")
          .andWhere("vl.line_kind", "SKU")
          .whereNotNull("dcv.labour_id");
      });
    })
    .modify((qb) => {
      if (entityId != null)
        qb.andWhereRaw(`${LABOUR_ENTITY_SQL} = ?`, [entityId]);
    });
};

const loadLedgerOptions = async ({ req, filters, kind }) => {
  const cfg = getEntityConfig(kind);
  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const branches = req.user?.isAdmin
    ? await knex("erp.branches")
        .select("id", "name")
        .where({ is_active: true })
        .orderBy("name", "asc")
    : (req.branchOptions || []).map((row) => ({
        id: Number(row.id),
        name: row.name,
      }));

  let query = knex(`${cfg.table} as ${cfg.alias}`)
    .select(
      `${cfg.alias}.${cfg.idCol} as id`,
      `${cfg.alias}.${cfg.codeCol} as code`,
      `${cfg.alias}.${cfg.nameCol} as name`,
      `${cfg.alias}.${cfg.nameUrCol} as name_ur`,
    )
    .whereRaw(cfg.statusExpr)
    .orderBy(`${cfg.alias}.${cfg.nameCol}`, "asc");

  if (scopedBranchIds.length) {
    query = query.whereExists(function whereEntityBranch() {
      this.select(1)
        .from(`${cfg.branchMapTable} as bm`)
        .whereRaw(`bm.${cfg.branchMapEntityCol} = ${cfg.alias}.${cfg.idCol}`)
        .whereIn("bm.branch_id", scopedBranchIds);
    });
  }

  const entities = await query;
  return { branches, entities };
};

const getLedgerRows = async ({ req, filters, options, kind }) => {
  const cfg = getEntityConfig(kind);
  const includeBranchColumn = Boolean(
    req.user?.isAdmin && filters.branchIds.length !== 1,
  );

  if (!filters.reportLoaded || !filters.entityId) {
    return {
      entity: null,
      openingBalance: 0,
      rows: [],
      totals: { qty: 0, debit: 0, credit: 0, closingBalance: 0 },
      includeBranchColumn,
    };
  }

  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const selectedEntity = (options.entities || []).find(
    (row) => Number(row.id) === Number(filters.entityId),
  );

  let openingQuery = knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .select(knex.raw(`COALESCE(SUM(${LEDGER_NET_SQL}), 0) as opening_balance`))
    .andWhere("vh.status", "APPROVED")
    .modify((qb) => {
      if (scopedBranchIds.length) qb.whereIn("vh.branch_id", scopedBranchIds);
      if (filters.from) qb.where("vh.voucher_date", "<", filters.from);
    });

  openingQuery = applyEntityVoucherScope({
    query: openingQuery,
    cfg,
    entityId: filters.entityId,
  });
  const openingRow = await openingQuery.first();

  const staffOpeningQuery = buildStaffCreditSaleQuery({ cfg, scopedBranchIds })
    .andWhere(`sh.${cfg.buyerCol}`, filters.entityId)
    .modify((qb) => {
      if (filters.from) qb.andWhere("vh.voucher_date", "<", filters.from);
    })
    .select(
      knex.raw("COALESCE(SUM(ge.cr), 0) as cr"),
      knex.raw("COALESCE(SUM(ge.dr), 0) as dr"),
    );
  const staffOpeningRow = await staffOpeningQuery.first();
  const staffOpeningBalance =
    Number(staffOpeningRow?.cr || 0) - Number(staffOpeningRow?.dr || 0);

  let commissionOpeningBalance = 0;
  if (kind === "employee") {
    const commissionOpeningRow = await buildCommissionQuery({
      scopedBranchIds,
    })
      .andWhere("cl.employee_id", filters.entityId)
      .modify((qb) => {
        if (filters.from) qb.andWhere("vh.voucher_date", "<", filters.from);
      })
      .select(knex.raw("COALESCE(SUM(cl.total_amount), 0) as amount"))
      .first();
    commissionOpeningBalance = Number(commissionOpeningRow?.amount || 0);
  }

  let detailsQuery = knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
    .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
    .select(
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"),
      "vh.id as voucher_id",
      "vh.voucher_type_code",
      "vh.voucher_no",
      "vh.book_no as bill_number",
      "b.name as branch_name",
      knex.raw(`COALESCE(
        NULLIF(vl.meta->>'description',''),
        NULLIF(vh.remarks, ''),
        CASE
          WHEN vl.line_kind = 'SKU' THEN NULLIF(
            CONCAT(
              'SKU ',
              COALESCE(s.sku_code, ''),
              CASE WHEN COALESCE(i.name, '') = '' THEN '' ELSE CONCAT(' - ', i.name) END
            ),
            'SKU '
          )
          WHEN vl.line_kind = 'LABOUR' THEN NULLIF(CONCAT('Labour ', COALESCE(l.name, '')), 'Labour ')
          WHEN vl.line_kind = 'EMPLOYEE' THEN NULLIF(CONCAT('Employee ', COALESCE(e.name, '')), 'Employee ')
          ELSE NULL
        END,
        CONCAT(vh.voucher_type_code, ' #', vh.voucher_no::text)
      ) as description`),
      knex.raw("COALESCE(vl.qty, 0) as qty"),
      knex.raw(`${LEDGER_DEBIT_SQL} as dr`),
      knex.raw(`${LEDGER_CREDIT_SQL} as cr`),
      knex.raw(`${IS_SALES_COMMISSION_LINE_SQL} as is_sales_commission`),
      "vl.id",
      "vl.line_no",
    )
    .andWhere("vh.status", "APPROVED")
    .where("vh.voucher_date", ">=", filters.from)
    .where("vh.voucher_date", "<=", filters.to)
    .orderBy("vh.voucher_date", "asc")
    .orderBy("vh.voucher_type_code", "asc")
    .orderBy("vh.voucher_no", "asc")
    .orderBy("vh.id", "asc")
    .orderBy("vl.line_no", "asc")
    .orderBy("vl.id", "asc");

  if (scopedBranchIds.length) {
    detailsQuery = detailsQuery.whereIn("vh.branch_id", scopedBranchIds);
  }
  detailsQuery = applyEntityVoucherScope({
    query: detailsQuery,
    cfg,
    entityId: filters.entityId,
  });

  const rawRows = await detailsQuery;
  let openingBalance = toAmount(
    Number(openingRow?.opening_balance || 0) +
      staffOpeningBalance +
      commissionOpeningBalance,
    2,
  );

  const staffDetailsQuery = buildStaffCreditSaleQuery({ cfg, scopedBranchIds })
    .leftJoin("erp.branches as b2", "b2.id", "vh.branch_id")
    .andWhere(`sh.${cfg.buyerCol}`, filters.entityId)
    .andWhere("vh.voucher_date", ">=", filters.from)
    .andWhere("vh.voucher_date", "<=", filters.to)
    .select(
      "ge.id as id",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"),
      "vh.id as voucher_id",
      "vh.voucher_type_code",
      "vh.voucher_no",
      "vh.book_no as bill_number",
      "b2.name as branch_name",
      knex.raw(
        `COALESCE(NULLIF(vh.remarks, ''), CONCAT('Credit Sale #', vh.voucher_no::text)) as description`,
      ),
      knex.raw("0 as qty"),
      "ge.dr",
      "ge.cr",
    );
  const staffDetailRows = await staffDetailsQuery;

  let commissionDetailRows = [];
  if (kind === "employee") {
    commissionDetailRows = await buildCommissionQuery({ scopedBranchIds })
      .leftJoin("erp.branches as b3", "b3.id", "vh.branch_id")
      .andWhere("cl.employee_id", filters.entityId)
      .andWhere("vh.voucher_date", ">=", filters.from)
      .andWhere("vh.voucher_date", "<=", filters.to)
      .select(
        "cl.id as id",
        knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as entry_date"),
        "vh.id as voucher_id",
        "vh.voucher_type_code",
        "vh.voucher_no",
        "vh.book_no as bill_number",
        "b3.name as branch_name",
        "cl.commission_type",
        "cl.total_amount",
      );
  }

  let syntheticEmployeeRows = [];
  let accrualMeta = null;
  if (kind === "employee" && Number(filters.entityId || 0) > 0) {
    const accrualProfileMap = await loadEmployeeAccrualProfiles({
      entityIds: [Number(filters.entityId)],
    });
    accrualMeta = accrualProfileMap.get(Number(filters.entityId)) || null;

    if (
      accrualMeta &&
      accrualMeta.payrollType === "MONTHLY" &&
      Number(accrualMeta.monthlyAmount || 0) > 0
    ) {
      const fromDateUtc = toUtcDateFromYmd(filters.from);
      const openingAsOnDate = fromDateUtc
        ? toYmd(new Date(fromDateUtc.getTime() - 24 * 60 * 60 * 1000))
        : null;
      const openingAccrualCount = countMonthlyAccrualsUpTo({
        employmentStartYmd: accrualMeta.employmentStartYmd,
        asOnYmd: openingAsOnDate || filters.from,
      });
      if (openingAccrualCount > 0) {
        openingBalance = toAmount(
          openingBalance +
            Number(accrualMeta.monthlyAmount || 0) *
              Number(openingAccrualCount || 0),
          2,
        );
      }
      syntheticEmployeeRows = buildMonthlyAccrualRowsInRange({
        employmentStartYmd: accrualMeta.employmentStartYmd,
        fromYmd: filters.from,
        toYmdValue: filters.to,
        monthlyAmount: Number(accrualMeta.monthlyAmount || 0),
        idSeed: Number(filters.entityId),
      });
    } else if (
      accrualMeta &&
      accrualMeta.payrollType === "DAILY" &&
      Number(accrualMeta.dailyAmount || 0) > 0
    ) {
      const fromDateUtc = toUtcDateFromYmd(filters.from);
      const openingAsOnDate = fromDateUtc
        ? toYmd(new Date(fromDateUtc.getTime() - 24 * 60 * 60 * 1000))
        : null;
      const openingAccrualCount = countDailyAccrualDaysUpTo({
        employmentStartYmd: accrualMeta.employmentStartYmd,
        asOnYmd: openingAsOnDate || filters.from,
      });
      if (openingAccrualCount > 0) {
        openingBalance = toAmount(
          openingBalance +
            Number(accrualMeta.dailyAmount || 0) *
              Number(openingAccrualCount || 0),
          2,
        );
      }
      syntheticEmployeeRows = buildDailyAccrualRowsInRange({
        employmentStartYmd: accrualMeta.employmentStartYmd,
        fromYmd: filters.from,
        toYmdValue: filters.to,
        dailyAmount: Number(accrualMeta.dailyAmount || 0),
        idSeed: Number(filters.entityId),
      });
    }
  }

  const detailEntries = rawRows
    .map((row) => ({
      id: Number(row.id || 0),
      voucher_id: Number(row.voucher_id || 0) || null,
      entry_date: row.entry_date || null,
      voucher_no: row.voucher_no || null,
      bill_number: row.bill_number || "",
      voucher_type: row.voucher_type_code || "",
      description: row.description || "",
      qty: toQty(row.qty, 3),
      debit: toAmount(row.dr, 2),
      credit: toAmount(row.cr, 2),
      branch_name: row.branch_name || "",
    }))
    // Exclude non-financial rows (e.g. pair-only status rows with zero posting).
    .filter(
      (entry) =>
        Math.abs(Number(entry.debit || 0)) > 0.0001 ||
        Math.abs(Number(entry.credit || 0)) > 0.0001,
    );

  syntheticEmployeeRows.forEach((entry) => {
    detailEntries.push({
      id: Number(entry.id || 0),
      voucher_id: null,
      entry_date: entry.entry_date || null,
      voucher_no: null,
      bill_number: "",
      voucher_type: entry.voucher_type || AUTO_PAYROLL_VOUCHER_TYPE,
      description: entry.description || AUTO_PAYROLL_DESCRIPTION,
      qty: 0,
      debit: 0,
      credit: toAmount(entry.credit || 0, 2),
      branch_name: "",
    });
  });

  staffDetailRows.forEach((row) => {
    detailEntries.push({
      id: Number(row.id || 0),
      voucher_id: Number(row.voucher_id || 0) || null,
      entry_date: row.entry_date || null,
      voucher_no: row.voucher_no || null,
      bill_number: row.bill_number || "",
      voucher_type: row.voucher_type_code || "",
      description: row.description || "",
      qty: 0,
      debit: toAmount(row.dr, 2),
      credit: toAmount(row.cr, 2),
      branch_name: row.branch_name || "",
    });
  });

  commissionDetailRows.forEach((row) => {
    const commissionType = String(row.commission_type || "");
    detailEntries.push({
      id: Number(row.id || 0),
      voucher_id: Number(row.voucher_id || 0) || null,
      entry_date: row.entry_date || null,
      voucher_no: row.voucher_no || null,
      bill_number: row.bill_number || "",
      voucher_type: row.voucher_type_code || "",
      description:
        COMMISSION_TYPE_DESCRIPTIONS[commissionType] ||
        `Sales Commission (${commissionType})`,
      qty: 0,
      debit: 0,
      credit: toAmount(row.total_amount, 2),
      branch_name: row.branch_name || "",
    });
  });

  // Rows can arrive from four different sources (voucher_line query, synthetic
  // payroll accrual rows, staff-credit-sale rows above) so re-sort chronologically
  // before computing the running balance.
  detailEntries.sort((a, b) => {
    const dateA = String(a.entry_date || "");
    const dateB = String(b.entry_date || "");
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    const typeA = String(a.voucher_type || "");
    const typeB = String(b.voucher_type || "");
    if (typeA !== typeB) return typeA.localeCompare(typeB);
    const voucherA = Number(a.voucher_no || 0);
    const voucherB = Number(b.voucher_no || 0);
    if (voucherA !== voucherB) return voucherA - voucherB;
    const voucherIdA = Number(a.voucher_id || 0);
    const voucherIdB = Number(b.voucher_id || 0);
    if (voucherIdA !== voucherIdB) return voucherIdA - voucherIdB;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  const reportEntries =
    filters.ledgerView === "summary"
      ? (() => {
          const grouped = new Map();
          detailEntries.forEach((entry) => {
            const key = entry.voucher_id
              ? `VID:${entry.voucher_id}`
              : entry.voucher_no
                ? `V:${entry.entry_date || ""}:${entry.voucher_type}:${entry.voucher_no}`
                : `G:${entry.id}`;
            const current = grouped.get(key);
            if (!current) {
              grouped.set(key, { ...entry });
              return;
            }
            current.qty = toQty(current.qty + entry.qty, 3);
            current.debit = toAmount(current.debit + entry.debit, 2);
            current.credit = toAmount(current.credit + entry.credit, 2);
            if (!current.description && entry.description)
              current.description = entry.description;
          });
          return [...grouped.values()].sort((a, b) => {
            const dateA = String(a.entry_date || "");
            const dateB = String(b.entry_date || "");
            if (dateA !== dateB) return dateA.localeCompare(dateB);
            const typeA = String(a.voucher_type || "");
            const typeB = String(b.voucher_type || "");
            if (typeA !== typeB) return typeA.localeCompare(typeB);
            const voucherA = Number(a.voucher_no || 0);
            const voucherB = Number(b.voucher_no || 0);
            if (voucherA !== voucherB) return voucherA - voucherB;
            const voucherIdA = Number(a.voucher_id || 0);
            const voucherIdB = Number(b.voucher_id || 0);
            if (voucherIdA !== voucherIdB) return voucherIdA - voucherIdB;
            return Number(a.id || 0) - Number(b.id || 0);
          });
        })()
      : detailEntries;

  let runningBalance = openingBalance;
  let totalQty = 0;
  let totalDebit = 0;
  let totalCredit = 0;

  const rows = reportEntries.map((entry, index) => {
    totalQty = toQty(totalQty + entry.qty, 3);
    totalDebit = toAmount(totalDebit + entry.debit, 2);
    totalCredit = toAmount(totalCredit + entry.credit, 2);
    runningBalance = toAmount(runningBalance + entry.credit - entry.debit, 2);

    return {
      sr_no: index + 1,
      entry_date: entry.entry_date,
      voucher_no: entry.voucher_no,
      bill_number: entry.bill_number,
      voucher_type: entry.voucher_type,
      description: entry.description,
      qty: entry.qty,
      debit: entry.debit,
      credit: entry.credit,
      balance: runningBalance,
      branch_name: entry.branch_name,
    };
  });

  // Category breakdown: the same debit/credit sources used above, re-sliced by
  // category (commission by type / payments / staff credit purchases / salary /
  // allowances) instead of chronologically — shown alongside the Summary view.
  // Reuses the queries already run above; must reconcile to the same closing
  // balance as the per-voucher `totals` below (verified in report-service tests).
  let categoryBreakdown = null;
  if (kind === "employee" && filters.ledgerView === "summary") {
    const commissionByType = new Map();
    commissionDetailRows.forEach((row) => {
      const type = String(row.commission_type || "");
      const current = commissionByType.get(type) || { credit: 0, debit: 0 };
      current.credit = toAmount(current.credit + Number(row.total_amount || 0), 2);
      commissionByType.set(type, current);
    });

    let paymentsCredit = 0;
    let paymentsDebit = 0;
    let salesCommissionCredit = 0;
    let salesCommissionDebit = 0;
    rawRows.forEach((row) => {
      const debit = toAmount(row.dr, 2);
      const credit = toAmount(row.cr, 2);
      if (Math.abs(debit) < 0.0001 && Math.abs(credit) < 0.0001) return;
      if (row.is_sales_commission) {
        salesCommissionCredit = toAmount(salesCommissionCredit + credit, 2);
        salesCommissionDebit = toAmount(salesCommissionDebit + debit, 2);
      } else {
        paymentsCredit = toAmount(paymentsCredit + credit, 2);
        paymentsDebit = toAmount(paymentsDebit + debit, 2);
      }
    });
    if (
      Math.abs(salesCommissionCredit) >= 0.005 ||
      Math.abs(salesCommissionDebit) >= 0.005
    ) {
      const current = commissionByType.get("SALESMAN_SALE") || {
        credit: 0,
        debit: 0,
      };
      current.credit = toAmount(current.credit + salesCommissionCredit, 2);
      current.debit = toAmount(current.debit + salesCommissionDebit, 2);
      commissionByType.set("SALESMAN_SALE", current);
    }

    let staffCreditPurchaseCredit = 0;
    let staffCreditPurchaseDebit = 0;
    staffDetailRows.forEach((row) => {
      staffCreditPurchaseCredit = toAmount(
        staffCreditPurchaseCredit + Number(row.cr || 0),
        2,
      );
      staffCreditPurchaseDebit = toAmount(
        staffCreditPurchaseDebit + Number(row.dr || 0),
        2,
      );
    });

    let salaryAmount = 0;
    let allowanceAmount = 0;
    if (accrualMeta) {
      const periodCount = syntheticEmployeeRows.length;
      const perCycleSalary =
        accrualMeta.payrollType === "MONTHLY"
          ? Number(accrualMeta.monthlySalaryOnly || 0)
          : accrualMeta.payrollType === "DAILY"
            ? Number(accrualMeta.dailySalaryOnly || 0)
            : 0;
      const perCycleAllowance =
        accrualMeta.payrollType === "MONTHLY"
          ? Number(accrualMeta.monthlyAllowanceOnly || 0)
          : accrualMeta.payrollType === "DAILY"
            ? Number(accrualMeta.dailyAllowanceOnly || 0)
            : 0;
      salaryAmount = toAmount(perCycleSalary * periodCount, 2);
      allowanceAmount = toAmount(perCycleAllowance * periodCount, 2);
    }

    const breakdown = [];
    commissionByType.forEach((value, type) => {
      if (Math.abs(value.credit) < 0.005 && Math.abs(value.debit) < 0.005) return;
      breakdown.push({
        labelKey: `commission_type_${type.toLowerCase()}`,
        debit: value.debit,
        credit: value.credit,
      });
    });
    if (Math.abs(paymentsCredit) >= 0.005 || Math.abs(paymentsDebit) >= 0.005) {
      breakdown.push({
        labelKey: "employee_balance_payments_label",
        debit: paymentsDebit,
        credit: paymentsCredit,
      });
    }
    if (
      Math.abs(staffCreditPurchaseCredit) >= 0.005 ||
      Math.abs(staffCreditPurchaseDebit) >= 0.005
    ) {
      breakdown.push({
        labelKey: "employee_balance_credit_purchases_label",
        debit: staffCreditPurchaseDebit,
        credit: staffCreditPurchaseCredit,
      });
    }
    if (salaryAmount >= 0.005) {
      breakdown.push({ labelKey: "basic_salary", debit: 0, credit: salaryAmount });
    }
    if (allowanceAmount >= 0.005) {
      breakdown.push({ labelKey: "allowances", debit: 0, credit: allowanceAmount });
    }

    const totalDebitBreakdown = toAmount(
      breakdown.reduce((sum, entry) => sum + Number(entry.debit || 0), 0),
      2,
    );
    const totalCreditBreakdown = toAmount(
      breakdown.reduce((sum, entry) => sum + Number(entry.credit || 0), 0),
      2,
    );

    categoryBreakdown = {
      openingBalance,
      breakdown,
      totalDebit: totalDebitBreakdown,
      totalCredit: totalCreditBreakdown,
      closingBalance: toAmount(
        openingBalance + totalCreditBreakdown - totalDebitBreakdown,
        2,
      ),
    };
  }

  return {
    entity: selectedEntity || null,
    openingBalance,
    ledgerView: filters.ledgerView,
    rows,
    totals: {
      qty: totalQty,
      debit: totalDebit,
      credit: totalCredit,
      closingBalance: rows.length
        ? rows[rows.length - 1].balance
        : openingBalance,
    },
    categoryBreakdown,
    includeBranchColumn,
  };
};

const loadBalanceOptions = async ({ req }) => {
  const branches = req.user?.isAdmin
    ? await knex("erp.branches")
        .select("id", "name")
        .where({ is_active: true })
        .orderBy("name", "asc")
    : (req.branchOptions || []).map((row) => ({
        id: Number(row.id),
        name: row.name,
      }));

  return { branches };
};

const getBalanceRows = async ({ req, filters, kind }) => {
  const cfg = getEntityConfig(kind);
  if (!filters.reportLoaded) return [];

  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  let balanceSubquery = knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .sum({
      amount: knex.raw(LEDGER_NET_SQL),
      credit_total: knex.raw(LEDGER_CREDIT_SQL),
      debit_total: knex.raw(LEDGER_DEBIT_SQL),
      sales_commission_credit: knex.raw(
        `CASE WHEN ${IS_SALES_COMMISSION_LINE_SQL} THEN (${LEDGER_CREDIT_SQL}) ELSE 0 END`,
      ),
      sales_commission_debit: knex.raw(
        `CASE WHEN ${IS_SALES_COMMISSION_LINE_SQL} THEN (${LEDGER_DEBIT_SQL}) ELSE 0 END`,
      ),
    })
    .andWhere("vh.status", "APPROVED")
    .where("vh.voucher_date", "<=", filters.asOn)
    .modify((qb) => {
      if (scopedBranchIds.length) qb.whereIn("vh.branch_id", scopedBranchIds);
    });

  balanceSubquery = applyEntityVoucherScope({
    query: balanceSubquery,
    cfg,
    entityId: null,
    includeEntitySelect: true,
  });
  if (cfg.lineKind === "LABOUR") {
    balanceSubquery = balanceSubquery.groupByRaw(LABOUR_ENTITY_SQL);
  } else {
    balanceSubquery = balanceSubquery.groupBy(`vl.${cfg.vlEntityCol}`);
  }
  balanceSubquery = balanceSubquery.as("bal");

  let query = knex(`${cfg.table} as ${cfg.alias}`)
    .leftJoin(balanceSubquery, "bal.entity_id", `${cfg.alias}.${cfg.idCol}`)
    .select(
      `${cfg.alias}.${cfg.idCol} as id`,
      `${cfg.alias}.${cfg.codeCol} as code`,
      `${cfg.alias}.${cfg.nameCol} as name`,
      `${cfg.alias}.${cfg.nameUrCol} as name_ur`,
      knex.raw("COALESCE(bal.amount, 0) as amount"),
      knex.raw("COALESCE(bal.credit_total, 0) as payments_credit"),
      knex.raw("COALESCE(bal.debit_total, 0) as payments_debit"),
      knex.raw(
        "COALESCE(bal.sales_commission_credit, 0) as sales_commission_credit",
      ),
      knex.raw(
        "COALESCE(bal.sales_commission_debit, 0) as sales_commission_debit",
      ),
    )
    .whereRaw(cfg.statusExpr)
    .orderBy(`${cfg.alias}.${cfg.nameCol}`, "asc");

  if (scopedBranchIds.length) {
    query = query.whereExists(function whereEntityBranch() {
      this.select(1)
        .from(`${cfg.branchMapTable} as bm`)
        .whereRaw(`bm.${cfg.branchMapEntityCol} = ${cfg.alias}.${cfg.idCol}`)
        .whereIn("bm.branch_id", scopedBranchIds);
    });
  }

  const rows = await query;

  const staffBalanceRows = await buildStaffCreditSaleQuery({
    cfg,
    scopedBranchIds,
  })
    .andWhere("vh.voucher_date", "<=", filters.asOn)
    .groupBy(`sh.${cfg.buyerCol}`)
    .select(`sh.${cfg.buyerCol} as entity_id`)
    .sum({
      amount: knex.raw("ge.cr - ge.dr"),
      credit_total: "ge.cr",
      debit_total: "ge.dr",
    });
  const staffBalanceByEntity = new Map(
    staffBalanceRows.map((row) => [
      Number(row.entity_id || 0),
      {
        amount: Number(row.amount || 0),
        credit: Number(row.credit_total || 0),
        debit: Number(row.debit_total || 0),
      },
    ]),
  );

  let commissionByEmployee = new Map();
  if (kind === "employee") {
    const commissionRows = await buildCommissionQuery({ scopedBranchIds })
      .andWhere("vh.voucher_date", "<=", filters.asOn)
      .groupBy("cl.employee_id", "cl.commission_type")
      .select("cl.employee_id as entity_id", "cl.commission_type")
      .sum({ amount: "cl.total_amount" });
    commissionRows.forEach((row) => {
      const employeeId = Number(row.entity_id || 0);
      if (!employeeId) return;
      const list = commissionByEmployee.get(employeeId) || [];
      list.push({
        commissionType: row.commission_type,
        amount: Number(row.amount || 0),
      });
      commissionByEmployee.set(employeeId, list);
    });
  }

  let salaryAccrualAmountByEmployee = new Map();
  let salaryOnlyAmountByEmployee = new Map();
  let allowanceOnlyAmountByEmployee = new Map();
  if (kind === "employee" && rows.length) {
    const employeeIds = rows
      .map((row) => Number(row.id || 0))
      .filter((id) => Number.isInteger(id) && id > 0);
    const accrualProfileMap = await loadEmployeeAccrualProfiles({
      entityIds: employeeIds,
    });
    accrualProfileMap.forEach((meta, employeeId) => {
      let count = 0;
      let perCycleAmount = 0;
      let perCycleSalary = 0;
      let perCycleAllowance = 0;
      if (meta.payrollType === "MONTHLY") {
        count = countMonthlyAccrualsUpTo({
          employmentStartYmd: meta.employmentStartYmd,
          asOnYmd: filters.asOn,
        });
        perCycleAmount = Number(meta.monthlyAmount || 0);
        perCycleSalary = Number(meta.monthlySalaryOnly || 0);
        perCycleAllowance = Number(meta.monthlyAllowanceOnly || 0);
      } else if (meta.payrollType === "DAILY") {
        count = countDailyAccrualDaysUpTo({
          employmentStartYmd: meta.employmentStartYmd,
          asOnYmd: filters.asOn,
        });
        perCycleAmount = Number(meta.dailyAmount || 0);
        perCycleSalary = Number(meta.dailySalaryOnly || 0);
        perCycleAllowance = Number(meta.dailyAllowanceOnly || 0);
      }
      salaryAccrualAmountByEmployee.set(
        Number(employeeId),
        toAmount(Number(perCycleAmount || 0) * Number(count || 0), 2),
      );
      salaryOnlyAmountByEmployee.set(
        Number(employeeId),
        toAmount(Number(perCycleSalary || 0) * Number(count || 0), 2),
      );
      allowanceOnlyAmountByEmployee.set(
        Number(employeeId),
        toAmount(Number(perCycleAllowance || 0) * Number(count || 0), 2),
      );
    });
  }

  const isDetailView = kind === "employee" && filters.viewMode === "detail";

  return rows.map((row) => {
    const employeeId = Number(row.id || 0) || null;
    const staffInfo = staffBalanceByEntity.get(employeeId) || {
      amount: 0,
      credit: 0,
      debit: 0,
    };
    const commissionEntries = commissionByEmployee.get(employeeId) || [];
    const commissionTotal = commissionEntries.reduce(
      (sum, entry) => sum + Number(entry.amount || 0),
      0,
    );

    const amount = toAmount(
      Number(row.amount || 0) +
        Number(salaryAccrualAmountByEmployee.get(employeeId) || 0) +
        Number(staffInfo.amount || 0) +
        commissionTotal,
      2,
    );

    const result = {
      entity_id: employeeId,
      entity_code: row.code || "",
      entity_name: row.name || "",
      entity_name_ur: row.name_ur || "",
      amount,
    };

    if (isDetailView) {
      const commissionByType = new Map();
      commissionEntries.forEach((entry) => {
        const type = String(entry.commissionType || "");
        const current = commissionByType.get(type) || { credit: 0, debit: 0 };
        current.credit = toAmount(current.credit + Number(entry.amount || 0), 2);
        commissionByType.set(type, current);
      });
      const salesCommissionCredit = toAmount(row.sales_commission_credit, 2);
      const salesCommissionDebit = toAmount(row.sales_commission_debit, 2);
      if (
        Math.abs(salesCommissionCredit) >= 0.005 ||
        Math.abs(salesCommissionDebit) >= 0.005
      ) {
        const current = commissionByType.get("SALESMAN_SALE") || {
          credit: 0,
          debit: 0,
        };
        current.credit = toAmount(current.credit + salesCommissionCredit, 2);
        current.debit = toAmount(current.debit + salesCommissionDebit, 2);
        commissionByType.set("SALESMAN_SALE", current);
      }

      const breakdown = [];
      commissionByType.forEach((value, type) => {
        if (Math.abs(value.credit) < 0.005 && Math.abs(value.debit) < 0.005) return;
        breakdown.push({
          labelKey: `commission_type_${type.toLowerCase()}`,
          debit: value.debit,
          credit: value.credit,
        });
      });

      const paymentsCredit = toAmount(
        row.payments_credit - salesCommissionCredit,
        2,
      );
      const paymentsDebit = toAmount(row.payments_debit - salesCommissionDebit, 2);
      if (Math.abs(paymentsCredit) >= 0.005 || Math.abs(paymentsDebit) >= 0.005) {
        breakdown.push({
          labelKey: "employee_balance_payments_label",
          debit: paymentsDebit,
          credit: paymentsCredit,
        });
      }

      const creditPurchaseCredit = toAmount(staffInfo.credit, 2);
      const creditPurchaseDebit = toAmount(staffInfo.debit, 2);
      if (
        Math.abs(creditPurchaseCredit) >= 0.005 ||
        Math.abs(creditPurchaseDebit) >= 0.005
      ) {
        breakdown.push({
          labelKey: "employee_balance_credit_purchases_label",
          debit: creditPurchaseDebit,
          credit: creditPurchaseCredit,
        });
      }

      const salaryAmount = toAmount(
        salaryOnlyAmountByEmployee.get(employeeId) || 0,
        2,
      );
      if (salaryAmount >= 0.005) {
        breakdown.push({ labelKey: "basic_salary", debit: 0, credit: salaryAmount });
      }

      const allowanceAmount = toAmount(
        allowanceOnlyAmountByEmployee.get(employeeId) || 0,
        2,
      );
      if (allowanceAmount >= 0.005) {
        breakdown.push({ labelKey: "allowances", debit: 0, credit: allowanceAmount });
      }

      result.breakdown = breakdown;
      result.totalDebit = toAmount(
        breakdown.reduce((sum, entry) => sum + Number(entry.debit || 0), 0),
        2,
      );
      result.totalCredit = toAmount(
        breakdown.reduce((sum, entry) => sum + Number(entry.credit || 0), 0),
        2,
      );
    }

    return result;
  });
};

const getLabourLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseEntityLedgerFilters({ req, input });
  const options = await loadLedgerOptions({ req, filters, kind: "labour" });
  const reportData = await getLedgerRows({
    req,
    filters,
    options,
    kind: "labour",
  });
  return { filters, options, reportData };
};

const getEmployeeLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseEntityLedgerFilters({ req, input });
  const options = await loadLedgerOptions({ req, filters, kind: "employee" });
  const reportData = await getLedgerRows({
    req,
    filters,
    options,
    kind: "employee",
  });
  return { filters, options, reportData };
};

const getLabourBalancesReportPageData = async ({ req, input = {} }) => {
  const filters = parseEntityBalanceFilters({ req, input });
  const [options, rows] = await Promise.all([
    loadBalanceOptions({ req }),
    getBalanceRows({ req, filters, kind: "labour" }),
  ]);

  return {
    filters,
    options,
    reportData: {
      rows,
      totalAmount: toAmount(
        rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        2,
      ),
    },
  };
};

const getEmployeeBalancesReportPageData = async ({ req, input = {} }) => {
  const filters = parseEntityBalanceFilters({ req, input });
  const [options, rows] = await Promise.all([
    loadBalanceOptions({ req }),
    getBalanceRows({ req, filters, kind: "employee" }),
  ]);

  return {
    filters,
    options,
    reportData: {
      rows,
      totalAmount: toAmount(
        rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        2,
      ),
    },
  };
};

module.exports = {
  getLabourLedgerReportPageData,
  getLabourBalancesReportPageData,
  getEmployeeLedgerReportPageData,
  getEmployeeBalancesReportPageData,
};
