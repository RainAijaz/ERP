exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.bom_sku_override_line
    ADD COLUMN IF NOT EXISTS rm_size_id bigint REFERENCES erp.sizes(id) ON DELETE RESTRICT
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.bom_sku_override_line
    DROP COLUMN IF EXISTS rm_size_id
  `);
};
