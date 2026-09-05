"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const { toBoolean, toIdList } = require("../../utils/report-filter-types");
const {
  getUserEntityBlockedSet,
} = require("../administration/entity-ledger-access-service");
const {
  localizedLineDescriptionSql,
  localizedNarrativeSql,
  supportsVoucherRemarksUr,
} = require("../../utils/localized-name");
const { resolveTranslation } = require("../../middleware/core/locale");

// Employee/Labour ledger access restrictions (per-entity), mirroring the
// per-account restrictions on the Account Activity Ledger. Admins bypass; every
// other user's view is scoped to the entities they're allowed to see. kind
// ('employee' | 'labour') maps to the entity_type stored by the access service.
const resolveBlockedEntityIds = async ({ req, kind }) => {
  if (req?.user?.isAdmin) return new Set();
  const userId = Number(req?.user?.id || 0);
  if (!Number.isInteger(userId) || userId <= 0) return new Set();
  const entityType = kind === "employee" ? "EMPLOYEE" : "LABOUR";
  return getUserEntityBlockedSet({ userId, entityType });
};

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
// Which labour a ledger row belongs to. Every voucher type carries it on the line, but a
// DCV cannot: voucher_line allows exactly one entity reference and a DCV line already
// fills sku_id, so the labour lives beside it in erp.dcv_line (per line, since one DCV
// may complete several departments worked by different labours), with dcv_header as the
// fallback for single-department vouchers and anything saved before dcv_line existed.
const LABOUR_ENTITY_SQL =
  "CASE WHEN vh.voucher_type_code = 'DCV' THEN dcv.labour_id ELSE vl.labour_id END";
const LABOUR_ENTITY_WITH_DCV_LINE_SQL =
  "CASE WHEN vh.voucher_type_code = 'DCV' THEN COALESCE(dcvl.labour_id, dcv.labour_id) ELSE vl.labour_id END";

// Guarded because the code may reach a database that has not run the dcv_line migration
// yet; joining a missing table would break the whole labour ledger, not just this column.
let dcvLineTableSupport;
const hasDcvLineTable = async () => {
  if (typeof dcvLineTableSupport === "boolean") return dcvLineTableSupport;
  dcvLineTableSupport = await knex.schema
    .withSchema("erp")
    .hasTable("dcv_line");
  return dcvLineTableSupport;
};
const resolveLabourEntitySql = async () =>
  (await hasDcvLineTable())
    ? LABOUR_ENTITY_WITH_DCV_LINE_SQL
    : LABOUR_ENTITY_SQL;
const resolveEntityVoucherScopeContext = async (cfg) => {
  if (cfg.lineKind !== "LABOUR") {
    return {
      supportsDcvLine: false,
      labourEntitySql: null,
    };
  }

  const supportsDcvLine = await hasDcvLineTable();
  return {
    supportsDcvLine,
    labourEntitySql: supportsDcvLine
      ? LABOUR_ENTITY_WITH_DCV_LINE_SQL
      : LABOUR_ENTITY_SQL,
  };
};
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

const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object") return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Error in HrPayrollReportService:", err);
    return [];
  }
};

const parseJsonObject = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    console.error("Error in HrPayrollReportService:", err);
    return {};
  }
};

const normalizeCommissionEntries = (linesDetail) =>
  parseJsonArray(linesDetail).flatMap((line) => {
    const entries = Array.isArray(line?.entries) ? line.entries : [];
    return entries
      .map((entry) => ({
        ruleId: toPositiveId(entry?.rule_id),
        basis: String(entry?.basis || ""),
        rate: Number(entry?.rate || 0),
        amount: toAmount(entry?.computed_amount, 2),
      }))
      .filter((entry) => Math.abs(entry.amount) >= 0.005);
  });

const commissionTypeLabelKey = (type) =>
  `commission_type_${String(type || "").toLowerCase()}`;

const normalizeCommissionRuleRows = async ({ ruleIds, locale }) => {
  const ids = [...new Set(ruleIds.map(toPositiveId).filter(Boolean))];
  if (!ids.length) return new Map();
  const localizedName = (alias) =>
    locale === "ur"
      ? `COALESCE(NULLIF(${alias}.name_ur, ''), ${alias}.name)`
      : `${alias}.name`;

  const rows = await knex("erp.employee_commission_rules as ecr")
    .leftJoin("erp.skus as s", "s.id", "ecr.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "ecr.subgroup_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "ecr.group_id")
    .leftJoin("erp.branches as b", "b.id", "ecr.branch_id")
    .whereIn("ecr.id", ids)
    .select(
      "ecr.id",
      "ecr.apply_on",
      "ecr.sku_id",
      "ecr.subgroup_id",
      "ecr.group_id",
      "ecr.commission_basis",
      "ecr.rate_type",
      "ecr.value",
      "s.sku_code",
      knex.raw(`${localizedName("i")} as item_name`),
      knex.raw(`${localizedName("sg")} as subgroup_name`),
      knex.raw(`${localizedName("pg")} as group_name`),
      knex.raw(`${localizedName("b")} as branch_name`),
    );

  return new Map(rows.map((row) => [Number(row.id), row]));
};

const PAIRS_PER_DOZEN = 12;

const normalizePairsFromCommissionLine = (line = {}) => {
  const meta = parseJsonObject(line.meta);
  const candidates = [
    meta.total_pairs,
    meta.transfer_qty_pairs,
    line.total_pairs,
    line.qty,
  ];
  const pairs = candidates
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  return pairs || 0;
};

const loadCommissionSkuContextMap = async ({ skuIds, locale }) => {
  const ids = [...new Set(skuIds.map(toPositiveId).filter(Boolean))];
  if (!ids.length) return new Map();
  const localizedName = (alias) =>
    locale === "ur"
      ? `COALESCE(NULLIF(${alias}.name_ur, ''), ${alias}.name)`
      : `${alias}.name`;

  const rows = await knex("erp.skus as s")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .whereIn("s.id", ids)
    .select(
      "s.id as sku_id",
      "s.sku_code",
      "i.group_id",
      "i.subgroup_id",
      knex.raw(`${localizedName("i")} as item_name`),
      knex.raw(`${localizedName("sg")} as subgroup_name`),
      knex.raw(`${localizedName("pg")} as group_name`),
    );

  return new Map(rows.map((row) => [Number(row.sku_id), row]));
};

const makeCommissionSummaryRow = ({
  level,
  rowType,
  labelKey,
  labelText,
  sortKey,
  parentKey = null,
  hierarchyKey = null,
}) => ({
  level,
  rowType,
  labelKey,
  labelText,
  totalDozen: 0,
  showDozen: true,
  debit: 0,
  credit: 0,
  sortKey,
  parentKey,
  hierarchyKey,
  _quantityKeys: new Set(),
});

const addAmountToCommissionSummaryRow = (row, amount) => {
  const normalized = toAmount(amount, 2);
  if (Math.abs(normalized) < 0.005) return;
  if (normalized >= 0) {
    row.credit = toAmount(Number(row.credit || 0) + normalized, 2);
  } else {
    row.debit = toAmount(Number(row.debit || 0) + Math.abs(normalized), 2);
  }
};

const addDozenToCommissionSummaryRow = (row, fact) => {
  if (!fact.quantityKey || fact.totalPairs <= 0) return;
  if (row._quantityKeys.has(fact.quantityKey)) return;
  row._quantityKeys.add(fact.quantityKey);
  row.totalDozen = toQty(
    Number(row.totalDozen || 0) + Number(fact.totalPairs || 0) / PAIRS_PER_DOZEN,
    3,
  );
};

const formatRateSuffix = ({ rateType, rate, locale }) => {
  const normalizedRateType = String(rateType || "").trim().toLowerCase();
  const rateLabel = normalizedRateType
    ? resolveTranslation(locale, `rate_type_${normalizedRateType}`)
    : "";
  const normalizedRate = Number(rate);
  if (!rateLabel || !Number.isFinite(normalizedRate)) return "";
  return `${rateLabel} - ${toAmount(normalizedRate, 2).toFixed(2)}`;
};

const resolveCommissionScope = ({ fact, rule, sku, locale }) => {
  const t = (key) => resolveTranslation(locale, key);
  const applyOn = String(rule?.apply_on || "").trim().toUpperCase();
  const rateSuffix = formatRateSuffix({
    rateType: rule?.rate_type,
    rate: fact.rate,
    locale,
  });

  if (applyOn === "GROUP") {
    const id = Number(rule?.group_id || sku?.group_id || 0) || "unknown";
    const label = `${t("apply_on_group")}: ${rule?.group_name || sku?.group_name || "-"}`;
    return {
      key: `GROUP:${id}:${rule?.rate_type || ""}:${fact.rate}`,
      labelText: [label, rateSuffix].filter(Boolean).join(" - "),
    };
  }

  if (applyOn === "SUBGROUP") {
    const id = Number(rule?.subgroup_id || sku?.subgroup_id || 0) || "unknown";
    const label = `${t("apply_on_subgroup")}: ${rule?.subgroup_name || sku?.subgroup_name || "-"}`;
    return {
      key: `SUBGROUP:${id}:${rule?.rate_type || ""}:${fact.rate}`,
      labelText: [label, rateSuffix].filter(Boolean).join(" - "),
    };
  }

  if (applyOn === "SKU") {
    const id = Number(sku?.subgroup_id || rule?.subgroup_id || 0) || "unknown";
    const label = `${t("apply_on_subgroup")}: ${sku?.subgroup_name || "-"}`;
    return {
      key: `SKU_SUBGROUP:${id}:${rule?.rate_type || ""}:${fact.rate}`,
      labelText: [
        label,
        t("apply_on_sku"),
        rateSuffix,
      ].filter(Boolean).join(" - "),
    };
  }

  const groupId = Number(sku?.group_id || 0) || "unknown";
  return {
    key: `GROUP:${groupId}:ALL:${fact.rate || ""}`,
    labelText: `${t("apply_on_group")}: ${sku?.group_name || t("commission_unclassified")}`,
  };
};

const buildArticleCommissionLabel = ({ sku, locale }) => {
  const t = (key) => resolveTranslation(locale, key);
  if (!sku) return t("commission_unclassified");
  const label = [sku.sku_code, sku.item_name].filter(Boolean).join(" - ");
  return `${t("sku")}: ${label || "-"}`;
};

const pushCommissionFact = (facts, fact) => {
  const amount = toAmount(fact.amount, 2);
  if (Math.abs(amount) < 0.005) return;
  facts.push({
    ...fact,
    amount,
    skuId: toPositiveId(fact.skuId),
    ruleId: toPositiveId(fact.ruleId),
    totalPairs: Number(fact.totalPairs || 0),
  });
};

const buildCommissionHierarchyRows = async ({
  facts,
  fallbackRows,
  locale,
}) => {
  const skuContextMap = await loadCommissionSkuContextMap({
    skuIds: facts.map((fact) => fact.skuId),
    locale,
  });
  const ruleContextMap = await normalizeCommissionRuleRows({
    ruleIds: facts.map((fact) => fact.ruleId),
    locale,
  });

  const typeRows = new Map();
  const scopeRows = new Map();
  const articleRows = new Map();
  const ensureTypeRow = (type) => {
    const key = String(type || "");
    if (!typeRows.has(key)) {
      typeRows.set(
        key,
        makeCommissionSummaryRow({
          level: 1,
          rowType: "commission_type",
          labelKey: commissionTypeLabelKey(type),
          labelText: resolveTranslation(locale, commissionTypeLabelKey(type)),
          sortKey: `1:${key}`,
          hierarchyKey: key,
        }),
      );
    }
    return typeRows.get(key);
  };

  facts.forEach((fact) => {
    const type = String(fact.type || "");
    const rule = fact.ruleId ? ruleContextMap.get(Number(fact.ruleId)) : null;
    const sku = fact.skuId ? skuContextMap.get(Number(fact.skuId)) : null;
    const typeRow = ensureTypeRow(type);
    addAmountToCommissionSummaryRow(typeRow, fact.amount);
    addDozenToCommissionSummaryRow(typeRow, fact);

    const scope = resolveCommissionScope({ fact, rule, sku, locale });
    const scopeKey = `${type}|${scope.key}`;
    if (!scopeRows.has(scopeKey)) {
      scopeRows.set(
        scopeKey,
        makeCommissionSummaryRow({
          level: 2,
          rowType: "commission_scope",
          labelKey: "",
          labelText: scope.labelText,
          sortKey: `2:${type}:${scope.labelText}`,
          parentKey: type,
          hierarchyKey: scopeKey,
        }),
      );
    }
    const scopeRow = scopeRows.get(scopeKey);
    addAmountToCommissionSummaryRow(scopeRow, fact.amount);
    addDozenToCommissionSummaryRow(scopeRow, fact);

    const articleKey = `${scopeKey}|SKU:${fact.skuId || "unknown"}`;
    if (!articleRows.has(articleKey)) {
      articleRows.set(
        articleKey,
        makeCommissionSummaryRow({
          level: 3,
          rowType: "commission_article",
          labelKey: "",
          labelText: buildArticleCommissionLabel({ sku, locale }),
          sortKey: `3:${type}:${scope.labelText}:${sku?.sku_code || ""}`,
          parentKey: scopeKey,
          hierarchyKey: articleKey,
        }),
      );
    }
    const articleRow = articleRows.get(articleKey);
    addAmountToCommissionSummaryRow(articleRow, fact.amount);
    addDozenToCommissionSummaryRow(articleRow, fact);
  });

  fallbackRows.forEach((fallback) => {
    const type = String(fallback.type || "");
    const typeRow = ensureTypeRow(type);
    typeRow.debit = toAmount(typeRow.debit + Number(fallback.debit || 0), 2);
    typeRow.credit = toAmount(typeRow.credit + Number(fallback.credit || 0), 2);

    const key = `${type}|fallback`;
    if (!scopeRows.has(key)) {
      scopeRows.set(
        key,
        makeCommissionSummaryRow({
          level: 2,
          rowType: "commission_unclassified",
          labelKey: "commission_unclassified",
          labelText: resolveTranslation(locale, "commission_unclassified"),
          sortKey: `2:${type}:zz_unclassified`,
          parentKey: type,
          hierarchyKey: key,
        }),
      );
    }
    const row = scopeRows.get(key);
    row.debit = toAmount(row.debit + Number(fallback.debit || 0), 2);
    row.credit = toAmount(row.credit + Number(fallback.credit || 0), 2);
  });

  const result = [];
  [...typeRows.keys()].sort().forEach((type) => {
    const typeRow = typeRows.get(type);
    result.push(typeRow);
    [...scopeRows.entries()]
      .filter(([, row]) => row.parentKey === type)
      .sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)))
      .forEach(([, scopeRow]) => {
        result.push(scopeRow);
        [...articleRows.entries()]
          .filter(([, row]) => row.parentKey === scopeRow.hierarchyKey)
          .sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)))
          .forEach(([, row]) => result.push(row));
      });
  });

  const parentKeys = new Set(
    [...scopeRows.values(), ...articleRows.values()]
      .map((row) => row.parentKey)
      .filter(Boolean),
  );

  return result.map((row) => {
    const { _quantityKeys, sortKey, hierarchyKey, ...publicRow } = row;
    return {
      ...publicRow,
      rowKey: hierarchyKey,
      hasChildren: parentKeys.has(hierarchyKey),
    };
  });
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

// Salary stops accruing the day employment ends. Every accrual helper clamps its
// upper bound through this, so a leaver's past figures stay untouched while no
// new period is generated after their last day.
const capAtEmploymentEnd = (ymd, employmentEndYmd) => {
  if (!employmentEndYmd) return ymd;
  if (!ymd) return ymd;
  return ymd > employmentEndYmd ? employmentEndYmd : ymd;
};

const countDailyAccrualDaysUpTo = ({
  employmentStartYmd,
  asOnYmd,
  employmentEndYmd = null,
}) => {
  const startDate = toUtcDateFromYmd(employmentStartYmd);
  const asOnDate = toUtcDateFromYmd(capAtEmploymentEnd(asOnYmd, employmentEndYmd));
  if (!startDate || !asOnDate) return 0;
  if (asOnDate < startDate) return 0;
  return countDaysExcludingSundays({
    fromYmd: toYmd(startDate),
    toYmdValue: toYmd(asOnDate),
  });
};

const countMonthlyAccrualsUpTo = ({
  employmentStartYmd,
  asOnYmd,
  employmentEndYmd = null,
}) => {
  const cappedAsOn = capAtEmploymentEnd(asOnYmd, employmentEndYmd);
  const firstAccrualYmd = getFirstAccrualDateYmd(employmentStartYmd);
  if (!firstAccrualYmd || cappedAsOn < firstAccrualYmd) return 0;
  const firstAccrualMonthStart = monthStartUtc(
    toUtcDateFromYmd(firstAccrualYmd),
  );
  const lastAccrualMonthStart = getLastAccrualMonthStartUtc(cappedAsOn);
  if (!firstAccrualMonthStart || !lastAccrualMonthStart) return 0;
  if (lastAccrualMonthStart < firstAccrualMonthStart) return 0;
  return monthDiff(firstAccrualMonthStart, lastAccrualMonthStart) + 1;
};

const buildMonthlyAccrualRowsInRange = ({
  employmentStartYmd,
  fromYmd,
  toYmdValue,
  monthlyAmount,
  employmentEndYmd = null,
  idSeed = 0,
}) => {
  const rows = [];
  const cappedTo = capAtEmploymentEnd(toYmdValue, employmentEndYmd);
  const firstAccrualYmd = getFirstAccrualDateYmd(employmentStartYmd);
  if (!firstAccrualYmd) return rows;
  const firstAccrualMonthStart = monthStartUtc(
    toUtcDateFromYmd(firstAccrualYmd),
  );
  const lastAccrualMonthStart = getLastAccrualMonthStartUtc(cappedTo);
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
  employmentEndYmd = null,
  idSeed = 0,
}) => {
  const rows = [];
  const startDate = toUtcDateFromYmd(employmentStartYmd);
  const fromDate = toUtcDateFromYmd(fromYmd);
  const toDate = toUtcDateFromYmd(capAtEmploymentEnd(toYmdValue, employmentEndYmd));
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
  // Deliberately NOT filtered on status='active'. That filter was applied at
  // load time, so flipping a leaver to inactive erased their entire historical
  // accrual retroactively — their past balances changed. The employment window
  // is what ends accrual now; status only governs whether they can be picked in
  // new transactions.
  const employeeRows = await knex("erp.employees as e")
    .select(
      "e.id",
      "e.basic_salary",
      "e.created_at",
      "e.payroll_type",
      "e.employment_start_date",
      "e.employment_end_date",
    )
    .whereIn("e.id", normalizedIds)
    .whereIn("e.payroll_type", ["MONTHLY", "DAILY"])
    .whereRaw(
      "(lower(trim(coalesce(e.status, ''))) = 'active' OR e.employment_end_date IS NOT NULL)",
    );

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
      // Falls back to created_at so rows predating the employment-window
      // migration keep accruing exactly as they did before.
      employmentStartYmd:
        toLocalDateOnly(row.employment_start_date || row.created_at || new Date()) ||
        toLocalDateOnly(new Date()),
      employmentEndYmd: row.employment_end_date
        ? toLocalDateOnly(row.employment_end_date)
        : null,
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
  scopeContext = null,
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

  const supportsDcvLine = Boolean(scopeContext?.supportsDcvLine);
  const labourEntitySql = scopeContext?.labourEntitySql;
  if (!labourEntitySql) {
    throw new Error("Labour voucher scope context is required");
  }

  return query
    .leftJoin("erp.dcv_header as dcv", "dcv.voucher_id", "vh.id")
    .modify((qb) => {
      if (supportsDcvLine)
        qb.leftJoin("erp.dcv_line as dcvl", "dcvl.voucher_line_id", "vl.id");
    })
    .modify((qb) => {
      if (includeEntitySelect)
        qb.select(knex.raw(`${labourEntitySql} as entity_id`));
    })
    .where(function whereLabourRows() {
      this.where(function whereDirectLabourLine() {
        this.where("vl.line_kind", "LABOUR").whereNotNull("vl.labour_id");
      }).orWhere(function whereDcvSkuLine() {
        this.where("vh.voucher_type_code", "DCV")
          .andWhere("vl.line_kind", "SKU")
          .modify((inner) => {
            // A multi-department DCV credits each line's own labour; only fall back to
            // the header labour for lines that have no dcv_line row of their own.
            if (supportsDcvLine) {
              inner.where(function whereAnyLabour() {
                this.whereNotNull("dcvl.labour_id").orWhereNotNull(
                  "dcv.labour_id",
                );
              });
              return;
            }
            inner.whereNotNull("dcv.labour_id");
          });
      });
    })
    .modify((qb) => {
      if (entityId != null)
        qb.andWhereRaw(`${labourEntitySql} = ?`, [entityId]);
    });
};

const loadLedgerOptions = async ({ req, filters, kind, blockedEntityIds }) => {
  const locale = String(req?.locale || "en").toLowerCase();
  const branchNameSql =
    locale === "ur"
      ? "COALESCE(NULLIF(branches.name_ur, ''), branches.name)"
      : "branches.name";
  const cfg = getEntityConfig(kind);
  const blocked =
    blockedEntityIds instanceof Set
      ? blockedEntityIds
      : await resolveBlockedEntityIds({ req, kind });
  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const branches = req.user?.isAdmin
    ? await knex("erp.branches")
        .select("id", knex.raw(`${branchNameSql} as name`))
        .where({ is_active: true })
        .orderByRaw(`${branchNameSql} asc`)
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

  const entities = (await query).filter(
    (row) => !blocked.has(Number(row.id)),
  );
  return { branches, entities };
};

const getLedgerRows = async ({
  req,
  filters,
  options,
  kind,
  blockedEntityIds,
}) => {
  const locale = String(req?.locale || "en").toLowerCase();
  const localizedName = (alias) =>
    locale === "ur"
      ? `COALESCE(NULLIF(${alias}.name_ur, ''), ${alias}.name)`
      : `${alias}.name`;
  const hasRemarksUr = await supportsVoucherRemarksUr();
  const lineDescription = localizedLineDescriptionSql(locale, "vl");
  const voucherRemarks = localizedNarrativeSql({ locale, hasRemarksUr });
  // These labels are built inside SQL, so they cannot go through the view's
  // t(); resolve them here and inline them as quoted literals instead. The
  // words come from the static dictionary, but escape anyway so a future
  // translation carrying an apostrophe cannot break the statement.
  const sqlLabel = (key) =>
    `'${String(resolveTranslation(locale, key)).replace(/'/g, "''")} '`;
  const skuLabel = sqlLabel("sku");
  const labourLabel = sqlLabel("labour");
  const employeeLabel = sqlLabel("employee");
  const creditSaleLabel = `'${String(resolveTranslation(locale, "credit_sale")).replace(/'/g, "''")} #'`;
  const cfg = getEntityConfig(kind);
  const voucherScopeContext = await resolveEntityVoucherScopeContext(cfg);
  const includeBranchColumn = Boolean(
    req.user?.isAdmin && filters.branchIds.length !== 1,
  );

  const blocked =
    blockedEntityIds instanceof Set
      ? blockedEntityIds
      : await resolveBlockedEntityIds({ req, kind });

  // A restricted user cannot pull a blocked entity's ledger even by posting its
  // id directly — treat it as if nothing was selected.
  if (filters.entityId && blocked.has(Number(filters.entityId))) {
    return {
      entity: null,
      openingBalance: 0,
      rows: [],
      totals: { qty: 0, debit: 0, credit: 0, closingBalance: 0 },
      includeBranchColumn,
    };
  }

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
    scopeContext: voucherScopeContext,
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
      knex.raw(`${localizedName("b")} as branch_name`),
      knex.raw(`COALESCE(
        ${lineDescription},
        ${voucherRemarks},
        CASE
          WHEN vl.line_kind = 'SKU' THEN NULLIF(
            CONCAT(
              ${skuLabel},
              COALESCE(s.sku_code, ''),
              CASE WHEN COALESCE(${localizedName("i")}, '') = '' THEN '' ELSE CONCAT(' - ', ${localizedName("i")}) END
            ),
            ${skuLabel}
          )
          WHEN vl.line_kind = 'LABOUR' THEN NULLIF(CONCAT(${labourLabel}, COALESCE(${localizedName("l")}, '')), ${labourLabel})
          WHEN vl.line_kind = 'EMPLOYEE' THEN NULLIF(CONCAT(${employeeLabel}, COALESCE(${localizedName("e")}, '')), ${employeeLabel})
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
    scopeContext: voucherScopeContext,
  });

  const rawRows = await detailsQuery;
  let salesCommissionBreakdownRows = [];
  if (kind === "employee") {
    const salesCommissionVoucherIds = [
      ...new Set(
        rawRows
          .filter((row) => row.is_sales_commission)
          .map((row) => Number(row.voucher_id || 0))
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (salesCommissionVoucherIds.length) {
      salesCommissionBreakdownRows = await knex("erp.voucher_line as sku_vl")
        .join("erp.voucher_header as vh", "vh.id", "sku_vl.voucher_header_id")
        .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
        .whereIn("vh.id", salesCommissionVoucherIds)
        .andWhere("vh.status", "APPROVED")
        .andWhere("sku_vl.line_kind", "SKU")
        .andWhere("sh.salesman_employee_id", filters.entityId)
        .select(
          "sku_vl.id",
          "vh.id as voucher_id",
          "sku_vl.sku_id",
          "sku_vl.line_no",
          "sku_vl.qty",
          "sku_vl.meta",
        );
    }
  }
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
        `COALESCE(${voucherRemarks}, CONCAT(${creditSaleLabel}, vh.voucher_no::text)) as description`,
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
        "cl.lines_detail",
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
        employmentEndYmd: accrualMeta.employmentEndYmd,
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
        employmentEndYmd: accrualMeta.employmentEndYmd,
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
        employmentEndYmd: accrualMeta.employmentEndYmd,
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
        employmentEndYmd: accrualMeta.employmentEndYmd,
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
    const commissionFacts = [];
    const commissionFallbackRows = [];
    const addCommissionFallback = ({ type, debit = 0, credit = 0 }) => {
      const normalizedDebit = toAmount(debit, 2);
      const normalizedCredit = toAmount(credit, 2);
      if (
        Math.abs(normalizedDebit) < 0.005 &&
        Math.abs(normalizedCredit) < 0.005
      ) {
        return;
      }
      commissionFallbackRows.push({
        type,
        debit: normalizedDebit,
        credit: normalizedCredit,
      });
    };

    let commissionLineMap = new Map();
    const commissionVoucherIds = [
      ...new Set(
        commissionDetailRows
          .map((row) => Number(row.voucher_id || 0))
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (commissionVoucherIds.length) {
      const commissionLineRows = await knex("erp.voucher_line as vl")
        .whereIn("vl.voucher_header_id", commissionVoucherIds)
        .andWhere("vl.line_kind", "SKU")
        .select(
          "vl.voucher_header_id",
          "vl.line_no",
          "vl.sku_id",
          "vl.qty",
          "vl.meta",
        );
      const mappedLines = new Map();
      commissionLineRows.forEach((line) => {
        const voucherId = Number(line.voucher_header_id || 0);
        const lineNo = Number(line.line_no || 0);
        const skuId = Number(line.sku_id || 0);
        if (!voucherId || !lineNo) return;
        mappedLines.set(`${voucherId}|${lineNo}`, line);
        if (skuId) mappedLines.set(`${voucherId}|${lineNo}|${skuId}`, line);
      });
      commissionLineMap = mappedLines;
    }

    const resolveCommissionLedgerLine = ({ voucherId, line }) => {
      const lineNo = Number(line?.line_no || 0);
      const skuId = Number(line?.sku_id || 0);
      if (!voucherId || !lineNo) return null;
      return (
        commissionLineMap.get(`${voucherId}|${lineNo}|${skuId}`) ||
        commissionLineMap.get(`${voucherId}|${lineNo}`) ||
        null
      );
    };

    commissionDetailRows.forEach((row) => {
      const type = String(row.commission_type || "");
      const voucherId = Number(row.voucher_id || 0);
      const linesDetail = parseJsonArray(row.lines_detail);
      let expandedTotal = 0;

      linesDetail.forEach((line) => {
        const entries = normalizeCommissionEntries([line]);
        const voucherLine = resolveCommissionLedgerLine({ voucherId, line });
        const sourceLine = voucherLine || line;
        const skuId = Number(line?.sku_id || sourceLine?.sku_id || 0);
        const totalPairs = normalizePairsFromCommissionLine(sourceLine);
        const quantityKey = `ledger:${voucherId || "no-voucher"}:${Number(
          line?.line_no || sourceLine?.line_no || 0,
        )}:${skuId || "unknown"}`;

        if (!entries.length && Math.abs(Number(line?.total_amount || 0)) >= 0.005) {
          const amount = toAmount(line.total_amount, 2);
          expandedTotal = toAmount(expandedTotal + amount, 2);
          pushCommissionFact(commissionFacts, {
            type,
            ruleId: null,
            basis: "",
            rate: null,
            amount,
            skuId,
            totalPairs,
            quantityKey,
          });
          return;
        }

        entries.forEach((entry) => {
          expandedTotal = toAmount(expandedTotal + entry.amount, 2);
          pushCommissionFact(commissionFacts, {
            type,
            ruleId: entry.ruleId,
            basis: entry.basis,
            rate: entry.rate,
            amount: entry.amount,
            skuId,
            totalPairs,
            quantityKey,
          });
        });
      });

      const ledgerTotal = toAmount(row.total_amount, 2);
      const unexpandedTotal = toAmount(ledgerTotal - expandedTotal, 2);
      if (Math.abs(unexpandedTotal) >= 0.005) {
        addCommissionFallback({
          type,
          debit: unexpandedTotal < 0 ? Math.abs(unexpandedTotal) : 0,
          credit: unexpandedTotal > 0 ? unexpandedTotal : 0,
        });
      }
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

    let expandedSalesCommission = 0;
    salesCommissionBreakdownRows.forEach((row) => {
      const meta = parseJsonObject(row.meta);
      const commission = parseJsonObject(meta.commission);
      const entries = normalizeCommissionEntries([
        {
          entries: Array.isArray(commission.entries)
            ? commission.entries
            : [],
        },
      ]);
      entries.forEach((entry) => {
        expandedSalesCommission = toAmount(
          expandedSalesCommission + entry.amount,
          2,
        );
        pushCommissionFact(commissionFacts, {
          type: "SALESMAN_SALE",
          ruleId: entry.ruleId,
          basis: entry.basis,
          rate: entry.rate,
          amount: entry.amount,
          skuId: row.sku_id,
          totalPairs: normalizePairsFromCommissionLine(row),
          quantityKey: `sales:${
            Number(row.id || 0) || `${row.voucher_id || ""}:${row.line_no || ""}`
          }`,
        });
      });
    });

    if (
      Math.abs(salesCommissionCredit) >= 0.005 ||
      Math.abs(salesCommissionDebit) >= 0.005
    ) {
      const ledgerSalesCommission = toAmount(
        salesCommissionCredit - salesCommissionDebit,
        2,
      );
      const unexpandedSalesCommission = toAmount(
        ledgerSalesCommission - expandedSalesCommission,
        2,
      );
      if (Math.abs(unexpandedSalesCommission) >= 0.005) {
        addCommissionFallback({
          type: "SALESMAN_SALE",
          debit:
            unexpandedSalesCommission < 0
              ? Math.abs(unexpandedSalesCommission)
              : 0,
          credit:
            unexpandedSalesCommission > 0 ? unexpandedSalesCommission : 0,
        });
      }
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

    const breakdown = await buildCommissionHierarchyRows({
      facts: commissionFacts,
      fallbackRows: commissionFallbackRows,
      locale,
    });
    if (Math.abs(paymentsCredit) >= 0.005 || Math.abs(paymentsDebit) >= 0.005) {
      breakdown.push({
        labelKey: "employee_balance_payments_label",
        showDozen: false,
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
        showDozen: false,
        debit: staffCreditPurchaseDebit,
        credit: staffCreditPurchaseCredit,
      });
    }
    if (salaryAmount >= 0.005) {
      breakdown.push({
        labelKey: "basic_salary",
        showDozen: false,
        debit: 0,
        credit: salaryAmount,
      });
    }
    if (allowanceAmount >= 0.005) {
      breakdown.push({
        labelKey: "allowances",
        showDozen: false,
        debit: 0,
        credit: allowanceAmount,
      });
    }

    const isBreakdownTotalRow = (entry) =>
      !entry.rowType || entry.rowType === "commission_type";
    const totalDebitBreakdown = toAmount(
      breakdown.reduce(
        (sum, entry) =>
          isBreakdownTotalRow(entry) ? sum + Number(entry.debit || 0) : sum,
        0,
      ),
      2,
    );
    const totalCreditBreakdown = toAmount(
      breakdown.reduce(
        (sum, entry) =>
          isBreakdownTotalRow(entry) ? sum + Number(entry.credit || 0) : sum,
        0,
      ),
      2,
    );
    const totalDozenBreakdown = toQty(
      breakdown.reduce(
        (sum, entry) =>
          entry.rowType === "commission_type"
            ? sum + Number(entry.totalDozen || 0)
            : sum,
        0,
      ),
      3,
    );

    categoryBreakdown = {
      openingBalance,
      breakdown,
      totalDozen: totalDozenBreakdown,
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
  const locale = String(req?.locale || "en").toLowerCase();
  const branchNameSql =
    locale === "ur"
      ? "COALESCE(NULLIF(branches.name_ur, ''), branches.name)"
      : "branches.name";
  const branches = req.user?.isAdmin
    ? await knex("erp.branches")
        .select("id", knex.raw(`${branchNameSql} as name`))
        .where({ is_active: true })
        .orderByRaw(`${branchNameSql} asc`)
    : (req.branchOptions || []).map((row) => ({
        id: Number(row.id),
        name: row.name,
      }));

  return { branches };
};

const getBalanceRows = async ({ req, filters, kind }) => {
  const cfg = getEntityConfig(kind);
  if (!filters.reportLoaded) return [];
  const voucherScopeContext = await resolveEntityVoucherScopeContext(cfg);

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
    scopeContext: voucherScopeContext,
  });
  if (cfg.lineKind === "LABOUR") {
    balanceSubquery = balanceSubquery.groupByRaw(
      voucherScopeContext.labourEntitySql,
    );
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

  // Drop entities this user isn't allowed to see, so the balances list stays
  // consistent with the (restricted) ledger it links to. Admins bypass.
  const blocked = await resolveBlockedEntityIds({ req, kind });
  const rows = (await query).filter((row) => !blocked.has(Number(row.id)));

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
          employmentEndYmd: meta.employmentEndYmd,
          asOnYmd: filters.asOn,
        });
        perCycleAmount = Number(meta.monthlyAmount || 0);
        perCycleSalary = Number(meta.monthlySalaryOnly || 0);
        perCycleAllowance = Number(meta.monthlyAllowanceOnly || 0);
      } else if (meta.payrollType === "DAILY") {
        count = countDailyAccrualDaysUpTo({
          employmentStartYmd: meta.employmentStartYmd,
          employmentEndYmd: meta.employmentEndYmd,
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
  const blockedEntityIds = await resolveBlockedEntityIds({ req, kind: "labour" });
  const options = await loadLedgerOptions({
    req,
    filters,
    kind: "labour",
    blockedEntityIds,
  });
  const reportData = await getLedgerRows({
    req,
    filters,
    options,
    kind: "labour",
    blockedEntityIds,
  });
  return { filters, options, reportData };
};

const getEmployeeLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseEntityLedgerFilters({ req, input });
  const blockedEntityIds = await resolveBlockedEntityIds({
    req,
    kind: "employee",
  });
  const options = await loadLedgerOptions({
    req,
    filters,
    kind: "employee",
    blockedEntityIds,
  });
  const reportData = await getLedgerRows({
    req,
    filters,
    options,
    kind: "employee",
    blockedEntityIds,
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
