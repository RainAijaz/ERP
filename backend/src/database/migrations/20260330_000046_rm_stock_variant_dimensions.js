exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_ledger
    ADD COLUMN IF NOT EXISTS color_id bigint REFERENCES erp.colors(id) ON DELETE RESTRICT
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_ledger
    ADD COLUMN IF NOT EXISTS size_id bigint REFERENCES erp.sizes(id) ON DELETE RESTRICT
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_stock_ledger_rm_variant_date
    ON erp.stock_ledger (branch_id, item_id, color_id, size_id, txn_date)
    WHERE category = 'RM'
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
    ADD COLUMN IF NOT EXISTS color_id bigint REFERENCES erp.colors(id) ON DELETE RESTRICT
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
    ADD COLUMN IF NOT EXISTS size_id bigint REFERENCES erp.sizes(id) ON DELETE RESTRICT
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
    DROP CONSTRAINT IF EXISTS stock_balance_rm_pkey
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_balance_rm_identity
    ON erp.stock_balance_rm (
      branch_id,
      stock_state,
      item_id,
      COALESCE(color_id, 0),
      COALESCE(size_id, 0)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_stock_balance_rm_item_variant
    ON erp.stock_balance_rm (branch_id, stock_state, item_id, color_id, size_id)
  `);
};

exports.down = async function down(knex) {
  const duplicateRows = await knex("erp.stock_balance_rm")
    .select("branch_id", "stock_state", "item_id")
    .count("* as count")
    .groupBy("branch_id", "stock_state", "item_id")
    .havingRaw("count(*) > 1")
    .first();

  if (duplicateRows) {
    throw new Error(
      "Cannot rollback RM stock variant migration: stock_balance_rm contains multiple rows per item identity.",
    );
  }

  await knex.raw("DROP INDEX IF EXISTS erp.idx_stock_balance_rm_item_variant");
  await knex.raw("DROP INDEX IF EXISTS erp.ux_stock_balance_rm_identity");

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
    DROP COLUMN IF EXISTS color_id,
    DROP COLUMN IF EXISTS size_id
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
    ADD CONSTRAINT stock_balance_rm_pkey
    PRIMARY KEY (branch_id, stock_state, item_id)
  `);

  await knex.raw("DROP INDEX IF EXISTS erp.idx_stock_ledger_rm_variant_date");

  await knex.raw(`
    ALTER TABLE erp.stock_ledger
    DROP COLUMN IF EXISTS color_id,
    DROP COLUMN IF EXISTS size_id
  `);
};
