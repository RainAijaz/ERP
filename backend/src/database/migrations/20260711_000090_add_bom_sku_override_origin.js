exports.up = async function up(knex) {
  // Provenance of a per-SKU rule value so the in-form "auto"/"custom" tags and
  // the master-driven auto-copy survive a page reload:
  //   master = the size group's driver SKU (its edits propagate to auto peers)
  //   auto   = auto-copied from the master, still following it
  //   custom = a copy the user edited into an exception (independent)
  // NULL = legacy / unknown (treated as protected, shows no tag).
  await knex.raw(`
    ALTER TABLE erp.bom_sku_override_line
    ADD COLUMN IF NOT EXISTS origin text
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_sku_override_line
    DROP CONSTRAINT IF EXISTS bom_sku_override_line_origin_check
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_sku_override_line
    ADD CONSTRAINT bom_sku_override_line_origin_check
    CHECK (origin IS NULL OR origin IN ('master', 'auto', 'custom'))
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.bom_sku_override_line
    DROP CONSTRAINT IF EXISTS bom_sku_override_line_origin_check
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_sku_override_line
    DROP COLUMN IF EXISTS origin
  `);
};
