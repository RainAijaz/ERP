// 20260822_000107_commission_branch_and_effective_dates.js
//
// Adds a branch dimension and an effective-date window to employee commission
// rules, so one salesman can earn a different rate at different branches and a
// rate change keeps the rate it replaced instead of silently restating history.
//
//   branch_id      NULL = every branch this employee is mapped to (today's
//                  behaviour). A branch-specific rule beats a NULL one.
//   effective_from NOT NULL. The date the rate starts applying.
//   effective_to   NULL = open-ended ("until changed").
//
// Existing rows are backfilled as "has always applied" — effective_from is set
// to the oldest voucher date in the system — so live posting and every
// retroactive recalculation produce identical numbers on the day this ships.
// Backfilling to created_at instead would make a recalc of any period before a
// rule was typed in suddenly resolve to nothing.
//
// No UNIQUE index: the app's existing dedupe paths imply duplicate rows already
// exist in the wild, and CREATE UNIQUE INDEX would fail the migration on prod.
// Uniqueness of the open-ended row per key is enforced by supersedeCommissionRule().

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ADD COLUMN IF NOT EXISTS branch_id      bigint REFERENCES erp.branches(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS effective_from date,
      ADD COLUMN IF NOT EXISTS effective_to   date;
  `);

  await knex.raw(`
    UPDATE erp.employee_commission_rules
    SET effective_from = COALESCE(
      (SELECT MIN(voucher_date) FROM erp.voucher_header),
      created_at::date,
      CURRENT_DATE
    )
    WHERE effective_from IS NULL;
  `);

  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ALTER COLUMN effective_from SET NOT NULL;
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'employee_commission_rules_effective_range_chk'
          AND conrelid = 'erp.employee_commission_rules'::regclass
      ) THEN
        ALTER TABLE erp.employee_commission_rules
          ADD CONSTRAINT employee_commission_rules_effective_range_chk
          CHECK (effective_to IS NULL OR effective_to >= effective_from);
      END IF;
    END $$;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_emp_comm_lookup
      ON erp.employee_commission_rules
      (employee_id, commission_type, status, effective_from, effective_to, branch_id);
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS erp.idx_emp_comm_lookup;
  `);
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      DROP CONSTRAINT IF EXISTS employee_commission_rules_effective_range_chk;
  `);
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      DROP COLUMN IF EXISTS effective_to,
      DROP COLUMN IF EXISTS effective_from,
      DROP COLUMN IF EXISTS branch_id;
  `);
};
