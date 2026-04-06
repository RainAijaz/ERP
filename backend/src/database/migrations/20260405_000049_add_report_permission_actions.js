const ROLE_TABLE = "role_permissions";
const USER_OVERRIDE_TABLE = "user_permissions_override";

const addRoleColumnIfMissing = async (knex, columnName) => {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn(ROLE_TABLE, columnName);
  if (hasColumn) return;
  await knex.schema.withSchema("erp").alterTable(ROLE_TABLE, (table) => {
    table.boolean(columnName).notNullable().defaultTo(false);
  });
};

const addOverrideColumnIfMissing = async (knex, columnName) => {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn(USER_OVERRIDE_TABLE, columnName);
  if (hasColumn) return;
  await knex.schema.withSchema("erp").alterTable(USER_OVERRIDE_TABLE, (table) => {
    table.boolean(columnName).nullable();
  });
};

const dropColumnIfExists = async (knex, tableName, columnName) => {
  const hasColumn = await knex.schema.withSchema("erp").hasColumn(tableName, columnName);
  if (!hasColumn) return;
  await knex.schema.withSchema("erp").alterTable(tableName, (table) => {
    table.dropColumn(columnName);
  });
};

exports.up = async (knex) => {
  const newActionColumns = [
    "can_load",
    "can_view_details",
    "can_export_excel_csv",
    "can_filter_all_branches",
    "can_view_cost_fields",
  ];

  for (const columnName of newActionColumns) {
    // Role permissions are explicit booleans.
    await addRoleColumnIfMissing(knex, columnName);
    // User overrides are tri-state (true/false/null).
    await addOverrideColumnIfMissing(knex, columnName);
  }

  await knex.raw(`
    UPDATE erp.role_permissions rp
    SET
      can_load = COALESCE(rp.can_load, false) OR COALESCE(rp.can_view, false),
      can_view_details = COALESCE(rp.can_view_details, false) OR COALESCE(rp.can_navigate, false),
      can_export_excel_csv = COALESCE(rp.can_export_excel_csv, false) OR COALESCE(rp.can_print, false)
    WHERE rp.scope_id IN (
      SELECT id
      FROM erp.permission_scope_registry
      WHERE scope_type = 'REPORT'
    );
  `);

  await knex.raw(`
    UPDATE erp.user_permissions_override upo
    SET
      can_load = COALESCE(upo.can_load, upo.can_view),
      can_view_details = COALESCE(upo.can_view_details, upo.can_navigate),
      can_export_excel_csv = COALESCE(upo.can_export_excel_csv, upo.can_print)
    WHERE upo.scope_id IN (
      SELECT id
      FROM erp.permission_scope_registry
      WHERE scope_type = 'REPORT'
    );
  `);
};

exports.down = async (knex) => {
  const newActionColumns = [
    "can_view_cost_fields",
    "can_filter_all_branches",
    "can_export_excel_csv",
    "can_view_details",
    "can_load",
  ];

  for (const columnName of newActionColumns) {
    await dropColumnIfExists(knex, USER_OVERRIDE_TABLE, columnName);
    await dropColumnIfExists(knex, ROLE_TABLE, columnName);
  }
};

