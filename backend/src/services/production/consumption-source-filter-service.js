const { applyReportArticleFilters } = require("../inventory/report-article-filter-service");

// Consumption is filtered by the produced article, not by the component's name.
// Older SFG rows were combined per component/department; their posted component
// ledger still links each quantity to its original production voucher line.
const filterConsumptionByProductionArticle = async ({ db, rows, filters }) => {
  if (!filters.articleIds.length && !filters.skuIds.length) return { rows, unattributedCount: 0 };
  try {
    const sourceIds = [...new Set(rows.map(row => Number(row.source_production_id)).filter(Boolean))];
    if (!sourceIds.length) return { rows: [], unattributedCount: rows.length };
    const outputs = await db("erp.voucher_line as output")
      .join("erp.skus as s", "s.id", "output.sku_id").join("erp.variants as v", "v.id", "s.variant_id")
      .select("output.voucher_header_id", "output.sku_id", "v.item_id")
      .whereIn("output.voucher_header_id", sourceIds).where("output.line_kind", "SKU");
    const matchingQuery = db("erp.skus as s").join("erp.variants as v", "v.id", "s.variant_id")
      .whereIn("s.id", [...new Set(outputs.map(row => row.sku_id))]).select("s.id");
    applyReportArticleFilters(matchingQuery, filters, { articleColumn: "v.item_id" });
    const matches = new Set((await matchingQuery).map(row => Number(row.id)));
    const sourceSkus = new Map();
    for (const row of outputs) {
      const id = Number(row.voucher_header_id);
      if (!sourceSkus.has(id)) sourceSkus.set(id, new Set());
      sourceSkus.get(id).add(Number(row.sku_id));
    }
    const legacyRows = rows.filter(row => !Number(row.metaObj?.source_sku_id) && sourceSkus.get(Number(row.source_production_id))?.size > 1);
    const allocations = new Map();
    if (legacyRows.length) {
      const ledger = await db("erp.stock_ledger as sl")
        .join("erp.voucher_line as output", "output.id", "sl.voucher_line_id")
        .leftJoin("erp.dcv_line as dl", "dl.voucher_line_id", "output.id")
        .leftJoin("erp.dcv_header as dh", "dh.voucher_id", "sl.voucher_header_id")
        .whereIn("sl.voucher_header_id", [...new Set(legacyRows.map(row => row.source_production_id))])
        .where({ "sl.category": "SFG", "sl.direction": -1, "sl.stock_state": "ON_HAND" })
        .select("sl.voucher_header_id", "sl.sku_id", "sl.qty_pairs", "output.sku_id as source_sku_id")
        .select(db.raw("coalesce(dl.dept_id, dh.dept_id) as dept_id"));
      for (const row of ledger) {
        const key = `${row.voucher_header_id}:${row.sku_id}:${row.dept_id}`;
        if (!allocations.has(key)) allocations.set(key, new Map());
        const group = allocations.get(key), skuId = Number(row.source_sku_id);
        group.set(skuId, (group.get(skuId) || 0) + Number(row.qty_pairs));
      }
    }
    const filtered = [];
    let unattributedCount = 0;
    for (const row of rows) {
      const parentSkus = sourceSkus.get(Number(row.source_production_id)) || new Set();
      const explicit = Number(row.metaObj?.source_sku_id);
      const sourceSku = explicit || (parentSkus.size === 1 ? [...parentSkus][0] : 0);
      if (sourceSku && parentSkus.has(sourceSku)) {
        if (matches.has(sourceSku)) filtered.push({ ...row, metaObj: { ...row.metaObj, source_sku_id: sourceSku } });
        continue;
      }
      const department = Number(row.metaObj?.department_id || row.metaObj?.dept_id || row.source_dept_id);
      const group = allocations.get(`${row.source_production_id}:${row.sku_id}:${department}`);
      const total = group ? [...group.values()].reduce((sum, qty) => sum + qty, 0) : 0;
      if (row.metaObj?.source === "DCV_SFG_CONSUMPTION" && total > 0 && Math.abs(total - Number(row.qty)) < 0.0005) {
        for (const [skuId, qty] of group) if (matches.has(skuId)) {
          filtered.push({ ...row, qty, metaObj: { ...row.metaObj, source_sku_id: skuId } });
        }
      } else unattributedCount += 1;
    }
    return { rows: filtered, unattributedCount };
  } catch (err) {
    console.error("Error in ConsumptionSourceFilterService:", err);
    throw err;
  }
};

module.exports = { filterConsumptionByProductionArticle };
