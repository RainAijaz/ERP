exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_voucher_header_type_no
    ON erp.voucher_header (voucher_type_code, voucher_no)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_voucher_header_type_status_id
    ON erp.voucher_header (voucher_type_code, status, id DESC)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_voucher_header_branch_type_status_id
    ON erp.voucher_header (branch_id, voucher_type_code, status, id DESC)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS erp.idx_voucher_header_branch_type_status_id`);
  await knex.raw(`DROP INDEX IF EXISTS erp.idx_voucher_header_type_status_id`);
  await knex.raw(`DROP INDEX IF EXISTS erp.idx_voucher_header_type_no`);
};
