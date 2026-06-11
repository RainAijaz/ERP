exports.up = async function up(knex) {
  const hasPaymentType = await knex.schema
    .withSchema("erp")
    .hasColumn("purchase_return_header_ext", "payment_type");

  if (!hasPaymentType) {
    await knex.raw(`
      ALTER TABLE erp.purchase_return_header_ext
        ADD COLUMN payment_type         text    NOT NULL DEFAULT 'CREDIT',
        ADD COLUMN cash_paid_account_id bigint  REFERENCES erp.accounts(id)
    `);

    // Backfill existing rows — all existing PRs were credit by definition
    await knex.raw(`
      UPDATE erp.purchase_return_header_ext
      SET payment_type = 'CREDIT', cash_paid_account_id = NULL
    `);

    await knex.raw(`
      ALTER TABLE erp.purchase_return_header_ext
        ADD CONSTRAINT purchase_return_hdr_payment_chk
        CHECK (
          (payment_type = 'CREDIT' AND cash_paid_account_id IS NULL)
          OR
          (payment_type = 'CASH'   AND cash_paid_account_id IS NOT NULL)
        )
    `);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      DROP CONSTRAINT IF EXISTS purchase_return_hdr_payment_chk,
      DROP COLUMN IF EXISTS cash_paid_account_id,
      DROP COLUMN IF EXISTS payment_type
  `);
};
