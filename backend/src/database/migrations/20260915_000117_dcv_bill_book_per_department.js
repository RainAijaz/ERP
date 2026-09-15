exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE IF EXISTS erp.dcv_header
      ADD COLUMN IF NOT EXISTS bill_book_no text
  `);

  await knex.raw(`
    ALTER TABLE IF EXISTS erp.dcv_line
      ADD COLUMN IF NOT EXISTS bill_book_no text
  `);

  await knex.raw(`
    UPDATE erp.dcv_header dh
    SET bill_book_no = NULLIF(trim(vh.book_no), '')
    FROM erp.voucher_header vh
    WHERE vh.id = dh.voucher_id
      AND NULLIF(trim(COALESCE(dh.bill_book_no, '')), '') IS NULL
      AND NULLIF(trim(COALESCE(vh.book_no, '')), '') IS NOT NULL
  `);

  await knex.raw(`
    UPDATE erp.dcv_line dl
    SET bill_book_no = COALESCE(NULLIF(trim(dh.bill_book_no), ''), NULLIF(trim(vh.book_no), ''))
    FROM erp.voucher_line vl
    JOIN erp.voucher_header vh ON vh.id = vl.voucher_header_id
    JOIN erp.dcv_header dh ON dh.voucher_id = vh.id
    WHERE vl.id = dl.voucher_line_id
      AND NULLIF(trim(COALESCE(dl.bill_book_no, '')), '') IS NULL
      AND COALESCE(NULLIF(trim(dh.bill_book_no), ''), NULLIF(trim(vh.book_no), '')) IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_dcv_line_bill_book_no
      ON erp.dcv_line(bill_book_no)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS erp.idx_dcv_line_bill_book_no`);
  await knex.raw(`
    ALTER TABLE IF EXISTS erp.dcv_line
      DROP COLUMN IF EXISTS bill_book_no
  `);
  await knex.raw(`
    ALTER TABLE IF EXISTS erp.dcv_header
      DROP COLUMN IF EXISTS bill_book_no
  `);
};
