exports.up = async function up(knex) {
  const hasTable = await knex.schema.withSchema("erp").hasTable("sales_header");
  if (!hasTable) return;

  // The previous migration (000076) tried to drop this via a dynamic DO $$ block
  // but the pattern match failed, leaving the old constraint active. Drop it explicitly.
  await knex.raw(`
    ALTER TABLE erp.sales_header
      DROP CONSTRAINT IF EXISTS sales_header_credit_party_check
  `);

  // Also catch any constraint whose definition still encodes the old stricter rule
  // (CREDIT requires customer_party_id only, no employee/labour alternative).
  await knex.raw(`
    DO $$
    DECLARE v text;
    BEGIN
      FOR v IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'erp.sales_header'::regclass
          AND contype   = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%payment_type%CREDIT%customer_party_id%'
          AND pg_get_constraintdef(oid) NOT ILIKE '%buyer_employee_id%'
      LOOP
        EXECUTE 'ALTER TABLE erp.sales_header DROP CONSTRAINT ' || quote_ident(v);
      END LOOP;
    END $$
  `);

  // Ensure the correct replacement constraint exists (idempotent).
  await knex.raw(`
    ALTER TABLE erp.sales_header
      DROP CONSTRAINT IF EXISTS sales_header_credit_buyer_check
  `);
  await knex.raw(`
    ALTER TABLE erp.sales_header
      ADD CONSTRAINT sales_header_credit_buyer_check CHECK (
        (payment_type = 'CASH')
        OR (payment_type = 'CREDIT' AND (
          customer_party_id  IS NOT NULL
          OR buyer_employee_id IS NOT NULL
          OR buyer_labour_id   IS NOT NULL
        ))
      )
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.sales_header
      DROP CONSTRAINT IF EXISTS sales_header_credit_buyer_check
  `);
};
