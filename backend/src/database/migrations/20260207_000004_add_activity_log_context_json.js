exports.up = async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("activity_log", "context_json");
  if (!hasColumn) {
    await knex.schema.withSchema("erp").alterTable("activity_log", (table) => {
      table.jsonb("context_json");
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("activity_log", "context_json");
  if (hasColumn) {
    await knex.schema.withSchema("erp").alterTable("activity_log", (table) => {
      table.dropColumn("context_json");
    });
  }
};
