exports.up = async function up(knex) {
  const hasRoleNameUr = await knex.schema.hasColumn("erp.role_templates", "name_ur");
  if (!hasRoleNameUr) {
    await knex.schema.alterTable("erp.role_templates", (table) => {
      table.text("name_ur");
    });
  }

  const hasUserName = await knex.schema.hasColumn("erp.users", "name");
  if (!hasUserName) {
    await knex.schema.alterTable("erp.users", (table) => {
      table.text("name");
    });
  }

  const hasUserNameUr = await knex.schema.hasColumn("erp.users", "name_ur");
  if (!hasUserNameUr) {
    await knex.schema.alterTable("erp.users", (table) => {
      table.text("name_ur");
    });
  }
};

exports.down = async function down(knex) {
  const hasUserNameUr = await knex.schema.hasColumn("erp.users", "name_ur");
  if (hasUserNameUr) {
    await knex.schema.alterTable("erp.users", (table) => {
      table.dropColumn("name_ur");
    });
  }

  const hasUserName = await knex.schema.hasColumn("erp.users", "name");
  if (hasUserName) {
    await knex.schema.alterTable("erp.users", (table) => {
      table.dropColumn("name");
    });
  }

  const hasRoleNameUr = await knex.schema.hasColumn("erp.role_templates", "name_ur");
  if (hasRoleNameUr) {
    await knex.schema.alterTable("erp.role_templates", (table) => {
      table.dropColumn("name_ur");
    });
  }
};
