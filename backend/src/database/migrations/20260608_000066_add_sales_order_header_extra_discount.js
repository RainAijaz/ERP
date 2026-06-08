exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.sales_order_header
    ADD COLUMN IF NOT EXISTS extra_discount numeric(18,2) NOT NULL DEFAULT 0 CHECK (extra_discount >= 0)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.sales_order_header
    DROP COLUMN IF EXISTS extra_discount
  `);
};
