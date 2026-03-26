exports.up = async function up(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_header_single_draft");
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_header_single_draft
    ON erp.bom_header (item_id, level, created_by)
    WHERE status = 'DRAFT'
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_header_single_draft");
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_header_single_draft
    ON erp.bom_header (item_id, level)
    WHERE status = 'DRAFT'
  `);
};
