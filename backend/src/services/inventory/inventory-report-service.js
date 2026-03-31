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
});
const STOCK_STATUS_TYPES = Object.freeze({
  packed: "PACKED",
  loose: "LOOSE",
});
const VIEW_TYPES = Object.freeze({
  details: "details",
  summary: "summary",
});

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
    return normalized === String(ALL_MULTI_FILTER_VALUE).toUpperCase() || normalized === "ALL";
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
  const normalized = String(value || STOCK_TYPES.finished).trim().toUpperCase();
  if (normalized === STOCK_TYPES.finished) return STOCK_TYPES.finished;
  if (normalized === STOCK_TYPES.semiFinished) return STOCK_TYPES.semiFinished;
  if (normalized === STOCK_TYPES.rawMaterial) return STOCK_TYPES.rawMaterial;
  return STOCK_TYPES.finished;
};

const normalizeViewType = (value) => {
  const normalized = String(value || VIEW_TYPES.details).trim().toLowerCase();
  return normalized === VIEW_TYPES.summary ? VIEW_TYPES.summary : VIEW_TYPES.details;
};

const normalizeRateType = (value) => {
  const normalized = String(value || RATE_TYPES.sale).trim().toUpperCase();
  return normalized === RATE_TYPES.cost ? RATE_TYPES.cost : RATE_TYPES.sale;
};

const normalizeStockStatus = (value) => {
  const normalized = String(value || STOCK_STATUS_TYPES.packed).trim().toUpperCase();
  if (normalized === STOCK_STATUS_TYPES.packed) return STOCK_STATUS_TYPES.packed;
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
  const parsedAsOfDate = parseDateFilter(input.as_of_date || input.asOfDate, today);
  const stockType = normalizeStockType(input.stock_type || input.stockType);
  const viewType = normalizeViewType(input.view_filter || input.viewType);
  const rateType = includeRateTypeFilter
    ? normalizeRateType(input.rate_type || input.rateType)
    : RATE_TYPES.sale;
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
    branchIds: normalizeBranchFilter({ req, input }),
    productGroupIds: toIdListWithAll(input.product_group_ids || input.productGroupIds),
    productSubgroupIds: toIdListWithAll(input.product_subgroup_ids || input.productSubgroupIds),
    unitId: toPositiveInt(input.unit_id || input.unitId),
    invalidAsOfDate: Boolean(parsedAsOfDate.provided && !parsedAsOfDate.valid),
    invalidFilterInput: Boolean(parsedAsOfDate.provided && !parsedAsOfDate.valid),
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
    collectReachableUomIds({ graph, sourceUomId: baseUomId }).forEach((uomId) => {
      optionIds.add(Number(uomId));
    });
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

const loadFgSfgDetailRows = async ({
  filters,
  selectedUnitId,
  uomContext,
  includeAmounts = true,
}) => {
  const skuCategories = getSkuCategoriesFromStockType(filters.stockType);
  if (!skuCategories.length) return [];

  const netQtyPairsSql =
    "SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END)";
  const packedFlagSql =
    "CASE WHEN upper(coalesce(vl.meta->>'status', '')) = 'PACKED' THEN true WHEN lower(coalesce(vl.meta->>'is_packed', '')) IN ('true','t','1','yes') THEN true ELSE false END";

  let query = knex("erp.stock_ledger as sl")
    .join("erp.skus as s", "s.id", "sl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
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

  if (filters.branchIds.length) query = query.whereIn("sl.branch_id", filters.branchIds);
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

  const rows = await query.orderBy("i.name", "asc").orderBy("s.sku_code", "asc");

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
      const stockType = String(row?.category || "").trim().toUpperCase();
      const costAmount = toAmount(row?.total_amount, 2);
      const costRate = hasNonZeroQuantity(quantity)
        ? toAmount(costAmount / quantity, 4)
        : 0;
      const saleRate =
        stockType === STOCK_TYPES.finished
          ? toAmount(row?.sale_rate, 4)
          : 0;
      const rate =
        filters.rateType === RATE_TYPES.sale
          ? saleRate
          : costRate;
      const amount =
        filters.rateType === RATE_TYPES.sale
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
      };
      if (includeAmounts) {
        detailRow.rate = rate;
        detailRow.amount = amount;
      }
      return detailRow;
    })
    .filter(Boolean);
};

const loadRmDetailRows = async ({ filters, includeAmounts = true }) => {
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

  if (filters.branchIds.length) query = query.whereIn("sl.branch_id", filters.branchIds);
  if (filters.productGroupIds.length) {
    query = query.whereIn("i.group_id", filters.productGroupIds);
  }
  if (filters.productSubgroupIds.length) {
    query = query.whereIn("i.subgroup_id", filters.productSubgroupIds);
  }

  const rows = await query.orderBy("i.name", "asc").orderBy("c.name", "asc").orderBy("sz.name", "asc");

  let rmRateByIdentity = new Map();
  if (includeAmounts) {
    const rmItemIds = [
      ...new Set(
        (rows || [])
          .map((row) => toPositiveInt(row?.item_id))
          .filter(Boolean),
      ),
    ];
    if (rmItemIds.length) {
      const rateRows = await knex("erp.rm_purchase_rates as r")
        .select(
          "r.rm_item_id",
          "r.color_id",
          "r.size_id",
          "r.avg_purchase_rate",
          "r.purchase_rate",
        )
        .whereIn("r.rm_item_id", rmItemIds)
        .andWhere("r.is_active", true);

      rmRateByIdentity = new Map(
        (rateRows || [])
          .map((row) => {
            const itemId = toPositiveInt(row?.rm_item_id);
            if (!itemId) return null;
            const colorId = toPositiveInt(row?.color_id) || 0;
            const sizeId = toPositiveInt(row?.size_id) || 0;
            const avgRate = Number(row?.avg_purchase_rate || 0);
            const purchaseRate = Number(row?.purchase_rate || 0);
            const resolvedRate =
              Number.isFinite(avgRate) && avgRate > 0 ? avgRate : purchaseRate;
            if (!(resolvedRate > 0)) return null;
            return [
              `${Number(itemId)}:${Number(colorId)}:${Number(sizeId)}`,
              Number(resolvedRate.toFixed(4)),
            ];
          })
          .filter(Boolean),
      );
    }
  }

  const resolveRmFallbackRate = ({ itemId, colorId = null, sizeId = null }) => {
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
    for (const key of keys) {
      const value = Number(rmRateByIdentity.get(key) || 0);
      if (value > 0) return Number(value.toFixed(4));
    }
    return 0;
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
        let rate = hasNonZeroQuantity(quantity) ? toAmount(amount / quantity, 4) : 0;
        if (!hasNonZeroQuantity(amount) && hasNonZeroQuantity(quantity)) {
          const fallbackRate = resolveRmFallbackRate({
            itemId: row?.item_id,
            colorId: row?.color_id,
            sizeId: row?.size_id,
          });
          if (fallbackRate > 0) {
            rate = Number(fallbackRate.toFixed(4));
            amount = toAmount(quantity * rate, 2);
          }
        }
        detailRow.rate = rate;
        detailRow.amount = amount;
      }

      return detailRow;
    })
    .filter(Boolean);
};

const buildFgSfgSummaryRows = (detailRows, { includeAmounts = true } = {}) => {
  const grouped = new Map();

  (detailRows || []).forEach((row) => {
    const key = `${Number(row.article_id || 0)}:${String(row.stock_type || "")}:${String(row.unit_label || "")}`;
    const existing = grouped.get(key) || {
      article_id: Number(row.article_id || 0) || null,
      article_name: String(row.article_name || "").trim(),
      stock_type: String(row.stock_type || "").trim(),
      unit_label: String(row.unit_label || "").trim() || "-",
      quantity: 0,
      amount: includeAmounts ? 0 : undefined,
    };
    existing.quantity = toQuantity(existing.quantity + Number(row.quantity || 0), 3);
    if (includeAmounts) {
      existing.amount = toAmount(Number(existing.amount || 0) + Number(row.amount || 0), 2);
    }
    grouped.set(key, existing);
  });

  return [...grouped.values()]
    .map((row) => {
      if (!includeAmounts) {
        return {
          article_id: row.article_id,
          article_name: row.article_name,
          stock_type: row.stock_type,
          unit_label: row.unit_label,
          quantity: row.quantity,
        };
      }
      return {
        ...row,
        rate: hasNonZeroQuantity(row.quantity) ? toAmount(row.amount / row.quantity, 4) : 0,
      };
    })
    .sort((a, b) => String(a.article_name || "").localeCompare(String(b.article_name || "")));
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
    existing.quantity = toQuantity(existing.quantity + Number(row.quantity || 0), 3);
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
  const filters = parseFilters({ req, input, includeRateTypeFilter: includeAmounts });

  const [branches, productGroups, productSubgroups, unitOptions] = await Promise.all([
    loadBranchOptions(req),
    loadProductGroupOptions(filters.stockType),
    loadProductSubgroupOptions(filters.stockType),
    loadUnitOptions(filters.stockType),
  ]);

  const unitOptionById = new Map(
    (unitOptions || []).map((option) => [Number(option.id), option]),
  );

  let selectedUnitId = filters.unitId;
  if (selectedUnitId && !unitOptionById.has(Number(selectedUnitId))) {
    selectedUnitId = null;
    filters.invalidFilterInput = true;
  }
  if (filters.stockType === STOCK_TYPES.rawMaterial) {
    selectedUnitId = null;
  }

  const options = {
    branches,
    productGroups,
    productSubgroups,
    units: unitOptions,
    stockTypes: [
      { value: STOCK_TYPES.finished, labelKey: "finished" },
      { value: STOCK_TYPES.semiFinished, labelKey: "semi_finished" },
      { value: STOCK_TYPES.rawMaterial, labelKey: "raw_materials" },
    ],
    viewFilters: [
      { value: VIEW_TYPES.details, labelKey: "details" },
      { value: VIEW_TYPES.summary, labelKey: "summary" },
    ],
    stockStatuses: [
      { value: STOCK_STATUS_TYPES.packed, labelKey: "packed" },
      { value: STOCK_STATUS_TYPES.loose, labelKey: "loose" },
    ],
    rateTypes: includeAmounts
      ? [
          { value: RATE_TYPES.sale, labelKey: "sale_rate_basis" },
          { value: RATE_TYPES.cost, labelKey: "cost_rate_basis" },
        ]
      : [],
  };

  filters.unitId = selectedUnitId;

  if (!filters.reportLoaded) {
    return {
      filters,
      options,
      reportData: buildDefaultReportData({ includeAmounts }),
    };
  }

  const uomContext = await loadUomContext();

  const [fgSfgDetailRows, rmDetailRows] = await Promise.all([
    loadFgSfgDetailRows({ filters, selectedUnitId, uomContext, includeAmounts }),
    loadRmDetailRows({ filters, includeAmounts }),
  ]);

  const fgSfgSummaryRows = buildFgSfgSummaryRows(fgSfgDetailRows, { includeAmounts });
  const rmSummaryRows = buildRmSummaryRows(rmDetailRows);

  const totals = {
    fgSfgQuantity: toQuantity(
      fgSfgDetailRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      3,
    ),
    rmQuantity: toQuantity(
      rmDetailRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      3,
    ),
    rmAmount: includeAmounts
      ? toAmount(rmDetailRows.reduce((sum, row) => sum + Number(row.amount || 0), 0), 2)
      : null,
    fgSfgAmount: includeAmounts
      ? toAmount(fgSfgDetailRows.reduce((sum, row) => sum + Number(row.amount || 0), 0), 2)
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
};
