exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.voucher_header
    ADD COLUMN IF NOT EXISTS linked_sales_order_id bigint
      REFERENCES erp.voucher_header(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_voucher_header_linked_so
    ON erp.voucher_header(linked_sales_order_id)
    WHERE linked_sales_order_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS erp.idx_voucher_header_linked_so`);
  await knex.raw(`
    ALTER TABLE erp.voucher_header
    DROP COLUMN IF EXISTS linked_sales_order_id
  `);
};
