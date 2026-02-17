exports.up = async function up(knex) {
  await knex.schema.withSchema("erp").alterTable("labour_rate_rules", (table) => {
    table.date("effective_from").nullable();
    table.date("effective_to").nullable();
    table.text("notes").nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.withSchema("erp").alterTable("labour_rate_rules", (table) => {
    table.dropColumn("notes");
    table.dropColumn("effective_to");
    table.dropColumn("effective_from");
  });
};

