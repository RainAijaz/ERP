exports.up = async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("voucher_header", "remarks_ur");
  if (!hasColumn) {
    await knex.schema
      .withSchema("erp")
      .alterTable("voucher_header", (table) => {
        table.text("remarks_ur");
      });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("voucher_header", "remarks_ur");
  if (hasColumn) {
    await knex.schema
      .withSchema("erp")
      .alterTable("voucher_header", (table) => {
        table.dropColumn("remarks_ur");
      });
  }
};
