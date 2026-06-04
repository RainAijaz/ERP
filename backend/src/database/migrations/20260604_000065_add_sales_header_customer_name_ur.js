exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.sales_header
    ADD COLUMN IF NOT EXISTS customer_name_ur text
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.sales_header
    DROP COLUMN IF EXISTS customer_name_ur
  `);
};
