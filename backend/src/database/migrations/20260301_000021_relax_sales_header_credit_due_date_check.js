exports.up = async function up(knex) {
  const hasTable = await knex.schema.withSchema("erp").hasTable("sales_header");
  if (!hasTable) return;

  const constraints = await knex
    .select("c.conname")
    .from({ c: "pg_constraint" })
    .join({ t: "pg_class" }, "t.oid", "c.conrelid")
    .join({ n: "pg_namespace" }, "n.oid", "t.relnamespace")
    .where("n.nspname", "erp")
    .where("t.relname", "sales_header")
    .where("c.contype", "c")
    .whereRaw(
      "pg_get_constraintdef(c.oid) ILIKE ?",
      ["%payment_due_date IS NOT NULL%"],
    )
    .whereRaw(
      "pg_get_constraintdef(c.oid) ILIKE ?",
      ["%payment_type = 'CREDIT'%"],
    );

  for (const row of constraints) {
    await knex.raw(
      `ALTER TABLE erp.sales_header DROP CONSTRAINT IF EXISTS "${String(row.conname)}"`,
    );
  }

  await knex.raw(`
    ALTER TABLE erp.sales_header
    DROP CONSTRAINT IF EXISTS sales_header_credit_party_check
  `);

  await knex.raw(`
    ALTER TABLE erp.sales_header
    ADD CONSTRAINT sales_header_credit_party_check
    CHECK (
      (payment_type = 'CASH')
      OR
      (payment_type = 'CREDIT' AND customer_party_id IS NOT NULL)
    )
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.withSchema("erp").hasTable("sales_header");
  if (!hasTable) return;

  const violatingRow = await knex("erp.sales_header")
    .where("payment_type", "CREDIT")
    .whereNull("payment_due_date")
    .first();

  if (violatingRow) return;

  await knex.raw(`
    ALTER TABLE erp.sales_header
    DROP CONSTRAINT IF EXISTS sales_header_credit_party_check
  `);

  await knex.raw(`
    ALTER TABLE erp.sales_header
    ADD CONSTRAINT sales_header_credit_party_check
    CHECK (
      (payment_type = 'CASH')
      OR
      (payment_type = 'CREDIT' AND customer_party_id IS NOT NULL AND payment_due_date IS NOT NULL)
    )
  `);
};
