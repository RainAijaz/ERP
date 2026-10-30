exports.up = async knex => {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commission_product_scope ON erp.items(item_type,group_id,subgroup_id,id);
    CREATE OR REPLACE FUNCTION erp.capture_employee_salary_history() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE start_date date; previous_period_end date;
    BEGIN
      IF TG_OP = 'UPDATE' AND (NEW.payroll_type,NEW.basic_salary,NEW.week_ending_day,NEW.absence_deductions_enabled,NEW.absence_day_divisor,NEW.salary_proration,NEW.salary_effective_from)
        IS NOT DISTINCT FROM (OLD.payroll_type,OLD.basic_salary,OLD.week_ending_day,OLD.absence_deductions_enabled,OLD.absence_day_divisor,OLD.salary_proration,OLD.salary_effective_from) THEN RETURN NEW; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || NEW.id,0));
      start_date := COALESCE(NEW.salary_effective_from,NEW.employment_start_date,NEW.created_at::date);
      IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=NEW.id AND period_to>=start_date) THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
      IF TG_OP='UPDATE' AND NEW.salary_effective_from IS DISTINCT FROM OLD.salary_effective_from
        AND (NEW.payroll_type,NEW.week_ending_day) IS DISTINCT FROM (OLD.payroll_type,OLD.week_ending_day) AND NEW.salary_proration<>'CALENDAR_DAYS' THEN
        IF OLD.payroll_type::text='MONTHLY' AND EXTRACT(DAY FROM start_date)<>1 THEN RAISE EXCEPTION 'salary_frequency_boundary'; END IF;
        IF OLD.payroll_type::text='WEEKLY' AND EXTRACT(DOW FROM start_date-1)<>OLD.week_ending_day THEN RAISE EXCEPTION 'salary_frequency_boundary'; END IF;
        IF NEW.payroll_type::text='MONTHLY' AND EXTRACT(DAY FROM start_date)<>1 THEN RAISE EXCEPTION 'salary_frequency_boundary'; END IF;
        IF NEW.payroll_type::text='WEEKLY' AND EXTRACT(DOW FROM start_date-1)<>NEW.week_ending_day THEN RAISE EXCEPTION 'salary_frequency_boundary'; END IF;
      END IF;
      DELETE FROM erp.employee_salary_history WHERE employee_id=NEW.id AND effective_from>=start_date;
      UPDATE erp.employee_salary_history SET effective_to=start_date-1 WHERE employee_id=NEW.id AND effective_from<start_date AND (effective_to IS NULL OR effective_to>=start_date);
      INSERT INTO erp.employee_salary_history(employee_id,effective_from,payroll_type,basic_salary,week_ending_day,absence_deductions_enabled,absence_day_divisor,salary_proration)
        VALUES(NEW.id,start_date,NEW.payroll_type::text,NEW.basic_salary,NEW.week_ending_day,NEW.absence_deductions_enabled,NEW.absence_day_divisor,NEW.salary_proration);
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION erp.guard_finalized_employee_earnings() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE employee_key bigint; voucher_key bigint; event_date date; source jsonb; records jsonb;
    BEGIN
      records:=jsonb_build_array(CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE NULL END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE NULL END);
      FOR source IN SELECT value FROM jsonb_array_elements(records) WHERE jsonb_typeof(value)='object' LOOP
        employee_key:=COALESCE((source->>'employee_id')::bigint,(source->>'buyer_employee_id')::bigint);
        voucher_key:=COALESCE((source->>'voucher_id')::bigint,(source->>'voucher_header_id')::bigint);
        IF employee_key IS NULL THEN CONTINUE; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || employee_key,0));
        SELECT voucher_date INTO event_date FROM erp.voucher_header WHERE id=voucher_key;
        IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=employee_key AND period_to>=event_date) THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
      END LOOP;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION erp.guard_finalized_employment_window() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE closed_to date;
    BEGIN
      IF (NEW.employment_start_date,NEW.employment_end_date) IS NOT DISTINCT FROM (OLD.employment_start_date,OLD.employment_end_date) THEN RETURN NEW; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || NEW.id,0));
      SELECT MAX(period_to) INTO closed_to FROM erp.employee_payroll_runs WHERE employee_id=NEW.id;
      IF closed_to IS NOT NULL AND (NEW.employment_start_date IS DISTINCT FROM OLD.employment_start_date OR
        LEAST(COALESCE(NEW.employment_end_date,'infinity'::date),COALESCE(OLD.employment_end_date,'infinity'::date))<=closed_to) THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS guard_finalized_employment_window ON erp.employees;
    CREATE TRIGGER guard_finalized_employment_window BEFORE UPDATE ON erp.employees FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_employment_window();
    CREATE OR REPLACE FUNCTION erp.guard_finalized_allowance() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE employee_key bigint; affected_from date;
    BEGIN
      employee_key:=COALESCE(NEW.employee_id,OLD.employee_id);
      PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || employee_key,0));
      IF TG_OP='INSERT' THEN affected_from:=COALESCE(NEW.effective_from,'1900-01-01'::date);
      ELSIF TG_OP='DELETE' THEN affected_from:=COALESCE(OLD.effective_from,'1900-01-01'::date);
      ELSIF (to_jsonb(NEW)-'effective_to')=(to_jsonb(OLD)-'effective_to') THEN
        affected_from:=LEAST(COALESCE(NEW.effective_to,'infinity'::date),COALESCE(OLD.effective_to,'infinity'::date))+1;
      ELSE affected_from:=LEAST(COALESCE(NEW.effective_from,'1900-01-01'::date),COALESCE(OLD.effective_from,'1900-01-01'::date)); END IF;
      IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=employee_key AND period_to>=affected_from) THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS guard_finalized_allowance ON erp.employee_allowance_rules;
    CREATE TRIGGER guard_finalized_allowance BEFORE INSERT OR UPDATE OR DELETE ON erp.employee_allowance_rules FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_allowance();
  `);
};
exports.down = async knex => knex.raw(`DROP TRIGGER IF EXISTS guard_finalized_allowance ON erp.employee_allowance_rules;
  DROP FUNCTION IF EXISTS erp.guard_finalized_allowance();
  DROP TRIGGER IF EXISTS guard_finalized_employment_window ON erp.employees;
  DROP FUNCTION IF EXISTS erp.guard_finalized_employment_window();
  DROP INDEX IF EXISTS erp.idx_commission_product_scope;`);
