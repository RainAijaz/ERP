exports.up = async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("accounts", "bank_settlement_enabled");
  if (!hasColumn) {
    await knex.schema.withSchema("erp").alterTable("accounts", (table) => {
      table.boolean("bank_settlement_enabled").notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("accounts", "bank_settlement_enabled");
  if (hasColumn) {
    await knex.schema.withSchema("erp").alterTable("accounts", (table) => {
      table.dropColumn("bank_settlement_enabled");
    });
  }
};
