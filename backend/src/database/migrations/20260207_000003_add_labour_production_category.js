exports.up = async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("labours", "production_category");
  if (!hasColumn) {
    await knex.schema.withSchema("erp").alterTable("labours", (table) => {
      table.text("production_category").notNullable().defaultTo("finished");
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("labours", "production_category");
  if (hasColumn) {
    await knex.schema.withSchema("erp").alterTable("labours", (table) => {
      table.dropColumn("production_category");
    });
  }
};
