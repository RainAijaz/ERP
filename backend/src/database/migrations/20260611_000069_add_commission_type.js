exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
    ADD COLUMN IF NOT EXISTS commission_type text NOT NULL DEFAULT 'SALESMAN_SALE'
      CHECK (commission_type IN ('SALESMAN_SALE', 'BRANCH_SALE', 'TRANSFER', 'PARTY'))
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
    DROP COLUMN IF EXISTS commission_type
  `);
};
