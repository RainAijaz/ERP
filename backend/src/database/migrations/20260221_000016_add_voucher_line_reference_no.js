exports.up = async function up(knex) {
  const hasColumn = await knex.schema.withSchema("erp").hasColumn("voucher_line", "reference_no");
  if (!hasColumn) {
    await knex.schema.withSchema("erp").table("voucher_line", (table) => {
      table.string("reference_no", 120).nullable();
    });
  }

  await knex.raw(`
    UPDATE erp.voucher_line
    SET reference_no = NULLIF(meta->>'reference_no', '')
    WHERE reference_no IS NULL
      AND NULLIF(meta->>'reference_no', '') IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_voucher_line_reference_no
    ON erp.voucher_line (reference_no)
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.idx_voucher_line_reference_no");

  const hasColumn = await knex.schema.withSchema("erp").hasColumn("voucher_line", "reference_no");
  if (hasColumn) {
    await knex.schema.withSchema("erp").table("voucher_line", (table) => {
      table.dropColumn("reference_no");
    });
  }
};
