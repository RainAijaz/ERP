exports.up = async (knex) => {
  const hasRoleHardDelete = await knex.schema.withSchema("erp").hasColumn("role_permissions", "can_hard_delete");
  if (!hasRoleHardDelete) {
    await knex.schema.withSchema("erp").alterTable("role_permissions", (table) => {
      table.boolean("can_hard_delete").notNullable().defaultTo(false);
    });
  }

  const hasUserHardDelete = await knex.schema.withSchema("erp").hasColumn("user_permissions_override", "can_hard_delete");
  if (!hasUserHardDelete) {
    await knex.schema.withSchema("erp").alterTable("user_permissions_override", (table) => {
      table.boolean("can_hard_delete").nullable().defaultTo(null);
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.alterTable("erp.user_permissions_override", (table) => {
    table.dropColumn("can_hard_delete");
  });

  await knex.schema.alterTable("erp.role_permissions", (table) => {
    table.dropColumn("can_hard_delete");
  });
};
