exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE erp.bom_header
    ADD COLUMN IF NOT EXISTS department_rate_changes jsonb NOT NULL DEFAULT '[]'::jsonb`);
};

exports.down = async function down(knex) {
  await knex.raw("ALTER TABLE erp.bom_header DROP COLUMN IF EXISTS department_rate_changes");
};
