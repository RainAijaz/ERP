/**
 * Tests the RM unit-of-measure change stock block.
 * Verifies that the stock_balance_rm sum query (used in the new guard) works
 * correctly for items that have stock vs. items that do not.
 *
 * Run: node src/scripts/test-rm-uom-stock-block.js
 */
require("dotenv").config();

const knex = require("../db/knex");

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  PASS: ${msg}`);
};

async function run() {
  console.log("[test-rm-uom-stock-block] start");

  try {
    // 1. Verify the query itself executes without error
    const allStock = await knex("erp.stock_balance_rm")
      .sum("qty as total_qty")
      .first();
    assert(allStock !== undefined, "stock_balance_rm sum query returns a row");
    console.log(`  INFO: total RM stock across all items = ${allStock.total_qty}`);

    // 2. Find an RM item that HAS stock
    const withStock = await knex("erp.stock_balance_rm as sb")
      .join("erp.items as i", "i.id", "sb.item_id")
      .where("i.item_type", "RM")
      .groupBy("sb.item_id")
      .havingRaw("SUM(sb.qty) > 0")
      .select("sb.item_id")
      .first();

    if (withStock) {
      const stockRow = await knex("erp.stock_balance_rm")
        .where({ item_id: withStock.item_id })
        .sum("qty as total_qty")
        .first();
      const total = Number(stockRow.total_qty);
      assert(total > 0, `Item ${withStock.item_id} with stock returns total_qty > 0 (got ${total})`);
      console.log(`  INFO: item ${withStock.item_id} has stock qty = ${total}`);
    } else {
      console.log("  INFO: no RM items with stock found in DB — skipping positive-stock assertion");
    }

    // 3. Find an RM item that has NO stock (or one that doesn't exist in stock_balance_rm)
    const noStockItem = await knex("erp.items")
      .select("id")
      .where("item_type", "RM")
      .whereNotIn("id",
        knex("erp.stock_balance_rm").select("item_id").havingRaw("SUM(qty) > 0").groupBy("item_id")
      )
      .first();

    if (noStockItem) {
      const stockRow = await knex("erp.stock_balance_rm")
        .where({ item_id: noStockItem.id })
        .sum("qty as total_qty")
        .first();
      const total = Number(stockRow.total_qty);
      assert(total <= 0, `Item ${noStockItem.id} with no stock returns total_qty <= 0 (got ${total})`);
      console.log(`  INFO: item ${noStockItem.id} has zero/no stock qty = ${total}`);
    } else {
      console.log("  INFO: all RM items have stock — skipping zero-stock assertion");
    }

    // 4. Test the null-guard: query against a non-existent item_id
    const phantom = await knex("erp.stock_balance_rm")
      .where({ item_id: -999 })
      .sum("qty as total_qty")
      .first();
    assert(
      !phantom || Number(phantom.total_qty) === 0,
      "Non-existent item returns null/0 total_qty (null-guard works)"
    );

    // 5. Verify the guard condition as used in raw-materials.js and approval-applier.js
    const guardTriggersCorrectly = (row) => row && Number(row.total_qty) > 0;

    assert(!guardTriggersCorrectly(undefined), "guard: undefined → does NOT block");
    assert(!guardTriggersCorrectly({ total_qty: null }), "guard: null total_qty → does NOT block");
    assert(!guardTriggersCorrectly({ total_qty: "0" }), "guard: zero total_qty → does NOT block");
    assert(!guardTriggersCorrectly({ total_qty: "0.000" }), "guard: '0.000' → does NOT block");
    assert(guardTriggersCorrectly({ total_qty: "5.000" }), "guard: '5.000' → DOES block");
    assert(guardTriggersCorrectly({ total_qty: "0.001" }), "guard: '0.001' → DOES block");

    console.log("\n[test-rm-uom-stock-block] ALL TESTS PASSED");
  } catch (err) {
    console.error("\n[test-rm-uom-stock-block]", err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
}

run();
