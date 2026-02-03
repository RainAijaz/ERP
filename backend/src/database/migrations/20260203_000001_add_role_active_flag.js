exports.up = async (knex) => {
  await knex.schema.alterTable("erp.role_templates", (table) => {
    table.boolean("is_active").notNullable().defaultTo(true);
  });

  await knex("erp.role_templates").update({ is_active: true });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("erp.role_templates", (table) => {
    table.dropColumn("is_active");
  });
};
