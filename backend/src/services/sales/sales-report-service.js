"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const { toBoolean, toIdList } = require("../../utils/report-filter-types");
const {
  evaluateSalesDiscountPolicy,
  loadActiveSalesDiscountPolicyMapTx,
} = require("./sales-discount-policy-service");

const ALL_MULTI_FILTER_VALUE = "__ALL__";
const SALES_ORDER_REPORT_ORDER_TYPES = Object.freeze({
  party: "party",
  payment_account: "payment_account",
  voucher: "voucher",
  article: "article",
});
const SALES_ORDER_REPORT_DISPLAY_TYPES = Object.freeze({
  details: "details",
  summary: "summary",
});
const SALES_REPORT_SALE_TYPES = Object.freeze({
  all: "all",
  cash: "cash",
  credit: "credit",
});
const SALES_REPORT_VOUCHER_STATUS_TYPES = Object.freeze({
  all: "all",
  approved: "approved",
  pending: "pending",
});

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
  ) {
    return null;
  }
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

const resolveSalesOrderReportOrderType = (value, fallback) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "payment account") {
    return SALES_ORDER_REPORT_ORDER_TYPES.payment_account;
  }
  return Object.values(SALES_ORDER_REPORT_ORDER_TYPES).includes(normalized)
    ? normalized
    : fallback;
};

const resolveSalesOrderReportDisplayType = (value, fallback) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return Object.values(SALES_ORDER_REPORT_DISPLAY_TYPES).includes(normalized)
    ? normalized
    : fallback;
};

const resolveSalesReportSaleType = (value, fallback = SALES_REPORT_SALE_TYPES.all) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return Object.values(SALES_REPORT_SALE_TYPES).includes(normalized)
    ? normalized
    : fallback;
};

const resolveSalesReportVoucherStatus = (
  value,
  fallback = SALES_REPORT_VOUCHER_STATUS_TYPES.all,
) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return Object.values(SALES_REPORT_VOUCHER_STATUS_TYPES).includes(normalized)
    ? normalized
    : fallback;
};

const applyPartyBranchScope = (query, branchIds = []) => {
  if (!branchIds.length) return query;
  return query.where(function whereCustomerBranchScope() {
    this.whereIn("p.branch_id", branchIds).orWhereExists(
      function whereCustomerBranchMap() {
        this.select(1)
          .from("erp.party_branch as pb")
          .whereRaw("pb.party_id = p.id")
          .whereIn("pb.branch_id", branchIds);
      },
    );
  });
};

const parseCustomerBalanceFilters = ({ req, input = {} }) => {
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

  return {
    asOn,
    branchIds,
    reportLoaded: toBoolean(input.load_report, false),
    invalidAsOnDate: Boolean(parsedAsOn.provided && !parsedAsOn.valid),
    invalidFilterInput: Boolean(parsedAsOn.provided && !parsedAsOn.valid),
  };
};

const parseCustomerLedgerFilters = ({ req, input = {} }) => {
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
    partyId: toPositiveId(input.party_id),
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

const parseSalesOrderReportFilters = ({ req, input = {} }) => {
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
  const branchIds = req.user?.isAdmin
    ? branchIdsFromInput
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const reportTypeRaw = String(input.report_type || "pending")
    .trim()
    .toLowerCase();
  const reportType = ["pending", "closed", "complete"].includes(reportTypeRaw)
    ? reportTypeRaw
    : "pending";
  const orderBy = resolveSalesOrderReportOrderType(
    input.order_by,
    SALES_ORDER_REPORT_ORDER_TYPES.party,
  );
  const displayType = resolveSalesOrderReportDisplayType(
    input.display_type,
    SALES_ORDER_REPORT_DISPLAY_TYPES.details,
  );

  return {
    from,
    to,
    partyId: toPositiveId(input.party_id),
    productGroupId: toPositiveId(input.product_group_id),
    branchIds,
    reportType,
    orderBy,
    displayType,
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

const loadSalesOrderReportOptions = async ({ req, filters }) => {
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

  let customersQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name", "p.name_ur")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','BOTH')")
    .orderBy("p.name", "asc");

  if (!req.user?.isAdmin || scopedBranchIds.length) {
    customersQuery = applyPartyBranchScope(customersQuery, scopedBranchIds);
  }

  const productGroups = await knex("erp.product_groups as pg")
    .select("pg.id", "pg.name")
    .where({ "pg.is_active": true })
    .whereExists(function whereGroupHasSalesSku() {
      this.select(1)
        .from("erp.items as i")
        .join("erp.variants as v", "v.item_id", "i.id")
        .join("erp.skus as s", "s.variant_id", "v.id")
        .whereRaw("i.group_id = pg.id")
        .andWhere("i.is_active", true)
        .andWhere("s.is_active", true);
    })
    .orderBy("pg.name", "asc");

  const customers = await customersQuery;

  return {
    branches,
    customers,
    productGroups,
  };
};

const getSalesOrderReportRows = async ({ req, filters }) => {
  if (!filters.reportLoaded) {
    return {
      includeBranchColumn: Boolean(
        req.user?.isAdmin && filters.branchIds.length !== 1,
      ),
      rows: [],
    };
  }

  const includeBranchColumn = Boolean(
    req.user?.isAdmin && filters.branchIds.length !== 1,
  );

  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  let orderLinesQuery = knex("erp.voucher_header as vh")
    .join("erp.sales_order_header as soh", "soh.voucher_id", "vh.id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.skus as s", "s.id", "vl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .join("erp.parties as p", "p.id", "soh.customer_party_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .select(
      "vh.id as sales_order_id",
      "vh.voucher_no as sales_order_no",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as sales_order_date"),
      "vh.status as voucher_status",
      "vh.branch_id",
      "b.name as branch_name",
      "soh.customer_party_id",
      "p.code as customer_code",
      "p.name as customer_name_en",
      "p.name_ur as customer_name_ur",
      "vl.id as sales_order_line_id",
      "vl.line_no",
      "vl.qty as ordered_pairs",
      "vl.meta as line_meta",
      "s.id as sku_id",
      "s.sku_code",
      "i.name as product_name",
      "u.name as unit_name",
      knex.raw("''::text as color_name"),
    )
    .where({
      "vh.voucher_type_code": "SALES_ORDER",
      "vl.line_kind": "SKU",
    })
    .where("vh.voucher_date", ">=", filters.from)
    .where("vh.voucher_date", "<=", filters.to);

  if (scopedBranchIds.length) {
    orderLinesQuery = orderLinesQuery.whereIn("vh.branch_id", scopedBranchIds);
  }
  if (filters.partyId) {
    orderLinesQuery = orderLinesQuery.where(
      "soh.customer_party_id",
      filters.partyId,
    );
  }
  if (filters.productGroupId) {
    orderLinesQuery = orderLinesQuery.where("i.group_id", filters.productGroupId);
  }

  if (filters.orderBy === SALES_ORDER_REPORT_ORDER_TYPES.party) {
    orderLinesQuery = orderLinesQuery
      .orderByRaw("coalesce(p.name, '') asc")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  } else if (filters.orderBy === SALES_ORDER_REPORT_ORDER_TYPES.voucher) {
    orderLinesQuery = orderLinesQuery
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  } else {
    orderLinesQuery = orderLinesQuery
      .orderByRaw("coalesce(i.name, '') asc")
      .orderByRaw("coalesce(s.sku_code, '') asc")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  }

  let movementQuery = knex("erp.voucher_header as svh")
    .join("erp.sales_header as sh", "sh.voucher_id", "svh.id")
    .join("erp.voucher_line as svl", "svl.voucher_header_id", "svh.id")
    .select(
      "sh.linked_sales_order_id as sales_order_id",
      knex.raw(
        "cast(svl.meta->>'sales_order_line_id' as bigint) as sales_order_line_id",
      ),
      knex.raw(
        "sum(case when coalesce(svl.meta->>'movement_kind', '') = 'SALE' then coalesce(svl.qty,0) else 0 end) as delivered_pairs",
      ),
      knex.raw(
        "sum(case when coalesce(svl.meta->>'movement_kind', '') = 'RETURN' then coalesce(svl.qty,0) else 0 end) as returned_pairs",
      ),
      knex.raw(
        "max(to_char(svh.voucher_date, 'YYYY-MM-DD')) as last_activity_date",
      ),
    )
    .where({
      "svh.voucher_type_code": "SALES_VOUCHER",
      "svl.line_kind": "SKU",
    })
    .whereNot("svh.status", "REJECTED")
    .whereNotNull("sh.linked_sales_order_id")
    .whereRaw("coalesce(svl.meta->>'sales_order_line_id', '') ~ '^[0-9]+$'")
    .groupBy(
      "sh.linked_sales_order_id",
      knex.raw("cast(svl.meta->>'sales_order_line_id' as bigint)"),
    );

  if (scopedBranchIds.length) {
    movementQuery = movementQuery.whereIn("svh.branch_id", scopedBranchIds);
  }

  const [orderLines, movementRows] = await Promise.all([
    orderLinesQuery,
    movementQuery,
  ]);

  const movementByLineKey = new Map(
    (movementRows || []).map((row) => [
      `${Number(row.sales_order_id || 0)}:${Number(row.sales_order_line_id || 0)}`,
      {
        deliveredPairs: Number(row.delivered_pairs || 0),
        returnedPairs: Number(row.returned_pairs || 0),
        lastActivityDate: row.last_activity_date || null,
      },
    ]),
  );

  const lines = (orderLines || []).map((row) => {
    const lineMeta =
      row.line_meta && typeof row.line_meta === "object" ? row.line_meta : {};
    const rowStatus =
      String(lineMeta.row_status || "PACKED")
        .trim()
        .toUpperCase() === "PACKED"
        ? "PACKED"
        : "LOOSE";
    const isPacked = rowStatus === "PACKED";
    const orderedPairsRaw = Number(row.ordered_pairs || 0);
    const orderedPairs = Number(Math.max(0, orderedPairsRaw).toFixed(3));
    const lineKey = `${Number(row.sales_order_id || 0)}:${Number(row.sales_order_line_id || 0)}`;
    const movement = movementByLineKey.get(lineKey) || {
      deliveredPairs: 0,
      returnedPairs: 0,
      lastActivityDate: null,
    };

    const deliveredPairs = Number(
      Math.max(
        0,
        Math.min(orderedPairs, Number(movement.deliveredPairs || 0)),
      ).toFixed(3),
    );
    const returnedPairs = Number(
      Math.max(0, Number(movement.returnedPairs || 0)).toFixed(3),
    );
    const remainingPairs = Number(
      Math.max(0, orderedPairs - deliveredPairs + returnedPairs).toFixed(3),
    );

    const convertPairsToQty = (pairs) =>
      isPacked
        ? Number((Number(pairs || 0) / 12).toFixed(3))
        : Number(Number(pairs || 0).toFixed(3));

    const orderedQty = convertPairsToQty(orderedPairs);
    const deliveredQty = convertPairsToQty(deliveredPairs);
    const remainingQty = convertPairsToQty(remainingPairs);

    const voucherStatus = String(row.voucher_status || "")
      .trim()
      .toUpperCase();
    const statusType =
      voucherStatus === "REJECTED"
        ? "closed"
        : remainingPairs <= 0
          ? "complete"
          : "pending";

    const productName = String(row.product_name || "").trim();
    const skuCode = String(row.sku_code || "").trim();

    return {
      sales_order_id: Number(row.sales_order_id || 0),
      sales_order_no: Number(row.sales_order_no || 0) || null,
      sales_order_date: row.sales_order_date || null,
      customer_party_id: Number(row.customer_party_id || 0) || null,
      close_date:
        statusType === "complete"
          ? movement.lastActivityDate || row.sales_order_date || null
          : null,
      branch_name: row.branch_name || "",
      customer_name_en: row.customer_name_en || "",
      customer_name_ur: row.customer_name_ur || "",
      customer_code: row.customer_code || "",
      sku_id: Number(row.sku_id || 0) || null,
      sku_code: skuCode,
      product_name:
        productName && skuCode
          ? `${productName} (${skuCode})`
          : productName || skuCode || "",
      unit_name: row.unit_name || "",
      color_name: row.color_name || "",
      ordered_qty: orderedQty,
      delivered_qty: deliveredQty,
      remaining_qty: remainingQty,
      status_type: statusType,
      action_link: `/vouchers/sales-order?voucher_no=${Number(row.sales_order_no || 0)}&view=1`,
    };
  });

  const filteredLines = lines.filter(
    (line) => line.status_type === filters.reportType,
  );

  const totals = filteredLines.reduce(
    (acc, line) => {
      acc.orderedQty = toQty(acc.orderedQty + Number(line.ordered_qty || 0), 3);
      acc.deliveredQty = toQty(
        acc.deliveredQty + Number(line.delivered_qty || 0),
        3,
      );
      acc.remainingQty = toQty(
        acc.remainingQty + Number(line.remaining_qty || 0),
        3,
      );
      return acc;
    },
    { orderedQty: 0, deliveredQty: 0, remainingQty: 0 },
  );

  return {
    includeBranchColumn,
    rows: filteredLines,
    totals,
  };
};

const getSalesOrderReportGroupIdentity = (row, orderBy) => {
  if (orderBy === SALES_ORDER_REPORT_ORDER_TYPES.voucher) {
    const key = `SO:${Number(row.sales_order_id || 0)}`;
    return {
      key,
      label: `#${Number(row.sales_order_no || 0) || "-"} | ${row.sales_order_date || "-"} | ${row.customer_name_en || row.customer_name_ur || "-"}`,
      sales_order_no: row.sales_order_no || null,
      sales_order_date: row.sales_order_date || "",
      close_date: row.close_date || "",
      customer_name_en: row.customer_name_en || "",
      customer_name_ur: row.customer_name_ur || "",
      product_name: "",
    };
  }

  if (orderBy === SALES_ORDER_REPORT_ORDER_TYPES.article) {
    const key = `SKU:${Number(row.sku_id || 0)}`;
    return {
      key,
      label: row.product_name || "-",
      sales_order_no: null,
      sales_order_date: "",
      close_date: "",
      customer_name_en: "",
      customer_name_ur: "",
      product_name: row.product_name || "",
    };
  }

  const key = `PTY:${Number(row.customer_party_id || 0)}`;
  return {
    key,
    label: row.customer_name_en || row.customer_name_ur || "-",
    sales_order_no: null,
    sales_order_date: "",
    close_date: "",
    customer_name_en: row.customer_name_en || "",
    customer_name_ur: row.customer_name_ur || "",
    product_name: "",
  };
};

const buildSalesOrderReportData = ({ reportRows, filters }) => {
  const rows = Array.isArray(reportRows?.rows) ? reportRows.rows : [];
  const includeBranchColumn = Boolean(reportRows?.includeBranchColumn);
  const baseTotals = reportRows?.totals || {
    orderedQty: 0,
    deliveredQty: 0,
    remainingQty: 0,
  };
  const groups = [];
  const groupMap = new Map();

  rows.forEach((row) => {
    const identity = getSalesOrderReportGroupIdentity(row, filters.orderBy);
    let group = groupMap.get(identity.key);
    if (!group) {
      group = {
        key: identity.key,
        label: identity.label,
        sales_order_no: identity.sales_order_no,
        sales_order_date: identity.sales_order_date,
        close_date: identity.close_date,
        latest_complete_date: identity.close_date,
        customer_name_en: identity.customer_name_en,
        customer_name_ur: identity.customer_name_ur,
        product_name: identity.product_name,
        total_ordered_qty: 0,
        total_delivered_qty: 0,
        total_remaining_qty: 0,
        line_count: 0,
        order_count: 0,
        customer_count: 0,
        article_count: 0,
        lines: [],
      };
      group._orderIds = new Set();
      group._customerIds = new Set();
      group._articleIds = new Set();
      groups.push(group);
      groupMap.set(identity.key, group);
    }

    group.total_ordered_qty = toQty(
      group.total_ordered_qty + Number(row.ordered_qty || 0),
      3,
    );
    group.total_delivered_qty = toQty(
      group.total_delivered_qty + Number(row.delivered_qty || 0),
      3,
    );
    group.total_remaining_qty = toQty(
      group.total_remaining_qty + Number(row.remaining_qty || 0),
      3,
    );
    group.line_count += 1;
    if (row.close_date) {
      const nextDate = String(row.close_date || "");
      const currentDate = String(group.latest_complete_date || "");
      if (!currentDate || nextDate > currentDate) {
        group.latest_complete_date = nextDate;
      }
    }
    if (row.sales_order_id) group._orderIds.add(Number(row.sales_order_id));
    if (row.customer_party_id)
      group._customerIds.add(Number(row.customer_party_id));
    if (row.sku_id) group._articleIds.add(Number(row.sku_id));
    if (filters.displayType === SALES_ORDER_REPORT_DISPLAY_TYPES.details) {
      group.lines.push(row);
    }
  });

  groups.forEach((group) => {
    group.order_count = group._orderIds.size;
    group.customer_count = group._customerIds.size;
    group.article_count = group._articleIds.size;
    delete group._orderIds;
    delete group._customerIds;
    delete group._articleIds;
  });

  const summaryRows = groups.map((group) => ({
    key: group.key,
    group_label: group.label,
    sales_order_no: group.sales_order_no,
    sales_order_date: group.sales_order_date,
    close_date: group.close_date,
    latest_complete_date: group.latest_complete_date || group.close_date || "",
    customer_name_en: group.customer_name_en,
    customer_name_ur: group.customer_name_ur,
    product_name: group.product_name,
    total_ordered_qty: toQty(group.total_ordered_qty, 3),
    total_delivered_qty: toQty(group.total_delivered_qty, 3),
    total_remaining_qty: toQty(group.total_remaining_qty, 3),
    line_count: group.line_count,
    order_count: group.order_count,
    customer_count: group.customer_count,
    article_count: group.article_count,
  }));

  return {
    includeBranchColumn,
    rows,
    groups,
    summaryRows,
    totals: {
      orderedQty: toQty(baseTotals.orderedQty || 0, 3),
      deliveredQty: toQty(baseTotals.deliveredQty || 0, 3),
      remainingQty: toQty(baseTotals.remainingQty || 0, 3),
    },
  };
};

const getSalesOrderReportPageData = async ({ req, input = {} }) => {
  const filters = parseSalesOrderReportFilters({ req, input });
  const options = await loadSalesOrderReportOptions({ req, filters });
  const reportRows = await getSalesOrderReportRows({ req, filters });
  const reportData = buildSalesOrderReportData({ reportRows, filters });

  return {
    filters,
    options,
    reportData,
  };
};

const parseSalesReportFilters = ({ req, input = {} }) => {
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

  const branchId = req.user?.isAdmin
    ? toPositiveId(input.branch_id)
    : Number(req.branchId || 0) || null;

  return {
    from,
    to,
    partyId: toPositiveId(input.party_id),
    groupId: toPositiveId(input.group_id),
    subgroupId: toPositiveId(input.subgroup_id),
    categoryId: toPositiveId(input.category_id),
    returnReasonId: toPositiveId(input.return_reason_id),
    salesmanId: toPositiveId(input.salesman_employee_id),
    receiveIntoAccountId: toPositiveId(input.receive_into_account_id),
    branchId,
    orderBy: resolveSalesOrderReportOrderType(
      input.order_by,
      SALES_ORDER_REPORT_ORDER_TYPES.payment_account,
    ),
    saleType: resolveSalesReportSaleType(input.sale_type),
    voucherStatus: resolveSalesReportVoucherStatus(input.voucher_status),
    reportType: resolveSalesOrderReportDisplayType(
      input.report_type,
      SALES_ORDER_REPORT_DISPLAY_TYPES.details,
    ),
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

const loadSaleReturnReasonOptions = async () =>
  knex("erp.return_reasons")
    .select("id", "code", "description")
    .where({ is_active: true })
    .orderBy("description", "asc");

const loadSalesReportOptions = async ({ req, filters }) => {
  const branchScope = req.user?.isAdmin
    ? [Number(filters.branchId || 0)].filter((id) => id > 0)
    : [Number(req.branchId || 0)].filter((id) => id > 0);

  const branchesPromise = req.user?.isAdmin
    ? knex("erp.branches")
        .select("id", "name")
        .where({ is_active: true })
        .orderBy("name", "asc")
    : Promise.resolve(
        (req.branchOptions || []).map((row) => ({
          id: Number(row.id || 0),
          name: row.name,
        })),
      );

  let customersQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name", "p.name_ur")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','BOTH')");

  if (!req.user?.isAdmin || branchScope.length) {
    customersQuery = applyPartyBranchScope(customersQuery, branchScope);
  }

  let salesmenQuery = knex("erp.employees as e")
    .distinct("e.id", "e.code", "e.name")
    .whereRaw("lower(coalesce(e.status, '')) = 'active'")
    .whereExists(function whereEmployeeHasSalesVoucher() {
      this.select(1)
        .from("erp.sales_header as sh")
        .join("erp.voucher_header as vh", "vh.id", "sh.voucher_id")
        .whereRaw("sh.salesman_employee_id = e.id")
        .where("vh.voucher_type_code", "SALES_VOUCHER")
        .whereNot("vh.status", "REJECTED")
        .modify((queryBuilder) => {
          if (branchScope.length) {
            queryBuilder.whereIn("vh.branch_id", branchScope);
          }
        });
    })
    .orderBy("e.name", "asc");

  let receiveAccountsQuery = knex("erp.accounts as a")
    .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
    .select("a.id", "a.code", "a.name")
    .where({ "a.is_active": true })
    .whereRaw("lower(coalesce(apc.code, '')) in ('cash','bank')");

  if (!req.user?.isAdmin || branchScope.length) {
    const scopedBranches = branchScope.length
      ? branchScope
      : [Number(req.branchId || 0)];
    receiveAccountsQuery = receiveAccountsQuery.whereExists(
      function whereReceiveAccountBranchScope() {
        this.select(1)
          .from("erp.account_branch as ab")
          .whereRaw("ab.account_id = a.id")
          .whereIn("ab.branch_id", scopedBranches);
      },
    );
  }

  const [
    branches,
    customers,
    groups,
    subgroups,
    categories,
    salesmen,
    receiveAccounts,
  ] =
    await Promise.all([
      branchesPromise,
      customersQuery.orderBy("p.name", "asc"),
      knex("erp.product_groups as pg")
        .select("pg.id", "pg.name")
        .where({ "pg.is_active": true })
        .whereExists(function whereGroupHasFgItems() {
          this.select(1)
            .from("erp.items as i")
            .whereRaw("i.group_id = pg.id")
            .andWhere("i.is_active", true)
            .andWhereRaw("upper(coalesce(i.item_type::text, '')) = 'FG'");
        })
        .orderBy("pg.name", "asc"),
      knex("erp.product_subgroups as sg")
        .select("sg.id", "sg.name", "sg.group_id")
        .where({ "sg.is_active": true })
        .modify((queryBuilder) => {
          if (filters.groupId) queryBuilder.where("sg.group_id", filters.groupId);
        })
        .whereExists(function whereSubgroupHasFgItems() {
          this.select(1)
            .from("erp.items as i")
            .whereRaw("i.subgroup_id = sg.id")
            .andWhere("i.is_active", true)
            .andWhereRaw("upper(coalesce(i.item_type::text, '')) = 'FG'");
        })
        .orderBy("sg.name", "asc"),
      knex("erp.product_types as pt")
        .select("pt.id", "pt.name", "pt.name_ur")
        .where({ "pt.is_active": true })
        .whereExists(function whereCategoryHasFgItems() {
          this.select(1)
            .from("erp.items as i")
            .whereRaw("i.product_type_id = pt.id")
            .andWhere("i.is_active", true)
            .andWhereRaw("upper(coalesce(i.item_type::text, '')) = 'FG'")
            .modify((queryBuilder) => {
              if (filters.groupId) queryBuilder.where("i.group_id", filters.groupId);
              if (filters.subgroupId) {
                queryBuilder.where("i.subgroup_id", filters.subgroupId);
              }
            });
        })
        .orderBy("pt.name", "asc"),
      salesmenQuery,
      receiveAccountsQuery.orderBy("a.name", "asc"),
    ]);

  return {
    branches,
    customers,
    groups,
    subgroups,
    categories,
    salesmen,
    receiveAccounts,
  };
};

const getSalesReportRows = async ({
  req,
  filters,
  movementKind = "SALE",
}) => {
  if (!filters.reportLoaded) return [];

  const rawMovementKind = String(movementKind || "SALE").trim().toUpperCase();
  const normalizedMovementKind =
    rawMovementKind === "RETURN"
      ? "RETURN"
      : rawMovementKind === "ALL"
        ? "ALL"
        : "SALE";

  const scopedBranchIds = req.user?.isAdmin
    ? [Number(filters.branchId || 0)].filter((id) => id > 0)
    : [Number(req.branchId || 0)].filter((id) => id > 0);

  let query = knex("erp.voucher_header as vh")
    .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
    .leftJoin("erp.product_types as pt", "pt.id", "i.product_type_id")
    .leftJoin("erp.parties as p", "p.id", "sh.customer_party_id")
    .leftJoin("erp.employees as e", "e.id", "sh.salesman_employee_id")
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .leftJoin("erp.accounts as ra", "ra.id", "sh.receive_into_account_id")
    .select(
      "vh.id as voucher_id",
      "vh.voucher_type_code",
      "vh.voucher_no",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
      "vh.book_no as bill_number",
      knex.raw("COALESCE(NULLIF(vh.remarks, ''), '') as remarks"),
      "vh.branch_id",
      "b.name as branch_name",
      "sh.payment_type",
      "sh.payment_received_amount",
      "sh.receive_into_account_id",
      "ra.name as receive_account_name",
      "sh.customer_party_id",
      "sh.customer_name as walk_in_customer_name",
      "p.name as customer_name_en",
      "p.name_ur as customer_name_ur",
      "sh.salesman_employee_id",
      "e.name as salesman_name",
      "vl.line_no",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
      "s.id as sku_id",
      "s.sku_code",
      "i.id as item_id",
      "i.name as item_name",
      "i.group_id",
      "pg.name as group_name",
      "i.subgroup_id",
      "sg.name as subgroup_name",
      "i.product_type_id",
      "pt.name as category_name",
    )
    .where("vh.voucher_type_code", "SALES_VOUCHER")
    .whereNot("vh.status", "REJECTED")
    .where("vl.line_kind", "SKU")
    .where("vh.voucher_date", ">=", filters.from)
    .where("vh.voucher_date", "<=", filters.to);

  if (normalizedMovementKind !== "ALL") {
    query = query.whereRaw(
      "upper(coalesce(vl.meta->>'movement_kind', 'SALE')) = ?",
      [normalizedMovementKind],
    );
  }

  if (scopedBranchIds.length) {
    query = query.whereIn("vh.branch_id", scopedBranchIds);
  }
  if (filters.partyId) query = query.where("sh.customer_party_id", filters.partyId);
  if (filters.groupId) query = query.where("i.group_id", filters.groupId);
  if (filters.subgroupId) query = query.where("i.subgroup_id", filters.subgroupId);
  if (filters.categoryId) {
    query = query.where("i.product_type_id", filters.categoryId);
  }
  if (normalizedMovementKind === "RETURN" && filters.returnReasonId) {
    query = query.whereRaw(
      "coalesce(nullif(vl.meta->>'return_reason_id', ''), '0')::int = ?",
      [Number(filters.returnReasonId)],
    );
  }
  if (filters.salesmanId) {
    query = query.where("sh.salesman_employee_id", filters.salesmanId);
  }
  if (filters.receiveIntoAccountId) {
    query = query.where("sh.receive_into_account_id", filters.receiveIntoAccountId);
  }
  if (filters.voucherStatus === SALES_REPORT_VOUCHER_STATUS_TYPES.approved) {
    query = query.whereRaw("upper(coalesce(vh.status::text, '')) = 'APPROVED'");
  } else if (filters.voucherStatus === SALES_REPORT_VOUCHER_STATUS_TYPES.pending) {
    query = query.whereRaw("upper(coalesce(vh.status::text, '')) = 'PENDING'");
  }
  if (filters.saleType === SALES_REPORT_SALE_TYPES.cash) {
    query = query.whereRaw("upper(coalesce(sh.payment_type::text, '')) = 'CASH'");
  } else if (filters.saleType === SALES_REPORT_SALE_TYPES.credit) {
    query = query.whereRaw(
      "upper(coalesce(sh.payment_type::text, '')) = 'CREDIT'",
    );
  }

  if (filters.orderBy === SALES_ORDER_REPORT_ORDER_TYPES.payment_account) {
    query = query
      .orderByRaw("coalesce(nullif(ra.name, ''), '-') asc")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  } else if (filters.orderBy === SALES_ORDER_REPORT_ORDER_TYPES.party) {
    query = query
      .orderByRaw(
        "coalesce(nullif(p.name, ''), nullif(sh.customer_name, ''), '') asc",
      )
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  } else if (filters.orderBy === SALES_ORDER_REPORT_ORDER_TYPES.voucher) {
    query = query
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  } else {
    query = query
      .orderByRaw("coalesce(nullif(i.name, ''), nullif(s.sku_code, ''), '') asc")
      .orderByRaw("coalesce(nullif(s.sku_code, ''), '') asc")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  }

  const rows = await query;
  const mappedRows = rows.map((row) => {
    const meta = row?.meta && typeof row.meta === "object" ? row.meta : {};
    const lineMovementKind =
      String(meta.movement_kind || "SALE").trim().toUpperCase() === "RETURN"
        ? "RETURN"
        : "SALE";
    const amountSign = lineMovementKind === "RETURN" ? -1 : 1;
    const rowStatus =
      String(meta.row_status || "PACKED").trim().toUpperCase() === "LOOSE"
        ? "LOOSE"
        : "PACKED";
    const inputQty = toQty(
      lineMovementKind === "RETURN"
        ? meta.return_qty !== undefined
          ? meta.return_qty
          : row.qty
        : meta.sale_qty !== undefined
          ? meta.sale_qty
          : row.qty,
      3,
    );
    const signedInputQty = toQty(amountSign * inputQty, 3);
    const qty = toQty(
      amountSign * (meta.total_pairs !== undefined ? meta.total_pairs : row.qty),
      3,
    );
    const rate = toAmount(
      meta.pair_rate !== undefined ? meta.pair_rate : row.rate,
      2,
    );
    const pairDiscount = toAmount(
      meta.pair_discount !== undefined ? meta.pair_discount : 0,
      2,
    );
    const discountAmount = toAmount(
      amountSign * (meta.total_discount !== undefined ? meta.total_discount : 0),
      2,
    );
    const returnReasonId = toPositiveId(meta.return_reason_id);
    const netAmount = toAmount(
      amountSign * (meta.total_amount !== undefined ? meta.total_amount : row.amount),
      2,
    );
    const grossAmount = toAmount(netAmount + discountAmount, 2);
    const paymentType = String(row.payment_type || "").trim().toUpperCase();
    const receivedAmount = toAmount(row.payment_received_amount || 0, 2);
    const remainingAmount = toAmount(
      paymentType === "CREDIT" ? Math.max(0, netAmount - receivedAmount) : 0,
      2,
    );
    const itemName = String(row.item_name || "").trim();
    const skuCode = String(row.sku_code || "").trim();
    const itemLabel =
      itemName && skuCode
        ? `${itemName} (${skuCode})`
        : itemName || skuCode || `#${Number(row.line_no || 0) || 0}`;

    return {
      voucher_id: Number(row.voucher_id || 0) || null,
      voucher_type: String(row.voucher_type_code || "").trim().toUpperCase(),
      voucher_no: Number(row.voucher_no || 0) || null,
      voucher_date: row.voucher_date || "",
      bill_number: String(row.bill_number || "").trim(),
      remarks: String(row.remarks || "").trim(),
      branch_id: Number(row.branch_id || 0) || null,
      branch_name: String(row.branch_name || "").trim(),
      voucher_status: String(row.voucher_status || "").trim().toUpperCase(),
      payment_type: paymentType,
      payment_received_amount: receivedAmount,
      receive_into_account_id: Number(row.receive_into_account_id || 0) || null,
      receive_account_name: String(row.receive_account_name || "").trim(),
      remaining_amount: remainingAmount,
      movement_kind: lineMovementKind,
      row_status: rowStatus,
      input_qty: signedInputQty,
      customer_party_id: Number(row.customer_party_id || 0) || null,
      customer_name_en: String(row.customer_name_en || "").trim(),
      customer_name_ur: String(row.customer_name_ur || "").trim(),
      walk_in_customer_name: String(row.walk_in_customer_name || "").trim(),
      salesman_employee_id: Number(row.salesman_employee_id || 0) || null,
      salesman_name: String(row.salesman_name || "").trim(),
      line_no: Number(row.line_no || 0) || 1,
      sku_id: Number(row.sku_id || 0) || null,
      sku_code: skuCode,
      item_id: Number(row.item_id || 0) || null,
      item_name: itemName,
      item_label: itemLabel,
      group_id: Number(row.group_id || 0) || null,
      group_name: String(row.group_name || "").trim(),
      subgroup_id: Number(row.subgroup_id || 0) || null,
      subgroup_name: String(row.subgroup_name || "").trim(),
      category_id: Number(row.product_type_id || 0) || null,
      category_name: String(row.category_name || "").trim(),
      return_reason_id: returnReasonId,
      return_reason_label: "",
      qty,
      rate,
      pair_discount: pairDiscount,
      gross_amount: grossAmount,
      discount_amount: discountAmount,
      net_amount: netAmount,
    };
  });

  if (
    normalizedMovementKind === "SALE" ||
    !mappedRows.length ||
    !mappedRows.some(
      (row) => String(row.movement_kind || "SALE").trim().toUpperCase() === "RETURN",
    )
  ) {
    return mappedRows;
  }

  const returnReasonRows = await loadSaleReturnReasonOptions();
  const returnReasonMap = new Map(
    returnReasonRows.map((row) => [
      Number(row.id || 0),
      String(row.description || row.code || "").trim(),
    ]),
  );

  return mappedRows.map((row) => ({
    ...row,
    return_reason_label: row.return_reason_id
      && String(row.movement_kind || "SALE").trim().toUpperCase() === "RETURN"
      ? returnReasonMap.get(Number(row.return_reason_id)) || ""
      : "",
  }));
};

const resolveSalesReportCustomerLabel = (row) => {
  if (!row) return "-";
  if (row.customer_party_id) {
    return (
      String(row.customer_name_en || "").trim() ||
      String(row.customer_name_ur || "").trim() ||
      "-"
    );
  }
  return String(row.walk_in_customer_name || "").trim() || "-";
};

const getSalesReportGroupIdentity = (row, orderBy) => {
  if (orderBy === SALES_ORDER_REPORT_ORDER_TYPES.voucher) {
    return {
      key: `V:${Number(row.voucher_id || 0) || 0}`,
      label: `#${Number(row.voucher_no || 0) || "-"}`,
      voucher_type: "",
      voucher_status: row.voucher_status || "",
      voucher_no: row.voucher_no,
      voucher_date: row.voucher_date || "",
      bill_number: row.bill_number || "",
      customer_label: resolveSalesReportCustomerLabel(row),
      payment_type: row.payment_type || "",
      payment_received_amount: toAmount(row.payment_received_amount || 0, 2),
      receive_account_name: row.receive_account_name || "",
      remaining_amount: toAmount(row.remaining_amount || 0, 2),
      item_label: "",
    };
  }

  if (orderBy === SALES_ORDER_REPORT_ORDER_TYPES.article) {
    return {
      key: `SKU:${Number(row.sku_id || row.item_id || 0) || 0}:${row.item_label}`,
      label: row.item_label || "-",
      voucher_type: "",
      voucher_status: "",
      voucher_no: null,
      voucher_date: "",
      bill_number: "",
      customer_label: "",
      payment_type: "",
      payment_received_amount: 0,
      receive_account_name: "",
      remaining_amount: 0,
      item_label: row.item_label || "-",
    };
  }

  if (orderBy === SALES_ORDER_REPORT_ORDER_TYPES.payment_account) {
    const accountLabel = String(row.receive_account_name || "").trim() || "-";
    const accountKey = row.receive_into_account_id
      ? `ACC:${Number(row.receive_into_account_id || 0)}`
      : `ACCNAME:${accountLabel}`;
    return {
      key: accountKey,
      label: accountLabel,
      voucher_type: "",
      voucher_status: "",
      voucher_no: null,
      voucher_date: "",
      bill_number: "",
      customer_label: "",
      payment_type: "",
      payment_received_amount: 0,
      receive_account_name: accountLabel,
      remaining_amount: 0,
      item_label: "",
    };
  }

  const customerLabel = resolveSalesReportCustomerLabel(row);
  const partyKey = row.customer_party_id
    ? `PTY:${Number(row.customer_party_id || 0)}`
    : `WALKIN:${customerLabel}`;
  return {
    key: partyKey,
    label: customerLabel,
    voucher_type: "",
    voucher_status: "",
    voucher_no: null,
    voucher_date: "",
    bill_number: "",
    customer_label: customerLabel,
    payment_type: "",
    payment_received_amount: 0,
    receive_account_name: "",
    remaining_amount: 0,
    item_label: "",
  };
};

const buildSalesReportData = ({ rows, filters, req }) => {
  const includeBranchColumn = Boolean(req.user?.isAdmin && !filters.branchId);
  const groups = [];
  const groupMap = new Map();

  rows.forEach((row) => {
    const identity = getSalesReportGroupIdentity(row, filters.orderBy);
    let group = groupMap.get(identity.key);
    if (!group) {
      group = {
        key: identity.key,
        label: identity.label,
        voucher_type: identity.voucher_type,
        voucher_status: identity.voucher_status,
        voucher_no: identity.voucher_no,
        voucher_date: identity.voucher_date,
        bill_number: identity.bill_number,
        customer_label: identity.customer_label,
        payment_type: identity.payment_type,
        payment_received_amount: identity.payment_received_amount,
        receive_account_name: identity.receive_account_name,
        remaining_amount: identity.remaining_amount,
        total_payment_received_amount: toAmount(
          identity.payment_received_amount,
          2,
        ),
        total_remaining_amount: toAmount(identity.remaining_amount, 2),
        item_label: identity.item_label,
        total_qty: 0,
        total_packed_qty_input: 0,
        total_loose_qty_input: 0,
        total_gross_amount: 0,
        total_discount_amount: 0,
        total_net_amount: 0,
        lines: [],
        _voucherIds: new Set(),
        _customerKeys: new Set(),
        _articleKeys: new Set(),
      };
      groups.push(group);
      groupMap.set(identity.key, group);
    }

    group.total_qty = toQty(group.total_qty + Number(row.qty || 0), 3);
    if (String(row.row_status || "").trim().toUpperCase() === "LOOSE") {
      group.total_loose_qty_input = toQty(
        group.total_loose_qty_input + Number(row.input_qty || 0),
        3,
      );
    } else {
      group.total_packed_qty_input = toQty(
        group.total_packed_qty_input + Number(row.input_qty || 0),
        3,
      );
    }
    group.total_gross_amount = toAmount(
      group.total_gross_amount + Number(row.gross_amount || 0),
      2,
    );
    group.total_discount_amount = toAmount(
      group.total_discount_amount + Number(row.discount_amount || 0),
      2,
    );
    group.total_net_amount = toAmount(
      group.total_net_amount + Number(row.net_amount || 0),
      2,
    );
    group._voucherIds.add(String(row.voucher_id || ""));
    group._customerKeys.add(
      row.customer_party_id
        ? `PTY:${Number(row.customer_party_id || 0)}`
        : `WALKIN:${resolveSalesReportCustomerLabel(row)}`,
    );
    group._articleKeys.add(String(row.sku_id || row.item_id || row.item_label || ""));

    if (filters.reportType === SALES_ORDER_REPORT_DISPLAY_TYPES.details) {
      group.lines.push(row);
    }
  });

  groups.forEach((group) => {
    const absGroupQty = Math.abs(Number(group.total_qty || 0));
    group.effective_pair_discount =
      absGroupQty > 0
        ? toAmount(
            Math.abs(Number(group.total_discount_amount || 0)) /
              Number(absGroupQty || 1),
            2,
          )
        : 0;
    if (filters.orderBy === SALES_ORDER_REPORT_ORDER_TYPES.voucher) {
      const paymentType = String(group.payment_type || "").trim().toUpperCase();
      const paymentReceivedAmount = toAmount(group.payment_received_amount || 0, 2);
      group.total_payment_received_amount = paymentReceivedAmount;
      group.remaining_amount =
        paymentType === "CREDIT"
          ? toAmount(
              Math.max(
                0,
                Number(group.total_net_amount || 0) - Number(paymentReceivedAmount || 0),
              ),
              2,
            )
          : 0;
      group.total_remaining_amount = group.remaining_amount;
    }
  });

  const summaryRows = groups.map((group) => ({
    key: group.key,
    group_label: group.label,
    voucher_type: group.voucher_type,
    voucher_status: group.voucher_status,
    voucher_no: group.voucher_no,
    voucher_date: group.voucher_date,
    bill_number: group.bill_number,
    customer_label: group.customer_label,
    payment_type: group.payment_type,
    payment_received_amount: toAmount(group.payment_received_amount, 2),
    receive_account_name: group.receive_account_name,
    remaining_amount: toAmount(group.remaining_amount, 2),
    total_payment_received_amount: toAmount(
      group.total_payment_received_amount,
      2,
    ),
    total_remaining_amount: toAmount(group.total_remaining_amount, 2),
    item_label: group.item_label,
    voucher_count: group._voucherIds.size,
    customer_count: group._customerKeys.size,
    article_count: group._articleKeys.size,
    total_qty: toQty(group.total_qty, 3),
    total_packed_qty_input: toQty(group.total_packed_qty_input, 3),
    total_loose_qty_input: toQty(group.total_loose_qty_input, 3),
    effective_pair_discount: toAmount(group.effective_pair_discount, 2),
    avg_rate:
      Math.abs(Number(group.total_qty || 0)) > 0
        ? toAmount(
            Math.abs(Number(group.total_gross_amount || 0)) /
              Number(Math.abs(group.total_qty || 0) || 1),
            2,
          )
        : 0,
    total_gross_amount: toAmount(group.total_gross_amount, 2),
    total_discount_amount: toAmount(group.total_discount_amount, 2),
    total_net_amount: toAmount(group.total_net_amount, 2),
  }));

  groups.forEach((group) => {
    delete group._voucherIds;
    delete group._customerKeys;
    delete group._articleKeys;
  });

  return {
    includeBranchColumn,
    groups,
    summaryRows,
    totals: {
      qty: toQty(rows.reduce((sum, row) => sum + Number(row.qty || 0), 0), 3),
      packedQty: toQty(
        rows.reduce(
          (sum, row) =>
            sum +
            (String(row.row_status || "").trim().toUpperCase() === "PACKED"
              ? Number(row.input_qty || 0)
              : 0),
          0,
        ),
        3,
      ),
      looseQty: toQty(
        rows.reduce(
          (sum, row) =>
            sum +
            (String(row.row_status || "").trim().toUpperCase() === "LOOSE"
              ? Number(row.input_qty || 0)
              : 0),
          0,
        ),
        3,
      ),
      grossAmount: toAmount(
        rows.reduce((sum, row) => sum + Number(row.gross_amount || 0), 0),
        2,
      ),
      discountAmount: toAmount(
        rows.reduce((sum, row) => sum + Number(row.discount_amount || 0), 0),
        2,
      ),
      netAmount: toAmount(
        rows.reduce((sum, row) => sum + Number(row.net_amount || 0), 0),
        2,
      ),
      effectivePairDiscount:
        Math.abs(rows.reduce((sum, row) => sum + Number(row.qty || 0), 0) || 0) > 0
          ? toAmount(
              Math.abs(
                rows.reduce(
                  (sum, row) => sum + Number(row.discount_amount || 0),
                  0,
                ),
              ) /
                Number(
                  Math.abs(
                    rows.reduce((sum, row) => sum + Number(row.qty || 0), 0),
                  ) || 1,
                ),
              2,
            )
          : 0,
    },
    rowCount: rows.length,
    groupCount: groups.length,
  };
};

const getSalesReportPageData = async ({ req, input = {} }) => {
  const filters = parseSalesReportFilters({ req, input });
  const [options, rows] = await Promise.all([
    loadSalesReportOptions({ req, filters }),
    getSalesReportRows({ req, filters, movementKind: "ALL" }),
  ]);
  const reportData = buildSalesReportData({ rows, filters, req });

  return {
    filters,
    options,
    reportData,
  };
};

const getSaleReturnReportPageData = async ({ req, input = {} }) => {
  const filters = parseSalesReportFilters({ req, input });
  const [options, returnReasons, rows] = await Promise.all([
    loadSalesReportOptions({ req, filters }),
    loadSaleReturnReasonOptions(),
    getSalesReportRows({ req, filters, movementKind: "RETURN" }),
  ]);
  const reportData = buildSalesReportData({ rows, filters, req });

  return {
    filters,
    options: {
      ...options,
      returnReasons,
    },
    reportData,
  };
};

const loadCustomerLedgerOptions = async ({ req, filters }) => {
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

  let customersQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name", "p.name_ur")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','BOTH')");

  if (!req.user?.isAdmin || scopedBranchIds.length) {
    customersQuery = applyPartyBranchScope(customersQuery, scopedBranchIds);
  }

  const customers = await customersQuery.orderBy("p.name", "asc");

  return {
    branches,
    customers,
  };
};

const getCustomerLedgerRows = async ({ req, filters, options }) => {
  const includeBranchColumn = Boolean(
    req.user?.isAdmin && filters.branchIds.length !== 1,
  );

  if (!filters.reportLoaded || !filters.partyId) {
    return {
      customer: null,
      openingBalance: 0,
      rows: [],
      ledgerView: filters.ledgerView,
      totals: {
        qty: 0,
        debit: 0,
        credit: 0,
        closingBalance: 0,
      },
      includeBranchColumn,
    };
  }

  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const selectedCustomer = (options.customers || []).find(
    (customer) => Number(customer.id) === Number(filters.partyId),
  );

  const openingRow = await knex("erp.gl_entry as ge")
    .leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
    .select(
      knex.raw(
        "COALESCE(SUM(COALESCE(ge.dr, 0) - COALESCE(ge.cr, 0)), 0) as opening_balance",
      ),
    )
    .where("ge.party_id", filters.partyId)
    .where(function whereApprovedOrManual() {
      this.whereNull("vh.id").orWhere("vh.status", "APPROVED");
    })
    .modify((queryBuilder) => {
      if (scopedBranchIds.length) {
        queryBuilder.whereIn("ge.branch_id", scopedBranchIds);
      }
      if (filters.from) {
        queryBuilder.where("ge.entry_date", "<", filters.from);
      }
    })
    .first();

  const qtyByVoucherSubquery = knex("erp.voucher_line as vl")
    .select("vl.voucher_header_id")
    .sum({ qty: knex.raw("COALESCE(vl.qty, 0)") })
    .whereIn("vl.line_kind", ["ITEM", "SKU"])
    .groupBy("vl.voucher_header_id")
    .as("vq");

  let detailsQuery = knex("erp.gl_entry as ge")
    .leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
    .leftJoin("erp.branches as b", "b.id", "ge.branch_id")
    .leftJoin(qtyByVoucherSubquery, "vq.voucher_header_id", "vh.id")
    .select(
      knex.raw("to_char(ge.entry_date, 'YYYY-MM-DD') as entry_date"),
      "vh.voucher_type_code",
      "vh.id as voucher_id",
      "vh.voucher_no",
      "vh.book_no as bill_number",
      "b.name as branch_name",
      knex.raw(
        "COALESCE(NULLIF(ge.narration, ''), NULLIF(vh.remarks, '')) as description",
      ),
      knex.raw("COALESCE(vq.qty, 0) as qty"),
      knex.raw("COALESCE(ge.dr, 0) as dr"),
      knex.raw("COALESCE(ge.cr, 0) as cr"),
      "ge.id",
    )
    .where("ge.party_id", filters.partyId)
    .where(function whereApprovedOrManual() {
      this.whereNull("vh.id").orWhere("vh.status", "APPROVED");
    })
    .where("ge.entry_date", ">=", filters.from)
    .where("ge.entry_date", "<=", filters.to)
    .orderBy("ge.entry_date", "asc")
    .orderBy("ge.id", "asc");

  if (scopedBranchIds.length) {
    detailsQuery = detailsQuery.whereIn("ge.branch_id", scopedBranchIds);
  }

  const rawRows = await detailsQuery;
  const voucherIds = [
    ...new Set(
      rawRows
        .map((row) => Number(row.voucher_id || 0))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  const voucherTypeByVoucherId = new Map(
    rawRows
      .map((row) => [
        Number(row.voucher_id || 0),
        String(row.voucher_type_code || "").toUpperCase(),
      ])
      .filter(([voucherId]) => Number.isInteger(voucherId) && voucherId > 0),
  );

  const salesVoucherExtraDiscountByVoucherId = new Map();
  if (voucherIds.length) {
    const salesHeaderRows = await knex("erp.sales_header")
      .select("voucher_id", "extra_discount")
      .whereIn("voucher_id", voucherIds);
    salesHeaderRows.forEach((row) => {
      const voucherId = Number(row.voucher_id || 0);
      if (!voucherId) return;
      salesVoucherExtraDiscountByVoucherId.set(
        voucherId,
        toAmount(row.extra_discount, 2),
      );
    });
  }

  const voucherLineSummaryByVoucherId = new Map();
  const voucherLineDetailsByVoucherId = new Map();
  if (voucherIds.length) {
    const voucherLines = await knex("erp.voucher_line as vl")
      .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
      .leftJoin("erp.variants as v", "v.id", "s.variant_id")
      .leftJoin("erp.items as i", "i.id", "v.item_id")
      .select(
        "vl.voucher_header_id",
        "vl.line_no",
        "vl.line_kind",
        "vl.qty",
        "vl.rate",
        "vl.amount",
        "vl.meta",
        "s.sku_code",
        "i.name as item_name",
      )
      .whereIn("vl.voucher_header_id", voucherIds)
      .whereIn("vl.line_kind", ["ITEM", "SKU"])
      .orderBy("vl.voucher_header_id", "asc")
      .orderBy("vl.line_no", "asc");

    const linesByVoucherId = new Map();
    voucherLines.forEach((line) => {
      const voucherId = Number(line.voucher_header_id || 0);
      if (!voucherId) return;
      const voucherType = String(voucherTypeByVoucherId.get(voucherId) || "");
      const name =
        String(line.item_name || "").trim() ||
        String(line.sku_code || "").trim() ||
        "Line";
      const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
      const qty = toQty(line.qty, 3);
      const rate = toAmount(line.rate, 2);
      const saleQty =
        meta.sale_qty !== undefined ? toQty(meta.sale_qty, 3) : qty;
      const pairRate =
        meta.pair_rate !== undefined ? toAmount(meta.pair_rate, 2) : rate;
      const pairDiscount =
        meta.pair_discount !== undefined ? toAmount(meta.pair_discount, 2) : 0;
      const lineTotal =
        meta.total_amount !== undefined
          ? Math.abs(toAmount(meta.total_amount, 2))
          : Math.abs(toAmount(line.amount, 2));
      const rawAmount = Math.abs(toAmount(line.amount, 2));
      const fallbackAmount = Math.abs(toAmount(qty * rate, 2));
      const weight =
        rawAmount > 0 ? rawAmount : fallbackAmount > 0 ? fallbackAmount : 1;
      const lineText =
        voucherType === "SALES_VOUCHER"
          ? `Article: ${name} | Qty: ${saleQty.toFixed(3)} | Pair Rate: ${pairRate.toFixed(2)} | Pair Discount: ${pairDiscount.toFixed(2)} | Line Total: ${lineTotal.toFixed(2)}`
          : `${name} x ${qty.toFixed(3)} @ ${rate.toFixed(2)}`;
      const list = linesByVoucherId.get(voucherId) || [];
      list.push({
        text: lineText,
        qty: voucherType === "SALES_VOUCHER" ? saleQty : qty,
        rate,
        weight:
          voucherType === "SALES_VOUCHER" && lineTotal > 0 ? lineTotal : weight,
        line_no: Number(line.line_no || 0),
      });
      linesByVoucherId.set(voucherId, list);
    });

    linesByVoucherId.forEach((list, voucherId) => {
      const voucherType = String(voucherTypeByVoucherId.get(voucherId) || "");
      const sorted = [...list].sort(
        (a, b) => Number(a.line_no || 0) - Number(b.line_no || 0),
      );
      const extraDiscount = toAmount(
        salesVoucherExtraDiscountByVoucherId.get(voucherId) || 0,
        2,
      );
      if (voucherType === "SALES_VOUCHER" && extraDiscount > 0) {
        sorted.push({
          text: `Extra Discount: ${extraDiscount.toFixed(2)}`,
          qty: 0,
          rate: 0,
          weight: extraDiscount,
          line_no: 999999,
        });
      }
      voucherLineDetailsByVoucherId.set(voucherId, sorted);
      const compact = sorted.slice(0, 4).map((line) => line.text);
      const suffix = sorted.length > 4 ? ` +${sorted.length - 4} more` : "";
      voucherLineSummaryByVoucherId.set(
        voucherId,
        `${compact.join("; ")}${suffix}`,
      );
    });
  }
  const openingBalance = toAmount(openingRow?.opening_balance || 0, 2);

  const baseEntries = rawRows.map((row) => {
    const voucherId = Number(row.voucher_id || 0) || null;
    const baseDescription = String(row.description || "").trim();
    const voucherType = String(row.voucher_type_code || "").toUpperCase();
    const description =
      voucherType === "SALES_ORDER"
        ? "Advance Payment Received"
        : baseDescription;

    return {
      id: Number(row.id || 0),
      entry_date: row.entry_date || null,
      voucher_id: voucherId,
      voucher_no: row.voucher_no || null,
      bill_number: row.bill_number || "",
      voucher_type: row.voucher_type_code || "",
      description: description || "",
      qty: voucherType === "SALES_ORDER" ? 0 : toQty(row.qty, 3),
      debit: toAmount(row.dr, 2),
      credit: toAmount(row.cr, 2),
      branch_name: row.branch_name || "",
    };
  });

  const allocateByWeight = ({ totalAmount, lines }) => {
    const safeTotal = toAmount(totalAmount, 2);
    if (!lines.length || safeTotal <= 0) return [];
    const totalWeight = lines.reduce(
      (sum, line) => sum + Number(line.weight || 0),
      0,
    );
    if (totalWeight <= 0) {
      const equal = toAmount(safeTotal / lines.length, 2);
      const allocations = lines.map((_, index) =>
        index === lines.length - 1
          ? toAmount(safeTotal - equal * (lines.length - 1), 2)
          : equal,
      );
      return allocations;
    }

    let allocated = 0;
    return lines.map((line, index) => {
      if (index === lines.length - 1) {
        return toAmount(safeTotal - allocated, 2);
      }
      const portion = toAmount(
        (safeTotal * Number(line.weight || 0)) / totalWeight,
        2,
      );
      allocated = toAmount(allocated + portion, 2);
      return portion;
    });
  };

  const detailEntries = baseEntries.flatMap((entry) => {
    const voucherId = Number(entry.voucher_id || 0) || null;
    const voucherLines = voucherId
      ? voucherLineDetailsByVoucherId.get(voucherId) || []
      : [];

    if (String(entry.voucher_type || "").toUpperCase() === "SALES_ORDER") {
      return [
        {
          ...entry,
          description: "Advance Payment Received",
          qty: 0,
        },
      ];
    }

    if (!voucherLines.length) {
      return [entry];
    }

    const drAllocations = allocateByWeight({
      totalAmount: entry.debit,
      lines: voucherLines,
    });
    const crAllocations = allocateByWeight({
      totalAmount: entry.credit,
      lines: voucherLines,
    });

    return voucherLines.map((line, index) => {
      const baseDescription = String(entry.description || "").trim();
      const lineDescription = String(line.text || "").trim();
      return {
        ...entry,
        id: Number(`${entry.id}${String(index + 1).padStart(2, "0")}`),
        description: baseDescription
          ? `${baseDescription} | ${lineDescription}`
          : lineDescription,
        qty: toQty(line.qty, 3),
        debit: entry.debit > 0 ? toAmount(drAllocations[index] || 0, 2) : 0,
        credit: entry.credit > 0 ? toAmount(crAllocations[index] || 0, 2) : 0,
      };
    });
  });

  const reportEntries =
    filters.ledgerView === "summary"
      ? (() => {
          const grouped = new Map();
          baseEntries.forEach((entry) => {
            const key = entry.voucher_no
              ? `V:${entry.voucher_type}:${entry.voucher_no}`
              : `G:${entry.id}`;
            const current = grouped.get(key);
            if (!current) {
              grouped.set(key, { ...entry });
              return;
            }
            current.qty = toQty(current.qty + entry.qty, 3);
            current.debit = toAmount(current.debit + entry.debit, 2);
            current.credit = toAmount(current.credit + entry.credit, 2);
            if (!current.description && entry.description) {
              current.description = entry.description;
            }
          });
          const summarized = [...grouped.values()].map((entry) => {
            const voucherType = String(entry.voucher_type || "").toUpperCase();
            if (voucherType === "SALES_ORDER") {
              return {
                ...entry,
                description: "Advance Payment Received",
                qty: 0,
              };
            }
            const voucherId = Number(entry.voucher_id || 0) || null;
            const voucherSummary = voucherId
              ? String(
                  voucherLineSummaryByVoucherId.get(voucherId) || "",
                ).trim()
              : "";
            if (!voucherSummary) return entry;
            const baseDescription = String(entry.description || "").trim();
            return {
              ...entry,
              description: baseDescription
                ? `${baseDescription} | ${voucherSummary}`
                : voucherSummary,
            };
          });

          return summarized.sort((a, b) => {
            const dateA = String(a.entry_date || "");
            const dateB = String(b.entry_date || "");
            if (dateA !== dateB) return dateA.localeCompare(dateB);
            const voucherA = Number(a.voucher_no || 0);
            const voucherB = Number(b.voucher_no || 0);
            if (voucherA !== voucherB) return voucherA - voucherB;
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
    runningBalance = toAmount(runningBalance + entry.debit - entry.credit, 2);

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
    customer: selectedCustomer || null,
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
    includeBranchColumn,
  };
};

const getCustomerLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseCustomerLedgerFilters({ req, input });
  const options = await loadCustomerLedgerOptions({ req, filters });
  const ledgerData = await getCustomerLedgerRows({ req, filters, options });

  return {
    filters,
    options,
    reportData: ledgerData,
  };
};

const loadCustomerBalanceOptions = async ({ req }) => {
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

const getCustomerBalanceRows = async ({ req, filters }) => {
  if (!filters.reportLoaded) return [];

  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const balanceSubquery = knex("erp.gl_entry as ge")
    .select("ge.party_id")
    .sum({ amount: knex.raw("COALESCE(ge.dr, 0) - COALESCE(ge.cr, 0)") })
    .where("ge.entry_date", "<=", filters.asOn)
    .modify((queryBuilder) => {
      if (scopedBranchIds.length) {
        queryBuilder.whereIn("ge.branch_id", scopedBranchIds);
      }
    })
    .groupBy("ge.party_id")
    .as("bal");

  let query = knex("erp.parties as p")
    .leftJoin(balanceSubquery, "bal.party_id", "p.id")
    .select(
      "p.id",
      "p.code",
      "p.name",
      "p.name_ur",
      knex.raw("COALESCE(bal.amount, 0) as amount"),
    )
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','BOTH')")
    .orderBy("p.name", "asc");

  if (scopedBranchIds.length) {
    query = applyPartyBranchScope(query, scopedBranchIds);
  }

  const rows = await query;
  return rows.map((row) => ({
    customer_id: Number(row.id || 0) || null,
    customer_code: row.code || "",
    customer_name: row.name || "",
    customer_name_ur: row.name_ur || "",
    amount: toAmount(row.amount, 2),
  }));
};

const getCustomerBalancesReportPageData = async ({ req, input = {} }) => {
  const filters = parseCustomerBalanceFilters({ req, input });
  const [options, rows] = await Promise.all([
    loadCustomerBalanceOptions({ req }),
    getCustomerBalanceRows({ req, filters }),
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

const parseSalesDiscountReportFilters = ({ req, input = {} }) => {
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
  const branchIds = req.user?.isAdmin
    ? branchIdsFromInput
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  const minDiscountRaw = Number(input.min_discount_amount);
  const minDiscountAmount =
    Number.isFinite(minDiscountRaw) && minDiscountRaw > 0
      ? toAmount(minDiscountRaw, 2)
      : 0;

  const highDiscountPctRaw = Number(input.high_discount_pct);
  const highDiscountPct =
    Number.isFinite(highDiscountPctRaw) && highDiscountPctRaw > 0
      ? Number(highDiscountPctRaw.toFixed(2))
      : 10;

  return {
    from,
    to,
    branchIds,
    salesmanId: toPositiveId(input.salesman_employee_id),
    partyId: toPositiveId(input.party_id),
    productGroupId: toPositiveId(input.product_group_id),
    minDiscountAmount,
    highDiscountPct,
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

const loadSalesDiscountReportOptions = async ({ req, filters }) => {
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

  let customersQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name", "p.name_ur")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','BOTH')")
    .orderBy("p.name", "asc");

  if (!req.user?.isAdmin || scopedBranchIds.length) {
    customersQuery = applyPartyBranchScope(customersQuery, scopedBranchIds);
  }

  let salesmenQuery = knex("erp.employees as e")
    .select("e.id", "e.code", "e.name")
    .whereRaw("lower(coalesce(e.status, '')) = 'active'")
    .orderBy("e.name", "asc");

  if (scopedBranchIds.length) {
    salesmenQuery = salesmenQuery.whereExists(function whereSalesmanBranch() {
      this.select(1)
        .from("erp.employee_branch as eb")
        .whereRaw("eb.employee_id = e.id")
        .whereIn("eb.branch_id", scopedBranchIds);
    });
  }

  const productGroups = await knex("erp.product_groups as pg")
    .select("pg.id", "pg.name")
    .where({ "pg.is_active": true })
    .whereExists(function whereGroupHasSalesSku() {
      this.select(1)
        .from("erp.items as i")
        .join("erp.variants as v", "v.item_id", "i.id")
        .join("erp.skus as s", "s.variant_id", "v.id")
        .whereRaw("i.group_id = pg.id")
        .andWhere("i.is_active", true)
        .andWhere("s.is_active", true);
    })
    .orderBy("pg.name", "asc");

  const [customers, salesmen] = await Promise.all([
    customersQuery,
    salesmenQuery,
  ]);

  return {
    branches,
    customers,
    salesmen,
    productGroups,
  };
};

const emptySalesDiscountReportData = ({ includeBranchColumn = false } = {}) => ({
  includeBranchColumn,
  kpis: {
    voucherCount: 0,
    discountedVoucherCount: 0,
    totalDozenQty: 0,
    totalExceededDiscountAmount: 0,
    grossSalesBeforeDiscount: 0,
    lineDiscountTotal: 0,
    extraDiscountTotal: 0,
    totalDiscount: 0,
    netSalesAfterDiscount: 0,
    discountPctOfGrossSales: 0,
    averagePairDiscount: 0,
    averageDozenDiscount: 0,
    policyBreachedVoucherCount: 0,
    policyExcessDiscountTotal: 0,
    highestDiscountVoucher: null,
  },
  trendRows: [],
  salesmanRows: [],
  customerRows: [],
  itemRows: [],
  alertRows: [],
  rows: [],
});

const getSalesDiscountReportData = async ({ req, filters }) => {
  const includeBranchColumn = Boolean(
    req.user?.isAdmin && filters.branchIds.length !== 1,
  );

  if (!filters.reportLoaded) {
    return emptySalesDiscountReportData({ includeBranchColumn });
  }

  const scopedBranchIds = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter(
        (id) => Number.isInteger(id) && id > 0,
      );

  let voucherQuery = knex("erp.voucher_header as vh")
    .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
    .leftJoin("erp.parties as p", "p.id", "sh.customer_party_id")
    .leftJoin("erp.employees as e", "e.id", "sh.salesman_employee_id")
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .select(
      "vh.id as voucher_id",
      "vh.voucher_no",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
      "vh.status as voucher_status",
      "vh.branch_id",
      "b.name as branch_name",
      "sh.sale_mode",
      "sh.payment_type",
      "sh.customer_party_id",
      "sh.customer_name as walk_in_customer_name",
      "p.name as customer_name_en",
      "p.name_ur as customer_name_ur",
      "sh.salesman_employee_id",
      "e.name as salesman_name",
      "sh.extra_discount",
    )
    .where({
      "vh.voucher_type_code": "SALES_VOUCHER",
    })
    .whereNot("vh.status", "REJECTED")
    .where("vh.voucher_date", ">=", filters.from)
    .where("vh.voucher_date", "<=", filters.to)
    .orderBy("vh.voucher_date", "asc")
    .orderBy("vh.voucher_no", "asc");

  if (scopedBranchIds.length) {
    voucherQuery = voucherQuery.whereIn("vh.branch_id", scopedBranchIds);
  }
  if (filters.salesmanId) {
    voucherQuery = voucherQuery.where(
      "sh.salesman_employee_id",
      filters.salesmanId,
    );
  }
  if (filters.partyId) {
    voucherQuery = voucherQuery.where("sh.customer_party_id", filters.partyId);
  }

  const vouchers = await voucherQuery;
  if (!vouchers.length) {
    return emptySalesDiscountReportData({ includeBranchColumn });
  }

  const voucherIds = vouchers.map((row) => Number(row.voucher_id || 0));
  const lineRows = await knex("erp.voucher_line as vl")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .select(
      "vl.voucher_header_id",
      "vl.line_no",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
      "i.group_id",
      "pg.name as group_name",
      "s.sku_code",
      "i.name as item_name",
    )
    .whereIn("vl.voucher_header_id", voucherIds)
    .where("vl.line_kind", "SKU")
    .orderBy("vl.voucher_header_id", "asc")
    .orderBy("vl.line_no", "asc");

  const discountPolicyByGroupId = await loadActiveSalesDiscountPolicyMapTx({
    trx: knex,
    productGroupIds: [
      ...new Set(
        lineRows
          .map((row) => Number(row.group_id || 0))
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ],
  });

  const linesByVoucherId = new Map();
  lineRows.forEach((row) => {
    const voucherId = Number(row.voucher_header_id || 0);
    if (!voucherId) return;
    const list = linesByVoucherId.get(voucherId) || [];
    list.push(row);
    linesByVoucherId.set(voucherId, list);
  });

  const voucherRows = vouchers
    .map((voucher) => {
      const voucherId = Number(voucher.voucher_id || 0);
      const extraDiscount = toAmount(voucher.extra_discount || 0, 2);
      const voucherLines = linesByVoucherId.get(voucherId) || [];

      let totalVoucherGross = 0;
      let grossSalesBeforeDiscount = 0;
      let lineDiscountTotal = 0;
      let totalQtyPairs = 0;
      let totalDozenQty = 0;
      const itemRows = [];
      const policyInputLines = [];
      const itemLabels = [];
      const seenItemLabels = new Set();

      voucherLines.forEach((line) => {
        const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
        const movementKind = String(meta.movement_kind || "SALE")
          .trim()
          .toUpperCase();
        if (movementKind !== "SALE") return;

        const qtyPairs = toQty(
          meta.total_pairs !== undefined ? meta.total_pairs : line.qty,
          3,
        );
        if (qtyPairs <= 0) return;

        const pairRate = toAmount(
          meta.pair_rate !== undefined ? meta.pair_rate : line.rate,
          2,
        );
        const pairDiscount = toAmount(meta.pair_discount, 2);
        const rowStatus = String(meta.row_status || "")
          .trim()
          .toUpperCase();
        const enteredSaleQty = toQty(meta.sale_qty || 0, 3);
        const lineGross = toAmount(qtyPairs * pairRate, 2);
        const lineDiscount = toAmount(qtyPairs * pairDiscount, 2);
        const lineNet = toAmount(lineGross - lineDiscount, 2);
        const lineGroupId = Number(line.group_id || 0) || null;
        const matchesProductGroup =
          !filters.productGroupId ||
          Number(filters.productGroupId || 0) === Number(lineGroupId || 0);
        const itemLabel =
          String(line.item_name || "").trim() ||
          String(line.sku_code || "").trim() ||
          `#${Number(line.line_no || 0) || 0}`;

        totalVoucherGross = toAmount(totalVoucherGross + lineGross, 2);
        if (!matchesProductGroup) return;

        grossSalesBeforeDiscount = toAmount(
          grossSalesBeforeDiscount + lineGross,
          2,
        );
        lineDiscountTotal = toAmount(lineDiscountTotal + lineDiscount, 2);
        totalQtyPairs = toQty(totalQtyPairs + qtyPairs, 3);
        if (rowStatus === "PACKED" && enteredSaleQty > 0) {
          totalDozenQty = toQty(totalDozenQty + enteredSaleQty, 3);
        }

        itemRows.push({
          item_label: itemLabel,
          group_name: String(line.group_name || "").trim(),
          qty_pairs: qtyPairs,
          dozen_qty:
            rowStatus === "PACKED" && enteredSaleQty > 0 ? enteredSaleQty : 0,
          gross_amount: lineGross,
          discount_amount: lineDiscount,
          net_amount: lineNet,
        });
        policyInputLines.push({
          lineNo: Number(line.line_no || 0) || itemRows.length,
          productGroupId: lineGroupId,
          productGroupName: String(line.group_name || "").trim(),
          qtyPairs,
          grossAmount: lineGross,
          pairDiscount,
        });

        if (!seenItemLabels.has(itemLabel)) {
          seenItemLabels.add(itemLabel);
          itemLabels.push(itemLabel);
        }
      });

      const allocatedExtraDiscount =
        filters.productGroupId && totalVoucherGross > 0
          ? toAmount(
              (Number(extraDiscount || 0) *
                Number(grossSalesBeforeDiscount || 0)) /
                Number(totalVoucherGross || 1),
              2,
            )
          : extraDiscount;
      const totalDiscount = toAmount(
        lineDiscountTotal + allocatedExtraDiscount,
        2,
      );
      const policyEvaluation = evaluateSalesDiscountPolicy({
        saleLines: policyInputLines,
        extraDiscount: allocatedExtraDiscount,
        policyByGroupId: discountPolicyByGroupId,
      });
      const netSalesAfterDiscount = toAmount(
        grossSalesBeforeDiscount - totalDiscount,
        2,
      );
      const discountPct = grossSalesBeforeDiscount
        ? Number(
            (
              (Number(totalDiscount || 0) / Number(grossSalesBeforeDiscount || 1)) *
              100
            ).toFixed(2),
          )
        : 0;

      return {
        voucher_id: voucherId,
        voucher_no: Number(voucher.voucher_no || 0) || null,
        voucher_date: voucher.voucher_date || null,
        voucher_status: String(voucher.voucher_status || "").trim().toUpperCase(),
        branch_id: Number(voucher.branch_id || 0) || null,
        branch_name: String(voucher.branch_name || "").trim(),
        sale_mode: String(voucher.sale_mode || "").trim().toUpperCase(),
        payment_type: String(voucher.payment_type || "").trim().toUpperCase(),
        customer_party_id: Number(voucher.customer_party_id || 0) || null,
        customer_name_en: String(voucher.customer_name_en || "").trim(),
        customer_name_ur: String(voucher.customer_name_ur || "").trim(),
        walk_in_customer_name: String(
          voucher.walk_in_customer_name || "",
        ).trim(),
        salesman_employee_id: Number(voucher.salesman_employee_id || 0) || null,
        salesman_name: String(voucher.salesman_name || "").trim(),
        total_dozen_qty: totalDozenQty,
        total_qty_pairs: totalQtyPairs,
        gross_sales_before_discount: grossSalesBeforeDiscount,
        line_discount_total: lineDiscountTotal,
        extra_discount: allocatedExtraDiscount,
        total_discount: totalDiscount,
        net_sales_after_discount: netSalesAfterDiscount,
        discount_pct: discountPct,
        policy_exceeded: policyEvaluation.hasViolation,
        policy_excess_discount_total: toAmount(
          policyEvaluation.totalExcessDiscount || 0,
          2,
        ),
        policy_violation_count: Number(policyEvaluation.violationCount || 0),
        policy_violation_groups: policyEvaluation.violatedGroups || [],
        policy_max_effective_pair_discount: Number(
          policyEvaluation.maxEffectivePairDiscount || 0,
        ),
        policy_max_allowed_pair_discount: Number(
          policyEvaluation.maxAllowedPairDiscount || 0,
        ),
        item_rows: itemRows,
        item_labels: itemLabels,
        item_summary: itemLabels.slice(0, 3).join(", "),
        action_link: `/vouchers/sales?voucher_no=${Number(voucher.voucher_no || 0)}&view=1`,
      };
    })
    .filter(
      (row) =>
        (!filters.productGroupId || Number(row.item_rows?.length || 0) > 0) &&
        Number(row.total_discount || 0) + 0.0001 >= filters.minDiscountAmount,
    );

  if (!voucherRows.length) {
    return emptySalesDiscountReportData({ includeBranchColumn });
  }

  const kpis = voucherRows.reduce(
    (acc, row) => {
      acc.voucherCount += 1;
      if (Number(row.total_discount || 0) > 0) acc.discountedVoucherCount += 1;
      acc.totalDozenQty = toQty(
        Number(acc.totalDozenQty || 0) + Number(row.total_dozen_qty || 0),
        3,
      );
      acc.totalQtyPairs = toQty(
        Number(acc.totalQtyPairs || 0) + Number(row.total_qty_pairs || 0),
        3,
      );
      acc.grossSalesBeforeDiscount = toAmount(
        acc.grossSalesBeforeDiscount + Number(row.gross_sales_before_discount || 0),
        2,
      );
      acc.lineDiscountTotal = toAmount(
        acc.lineDiscountTotal + Number(row.line_discount_total || 0),
        2,
      );
      acc.extraDiscountTotal = toAmount(
        acc.extraDiscountTotal + Number(row.extra_discount || 0),
        2,
      );
      acc.totalDiscount = toAmount(
        acc.totalDiscount + Number(row.total_discount || 0),
        2,
      );
      acc.netSalesAfterDiscount = toAmount(
        acc.netSalesAfterDiscount + Number(row.net_sales_after_discount || 0),
        2,
      );
      if (row.policy_exceeded) {
        acc.policyBreachedVoucherCount += 1;
      }
      acc.policyExcessDiscountTotal = toAmount(
        acc.policyExcessDiscountTotal +
          Number(row.policy_excess_discount_total || 0),
        2,
      );
      acc.totalExceededDiscountAmount = toAmount(
        acc.totalExceededDiscountAmount +
          Number(row.policy_excess_discount_total || 0),
        2,
      );
      if (
        !acc.highestDiscountVoucher ||
        Number(row.total_discount || 0) >
          Number(acc.highestDiscountVoucher.total_discount || 0)
      ) {
        acc.highestDiscountVoucher = row;
      }
      return acc;
    },
    {
      voucherCount: 0,
      discountedVoucherCount: 0,
      totalDozenQty: 0,
      totalExceededDiscountAmount: 0,
      totalQtyPairs: 0,
      grossSalesBeforeDiscount: 0,
      lineDiscountTotal: 0,
      extraDiscountTotal: 0,
      totalDiscount: 0,
      netSalesAfterDiscount: 0,
      policyBreachedVoucherCount: 0,
      policyExcessDiscountTotal: 0,
      highestDiscountVoucher: null,
    },
  );

  kpis.discountPctOfGrossSales = kpis.grossSalesBeforeDiscount
    ? Number(
        (
          (Number(kpis.totalDiscount || 0) /
            Number(kpis.grossSalesBeforeDiscount || 1)) *
          100
        ).toFixed(2),
      )
    : 0;
  kpis.averagePairDiscount = Number(kpis.totalQtyPairs || 0)
    ? toAmount(
        Number(kpis.lineDiscountTotal || 0) / Number(kpis.totalQtyPairs || 1),
        2,
      )
    : 0;
  kpis.averageDozenDiscount = toAmount(
    Number(kpis.averagePairDiscount || 0) * 12,
    2,
  );

  const trendMap = new Map();
  voucherRows.forEach((row) => {
    const dateKey = String(row.voucher_date || "");
    const current = trendMap.get(dateKey) || {
      voucher_date: dateKey,
      voucher_count: 0,
      gross_sales_before_discount: 0,
      total_discount: 0,
      net_sales_after_discount: 0,
    };
    current.voucher_count += 1;
    current.gross_sales_before_discount = toAmount(
      current.gross_sales_before_discount +
        Number(row.gross_sales_before_discount || 0),
      2,
    );
    current.total_discount = toAmount(
      current.total_discount + Number(row.total_discount || 0),
      2,
    );
    current.net_sales_after_discount = toAmount(
      current.net_sales_after_discount +
        Number(row.net_sales_after_discount || 0),
      2,
    );
    trendMap.set(dateKey, current);
  });

  const trendRows = [...trendMap.values()].sort((a, b) =>
    String(a.voucher_date || "").localeCompare(String(b.voucher_date || "")),
  );
  const maxTrendDiscount = Math.max(
    ...trendRows.map((row) => Number(row.total_discount || 0)),
    0,
  );
  trendRows.forEach((row) => {
    row.discount_pct = row.gross_sales_before_discount
      ? Number(
          (
            (Number(row.total_discount || 0) /
              Number(row.gross_sales_before_discount || 1)) *
            100
          ).toFixed(2),
        )
      : 0;
    row.bar_pct = maxTrendDiscount
      ? Number(
          (
            (Number(row.total_discount || 0) / Number(maxTrendDiscount || 1)) *
            100
          ).toFixed(2),
        )
      : 0;
  });

  const salesmanMap = new Map();
  const customerMap = new Map();
  const itemMap = new Map();

  voucherRows.forEach((row) => {
    const salesmanKey = Number(row.salesman_employee_id || 0) || 0;
    const salesmanEntry = salesmanMap.get(salesmanKey) || {
      salesman_employee_id: salesmanKey || null,
      salesman_name: String(row.salesman_name || "").trim(),
      total_dozen_qty: 0,
      total_qty_pairs: 0,
      gross_sales_before_discount: 0,
      total_discount: 0,
      net_sales_after_discount: 0,
    };
    salesmanEntry.total_dozen_qty = toQty(
      Number(salesmanEntry.total_dozen_qty || 0) +
        Number(row.total_dozen_qty || 0),
      3,
    );
    salesmanEntry.total_qty_pairs = toQty(
      Number(salesmanEntry.total_qty_pairs || 0) +
        Number(row.total_qty_pairs || 0),
      3,
    );
    salesmanEntry.gross_sales_before_discount = toAmount(
      salesmanEntry.gross_sales_before_discount +
        Number(row.gross_sales_before_discount || 0),
      2,
    );
    salesmanEntry.total_discount = toAmount(
      salesmanEntry.total_discount + Number(row.total_discount || 0),
      2,
    );
    salesmanEntry.net_sales_after_discount = toAmount(
      salesmanEntry.net_sales_after_discount +
        Number(row.net_sales_after_discount || 0),
      2,
    );
    salesmanMap.set(salesmanKey, salesmanEntry);

    const customerKey = row.customer_party_id
      ? `PTY:${Number(row.customer_party_id)}`
      : `WALKIN:${String(row.walk_in_customer_name || "").trim() || "-"}`;
    const customerEntry = customerMap.get(customerKey) || {
      customer_party_id: row.customer_party_id || null,
      customer_name_en: row.customer_name_en || "",
      customer_name_ur: row.customer_name_ur || "",
      walk_in_customer_name: row.walk_in_customer_name || "",
      total_dozen_qty: 0,
      total_qty_pairs: 0,
      gross_sales_before_discount: 0,
      total_discount: 0,
      net_sales_after_discount: 0,
    };
    customerEntry.total_dozen_qty = toQty(
      Number(customerEntry.total_dozen_qty || 0) +
        Number(row.total_dozen_qty || 0),
      3,
    );
    customerEntry.total_qty_pairs = toQty(
      Number(customerEntry.total_qty_pairs || 0) +
        Number(row.total_qty_pairs || 0),
      3,
    );
    customerEntry.gross_sales_before_discount = toAmount(
      customerEntry.gross_sales_before_discount +
        Number(row.gross_sales_before_discount || 0),
      2,
    );
    customerEntry.total_discount = toAmount(
      customerEntry.total_discount + Number(row.total_discount || 0),
      2,
    );
    customerEntry.net_sales_after_discount = toAmount(
      customerEntry.net_sales_after_discount +
        Number(row.net_sales_after_discount || 0),
      2,
    );
    customerMap.set(customerKey, customerEntry);

    (row.item_rows || []).forEach((itemRow) => {
      const itemKey = String(itemRow.item_label || "").trim() || "-";
      const itemEntry = itemMap.get(itemKey) || {
        item_label: itemKey,
        voucher_keys: new Set(),
        total_dozen_qty: 0,
        qty_pairs: 0,
        gross_amount: 0,
        discount_amount: 0,
        net_amount: 0,
      };
      itemEntry.voucher_keys.add(String(row.voucher_id || ""));
      itemEntry.qty_pairs = toQty(
        itemEntry.qty_pairs + Number(itemRow.qty_pairs || 0),
        3,
      );
      itemEntry.total_dozen_qty = toQty(
        Number(itemEntry.total_dozen_qty || 0) + Number(itemRow.dozen_qty || 0),
        3,
      );
      itemEntry.gross_amount = toAmount(
        itemEntry.gross_amount + Number(itemRow.gross_amount || 0),
        2,
      );
      itemEntry.discount_amount = toAmount(
        itemEntry.discount_amount + Number(itemRow.discount_amount || 0),
        2,
      );
      itemEntry.net_amount = toAmount(
        itemEntry.net_amount + Number(itemRow.net_amount || 0),
        2,
      );
      itemMap.set(itemKey, itemEntry);
    });
  });

  const enrichDiscountRow = (row) => ({
    ...row,
    discount_pct: row.gross_sales_before_discount
      ? Number(
          (
            (Number(row.total_discount || 0) /
              Number(row.gross_sales_before_discount || 1)) *
            100
          ).toFixed(2),
        )
      : 0,
    average_pair_discount: Number(row.total_qty_pairs || 0)
      ? toAmount(
          Number(row.total_discount || 0) / Number(row.total_qty_pairs || 1),
          2,
        )
      : 0,
    average_dozen_discount: Number(row.total_qty_pairs || 0)
      ? toAmount(
          (Number(row.total_discount || 0) / Number(row.total_qty_pairs || 1)) *
            12,
          2,
        )
      : 0,
  });

  const salesmanRows = [...salesmanMap.values()]
    .map(enrichDiscountRow)
    .sort((a, b) => Number(b.total_discount || 0) - Number(a.total_discount || 0))
    .slice(0, 10);

  const customerRows = [...customerMap.values()]
    .map(enrichDiscountRow)
    .sort((a, b) => Number(b.total_discount || 0) - Number(a.total_discount || 0))
    .slice(0, 10);

  const itemRows = [...itemMap.values()]
    .map((row) => ({
      item_label: row.item_label,
      total_dozen_qty: row.total_dozen_qty,
      qty_pairs: row.qty_pairs,
      gross_amount: row.gross_amount,
      total_discount: row.discount_amount,
      net_amount: row.net_amount,
      average_pair_discount: row.qty_pairs
        ? toAmount(
            Number(row.discount_amount || 0) / Number(row.qty_pairs || 1),
            2,
          )
        : 0,
      average_dozen_discount: row.qty_pairs
        ? toAmount(
            (Number(row.discount_amount || 0) / Number(row.qty_pairs || 1)) * 12,
            2,
          )
        : 0,
      discount_pct: row.gross_amount
        ? Number(
            (
              (Number(row.discount_amount || 0) /
                Number(row.gross_amount || 1)) *
              100
            ).toFixed(2),
          )
        : 0,
    }))
    .sort((a, b) => Number(b.total_discount || 0) - Number(a.total_discount || 0))
    .slice(0, 10);

  const alertRows = [...voucherRows]
    .filter(
      (row) =>
        row.policy_exceeded ||
        Number(row.discount_pct || 0) + 0.0001 >= filters.highDiscountPct,
    )
    .sort((a, b) => Number(b.total_discount || 0) - Number(a.total_discount || 0))
    .slice(0, 15);

  const rows = [...voucherRows].sort((a, b) => {
    const dateCompare = String(a.voucher_date || "").localeCompare(
      String(b.voucher_date || ""),
    );
    if (dateCompare !== 0) return dateCompare;
    return Number(a.voucher_no || 0) - Number(b.voucher_no || 0);
  });

  return {
    includeBranchColumn,
    kpis,
    trendRows,
    salesmanRows,
    customerRows,
    itemRows,
    alertRows,
    rows,
  };
};

const getSalesDiscountReportPageData = async ({ req, input = {} }) => {
  const filters = parseSalesDiscountReportFilters({ req, input });
  const [options, reportData] = await Promise.all([
    loadSalesDiscountReportOptions({ req, filters }),
    getSalesDiscountReportData({ req, filters }),
  ]);

  return {
    filters,
    options,
    reportData,
  };
};

const normalizePhoneForAnalysis = (value) =>
  String(value || "")
    .replace(/[^0-9]/g, "")
    .trim();

const normalizeContactNameForAnalysis = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();

const parseCustomerContactAnalysisFilters = ({ req, input = {} }) => {
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 89);

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

  const branchId = req.user?.isAdmin
    ? toPositiveId(input.branch_id)
    : Number(req.branchId || 0) || null;

  return {
    from,
    to,
    branchId,
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

const loadCustomerContactAnalysisOptions = async ({ req, filters }) => {
  const branches = req.user?.isAdmin
    ? await knex("erp.branches")
        .select("id", "name")
        .where({ is_active: true })
        .orderBy("name", "asc")
    : (req.branchOptions || []).map((row) => ({
        id: Number(row.id || 0),
        name: String(row.name || "").trim(),
      }));

  return {
    branches,
    branchId: filters.branchId,
  };
};

const getCustomerContactAnalysisPageData = async ({ req, input = {} }) => {
  const filters = parseCustomerContactAnalysisFilters({ req, input });
  const options = await loadCustomerContactAnalysisOptions({ req, filters });

  if (!filters.reportLoaded) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        totals: {
          contactCount: 0,
          voucherCount: 0,
          totalBillAmount: 0,
          highestBill: 0,
        },
      },
    };
  }

  const scopedBranchIds = req.user?.isAdmin
    ? [Number(filters.branchId || 0)].filter((id) => id > 0)
    : [Number(req.branchId || 0)].filter((id) => id > 0);

  let voucherQuery = knex("erp.voucher_header as vh")
    .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
    .leftJoin("erp.parties as p", "p.id", "sh.customer_party_id")
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .select(
      "vh.id as voucher_id",
      "vh.voucher_no",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
      "vh.book_no as bill_number",
      "vh.branch_id",
      "b.name as branch_name",
      "vh.status as voucher_status",
      "sh.payment_type",
      "sh.customer_party_id",
      "sh.customer_name as walk_in_customer_name",
      "sh.customer_phone_number",
      "p.name as customer_name_en",
      "p.name_ur as customer_name_ur",
      "p.phone1 as party_phone1",
      "p.phone2 as party_phone2",
    )
    .where("vh.voucher_type_code", "SALES_VOUCHER")
    .whereNot("vh.status", "REJECTED")
    .where("vh.voucher_date", ">=", filters.from)
    .where("vh.voucher_date", "<=", filters.to);

  let lineQuery = knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .select(
      "vl.voucher_header_id as voucher_id",
      "vl.amount",
      "vl.meta",
      "pg.name as group_name",
    )
    .where("vh.voucher_type_code", "SALES_VOUCHER")
    .whereNot("vh.status", "REJECTED")
    .where("vl.line_kind", "SKU")
    .where("vh.voucher_date", ">=", filters.from)
    .where("vh.voucher_date", "<=", filters.to);

  if (scopedBranchIds.length) {
    voucherQuery = voucherQuery.whereIn("vh.branch_id", scopedBranchIds);
    lineQuery = lineQuery.whereIn("vh.branch_id", scopedBranchIds);
  }

  const [voucherRows, lineRows] = await Promise.all([voucherQuery, lineQuery]);

  const voucherLineSummary = new Map();
  lineRows.forEach((line) => {
    const voucherId = Number(line.voucher_id || 0) || null;
    if (!voucherId) return;
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    const movementKind =
      String(meta.movement_kind || "SALE").trim().toUpperCase() === "RETURN"
        ? "RETURN"
        : "SALE";
    const sign = movementKind === "RETURN" ? -1 : 1;
    const lineAmount = toAmount(
      sign * (meta.total_amount !== undefined ? meta.total_amount : line.amount || 0),
      2,
    );
    const groupName = String(line.group_name || "").trim();

    const existing = voucherLineSummary.get(voucherId) || {
      netAmount: 0,
      groupSpend: new Map(),
      productGroups: new Set(),
    };

    existing.netAmount = toAmount(existing.netAmount + lineAmount, 2);
    if (groupName) {
      existing.productGroups.add(groupName);
      existing.groupSpend.set(
        groupName,
        toAmount(Number(existing.groupSpend.get(groupName) || 0) + lineAmount, 2),
      );
    }
    voucherLineSummary.set(voucherId, existing);
  });

  const contactMap = new Map();

  voucherRows.forEach((row) => {
    const voucherId = Number(row.voucher_id || 0) || null;
    if (!voucherId) return;

    const rawPhone =
      String(row.customer_phone_number || "").trim() ||
      String(row.party_phone1 || "").trim() ||
      String(row.party_phone2 || "").trim();
    const phoneKey = normalizePhoneForAnalysis(rawPhone);
    if (!phoneKey) return;

    const lineSummary = voucherLineSummary.get(voucherId) || {
      netAmount: 0,
      groupSpend: new Map(),
      productGroups: new Set(),
    };
    const voucherNetAmount = toAmount(lineSummary.netAmount || 0, 2);
    const partyName =
      String(row.customer_name_en || "").trim() ||
      String(row.customer_name_ur || "").trim();
    const displayName =
      partyName || String(row.walk_in_customer_name || "").trim() || "-";
    const contactKey = row.customer_party_id
      ? `PTY:${Number(row.customer_party_id || 0)}`
      : `CASH:${normalizeContactNameForAnalysis(displayName) || "WALKIN"}:${phoneKey}`;
    const voucherDate = String(row.voucher_date || "").trim();
    const paymentType = String(row.payment_type || "").trim().toUpperCase();
    const orderedGroups = [...lineSummary.groupSpend.entries()]
      .sort((a, b) => {
        const amountCompare = Number(b[1] || 0) - Number(a[1] || 0);
        if (Math.abs(amountCompare) > 0.0001) return amountCompare;
        return String(a[0] || "").localeCompare(String(b[0] || ""));
      })
      .map(([groupName]) => String(groupName || "").trim())
      .filter(Boolean);

    let contact = contactMap.get(phoneKey);
    if (!contact) {
      contact = {
        phone_key: phoneKey,
        contacts: new Map(),
        voucher_count: 0,
        total_bill_amount: 0,
        highest_bill: null,
        last_purchase_date: "",
        product_group_spend: new Map(),
        invoices: [],
      };
      contactMap.set(phoneKey, contact);
    }

    let contactEntry = contact.contacts.get(contactKey);
    if (!contactEntry) {
      contactEntry = {
        contact_key: contactKey,
        display_name: displayName,
        display_phone: rawPhone || phoneKey,
        cumulative_bill_amount: 0,
        last_purchase_date: "",
      };
      contact.contacts.set(contactKey, contactEntry);
    }

    contactEntry.cumulative_bill_amount = toAmount(
      Number(contactEntry.cumulative_bill_amount || 0) + Number(voucherNetAmount || 0),
      2,
    );
    if (
      !contactEntry.last_purchase_date ||
      voucherDate.localeCompare(contactEntry.last_purchase_date) > 0
    ) {
      contactEntry.last_purchase_date = voucherDate;
    }

    contact.voucher_count += 1;
    contact.total_bill_amount = toAmount(
      Number(contact.total_bill_amount || 0) + Number(voucherNetAmount || 0),
      2,
    );
    if (
      contact.highest_bill === null ||
      Number(voucherNetAmount || 0) > Number(contact.highest_bill || 0)
    ) {
      contact.highest_bill = voucherNetAmount;
    }
    if (!contact.last_purchase_date || voucherDate.localeCompare(contact.last_purchase_date) > 0) {
      contact.last_purchase_date = voucherDate;
    }

    lineSummary.groupSpend.forEach((amount, groupName) => {
      contact.product_group_spend.set(
        groupName,
        toAmount(
          Number(contact.product_group_spend.get(groupName) || 0) + Number(amount || 0),
          2,
        ),
      );
    });

    contact.invoices.push({
      voucher_id: voucherId,
      voucher_no: Number(row.voucher_no || 0) || null,
      voucher_date: voucherDate,
      bill_number: String(row.bill_number || "").trim(),
      branch_name: String(row.branch_name || "").trim(),
      customer_name: displayName,
      payment_type: paymentType,
      voucher_status: String(row.voucher_status || "").trim().toUpperCase(),
      bill_amount: voucherNetAmount,
      product_groups: orderedGroups,
      action_link: `/vouchers/sales?voucher_no=${Number(row.voucher_no || 0)}&view=1`,
    });
  });

  const rows = [...contactMap.values()]
    .map((contact) => {
      const primaryContact = [...contact.contacts.values()].sort((a, b) => {
        const amountCompare =
          Number(b.cumulative_bill_amount || 0) - Number(a.cumulative_bill_amount || 0);
        if (Math.abs(amountCompare) > 0.0001) return amountCompare;
        const dateCompare = String(b.last_purchase_date || "").localeCompare(
          String(a.last_purchase_date || ""),
        );
        if (dateCompare !== 0) return dateCompare;
        return String(a.display_name || "").localeCompare(String(b.display_name || ""));
      })[0] || {
        display_name: "-",
        display_phone: contact.phone_key,
      };

      const productGroups = [...contact.product_group_spend.entries()]
        .sort((a, b) => {
          const amountCompare = Number(b[1] || 0) - Number(a[1] || 0);
          if (Math.abs(amountCompare) > 0.0001) return amountCompare;
          return String(a[0] || "").localeCompare(String(b[0] || ""));
        })
        .map(([groupName]) => String(groupName || "").trim())
        .filter(Boolean);

      const invoices = [...contact.invoices].sort((a, b) => {
        const dateCompare = String(b.voucher_date || "").localeCompare(
          String(a.voucher_date || ""),
        );
        if (dateCompare !== 0) return dateCompare;
        return Number(b.voucher_no || 0) - Number(a.voucher_no || 0);
      });

      return {
        phone_key: contact.phone_key,
        phone_number: primaryContact.display_phone || contact.phone_key,
        primary_customer_name: primaryContact.display_name || "-",
        total_bill_amount: toAmount(contact.total_bill_amount, 2),
        highest_bill: toAmount(contact.highest_bill || 0, 2),
        bill_count: Number(contact.voucher_count || 0),
        last_purchase_date: contact.last_purchase_date || "",
        product_groups_bought: productGroups,
        invoices,
      };
    })
    .sort((a, b) => {
      const totalCompare =
        Number(b.total_bill_amount || 0) - Number(a.total_bill_amount || 0);
      if (Math.abs(totalCompare) > 0.0001) return totalCompare;
      const billCompare = Number(b.bill_count || 0) - Number(a.bill_count || 0);
      if (billCompare !== 0) return billCompare;
      return String(a.primary_customer_name || "").localeCompare(
        String(b.primary_customer_name || ""),
      );
    });

  return {
    filters,
    options,
    reportData: {
      rows,
      totals: {
        contactCount: rows.length,
        voucherCount: rows.reduce(
          (sum, row) => sum + Number(row.bill_count || 0),
          0,
        ),
        totalBillAmount: toAmount(
          rows.reduce((sum, row) => sum + Number(row.total_bill_amount || 0), 0),
          2,
        ),
        highestBill: toAmount(
          rows.reduce(
            (max, row) =>
              Math.max(Number(max || 0), Number(row.highest_bill || 0)),
            0,
          ),
          2,
        ),
      },
    },
  };
};

const getCustomerListingsRows = async ({ req }) => {
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
      knex.raw(`(SELECT COALESCE(string_agg(b.name, ', ' ORDER BY b.name), '')
        FROM erp.party_branch pb
        JOIN erp.branches b ON b.id = pb.branch_id
        WHERE pb.party_id = p.id) as branch_names`),
    )
    .where({ "p.is_active": true, "p.party_type": "CUSTOMER" })
    .orderBy("p.id", "desc");

  if (!req.user?.isAdmin && Number(req.branchId || 0) > 0) {
    query = query.whereExists(function whereCustomerBranch() {
      this.select(1)
        .from("erp.party_branch as pb")
        .whereRaw("pb.party_id = p.id")
        .andWhere("pb.branch_id", Number(req.branchId));
    });
  }

  return query;
};

module.exports = {
  getCustomerListingsRows,
  getCustomerLedgerReportPageData,
  getCustomerBalancesReportPageData,
  getSalesOrderReportPageData,
  getSalesReportPageData,
  getSaleReturnReportPageData,
  getSalesDiscountReportPageData,
  getCustomerContactAnalysisPageData,
};
