exports.up = async function up(knex) {
  const hasContraColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("account_groups", "is_contra");

  if (!hasContraColumn) return;

  await knex.schema.withSchema("erp").alterTable("account_groups", (table) => {
    table.dropColumn("is_contra");
  });
};

exports.down = async function down(knex) {
  const hasContraColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("account_groups", "is_contra");

  if (hasContraColumn) return;

  await knex.schema.withSchema("erp").alterTable("account_groups", (table) => {
    table.boolean("is_contra").notNullable().defaultTo(false);
  });
};
