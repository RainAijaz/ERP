"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const { toBoolean } = require("../../utils/report-filter-types");

const ALL_MULTI_FILTER_VALUE = "__ALL__";
const STOCK_TYPES = Object.freeze({
  finished: "FG",
  semiFinished: "SFG",
  rawMaterial: "RM",
});
const RATE_TYPES = Object.freeze({
  cost: "COST",
  sale: "SALE",
  rmFixed: "FIXED",
  rmWeightedAverage: "WAVG",
});
const STOCK_STATUS_TYPES = Object.freeze({
  packed: "PACKED",
  loose: "LOOSE",
});
const VIEW_TYPES = Object.freeze({
  details: "details",
  summary: "summary",
});
const ORDER_BY_TYPES = Object.freeze({
  sku: "SKU",
  article: "ARTICLE",
});
const MOVEMENT_VOUCHER_CODES = Object.freeze({
  production: ["DCV", "CONSUMP", "PROD_FG", "PROD_SFG", "LABOUR_PROD"],
  purchase: ["PI", "PR", "GRN_IN", "PO"],
  sale: ["SALES_VOUCHER", "SALES_ORDER"],
});

const FG_PACKED_FLAG_SQL = `
CASE
  WHEN sln.is_packed IS NOT NULL THEN sln.is_packed
  WHEN pl.is_packed IS NOT NULL THEN pl.is_packed
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'PACKED' THEN true
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'LOOSE' THEN false
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('true','t','1','yes') THEN true
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('false','f','0','no') THEN false
  ELSE false
END`;

const toPositiveInt = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toAmount = (value, precision = 2) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(precision));
};

const toQuantity = (value, precision = 3) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(precision));
};

const hasNonZeroQuantity = (value, epsilon = 0.0005) =>
  Math.abs(Number(value || 0)) >= Number(epsilon);

const parseYmdStrict = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const yyyy = Number(match[1]);
  const mm = Number(match[2]);
  const dd = Number(match[3]);
  if (!Number.isInteger(yyyy) || !Number.isInteger(mm) || !Number.isInteger(dd))
    return null;
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (
    dt.getUTCFullYear() !== yyyy ||
    dt.getUTCMonth() !== mm - 1 ||
    dt.getUTCDate() !== dd
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
};

const parseDateFilter = (value, fallback) => {
  const text = String(value == null ? "" : value).trim();
  if (!text) return { value: fallback, provided: false, valid: true };
  const parsed = parseYmdStrict(text);
  if (!parsed) return { value: fallback, provided: true, valid: false };
  return { value: parsed, provided: true, valid: true };
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
  const hasAll = tokens.some((entry) => {
    const normalized = entry.toUpperCase();
    return (
      normalized === String(ALL_MULTI_FILTER_VALUE).toUpperCase() ||
      normalized === "ALL"
    );
  });
  if (hasAll) return [];
  return [
    ...new Set(
      tokens
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    ),
  ];
};

const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  const scoped = Array.isArray(req?.branchScope)
    ? req.branchScope
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0)
    : [];
  if (scoped.length) return scoped;
  const fallback = toPositiveInt(req?.branchId);
  return fallback ? [Number(fallback)] : [];
};

const normalizeBranchFilter = ({ req, input = {} }) => {
  const selected = toIdListWithAll(input.branch_ids || input.branchIds);
  if (req?.user?.isAdmin) return selected;

  const allowed = getAllowedBranchIds(req);
  if (!allowed.length) return [];
  if (!selected.length) return allowed;
  const allowedSet = new Set(allowed);
  return selected.filter((entry) => allowedSet.has(Number(entry)));
};

const normalizeStockType = (value) => {
  const normalized = String(value || STOCK_TYPES.finished)
    .trim()
    .toUpperCase();
  if (normalized === STOCK_TYPES.finished) return STOCK_TYPES.finished;
  if (normalized === STOCK_TYPES.semiFinished) return STOCK_TYPES.semiFinished;
  if (normalized === STOCK_TYPES.rawMaterial) return STOCK_TYPES.rawMaterial;
  return STOCK_TYPES.finished;
};

const normalizeViewType = (value) => {
  const normalized = String(value || VIEW_TYPES.details)
    .trim()
    .toLowerCase();
  return normalized === VIEW_TYPES.summary
    ? VIEW_TYPES.summary
    : VIEW_TYPES.details;
};

const normalizeOrderBy = (value) => {
  const normalized = String(value || ORDER_BY_TYPES.sku)
    .trim()
    .toUpperCase();
  return normalized === ORDER_BY_TYPES.article
    ? ORDER_BY_TYPES.article
    : ORDER_BY_TYPES.sku;
};

const normalizeRateType = ({ value, stockType }) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  if (stockType === STOCK_TYPES.rawMaterial) {
    if (normalized === RATE_TYPES.rmFixed) return RATE_TYPES.rmFixed;
    return RATE_TYPES.rmWeightedAverage;
  }

  if (stockType === STOCK_TYPES.finished) {
    return normalized === RATE_TYPES.cost ? RATE_TYPES.cost : RATE_TYPES.sale;
  }

  return RATE_TYPES.cost;
};

const normalizeStockStatus = (value) => {
  const normalized = String(value || STOCK_STATUS_TYPES.packed)
    .trim()
    .toUpperCase();
  if (normalized === STOCK_STATUS_TYPES.packed)
    return STOCK_STATUS_TYPES.packed;
  if (normalized === STOCK_STATUS_TYPES.loose) return STOCK_STATUS_TYPES.loose;
  return STOCK_STATUS_TYPES.packed;
};

const getItemTypesFromStockType = (stockType) => {
  if (stockType === STOCK_TYPES.finished) return ["FG"];
  if (stockType === STOCK_TYPES.semiFinished) return ["SFG"];
  if (stockType === STOCK_TYPES.rawMaterial) return ["RM"];
  return ["FG"];
};

const getSkuCategoriesFromStockType = (stockType) => {
  if (stockType === STOCK_TYPES.finished) return ["FG"];
  if (stockType === STOCK_TYPES.semiFinished) return ["SFG"];
  if (stockType === STOCK_TYPES.rawMaterial) return [];
  return ["FG"];
};

const parseFilters = ({ req, input = {}, includeRateTypeFilter = true }) => {
  const today = toLocalDateOnly(new Date());
  const parsedAsOfDate = parseDateFilter(
    input.as_of_date || input.asOfDate,
    today,
  );
  const stockType = normalizeStockType(input.stock_type || input.stockType);
  const viewType = normalizeViewType(input.view_filter || input.viewType);
  const orderBy = normalizeOrderBy(input.order_by || input.orderBy);
  const rateType = includeRateTypeFilter
    ? normalizeRateType({
        value: input.rate_type || input.rateType,
        stockType,
      })
    : RATE_TYPES.cost;
  const stockStatus =
    stockType === STOCK_TYPES.finished
      ? normalizeStockStatus(input.stock_status || input.stockStatus)
      : null;

  return {
    reportLoaded: toBoolean(input.load_report || input.loadReport, false),
    asOfDate: parsedAsOfDate.value,
    stockType,
    rateType,
    stockStatus,
    viewType,
    orderBy,
    unitId: toPositiveInt(input.unit_id || input.unitId),
    branchIds: normalizeBranchFilter({ req, input }),
    productGroupIds: toIdListWithAll(
      input.product_group_ids || input.productGroupIds,
    ),
    productSubgroupIds: toIdListWithAll(
      input.product_subgroup_ids || input.productSubgroupIds,
    ),
    invalidAsOfDate: Boolean(parsedAsOfDate.provided && !parsedAsOfDate.valid),
    invalidFilterInput: Boolean(
      parsedAsOfDate.provided && !parsedAsOfDate.valid,
    ),
  };
};

const resolveDefaultSemifinishedUnit = ({ unitOptions = [] }) => {
  const normalizedOptions = Array.isArray(unitOptions) ? unitOptions : [];
  if (!normalizedOptions.length) return null;

  const byCode = normalizedOptions.find((unit) => {
    const code = String(unit?.code || "").trim().toUpperCase();
    return code === "DZN" || code === "DOZEN";
  });
  if (byCode) return byCode;

  const byName = normalizedOptions.find((unit) => {
    const name = String(unit?.name || "").trim().toUpperCase();
    return name === "DOZEN" || name === "DZN";
  });
  if (byName) return byName;

  return normalizedOptions[0] || null;
};

const resolveSemifinishedUnitSelection = ({ filters, unitOptions = [] }) => {
  if (
    String(filters?.stockType || "").toUpperCase() !== STOCK_TYPES.semiFinished
  ) {
    return { unitId: null, unitLabel: "" };
  }

  const requestedUnitId = toPositiveInt(filters?.unitId);
  if (!requestedUnitId) {
    const defaultUnit = resolveDefaultSemifinishedUnit({ unitOptions });
    if (!defaultUnit) {
      return { unitId: null, unitLabel: "" };
    }
    return {
      unitId: Number(defaultUnit.id),
      unitLabel: String(defaultUnit.code || defaultUnit.name || "").trim(),
    };
  }

  const selected = (unitOptions || []).find(
    (unit) => Number(unit?.id || 0) === Number(requestedUnitId),
  );
  if (!selected) {
    return { unitId: null, unitLabel: "" };
  }

  return {
    unitId: Number(selected.id),
    unitLabel: String(selected.code || selected.name || "").trim(),
  };
};

const loadBranchOptions = async (req) => {
  if (req?.user?.isAdmin) {
    return knex("erp.branches")
      .select("id", "name")
      .where({ is_active: true })
      .orderBy("name", "asc");
  }

  if (Array.isArray(req?.branchOptions) && req.branchOptions.length) {
    return req.branchOptions
      .map((row) => ({
        id: Number(row.id),
        name: String(row.name || ""),
      }))
      .filter((row) => row.id > 0)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }

  const allowed = getAllowedBranchIds(req);
  if (!allowed.length) return [];
  return knex("erp.branches")
    .select("id", "name")
    .whereIn("id", allowed)
    .orderBy("name", "asc");
};

const loadProductGroupOptions = async (stockType) => {
  const itemTypes = getItemTypesFromStockType(stockType);
  return knex("erp.product_groups as pg")
    .select("pg.id", "pg.name")
    .where({ "pg.is_active": true })
    .whereExists(function whereMatchingItems() {
      this.select(1)
        .from("erp.items as i")
        .whereRaw("i.group_id = pg.id")
        .andWhere("i.is_active", true)
        .whereIn("i.item_type", itemTypes);
    })
    .orderBy("pg.name", "asc");
};

const loadProductSubgroupOptions = async (stockType) => {
  const itemTypes = getItemTypesFromStockType(stockType);
  return knex("erp.product_subgroups as sg")
    .select("sg.id", "sg.name", "sg.group_id")
    .where({ "sg.is_active": true })
    .whereExists(function whereMatchingItems() {
      this.select(1)
        .from("erp.items as i")
        .whereRaw("i.subgroup_id = sg.id")
        .andWhere("i.is_active", true)
        .whereIn("i.item_type", itemTypes);
    })
    .orderBy("sg.name", "asc");
};

const buildUomGraph = (conversionRows) => {
  const graph = new Map();

  const addEdge = (fromId, toId, factor) => {
    if (!fromId || !toId || !(factor > 0)) return;
    if (!graph.has(fromId)) graph.set(fromId, []);
    graph.get(fromId).push({ toId, factor });
  };

  (conversionRows || []).forEach((row) => {
    const fromId = toPositiveInt(row?.from_uom_id);
    const toId = toPositiveInt(row?.to_uom_id);
    const factor = Number(row?.factor || 0);
    if (!fromId || !toId || !(factor > 0)) return;
    addEdge(Number(fromId), Number(toId), factor);
    addEdge(Number(toId), Number(fromId), 1 / factor);
  });

  return graph;
};

const getConversionFactor = ({ graph, fromUomId, toUomId }) => {
  const source = toPositiveInt(fromUomId);
  const target = toPositiveInt(toUomId);
  if (!source || !target) return null;
  if (source === target) return 1;

  const queue = [{ id: Number(source), factor: 1 }];
  const visited = new Set([Number(source)]);

  while (queue.length) {
    const current = queue.shift();
    const edges = graph.get(Number(current.id)) || [];
    for (const edge of edges) {
      const nextId = Number(edge.toId);
      if (visited.has(nextId)) continue;
      const nextFactor = Number(current.factor) * Number(edge.factor || 0);
      if (!(nextFactor > 0)) continue;
      if (nextId === Number(target)) return nextFactor;
      visited.add(nextId);
      queue.push({ id: nextId, factor: nextFactor });
    }
  }

  return null;
};

const collectReachableUomIds = ({ graph, sourceUomId }) => {
  const source = toPositiveInt(sourceUomId);
  if (!source) return [];

  const queue = [Number(source)];
  const visited = new Set([Number(source)]);
  while (queue.length) {
    const current = queue.shift();
    const edges = graph.get(Number(current)) || [];
    for (const edge of edges) {
      const nextId = Number(edge.toId);
      if (!nextId || visited.has(nextId)) continue;
      visited.add(nextId);
      queue.push(nextId);
    }
  }

  return [...visited];
};

const loadUnitOptions = async (stockType) => {
  if (stockType === STOCK_TYPES.rawMaterial) return [];

  const skuCategories = getSkuCategoriesFromStockType(stockType);
  if (!skuCategories.length) return [];

  const [baseRows, uomRows, conversionRows] = await Promise.all([
    knex("erp.items as i")
      .distinct("i.base_uom_id")
      .where({ "i.is_active": true })
      .whereIn("i.item_type", skuCategories)
      .whereNotNull("i.base_uom_id"),
    knex("erp.uom")
      .select("id", "code", "name")
      .where({ is_active: true })
      .orderBy("name", "asc"),
    knex("erp.uom_conversions")
      .select("from_uom_id", "to_uom_id", "factor")
      .where({ is_active: true }),
  ]);

  const graph = buildUomGraph(conversionRows);
  const optionIds = new Set();

  (baseRows || []).forEach((row) => {
    const baseUomId = toPositiveInt(row?.base_uom_id);
    if (!baseUomId) return;
    optionIds.add(Number(baseUomId));
    collectReachableUomIds({ graph, sourceUomId: baseUomId }).forEach(
      (uomId) => {
        optionIds.add(Number(uomId));
      },
    );
  });

  return (uomRows || [])
    .filter((row) => optionIds.has(Number(row.id)))
    .map((row) => ({
      id: Number(row.id),
      code: String(row.code || "").trim(),
      name: String(row.name || "").trim(),
    }));
};

const loadUomContext = async () => {
  const [uomRows, conversionRows] = await Promise.all([
    knex("erp.uom")
      .select("id", "code", "name")
      .where({ is_active: true })
      .orderBy("name", "asc"),
    knex("erp.uom_conversions")
      .select("from_uom_id", "to_uom_id", "factor")
      .where({ is_active: true }),
  ]);

  const uomById = new Map(
    (uomRows || []).map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        code: String(row.code || "").trim(),
        name: String(row.name || "").trim(),
      },
    ]),
  );

  return {
    uomById,
    graph: buildUomGraph(conversionRows),
  };
};

const getUnitLabel = ({ uomById, unitId, fallbackCode, fallbackName }) => {
  if (unitId && uomById.has(Number(unitId))) {
    const uom = uomById.get(Number(unitId));
    return String(uom?.code || uom?.name || "").trim() || "-";
  }
  return String(fallbackCode || fallbackName || "").trim() || "-";
};

const isPairUomOption = (unit) => {
  const code = String(unit?.code || "")
    .trim()
    .toUpperCase();
  const name = String(unit?.name || "")
    .trim()
    .toUpperCase();
  return code === "PAIR" || name === "PAIR" || name === "PAIRS";
};

const resolvePackedConversionUnits = ({ filters, unitOptions = [] }) => {
  if (
    String(filters?.stockType || "").toUpperCase() !== STOCK_TYPES.finished ||
    String(filters?.stockStatus || "").toUpperCase() !==
      STOCK_STATUS_TYPES.packed
  ) {
    return [];
  }
  return (unitOptions || []).filter((unit) => !isPairUomOption(unit));
};

const sumConvertedQuantities = (rows, conversionUnits) => {
  const totals = {};
  (conversionUnits || []).forEach((unit) => {
    const unitId = Number(unit?.id || 0);
    if (!unitId) return;
    totals[unitId] = 0;
  });

  (rows || []).forEach((row) => {
    const converted = row?.convertedQuantities || {};
    Object.keys(totals).forEach((unitId) => {
      totals[unitId] = toQuantity(
        Number(totals[unitId] || 0) + Number(converted[unitId] || 0),
        3,
      );
    });
  });

  return totals;
};

const loadFgSfgDetailRows = async ({
  filters,
  selectedUnitId,
  uomContext,
  conversionUnits = [],
  includeAmounts = true,
}) => {
  const skuCategories = getSkuCategoriesFromStockType(filters.stockType);
  if (!skuCategories.length) return [];

  const netQtyPairsSql =
    "SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END)";
  const packedFlagSql = FG_PACKED_FLAG_SQL;

  let query = knex("erp.stock_ledger as sl")
    .join("erp.skus as s", "s.id", "sl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .leftJoin("erp.branches as b", "b.id", "sl.branch_id")
    .select(
      "sl.branch_id",
      "b.name as branch_name",
      "sl.category",
      "s.id as sku_id",
      "s.sku_code",
      "i.id as article_id",
      "i.name as article_name",
      "i.group_id",
      "pg.name as group_name",
      "i.subgroup_id",
      "sg.name as subgroup_name",
      knex.raw(`${packedFlagSql} as is_packed`),
      "i.base_uom_id",
      "v.sale_rate",
      "u.code as base_uom_code",
      "u.name as base_uom_name",
    )
    .select(knex.raw(`${netQtyPairsSql} as qty_pairs`))
    .select(knex.raw("SUM(COALESCE(sl.value, 0)) as total_amount"))
    .where({ "sl.stock_state": "ON_HAND" })
    .whereIn("sl.category", skuCategories)
    .where("sl.txn_date", "<=", filters.asOfDate)
    .groupBy(
      "sl.branch_id",
      "b.name",
      "sl.category",
      "s.id",
      "s.sku_code",
      "i.id",
      "i.name",
      "i.group_id",
      "pg.name",
      "i.subgroup_id",
      "sg.name",
      knex.raw(packedFlagSql),
      "i.base_uom_id",
      "v.sale_rate",
      "u.code",
      "u.name",
    );

  if (filters.branchIds.length)
    query = query.whereIn("sl.branch_id", filters.branchIds);
  if (filters.productGroupIds.length) {
    query = query.whereIn("i.group_id", filters.productGroupIds);
  }
  if (filters.productSubgroupIds.length) {
    query = query.whereIn("i.subgroup_id", filters.productSubgroupIds);
  }
  if (filters.stockType === STOCK_TYPES.finished) {
    const targetStatus = normalizeStockStatus(filters.stockStatus);
    query =
      targetStatus === STOCK_STATUS_TYPES.loose
        ? query.whereRaw(`${packedFlagSql} = false`)
        : query.whereRaw(`${packedFlagSql} = true`);
  }

  if (filters.orderBy === ORDER_BY_TYPES.article) {
    query = query.orderBy("i.name", "asc").orderBy("s.sku_code", "asc");
  } else {
    query = query.orderBy("s.sku_code", "asc").orderBy("i.name", "asc");
  }

  const rows = await query;

  return rows
    .map((row) => {
      const qtyPairs = Number(row?.qty_pairs || 0);
      if (!hasNonZeroQuantity(qtyPairs)) return null;

      const baseUomId = toPositiveInt(row?.base_uom_id);
      let conversionFactor = 1;
      if (selectedUnitId) {
        conversionFactor =
          getConversionFactor({
            graph: uomContext.graph,
            fromUomId: baseUomId,
            toUomId: selectedUnitId,
          }) || 0;
      }
      if (!(conversionFactor > 0)) return null;

      const quantity = toQuantity(qtyPairs * conversionFactor, 3);
      if (!hasNonZeroQuantity(quantity)) return null;

      const pairQuantity = toQuantity(qtyPairs, 3);
      const convertedQuantities = {};
      (conversionUnits || []).forEach((unit) => {
        const targetUomId = toPositiveInt(unit?.id);
        if (!targetUomId) return;
        const factor =
          getConversionFactor({
            graph: uomContext.graph,
            fromUomId: baseUomId,
            toUomId: targetUomId,
          }) || 0;
        if (!(factor > 0)) {
          convertedQuantities[targetUomId] = 0;
          return;
        }
        convertedQuantities[targetUomId] = toQuantity(qtyPairs * factor, 3);
      });

      const stockType = String(row?.category || "")
        .trim()
        .toUpperCase();
      const costAmount = toAmount(row?.total_amount, 2);
      const costRate = hasNonZeroQuantity(quantity)
        ? toAmount(costAmount / quantity, 4)
        : 0;
      const saleRate =
        stockType === STOCK_TYPES.finished ? toAmount(row?.sale_rate, 4) : 0;
      const isFgWithSaleBasis =
        stockType === STOCK_TYPES.finished &&
        filters.rateType === RATE_TYPES.sale;
      const rate = isFgWithSaleBasis ? saleRate : costRate;
      const amount = isFgWithSaleBasis
        ? toAmount(quantity * rate, 2)
        : costAmount;

      const detailRow = {
        branch_id: Number(row?.branch_id || 0) || null,
        branch_name: String(row?.branch_name || "").trim(),
        stock_type: stockType,
        is_packed: Boolean(row?.is_packed),
        stock_status: Boolean(row?.is_packed)
          ? STOCK_STATUS_TYPES.packed
          : STOCK_STATUS_TYPES.loose,
        sku_id: Number(row?.sku_id || 0) || null,
        sku_code: String(row?.sku_code || "").trim(),
        article_id: Number(row?.article_id || 0) || null,
        article_name: String(row?.article_name || "").trim(),
        group_id: Number(row?.group_id || 0) || null,
        subgroup_id: Number(row?.subgroup_id || 0) || null,
        unit_label: getUnitLabel({
          uomById: uomContext.uomById,
          unitId: selectedUnitId,
          fallbackCode: row?.base_uom_code,
          fallbackName: row?.base_uom_name,
        }),
        quantity,
        pairQuantity,
        convertedQuantities,
      };
      if (includeAmounts) {
        detailRow.rate = rate;
        detailRow.amount = amount;
      }
      return detailRow;
    })
    .filter(Boolean);
};

const loadRmDetailRows = async ({
  filters,
  includeAmounts = true,
  rmRateType = RATE_TYPES.rmWeightedAverage,
}) => {
  if (filters.stockType !== STOCK_TYPES.rawMaterial) {
    return [];
  }

  const netQtySql =
    "SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty, 0) ELSE -COALESCE(sl.qty, 0) END)";

  let query = knex("erp.stock_ledger as sl")
    .join("erp.items as i", "i.id", "sl.item_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
    .leftJoin("erp.colors as c", "c.id", "sl.color_id")
    .leftJoin("erp.sizes as sz", "sz.id", "sl.size_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .leftJoin("erp.branches as b", "b.id", "sl.branch_id")
    .select(
      "sl.branch_id",
      "b.name as branch_name",
      "sl.item_id",
      "i.name as item_name",
      "i.group_id",
      "pg.name as group_name",
      "i.subgroup_id",
      "sg.name as subgroup_name",
      "sl.color_id",
      "c.name as color_name",
      "sl.size_id",
      "sz.name as size_name",
      "i.base_uom_id",
      "u.code as base_uom_code",
      "u.name as base_uom_name",
    )
    .select(knex.raw(`${netQtySql} as qty`))
    .select(knex.raw("SUM(COALESCE(sl.value, 0)) as total_amount"))
    .where({ "sl.stock_state": "ON_HAND", "sl.category": "RM" })
    .where("sl.txn_date", "<=", filters.asOfDate)
    .groupBy(
      "sl.branch_id",
      "b.name",
      "sl.item_id",
      "i.name",
      "i.group_id",
      "pg.name",
      "i.subgroup_id",
      "sg.name",
      "sl.color_id",
      "c.name",
      "sl.size_id",
      "sz.name",
      "i.base_uom_id",
      "u.code",
      "u.name",
    );

  if (filters.branchIds.length)
    query = query.whereIn("sl.branch_id", filters.branchIds);
  if (filters.productGroupIds.length) {
    query = query.whereIn("i.group_id", filters.productGroupIds);
  }
  if (filters.productSubgroupIds.length) {
    query = query.whereIn("i.subgroup_id", filters.productSubgroupIds);
  }

  const rows = await query
    .orderBy("i.name", "asc")
    .orderBy("c.name", "asc")
    .orderBy("sz.name", "asc");

  let rmRateByIdentity = new Map();
  let rmRatesByItem = new Map();
  if (includeAmounts) {
    const rmItemIds = [
      ...new Set(
        (rows || []).map((row) => toPositiveInt(row?.item_id)).filter(Boolean),
      ),
    ];
    if (rmItemIds.length) {
      const rateRows = await knex("erp.rm_purchase_rates as r")
        .select(
          "r.id",
          "r.rm_item_id",
          "r.color_id",
          "r.size_id",
          "r.avg_purchase_rate",
          "r.purchase_rate",
        )
        .whereIn("r.rm_item_id", rmItemIds)
        .andWhere("r.is_active", true)
        .orderBy("r.id", "desc");

      (rateRows || []).forEach((row) => {
        const itemId = toPositiveInt(row?.rm_item_id);
        if (!itemId) return;
        const colorId = toPositiveInt(row?.color_id) || 0;
        const sizeId = toPositiveInt(row?.size_id) || 0;
        const avgRate = Number(row?.avg_purchase_rate || 0);
        const purchaseRate = Number(row?.purchase_rate || 0);
        const resolvedAvgRate =
          Number.isFinite(avgRate) && avgRate > 0 ? avgRate : 0;
        const resolvedPurchaseRate =
          Number.isFinite(purchaseRate) && purchaseRate > 0 ? purchaseRate : 0;
        if (!(resolvedAvgRate > 0) && !(resolvedPurchaseRate > 0)) return;

        const ratePayload = {
          avgRate: Number(resolvedAvgRate.toFixed(4)),
          purchaseRate: Number(resolvedPurchaseRate.toFixed(4)),
        };

        const identityKey = `${Number(itemId)}:${Number(colorId)}:${Number(sizeId)}`;
        if (!rmRateByIdentity.has(identityKey)) {
          rmRateByIdentity.set(identityKey, ratePayload);
        }

        const itemKey = Number(itemId);
        if (!rmRatesByItem.has(itemKey)) rmRatesByItem.set(itemKey, []);
        rmRatesByItem.get(itemKey).push(ratePayload);
      });
    }
  }

  const resolveRateByTypePreference = ({ candidates = [], rateType }) => {
    for (const candidate of candidates) {
      const avgRate = Number(candidate?.avgRate || 0);
      const purchaseRate = Number(candidate?.purchaseRate || 0);

      if (rateType === RATE_TYPES.rmFixed) {
        if (purchaseRate > 0) return Number(purchaseRate.toFixed(4));
        if (avgRate > 0) return Number(avgRate.toFixed(4));
      } else {
        if (avgRate > 0) return Number(avgRate.toFixed(4));
        if (purchaseRate > 0) return Number(purchaseRate.toFixed(4));
      }
    }
    return 0;
  };

  const resolveRmSelectedRate = ({
    itemId,
    colorId = null,
    sizeId = null,
    rateType = RATE_TYPES.rmWeightedAverage,
  }) => {
    const normalizedItemId = toPositiveInt(itemId);
    if (!normalizedItemId) return 0;
    const normalizedColorId = toPositiveInt(colorId) || 0;
    const normalizedSizeId = toPositiveInt(sizeId) || 0;
    const keys = [
      `${normalizedItemId}:${normalizedColorId}:${normalizedSizeId}`,
      `${normalizedItemId}:${normalizedColorId}:0`,
      `${normalizedItemId}:0:${normalizedSizeId}`,
      `${normalizedItemId}:0:0`,
    ];
    const identityCandidates = [];
    for (const key of keys) {
      const value = rmRateByIdentity.get(key);
      if (!value || typeof value !== "object") continue;
      identityCandidates.push(value);
    }

    const directMatchRate = resolveRateByTypePreference({
      candidates: identityCandidates,
      rateType,
    });
    if (directMatchRate > 0) return directMatchRate;

    return resolveRateByTypePreference({
      candidates: rmRatesByItem.get(Number(normalizedItemId)) || [],
      rateType,
    });
  };

  return rows
    .map((row) => {
      const quantity = toQuantity(row?.qty, 3);
      if (!hasNonZeroQuantity(quantity)) return null;

      const detailRow = {
        branch_id: Number(row?.branch_id || 0) || null,
        branch_name: String(row?.branch_name || "").trim(),
        item_id: Number(row?.item_id || 0) || null,
        item_name: String(row?.item_name || "").trim(),
        color_id: toPositiveInt(row?.color_id),
        color_name: String(row?.color_name || "").trim(),
        size_id: toPositiveInt(row?.size_id),
        size_name: String(row?.size_name || "").trim(),
        unit_label: getUnitLabel({
          uomById: new Map(),
          unitId: null,
          fallbackCode: row?.base_uom_code,
          fallbackName: row?.base_uom_name,
        }),
        quantity,
      };
      if (includeAmounts) {
        let amount = toAmount(row?.total_amount, 2);
        let rate = hasNonZeroQuantity(quantity)
          ? toAmount(amount / quantity, 4)
          : 0;

        const selectedRate = resolveRmSelectedRate({
          itemId: row?.item_id,
          colorId: row?.color_id,
          sizeId: row?.size_id,
          rateType: rmRateType,
        });
        if (selectedRate > 0) {
          rate = Number(selectedRate.toFixed(4));
          amount = toAmount(quantity * rate, 2);
        }

        detailRow.rate = rate;
        detailRow.amount = amount;
      }

      return detailRow;
    })
    .filter(Boolean);
};

const buildFgSfgSummaryRows = (
  detailRows,
  { includeAmounts = true, orderBy = ORDER_BY_TYPES.sku } = {},
) => {
  const groupByArticle = orderBy === ORDER_BY_TYPES.article;
  const grouped = new Map();

  (detailRows || []).forEach((row) => {
    const articleId = Number(row.article_id || 0) || 0;
    const skuId = Number(row.sku_id || 0) || 0;
    const stockType = String(row.stock_type || "").trim();
    const key = groupByArticle
      ? `article:${articleId || String(row.article_name || "").trim()}:${stockType}`
      : `sku:${skuId || String(row.sku_code || "").trim()}:${stockType}`;
    const rowUnitLabel = String(row.unit_label || "").trim() || "-";
    const existing = grouped.get(key) || {
      sku_id: groupByArticle ? null : Number(row.sku_id || 0) || null,
      sku_code: groupByArticle ? "" : String(row.sku_code || "").trim(),
      article_id: Number(row.article_id || 0) || null,
      article_name: String(row.article_name || "").trim(),
      stock_type: stockType,
      unit_label: rowUnitLabel,
      quantity: 0,
      pairQuantity: 0,
      convertedQuantities: {},
      amount: includeAmounts ? 0 : undefined,
    };
    if (!groupByArticle) {
      existing.sku_id = Number(row.sku_id || 0) || existing.sku_id || null;
      existing.sku_code =
        String(row.sku_code || "").trim() || existing.sku_code || "";
    }
    if (existing.unit_label !== rowUnitLabel) {
      existing.unit_label = "-";
    }
    existing.quantity = toQuantity(
      existing.quantity + Number(row.quantity || 0),
      3,
    );
    existing.pairQuantity = toQuantity(
      Number(existing.pairQuantity || 0) +
        Number(row.pairQuantity || row.quantity || 0),
      3,
    );
    const rowConverted = row?.convertedQuantities || {};
    Object.keys(rowConverted).forEach((unitId) => {
      existing.convertedQuantities[unitId] = toQuantity(
        Number(existing.convertedQuantities[unitId] || 0) +
          Number(rowConverted[unitId] || 0),
        3,
      );
    });
    if (includeAmounts) {
      existing.amount = toAmount(
        Number(existing.amount || 0) + Number(row.amount || 0),
        2,
      );
    }
    grouped.set(key, existing);
  });

  return [...grouped.values()]
    .map((row) => {
      if (!includeAmounts) {
        return {
          sku_id: row.sku_id,
          sku_code: row.sku_code,
          article_id: row.article_id,
          article_name: row.article_name,
          stock_type: row.stock_type,
          unit_label: row.unit_label,
          quantity: row.quantity,
          pairQuantity: row.pairQuantity,
          convertedQuantities: row.convertedQuantities,
        };
      }
      return {
        ...row,
        rate: hasNonZeroQuantity(row.quantity)
          ? toAmount(row.amount / row.quantity, 4)
          : 0,
      };
    })
    .sort((a, b) => {
      if (orderBy === ORDER_BY_TYPES.article) {
        const articleCompare = String(a.article_name || "").localeCompare(
          String(b.article_name || ""),
        );
        if (articleCompare !== 0) return articleCompare;
      }
      const skuCompare = String(a.sku_code || "").localeCompare(
        String(b.sku_code || ""),
      );
      if (skuCompare !== 0) return skuCompare;
      return String(a.article_name || "").localeCompare(
        String(b.article_name || ""),
      );
    });
};

const buildRmSummaryRows = (detailRows) => {
  const grouped = new Map();

  (detailRows || []).forEach((row) => {
    const key = `${Number(row.item_id || 0)}:${String(row.unit_label || "")}`;
    const existing = grouped.get(key) || {
      item_id: Number(row.item_id || 0) || null,
      item_name: String(row.item_name || "").trim(),
      unit_label: String(row.unit_label || "").trim() || "-",
      quantity: 0,
    };
    existing.quantity = toQuantity(
      existing.quantity + Number(row.quantity || 0),
      3,
    );
    grouped.set(key, existing);
  });

  return [...grouped.values()].sort((a, b) =>
    String(a.item_name || "").localeCompare(String(b.item_name || "")),
  );
};

const buildDefaultReportData = ({ includeAmounts = true } = {}) => ({
  fgSfgDetailRows: [],
  rmDetailRows: [],
  fgSfgSummaryRows: [],
  rmSummaryRows: [],
  totals: {
    fgSfgQuantity: 0,
    fgSfgAmount: includeAmounts ? 0 : null,
    rmQuantity: 0,
    rmAmount: includeAmounts ? 0 : null,
  },
});

const getInventoryStockReportPageData = async ({
  req,
  input = {},
  includeAmounts = true,
}) => {
  const filters = parseFilters({
    req,
    input,
    includeRateTypeFilter: includeAmounts,
  });

  const [branches, productGroups, productSubgroups, unitOptions] =
    await Promise.all([
      loadBranchOptions(req),
      loadProductGroupOptions(filters.stockType),
      loadProductSubgroupOptions(filters.stockType),
      loadUnitOptions(filters.stockType),
    ]);
  const conversionUnits = resolvePackedConversionUnits({
    filters,
    unitOptions,
  });
  const selectedUnit = resolveSemifinishedUnitSelection({
    filters,
    unitOptions,
  });
  if (
    filters.stockType === STOCK_TYPES.semiFinished &&
    filters.unitId &&
    !selectedUnit.unitId
  ) {
    filters.invalidFilterInput = true;
  }
  const selectedUnitId = selectedUnit.unitId;
  filters.unitId = selectedUnit.unitId;
  filters.unitLabel = selectedUnit.unitLabel;

  const rateTypesByStockType = includeAmounts
    ? {
        [STOCK_TYPES.finished]: [
          { value: RATE_TYPES.sale, labelKey: "sale_rate_basis" },
          { value: RATE_TYPES.cost, labelKey: "cost_rate_basis" },
        ],
        [STOCK_TYPES.rawMaterial]: [
          { value: RATE_TYPES.rmFixed, labelKey: "purchase_rate" },
          {
            value: RATE_TYPES.rmWeightedAverage,
            labelKey: "avg_purchase_rate",
          },
        ],
        [STOCK_TYPES.semiFinished]: [],
      }
    : {
        [STOCK_TYPES.finished]: [],
        [STOCK_TYPES.rawMaterial]: [],
        [STOCK_TYPES.semiFinished]: [],
      };

  const options = {
    branches,
    productGroups,
    productSubgroups,
    stockTypes: [
      { value: STOCK_TYPES.finished, labelKey: "finished" },
      { value: STOCK_TYPES.semiFinished, labelKey: "semi_finished" },
      { value: STOCK_TYPES.rawMaterial, labelKey: "raw_materials" },
    ],
    orderByOptions: [
      { value: ORDER_BY_TYPES.sku, labelKey: "sku" },
      { value: ORDER_BY_TYPES.article, labelKey: "article" },
    ],
    viewFilters: [
      { value: VIEW_TYPES.details, labelKey: "details" },
      { value: VIEW_TYPES.summary, labelKey: "summary" },
    ],
    stockStatuses: [
      { value: STOCK_STATUS_TYPES.packed, labelKey: "packed" },
      { value: STOCK_STATUS_TYPES.loose, labelKey: "loose" },
    ],
    unitOptions,
    conversionUnits,
    rateTypesByStockType,
    rateTypes: Array.isArray(rateTypesByStockType[filters.stockType])
      ? rateTypesByStockType[filters.stockType]
      : [],
  };

  if (!filters.reportLoaded) {
    return {
      filters,
      options,
      reportData: buildDefaultReportData({ includeAmounts }),
    };
  }

  const uomContext = await loadUomContext();

  const [fgSfgDetailRows, rmDetailRows] = await Promise.all([
    loadFgSfgDetailRows({
      filters,
      selectedUnitId,
      uomContext,
      conversionUnits,
      includeAmounts,
    }),
    loadRmDetailRows({
      filters,
      includeAmounts,
      rmRateType: filters.rateType,
    }),
  ]);

  const fgSfgSummaryRows = buildFgSfgSummaryRows(fgSfgDetailRows, {
    includeAmounts,
    orderBy: filters.orderBy,
  });
  const rmSummaryRows = buildRmSummaryRows(rmDetailRows, { includeAmounts });

  const totals = {
    fgSfgQuantity: toQuantity(
      fgSfgDetailRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      3,
    ),
    fgSfgPairQuantity: toQuantity(
      fgSfgDetailRows.reduce(
        (sum, row) => sum + Number(row.pairQuantity || row.quantity || 0),
        0,
      ),
      3,
    ),
    fgSfgConvertedQuantities: sumConvertedQuantities(
      fgSfgDetailRows,
      conversionUnits,
    ),
    rmQuantity: toQuantity(
      rmDetailRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      3,
    ),
    rmAmount: includeAmounts
      ? toAmount(
          rmDetailRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
          2,
        )
      : null,
    fgSfgAmount: includeAmounts
      ? toAmount(
          fgSfgDetailRows.reduce(
            (sum, row) => sum + Number(row.amount || 0),
            0,
          ),
          2,
        )
      : null,
  };
  if (!includeAmounts) {
    delete totals.fgSfgAmount;
    delete totals.rmAmount;
  }

  return {
    filters,
    options,
    reportData: {
      fgSfgDetailRows,
      rmDetailRows,
      fgSfgSummaryRows,
      rmSummaryRows,
      totals,
    },
  };
};

const getDefaultLedgerDateRange = () => {
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 30);
  return {
    today: toLocalDateOnly(now),
    defaultFrom: toLocalDateOnly(fromDate),
  };
};

const getMovementVoucherCodeBuckets = () => {
  const toNormalizedList = (codes) =>
    [...new Set((codes || []).map((code) => String(code || "").trim()))]
      .filter(Boolean)
      .map((code) => code.toUpperCase());

  const production = toNormalizedList(MOVEMENT_VOUCHER_CODES.production);
  const purchase = toNormalizedList(MOVEMENT_VOUCHER_CODES.purchase);
  const sale = toNormalizedList(MOVEMENT_VOUCHER_CODES.sale);
  const allClassified = [...new Set([...production, ...purchase, ...sale])];

  return {
    production,
    purchase,
    sale,
    allClassified,
  };
};

const parseStockMovementFilters = ({ req, input = {} }) => {
  const { today, defaultFrom } = getDefaultLedgerDateRange();
  const parsedFrom = parseDateFilter(
    input.from_date || input.fromDate,
    defaultFrom,
  );
  const parsedTo = parseDateFilter(input.to_date || input.toDate, today);

  let from = parsedFrom.value;
  let to = parsedTo.value;
  let invalidDateRange = false;
  if (from > to) {
    from = defaultFrom;
    to = today;
    invalidDateRange = true;
  }

  const stockType = normalizeStockType(
    input.stock_type || input.stockType || STOCK_TYPES.finished,
  );
  const stockStatus =
    stockType === STOCK_TYPES.finished
      ? normalizeStockStatus(input.stock_status || input.stockStatus)
      : null;
  const viewType = normalizeViewType(
    input.view_filter ||
      input.viewType ||
      input.report_type ||
      input.reportType,
  );
  const orderBy = normalizeOrderBy(input.order_by || input.orderBy);
  const reportLoaded = toBoolean(input.load_report || input.loadReport, false);

  return {
    reportLoaded,
    from,
    to,
    stockType,
    stockStatus,
    unitId: toPositiveInt(input.unit_id || input.unitId),
    viewType,
    orderBy,
    branchIds: normalizeBranchFilter({ req, input }),
    productGroupIds: toIdListWithAll(
      input.product_group_ids || input.productGroupIds,
    ),
    productSubgroupIds: toIdListWithAll(
      input.product_subgroup_ids || input.productSubgroupIds,
    ),
    articleIds:
      stockType === STOCK_TYPES.rawMaterial
        ? []
        : toIdListWithAll(input.article_ids || input.articleIds),
    stockItemIds: toIdListWithAll(
      input.stock_item_ids ||
        input.stockItemIds ||
        input.sku_ids ||
        input.skuIds ||
        input.raw_material_ids ||
        input.rawMaterialIds ||
        input.item_ids ||
        input.itemIds,
    ),
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

const loadProductGroupOptionsByType = async () => {
  const [finished, semiFinished, rawMaterial] = await Promise.all([
    loadProductGroupOptions(STOCK_TYPES.finished),
    loadProductGroupOptions(STOCK_TYPES.semiFinished),
    loadProductGroupOptions(STOCK_TYPES.rawMaterial),
  ]);

  return {
    [STOCK_TYPES.finished]: finished,
    [STOCK_TYPES.semiFinished]: semiFinished,
    [STOCK_TYPES.rawMaterial]: rawMaterial,
  };
};

const loadProductSubgroupOptionsByType = async () => {
  const [finished, semiFinished, rawMaterial] = await Promise.all([
    loadProductSubgroupOptions(STOCK_TYPES.finished),
    loadProductSubgroupOptions(STOCK_TYPES.semiFinished),
    loadProductSubgroupOptions(STOCK_TYPES.rawMaterial),
  ]);

  return {
    [STOCK_TYPES.finished]: finished,
    [STOCK_TYPES.semiFinished]: semiFinished,
    [STOCK_TYPES.rawMaterial]: rawMaterial,
  };
};

const loadStockMovementArticleOptionsForType = async (stockType) => {
  if (
    stockType !== STOCK_TYPES.finished &&
    stockType !== STOCK_TYPES.semiFinished
  ) {
    return [];
  }

  const itemTypes = getItemTypesFromStockType(stockType);
  const rows = await knex("erp.items as i")
    .select("i.id", "i.name")
    .where({ "i.is_active": true })
    .whereIn("i.item_type", itemTypes)
    .orderBy("i.name", "asc");

  return (rows || []).map((row) => ({
    id: Number(row.id),
    name: String(row.name || "").trim(),
  }));
};

const loadStockMovementArticleOptionsByType = async () => {
  const [finished, semiFinished] = await Promise.all([
    loadStockMovementArticleOptionsForType(STOCK_TYPES.finished),
    loadStockMovementArticleOptionsForType(STOCK_TYPES.semiFinished),
  ]);

  return {
    [STOCK_TYPES.finished]: finished,
    [STOCK_TYPES.semiFinished]: semiFinished,
    [STOCK_TYPES.rawMaterial]: [],
  };
};

const loadStockMovementItemsForType = async (stockType) => {
  if (stockType === STOCK_TYPES.rawMaterial) {
    const rows = await knex("erp.items as i")
      .select("i.id", "i.name")
      .where({ "i.is_active": true, "i.item_type": "RM" })
      .orderBy("i.name", "asc");

    return (rows || []).map((row) => ({
      id: Number(row.id),
      label: String(row.name || "").trim(),
      item_id: Number(row.id),
    }));
  }

  const skuCategories = getSkuCategoriesFromStockType(stockType);
  if (!skuCategories.length) return [];

  const rows = await knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id", "s.sku_code", "i.id as item_id", "i.name as item_name")
    .where({ "s.is_active": true, "i.is_active": true })
    .whereIn("i.item_type", skuCategories)
    .orderBy("i.name", "asc")
    .orderBy("s.sku_code", "asc");

  return (rows || []).map((row) => {
    const skuCode = String(row.sku_code || "").trim();
    const itemName = String(row.item_name || "").trim();
    return {
      id: Number(row.id),
      label:
        skuCode && itemName
          ? `${skuCode} - ${itemName}`
          : skuCode || itemName || "-",
      item_id: Number(row.item_id || 0) || null,
    };
  });
};

const loadStockMovementItemsByType = async () => {
  const [finished, semiFinished, rawMaterial] = await Promise.all([
    loadStockMovementItemsForType(STOCK_TYPES.finished),
    loadStockMovementItemsForType(STOCK_TYPES.semiFinished),
    loadStockMovementItemsForType(STOCK_TYPES.rawMaterial),
  ]);

  return {
    [STOCK_TYPES.finished]: finished,
    [STOCK_TYPES.semiFinished]: semiFinished,
    [STOCK_TYPES.rawMaterial]: rawMaterial,
  };
};

const buildDefaultStockMovementReportData = ({
  includeBranchColumn = false,
  showSkuGroupedDetail = false,
  conversionUnits = [],
} = {}) => ({
  rows: [],
  summaryRows: [],
  includeBranchColumn: Boolean(includeBranchColumn),
  showSkuGroupedDetail: Boolean(showSkuGroupedDetail),
  totals: {
    openingQty: 0,
    productionQty: 0,
    purchaseQty: 0,
    saleQty: 0,
    adjustmentQty: 0,
    closingQty: 0,
    openingQtyConverted: (conversionUnits || []).reduce((acc, unit) => {
      const unitId = toPositiveInt(unit?.id);
      if (unitId) acc[unitId] = 0;
      return acc;
    }, {}),
    productionQtyConverted: (conversionUnits || []).reduce((acc, unit) => {
      const unitId = toPositiveInt(unit?.id);
      if (unitId) acc[unitId] = 0;
      return acc;
    }, {}),
    purchaseQtyConverted: (conversionUnits || []).reduce((acc, unit) => {
      const unitId = toPositiveInt(unit?.id);
      if (unitId) acc[unitId] = 0;
      return acc;
    }, {}),
    saleQtyConverted: (conversionUnits || []).reduce((acc, unit) => {
      const unitId = toPositiveInt(unit?.id);
      if (unitId) acc[unitId] = 0;
      return acc;
    }, {}),
    adjustmentQtyConverted: (conversionUnits || []).reduce((acc, unit) => {
      const unitId = toPositiveInt(unit?.id);
      if (unitId) acc[unitId] = 0;
      return acc;
    }, {}),
    closingQtyConverted: (conversionUnits || []).reduce((acc, unit) => {
      const unitId = toPositiveInt(unit?.id);
      if (unitId) acc[unitId] = 0;
      return acc;
    }, {}),
  },
});

const sumMovementConvertedQuantities = (rows, conversionUnits, metricKey) => {
  const totals = {};
  (conversionUnits || []).forEach((unit) => {
    const unitId = Number(unit?.id || 0);
    if (!unitId) return;
    totals[unitId] = 0;
  });

  (rows || []).forEach((row) => {
    const converted = row?.convertedQuantities?.[metricKey] || {};
    Object.keys(totals).forEach((unitId) => {
      totals[unitId] = toQuantity(
        Number(totals[unitId] || 0) + Number(converted[unitId] || 0),
        3,
      );
    });
  });

  return totals;
};

const buildStockMovementSummaryRows = ({
  rows = [],
  stockType,
  orderBy = ORDER_BY_TYPES.sku,
}) => {
  const grouped = new Map();

  (rows || []).forEach((row) => {
    const stockItemId = Number(row?.stockItemId || 0) || 0;
    const stockItemLabel = String(row?.stockItemLabel || "").trim();
    const key =
      stockItemId > 0 ? `item:${stockItemId}` : `label:${stockItemLabel}`;

    const existing = grouped.get(key) || {
      stockItemId: stockItemId || null,
      stockItemLabel,
      skuCode: String(row?.skuCode || "").trim(),
      articleId: Number(row?.articleId || 0) || null,
      articleName: String(row?.articleName || "").trim(),
      groupId: Number(row?.groupId || 0) || null,
      groupName: String(row?.groupName || "").trim(),
      subgroupId: Number(row?.subgroupId || 0) || null,
      subgroupName: String(row?.subgroupName || "").trim(),
      openingQty: 0,
      productionQty: 0,
      purchaseQty: 0,
      saleQty: 0,
      adjustmentQty: 0,
      closingQty: 0,
      convertedQuantities: {
        openingQty: {},
        productionQty: {},
        purchaseQty: {},
        saleQty: {},
        adjustmentQty: {},
        closingQty: {},
      },
    };

    existing.openingQty = toQuantity(
      Number(existing.openingQty || 0) + Number(row?.openingQty || 0),
      3,
    );
    existing.productionQty = toQuantity(
      Number(existing.productionQty || 0) + Number(row?.productionQty || 0),
      3,
    );
    existing.purchaseQty = toQuantity(
      Number(existing.purchaseQty || 0) + Number(row?.purchaseQty || 0),
      3,
    );
    existing.saleQty = toQuantity(
      Number(existing.saleQty || 0) + Number(row?.saleQty || 0),
      3,
    );
    existing.adjustmentQty = toQuantity(
      Number(existing.adjustmentQty || 0) + Number(row?.adjustmentQty || 0),
      3,
    );
    existing.closingQty = toQuantity(
      Number(existing.closingQty || 0) + Number(row?.closingQty || 0),
      3,
    );

    [
      "openingQty",
      "productionQty",
      "purchaseQty",
      "saleQty",
      "adjustmentQty",
      "closingQty",
    ].forEach((metricKey) => {
      const metricConverted = row?.convertedQuantities?.[metricKey] || {};
      Object.keys(metricConverted).forEach((unitId) => {
        existing.convertedQuantities[metricKey][unitId] = toQuantity(
          Number(existing.convertedQuantities[metricKey][unitId] || 0) +
            Number(metricConverted[unitId] || 0),
          3,
        );
      });
    });

    grouped.set(key, existing);
  });

  return [...grouped.values()].sort((a, b) => {
    if (stockType === STOCK_TYPES.rawMaterial) {
      return String(a.stockItemLabel || "").localeCompare(
        String(b.stockItemLabel || ""),
      );
    }

    if (orderBy === ORDER_BY_TYPES.article) {
      const byArticle = String(a.articleName || "").localeCompare(
        String(b.articleName || ""),
      );
      if (byArticle !== 0) return byArticle;
      return String(a.skuCode || a.stockItemLabel || "").localeCompare(
        String(b.skuCode || b.stockItemLabel || ""),
      );
    }

    const bySku = String(a.skuCode || a.stockItemLabel || "").localeCompare(
      String(b.skuCode || b.stockItemLabel || ""),
    );
    if (bySku !== 0) return bySku;
    return String(a.articleName || "").localeCompare(
      String(b.articleName || ""),
    );
  });
};

const loadStockMovementRows = async ({
  filters,
  selectedUnitId = null,
  conversionUnits = [],
  uomContext = null,
}) => {
  const qtyColumnSql =
    filters.stockType === STOCK_TYPES.rawMaterial
      ? "COALESCE(sl.qty, 0)"
      : "COALESCE(sl.qty_pairs, 0)";
  const signedQtySql = `CASE WHEN sl.direction = 1 THEN ${qtyColumnSql} ELSE -${qtyColumnSql} END`;
  const packedFlagSql = FG_PACKED_FLAG_SQL;
  const includeColorSizeColumns = filters.orderBy === ORDER_BY_TYPES.sku;

  const movementBuckets = getMovementVoucherCodeBuckets();
  const buildVoucherTypeClause = (codes, negate = false) => {
    const normalizedCodes = [...new Set((codes || []).filter(Boolean))];
    if (!normalizedCodes.length) {
      return {
        sql: negate ? "1 = 1" : "1 = 0",
        bindings: [],
      };
    }
    const placeholders = normalizedCodes.map(() => "?").join(", ");
    return {
      sql: `COALESCE(vh.voucher_type_code, '') ${negate ? "NOT IN" : "IN"} (${placeholders})`,
      bindings: normalizedCodes,
    };
  };

  const productionClause = buildVoucherTypeClause(movementBuckets.production);
  const purchaseClause = buildVoucherTypeClause(movementBuckets.purchase);
  const saleClause = buildVoucherTypeClause(movementBuckets.sale);
  const adjustmentClause = buildVoucherTypeClause(
    movementBuckets.allClassified,
    true,
  );

  let query = knex("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .leftJoin("erp.branches as b", "b.id", "sl.branch_id")
    .where({ "sl.stock_state": "ON_HAND", "sl.category": filters.stockType })
    .where("sl.txn_date", "<=", filters.to);

  if (filters.stockType === STOCK_TYPES.finished) {
    query = query
      .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
      .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
      .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id");
  }

  if (filters.stockType === STOCK_TYPES.rawMaterial) {
    query = query
      .join("erp.items as i", "i.id", "sl.item_id")
      .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
      .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
      .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
      .select(
        "sl.branch_id",
        "b.name as branch_name",
        knex.raw("i.id as stock_item_id"),
        knex.raw("i.name as stock_item_label"),
        knex.raw("NULL::text as sku_code"),
        knex.raw("NULL::bigint as article_id"),
        knex.raw("NULL::text as article_name"),
        "i.group_id",
        "pg.name as group_name",
        "i.subgroup_id",
        "sg.name as subgroup_name",
        "i.base_uom_id",
        "u.code as base_uom_code",
        "u.name as base_uom_name",
      )
      .groupBy(
        "sl.branch_id",
        "b.name",
        "i.id",
        "i.name",
        "i.group_id",
        "pg.name",
        "i.subgroup_id",
        "sg.name",
        "i.base_uom_id",
        "u.code",
        "u.name",
      )
      .orderBy("i.name", "asc")
      .orderBy("b.name", "asc");

    if (includeColorSizeColumns) {
      query = query
        .leftJoin("erp.colors as c", "c.id", "sl.color_id")
        .leftJoin("erp.sizes as sz", "sz.id", "sl.size_id")
        .select(
          "sl.color_id",
          "c.name as color_name",
          "sl.size_id",
          "sz.name as size_name",
        )
        .groupBy("sl.color_id", "c.name", "sl.size_id", "sz.name")
        .orderBy("c.name", "asc")
        .orderBy("sz.name", "asc");
    } else {
      query = query.select(
        knex.raw("NULL::bigint as color_id"),
        knex.raw("NULL::text as color_name"),
        knex.raw("NULL::bigint as size_id"),
        knex.raw("NULL::text as size_name"),
      );
    }

    if (filters.stockItemIds.length) {
      query = query.whereIn("sl.item_id", filters.stockItemIds);
    }
  } else {
    query = query
      .join("erp.skus as s", "s.id", "sl.sku_id")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", "i.id", "v.item_id")
      .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
      .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
      .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
      .whereIn("i.item_type", getItemTypesFromStockType(filters.stockType))
      .select(
        "sl.branch_id",
        "b.name as branch_name",
        knex.raw("s.id as stock_item_id"),
        knex.raw("s.sku_code as stock_item_label"),
        "s.sku_code",
        "i.id as article_id",
        "i.name as article_name",
        "i.group_id",
        "pg.name as group_name",
        "i.subgroup_id",
        "sg.name as subgroup_name",
        "i.base_uom_id",
        "u.code as base_uom_code",
        "u.name as base_uom_name",
      )
      .groupBy(
        "sl.branch_id",
        "b.name",
        "s.id",
        "s.sku_code",
        "i.id",
        "i.name",
        "i.group_id",
        "pg.name",
        "i.subgroup_id",
        "sg.name",
        "i.base_uom_id",
        "u.code",
        "u.name",
      )
      .orderBy(
        filters.orderBy === ORDER_BY_TYPES.article ? "i.name" : "s.sku_code",
        "asc",
      )
      .orderBy(
        filters.orderBy === ORDER_BY_TYPES.article ? "s.sku_code" : "i.name",
        "asc",
      )
      .orderBy("b.name", "asc");

    if (includeColorSizeColumns) {
      query = query
        .leftJoin("erp.colors as c", "c.id", "v.color_id")
        .leftJoin("erp.sizes as sz", "sz.id", "v.size_id")
        .select(
          "v.color_id",
          "c.name as color_name",
          "v.size_id",
          "sz.name as size_name",
        )
        .groupBy("v.color_id", "c.name", "v.size_id", "sz.name")
        .orderBy("c.name", "asc")
        .orderBy("sz.name", "asc");
    } else {
      query = query.select(
        knex.raw("NULL::bigint as color_id"),
        knex.raw("NULL::text as color_name"),
        knex.raw("NULL::bigint as size_id"),
        knex.raw("NULL::text as size_name"),
      );
    }

    if (filters.articleIds.length) {
      query = query.whereIn("i.id", filters.articleIds);
    }
    if (filters.stockItemIds.length) {
      query = query.whereIn("s.id", filters.stockItemIds);
    }
  }

  if (filters.branchIds.length) {
    query = query.whereIn("sl.branch_id", filters.branchIds);
  }
  if (filters.productGroupIds.length) {
    query = query.whereIn("i.group_id", filters.productGroupIds);
  }
  if (filters.productSubgroupIds.length) {
    query = query.whereIn("i.subgroup_id", filters.productSubgroupIds);
  }
  if (filters.stockType === STOCK_TYPES.finished) {
    query =
      filters.stockStatus === STOCK_STATUS_TYPES.loose
        ? query.whereRaw(`${packedFlagSql} = false`)
        : query.whereRaw(`${packedFlagSql} = true`);
  }

  query = query
    .select(
      knex.raw(
        `COALESCE(SUM(CASE WHEN sl.txn_date < ? THEN ${signedQtySql} ELSE 0 END), 0) as opening_qty`,
        [filters.from],
      ),
    )
    .select(
      knex.raw(
        `COALESCE(SUM(CASE WHEN sl.txn_date >= ? AND sl.txn_date <= ? AND ${productionClause.sql} THEN ${signedQtySql} ELSE 0 END), 0) as production_qty`,
        [filters.from, filters.to, ...productionClause.bindings],
      ),
    )
    .select(
      knex.raw(
        `COALESCE(SUM(CASE WHEN sl.txn_date >= ? AND sl.txn_date <= ? AND ${purchaseClause.sql} THEN ${signedQtySql} ELSE 0 END), 0) as purchase_qty`,
        [filters.from, filters.to, ...purchaseClause.bindings],
      ),
    )
    .select(
      knex.raw(
        `COALESCE(SUM(CASE WHEN sl.txn_date >= ? AND sl.txn_date <= ? AND ${saleClause.sql} THEN ${signedQtySql} ELSE 0 END), 0) as sale_qty`,
        [filters.from, filters.to, ...saleClause.bindings],
      ),
    )
    .select(
      knex.raw(
        `COALESCE(SUM(CASE WHEN sl.txn_date >= ? AND sl.txn_date <= ? AND ${adjustmentClause.sql} THEN ${signedQtySql} ELSE 0 END), 0) as adjustment_qty`,
        [filters.from, filters.to, ...adjustmentClause.bindings],
      ),
    )
    .select(knex.raw(`COALESCE(SUM(${signedQtySql}), 0) as closing_qty`));

  const rows = await query;
  return (rows || [])
    .map((row) => {
      const baseUomId = toPositiveInt(row?.base_uom_id);
      const selectedUnitFactor = selectedUnitId
        ? getConversionFactor({
            graph: uomContext?.graph,
            fromUomId: baseUomId,
            toUomId: selectedUnitId,
          }) || 0
        : 1;
      if (!(selectedUnitFactor > 0)) return null;

      const openingQty = toQuantity(
        Number(row?.opening_qty || 0) * Number(selectedUnitFactor),
        3,
      );
      const productionQty = toQuantity(
        Number(row?.production_qty || 0) * Number(selectedUnitFactor),
        3,
      );
      const purchaseQty = toQuantity(
        Number(row?.purchase_qty || 0) * Number(selectedUnitFactor),
        3,
      );
      const saleQty = toQuantity(
        Number(row?.sale_qty || 0) * Number(selectedUnitFactor),
        3,
      );
      const adjustmentQty = toQuantity(
        Number(row?.adjustment_qty || 0) * Number(selectedUnitFactor),
        3,
      );
      const closingQty = toQuantity(
        Number(row?.closing_qty || 0) * Number(selectedUnitFactor),
        3,
      );

      const includeRow = [
        openingQty,
        productionQty,
        purchaseQty,
        saleQty,
        adjustmentQty,
        closingQty,
      ].some((value) => hasNonZeroQuantity(value));
      if (!includeRow) return null;

      const convertedQuantities = {
        openingQty: {},
        productionQty: {},
        purchaseQty: {},
        saleQty: {},
        adjustmentQty: {},
        closingQty: {},
      };

      (conversionUnits || []).forEach((unit) => {
        const targetUomId = toPositiveInt(unit?.id);
        if (!targetUomId || !uomContext?.graph) return;
        const factor =
          getConversionFactor({
            graph: uomContext.graph,
            fromUomId: toPositiveInt(row?.base_uom_id),
            toUomId: targetUomId,
          }) || 0;

        if (!(factor > 0)) {
          convertedQuantities.openingQty[targetUomId] = 0;
          convertedQuantities.productionQty[targetUomId] = 0;
          convertedQuantities.purchaseQty[targetUomId] = 0;
          convertedQuantities.saleQty[targetUomId] = 0;
          convertedQuantities.adjustmentQty[targetUomId] = 0;
          convertedQuantities.closingQty[targetUomId] = 0;
          return;
        }

        convertedQuantities.openingQty[targetUomId] = toQuantity(
          openingQty * factor,
          3,
        );
        convertedQuantities.productionQty[targetUomId] = toQuantity(
          productionQty * factor,
          3,
        );
        convertedQuantities.purchaseQty[targetUomId] = toQuantity(
          purchaseQty * factor,
          3,
        );
        convertedQuantities.saleQty[targetUomId] = toQuantity(
          saleQty * factor,
          3,
        );
        convertedQuantities.adjustmentQty[targetUomId] = toQuantity(
          adjustmentQty * factor,
          3,
        );
        convertedQuantities.closingQty[targetUomId] = toQuantity(
          closingQty * factor,
          3,
        );
      });

      return {
        branchId: Number(row?.branch_id || 0) || null,
        branchName: String(row?.branch_name || "").trim(),
        stockItemId: Number(row?.stock_item_id || 0) || null,
        stockItemLabel: String(row?.stock_item_label || "").trim(),
        skuCode: String(row?.sku_code || "").trim(),
        articleId: Number(row?.article_id || 0) || null,
        articleName: String(row?.article_name || "").trim(),
        groupId: Number(row?.group_id || 0) || null,
        groupName: String(row?.group_name || "").trim(),
        subgroupId: Number(row?.subgroup_id || 0) || null,
        subgroupName: String(row?.subgroup_name || "").trim(),
        colorId: toPositiveInt(row?.color_id),
        colorName: String(row?.color_name || "").trim(),
        sizeId: toPositiveInt(row?.size_id),
        sizeName: String(row?.size_name || "").trim(),
        unitLabel:
          String(row?.base_uom_code || row?.base_uom_name || "").trim() ||
          "-",
        baseUomId,
        openingQty,
        productionQty,
        purchaseQty,
        saleQty,
        adjustmentQty,
        closingQty,
        convertedQuantities,
      };
    })
    .filter(Boolean);
};

const getInventoryStockMovementReportPageData = async ({ req, input = {} }) => {
  const filters = parseStockMovementFilters({ req, input });
  // Keep detail grid structure stable regardless of branch filter cardinality.
  // Selecting a single branch should not downgrade detail rendering semantics.
  const includeBranchColumn = Boolean(req?.user?.isAdmin);
  const showSkuGroupedDetail = filters.viewType === VIEW_TYPES.details;

  const [
    branches,
    productGroupsByType,
    productSubgroupsByType,
    articlesByType,
    stockItemsByType,
    unitOptions,
  ] = await Promise.all([
    loadBranchOptions(req),
    loadProductGroupOptionsByType(),
    loadProductSubgroupOptionsByType(),
    loadStockMovementArticleOptionsByType(),
    loadStockMovementItemsByType(),
    loadUnitOptions(filters.stockType),
  ]);
  const conversionUnits = resolvePackedConversionUnits({
    filters,
    unitOptions,
  });
  const selectedUnit = resolveSemifinishedUnitSelection({
    filters,
    unitOptions,
  });
  if (
    filters.stockType === STOCK_TYPES.semiFinished &&
    filters.unitId &&
    !selectedUnit.unitId
  ) {
    filters.invalidFilterInput = true;
  }
  filters.unitId = selectedUnit.unitId;
  filters.unitLabel = selectedUnit.unitLabel;

  const productGroups = Array.isArray(productGroupsByType[filters.stockType])
    ? productGroupsByType[filters.stockType]
    : [];
  const productSubgroups = Array.isArray(
    productSubgroupsByType[filters.stockType],
  )
    ? productSubgroupsByType[filters.stockType]
    : [];
  const articles =
    filters.stockType === STOCK_TYPES.rawMaterial
      ? []
      : Array.isArray(articlesByType[filters.stockType])
        ? articlesByType[filters.stockType]
        : [];

  const allStockItems = Array.isArray(stockItemsByType[filters.stockType])
    ? stockItemsByType[filters.stockType]
    : [];
  const stockItems =
    filters.stockType === STOCK_TYPES.rawMaterial || !filters.articleIds.length
      ? allStockItems
      : allStockItems.filter((item) =>
          filters.articleIds.includes(Number(item.item_id || 0)),
        );

  const sanitizeSelectedIds = (selectedIds, allowedRows) => {
    if (!Array.isArray(selectedIds) || !selectedIds.length) return [];
    const allowed = new Set(
      (allowedRows || [])
        .map((row) => Number(row?.id || 0))
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    return selectedIds.filter((id) => allowed.has(Number(id)));
  };

  const safeProductGroupIds = sanitizeSelectedIds(
    filters.productGroupIds,
    productGroups,
  );
  if (safeProductGroupIds.length !== filters.productGroupIds.length) {
    filters.invalidFilterInput = true;
  }
  filters.productGroupIds = safeProductGroupIds;

  const safeProductSubgroupIds = sanitizeSelectedIds(
    filters.productSubgroupIds,
    productSubgroups,
  );
  if (safeProductSubgroupIds.length !== filters.productSubgroupIds.length) {
    filters.invalidFilterInput = true;
  }
  filters.productSubgroupIds = safeProductSubgroupIds;

  if (filters.stockType === STOCK_TYPES.rawMaterial) {
    filters.articleIds = [];
  } else {
    const safeArticleIds = sanitizeSelectedIds(filters.articleIds, articles);
    if (safeArticleIds.length !== filters.articleIds.length) {
      filters.invalidFilterInput = true;
    }
    filters.articleIds = safeArticleIds;
  }

  const safeStockItemIds = sanitizeSelectedIds(
    filters.stockItemIds,
    stockItems,
  );
  if (safeStockItemIds.length !== filters.stockItemIds.length) {
    filters.invalidFilterInput = true;
  }
  filters.stockItemIds = safeStockItemIds;

  const options = {
    branches,
    productGroups,
    productSubgroups,
    articles,
    stockItems,
    productGroupsByType,
    productSubgroupsByType,
    articlesByType,
    stockItemsByType,
    stockTypes: [
      { value: STOCK_TYPES.finished, labelKey: "finished" },
      { value: STOCK_TYPES.semiFinished, labelKey: "semi_finished" },
      { value: STOCK_TYPES.rawMaterial, labelKey: "raw_materials" },
    ],
    stockStatuses: [
      { value: STOCK_STATUS_TYPES.packed, labelKey: "packed" },
      { value: STOCK_STATUS_TYPES.loose, labelKey: "loose" },
    ],
    viewFilters: [
      { value: VIEW_TYPES.details, labelKey: "details" },
      { value: VIEW_TYPES.summary, labelKey: "summary" },
    ],
    orderByOptions: [
      { value: ORDER_BY_TYPES.sku, labelKey: "sku" },
      { value: ORDER_BY_TYPES.article, labelKey: "article" },
    ],
    unitOptions,
    conversionUnits,
  };

  if (!filters.reportLoaded) {
    return {
      filters,
      options,
      reportData: buildDefaultStockMovementReportData({
        includeBranchColumn,
        showSkuGroupedDetail,
        conversionUnits,
      }),
    };
  }

  const uomContext =
    conversionUnits.length || selectedUnit.unitId
      ? await loadUomContext()
      : null;
  const rows = await loadStockMovementRows({
    filters,
    selectedUnitId: selectedUnit.unitId,
    conversionUnits,
    uomContext,
  });
  const summaryRows = buildStockMovementSummaryRows({
    rows,
    stockType: filters.stockType,
    orderBy: filters.orderBy,
  });
  const totalSourceRows =
    filters.viewType === VIEW_TYPES.summary ? summaryRows : rows;
  const totals = {
    openingQty: toQuantity(
      totalSourceRows.reduce(
        (sum, row) => sum + Number(row.openingQty || 0),
        0,
      ),
      3,
    ),
    productionQty: toQuantity(
      totalSourceRows.reduce(
        (sum, row) => sum + Number(row.productionQty || 0),
        0,
      ),
      3,
    ),
    purchaseQty: toQuantity(
      totalSourceRows.reduce(
        (sum, row) => sum + Number(row.purchaseQty || 0),
        0,
      ),
      3,
    ),
    saleQty: toQuantity(
      totalSourceRows.reduce((sum, row) => sum + Number(row.saleQty || 0), 0),
      3,
    ),
    adjustmentQty: toQuantity(
      totalSourceRows.reduce(
        (sum, row) => sum + Number(row.adjustmentQty || 0),
        0,
      ),
      3,
    ),
    closingQty: toQuantity(
      totalSourceRows.reduce(
        (sum, row) => sum + Number(row.closingQty || 0),
        0,
      ),
      3,
    ),
    openingQtyConverted: sumMovementConvertedQuantities(
      totalSourceRows,
      conversionUnits,
      "openingQty",
    ),
    productionQtyConverted: sumMovementConvertedQuantities(
      totalSourceRows,
      conversionUnits,
      "productionQty",
    ),
    purchaseQtyConverted: sumMovementConvertedQuantities(
      totalSourceRows,
      conversionUnits,
      "purchaseQty",
    ),
    saleQtyConverted: sumMovementConvertedQuantities(
      totalSourceRows,
      conversionUnits,
      "saleQty",
    ),
    adjustmentQtyConverted: sumMovementConvertedQuantities(
      totalSourceRows,
      conversionUnits,
      "adjustmentQty",
    ),
    closingQtyConverted: sumMovementConvertedQuantities(
      totalSourceRows,
      conversionUnits,
      "closingQty",
    ),
  };

  return {
    filters,
    options,
    reportData: {
      rows,
      summaryRows,
      includeBranchColumn:
        filters.viewType === VIEW_TYPES.details ? includeBranchColumn : false,
      showSkuGroupedDetail:
        filters.viewType === VIEW_TYPES.details ? showSkuGroupedDetail : false,
      totals,
    },
  };
};

const parseLedgerFilters = ({ req, input = {} }) => {
  const { today, defaultFrom } = getDefaultLedgerDateRange();
  const parsedFrom = parseDateFilter(
    input.from_date || input.fromDate,
    defaultFrom,
  );
  const parsedTo = parseDateFilter(input.to_date || input.toDate, today);
  const stockType = normalizeStockType(input.stock_type || input.stockType);
  const stockStatus =
    stockType === STOCK_TYPES.finished
      ? normalizeStockStatus(input.stock_status || input.stockStatus)
      : null;

  let from = parsedFrom.value;
  let to = parsedTo.value;
  let invalidDateRange = false;
  if (from > to) {
    from = defaultFrom;
    to = today;
    invalidDateRange = true;
  }

  const reportLoaded = toBoolean(input.load_report || input.loadReport, false);
  const rawFrom = String(input.from_date || input.fromDate || "").trim();
  const rawTo = String(input.to_date || input.toDate || "").trim();

  const stockItemId = toPositiveInt(
    input.stock_item_id ||
      input.stockItemId ||
      input.sku_id ||
      input.skuId ||
      input.item_id ||
      input.itemId,
  );

  const missingDateRange = reportLoaded && (!rawFrom || !rawTo);
  const missingStockItem = reportLoaded && !stockItemId;

  return {
    reportLoaded,
    from,
    to,
    stockType,
    stockStatus,
    unitId: toPositiveInt(input.unit_id || input.unitId),
    stockItemId,
    branchIds: normalizeBranchFilter({ req, input }),
    missingDateRange,
    missingStockItem,
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

const loadLedgerStockItemsForType = async (stockType) => {
  if (stockType === STOCK_TYPES.rawMaterial) {
    const rows = await knex("erp.items as i")
      .select("i.id", "i.name")
      .where({ "i.is_active": true, "i.item_type": "RM" })
      .orderBy("i.name", "asc");

    return rows.map((row) => ({
      id: Number(row.id),
      label: String(row.name || "").trim(),
    }));
  }

  const skuCategories = getSkuCategoriesFromStockType(stockType);
  if (!skuCategories.length) return [];

  const rows = await knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id", "s.sku_code", "i.name as item_name")
    .where({ "s.is_active": true, "i.is_active": true })
    .whereIn("i.item_type", skuCategories)
    .orderBy("i.name", "asc")
    .orderBy("s.sku_code", "asc");

  return rows.map((row) => {
    const skuCode = String(row.sku_code || "").trim();
    const itemName = String(row.item_name || "").trim();
    return {
      id: Number(row.id),
      label:
        skuCode && itemName
          ? `${skuCode} - ${itemName}`
          : skuCode || itemName || "-",
    };
  });
};

const loadLedgerStockItemsByType = async () => {
  const [finished, semiFinished, rawMaterial] = await Promise.all([
    loadLedgerStockItemsForType(STOCK_TYPES.finished),
    loadLedgerStockItemsForType(STOCK_TYPES.semiFinished),
    loadLedgerStockItemsForType(STOCK_TYPES.rawMaterial),
  ]);

  return {
    [STOCK_TYPES.finished]: finished,
    [STOCK_TYPES.semiFinished]: semiFinished,
    [STOCK_TYPES.rawMaterial]: rawMaterial,
  };
};

const applyStockLedgerBaseFilters = ({
  query,
  filters,
  stockItemId,
  packedFlagSql,
}) => {
  query.where({
    "sl.stock_state": "ON_HAND",
    "sl.category": filters.stockType,
  });

  if (filters.branchIds.length) {
    query.whereIn("sl.branch_id", filters.branchIds);
  }

  if (filters.stockType === STOCK_TYPES.rawMaterial) {
    query.where("sl.item_id", stockItemId);
  } else {
    query.where("sl.sku_id", stockItemId);
  }

  if (filters.stockType === STOCK_TYPES.finished) {
    if (filters.stockStatus === STOCK_STATUS_TYPES.loose) {
      query.whereRaw(`${packedFlagSql} = false`);
    } else {
      query.whereRaw(`${packedFlagSql} = true`);
    }
  }

  return query;
};

const buildDefaultStockLedgerReportData = () => ({
  rows: [],
  totals: {
    openingQty: 0,
    openingValue: 0,
    inQty: 0,
    outQty: 0,
    inValue: 0,
    outValue: 0,
    closingQty: 0,
    closingValue: 0,
    openingQtyConverted: {},
    inQtyConverted: {},
    outQtyConverted: {},
    closingQtyConverted: {},
  },
});

const loadStockLedgerRows = async ({
  filters,
  stockItemId,
  selectedUnitId = null,
  selectedUnitLabel = "",
  conversionUnits = [],
  uomContext = null,
  selectedBaseUomId = null,
}) => {
  const packedFlagSql = FG_PACKED_FLAG_SQL;
  const qtyColumnSql =
    filters.stockType === STOCK_TYPES.rawMaterial
      ? "COALESCE(sl.qty, 0)"
      : "COALESCE(sl.qty_pairs, 0)";
  const signedQtySql = `CASE WHEN sl.direction = 1 THEN ${qtyColumnSql} ELSE -${qtyColumnSql} END`;
  const signedValueSql = "COALESCE(sl.value, 0)";

  let openingQuery = knex("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .select(knex.raw(`COALESCE(SUM(${signedQtySql}), 0) as opening_qty`))
    .select(knex.raw(`COALESCE(SUM(${signedValueSql}), 0) as opening_value`))
    .where("sl.txn_date", "<", filters.from);

  openingQuery = applyStockLedgerBaseFilters({
    query: openingQuery,
    filters,
    stockItemId,
    packedFlagSql,
  });

  const openingRow = await openingQuery.first();
  const selectedUnitFactor = selectedUnitId
    ? getConversionFactor({
        graph: uomContext?.graph,
        fromUomId: selectedBaseUomId,
        toUomId: selectedUnitId,
      }) || 0
    : 1;
  if (!(selectedUnitFactor > 0)) {
    return buildDefaultStockLedgerReportData();
  }

  const openingQty = toQuantity(
    Number(openingRow?.opening_qty || 0) * Number(selectedUnitFactor),
    3,
  );
  const openingValue = toAmount(openingRow?.opening_value, 2);

  let txnQuery = knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .join("erp.voucher_type as vt", "vt.code", "vh.voucher_type_code")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .leftJoin("erp.branches as b", "b.id", "sl.branch_id")
    .select(
      "sl.id",
      "sl.txn_date",
      "sl.direction",
      "sl.unit_cost",
      "sl.value",
      "sl.branch_id",
      "b.name as branch_name",
      "vh.id as voucher_header_id",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vt.name as voucher_type_name",
    )
    .select(knex.raw(`${qtyColumnSql} as movement_qty`))
    .whereBetween("sl.txn_date", [filters.from, filters.to]);

  if (filters.stockType === STOCK_TYPES.rawMaterial) {
    txnQuery = txnQuery
      .join("erp.items as i", "i.id", "sl.item_id")
      .leftJoin("erp.colors as c", "c.id", "sl.color_id")
      .leftJoin("erp.sizes as sz", "sz.id", "sl.size_id")
      .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
      .select(
        "i.name as item_name",
        "c.name as color_name",
        "sz.name as size_name",
        "u.code as unit_code",
        "u.name as unit_name",
      );
  } else {
    txnQuery = txnQuery
      .join("erp.skus as s", "s.id", "sl.sku_id")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", "i.id", "v.item_id")
      .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
      .select(
        "s.sku_code",
        "i.name as item_name",
        "u.code as unit_code",
        "u.name as unit_name",
      )
      .select(knex.raw(`${packedFlagSql} as is_packed`));
  }

  txnQuery = applyStockLedgerBaseFilters({
    query: txnQuery,
    filters,
    stockItemId,
    packedFlagSql,
  });

  const txnRows = await txnQuery
    .orderBy("sl.txn_date", "asc")
    .orderBy("sl.id", "asc");

  let runningQty = openingQty;
  let runningValue = openingValue;
  let inQtyTotal = 0;
  let outQtyTotal = 0;
  let inValueTotal = 0;
  let outValueTotal = 0;

  const rows = txnRows.map((row) => {
    const direction = Number(row?.direction) === -1 ? -1 : 1;
    const movementQty = toQuantity(
      Number(row?.movement_qty || 0) * Number(selectedUnitFactor),
      3,
    );
    const movementValueSigned = toAmount(row?.value, 2);
    const inQty = direction === 1 ? movementQty : 0;
    const outQty = direction === -1 ? movementQty : 0;
    const inValue =
      direction === 1 ? toAmount(Math.abs(movementValueSigned), 2) : 0;
    const outValue =
      direction === -1 ? toAmount(Math.abs(movementValueSigned), 2) : 0;

    runningQty = toQuantity(
      runningQty + (direction === 1 ? movementQty : -movementQty),
      3,
    );
    runningValue = toAmount(runningValue + movementValueSigned, 2);
    inQtyTotal = toQuantity(inQtyTotal + inQty, 3);
    outQtyTotal = toQuantity(outQtyTotal + outQty, 3);
    inValueTotal = toAmount(inValueTotal + inValue, 2);
    outValueTotal = toAmount(outValueTotal + outValue, 2);

    const convertedQuantities = {
      inQty: {},
      outQty: {},
      runningQty: {},
    };

    (conversionUnits || []).forEach((unit) => {
      const targetUomId = toPositiveInt(unit?.id);
      if (!targetUomId || !uomContext?.graph) return;
      const factor =
        getConversionFactor({
          graph: uomContext.graph,
          fromUomId: selectedBaseUomId,
          toUomId: targetUomId,
        }) || 0;
      if (!(factor > 0)) {
        convertedQuantities.inQty[targetUomId] = 0;
        convertedQuantities.outQty[targetUomId] = 0;
        convertedQuantities.runningQty[targetUomId] = 0;
        return;
      }
      convertedQuantities.inQty[targetUomId] = toQuantity(inQty * factor, 3);
      convertedQuantities.outQty[targetUomId] = toQuantity(outQty * factor, 3);
      convertedQuantities.runningQty[targetUomId] = toQuantity(
        runningQty * factor,
        3,
      );
    });

    return {
      id: Number(row?.id || 0),
      txnDate: String(row?.txn_date || ""),
      voucherTypeCode: String(row?.voucher_type_code || "").trim(),
      voucherTypeName: String(row?.voucher_type_name || "").trim(),
      voucherNo: Number(row?.voucher_no || 0) || null,
      voucherHeaderId: Number(row?.voucher_header_id || 0) || null,
      branchId: Number(row?.branch_id || 0) || null,
      branchName: String(row?.branch_name || "").trim(),
      itemName: String(row?.item_name || "").trim(),
      skuCode: String(row?.sku_code || "").trim(),
      colorName: String(row?.color_name || "").trim(),
      sizeName: String(row?.size_name || "").trim(),
      unitLabel:
        String(selectedUnitLabel || "").trim() ||
        String(row?.unit_code || row?.unit_name || "").trim() ||
        "-",
      stockStatus:
        filters.stockType === STOCK_TYPES.finished
          ? row?.is_packed
            ? STOCK_STATUS_TYPES.packed
            : STOCK_STATUS_TYPES.loose
          : null,
      unitCost: toAmount(row?.unit_cost, 6),
      inQty,
      outQty,
      inValue,
      outValue,
      runningQty,
      runningValue,
      convertedQuantities,
    };
  });

  const openingQtyConverted = {};
  const inQtyConverted = {};
  const outQtyConverted = {};
  const closingQtyConverted = {};
  (conversionUnits || []).forEach((unit) => {
    const targetUomId = toPositiveInt(unit?.id);
    if (!targetUomId || !uomContext?.graph) return;
    const factor =
      getConversionFactor({
        graph: uomContext.graph,
        fromUomId: selectedBaseUomId,
        toUomId: targetUomId,
      }) || 0;
    if (!(factor > 0)) {
      openingQtyConverted[targetUomId] = 0;
      inQtyConverted[targetUomId] = 0;
      outQtyConverted[targetUomId] = 0;
      closingQtyConverted[targetUomId] = 0;
      return;
    }
    openingQtyConverted[targetUomId] = toQuantity(openingQty * factor, 3);
    inQtyConverted[targetUomId] = toQuantity(inQtyTotal * factor, 3);
    outQtyConverted[targetUomId] = toQuantity(outQtyTotal * factor, 3);
    closingQtyConverted[targetUomId] = toQuantity(runningQty * factor, 3);
  });

  return {
    rows,
    totals: {
      openingQty,
      openingValue,
      inQty: inQtyTotal,
      outQty: outQtyTotal,
      inValue: inValueTotal,
      outValue: outValueTotal,
      closingQty: runningQty,
      closingValue: runningValue,
      openingQtyConverted,
      inQtyConverted,
      outQtyConverted,
      closingQtyConverted,
    },
  };
};

const loadLedgerSelectedBaseUomId = async ({ stockType, stockItemId }) => {
  if (!toPositiveInt(stockItemId)) return null;

  if (stockType === STOCK_TYPES.rawMaterial) {
    const row = await knex("erp.items as i")
      .select("i.base_uom_id")
      .where({ "i.id": stockItemId })
      .first();
    return toPositiveInt(row?.base_uom_id);
  }

  const row = await knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("i.base_uom_id")
    .where({ "s.id": stockItemId })
    .first();
  return toPositiveInt(row?.base_uom_id);
};

const getInventoryStockLedgerReportPageData = async ({ req, input = {} }) => {
  const filters = parseLedgerFilters({ req, input });

  const [branches, stockItemsByType, unitOptions] = await Promise.all([
    loadBranchOptions(req),
    loadLedgerStockItemsByType(),
    loadUnitOptions(filters.stockType),
  ]);
  const conversionUnits = resolvePackedConversionUnits({
    filters,
    unitOptions,
  });
  const selectedUnit = resolveSemifinishedUnitSelection({
    filters,
    unitOptions,
  });
  if (
    filters.stockType === STOCK_TYPES.semiFinished &&
    filters.unitId &&
    !selectedUnit.unitId
  ) {
    filters.invalidFilterInput = true;
  }
  filters.unitId = selectedUnit.unitId;
  filters.unitLabel = selectedUnit.unitLabel;

  const stockItems = Array.isArray(stockItemsByType[filters.stockType])
    ? stockItemsByType[filters.stockType]
    : [];
  const stockItemMap = new Map(
    stockItems.map((item) => [
      Number(item.id),
      String(item.label || "").trim(),
    ]),
  );

  let selectedStockItemId = filters.stockItemId;
  if (selectedStockItemId && !stockItemMap.has(Number(selectedStockItemId))) {
    selectedStockItemId = null;
    filters.invalidFilterInput = true;
    filters.missingStockItem = Boolean(filters.reportLoaded);
  }

  filters.stockItemId = selectedStockItemId;
  filters.stockItemLabel = selectedStockItemId
    ? String(stockItemMap.get(Number(selectedStockItemId)) || "").trim()
    : "";

  const options = {
    branches,
    stockItems,
    stockItemsByType,
    unitOptions,
    conversionUnits,
    stockTypes: [
      { value: STOCK_TYPES.finished, labelKey: "finished" },
      { value: STOCK_TYPES.semiFinished, labelKey: "semi_finished" },
      { value: STOCK_TYPES.rawMaterial, labelKey: "raw_materials" },
    ],
    stockStatuses: [
      { value: STOCK_STATUS_TYPES.packed, labelKey: "packed" },
      { value: STOCK_STATUS_TYPES.loose, labelKey: "loose" },
    ],
  };

  if (!filters.reportLoaded) {
    return {
      filters,
      options,
      reportData: buildDefaultStockLedgerReportData(),
    };
  }

  const validationErrors = [];
  if (filters.missingDateRange)
    validationErrors.push("stock_ledger_error_select_date_range");
  if (filters.missingStockItem)
    validationErrors.push("stock_ledger_error_select_stock_item");
  filters.validationErrors = validationErrors;

  if (validationErrors.length) {
    return {
      filters,
      options,
      reportData: buildDefaultStockLedgerReportData(),
    };
  }

  const selectedBaseUomId = await loadLedgerSelectedBaseUomId({
    stockType: filters.stockType,
    stockItemId: selectedStockItemId,
  });
  const uomContext =
    conversionUnits.length || selectedUnit.unitId
      ? await loadUomContext()
      : null;

  const reportData = await loadStockLedgerRows({
    filters,
    stockItemId: selectedStockItemId,
    selectedUnitId: selectedUnit.unitId,
    selectedUnitLabel: selectedUnit.unitLabel,
    conversionUnits,
    uomContext,
    selectedBaseUomId,
  });

  return {
    filters,
    options,
    reportData,
  };
};

const getInventoryStockAmountReportPageData = async ({ req, input = {} }) =>
  getInventoryStockReportPageData({
    req,
    input,
    includeAmounts: true,
  });

const getInventoryStockBalancesReportPageData = async ({ req, input = {} }) =>
  getInventoryStockReportPageData({
    req,
    input,
    includeAmounts: false,
  });

module.exports = {
  STOCK_TYPES,
  RATE_TYPES,
  VIEW_TYPES,
  ALL_MULTI_FILTER_VALUE,
  getInventoryStockAmountReportPageData,
  getInventoryStockBalancesReportPageData,
  getInventoryStockLedgerReportPageData,
  getInventoryStockMovementReportPageData,
};
