exports.up = async function up(knex) {
  const hasRoleNameUr = await knex.schema
    .withSchema("erp")
    .hasColumn("role_templates", "name_ur");
  if (!hasRoleNameUr) {
    await knex.schema
      .withSchema("erp")
      .alterTable("role_templates", (table) => {
        table.text("name_ur");
      });
  }

  const hasUserName = await knex.schema
    .withSchema("erp")
    .hasColumn("users", "name");
  if (!hasUserName) {
    await knex.schema.withSchema("erp").alterTable("users", (table) => {
      table.text("name");
    });
  }

  const hasUserNameUr = await knex.schema
    .withSchema("erp")
    .hasColumn("users", "name_ur");
  if (!hasUserNameUr) {
    await knex.schema.withSchema("erp").alterTable("users", (table) => {
      table.text("name_ur");
    });
  }
};

exports.down = async function down(knex) {
  const hasUserNameUr = await knex.schema
    .withSchema("erp")
    .hasColumn("users", "name_ur");
  if (hasUserNameUr) {
    await knex.schema.withSchema("erp").alterTable("users", (table) => {
      table.dropColumn("name_ur");
    });
  }

  const hasUserName = await knex.schema
    .withSchema("erp")
    .hasColumn("users", "name");
  if (hasUserName) {
    await knex.schema.withSchema("erp").alterTable("users", (table) => {
      table.dropColumn("name");
    });
  }

  const hasRoleNameUr = await knex.schema
    .withSchema("erp")
    .hasColumn("role_templates", "name_ur");
  if (hasRoleNameUr) {
    await knex.schema
      .withSchema("erp")
      .alterTable("role_templates", (table) => {
        table.dropColumn("name_ur");
      });
  }
};
