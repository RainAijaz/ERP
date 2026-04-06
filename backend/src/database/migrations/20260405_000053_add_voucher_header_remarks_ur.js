exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn(
    "erp.voucher_header",
    "remarks_ur",
  );
  if (!hasColumn) {
    await knex.schema.alterTable("erp.voucher_header", (table) => {
      table.text("remarks_ur");
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn(
    "erp.voucher_header",
    "remarks_ur",
  );
  if (hasColumn) {
    await knex.schema.alterTable("erp.voucher_header", (table) => {
      table.dropColumn("remarks_ur");
    });
  }
};
