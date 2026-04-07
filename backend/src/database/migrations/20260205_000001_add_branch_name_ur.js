exports.up = async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("branches", "name_ur");
  if (!hasColumn) {
    await knex.schema.withSchema("erp").alterTable("branches", (table) => {
      table.text("name_ur");
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("branches", "name_ur");
  if (hasColumn) {
    await knex.schema.withSchema("erp").alterTable("branches", (table) => {
      table.dropColumn("name_ur");
    });
  }
};
