exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
    ADD COLUMN IF NOT EXISTS source_rule_id bigint REFERENCES erp.employee_commission_rules(id) ON DELETE SET NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
    DROP COLUMN IF EXISTS source_rule_id
  `);
};
