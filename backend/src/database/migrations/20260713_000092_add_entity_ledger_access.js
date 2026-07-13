// Access restrictions for the Employee Ledger and Labour Ledger reports.
//
// Accounts are gated through user_account_access / role_account_access (keyed by
// account_id). Employees and labours have no individual ledger accounts — they
// post to shared control accounts — so their per-entity restrictions live here,
// keyed polymorphically by (entity_type, entity_id). entity_type is 'EMPLOYEE'
// or 'LABOUR'; we cannot FK a polymorphic column, so a CHECK constraint guards it
// and the app deletes stale rows when an entity is removed.
//
// Flag semantics mirror *_account_access so the same merge logic can drive both:
//   both false            -> ledger blocked (cannot view this entity)
//   both true (user only) -> explicit "allow" override that lifts a role block
// Employee/labour ledgers have no summary-vs-details split, so summary-only is
// never produced for them.

const USER_TABLE = "user_entity_access";
const ROLE_TABLE = "role_entity_access";

const createTable = async (knex, tableName, ownerCol, ownerTable, uqName) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(tableName);
  if (hasTable) return;

  await knex.schema.withSchema("erp").createTable(tableName, (table) => {
    table.bigIncrements("id").primary();
    table
      .bigInteger(ownerCol)
      .notNullable()
      .references("id")
      .inTable(ownerTable)
      .onDelete("CASCADE");
    table.text("entity_type").notNullable();
    table.bigInteger("entity_id").notNullable();
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

    table.unique([ownerCol, "entity_type", "entity_id"], uqName);
    table.index([ownerCol], `idx_${tableName}_owner`);
  });

  await knex.raw(
    `ALTER TABLE erp.?? ADD CONSTRAINT ?? CHECK (entity_type IN ('EMPLOYEE','LABOUR'))`,
    [tableName, `chk_${tableName}_entity_type`],
  );
};

exports.up = async (knex) => {
  await createTable(
    knex,
    USER_TABLE,
    "user_id",
    "erp.users",
    "uq_user_entity_access_user_entity",
  );
  await createTable(
    knex,
    ROLE_TABLE,
    "role_id",
    "erp.role_templates",
    "uq_role_entity_access_role_entity",
  );
};

exports.down = async (knex) => {
  for (const tableName of [USER_TABLE, ROLE_TABLE]) {
    const hasTable = await knex.schema.withSchema("erp").hasTable(tableName);
    if (hasTable) await knex.schema.withSchema("erp").dropTable(tableName);
  }
};
