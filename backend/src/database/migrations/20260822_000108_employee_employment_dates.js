// 20260822_000108_employee_employment_dates.js
//
// Adds a real employment window to employees.
//
// Salary accrual previously started from employees.created_at — the day the row
// was typed into the ERP, not the day the person joined — and had no end at all,
// so a leaver was handled by flipping status to 'inactive', which removed them
// from the accrual query entirely and wiped their whole historical salary
// accrual retroactively.
//
// Both columns stay nullable in the DB and the accrual engine falls back to
// created_at, so no existing insert path can break. The employees screen makes
// the start date required for new/edited rows.

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.employees
      ADD COLUMN IF NOT EXISTS employment_start_date date,
      ADD COLUMN IF NOT EXISTS employment_end_date   date;
  `);

  // Preserves current behaviour exactly: accrual already used created_at.
  await knex.raw(`
    UPDATE erp.employees
    SET employment_start_date = created_at::date
    WHERE employment_start_date IS NULL;
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'employees_employment_range_chk'
          AND conrelid = 'erp.employees'::regclass
      ) THEN
        ALTER TABLE erp.employees
          ADD CONSTRAINT employees_employment_range_chk
          CHECK (
            employment_end_date IS NULL
            OR employment_start_date IS NULL
            OR employment_end_date >= employment_start_date
          );
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.employees
      DROP CONSTRAINT IF EXISTS employees_employment_range_chk;
  `);
  await knex.raw(`
    ALTER TABLE erp.employees
      DROP COLUMN IF EXISTS employment_end_date,
      DROP COLUMN IF EXISTS employment_start_date;
  `);
};
