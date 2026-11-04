"use strict";

// Company-wide low-stock definition shared by the homepage KPI and chart.
// A zero minimum still flags negative stock; stock in transit is unavailable.
const buildLowStockMaterialsQuery = (knex) => knex("erp.items as i")
  .leftJoin("erp.stock_balance_rm as sb", function onHandOnly() {
    this.on("sb.item_id", "i.id").andOn("sb.stock_state", knex.raw("?", ["ON_HAND"]));
  })
  .where({ "i.item_type": "RM", "i.is_active": true })
  .where("i.min_stock_level", ">=", 0)
  .groupBy("i.id", "i.min_stock_level")
  .havingRaw("COALESCE(SUM(sb.qty),0) < i.min_stock_level")
  .select("i.id").timeout(12000, { cancel: true });

module.exports = { buildLowStockMaterialsQuery };
