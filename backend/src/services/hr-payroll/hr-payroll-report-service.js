"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const { toBoolean, toIdList } = require("../../utils/report-filter-types");

const ALL_MULTI_FILTER_VALUE = "__ALL__";
const DEBIT_META_SQL = "COALESCE(NULLIF(vl.meta->>'debit','')::numeric, 0)";
const CREDIT_META_SQL = "COALESCE(NULLIF(vl.meta->>'credit','')::numeric, 0)";
const RESOLVED_DEBIT_SQL = `CASE WHEN ${DEBIT_META_SQL} = 0 AND ${CREDIT_META_SQL} = 0 THEN COALESCE(vl.amount, 0) ELSE ${DEBIT_META_SQL} END`;
const RESOLVED_CREDIT_SQL = `CASE WHEN ${DEBIT_META_SQL} = 0 AND ${CREDIT_META_SQL} = 0 THEN 0 ELSE ${CREDIT_META_SQL} END`;
// HR ledgers are payable-oriented:
// payable increase = credit, payment = debit.
const LEDGER_DEBIT_SQL = `${RESOLVED_CREDIT_SQL}`;
const LEDGER_CREDIT_SQL = `${RESOLVED_DEBIT_SQL}`;
const LEDGER_NET_SQL = `(${LEDGER_CREDIT_SQL}) - (${LEDGER_DEBIT_SQL})`;
const LABOUR_ENTITY_SQL = "CASE WHEN vh.voucher_type_code = 'DCV' THEN dcv.labour_id ELSE vl.labour_id END";
const AUTO_PAYROLL_VOUCHER_TYPE = "PAYROLL_ACCRUAL";
const AUTO_PAYROLL_DESCRIPTION = "Monthly salary accrual";

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

const countMonthlyAccrualsUpTo = ({ employmentStartYmd, asOnYmd }) => {
  const firstAccrualYmd = getFirstAccrualDateYmd(employmentStartYmd);
  if (!firstAccrualYmd || asOnYmd < firstAccrualYmd) return 0;
  const firstAccrualMonthStart = monthStartUtc(toUtcDateFromYmd(firstAccrualYmd));
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
  const firstAccrualMonthStart = monthStartUtc(toUtcDateFromYmd(firstAccrualYmd));
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

const loadEmployeeMonthlyAmounts = async ({ entityIds = [] }) => {
  const normalizedIds = [...new Set((entityIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!normalizedIds.length) return new Map();
  const employeeRows = await knex("erp.employees as e")
    .select("e.id", "e.basic_salary", "e.created_at")
    .whereIn("e.id", normalizedIds)
    .where("e.payroll_type", "MONTHLY")
    .whereRaw("lower(trim(coalesce(e.status, ''))) = 'active'");
  const allowanceRows = await knex("erp.employee_allowance_rules as ar")
    .select("ar.employee_id")
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
    .whereRaw("upper(coalesce(ar.frequency, '')) = 'MONTHLY'")
    .whereRaw("lower(trim(coalesce(ar.status, ''))) = 'active'")
    .groupBy("ar.employee_id");
  const allowanceMap = new Map(
    (allowanceRows || []).map((row) => [
      Number(row.employee_id || 0),
      {
        fixedAmount: Number(row.fixed_amount || 0),
        percentAmount: Number(row.percent_amount || 0),
      },
    ]),
  );
  const result = new Map();
  (employeeRows || []).forEach((row) => {
    const employeeId = Number(row.id || 0);
    if (!employeeId) return;
    const basicSalary = Number(row.basic_salary || 0);
    const allowance = allowanceMap.get(employeeId) || {
      fixedAmount: 0,
      percentAmount: 0,
    };
    const monthlyAmount = Number(
      (
        basicSalary +
        Number(allowance.fixedAmount || 0) +
        (basicSalary * Number(allowance.percentAmount || 0)) / 100
      ).toFixed(2),
    );
    result.set(employeeId, {
      monthlyAmount: Number.isFinite(monthlyAmount) && monthlyAmount > 0 ? monthlyAmount : 0,
      employmentStartYmd:
        toLocalDateOnly(row.created_at || new Date()) || toLocalDateOnly(new Date()),
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
  if (!Number.isInteger(y) || !Number.isInteger(mm) || !Number.isInteger(dd)) return null;
  const dt = new Date(Date.UTC(y, mm - 1, dd));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
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
    : [Number(req.branchId || 0)].filter((id) => Number.isInteger(id) && id > 0);

  return {
    asOn,
    branchIds,
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
    String(input.ledger_view || "summary").trim().toLowerCase() === "detail"
      ? "detail"
      : "summary";
  const branchIds = req.user?.isAdmin
    ? branchIdsFromInput
    : [Number(req.branchId || 0)].filter((id) => Number.isInteger(id) && id > 0);

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
  },
});

const getEntityConfig = (kind) => {
  const cfg = ENTITY_CONFIG[kind];
  if (!cfg) throw new Error("Invalid report entity kind");
  return cfg;
};

const applyEntityVoucherScope = ({ query, cfg, entityId, includeEntitySelect = false }) => {
  if (cfg.lineKind !== "LABOUR") {
    return query
      .modify((qb) => {
        if (includeEntitySelect) qb.select(`vl.${cfg.vlEntityCol} as entity_id`);
      })
      .where("vl.line_kind", cfg.lineKind)
      .modify((qb) => {
        if (entityId != null) qb.andWhere(`vl.${cfg.vlEntityCol}`, entityId);
      });
  }

  return query
    .leftJoin("erp.dcv_header as dcv", "dcv.voucher_id", "vh.id")
    .modify((qb) => {
      if (includeEntitySelect) qb.select(knex.raw(`${LABOUR_ENTITY_SQL} as entity_id`));
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
      if (entityId != null) qb.andWhereRaw(`${LABOUR_ENTITY_SQL} = ?`, [entityId]);
    });
};

const loadLedgerOptions = async ({ req, filters, kind }) => {
  const cfg = getEntityConfig(kind);
  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter((id) => Number.isInteger(id) && id > 0);

  const branches = req.user?.isAdmin
    ? await knex("erp.branches").select("id", "name").where({ is_active: true }).orderBy("name", "asc")
    : (req.branchOptions || []).map((row) => ({ id: Number(row.id), name: row.name }));

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
  const includeBranchColumn = Boolean(req.user?.isAdmin && filters.branchIds.length !== 1);

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
    : [Number(req.branchId || 0)].filter((id) => Number.isInteger(id) && id > 0);

  const selectedEntity = (options.entities || []).find((row) => Number(row.id) === Number(filters.entityId));

  let openingQuery = knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .select(
      knex.raw(
        `COALESCE(SUM(${LEDGER_NET_SQL}), 0) as opening_balance`,
      ),
    )
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
  let openingBalance = toAmount(openingRow?.opening_balance || 0, 2);

  let syntheticEmployeeRows = [];
  if (kind === "employee" && Number(filters.entityId || 0) > 0) {
    const monthlyAmountMap = await loadEmployeeMonthlyAmounts({
      entityIds: [Number(filters.entityId)],
    });
    const monthlyMeta = monthlyAmountMap.get(Number(filters.entityId));
    if (monthlyMeta && Number(monthlyMeta.monthlyAmount || 0) > 0) {
      const fromDateUtc = toUtcDateFromYmd(filters.from);
      const openingAsOnDate = fromDateUtc
        ? toYmd(new Date(fromDateUtc.getTime() - 24 * 60 * 60 * 1000))
        : null;
      const openingAccrualCount = countMonthlyAccrualsUpTo({
        employmentStartYmd: monthlyMeta.employmentStartYmd,
        asOnYmd: openingAsOnDate || filters.from,
      });
      if (openingAccrualCount > 0) {
        openingBalance = toAmount(
          openingBalance +
            Number(monthlyMeta.monthlyAmount || 0) * Number(openingAccrualCount || 0),
          2,
        );
      }
      syntheticEmployeeRows = buildMonthlyAccrualRowsInRange({
        employmentStartYmd: monthlyMeta.employmentStartYmd,
        fromYmd: filters.from,
        toYmdValue: filters.to,
        monthlyAmount: Number(monthlyMeta.monthlyAmount || 0),
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
    .filter((entry) => Math.abs(Number(entry.debit || 0)) > 0.0001 || Math.abs(Number(entry.credit || 0)) > 0.0001);

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
            if (!current.description && entry.description) current.description = entry.description;
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

  return {
    entity: selectedEntity || null,
    openingBalance,
    ledgerView: filters.ledgerView,
    rows,
    totals: {
      qty: totalQty,
      debit: totalDebit,
      credit: totalCredit,
      closingBalance: rows.length ? rows[rows.length - 1].balance : openingBalance,
    },
    includeBranchColumn,
  };
};

const loadBalanceOptions = async ({ req }) => {
  const branches = req.user?.isAdmin
    ? await knex("erp.branches").select("id", "name").where({ is_active: true }).orderBy("name", "asc")
    : (req.branchOptions || []).map((row) => ({ id: Number(row.id), name: row.name }));

  return { branches };
};

const getBalanceRows = async ({ req, filters, kind }) => {
  const cfg = getEntityConfig(kind);
  if (!filters.reportLoaded) return [];

  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter((id) => Number.isInteger(id) && id > 0);

  let balanceSubquery = knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .sum({ amount: knex.raw(LEDGER_NET_SQL) })
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
  let salaryAccrualAmountByEmployee = new Map();
  if (kind === "employee" && rows.length) {
    const employeeIds = rows
      .map((row) => Number(row.id || 0))
      .filter((id) => Number.isInteger(id) && id > 0);
    const monthlyAmountMap = await loadEmployeeMonthlyAmounts({
      entityIds: employeeIds,
    });
    salaryAccrualAmountByEmployee = new Map(
      [...monthlyAmountMap.entries()].map(([employeeId, meta]) => {
        const count = countMonthlyAccrualsUpTo({
          employmentStartYmd: meta.employmentStartYmd,
          asOnYmd: filters.asOn,
        });
        return [
          Number(employeeId),
          toAmount(Number(meta.monthlyAmount || 0) * Number(count || 0), 2),
        ];
      }),
    );
  }
  return rows.map((row) => ({
    entity_id: Number(row.id || 0) || null,
    entity_code: row.code || "",
    entity_name: row.name || "",
    entity_name_ur: row.name_ur || "",
    amount: toAmount(
      Number(row.amount || 0) +
        Number(salaryAccrualAmountByEmployee.get(Number(row.id || 0)) || 0),
      2,
    ),
  }));
};

const getLabourLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseEntityLedgerFilters({ req, input });
  const options = await loadLedgerOptions({ req, filters, kind: "labour" });
  const reportData = await getLedgerRows({ req, filters, options, kind: "labour" });
  return { filters, options, reportData };
};

const getEmployeeLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseEntityLedgerFilters({ req, input });
  const options = await loadLedgerOptions({ req, filters, kind: "employee" });
  const reportData = await getLedgerRows({ req, filters, options, kind: "employee" });
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
      totalAmount: toAmount(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0), 2),
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
      totalAmount: toAmount(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0), 2),
    },
  };
};

module.exports = {
  getLabourLedgerReportPageData,
  getLabourBalancesReportPageData,
  getEmployeeLedgerReportPageData,
  getEmployeeBalancesReportPageData,
};
