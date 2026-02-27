"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const {
  REPORT_ORDER_TYPES,
  REPORT_TYPES,
  resolveReportOrderType,
  resolveReportType,
  toIdList,
  toBoolean,
} = require("../../utils/report-filter-types");

const PURCHASE_TYPE_FILTERS = Object.freeze({
  all: "all",
  cash: "cash",
  credit: "credit",
});

const ALL_MULTI_FILTER_VALUE = "__ALL__";

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
  )
    return null;
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

const resolvePurchaseTypeFilter = (
  value,
  fallback = PURCHASE_TYPE_FILTERS.all,
) => {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (key === PURCHASE_TYPE_FILTERS.cash) return PURCHASE_TYPE_FILTERS.cash;
  if (key === PURCHASE_TYPE_FILTERS.credit) return PURCHASE_TYPE_FILTERS.credit;
  if (key === PURCHASE_TYPE_FILTERS.all) return PURCHASE_TYPE_FILTERS.all;
  return fallback;
};

const toIdListWithAll = (value) => {
  const raw = Array.isArray(value) ? value : [value];
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

const toIdListWithAllFromSources = (...sources) => {
  const merged = [];
  sources.forEach((source) => {
    if (Array.isArray(source)) merged.push(...source);
    else merged.push(source);
  });
  return toIdListWithAll(merged);
};

const parseFilters = ({ req, input = {} }) => {
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

  const selectedBranchIds = toIdListWithAll(input.branch_ids);
  const branchIds = req.user?.isAdmin
    ? selectedBranchIds
    : [Number(req.branchId || 0)].filter((id) => id > 0);

  const orderBy = resolveReportOrderType(
    input.order_by,
    REPORT_ORDER_TYPES.party,
  );
  const reportType = resolveReportType(input.report_type, REPORT_TYPES.details);
  const purchaseType = resolvePurchaseTypeFilter(
    input.purchase_type,
    PURCHASE_TYPE_FILTERS.all,
  );
  const cashAccountId =
    purchaseType === PURCHASE_TYPE_FILTERS.cash
      ? toPositiveId(input.cash_paid_account_id)
      : null;
  const groupIds = toIdListWithAllFromSources(
    input.raw_material_group_ids,
    input.raw_material_group_id,
  );
  const subgroupIds = toIdListWithAllFromSources(
    input.raw_material_subgroup_ids,
    input.raw_material_subgroup_id,
  );

  return {
    from,
    to,
    branchIds,
    orderBy,
    reportType,
    purchaseType,
    cashAccountId,
    groupIds,
    subgroupIds,
    groupId: groupIds[0] || null,
    subgroupId: subgroupIds[0] || null,
    partyIds: toIdListWithAll(input.party_ids),
    rawMaterialIds: toIdListWithAll(input.raw_material_ids),
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

const applyPartyBranchScope = (query, branchIds = []) => {
  if (!branchIds.length) return query;
  return query.where(function whereSupplierBranchScope() {
    this.whereIn("p.branch_id", branchIds).orWhereExists(
      function whereSupplierBranchMap() {
        this.select(1)
          .from("erp.party_branch as pb")
          .whereRaw("pb.party_id = p.id")
          .whereIn("pb.branch_id", branchIds);
      },
    );
  });
};

const loadReportFilterOptions = async ({ req, filters }) => {
  const branchScope = req.user?.isAdmin
    ? filters.branchIds
    : [Number(req.branchId || 0)].filter((id) => id > 0);

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

  let suppliersQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','BOTH')");

  if (!req.user?.isAdmin || branchScope.length) {
    suppliersQuery = applyPartyBranchScope(
      suppliersQuery,
      branchScope.length ? branchScope : [Number(req.branchId || 0)],
    );
  }

  let cashAccountsQuery = knex("erp.accounts as a")
    .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
    .select("a.id", "a.code", "a.name")
    .where({ "a.is_active": true })
    .whereRaw("lower(coalesce(apc.code, '')) in ('cash','bank')");

  if (!req.user?.isAdmin || branchScope.length) {
    const scopedBranches = branchScope.length
      ? branchScope
      : [Number(req.branchId || 0)];
    cashAccountsQuery = cashAccountsQuery.whereExists(
      function whereAccountBranchScope() {
        this.select(1)
          .from("erp.account_branch as ab")
          .whereRaw("ab.account_id = a.id")
          .whereIn("ab.branch_id", scopedBranches);
      },
    );
  }

  const [branches, suppliers, rawMaterials, groups, subgroups, cashAccounts] =
    await Promise.all([
      branchesPromise,
      suppliersQuery.orderBy("p.name", "asc"),
      knex("erp.items as i")
        .select("i.id", "i.code", "i.name", "i.group_id", "i.subgroup_id")
        .where({ "i.is_active": true })
        .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
        .orderBy("i.name", "asc"),
      knex("erp.product_groups as g")
        .select("g.id", "g.name")
        .where({ "g.is_active": true })
        .whereExists(function whereGroupHasRawMaterial() {
          this.select(1)
            .from("erp.items as i")
            .whereRaw("i.group_id = g.id")
            .andWhere("i.is_active", true)
            .andWhereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'");
        })
        .orderBy("g.name", "asc"),
      knex("erp.product_subgroups as sg")
        .select("sg.id", "sg.name", "sg.group_id")
        .where({ "sg.is_active": true })
        .modify((qb) => {
          if (Array.isArray(filters.groupIds) && filters.groupIds.length) {
            qb.whereIn("sg.group_id", filters.groupIds);
          }
        })
        .whereExists(function whereSubgroupHasRawMaterial() {
          this.select(1)
            .from("erp.items as i")
            .whereRaw("i.subgroup_id = sg.id")
            .andWhere("i.is_active", true)
            .andWhereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'");
        })
        .orderBy("sg.name", "asc"),
      cashAccountsQuery.orderBy("a.name", "asc"),
    ]);

  return {
    branches,
    suppliers,
    rawMaterials,
    groups,
    subgroups,
    cashAccounts,
  };
};

const getPurchaseReportRows = async ({ req, filters }) => {
  if (!filters.reportLoaded) return [];

  let query = knex("erp.voucher_header as vh")
    .join("erp.purchase_invoice_header_ext as pie", "pie.voucher_id", "vh.id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.parties as p", "p.id", "pie.supplier_party_id")
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .leftJoin("erp.accounts as a", "a.id", "pie.cash_paid_account_id")
    .select(
      "vh.id as voucher_id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.book_no as bill_number",
      knex.raw("COALESCE(NULLIF(vh.remarks, ''), '') as remarks"),
      "vh.branch_id",
      "b.name as branch_name",
      "pie.supplier_party_id",
      "p.name as supplier_name",
      "pie.payment_type",
      "pie.cash_paid_account_id",
      "a.name as cash_account_name",
      "vl.line_no",
      "vl.item_id",
      "i.code as item_code",
      "i.name as item_name",
      "i.group_id",
      "i.subgroup_id",
      "vl.qty",
      "vl.rate",
      "vl.amount",
    )
    .where({
      "vh.voucher_type_code": "PI",
      "vh.status": "APPROVED",
      "vl.line_kind": "ITEM",
    })
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
    .where("vh.voucher_date", ">=", filters.from)
    .where("vh.voucher_date", "<=", filters.to);

  if (req.user?.isAdmin) {
    if (filters.branchIds.length) {
      query = query.whereIn("vh.branch_id", filters.branchIds);
    }
  } else {
    query = query.where("vh.branch_id", req.branchId);
  }

  if (filters.partyIds.length)
    query = query.whereIn("pie.supplier_party_id", filters.partyIds);
  if (filters.rawMaterialIds.length)
    query = query.whereIn("vl.item_id", filters.rawMaterialIds);
  if (Array.isArray(filters.groupIds) && filters.groupIds.length)
    query = query.whereIn("i.group_id", filters.groupIds);
  if (Array.isArray(filters.subgroupIds) && filters.subgroupIds.length)
    query = query.whereIn("i.subgroup_id", filters.subgroupIds);

  if (filters.purchaseType === PURCHASE_TYPE_FILTERS.cash) {
    query = query.whereRaw(
      "upper(coalesce(pie.payment_type::text, '')) = 'CASH'",
    );
    if (filters.cashAccountId)
      query = query.andWhere("pie.cash_paid_account_id", filters.cashAccountId);
  } else if (filters.purchaseType === PURCHASE_TYPE_FILTERS.credit) {
    query = query.whereRaw(
      "upper(coalesce(pie.payment_type::text, '')) = 'CREDIT'",
    );
  }

  if (filters.orderBy === REPORT_ORDER_TYPES.party) {
    query = query
      .orderByRaw("coalesce(p.name, '') asc")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  } else if (filters.orderBy === REPORT_ORDER_TYPES.invoice) {
    query = query
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  } else {
    query = query
      .orderByRaw("coalesce(i.name, '') asc")
      .orderBy("vh.voucher_date", "asc")
      .orderBy("vh.voucher_no", "asc")
      .orderBy("vl.line_no", "asc");
  }

  const rows = await query;
  return rows.map((row) => ({
    voucher_id: Number(row.voucher_id),
    voucher_no: Number(row.voucher_no),
    voucher_date: toLocalDateOnly(row.voucher_date),
    bill_number: row.bill_number || "",
    remarks: row.remarks || "",
    branch_id: Number(row.branch_id || 0) || null,
    branch_name: row.branch_name || "",
    supplier_party_id: Number(row.supplier_party_id || 0) || null,
    supplier_name: row.supplier_name || "",
    payment_type: String(row.payment_type || "").toUpperCase(),
    cash_paid_account_id: Number(row.cash_paid_account_id || 0) || null,
    cash_account_name: row.cash_account_name || "",
    line_no: Number(row.line_no || 0) || 1,
    item_id: Number(row.item_id || 0) || null,
    item_code: row.item_code || "",
    item_name: row.item_name || "",
    group_id: Number(row.group_id || 0) || null,
    subgroup_id: Number(row.subgroup_id || 0) || null,
    qty: toQty(row.qty),
    rate: toAmount(row.rate, 4),
    amount: toAmount(row.amount, 2),
  }));
};

const getGroupIdentity = (row, orderBy) => {
  if (orderBy === REPORT_ORDER_TYPES.invoice) {
    const key = `INV:${Number(row.voucher_id || 0)}`;
    return {
      key,
      label: `#${Number(row.voucher_no || 0)} | ${row.voucher_date || "-"} | ${row.supplier_name || "-"}`,
      voucher_no: Number(row.voucher_no || 0) || null,
      voucher_date: row.voucher_date || "",
      bill_number: row.bill_number || "",
      remarks: row.remarks || "",
      supplier_name: row.supplier_name || "",
      item_name: "",
      item_code: "",
    };
  }

  if (orderBy === REPORT_ORDER_TYPES.product) {
    const key = `RM:${Number(row.item_id || 0)}`;
    const label = row.item_code
      ? `${row.item_code} - ${row.item_name || ""}`
      : row.item_name || "-";
    return {
      key,
      label,
      voucher_no: null,
      voucher_date: "",
      bill_number: "",
      remarks: "",
      supplier_name: "",
      item_name: row.item_name || "",
      item_code: row.item_code || "",
    };
  }

  const key = `PTY:${Number(row.supplier_party_id || 0)}`;
  return {
    key,
    label: row.supplier_name || "-",
    voucher_no: null,
    voucher_date: "",
    bill_number: "",
    remarks: "",
    supplier_name: row.supplier_name || "",
    item_name: "",
    item_code: "",
  };
};

const buildReportData = ({ rows, filters }) => {
  const groups = [];
  const groupMap = new Map();

  rows.forEach((row) => {
    const identity = getGroupIdentity(row, filters.orderBy);
    let group = groupMap.get(identity.key);
    if (!group) {
      group = {
        key: identity.key,
        label: identity.label,
        voucher_no: identity.voucher_no,
        voucher_date: identity.voucher_date,
        bill_number: identity.bill_number,
        remarks: identity.remarks,
        supplier_name: identity.supplier_name,
        item_name: identity.item_name,
        item_code: identity.item_code,
        total_qty: 0,
        total_amount: 0,
        lines: [],
      };
      groups.push(group);
      groupMap.set(identity.key, group);
    }

    group.total_qty = toQty(group.total_qty + row.qty);
    group.total_amount = toAmount(group.total_amount + row.amount);
    if (filters.reportType === REPORT_TYPES.details) {
      group.lines.push(row);
    }
  });

  const summaryRows = groups.map((group) => ({
    group_label: group.label,
    voucher_no: group.voucher_no,
    voucher_date: group.voucher_date,
    bill_number: group.bill_number,
    remarks: group.remarks,
    supplier_name: group.supplier_name,
    item_name: group.item_name,
    item_code: group.item_code,
    total_qty: toQty(group.total_qty),
    avg_rate:
      group.total_qty > 0
        ? toAmount(group.total_amount / group.total_qty, 4)
        : 0,
    total_amount: toAmount(group.total_amount),
  }));

  const grandTotalQty = toQty(
    groups.reduce((sum, group) => sum + Number(group.total_qty || 0), 0),
  );
  const grandTotalAmount = toAmount(
    groups.reduce((sum, group) => sum + Number(group.total_amount || 0), 0),
  );

  return {
    groups,
    summaryRows,
    grandTotalQty,
    grandTotalAmount,
    rowCount: rows.length,
    groupCount: groups.length,
  };
};

const getPurchaseReportPageData = async ({ req, input = {} }) => {
  try {
    const filters = parseFilters({ req, input });
    const [options, rows] = await Promise.all([
      loadReportFilterOptions({ req, filters }),
      getPurchaseReportRows({ req, filters }),
    ]);
    const reportData = buildReportData({ rows, filters });

    return {
      filters,
      options,
      reportData,
    };
  } catch (err) {
    console.error("Error in PurchaseReportDataService:", err);
    throw err;
  }
};

const parseSupplierBalanceFilters = ({ req, input = {} }) => {
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

const parseSupplierLedgerFilters = ({ req, input = {} }) => {
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

  return {
    from,
    to,
    partyId: toPositiveId(input.party_id),
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

const loadSupplierLedgerOptions = async ({ req, filters }) => {
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

  let suppliersQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name", "p.name_ur")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','BOTH')");

  if (!req.user?.isAdmin || scopedBranchIds.length) {
    suppliersQuery = applyPartyBranchScope(suppliersQuery, scopedBranchIds);
  }

  const suppliers = await suppliersQuery.orderBy("p.name", "asc");

  return {
    branches,
    suppliers,
  };
};

const getSupplierLedgerRows = async ({ req, filters, options }) => {
  const includeBranchColumn = Boolean(
    req.user?.isAdmin && filters.branchIds.length !== 1,
  );

  if (!filters.reportLoaded || !filters.partyId) {
    return {
      supplier: null,
      openingBalance: 0,
      rows: [],
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

  const selectedSupplier = (options.suppliers || []).find(
    (supplier) => Number(supplier.id) === Number(filters.partyId),
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
    .where("vl.line_kind", "ITEM")
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
  const openingBalance = toAmount(openingRow?.opening_balance || 0, 2);

  let runningBalance = openingBalance;
  let totalQty = 0;
  let totalDebit = 0;
  let totalCredit = 0;

  const rows = rawRows.map((row, index) => {
    const qty = toQty(row.qty, 3);
    const debit = toAmount(row.dr, 2);
    const credit = toAmount(row.cr, 2);

    totalQty = toQty(totalQty + qty, 3);
    totalDebit = toAmount(totalDebit + debit, 2);
    totalCredit = toAmount(totalCredit + credit, 2);
    runningBalance = toAmount(runningBalance + debit - credit, 2);

    return {
      sr_no: index + 1,
      entry_date: row.entry_date || null,
      voucher_no: row.voucher_no || null,
      bill_number: row.bill_number || "",
      voucher_type: row.voucher_type_code || "",
      description: row.description || "",
      qty,
      debit,
      credit,
      balance: runningBalance,
      branch_name: row.branch_name || "",
    };
  });

  return {
    supplier: selectedSupplier || null,
    openingBalance,
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

const getSupplierLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseSupplierLedgerFilters({ req, input });
  const options = await loadSupplierLedgerOptions({ req, filters });
  const ledgerData = await getSupplierLedgerRows({ req, filters, options });

  return {
    filters,
    options,
    reportData: ledgerData,
  };
};

const loadSupplierBalanceOptions = async ({ req }) => {
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

const getSupplierBalanceRows = async ({ req, filters }) => {
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
      if (scopedBranchIds.length)
        queryBuilder.whereIn("ge.branch_id", scopedBranchIds);
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
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','BOTH')")
    .orderBy("p.name", "asc");

  if (scopedBranchIds.length) {
    query = applyPartyBranchScope(query, scopedBranchIds);
  }

  const rows = await query;
  return rows.map((row) => ({
    supplier_id: Number(row.id || 0) || null,
    supplier_code: row.code || "",
    supplier_name: row.name || "",
    supplier_name_ur: row.name_ur || "",
    amount: toAmount(row.amount, 2),
  }));
};

const getSupplierBalancesReportPageData = async ({ req, input = {} }) => {
  const filters = parseSupplierBalanceFilters({ req, input });
  const [options, rows] = await Promise.all([
    loadSupplierBalanceOptions({ req }),
    getSupplierBalanceRows({ req, filters }),
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
  PURCHASE_TYPE_FILTERS,
  getPurchaseReportPageData,
  getSupplierBalancesReportPageData,
  getSupplierLedgerReportPageData,
};
