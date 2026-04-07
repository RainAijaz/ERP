exports.up = async function up(knex) {
  const hasVoucherHeader = await knex.schema
    .withSchema("erp")
    .hasTable("voucher_header");
  if (hasVoucherHeader) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_vh_report_branch_type_status_date_no
      ON erp.voucher_header (branch_id, voucher_type_code, status, voucher_date, voucher_no, id)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_vh_report_type_status_date_no
      ON erp.voucher_header (voucher_type_code, status, voucher_date, voucher_no, id)
    `);
  }

  const hasVoucherLine = await knex.schema
    .withSchema("erp")
    .hasTable("voucher_line");
  if (hasVoucherLine) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_vl_report_header_kind_line_no
      ON erp.voucher_line (voucher_header_id, line_kind, line_no)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_vl_report_account_header_line_no
      ON erp.voucher_line (account_id, voucher_header_id, line_no)
      WHERE line_kind = 'ACCOUNT'
    `);
  }

  const hasGlEntry = await knex.schema.withSchema("erp").hasTable("gl_entry");
  if (hasGlEntry) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_gl_entry_account_branch_date_id
      ON erp.gl_entry (account_id, branch_id, entry_date, id)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_gl_entry_branch_account_date_id
      ON erp.gl_entry (branch_id, account_id, entry_date, id)
    `);
  }

  const hasStockLedger = await knex.schema
    .withSchema("erp")
    .hasTable("stock_ledger");
  if (hasStockLedger) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_stock_ledger_onhand_branch_txn_date
      ON erp.stock_ledger (branch_id, txn_date)
      WHERE stock_state = 'ON_HAND'
    `);
  }

  const hasSalesHeader = await knex.schema
    .withSchema("erp")
    .hasTable("sales_header");
  if (hasSalesHeader) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_sales_header_customer_party
      ON erp.sales_header (customer_party_id)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_sales_header_linked_sales_order
      ON erp.sales_header (linked_sales_order_id)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_sales_header_salesman_employee
      ON erp.sales_header (salesman_employee_id)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_sales_header_receive_account
      ON erp.sales_header (receive_into_account_id)
    `);
  }
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.idx_sales_header_receive_account");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_sales_header_salesman_employee");
  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_sales_header_linked_sales_order",
  );
  await knex.raw("DROP INDEX IF EXISTS erp.idx_sales_header_customer_party");

  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_stock_ledger_onhand_branch_txn_date",
  );

  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_gl_entry_branch_account_date_id",
  );
  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_gl_entry_account_branch_date_id",
  );

  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_vl_report_account_header_line_no",
  );
  await knex.raw("DROP INDEX IF EXISTS erp.idx_vl_report_header_kind_line_no");

  await knex.raw("DROP INDEX IF EXISTS erp.idx_vh_report_type_status_date_no");
  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_vh_report_branch_type_status_date_no",
  );
};
