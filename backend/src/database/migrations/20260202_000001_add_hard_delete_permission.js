exports.up = async (knex) => {
  await knex.schema.alterTable("erp.role_permissions", (table) => {
    table.boolean("can_hard_delete").notNullable().defaultTo(false);
  });

  await knex.schema.alterTable("erp.user_permissions_override", (table) => {
    table.boolean("can_hard_delete").nullable().defaultTo(null);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("erp.user_permissions_override", (table) => {
    table.dropColumn("can_hard_delete");
  });

  await knex.schema.alterTable("erp.role_permissions", (table) => {
    table.dropColumn("can_hard_delete");
  });
};
