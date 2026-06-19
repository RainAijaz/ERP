exports.up = async (knex) => {
  await knex.schema.withSchema("erp").alterTable("variants", (table) => {
    table.boolean("rate_editable").notNullable().defaultTo(false);
  });
};

exports.down = async (knex) => {
  await knex.schema.withSchema("erp").alterTable("variants", (table) => {
    table.dropColumn("rate_editable");
  });
};
