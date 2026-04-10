const TABLE = "user_account_access";

exports.up = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (hasTable) return;

  await knex.schema.withSchema("erp").createTable(TABLE, (table) => {
    table.bigIncrements("id").primary();
    table
      .bigInteger("user_id")
      .notNullable()
      .references("id")
      .inTable("erp.users")
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
      ["user_id", "account_id"],
      "uq_user_account_access_user_account",
    );
    table.index(["user_id"], "idx_user_account_access_user");
    table.index(["account_id"], "idx_user_account_access_account");
    table.index(
      ["user_id", "can_view_summary"],
      "idx_user_account_access_summary",
    );
    table.index(
      ["user_id", "can_view_details"],
      "idx_user_account_access_details",
    );
  });
};

exports.down = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (!hasTable) return;
  await knex.schema.withSchema("erp").dropTable(TABLE);
};
