exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_ledger
    ADD COLUMN IF NOT EXISTS is_packed boolean
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_stock_ledger_sku_is_packed
    ON erp.stock_ledger(sku_id, is_packed)
    WHERE sku_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS erp.idx_stock_ledger_sku_is_packed`);
  await knex.raw(`
    ALTER TABLE erp.stock_ledger
    DROP COLUMN IF EXISTS is_packed
  `);
};
