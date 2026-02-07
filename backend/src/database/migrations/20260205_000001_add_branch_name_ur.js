exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn("erp.branches", "name_ur");
  if (!hasColumn) {
    await knex.schema.alterTable("erp.branches", (table) => {
      table.text("name_ur");
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn("erp.branches", "name_ur");
  if (hasColumn) {
    await knex.schema.alterTable("erp.branches", (table) => {
      table.dropColumn("name_ur");
    });
  }
};
