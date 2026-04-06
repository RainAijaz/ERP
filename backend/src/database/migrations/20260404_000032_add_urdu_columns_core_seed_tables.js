exports.up = async function up(knex) {
  const addColumnIfMissing = async (tableName, columnName) => {
    const hasColumn = await knex.schema
      .withSchema("erp")
      .hasColumn(tableName, columnName);
    if (hasColumn) return;
    await knex.schema.withSchema("erp").alterTable(tableName, (table) => {
      table.text(columnName);
    });
  };

  await addColumnIfMissing("role_templates", "description_ur");

  await addColumnIfMissing("entity_type_registry", "name_ur");
  await addColumnIfMissing("entity_type_registry", "description_ur");

  await addColumnIfMissing("audit_action_registry", "name_ur");
  await addColumnIfMissing("audit_action_registry", "description_ur");

  await addColumnIfMissing("approval_request_type_registry", "name_ur");
  await addColumnIfMissing("approval_request_type_registry", "description_ur");

  await addColumnIfMissing("voucher_type", "name_ur");
  await addColumnIfMissing("return_reasons", "description_ur");

  await addColumnIfMissing("permission_scope_registry", "description_ur");
  await addColumnIfMissing("permission_scope_registry", "module_group_ur");

  await addColumnIfMissing("account_groups", "name_ur");
};

exports.down = async function down(knex) {
  const dropColumnIfExists = async (tableName, columnName) => {
    const hasColumn = await knex.schema
      .withSchema("erp")
      .hasColumn(tableName, columnName);
    if (!hasColumn) return;
    await knex.schema.withSchema("erp").alterTable(tableName, (table) => {
      table.dropColumn(columnName);
    });
  };

  await dropColumnIfExists("account_groups", "name_ur");

  await dropColumnIfExists("permission_scope_registry", "module_group_ur");
  await dropColumnIfExists("permission_scope_registry", "description_ur");

  await dropColumnIfExists("return_reasons", "description_ur");
  await dropColumnIfExists("voucher_type", "name_ur");

  await dropColumnIfExists("approval_request_type_registry", "description_ur");
  await dropColumnIfExists("approval_request_type_registry", "name_ur");

  await dropColumnIfExists("audit_action_registry", "description_ur");
  await dropColumnIfExists("audit_action_registry", "name_ur");

  await dropColumnIfExists("entity_type_registry", "description_ur");
  await dropColumnIfExists("entity_type_registry", "name_ur");

  await dropColumnIfExists("role_templates", "description_ur");
};
