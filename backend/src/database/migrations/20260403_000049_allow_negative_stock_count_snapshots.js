exports.up = async function up(knex) {
  // Stock count negative-stock workflows require snapshot columns to accept negative values.
  await knex.raw(`
    ALTER TABLE erp.stock_count_line
      DROP CONSTRAINT IF EXISTS stock_count_line_system_qty_snapshot_check,
      DROP CONSTRAINT IF EXISTS stock_count_line_system_qty_pairs_snapshot_check,
      DROP CONSTRAINT IF EXISTS stock_count_line_physical_qty_check,
      DROP CONSTRAINT IF EXISTS stock_count_line_physical_qty_pairs_check
  `);
};

exports.down = async function down(knex) {
  // Restore original non-negative snapshot constraints.
  await knex.raw(`
    ALTER TABLE erp.stock_count_line
      DROP CONSTRAINT IF EXISTS stock_count_line_system_qty_snapshot_check,
      DROP CONSTRAINT IF EXISTS stock_count_line_system_qty_pairs_snapshot_check,
      DROP CONSTRAINT IF EXISTS stock_count_line_physical_qty_check,
      DROP CONSTRAINT IF EXISTS stock_count_line_physical_qty_pairs_check
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_count_line
      ADD CONSTRAINT stock_count_line_system_qty_snapshot_check
        CHECK (system_qty_snapshot >= 0),
      ADD CONSTRAINT stock_count_line_system_qty_pairs_snapshot_check
        CHECK (system_qty_pairs_snapshot >= 0),
      ADD CONSTRAINT stock_count_line_physical_qty_check
        CHECK (physical_qty >= 0),
      ADD CONSTRAINT stock_count_line_physical_qty_pairs_check
        CHECK (physical_qty_pairs >= 0)
  `);
};
