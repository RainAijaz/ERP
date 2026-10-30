exports.up = async (knex) => {
  if (await knex.schema.withSchema('erp').hasColumn('employee_commission_rules','eligibility')) {
    if (!(await knex.schema.withSchema('erp').hasTable('employee_salary_history')) || !(await knex.schema.withSchema('erp').hasTable('employee_payroll_runs'))) throw new Error('Incomplete salary configuration schema.');
    return;
  }
  await knex.raw("ALTER TYPE erp.payroll_type ADD VALUE IF NOT EXISTS 'WEEKLY'");
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ADD COLUMN eligibility jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN eligibility_key text NOT NULL DEFAULT '';
    ALTER TABLE erp.employee_commission_rules ADD CONSTRAINT commission_eligibility_object CHECK(jsonb_typeof(eligibility) = 'object');
    ALTER TABLE erp.employee_commission_rules DROP CONSTRAINT IF EXISTS employee_commission_rules_commission_type_check;
    ALTER TABLE erp.employee_commission_rules DROP CONSTRAINT IF EXISTS employee_commission_rules_commission_type_chk;
    ALTER TABLE erp.commission_ledger DROP CONSTRAINT IF EXISTS commission_ledger_commission_type_check;
    ALTER TABLE erp.employee_commission_rules ADD CONSTRAINT employee_commission_rules_commission_type_check CHECK
      (commission_type IN ('SALESMAN_SALE','BRANCH_SALE','TRANSFER','PARTY','PRODUCTION_FG','PRODUCTION_SFG','PRODUCTION_STAGE'));
    ALTER TABLE erp.commission_ledger ADD CONSTRAINT commission_ledger_commission_type_check CHECK
      (commission_type IN ('SALESMAN_SALE','BRANCH_SALE','TRANSFER','PARTY','PRODUCTION_FG','PRODUCTION_SFG','PRODUCTION_STAGE'));
    CREATE INDEX idx_commission_rule_eligibility ON erp.employee_commission_rules(employee_id, commission_type, eligibility_key);
    ALTER TABLE erp.employees
      ADD COLUMN salary_effective_from date,
      ADD COLUMN week_ending_day smallint CHECK (week_ending_day BETWEEN 0 AND 6),
      ADD COLUMN absence_deductions_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN absence_day_divisor numeric(8,3) CHECK (absence_day_divisor > 0),
      ADD COLUMN salary_proration text NOT NULL DEFAULT 'NONE' CHECK(salary_proration IN ('NONE','CALENDAR_DAYS'));
    UPDATE erp.employees SET salary_effective_from = COALESCE(employment_start_date, created_at::date);
    CREATE TABLE erp.employee_salary_history (
      id bigserial PRIMARY KEY, employee_id bigint NOT NULL REFERENCES erp.employees(id) ON DELETE CASCADE,
      effective_from date NOT NULL, effective_to date, payroll_type text NOT NULL,
      basic_salary numeric(18,2) NOT NULL CHECK(basic_salary >= 0), week_ending_day smallint,
      absence_deductions_enabled boolean NOT NULL, absence_day_divisor numeric(8,3), salary_proration text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(employee_id,effective_from),
      CHECK(effective_to IS NULL OR effective_to >= effective_from)
    );
    INSERT INTO erp.employee_salary_history(employee_id,effective_from,payroll_type,basic_salary,week_ending_day,absence_deductions_enabled,absence_day_divisor,salary_proration)
      SELECT id,salary_effective_from,payroll_type::text,basic_salary,week_ending_day,absence_deductions_enabled,absence_day_divisor,salary_proration FROM erp.employees;
    CREATE TABLE erp.employee_payroll_runs (
      id bigserial PRIMARY KEY, employee_id bigint NOT NULL REFERENCES erp.employees(id),
      period_from date NOT NULL, period_to date NOT NULL, snapshot jsonb NOT NULL,
      total_payable numeric(18,2) NOT NULL, created_by bigint REFERENCES erp.users(id),
      created_at timestamptz NOT NULL DEFAULT now(), CHECK(period_to >= period_from),
      UNIQUE(employee_id,period_from,period_to)
    );
    CREATE OR REPLACE FUNCTION erp.capture_employee_salary_history() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE start_date date;
    BEGIN
      IF TG_OP = 'UPDATE' AND (NEW.payroll_type,NEW.basic_salary,NEW.week_ending_day,NEW.absence_deductions_enabled,NEW.absence_day_divisor,NEW.salary_proration,NEW.salary_effective_from)
        IS NOT DISTINCT FROM (OLD.payroll_type,OLD.basic_salary,OLD.week_ending_day,OLD.absence_deductions_enabled,OLD.absence_day_divisor,OLD.salary_proration,OLD.salary_effective_from) THEN RETURN NEW; END IF;
      start_date := COALESCE(NEW.salary_effective_from,NEW.employment_start_date,NEW.created_at::date);
      IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=NEW.id AND period_to >= start_date) THEN
        RAISE EXCEPTION 'salary_period_finalized';
      END IF;
      DELETE FROM erp.employee_salary_history WHERE employee_id=NEW.id AND effective_from >= start_date;
      UPDATE erp.employee_salary_history SET effective_to=start_date-1 WHERE employee_id=NEW.id AND effective_from<start_date AND (effective_to IS NULL OR effective_to>=start_date);
      INSERT INTO erp.employee_salary_history(employee_id,effective_from,payroll_type,basic_salary,week_ending_day,absence_deductions_enabled,absence_day_divisor,salary_proration)
        VALUES(NEW.id,start_date,NEW.payroll_type::text,NEW.basic_salary,NEW.week_ending_day,NEW.absence_deductions_enabled,NEW.absence_day_divisor,NEW.salary_proration);
      RETURN NEW;
    END $$;
    CREATE TRIGGER capture_employee_salary_history AFTER INSERT OR UPDATE ON erp.employees FOR EACH ROW EXECUTE FUNCTION erp.capture_employee_salary_history();
  `);
};

exports.down = async (knex) => {
  const used = await knex('erp.employee_payroll_runs').first('id');
  if (used) throw new Error('Cannot remove salary configuration while finalized payroll exists.');
  const configured = await knex('erp.employee_commission_rules').whereRaw("eligibility <> '{}'::jsonb OR commission_type='PRODUCTION_STAGE'").first('id');
  const weekly = await knex('erp.employees').whereRaw("payroll_type::text='WEEKLY' OR absence_deductions_enabled OR salary_proration<>'NONE'").first('id');
  if (configured || weekly) throw new Error('Cannot remove salary configuration while configured rules or weekly salaries exist.');
  await knex.raw(`DROP TRIGGER IF EXISTS capture_employee_salary_history ON erp.employees;
    DROP FUNCTION IF EXISTS erp.capture_employee_salary_history();
    DROP TABLE erp.employee_payroll_runs; DROP TABLE erp.employee_salary_history;
    ALTER TABLE erp.employees DROP COLUMN salary_effective_from, DROP COLUMN week_ending_day, DROP COLUMN absence_deductions_enabled, DROP COLUMN absence_day_divisor, DROP COLUMN salary_proration;
    DROP INDEX IF EXISTS erp.idx_commission_rule_eligibility;
    ALTER TABLE erp.employee_commission_rules DROP COLUMN eligibility, DROP COLUMN eligibility_key;`);
  // PostgreSQL enum values cannot be safely removed without rebuilding the type.
};
