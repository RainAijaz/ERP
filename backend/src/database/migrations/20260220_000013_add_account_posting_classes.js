exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable("erp.account_posting_classes");
  if (!hasTable) {
    await knex.schema.withSchema("erp").createTable("account_posting_classes", (table) => {
      table.bigIncrements("id").primary();
      table.text("code").notNullable().unique();
      table.text("name").notNullable().unique();
      table.text("name_ur");
      table.boolean("is_system").notNullable().defaultTo(true);
      table.boolean("is_active").notNullable().defaultTo(true);
      table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp("updated_at", { useTz: true });
    });
  }

  await knex.raw(`
    INSERT INTO erp.account_posting_classes (code, name, is_system, is_active)
    VALUES
      ('bank', 'Bank', true, true),
      ('cash', 'Cash', true, true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      is_system = EXCLUDED.is_system,
      is_active = EXCLUDED.is_active
  `);

  const hasColumn = await knex.schema.hasColumn("erp.accounts", "posting_class_id");
  if (!hasColumn) {
    await knex.schema.alterTable("erp.accounts", (table) => {
      table.bigInteger("posting_class_id").nullable();
      table
        .foreign("posting_class_id")
        .references("id")
        .inTable("erp.account_posting_classes")
        .onDelete("RESTRICT");
    });
    await knex.schema.alterTable("erp.accounts", (table) => {
      table.index(["posting_class_id"], "idx_accounts_posting_class_id");
    });
  }

  // Backfill legacy bank-group accounts so existing auto bank settlement keeps working.
  await knex.raw(`
    UPDATE erp.accounts a
    SET posting_class_id = apc.id
    FROM erp.account_posting_classes apc, erp.account_groups ag
    WHERE apc.code = 'bank'
      AND ag.id = a.subgroup_id
      AND ag.code = 'bank'
      AND a.posting_class_id IS NULL
  `);
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn("erp.accounts", "posting_class_id");
  if (hasColumn) {
    await knex.schema.alterTable("erp.accounts", (table) => {
      table.dropIndex(["posting_class_id"], "idx_accounts_posting_class_id");
      table.dropColumn("posting_class_id");
    });
  }

  const hasTable = await knex.schema.hasTable("erp.account_posting_classes");
  if (hasTable) {
    await knex.schema.withSchema("erp").dropTable("account_posting_classes");
  }
};
