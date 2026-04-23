const TABLE = "inventory_negative_stock_override";

exports.up = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (hasTable) return;

  await knex.schema.withSchema("erp").createTable(TABLE, (table) => {
    table.bigIncrements("id").primary();
    table
      .text("voucher_type_code")
      .notNullable()
      .references("code")
      .inTable("erp.voucher_type")
      .onDelete("CASCADE");
    table.text("subject_type").notNullable();
    table.bigInteger("subject_id").notNullable();
    table.boolean("is_enabled").notNullable().defaultTo(true);
    table
      .bigInteger("created_by")
      .nullable()
      .references("id")
      .inTable("erp.users")
      .onDelete("SET NULL");
    table
      .bigInteger("updated_by")
      .nullable()
      .references("id")
      .inTable("erp.users")
      .onDelete("SET NULL");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());

    table.unique(
      ["voucher_type_code", "subject_type", "subject_id"],
      "uq_inv_neg_stock_override_subject",
    );
    table.index(["voucher_type_code"], "idx_inv_neg_stock_override_voucher");
    table.index(
      ["voucher_type_code", "subject_type", "subject_id", "is_enabled"],
      "idx_inv_neg_stock_override_lookup",
    );
  });

  await knex.raw(`
    ALTER TABLE erp.${TABLE}
    ADD CONSTRAINT ck_inv_neg_stock_override_subject_type
    CHECK (subject_type IN ('ROLE', 'USER'))
  `);
};

exports.down = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (!hasTable) return;
  await knex.schema.withSchema("erp").dropTable(TABLE);
};
