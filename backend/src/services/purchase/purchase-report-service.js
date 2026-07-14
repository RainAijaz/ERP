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
const PURCHASE_CATEGORY_FILTERS = Object.freeze({
  all: "all",
  rawMaterial: "raw_material",
  asset: "asset",
  consumable: "consumable",
});

const localizedNameSelect = (alias, as, locale) =>
  locale === "ur"
    ? knex.raw(`COALESCE(${alias}.name_ur, ${alias}.name) as ${as}`)
    : `${alias}.name as ${as}`;

const ALL_MULTI_FILTER_VALUE = "__ALL__";
const PURCHASE_RATE_ALERT_PERCENT = (() => {
  const value = Number(process.env.PURCHASE_RATE_ALERT_PERCENT || 10);
  if (!Number.isFinite(value) || value <= 0) return 10;
  return Number(value.toFixed(2));
})();

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

const resolvePurchaseCategoryFilter = (
  value,
  fallback = PURCHASE_CATEGORY_FILTERS.all,
) => {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (key === PURCHASE_CATEGORY_FILTERS.asset) return PURCHASE_CATEGORY_FILTERS.asset;
  if (key === PURCHASE_CATEGORY_FILTERS.rawMaterial)
    return PURCHASE_CATEGORY_FILTERS.rawMaterial;
  if (key === PURCHASE_CATEGORY_FILTERS.consumable) return PURCHASE_CATEGORY_FILTERS.consumable;
  if (key === PURCHASE_CATEGORY_FILTERS.all) return PURCHASE_CATEGORY_FILTERS.all;
  return fallback;
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

const toIdListWithAllFromSources = (...sources) => {
  const merged = [];
  sources.forEach((source) => {
    if (Array.isArray(source)) merged.push(...source);
    else merged.push(source);
  });
  return toIdListWithAll(merged);
};

let purchaseInvoiceHeaderHasPurchaseCategoryColumn;
let assetColumnSupport;

const hasColumn = async (tableName, columnName) => {
  try {
    return await knex.schema.withSchema("erp").hasColumn(tableName, columnName);
  } catch (err) {
    return false;
  }
};

const hasPurchaseInvoiceCategoryColumn = async () => {
  if (typeof purchaseInvoiceHeaderHasPurchaseCategoryColumn === "boolean") {
    return purchaseInvoiceHeaderHasPurchaseCategoryColumn;
  }
  purchaseInvoiceHeaderHasPurchaseCategoryColumn = await hasColumn(
    "purchase_invoice_header_ext",
    "purchase_category",
  );
  return purchaseInvoiceHeaderHasPurchaseCategoryColumn;
};

const getAssetColumnSupport = async () => {
  if (assetColumnSupport) return assetColumnSupport;
  const [hasName, hasNameUr] = await Promise.all([
    hasColumn("assets", "name"),
    hasColumn("assets", "name_ur"),
  ]);
  assetColumnSupport = {
    name: hasName,
    name_ur: hasNameUr,
  };
  return assetColumnSupport;
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
  let branchIds;
  if (req.user?.isAdmin) {
    branchIds = selectedBranchIds;
  } else {
    const allowedBranchIds = (req.branchOptions || [])
      .map((b) => Number(b.id || 0))
      .filter((id) => id > 0);
    const fallback = Number(req.branchId || 0);
    const effectiveAllowed = allowedBranchIds.length
      ? allowedBranchIds
      : fallback > 0 ? [fallback] : [];
    if (selectedBranchIds.length) {
      branchIds = selectedBranchIds.filter((id) => effectiveAllowed.includes(id));
      if (!branchIds.length) branchIds = effectiveAllowed;
    } else {
      branchIds = effectiveAllowed;
    }
  }

  const orderBy = resolveReportOrderType(
    input.order_by,
    REPORT_ORDER_TYPES.party,
  );
  const reportType = resolveReportType(input.report_type, REPORT_TYPES.details);
  const purchaseType = resolvePurchaseTypeFilter(
    input.purchase_type,
    PURCHASE_TYPE_FILTERS.all,
  );
  const purchaseCategory = resolvePurchaseCategoryFilter(
    input.purchase_category,
    PURCHASE_CATEGORY_FILTERS.all,
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
    purchaseCategory,
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
  const branchScope = filters.branchIds;
  const locale = String(req?.locale || "en").toLowerCase();

  const branchesPromise = req.user?.isAdmin
    ? knex("erp.branches")
        .select("id", localizedNameSelect("erp.branches", "name", locale))
        .where({ is_active: true })
        .orderBy("name", "asc")
    : Promise.resolve(
        (req.branchOptions || []).map((row) => ({
          id: Number(row.id),
          name:
            locale === "ur" && row.name_ur ? row.name_ur : row.name,
        })),
      );

  let suppliersQuery = knex("erp.parties as p")
    .select("p.id", "p.code", localizedNameSelect("p", "name", locale))
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','BOTH')");

  if (branchScope.length) {
    suppliersQuery = applyPartyBranchScope(suppliersQuery, branchScope);
  }

  let cashAccountsQuery = knex("erp.accounts as a")
    .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
    .select("a.id", "a.code", localizedNameSelect("a", "name", locale))
    .where({ "a.is_active": true })
    .whereRaw("lower(coalesce(apc.code, '')) in ('cash','bank')");

  if (branchScope.length) {
    cashAccountsQuery = cashAccountsQuery.whereExists(
      function whereAccountBranchScope() {
        this.select(1)
          .from("erp.account_branch as ab")
          .whereRaw("ab.account_id = a.id")
          .whereIn("ab.branch_id", branchScope);
      },
    );
  }

  const [branches, suppliers, rawMaterials, groups, subgroups, cashAccounts] =
    await Promise.all([
      branchesPromise,
      suppliersQuery.orderBy("p.name", "asc"),
      knex("erp.items as i")
        .select(
          "i.id",
          "i.code",
          localizedNameSelect("i", "name", locale),
          "i.group_id",
          "i.subgroup_id",
        )
        .where({ "i.is_active": true })
        .whereRaw("upper(coalesce(i.item_type::text, '')) IN ('RM', 'SFG')")
        .orderBy("i.name", "asc"),
      knex("erp.product_groups as g")
        .select("g.id", localizedNameSelect("g", "name", locale))
        .where({ "g.is_active": true })
        .whereExists(function whereGroupHasRawMaterial() {
          this.select(1)
            .from("erp.items as i")
            .whereRaw("i.group_id = g.id")
            .andWhere("i.is_active", true)
            .andWhereRaw("upper(coalesce(i.item_type::text, '')) IN ('RM', 'SFG')");
        })
        .orderBy("g.name", "asc"),
      knex("erp.product_subgroups as sg")
        .select(
          "sg.id",
          localizedNameSelect("sg", "name", locale),
          "sg.group_id",
        )
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
            .andWhereRaw("upper(coalesce(i.item_type::text, '')) IN ('RM', 'SFG')");
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

  const supportsPurchaseCategory = await hasPurchaseInvoiceCategoryColumn();
  const includeRawMaterialRows =
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.asset &&
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.consumable;
  const hasItemFilter = filters.rawMaterialIds.length > 0;
  const includeAssetRows =
    supportsPurchaseCategory &&
    !hasItemFilter &&
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.rawMaterial &&
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.consumable;
  const includeConsumableRows =
    supportsPurchaseCategory &&
    !hasItemFilter &&
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.rawMaterial &&
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.asset;

  const applyCommonFilters = (query) => {
    let next = query
      .where({
        "vh.voucher_type_code": "PI",
        "vh.status": "APPROVED",
      })
      .where("vh.voucher_date", ">=", filters.from)
      .where("vh.voucher_date", "<=", filters.to);

    if (filters.branchIds.length) {
      next = next.whereIn("vh.branch_id", filters.branchIds);
    }

    if (filters.partyIds.length) {
      next = next.whereIn("pie.supplier_party_id", filters.partyIds);
    }

    if (filters.purchaseType === PURCHASE_TYPE_FILTERS.cash) {
      next = next.whereRaw(
        "upper(coalesce(pie.payment_type::text, '')) = 'CASH'",
      );
      if (filters.cashAccountId) {
        next = next.andWhere("pie.cash_paid_account_id", filters.cashAccountId);
      }
    } else if (filters.purchaseType === PURCHASE_TYPE_FILTERS.credit) {
      next = next.whereRaw(
        "upper(coalesce(pie.payment_type::text, '')) = 'CREDIT'",
      );
    }

    return next;
  };

  const locale = String(req?.locale || "en").toLowerCase();
  const rawMaterialRowsPromise = includeRawMaterialRows
    ? (() => {
        let query = knex("erp.voucher_header as vh")
          .join(
            "erp.purchase_invoice_header_ext as pie",
            "pie.voucher_id",
            "vh.id",
          )
          .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
          .join("erp.items as i", "i.id", "vl.item_id")
          .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
          .leftJoin("erp.rm_purchase_rates as r", function joinRmRates() {
            this.on("r.rm_item_id", "=", "vl.item_id")
              .andOn(knex.raw("r.is_active = true"))
              .andOn(
                knex.raw(
                  "COALESCE(r.color_id::text, '0') = COALESCE(NULLIF(vl.meta->>'color_id', ''), NULLIF(vl.meta->>'rm_color_id', ''), '0')",
                ),
              )
              .andOn(
                knex.raw(
                  "COALESCE(r.size_id::text, '0') = COALESCE(NULLIF(vl.meta->>'size_id', ''), NULLIF(vl.meta->>'rm_size_id', ''), '0')",
                ),
              );
          })
          .leftJoin("erp.parties as p", "p.id", "pie.supplier_party_id")
          .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
          .leftJoin("erp.accounts as a", "a.id", "pie.cash_paid_account_id")
          .leftJoin(
            "erp.colors as vc",
            knex.raw(
              "vc.id::text = COALESCE(NULLIF(vl.meta->>'color_id', ''), NULLIF(vl.meta->>'rm_color_id', ''))",
            ),
          )
          .leftJoin(
            "erp.sizes as vs",
            knex.raw(
              "vs.id::text = COALESCE(NULLIF(vl.meta->>'size_id', ''), NULLIF(vl.meta->>'rm_size_id', ''))",
            ),
          )
          .select(
            "vh.id as voucher_id",
            "vh.voucher_no",
            "vh.voucher_date",
            "vh.book_no as bill_number",
            knex.raw("COALESCE(NULLIF(vh.remarks, ''), '') as remarks"),
            "vh.branch_id",
            localizedNameSelect("b", "branch_name", locale),
            "pie.supplier_party_id",
            localizedNameSelect("p", "supplier_name", locale),
            "pie.payment_type",
            "pie.cash_paid_account_id",
            localizedNameSelect("a", "cash_account_name", locale),
            "vl.line_no",
            "vl.item_id",
            "i.code as item_code",
            localizedNameSelect("i", "item_name", locale),
            localizedNameSelect("vc", "color_name", locale),
            localizedNameSelect("vs", "size_name", locale),
            "u.code as uom_code",
            "i.group_id",
            "i.subgroup_id",
            "vl.qty",
            "vl.rate",
            "vl.amount",
            knex.raw("COALESCE(r.purchase_rate, 0) as fixed_purchase_rate"),
            knex.raw("COALESCE(r.avg_purchase_rate, 0) as weighted_average_rate"),
            knex.raw("NULL::bigint as asset_id"),
            knex.raw("NULL::text as asset_name"),
            knex.raw("'RAW_MATERIAL'::text as purchase_category"),
          )
          .where({
            "vl.line_kind": "ITEM",
          })
          .whereRaw("upper(coalesce(i.item_type::text, '')) IN ('RM', 'SFG')");

        query = applyCommonFilters(query);
        if (supportsPurchaseCategory) {
          query = query.whereRaw(
            "upper(coalesce(pie.purchase_category::text, 'RAW_MATERIAL')) = 'RAW_MATERIAL'",
          );
        }
        if (filters.rawMaterialIds.length) {
          query = query.whereIn("vl.item_id", filters.rawMaterialIds);
        }
        if (Array.isArray(filters.groupIds) && filters.groupIds.length) {
          query = query.whereIn("i.group_id", filters.groupIds);
        }
        if (Array.isArray(filters.subgroupIds) && filters.subgroupIds.length) {
          query = query.whereIn("i.subgroup_id", filters.subgroupIds);
        }
        return query;
      })()
    : Promise.resolve([]);

  const assetRowsPromise = includeAssetRows
    ? (async () => {
        const assetColumns = await getAssetColumnSupport();
        const assetNameExpr =
          locale === "ur" && assetColumns.name_ur
            ? "COALESCE(a2.name_ur, a2.name, a2.description, a2.asset_code, '-')"
            : assetColumns.name
              ? "COALESCE(a2.name, a2.description, a2.asset_code, '-')"
              : "COALESCE(a2.description, a2.asset_code, '-')";

        let query = knex("erp.voucher_header as vh")
          .join(
            "erp.purchase_invoice_header_ext as pie",
            "pie.voucher_id",
            "vh.id",
          )
          .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
          .leftJoin("erp.parties as p", "p.id", "pie.supplier_party_id")
          .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
          .leftJoin("erp.accounts as a", "a.id", "pie.cash_paid_account_id")
          .leftJoin("erp.assets as a2", function joinAssets() {
            this.on(
              "a2.id",
              "=",
              knex.raw(
                "CASE WHEN coalesce(vl.meta->>'asset_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'asset_id')::bigint ELSE NULL END",
              ),
            );
          })
          .select(
            "vh.id as voucher_id",
            "vh.voucher_no",
            "vh.voucher_date",
            "vh.book_no as bill_number",
            knex.raw("COALESCE(NULLIF(vh.remarks, ''), '') as remarks"),
            "vh.branch_id",
            localizedNameSelect("b", "branch_name", locale),
            "pie.supplier_party_id",
            localizedNameSelect("p", "supplier_name", locale),
            "pie.payment_type",
            "pie.cash_paid_account_id",
            localizedNameSelect("a", "cash_account_name", locale),
            "vl.line_no",
            knex.raw("NULL::bigint as item_id"),
            knex.raw("''::text as item_code"),
            knex.raw(`${assetNameExpr} as item_name`),
            knex.raw("NULL::text as color_name"),
            knex.raw("NULL::text as size_name"),
            knex.raw("NULL::bigint as group_id"),
            knex.raw("NULL::bigint as subgroup_id"),
            "vl.qty",
            "vl.rate",
            "vl.amount",
            "vl.rate as fixed_purchase_rate",
            "vl.rate as weighted_average_rate",
            knex.raw(
              "CASE WHEN coalesce(vl.meta->>'asset_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'asset_id')::bigint ELSE NULL END as asset_id",
            ),
            knex.raw(`${assetNameExpr} as asset_name`),
            knex.raw("'ASSET'::text as purchase_category"),
          )
          .where({
            "vl.line_kind": "ACCOUNT",
          });

        query = applyCommonFilters(query);
        query = query.whereRaw(
          "upper(coalesce(pie.purchase_category::text, 'RAW_MATERIAL')) = 'ASSET'",
        );
        return query;
      })()
    : Promise.resolve([]);

  const consumableRowsPromise = includeConsumableRows
    ? (() => {
        let query = knex("erp.voucher_header as vh")
          .join(
            "erp.purchase_invoice_header_ext as pie",
            "pie.voucher_id",
            "vh.id",
          )
          .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
          .leftJoin("erp.parties as p", "p.id", "pie.supplier_party_id")
          .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
          .leftJoin("erp.accounts as a", "a.id", "pie.cash_paid_account_id")
          .leftJoin("erp.accounts as ea", "ea.id", "vl.account_id")
          .select(
            "vh.id as voucher_id",
            "vh.voucher_no",
            "vh.voucher_date",
            "vh.book_no as bill_number",
            knex.raw("COALESCE(NULLIF(vh.remarks, ''), '') as remarks"),
            "vh.branch_id",
            localizedNameSelect("b", "branch_name", locale),
            "pie.supplier_party_id",
            localizedNameSelect("p", "supplier_name", locale),
            "pie.payment_type",
            "pie.cash_paid_account_id",
            localizedNameSelect("a", "cash_account_name", locale),
            "vl.line_no",
            knex.raw("NULL::bigint as item_id"),
            knex.raw("''::text as item_code"),
            knex.raw(
              locale === "ur"
                ? "COALESCE(ea.name_ur, ea.name, '-') as item_name"
                : "COALESCE(ea.name, '-') as item_name",
            ),
            knex.raw("NULL::text as color_name"),
            knex.raw("NULL::text as size_name"),
            knex.raw("NULL::text as uom_code"),
            knex.raw("NULL::bigint as group_id"),
            knex.raw("NULL::bigint as subgroup_id"),
            "vl.qty",
            "vl.rate",
            "vl.amount",
            "vl.rate as fixed_purchase_rate",
            "vl.rate as weighted_average_rate",
            "vl.account_id as consumable_account_id",
            knex.raw(
              locale === "ur"
                ? "COALESCE(ea.name_ur, ea.name, '-') as asset_name"
                : "COALESCE(ea.name, '-') as asset_name",
            ),
            knex.raw("NULL::bigint as asset_id"),
            knex.raw("'CONSUMABLE'::text as purchase_category"),
          )
          .where({ "vl.line_kind": "ACCOUNT" });

        query = applyCommonFilters(query);
        query = query.whereRaw(
          "upper(coalesce(pie.purchase_category::text, 'RAW_MATERIAL')) = 'CONSUMABLE'",
        );
        return query;
      })()
    : Promise.resolve([]);

  const [rawMaterialRows, assetRows, consumableRows] = await Promise.all([
    rawMaterialRowsPromise,
    assetRowsPromise,
    consumableRowsPromise,
  ]);

  const mappedRows = [...rawMaterialRows, ...assetRows, ...consumableRows].map((row) => {
    const _cat = String(row.purchase_category || "RAW_MATERIAL").trim().toUpperCase();
    const purchaseCategory = _cat === "ASSET" ? "ASSET" : _cat === "CONSUMABLE" ? "CONSUMABLE" : "RAW_MATERIAL";
    const currentPurchaseRate = toAmount(row.rate, 4);
    const fixedPurchaseRate =
      purchaseCategory === "ASSET" || purchaseCategory === "CONSUMABLE"
        ? currentPurchaseRate
        : toAmount(row.fixed_purchase_rate, 4);
    const weightedAverageRate =
      purchaseCategory === "ASSET" || purchaseCategory === "CONSUMABLE"
        ? currentPurchaseRate
        : toAmount(row.weighted_average_rate, 4);
    const rateDifferenceAmount = toAmount(
      currentPurchaseRate - fixedPurchaseRate,
      4,
    );
    const absRateDifferenceAmount = toAmount(Math.abs(rateDifferenceAmount), 4);
    const rateDifferencePercent =
      fixedPurchaseRate > 0
        ? toAmount((rateDifferenceAmount / fixedPurchaseRate) * 100, 2)
        : 0;
    const absRateDifferencePercent =
      fixedPurchaseRate > 0
        ? toAmount((absRateDifferenceAmount / fixedPurchaseRate) * 100, 2)
        : 0;

    return {
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
      purchase_category: purchaseCategory,
      cash_paid_account_id: Number(row.cash_paid_account_id || 0) || null,
      cash_account_name: row.cash_account_name || "",
      line_no: Number(row.line_no || 0) || 1,
      item_id:
        purchaseCategory === "RAW_MATERIAL"
          ? Number(row.item_id || 0) || null
          : null,
      item_code: row.item_code || "",
      uom_code: row.uom_code || "",
      color_name: row.color_name || "",
      size_name: row.size_name || "",
      item_name:
        purchaseCategory === "ASSET" || purchaseCategory === "CONSUMABLE"
          ? row.asset_name || row.item_name || ""
          : row.item_name || "",
      entity_id:
        purchaseCategory === "ASSET"
          ? Number(row.asset_id || 0) || null
          : purchaseCategory === "CONSUMABLE"
            ? Number(row.consumable_account_id || 0) || null
            : Number(row.item_id || 0) || null,
      entity_name:
        purchaseCategory === "ASSET" || purchaseCategory === "CONSUMABLE"
          ? row.asset_name || row.item_name || ""
          : row.item_name || "",
      group_id:
        purchaseCategory === "RAW_MATERIAL"
          ? Number(row.group_id || 0) || null
          : null,
      subgroup_id:
        purchaseCategory === "RAW_MATERIAL"
          ? Number(row.subgroup_id || 0) || null
          : null,
      qty: toQty(row.qty),
      rate: currentPurchaseRate,
      fixed_purchase_rate: fixedPurchaseRate,
      weighted_average_rate: weightedAverageRate,
      rate_diff_amount: rateDifferenceAmount,
      rate_diff_percent: rateDifferencePercent,
      rate_diff_amount_abs: absRateDifferenceAmount,
      rate_diff_percent_abs: absRateDifferencePercent,
      is_rate_difference_high:
        fixedPurchaseRate > 0 &&
        absRateDifferencePercent >= PURCHASE_RATE_ALERT_PERCENT,
      amount: toAmount(row.amount, 2),
    };
  });

  const compareText = (a, b) =>
    String(a || "").localeCompare(String(b || ""), undefined, {
      sensitivity: "base",
    });
  const compareDate = (a, b) =>
    String(a?.voucher_date || "").localeCompare(String(b?.voucher_date || ""));
  const compareVoucher = (a, b) =>
    Number(a?.voucher_no || 0) - Number(b?.voucher_no || 0);
  const compareLine = (a, b) => Number(a?.line_no || 0) - Number(b?.line_no || 0);

  return mappedRows.sort((left, right) => {
    if (filters.orderBy === REPORT_ORDER_TYPES.party) {
      const partyCmp = compareText(left?.supplier_name, right?.supplier_name);
      if (partyCmp !== 0) return partyCmp;
      const dateCmp = compareDate(left, right);
      if (dateCmp !== 0) return dateCmp;
      const voucherCmp = compareVoucher(left, right);
      if (voucherCmp !== 0) return voucherCmp;
      return compareLine(left, right);
    }
    if (filters.orderBy === REPORT_ORDER_TYPES.invoice) {
      const dateCmp = compareDate(left, right);
      if (dateCmp !== 0) return dateCmp;
      const voucherCmp = compareVoucher(left, right);
      if (voucherCmp !== 0) return voucherCmp;
      return compareLine(left, right);
    }
    const entityCmp = compareText(left?.entity_name, right?.entity_name);
    if (entityCmp !== 0) return entityCmp;
    const dateCmp = compareDate(left, right);
    if (dateCmp !== 0) return dateCmp;
    const voucherCmp = compareVoucher(left, right);
    if (voucherCmp !== 0) return voucherCmp;
    return compareLine(left, right);
  });
};

const getGroupIdentity = (row, orderBy) => {
  if (orderBy === REPORT_ORDER_TYPES.invoice) {
    const key = `INV:${Number(row.voucher_id || 0)}`;
    return {
      key,
      label: `VR. NO. ${Number(row.voucher_no || 0)} | ${row.voucher_date || "-"} | ${row.supplier_name || "-"}`,
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
    const key = `ITEM:${String(row.purchase_category || "RAW_MATERIAL")}:${Number(row.entity_id || 0)}`;
    const label = String(row.entity_name || row.item_name || "").trim() || "-";
    return {
      key,
      label,
      voucher_no: null,
      voucher_date: "",
      bill_number: "",
      remarks: "",
      supplier_name: "",
      item_name: row.entity_name || row.item_name || "",
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
        total_fixed_amount_basis: 0,
        total_weighted_amount_basis: 0,
        avg_rate: 0,
        avg_fixed_purchase_rate: 0,
        avg_weighted_average_rate: 0,
        avg_variance_amount: 0,
        avg_variance_percent: 0,
        is_rate_difference_high: false,
        lines: [],
      };
      groups.push(group);
      groupMap.set(identity.key, group);
    }

    group.total_qty = toQty(group.total_qty + row.qty);
    group.total_amount = toAmount(group.total_amount + row.amount);
    group.total_fixed_amount_basis = toAmount(
      group.total_fixed_amount_basis +
        Number(row.qty || 0) * Number(row.fixed_purchase_rate || 0),
      4,
    );
    group.total_weighted_amount_basis = toAmount(
      group.total_weighted_amount_basis +
        Number(row.qty || 0) * Number(row.weighted_average_rate || 0),
      4,
    );
    if (filters.reportType === REPORT_TYPES.details) {
      group.lines.push(row);
    }
  });

  groups.forEach((group) => {
    group.avg_rate =
      group.total_qty > 0
        ? toAmount(group.total_amount / group.total_qty, 4)
        : 0;
    group.avg_fixed_purchase_rate =
      group.total_qty > 0
        ? toAmount(group.total_fixed_amount_basis / group.total_qty, 4)
        : 0;
    group.avg_weighted_average_rate =
      group.total_qty > 0
        ? toAmount(group.total_weighted_amount_basis / group.total_qty, 4)
        : 0;
    group.avg_variance_amount = toAmount(
      Number(group.avg_rate || 0) - Number(group.avg_fixed_purchase_rate || 0),
      4,
    );
    group.avg_variance_percent =
      Number(group.avg_fixed_purchase_rate || 0) > 0
        ? toAmount(
            (Number(group.avg_variance_amount || 0) /
              Number(group.avg_fixed_purchase_rate || 0)) *
              100,
            2,
          )
        : 0;
    group.is_rate_difference_high =
      Number(group.avg_fixed_purchase_rate || 0) > 0 &&
      Math.abs(Number(group.avg_variance_percent || 0)) >=
        PURCHASE_RATE_ALERT_PERCENT;
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
    avg_rate: group.avg_rate,
    avg_fixed_purchase_rate: group.avg_fixed_purchase_rate,
    avg_weighted_average_rate: group.avg_weighted_average_rate,
    avg_variance_amount: group.avg_variance_amount,
    avg_variance_percent: group.avg_variance_percent,
    is_rate_difference_high: group.is_rate_difference_high,
    total_amount: toAmount(group.total_amount),
  }));

  const grandTotalQty = toQty(
    groups.reduce((sum, group) => sum + Number(group.total_qty || 0), 0),
  );
  const grandTotalAmount = toAmount(
    groups.reduce((sum, group) => sum + Number(group.total_amount || 0), 0),
  );
  const grandTotalFixedAmountBasis = toAmount(
    groups.reduce(
      (sum, group) => sum + Number(group.total_fixed_amount_basis || 0),
      0,
    ),
    4,
  );
  const grandTotalWeightedAmountBasis = toAmount(
    groups.reduce(
      (sum, group) => sum + Number(group.total_weighted_amount_basis || 0),
      0,
    ),
    4,
  );
  const grandAvgRate =
    grandTotalQty > 0 ? toAmount(grandTotalAmount / grandTotalQty, 4) : 0;
  const grandAvgFixedPurchaseRate =
    grandTotalQty > 0
      ? toAmount(grandTotalFixedAmountBasis / grandTotalQty, 4)
      : 0;
  const grandAvgWeightedAverageRate =
    grandTotalQty > 0
      ? toAmount(grandTotalWeightedAmountBasis / grandTotalQty, 4)
      : 0;
  const grandAvgVarianceAmount = toAmount(
    Number(grandAvgRate || 0) - Number(grandAvgFixedPurchaseRate || 0),
    4,
  );
  const grandAvgVariancePercent =
    Number(grandAvgFixedPurchaseRate || 0) > 0
      ? toAmount(
          (Number(grandAvgVarianceAmount || 0) /
            Number(grandAvgFixedPurchaseRate || 0)) *
            100,
          2,
        )
      : 0;
  const isGrandRateDifferenceHigh =
    Number(grandAvgFixedPurchaseRate || 0) > 0 &&
    Math.abs(Number(grandAvgVariancePercent || 0)) >=
      PURCHASE_RATE_ALERT_PERCENT;

  return {
    groups,
    summaryRows,
    grandTotalQty,
    grandTotalAmount,
    grandAvgRate,
    grandAvgFixedPurchaseRate,
    grandAvgWeightedAverageRate,
    grandAvgVarianceAmount,
    grandAvgVariancePercent,
    isGrandRateDifferenceHigh,
    rateAlertPercent: PURCHASE_RATE_ALERT_PERCENT,
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

const fetchSupplierLedgerDetailLines = async ({ voucherHeaderIds, locale }) => {
  const ids = [...new Set(voucherHeaderIds.filter((id) => Number(id) > 0))];
  if (!ids.length) return new Map();

  const lineRows = await knex("erp.voucher_line as vl")
    .leftJoin("erp.items as i", "i.id", "vl.item_id")
    .leftJoin("erp.accounts as a", "a.id", "vl.account_id")
    .leftJoin("erp.skus as sk", "sk.id", "vl.sku_id")
    .leftJoin("erp.variants as vr", "vr.id", "sk.variant_id")
    .leftJoin("erp.items as si", "si.id", "vr.item_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .leftJoin(
      "erp.colors as vc",
      knex.raw(
        "vc.id::text = COALESCE(NULLIF(vl.meta->>'color_id', ''), NULLIF(vl.meta->>'rm_color_id', ''))",
      ),
    )
    .leftJoin(
      "erp.sizes as vs",
      knex.raw(
        "vs.id::text = COALESCE(NULLIF(vl.meta->>'size_id', ''), NULLIF(vl.meta->>'rm_size_id', ''))",
      ),
    )
    .select(
      "vl.voucher_header_id",
      "vl.line_no",
      "vl.line_kind",
      localizedNameSelect("i", "item_name", locale),
      localizedNameSelect("si", "sku_item_name", locale),
      "sk.sku_code",
      localizedNameSelect("a", "account_name", locale),
      localizedNameSelect("vc", "color_name", locale),
      localizedNameSelect("vs", "size_name", locale),
      "u.code as uom_code",
      "vl.qty",
      "vl.rate",
      "vl.amount",
    )
    .whereIn("vl.voucher_header_id", ids)
    .whereIn("vl.line_kind", ["ITEM", "SKU", "ACCOUNT"])
    .orderBy("vl.voucher_header_id", "asc")
    .orderBy("vl.line_no", "asc");

  const byVoucher = new Map();
  lineRows.forEach((row) => {
    const key = Number(row.voucher_header_id || 0);
    if (!key) return;

    let name = "";
    if (row.line_kind === "ITEM") {
      name = row.item_name || "";
    } else if (row.line_kind === "SKU") {
      name = [row.sku_item_name, row.sku_code].filter(Boolean).join(" ");
    } else if (row.line_kind === "ACCOUNT") {
      name = row.account_name || "";
    }

    const variant = [row.color_name, row.size_name].filter(Boolean).join(" / ");

    if (!byVoucher.has(key)) byVoucher.set(key, []);
    byVoucher.get(key).push({
      name: name || "-",
      variant,
      uom_code: row.uom_code || "",
      qty: toQty(row.qty, 3),
      rate: toAmount(row.rate, 4),
      amount: toAmount(row.amount, 2),
    });
  });

  return byVoucher;
};

const getSupplierLedgerRows = async ({ req, filters, options }) => {
  const locale = String(req?.locale || "en").toLowerCase();
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
      localizedNameSelect("b", "branch_name", locale),
      knex.raw(
        "COALESCE(NULLIF(ge.narration, ''), NULLIF(vh.remarks, '')) as description",
      ),
      knex.raw("COALESCE(vq.qty, 0) as qty"),
      knex.raw("COALESCE(ge.dr, 0) as dr"),
      knex.raw("COALESCE(ge.cr, 0) as cr"),
      "ge.id",
      "vh.id as voucher_header_id",
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

  const baseEntries = rawRows.map((row) => ({
    id: Number(row.id || 0),
    voucher_header_id: Number(row.voucher_header_id || 0) || null,
    entry_date: row.entry_date || null,
    voucher_no: row.voucher_no || null,
    bill_number: row.bill_number || "",
    voucher_type: row.voucher_type_code || "",
    description: row.description || "",
    qty: toQty(row.qty, 3),
    debit: toAmount(row.dr, 2),
    credit: toAmount(row.cr, 2),
    branch_name: row.branch_name || "",
  }));

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

          return [...grouped.values()].sort((a, b) => {
            const dateA = String(a.entry_date || "");
            const dateB = String(b.entry_date || "");
            if (dateA !== dateB) return dateA.localeCompare(dateB);
            const voucherA = Number(a.voucher_no || 0);
            const voucherB = Number(b.voucher_no || 0);
            if (voucherA !== voucherB) return voucherA - voucherB;
            return Number(a.id || 0) - Number(b.id || 0);
          });
        })()
      : baseEntries;

  const detailLinesByVoucher =
    filters.ledgerView === "detail"
      ? await fetchSupplierLedgerDetailLines({
          voucherHeaderIds: reportEntries.map((entry) => entry.voucher_header_id),
          locale,
        })
      : new Map();

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
      detail_lines: entry.voucher_header_id
        ? detailLinesByVoucher.get(entry.voucher_header_id) || []
        : [],
    };
  });

  return {
    supplier: selectedSupplier || null,
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

  return {
    branches,
  };
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
  return rows
    .map((row) => ({
      supplier_id: Number(row.id || 0) || null,
      supplier_code: row.code || "",
      supplier_name: row.name || "",
      supplier_name_ur: row.name_ur || "",
      amount: toAmount(row.amount, 2),
    }))
    .filter((row) => Number(row.amount) !== 0);
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

const parsePendingGrnFilters = ({ req, input = {} }) => {
  const parsedFrom = parseDateFilter(input.from_date, "");
  const parsedTo = parseDateFilter(input.to_date, "");
  let from = parsedFrom.value;
  let to = parsedTo.value;
  let invalidDateRange = false;
  if (from && to && from > to) {
    from = "";
    to = "";
    invalidDateRange = true;
  }

  const selectedBranchIds = toIdListWithAll(input.branch_ids);
  let branchIds;
  if (req.user?.isAdmin) {
    branchIds = selectedBranchIds;
  } else {
    const allowedBranchIds = (req.branchOptions || [])
      .map((b) => Number(b.id || 0))
      .filter((id) => id > 0);
    const fallback = Number(req.branchId || 0);
    const effectiveAllowed = allowedBranchIds.length
      ? allowedBranchIds
      : fallback > 0
        ? [fallback]
        : [];
    if (selectedBranchIds.length) {
      branchIds = selectedBranchIds.filter((id) =>
        effectiveAllowed.includes(id),
      );
      if (!branchIds.length) branchIds = effectiveAllowed;
    } else {
      branchIds = effectiveAllowed;
    }
  }

  return {
    from,
    to,
    branchIds,
    supplierIds: toIdListWithAll(input.party_ids),
    purchaseCategory: resolvePurchaseCategoryFilter(
      input.purchase_category,
      PURCHASE_CATEGORY_FILTERS.all,
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

const loadPendingGrnReportOptions = async ({ req, filters }) => {
  const branchScope = filters.branchIds;

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
    .select("p.id", "p.code", "p.name", "p.name_ur")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','BOTH')");

  if (branchScope.length) {
    suppliersQuery = applyPartyBranchScope(suppliersQuery, branchScope);
  }

  const [branches, suppliers] = await Promise.all([
    branchesPromise,
    suppliersQuery.orderBy("p.name", "asc"),
  ]);

  return { branches, suppliers };
};

const daysBetweenYmd = (fromYmd, toYmd) => {
  const from = String(fromYmd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const to = String(toYmd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!from || !to) return 0;
  const fromUtc = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]));
  const toUtc = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]));
  return Math.max(0, Math.round((toUtc - fromUtc) / 86400000));
};

const getPendingGrnReportRows = async ({ req, filters }) => {
  if (!filters.reportLoaded) return [];

  const locale = String(req?.locale || "en").toLowerCase();
  const includeRawMaterialRows =
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.asset;
  const includeAssetRows =
    filters.purchaseCategory !== PURCHASE_CATEGORY_FILTERS.rawMaterial;

  const applyCommonGrnFilters = (query) => {
    let next = query.where({
      "vh.voucher_type_code": "GRN",
      "vh.status": "APPROVED",
    });
    if (filters.from) {
      next = next.where("vh.voucher_date", ">=", filters.from);
    }
    if (filters.to) {
      next = next.where("vh.voucher_date", "<=", filters.to);
    }
    if (filters.branchIds.length) {
      next = next.whereIn("vh.branch_id", filters.branchIds);
    }
    if (filters.supplierIds.length) {
      next = next.whereIn("ghe.supplier_party_id", filters.supplierIds);
    }
    return next;
  };

  const rawMaterialRowsPromise = includeRawMaterialRows
    ? (() => {
        let query = knex("erp.voucher_header as vh")
          .join("erp.purchase_grn_header_ext as ghe", "ghe.voucher_id", "vh.id")
          .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
          .join("erp.items as i", "i.id", "vl.item_id")
          .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
          .leftJoin("erp.parties as p", "p.id", "ghe.supplier_party_id")
          .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
          .leftJoin(
            "erp.colors as vc",
            knex.raw(
              "vc.id::text = COALESCE(NULLIF(vl.meta->>'color_id', ''), NULLIF(vl.meta->>'rm_color_id', ''))",
            ),
          )
          .leftJoin(
            "erp.sizes as vs",
            knex.raw(
              "vs.id::text = COALESCE(NULLIF(vl.meta->>'size_id', ''), NULLIF(vl.meta->>'rm_size_id', ''))",
            ),
          )
          .select(
            "vh.id as grn_voucher_id",
            "vh.voucher_no as grn_voucher_no",
            "vh.voucher_date",
            "vh.book_no",
            "vh.branch_id",
            localizedNameSelect("b", "branch_name", locale),
            "ghe.supplier_party_id",
            "p.code as supplier_code",
            "p.name as supplier_name",
            "p.name_ur as supplier_name_ur",
            knex.raw(
              "COALESCE(NULLIF(ghe.supplier_reference_no, ''), NULLIF(vh.book_no, ''), NULL) as grn_reference_no",
            ),
            "vl.id as grn_line_id",
            "vl.line_no as grn_line_no",
            "vl.item_id",
            "i.code as item_code",
            "i.name as item_name",
            "i.name_ur as item_name_ur",
            "u.code as uom_code",
            "vl.qty",
            localizedNameSelect("vc", "color_name", locale),
            localizedNameSelect("vs", "size_name", locale),
            knex.raw("'RAW_MATERIAL'::text as purchase_category"),
          )
          .where({ "vl.line_kind": "ITEM" })
          .whereRaw("upper(coalesce(i.item_type::text, '')) IN ('RM', 'SFG')")
          .andWhere("ghe.purchase_category", "RAW_MATERIAL");

        return applyCommonGrnFilters(query);
      })()
    : Promise.resolve([]);

  const assetRowsPromise = includeAssetRows
    ? (async () => {
        const assetColumns = await getAssetColumnSupport();
        const locale = String(req?.locale || "en").toLowerCase();
        const assetNameExpr =
          locale === "ur" && assetColumns.name_ur
            ? "COALESCE(a2.name_ur, a2.name, a2.description, a2.asset_code, '-')"
            : assetColumns.name
              ? "COALESCE(a2.name, a2.description, a2.asset_code, '-')"
              : "COALESCE(a2.description, a2.asset_code, '-')";

        let query = knex("erp.voucher_header as vh")
          .join("erp.purchase_grn_header_ext as ghe", "ghe.voucher_id", "vh.id")
          .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
          .leftJoin("erp.parties as p", "p.id", "ghe.supplier_party_id")
          .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
          .leftJoin("erp.assets as a2", function joinAssets() {
            this.on(
              "a2.id",
              "=",
              knex.raw(
                "CASE WHEN coalesce(vl.meta->>'asset_id', '') ~ '^[0-9]+$' THEN (vl.meta->>'asset_id')::bigint ELSE NULL END",
              ),
            );
          })
          .select(
            "vh.id as grn_voucher_id",
            "vh.voucher_no as grn_voucher_no",
            "vh.voucher_date",
            "vh.book_no",
            "vh.branch_id",
            localizedNameSelect("b", "branch_name", locale),
            "ghe.supplier_party_id",
            "p.code as supplier_code",
            "p.name as supplier_name",
            "p.name_ur as supplier_name_ur",
            knex.raw(
              "COALESCE(NULLIF(ghe.supplier_reference_no, ''), NULLIF(vh.book_no, ''), NULL) as grn_reference_no",
            ),
            "vl.id as grn_line_id",
            "vl.line_no as grn_line_no",
            knex.raw("NULL::bigint as item_id"),
            knex.raw("COALESCE(a2.asset_code, '') as item_code"),
            knex.raw(`${assetNameExpr} as item_name`),
            knex.raw("NULL::text as item_name_ur"),
            knex.raw("NULL::text as uom_code"),
            "vl.qty",
            knex.raw("NULL::text as color_name"),
            knex.raw("NULL::text as size_name"),
            knex.raw("'ASSET'::text as purchase_category"),
          )
          .where({ "vl.line_kind": "ACCOUNT" })
          .whereRaw("coalesce(vl.meta->>'asset_id', '') ~ '^[0-9]+$'")
          .andWhere("ghe.purchase_category", "ASSET");

        return applyCommonGrnFilters(query);
      })()
    : Promise.resolve([]);

  const [rawMaterialRows, assetRows] = await Promise.all([
    rawMaterialRowsPromise,
    assetRowsPromise,
  ]);
  const grnLines = [...rawMaterialRows, ...assetRows];
  if (!grnLines.length) return [];

  const grnLineIds = grnLines.map((line) => Number(line.grn_line_id));
  const allocationRows = await knex("erp.purchase_grn_invoice_alloc as a")
    .join("erp.voucher_line as pl", "pl.id", "a.purchase_voucher_line_id")
    .join("erp.voucher_header as pvh", "pvh.id", "pl.voucher_header_id")
    .select("a.grn_voucher_line_id")
    .sum({ qty_allocated: "a.qty_allocated" })
    .whereIn("a.grn_voucher_line_id", grnLineIds)
    .where("pvh.voucher_type_code", "PI")
    .whereNot("pvh.status", "REJECTED")
    .groupBy("a.grn_voucher_line_id");

  const allocatedByLineId = new Map(
    allocationRows.map((row) => [
      Number(row.grn_voucher_line_id),
      Number(row.qty_allocated || 0),
    ]),
  );

  const today = toLocalDateOnly(new Date());

  return grnLines
    .map((line) => {
      const qty = Number(line.qty || 0);
      const allocated = Number(
        allocatedByLineId.get(Number(line.grn_line_id)) || 0,
      );
      const openQty = Number((qty - allocated).toFixed(3));
      const voucherDate = toLocalDateOnly(line.voucher_date);
      return {
        grn_voucher_id: Number(line.grn_voucher_id),
        grn_voucher_no: Number(line.grn_voucher_no),
        grn_voucher_date: voucherDate,
        branch_id: Number(line.branch_id),
        branch_name: line.branch_name || "",
        supplier_party_id: Number(line.supplier_party_id || 0) || null,
        supplier_code: line.supplier_code || "",
        supplier_name: line.supplier_name || "",
        supplier_name_ur: line.supplier_name_ur || "",
        grn_reference_no: line.grn_reference_no || "",
        grn_line_id: Number(line.grn_line_id),
        grn_line_no: Number(line.grn_line_no),
        item_id: line.item_id ? Number(line.item_id) : null,
        item_code: line.item_code || "",
        item_name: line.item_name || "",
        item_name_ur: line.item_name_ur || "",
        color_name: line.color_name || "",
        size_name: line.size_name || "",
        uom_code: line.uom_code || "",
        purchase_category: line.purchase_category,
        qty: toQty(qty),
        allocated_qty: toQty(allocated),
        open_qty: openQty,
        days_pending: daysBetweenYmd(voucherDate, today),
      };
    })
    .filter((row) => row.open_qty > 0.0005)
    .sort((a, b) => {
      if (a.grn_voucher_date !== b.grn_voucher_date)
        return a.grn_voucher_date.localeCompare(b.grn_voucher_date);
      if (a.grn_voucher_no !== b.grn_voucher_no)
        return a.grn_voucher_no - b.grn_voucher_no;
      return a.grn_line_no - b.grn_line_no;
    });
};

const getPendingGrnReportPageData = async ({ req, input = {} }) => {
  const filters = parsePendingGrnFilters({ req, input });
  const [options, rows] = await Promise.all([
    loadPendingGrnReportOptions({ req, filters }),
    getPendingGrnReportRows({ req, filters }),
  ]);

  return {
    filters,
    options,
    reportData: {
      rows,
      totalOpenQty: toQty(
        rows.reduce((sum, row) => sum + Number(row.open_qty || 0), 0),
      ),
      rowCount: rows.length,
      grnVoucherCount: new Set(rows.map((row) => row.grn_voucher_id)).size,
    },
  };
};

module.exports = {
  PURCHASE_TYPE_FILTERS,
  getPurchaseReportPageData,
  getSupplierBalancesReportPageData,
  getSupplierLedgerReportPageData,
  getPendingGrnReportPageData,
};
