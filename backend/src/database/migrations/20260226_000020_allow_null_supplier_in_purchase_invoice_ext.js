exports.up = async function up(knex) {
  const hasTable = await knex.schema.withSchema("erp").hasTable("purchase_invoice_header_ext");
  if (!hasTable) return;

  const hasColumn = await knex.schema.withSchema("erp").hasColumn("purchase_invoice_header_ext", "supplier_party_id");
  if (!hasColumn) return;

  await knex.raw(`
    ALTER TABLE erp.purchase_invoice_header_ext
    ALTER COLUMN supplier_party_id DROP NOT NULL
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.withSchema("erp").hasTable("purchase_invoice_header_ext");
  if (!hasTable) return;

  const hasColumn = await knex.schema.withSchema("erp").hasColumn("purchase_invoice_header_ext", "supplier_party_id");
  if (!hasColumn) return;

  const rowWithNullSupplier = await knex("erp.purchase_invoice_header_ext")
    .whereNull("supplier_party_id")
    .first();
  if (rowWithNullSupplier) return;

  await knex.raw(`
    ALTER TABLE erp.purchase_invoice_header_ext
    ALTER COLUMN supplier_party_id SET NOT NULL
  `);
};
