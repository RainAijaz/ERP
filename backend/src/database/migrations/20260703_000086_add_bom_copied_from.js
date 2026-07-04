exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.bom_header
    ADD COLUMN IF NOT EXISTS copied_from_bom_id bigint
      REFERENCES erp.bom_header(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_bom_header_copied_from
    ON erp.bom_header(copied_from_bom_id)
    WHERE copied_from_bom_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS erp.ix_bom_header_copied_from`);
  await knex.raw(`
    ALTER TABLE erp.bom_header
    DROP COLUMN IF EXISTS copied_from_bom_id
  `);
};
