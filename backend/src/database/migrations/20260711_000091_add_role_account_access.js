const TABLE = "role_account_access";

exports.up = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (hasTable) return;

  await knex.schema.withSchema("erp").createTable(TABLE, (table) => {
    table.bigIncrements("id").primary();
    table
      .bigInteger("role_id")
      .notNullable()
      .references("id")
      .inTable("erp.role_templates")
      .onDelete("CASCADE");
    table
      .bigInteger("account_id")
      .notNullable()
      .references("id")
      .inTable("erp.accounts")
      .onDelete("CASCADE");
    table.boolean("can_view_summary").notNullable().defaultTo(true);
    table.boolean("can_view_details").notNullable().defaultTo(true);
    table
      .bigInteger("created_by")
      .nullable()
      .references("id")
      .inTable("erp.users")
      .onDelete("SET NULL");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());

    table.unique(
      ["role_id", "account_id"],
      "uq_role_account_access_role_account",
    );
    table.index(["role_id"], "idx_role_account_access_role");
    table.index(["account_id"], "idx_role_account_access_account");
  });
};

exports.down = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (!hasTable) return;
  await knex.schema.withSchema("erp").dropTable(TABLE);
};
