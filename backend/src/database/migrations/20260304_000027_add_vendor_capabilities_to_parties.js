exports.up = async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("parties", "vendor_capabilities");

  if (!hasColumn) {
    await knex.schema.withSchema("erp").alterTable("parties", (table) => {
      table
        .specificType("vendor_capabilities", "text[]")
        .notNullable()
        .defaultTo(knex.raw("ARRAY[]::text[]"));
    });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_parties_vendor_capabilities
    ON erp.parties
    USING gin (vendor_capabilities)
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_parties_vendor_capabilities_valid'
      ) THEN
        ALTER TABLE erp.parties
          ADD CONSTRAINT chk_parties_vendor_capabilities_valid
          CHECK (vendor_capabilities <@ ARRAY['MATERIAL','REPAIR','SERVICE']::text[]);
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.parties
    DROP CONSTRAINT IF EXISTS chk_parties_vendor_capabilities_valid
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS erp.idx_parties_vendor_capabilities
  `);

  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("parties", "vendor_capabilities");

  if (hasColumn) {
    await knex.schema.withSchema("erp").alterTable("parties", (table) => {
      table.dropColumn("vendor_capabilities");
    });
  }
};
