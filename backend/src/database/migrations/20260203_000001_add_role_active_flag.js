exports.up = async (knex) => {
  const hasIsActive = await knex.schema
    .withSchema("erp")
    .hasColumn("role_templates", "is_active");

  if (!hasIsActive) {
    await knex.schema
      .withSchema("erp")
      .alterTable("role_templates", (table) => {
        table.boolean("is_active").notNullable().defaultTo(true);
      });
  }

  await knex("erp.role_templates").update({ is_active: true });
};

exports.down = async (knex) => {
  const hasIsActive = await knex.schema
    .withSchema("erp")
    .hasColumn("role_templates", "is_active");

  if (hasIsActive) {
    await knex.schema
      .withSchema("erp")
      .alterTable("role_templates", (table) => {
        table.dropColumn("is_active");
      });
  }
};
