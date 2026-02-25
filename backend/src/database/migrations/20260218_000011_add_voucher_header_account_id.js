/**
 * Persist selected cash/bank header account on voucher header.
 */
exports.up = async function up(knex) {
  const hasColumn = await knex.schema.withSchema("erp").hasColumn("voucher_header", "header_account_id");
  if (!hasColumn) {
    await knex.schema.withSchema("erp").table("voucher_header", (table) => {
      table.bigInteger("header_account_id").nullable();
    });
  }

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_voucher_header_header_account'
          AND conrelid = 'erp.voucher_header'::regclass
      ) THEN
        ALTER TABLE erp.voucher_header
          ADD CONSTRAINT fk_voucher_header_header_account
          FOREIGN KEY (header_account_id)
          REFERENCES erp.accounts(id)
          ON DELETE RESTRICT;
      END IF;
    END$$;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_voucher_header_header_account_id
    ON erp.voucher_header (header_account_id)
  `);

  // Best-effort backfill for existing cash/bank vouchers from the first ACCOUNT line.
  await knex.raw(`
    UPDATE erp.voucher_header vh
    SET header_account_id = src.account_id
    FROM (
      SELECT DISTINCT ON (vl.voucher_header_id)
        vl.voucher_header_id,
        vl.account_id
      FROM erp.voucher_line vl
      JOIN erp.voucher_header vh2 ON vh2.id = vl.voucher_header_id
      WHERE vl.line_kind = 'ACCOUNT'
        AND vl.account_id IS NOT NULL
        AND vh2.voucher_type_code IN ('CASH_VOUCHER', 'BANK_VOUCHER')
      ORDER BY vl.voucher_header_id, vl.line_no ASC
    ) src
    WHERE vh.id = src.voucher_header_id
      AND vh.header_account_id IS NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw("ALTER TABLE erp.voucher_header DROP CONSTRAINT IF EXISTS fk_voucher_header_header_account");
  const hasColumn = await knex.schema.withSchema("erp").hasColumn("voucher_header", "header_account_id");
  if (hasColumn) {
    await knex.schema.withSchema("erp").table("voucher_header", (table) => {
      table.dropColumn("header_account_id");
    });
  }
};
