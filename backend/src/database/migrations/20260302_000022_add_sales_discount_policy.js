exports.up = async function up(knex) {
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("sales_discount_policy");

  if (!hasTable) {
    await knex.schema.withSchema("erp").createTable("sales_discount_policy", (table) => {
      table.bigIncrements("id").primary();
      table
        .bigInteger("product_group_id")
        .notNullable()
        .references("id")
        .inTable("erp.product_groups")
        .onDelete("RESTRICT");
      table.decimal("max_pair_discount", 18, 2).notNullable().defaultTo(0);
      table.boolean("is_active").notNullable().defaultTo(true);
      table
        .bigInteger("created_by")
        .nullable()
        .references("id")
        .inTable("erp.users")
        .onDelete("RESTRICT");
      table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table
        .bigInteger("updated_by")
        .nullable()
        .references("id")
        .inTable("erp.users")
        .onDelete("RESTRICT");
      table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.unique(["product_group_id"], {
        indexName: "sales_discount_policy_product_group_unique",
      });
    });

    await knex.raw(`
      ALTER TABLE erp.sales_discount_policy
      ADD CONSTRAINT sales_discount_policy_max_pair_discount_check
      CHECK (max_pair_discount >= 0)
    `);
  }

  await knex("erp.permission_scope_registry")
    .insert({
      scope_type: "SCREEN",
      scope_key: "master_data.basic_info.sales_discount_policies",
      description: "Sales Discount Policies",
      module_group: "Master Data",
    })
    .onConflict(["scope_type", "scope_key"])
    .ignore();

  const approvalRows = ["create", "edit", "delete"].map((action) => ({
    entity_type: "SCREEN",
    entity_key: "master_data.basic_info.sales_discount_policies",
    action,
    requires_approval: false,
  }));

  await knex("erp.approval_policy")
    .insert(approvalRows)
    .onConflict(["entity_type", "entity_key", "action"])
    .ignore();
};

exports.down = async function down(knex) {
  await knex("erp.approval_policy")
    .where({
      entity_type: "SCREEN",
      entity_key: "master_data.basic_info.sales_discount_policies",
    })
    .del();

  const scopeRow = await knex("erp.permission_scope_registry")
    .select("id")
    .where({
      scope_type: "SCREEN",
      scope_key: "master_data.basic_info.sales_discount_policies",
    })
    .first();

  if (scopeRow?.id) {
    await knex("erp.user_permissions_override")
      .where({ scope_id: scopeRow.id })
      .del();
    await knex("erp.role_permissions")
      .where({ scope_id: scopeRow.id })
      .del();
    await knex("erp.permission_scope_registry")
      .where({ id: scopeRow.id })
      .del();
  }

  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("sales_discount_policy");
  if (hasTable) {
    await knex.schema.withSchema("erp").dropTable("sales_discount_policy");
  }
};
