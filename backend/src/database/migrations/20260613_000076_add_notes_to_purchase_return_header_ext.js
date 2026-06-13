exports.up = async function up(knex) {
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("purchase_return_header_ext");
  if (!hasTable) return;

  const hasNotes = await knex.schema
    .withSchema("erp")
    .hasColumn("purchase_return_header_ext", "notes");
  if (hasNotes) return;

  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      ADD COLUMN notes text
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("purchase_return_header_ext");
  if (!hasTable) return;

  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      DROP COLUMN IF EXISTS notes
  `);
};
