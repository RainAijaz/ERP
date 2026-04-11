exports.up = async function up(knex) {
  const hasAccountsTable = await knex.schema.withSchema("erp").hasTable("accounts");
  if (!hasAccountsTable) return;
  const hasContraColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("accounts", "is_contra");
  if (!hasContraColumn) {
    await knex.schema.withSchema("erp").alterTable("accounts", (table) => {
      table.boolean("is_contra").notNullable().defaultTo(false);
    });
  }

  await knex.raw(`
    UPDATE erp.accounts AS a
    SET is_contra = COALESCE(ag.is_contra, false)
    FROM erp.account_groups AS ag
    WHERE ag.id = a.subgroup_id
  `);
};

exports.down = async function down(knex) {
  const hasAccountsTable = await knex.schema.withSchema("erp").hasTable("accounts");
  if (!hasAccountsTable) return;
  const hasContraColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("accounts", "is_contra");
  if (!hasContraColumn) return;
  await knex.schema.withSchema("erp").alterTable("accounts", (table) => {
    table.dropColumn("is_contra");
  });
};
