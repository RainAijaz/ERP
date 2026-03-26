exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ADD COLUMN IF NOT EXISTS rate_type text;
  `);

  await knex.raw(`
    UPDATE erp.employee_commission_rules
    SET rate_type = 'PER_PAIR'
    WHERE rate_type IS NULL
       OR trim(rate_type) = ''
       OR upper(trim(rate_type)) NOT IN ('PER_DOZEN', 'PER_PAIR');
  `);

  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ALTER COLUMN rate_type SET DEFAULT 'PER_PAIR',
      ALTER COLUMN rate_type SET NOT NULL;
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'employee_commission_rules_rate_type_chk'
          AND conrelid = 'erp.employee_commission_rules'::regclass
      ) THEN
        ALTER TABLE erp.employee_commission_rules
          ADD CONSTRAINT employee_commission_rules_rate_type_chk
          CHECK (rate_type IN ('PER_DOZEN','PER_PAIR'));
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      DROP CONSTRAINT IF EXISTS employee_commission_rules_rate_type_chk;
  `);

  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      DROP COLUMN IF EXISTS rate_type;
  `);
};
