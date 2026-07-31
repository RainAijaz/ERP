// Global semi-finished items.
//
// Most SFG items belong to specific articles: they are linked through
// erp.item_usage, and their variants are auto-generated to mirror the sizes and
// colours of the finished goods they are linked to.
//
// A global SFG is a shared component used by every article, with no dimensions
// of its own (e.g. a part that is identical regardless of article or size). It
// carries NO item_usage rows -- the flag replaces per-article linking -- and its
// SKUs are created by hand rather than mirrored from any article.
//
// The flag is only meaningful for SFG items, hence the CHECK.

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.items
    ADD COLUMN IF NOT EXISTS is_global_sfg boolean NOT NULL DEFAULT false
  `);
  await knex.raw(`
    ALTER TABLE erp.items
    DROP CONSTRAINT IF EXISTS items_is_global_sfg_requires_sfg
  `);
  await knex.raw(`
    ALTER TABLE erp.items
    ADD CONSTRAINT items_is_global_sfg_requires_sfg
    CHECK (is_global_sfg = false OR item_type = 'SFG')
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_items_is_global_sfg
    ON erp.items(is_global_sfg)
    WHERE is_global_sfg = true
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS erp.ix_items_is_global_sfg`);
  await knex.raw(`
    ALTER TABLE erp.items
    DROP CONSTRAINT IF EXISTS items_is_global_sfg_requires_sfg
  `);
  await knex.raw(`
    ALTER TABLE erp.items
    DROP COLUMN IF EXISTS is_global_sfg
  `);
};
