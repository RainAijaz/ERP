exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      ADD COLUMN IF NOT EXISTS bill_book_no text
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      DROP COLUMN IF EXISTS bill_book_no
  `);
};

