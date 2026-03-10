"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const { toIdList, toBoolean } = require("../../utils/report-filter-types");

const STATUS_OPTIONS = Object.freeze([
  "PENDING",
  "PARTIALLY_RETURNED",
  "CLOSED",
  "OVERDUE",
]);

const toPositiveInt = (value) => {
  const num = Number(value || 0);
  return Number.isInteger(num) && num > 0 ? num : null;
};

const parseYmdStrict = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d))
    return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  )
    return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
};

const parseDateFilter = (value, fallback) => {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) {
    return { value: fallback, valid: true, provided: false };
  }
  const parsed = parseYmdStrict(raw);
  if (!parsed) {
    return { value: fallback, valid: false, provided: true };
  }
  return { value: parsed, valid: true, provided: true };
};

const toList = (value) => {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => String(entry == null ? "" : entry).split(","))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
};

const toIdListWithAll = (value) => {
  const tokens = toList(value);
  const hasAll = tokens.some(
    (token) => token.toLowerCase() === "all" || token === "__ALL__",
  );
  if (hasAll) return [];
  return toIdList(tokens);
};

const toStatusList = (value) => {
  const tokens = toList(value).map((token) => token.toUpperCase());
  const hasAll = tokens.some((token) => token === "ALL" || token === "__ALL__");
  if (hasAll || !tokens.length) return [];
  return [...new Set(tokens.filter((token) => STATUS_OPTIONS.includes(token)))];
};

const toReasonCodeList = (value) => {
  const tokens = toList(value).map((token) => token.toUpperCase());
  const hasAll = tokens.some((token) => token === "ALL" || token === "__ALL__");
  if (hasAll || !tokens.length) return [];
  return [...new Set(tokens)];
};

const normalizeDate = (value) => {
  const normalized = toLocalDateOnly(value);
  return normalized || null;
};

const daysBetween = (fromDate, toDate) => {
  const start = parseYmdStrict(fromDate);
  const end = parseYmdStrict(toDate);
  if (!start || !end) return 0;
  const fromDt = new Date(`${start}T00:00:00Z`);
  const toDt = new Date(`${end}T00:00:00Z`);
  const diffMs = toDt.getTime() - fromDt.getTime();
  return Math.floor(diffMs / 86400000);
};

const resolveBranchScope = (req, branchIds) => {
  if (req.user?.isAdmin) return branchIds;
  const branchId = Number(req.branchId || 0);
  return Number.isInteger(branchId) && branchId > 0 ? [branchId] : [];
};

const parseCommonFilters = ({ req, input = {} }) => {
  const now = new Date();
  const defaultTo = toLocalDateOnly(now);
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 30);
  const defaultFrom = toLocalDateOnly(fromDate);

  const parsedFrom = parseDateFilter(input.from_date, defaultFrom);
  const parsedTo = parseDateFilter(input.to_date, defaultTo);

  let from = parsedFrom.value;
  let to = parsedTo.value;
  let invalidDateRange = false;
  if (from > to) {
    from = defaultFrom;
    to = defaultTo;
    invalidDateRange = true;
  }

  const selectedBranchIds = toIdListWithAll(input.branch_ids);

  return {
    from,
    to,
    vendorIds: toIdListWithAll(input.vendor_ids),
    assetIds: toIdListWithAll(input.asset_ids),
    reasonCodes: toReasonCodeList(input.reason_codes),
    statusList: toStatusList(input.status_list),
    overdueOnly: toBoolean(input.overdue_only, false),
    includeClosed: toBoolean(input.include_closed, true),
    overdueVendorsOnly: toBoolean(input.overdue_vendors_only, false),
    branchIds: resolveBranchScope(req, selectedBranchIds),
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

const loadOptions = async ({ req, branchIds }) => {
  const branchesPromise = req.user?.isAdmin
    ? knex("erp.branches")
        .select("id", "name")
        .where({ is_active: true })
        .orderBy("name", "asc")
    : Promise.resolve(
        (req.branchOptions || []).map((row) => ({
          id: Number(row.id),
          name: row.name,
        })),
      );

  let vendorQuery = knex("erp.parties as p")
    .select("p.id", "p.name")
    .where("p.is_active", true)
    .whereRaw("upper(coalesce(p.party_type::text, '')) = 'SUPPLIER'")
    .orderBy("p.name", "asc");

  if (!req.user?.isAdmin || branchIds.length) {
    const scopedBranchIds = branchIds.length
      ? branchIds
      : [Number(req.branchId || 0)].filter(Boolean);
    vendorQuery = vendorQuery.where(function scopedPartyBranch() {
      this.whereIn("p.branch_id", scopedBranchIds).orWhereExists(
        function branchMap() {
          this.select(1)
            .from("erp.party_branch as pb")
            .whereRaw("pb.party_id = p.id")
            .whereIn("pb.branch_id", scopedBranchIds);
        },
      );
    });
  }

  let assetQuery = knex("erp.assets")
    .select(
      "id",
      "asset_code",
      knex.raw("COALESCE(name, description) as asset_name"),
    )
    .where("is_active", true)
    .orderBy("asset_code", "asc");

  if (!req.user?.isAdmin || branchIds.length) {
    const scopedBranchIds = branchIds.length
      ? branchIds
      : [Number(req.branchId || 0)].filter(Boolean);
    assetQuery = assetQuery.where(function scopedAssetBranch() {
      this.whereNull("home_branch_id").orWhereIn(
        "home_branch_id",
        scopedBranchIds,
      );
    });
  }

  const reasonsQuery = knex("erp.rgp_reason_registry")
    .select("code", "name")
    .where({ is_active: true })
    .orderBy("name", "asc");

  const [branches, vendors, assets, reasons] = await Promise.all([
    branchesPromise,
    vendorQuery,
    assetQuery,
    reasonsQuery,
  ]);

  return {
    branches,
    vendors,
    assets,
    reasons,
    statuses: STATUS_OPTIONS,
  };
};

const getLineConditionVarianceMap = async ({ filters }) => {
  let query = knex("erp.rgp_inward_line as ril")
    .join("erp.rgp_inward as ri", "ri.voucher_id", "ril.rgp_in_voucher_id")
    .join("erp.voucher_header as rvh", "rvh.id", "ri.voucher_id")
    .join(
      "erp.rgp_outward_line as rol",
      "rol.voucher_line_id",
      "ril.rgp_out_voucher_line_id",
    )
    .join("erp.voucher_line as ovl", "ovl.id", "rol.voucher_line_id")
    .join("erp.voucher_header as ovh", "ovh.id", "ovl.voucher_header_id")
    .join("erp.rgp_outward as ro", "ro.voucher_id", "ovh.id")
    .select("ril.rgp_out_voucher_line_id")
    .count({ count: "*" })
    .whereNot("rvh.status", "REJECTED")
    .where("ovh.voucher_date", ">=", filters.from)
    .where("ovh.voucher_date", "<=", filters.to)
    .whereRaw(
      "upper(coalesce(ril.condition_in_code::text, '')) <> upper(coalesce(rol.condition_out_code::text, ''))",
    )
    .groupBy("ril.rgp_out_voucher_line_id");

  if (filters.branchIds.length) {
    query = query.whereIn("ovh.branch_id", filters.branchIds);
  }
  if (filters.vendorIds.length) {
    query = query.whereIn("ro.vendor_party_id", filters.vendorIds);
  }

  const rows = await query;
  return new Map(
    rows.map((row) => [
      Number(row.rgp_out_voucher_line_id),
      Number(row.count || 0),
    ]),
  );
};

const loadControlRows = async ({ filters }) => {
  const returnAggSubQuery = knex("erp.rgp_inward_line as ril")
    .join("erp.rgp_inward as ri", "ri.voucher_id", "ril.rgp_in_voucher_id")
    .join("erp.voucher_header as rvh", "rvh.id", "ri.voucher_id")
    .select("ril.rgp_out_voucher_line_id")
    .sum({ returned_qty: "ril.returned_qty" })
    .max({ last_return_date: "rvh.voucher_date" })
    .max({ last_rrv_no: "rvh.voucher_no" })
    .whereNot("rvh.status", "REJECTED")
    .groupBy("ril.rgp_out_voucher_line_id")
    .as("ret");

  let query = knex("erp.rgp_outward_line as rol")
    .join("erp.voucher_line as ovl", "ovl.id", "rol.voucher_line_id")
    .join("erp.voucher_header as ovh", "ovh.id", "ovl.voucher_header_id")
    .join("erp.rgp_outward as ro", "ro.voucher_id", "ovh.id")
    .join("erp.parties as p", "p.id", "ro.vendor_party_id")
    .leftJoin("erp.assets as a", "a.id", "rol.asset_id")
    .leftJoin("erp.branches as b", "b.id", "ovh.branch_id")
    .leftJoin(returnAggSubQuery, "ret.rgp_out_voucher_line_id", "ovl.id")
    .select(
      "ovh.id as outward_voucher_id",
      "ovh.voucher_no as rdv_no",
      "ovh.voucher_date as rdv_date",
      "ovh.branch_id",
      "b.name as branch_name",
      "ovl.id as outward_line_id",
      "ovl.line_no",
      "ro.vendor_party_id",
      "p.name as vendor_name",
      "ro.reason_code",
      "ro.expected_return_date",
      "rol.asset_id",
      knex.raw("COALESCE(a.asset_code, '') as asset_code"),
      knex.raw(
        "COALESCE(a.name, a.description, rol.item_description, '') as asset_name",
      ),
      "rol.item_description",
      "rol.qty as sent_qty",
      "rol.condition_out_code",
      knex.raw("COALESCE(ret.returned_qty, 0) as returned_qty"),
      knex.raw("COALESCE(ret.last_return_date, null) as last_return_date"),
      knex.raw("COALESCE(ret.last_rrv_no, null) as last_rrv_no"),
    )
    .whereNot("ovh.status", "REJECTED")
    .where("ovh.voucher_type_code", "RDV")
    .where("ovh.voucher_date", ">=", filters.from)
    .where("ovh.voucher_date", "<=", filters.to)
    .orderBy("ovh.voucher_date", "desc")
    .orderBy("ovh.voucher_no", "desc")
    .orderBy("ovl.line_no", "asc");

  if (filters.branchIds.length) {
    query = query.whereIn("ovh.branch_id", filters.branchIds);
  }
  if (filters.vendorIds.length) {
    query = query.whereIn("ro.vendor_party_id", filters.vendorIds);
  }
  if (filters.assetIds.length) {
    query = query.whereIn("rol.asset_id", filters.assetIds);
  }
  if (filters.reasonCodes.length) {
    query = query.whereIn("ro.reason_code", filters.reasonCodes);
  }

  const today = toLocalDateOnly(new Date());
  const rows = await query;

  return rows.map((row) => {
    const sentQty = Number(row.sent_qty || 0);
    const returnedQty = Number(row.returned_qty || 0);
    const pendingQty = Number((sentQty - returnedQty).toFixed(3));
    const expectedReturnDate = normalizeDate(row.expected_return_date);
    const isOverdue = Boolean(
      pendingQty > 0 && expectedReturnDate && expectedReturnDate < today,
    );

    let status = "PENDING";
    if (pendingQty <= 0) status = "CLOSED";
    else if (returnedQty > 0) status = "PARTIALLY_RETURNED";
    if (isOverdue) status = "OVERDUE";

    return {
      outwardVoucherId: Number(row.outward_voucher_id),
      rdvNo: Number(row.rdv_no),
      rdvDate: normalizeDate(row.rdv_date),
      branchId: Number(row.branch_id || 0) || null,
      branchName: row.branch_name || "",
      outwardLineId: Number(row.outward_line_id),
      lineNo: Number(row.line_no || 0),
      vendorPartyId: Number(row.vendor_party_id || 0) || null,
      vendorName: row.vendor_name || "",
      reasonCode: String(row.reason_code || "").toUpperCase(),
      expectedReturnDate,
      assetId: Number(row.asset_id || 0) || null,
      assetCode: row.asset_code || "",
      assetName: row.asset_name || row.item_description || "",
      itemDescription: row.item_description || "",
      conditionOutCode: String(row.condition_out_code || "").toUpperCase(),
      sentQty: Number(sentQty.toFixed(3)),
      returnedQty: Number(returnedQty.toFixed(3)),
      pendingQty: Number(Math.max(pendingQty, 0).toFixed(3)),
      lastRrvNo: toPositiveInt(row.last_rrv_no),
      lastReturnDate: normalizeDate(row.last_return_date),
      daysOut: daysBetween(normalizeDate(row.rdv_date), today),
      overdueDays: isOverdue
        ? Math.max(daysBetween(expectedReturnDate, today), 0)
        : 0,
      status,
      isOverdue,
    };
  });
};

const applyControlFilters = (rows, filters) => {
  return rows.filter((row) => {
    if (filters.overdueOnly && !row.isOverdue) return false;
    if (filters.statusList.length && !filters.statusList.includes(row.status))
      return false;
    return true;
  });
};

const buildControlSummary = (rows) => {
  const totals = rows.reduce(
    (acc, row) => {
      acc.sentQty += Number(row.sentQty || 0);
      acc.returnedQty += Number(row.returnedQty || 0);
      acc.pendingQty += Number(row.pendingQty || 0);
      if (row.status === "CLOSED") acc.closedLines += 1;
      if (row.pendingQty > 0) {
        acc.pendingLines += 1;
        acc.pendingExposure += Number(row.pendingQty || 0);
      }
      if (row.isOverdue) {
        acc.overdueLines += 1;
        acc.overdueQty += Number(row.pendingQty || 0);
      }
      return acc;
    },
    {
      sentQty: 0,
      returnedQty: 0,
      pendingQty: 0,
      pendingLines: 0,
      closedLines: 0,
      overdueLines: 0,
      overdueQty: 0,
      pendingExposure: 0,
    },
  );

  const totalLines = rows.length;
  const closedPercent =
    totalLines > 0
      ? Number(((totals.closedLines / totalLines) * 100).toFixed(2))
      : 0;

  return {
    totals: {
      sentQty: Number(totals.sentQty.toFixed(3)),
      returnedQty: Number(totals.returnedQty.toFixed(3)),
      pendingQty: Number(totals.pendingQty.toFixed(3)),
    },
    kpis: {
      totalLines,
      pendingLines: totals.pendingLines,
      overdueLines: totals.overdueLines,
      overdueQty: Number(totals.overdueQty.toFixed(3)),
      pendingExposure: Number(totals.pendingExposure.toFixed(3)),
      closedPercent,
    },
  };
};

const buildVendorPerformance = ({ rows, conditionVarianceMap, filters }) => {
  const grouped = new Map();

  rows.forEach((row) => {
    if (!grouped.has(row.vendorPartyId)) {
      grouped.set(row.vendorPartyId, {
        vendorPartyId: row.vendorPartyId,
        vendorName: row.vendorName,
        totalDispatchQty: 0,
        totalReturnedQty: 0,
        pendingQty: 0,
        overdueQty: 0,
        dispatchLines: 0,
        closedLines: 0,
        shortageCases: 0,
        conditionVarianceCases: 0,
        onTimeCases: 0,
        returnDaysSum: 0,
        returnDaysCount: 0,
        lastDispatchDate: null,
        lastReturnDate: null,
      });
    }

    const vendor = grouped.get(row.vendorPartyId);
    vendor.totalDispatchQty += Number(row.sentQty || 0);
    vendor.totalReturnedQty += Number(row.returnedQty || 0);
    vendor.pendingQty += Number(row.pendingQty || 0);
    vendor.dispatchLines += 1;
    if (row.status === "CLOSED") vendor.closedLines += 1;
    if (row.pendingQty > 0) vendor.shortageCases += 1;
    if (row.isOverdue) vendor.overdueQty += Number(row.pendingQty || 0);
    if (Number(conditionVarianceMap.get(row.outwardLineId) || 0) > 0) {
      vendor.conditionVarianceCases += 1;
    }

    if (row.lastReturnDate) {
      const cycleDays = daysBetween(row.rdvDate, row.lastReturnDate);
      vendor.returnDaysSum += Math.max(cycleDays, 0);
      vendor.returnDaysCount += 1;
      if (
        row.expectedReturnDate &&
        row.pendingQty <= 0 &&
        row.lastReturnDate <= row.expectedReturnDate
      ) {
        vendor.onTimeCases += 1;
      }
      if (
        !vendor.lastReturnDate ||
        row.lastReturnDate > vendor.lastReturnDate
      ) {
        vendor.lastReturnDate = row.lastReturnDate;
      }
    }

    if (!vendor.lastDispatchDate || row.rdvDate > vendor.lastDispatchDate) {
      vendor.lastDispatchDate = row.rdvDate;
    }
  });

  let vendorRows = [...grouped.values()].map((vendor) => {
    const onTimePercent = vendor.dispatchLines
      ? Number(((vendor.onTimeCases / vendor.dispatchLines) * 100).toFixed(2))
      : 0;
    const avgReturnDays = vendor.returnDaysCount
      ? Number((vendor.returnDaysSum / vendor.returnDaysCount).toFixed(2))
      : 0;

    let riskGrade = "A";
    if (
      vendor.overdueQty > 0 ||
      vendor.shortageCases >= 3 ||
      vendor.conditionVarianceCases >= 3
    ) {
      riskGrade = "C";
    } else if (
      vendor.shortageCases > 0 ||
      vendor.conditionVarianceCases > 0 ||
      onTimePercent < 80
    ) {
      riskGrade = "B";
    }

    return {
      ...vendor,
      totalDispatchQty: Number(vendor.totalDispatchQty.toFixed(3)),
      totalReturnedQty: Number(vendor.totalReturnedQty.toFixed(3)),
      pendingQty: Number(vendor.pendingQty.toFixed(3)),
      overdueQty: Number(vendor.overdueQty.toFixed(3)),
      onTimePercent,
      avgReturnDays,
      riskGrade,
    };
  });

  if (!filters.includeClosed) {
    vendorRows = vendorRows.filter((row) => row.pendingQty > 0);
  }
  if (filters.overdueVendorsOnly) {
    vendorRows = vendorRows.filter((row) => row.overdueQty > 0);
  }

  vendorRows.sort((a, b) => {
    const riskWeight = { C: 3, B: 2, A: 1 };
    const riskDiff =
      (riskWeight[b.riskGrade] || 0) - (riskWeight[a.riskGrade] || 0);
    if (riskDiff !== 0) return riskDiff;
    if (b.overdueQty !== a.overdueQty) return b.overdueQty - a.overdueQty;
    return String(a.vendorName || "").localeCompare(String(b.vendorName || ""));
  });

  const totals = vendorRows.reduce(
    (acc, row) => {
      acc.totalDispatchQty += row.totalDispatchQty;
      acc.totalReturnedQty += row.totalReturnedQty;
      acc.pendingQty += row.pendingQty;
      acc.overdueQty += row.overdueQty;
      acc.shortageCases += row.shortageCases;
      acc.conditionVarianceCases += row.conditionVarianceCases;
      return acc;
    },
    {
      totalDispatchQty: 0,
      totalReturnedQty: 0,
      pendingQty: 0,
      overdueQty: 0,
      shortageCases: 0,
      conditionVarianceCases: 0,
    },
  );

  return {
    rows: vendorRows,
    totals: {
      totalDispatchQty: Number(totals.totalDispatchQty.toFixed(3)),
      totalReturnedQty: Number(totals.totalReturnedQty.toFixed(3)),
      pendingQty: Number(totals.pendingQty.toFixed(3)),
      overdueQty: Number(totals.overdueQty.toFixed(3)),
      shortageCases: Number(totals.shortageCases || 0),
      conditionVarianceCases: Number(totals.conditionVarianceCases || 0),
    },
  };
};

const getReturnablesControlReportPageData = async ({ req, input = {} }) => {
  const filters = parseCommonFilters({ req, input });
  const options = await loadOptions({ req, branchIds: filters.branchIds });

  if (!filters.reportLoaded) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        totals: { sentQty: 0, returnedQty: 0, pendingQty: 0 },
        kpis: {
          totalLines: 0,
          pendingLines: 0,
          overdueLines: 0,
          overdueQty: 0,
          pendingExposure: 0,
          closedPercent: 0,
        },
      },
    };
  }

  const rawRows = await loadControlRows({ filters });
  const rows = applyControlFilters(rawRows, filters);
  const summary = buildControlSummary(rows);

  return {
    filters,
    options,
    reportData: {
      rows,
      totals: summary.totals,
      kpis: summary.kpis,
    },
  };
};

const getReturnablesVendorPerformancePageData = async ({ req, input = {} }) => {
  const filters = parseCommonFilters({ req, input });
  const options = await loadOptions({ req, branchIds: filters.branchIds });

  if (!filters.reportLoaded) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        totals: {
          totalDispatchQty: 0,
          totalReturnedQty: 0,
          pendingQty: 0,
          overdueQty: 0,
          shortageCases: 0,
          conditionVarianceCases: 0,
        },
      },
    };
  }

  const rawRows = await loadControlRows({ filters });
  const rows = applyControlFilters(rawRows, { ...filters, statusList: [] });
  const conditionVarianceMap = await getLineConditionVarianceMap({ filters });
  const vendorData = buildVendorPerformance({
    rows,
    conditionVarianceMap,
    filters,
  });

  return {
    filters,
    options,
    reportData: vendorData,
  };
};

module.exports = {
  getReturnablesControlReportPageData,
  getReturnablesVendorPerformancePageData,
};
