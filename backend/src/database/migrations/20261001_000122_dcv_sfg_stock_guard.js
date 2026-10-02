exports.up = async function up(knex) {
  await knex.schema.withSchema("erp").alterTable("voucher_type", (table) => {
    table.boolean("enforce_sfg_availability").notNullable().defaultTo(false);
  });
  await knex("erp.voucher_type")
    .where({ code: "DCV" })
    .update({ enforce_sfg_availability: true });
};

exports.down = async function down(knex) {
  await knex.schema.withSchema("erp").alterTable("voucher_type", (table) => {
    table.dropColumn("enforce_sfg_availability");
  });
};
