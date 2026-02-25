exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_labour_rate_rules_sku_id
    ON erp.labour_rate_rules (sku_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_labour_rate_rules_apply_on_subgroup
    ON erp.labour_rate_rules (apply_on, subgroup_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_labour_rate_rules_apply_on_group
    ON erp.labour_rate_rules (apply_on, group_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_items_type_subgroup_group
    ON erp.items (item_type, subgroup_id, group_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_skus_variant_id
    ON erp.skus (variant_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_variants_item_id
    ON erp.variants (item_id)
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.idx_variants_item_id");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_skus_variant_id");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_items_type_subgroup_group");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_labour_rate_rules_apply_on_group");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_labour_rate_rules_apply_on_subgroup");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_labour_rate_rules_sku_id");
};

