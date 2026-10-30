exports.up = async knex => {
  const installed = await knex.raw("SELECT 1 FROM pg_trigger WHERE tgname='guard_finalized_commission' AND tgrelid='erp.commission_ledger'::regclass");
  if (installed.rows.length) return;
  await knex.raw(`
    ALTER TABLE erp.employees ADD CONSTRAINT employee_weekly_configuration CHECK
      (payroll_type::text <> 'WEEKLY' OR week_ending_day IS NOT NULL);
    ALTER TABLE erp.employees ADD CONSTRAINT employee_absence_configuration CHECK
      (NOT absence_deductions_enabled OR absence_day_divisor > 0);
    CREATE OR REPLACE FUNCTION erp.guard_finalized_employee_earnings() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE employee_key bigint; voucher_key bigint; event_date date; old_employee bigint;
    BEGIN
      IF TG_TABLE_NAME = 'commission_ledger' THEN
        employee_key := COALESCE(NEW.employee_id,OLD.employee_id);
        voucher_key := COALESCE(NEW.voucher_id,OLD.voucher_id);
      ELSIF TG_TABLE_NAME = 'sales_header' THEN
        employee_key := COALESCE(NEW.buyer_employee_id,OLD.buyer_employee_id);
        voucher_key := COALESCE(NEW.voucher_id,OLD.voucher_id);
      ELSE
        employee_key := COALESCE(NEW.employee_id,OLD.employee_id);
        voucher_key := COALESCE(NEW.voucher_header_id,OLD.voucher_header_id);
      END IF;
      IF employee_key IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || employee_key,0));
        SELECT voucher_date INTO event_date FROM erp.voucher_header WHERE id=voucher_key;
        IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=employee_key AND period_to>=event_date) THEN
          RAISE EXCEPTION 'salary_period_finalized';
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF TG_TABLE_NAME = 'sales_header' THEN old_employee:=OLD.buyer_employee_id; ELSE old_employee:=OLD.employee_id; END IF;
        IF old_employee IS NOT NULL AND old_employee IS DISTINCT FROM employee_key THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || old_employee,0));
          IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=old_employee AND period_to>=event_date) THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER guard_finalized_commission BEFORE INSERT OR UPDATE OR DELETE ON erp.commission_ledger FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_employee_earnings();
    CREATE TRIGGER guard_finalized_employee_lines BEFORE INSERT OR UPDATE OR DELETE ON erp.voucher_line FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_employee_earnings();
    CREATE TRIGGER guard_finalized_employee_purchases BEFORE INSERT OR UPDATE OR DELETE ON erp.sales_header FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_employee_earnings();
    CREATE OR REPLACE FUNCTION erp.guard_finalized_payroll_header() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE employee_key bigint;
    BEGIN
      FOR employee_key IN
        SELECT employee_id FROM erp.voucher_line WHERE voucher_header_id=OLD.id AND employee_id IS NOT NULL
        UNION SELECT employee_id FROM erp.commission_ledger WHERE voucher_id=OLD.id
        UNION SELECT buyer_employee_id FROM erp.sales_header WHERE voucher_id=OLD.id AND buyer_employee_id IS NOT NULL
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || employee_key,0));
        IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=employee_key AND period_to>=OLD.voucher_date) THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
      END LOOP;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER guard_finalized_payroll_header BEFORE UPDATE OR DELETE ON erp.voucher_header FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_payroll_header();
    CREATE OR REPLACE FUNCTION erp.guard_payroll_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'salary_period_finalized'; END $$;
    CREATE TRIGGER guard_payroll_snapshot BEFORE UPDATE OR DELETE ON erp.employee_payroll_runs FOR EACH ROW EXECUTE FUNCTION erp.guard_payroll_snapshot();
  `);
};
exports.down = async knex => knex.raw(`
  DROP TRIGGER IF EXISTS guard_payroll_snapshot ON erp.employee_payroll_runs;
  DROP FUNCTION IF EXISTS erp.guard_payroll_snapshot();
  DROP TRIGGER IF EXISTS guard_finalized_payroll_header ON erp.voucher_header;
  DROP FUNCTION IF EXISTS erp.guard_finalized_payroll_header();
  DROP TRIGGER IF EXISTS guard_finalized_commission ON erp.commission_ledger;
  DROP TRIGGER IF EXISTS guard_finalized_employee_lines ON erp.voucher_line;
  DROP TRIGGER IF EXISTS guard_finalized_employee_purchases ON erp.sales_header;
  DROP FUNCTION IF EXISTS erp.guard_finalized_employee_earnings();
  ALTER TABLE erp.employees DROP CONSTRAINT employee_weekly_configuration, DROP CONSTRAINT employee_absence_configuration;
`);
