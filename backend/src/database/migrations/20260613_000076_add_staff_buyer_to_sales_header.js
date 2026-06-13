exports.up = async function up(knex) {
  // Add dedicated account group for Staff Receivable
  await knex.raw(`
    INSERT INTO erp.account_groups (account_type, code, name)
    VALUES ('ASSET', 'staff_receivable_control', 'Staff Receivable')
    ON CONFLICT DO NOTHING
  `);

  // Move any existing "Staff Receivable" accounts into the new group
  await knex.raw(`
    UPDATE erp.accounts
    SET subgroup_id = (
      SELECT id FROM erp.account_groups WHERE code = 'staff_receivable_control'
    )
    WHERE subgroup_id = (
      SELECT id FROM erp.account_groups WHERE code = 'accounts_receivable_control'
    )
    AND lower(name) LIKE '%staff%receiv%'
  `);

  // Add buyer_employee_id and buyer_labour_id columns
  await knex.raw(`
    ALTER TABLE erp.sales_header
      ADD COLUMN IF NOT EXISTS buyer_employee_id bigint REFERENCES erp.employees(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS buyer_labour_id   bigint REFERENCES erp.labours(id)   ON DELETE RESTRICT
  `);

  // At most one buyer type can be set at a time
  await knex.raw(`
    ALTER TABLE erp.sales_header
      DROP CONSTRAINT IF EXISTS sales_header_single_buyer_check
  `);
  await knex.raw(`
    ALTER TABLE erp.sales_header
      ADD CONSTRAINT sales_header_single_buyer_check CHECK (
        (CASE WHEN customer_party_id  IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN buyer_employee_id  IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN buyer_labour_id    IS NOT NULL THEN 1 ELSE 0 END) <= 1
      )
  `);

  // Replace CREDIT-requires-party constraint to also accept employee/labour buyers
  await knex.raw(`
    DO $$
    DECLARE v text;
    BEGIN
      SELECT conname INTO v
      FROM pg_constraint
      WHERE conrelid = 'erp.sales_header'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%payment_type%CREDIT%customer_party_id%';
      IF v IS NOT NULL THEN
        EXECUTE 'ALTER TABLE erp.sales_header DROP CONSTRAINT ' || quote_ident(v);
      END IF;
    END $$
  `);
  await knex.raw(`
    ALTER TABLE erp.sales_header
      DROP CONSTRAINT IF EXISTS sales_header_credit_buyer_check
  `);
  await knex.raw(`
    ALTER TABLE erp.sales_header
      ADD CONSTRAINT sales_header_credit_buyer_check CHECK (
        (payment_type = 'CASH')
        OR (payment_type = 'CREDIT' AND (
          customer_party_id IS NOT NULL
          OR buyer_employee_id IS NOT NULL
          OR buyer_labour_id  IS NOT NULL
        ))
      )
  `);

  // Replace cash walk-in constraint to also exempt employee/labour buyers
  await knex.raw(`
    DO $$
    DECLARE v text;
    BEGIN
      SELECT conname INTO v
      FROM pg_constraint
      WHERE conrelid = 'erp.sales_header'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%customer_party_id%customer_name%';
      IF v IS NOT NULL THEN
        EXECUTE 'ALTER TABLE erp.sales_header DROP CONSTRAINT ' || quote_ident(v);
      END IF;
    END $$
  `);
  await knex.raw(`
    ALTER TABLE erp.sales_header
      DROP CONSTRAINT IF EXISTS sales_header_walk_in_check
  `);
  await knex.raw(`
    ALTER TABLE erp.sales_header
      ADD CONSTRAINT sales_header_walk_in_check CHECK (
        customer_party_id  IS NOT NULL
        OR buyer_employee_id IS NOT NULL
        OR buyer_labour_id   IS NOT NULL
        OR (COALESCE(trim(customer_name), '')        <> ''
        AND COALESCE(trim(customer_phone_number), '') <> '')
      )
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE erp.sales_header DROP CONSTRAINT IF EXISTS sales_header_walk_in_check`);
  await knex.raw(`ALTER TABLE erp.sales_header DROP CONSTRAINT IF EXISTS sales_header_credit_buyer_check`);
  await knex.raw(`ALTER TABLE erp.sales_header DROP CONSTRAINT IF EXISTS sales_header_single_buyer_check`);
  await knex.raw(`
    ALTER TABLE erp.sales_header
      DROP COLUMN IF EXISTS buyer_employee_id,
      DROP COLUMN IF EXISTS buyer_labour_id
  `);
};
