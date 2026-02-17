exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn("erp.labours", "production_category");
  if (!hasColumn) {
    await knex.schema.alterTable("erp.labours", (table) => {
      table.text("production_category").notNullable().defaultTo("finished");
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn("erp.labours", "production_category");
  if (hasColumn) {
    await knex.schema.alterTable("erp.labours", (table) => {
      table.dropColumn("production_category");
    });
  }
};
