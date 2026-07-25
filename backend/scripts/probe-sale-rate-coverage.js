/* eslint-disable no-console */
const knex = require("../src/db/knex");

async function run() {
  // For the stock-count lines feeding the accuracy report, how many have a
  // usable variant.sale_rate, split by category?
  const rows = await knex({ vh: "erp.voucher_header" })
    .join({ vl: "erp.voucher_line" }, "vl.voucher_header_id", "vh.id")
    .join({ scl: "erp.stock_count_line" }, "scl.voucher_line_id", "vl.id")
    .join({ sch: "erp.stock_count_header" }, "sch.voucher_id", "vh.id")
    .join({ rc: "erp.reason_codes" }, "rc.id", "sch.reason_code_id")
    .leftJoin({ sk: "erp.skus" }, "sk.id", "vl.sku_id")
    .leftJoin({ v: "erp.variants" }, "v.id", "sk.variant_id")
    .where("vh.voucher_type_code", "STOCK_COUNT_ADJ")
    .where("vh.status", "APPROVED")
    .where("rc.code", "PHYSICAL_COUNT")
    .select(
      knex.raw("sch.item_type_scope as category"),
      knex.raw("COUNT(*)::int as lines"),
      knex.raw("COUNT(v.sale_rate)::int as have_variant"),
      knex.raw(
        "COUNT(*) FILTER (WHERE COALESCE(v.sale_rate,0) > 0)::int as have_positive_rate",
      ),
      knex.raw("COALESCE(AVG(NULLIF(v.sale_rate,0)),0)::numeric(18,2) as avg_rate"),
    )
    .groupByRaw("sch.item_type_scope")
    .orderByRaw("sch.item_type_scope");
  console.table(rows);

  await knex.destroy();
}
run().catch(async (e) => {
  console.error(e);
  await knex.destroy();
  process.exit(1);
});
