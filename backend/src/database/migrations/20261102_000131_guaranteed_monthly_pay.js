'use strict';

exports.up = async knex => {
  await knex.raw(`
    ALTER TABLE erp.employees ADD COLUMN pay_arrangement text NOT NULL DEFAULT 'EXISTING'
      CHECK(pay_arrangement IN ('EXISTING','MONTHLY_GUARANTEE'));
    ALTER TABLE erp.labours
      ADD COLUMN pay_arrangement text NOT NULL DEFAULT 'EXISTING' CHECK(pay_arrangement IN ('EXISTING','MONTHLY_GUARANTEE')),
      ADD COLUMN basic_salary numeric(18,2) NOT NULL DEFAULT 0 CHECK(basic_salary>=0),
      ADD COLUMN salary_effective_from date;
    CREATE TABLE erp.worker_guarantee_history (
      id bigserial PRIMARY KEY,
      employee_id bigint REFERENCES erp.employees(id), labour_id bigint REFERENCES erp.labours(id),
      pay_arrangement text NOT NULL CHECK(pay_arrangement IN ('EXISTING','MONTHLY_GUARANTEE')),
      basic_salary numeric(18,2) NOT NULL CHECK(basic_salary>=0),
      effective_from date NOT NULL, effective_to date, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK(num_nonnulls(employee_id,labour_id)=1), CHECK(EXTRACT(DAY FROM effective_from)=1),
      CHECK(effective_to IS NULL OR effective_to>=effective_from),
      UNIQUE(employee_id,effective_from), UNIQUE(labour_id,effective_from)
    );
    CREATE TABLE erp.labour_payroll_runs (
      id bigserial PRIMARY KEY, labour_id bigint NOT NULL REFERENCES erp.labours(id),
      period_from date NOT NULL, period_to date NOT NULL, snapshot jsonb NOT NULL,
      total_payable numeric(18,2) NOT NULL, created_by bigint REFERENCES erp.users(id),
      created_at timestamptz NOT NULL DEFAULT now(), CHECK(period_to>=period_from), UNIQUE(labour_id,period_from,period_to)
    );
    CREATE TRIGGER guard_labour_payroll_snapshot BEFORE UPDATE OR DELETE ON erp.labour_payroll_runs
      FOR EACH ROW EXECUTE FUNCTION erp.guard_payroll_snapshot();

    CREATE FUNCTION erp.capture_worker_guarantee_history() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE is_employee boolean:=TG_TABLE_NAME='employees'; previous jsonb; current_row jsonb:=to_jsonb(NEW);
      worker bigint:=NEW.id; start_date date; previous_mode text; closed_to date; history_exists boolean;
    BEGIN
      previous:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
      previous_mode:=COALESCE(previous->>'pay_arrangement','EXISTING');
      IF TG_OP='UPDATE' AND (current_row->>'pay_arrangement',current_row->>'basic_salary',current_row->>'salary_effective_from',current_row->>'payroll_type')
        IS NOT DISTINCT FROM (previous->>'pay_arrangement',previous->>'basic_salary',previous->>'salary_effective_from',previous->>'payroll_type') THEN RETURN NEW; END IF;
      IF NEW.pay_arrangement='EXISTING' AND previous_mode='EXISTING' THEN
        SELECT EXISTS(SELECT 1 FROM erp.worker_guarantee_history WHERE (employee_id=worker AND is_employee) OR (labour_id=worker AND NOT is_employee)) INTO history_exists;
        IF NOT history_exists THEN RETURN NEW; END IF;
      END IF;
      start_date:=NEW.salary_effective_from;
      IF start_date IS NULL OR EXTRACT(DAY FROM start_date)<>1 THEN RAISE EXCEPTION 'guarantee_month_boundary'; END IF;
      IF NEW.pay_arrangement='MONTHLY_GUARANTEE' AND (NEW.basic_salary<=0 OR
        (is_employee AND current_row->>'payroll_type'<>'MONTHLY')) THEN RAISE EXCEPTION 'guarantee_monthly_only'; END IF;
      IF is_employee THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || worker,0));
        SELECT MAX(period_to) INTO closed_to FROM erp.employee_payroll_runs WHERE employee_id=worker;
      ELSE
        PERFORM pg_advisory_xact_lock(hashtextextended('erp-labour-payroll:' || worker,0));
        SELECT MAX(period_to) INTO closed_to FROM erp.labour_payroll_runs WHERE labour_id=worker;
      END IF;
      IF closed_to>=start_date THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
      -- Keep earlier versions; a correction at the same effective month replaces
      -- that month's version. Never silently erase scheduled future terms.
      IF EXISTS(SELECT 1 FROM erp.worker_guarantee_history WHERE
        ((employee_id=worker AND is_employee) OR (labour_id=worker AND NOT is_employee)) AND effective_from>start_date)
        THEN RAISE EXCEPTION 'guarantee_future_terms'; END IF;
      DELETE FROM erp.worker_guarantee_history WHERE ((employee_id=worker AND is_employee) OR (labour_id=worker AND NOT is_employee)) AND effective_from=start_date;
      UPDATE erp.worker_guarantee_history SET effective_to=start_date-1
        WHERE ((employee_id=worker AND is_employee) OR (labour_id=worker AND NOT is_employee)) AND effective_from<start_date AND (effective_to IS NULL OR effective_to>=start_date);
      INSERT INTO erp.worker_guarantee_history(employee_id,labour_id,pay_arrangement,basic_salary,effective_from)
        VALUES(CASE WHEN is_employee THEN worker END,CASE WHEN NOT is_employee THEN worker END,NEW.pay_arrangement,NEW.basic_salary,start_date);
      RETURN NEW;
    END $$;
    CREATE TRIGGER capture_worker_guarantee_history AFTER INSERT OR UPDATE ON erp.employees
      FOR EACH ROW EXECUTE FUNCTION erp.capture_worker_guarantee_history();
    CREATE TRIGGER capture_worker_guarantee_history AFTER INSERT OR UPDATE ON erp.labours
      FOR EACH ROW EXECUTE FUNCTION erp.capture_worker_guarantee_history();

    CREATE FUNCTION erp.guard_finalized_labour_earnings() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE source jsonb; records jsonb; worker bigint; voucher_key bigint; event_date date;
      workers bigint[]; candidate bigint;
    BEGIN
      records:=jsonb_build_array(CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END);
      FOR source IN SELECT value FROM jsonb_array_elements(records) WHERE jsonb_typeof(value)='object' LOOP
        worker:=COALESCE((source->>'labour_id')::bigint,(source->>'buyer_labour_id')::bigint);
        voucher_key:=COALESCE((source->>'voucher_id')::bigint,(source->>'voucher_header_id')::bigint);
        IF TG_TABLE_NAME='voucher_header' THEN voucher_key:=(source->>'id')::bigint; END IF;
        IF TG_TABLE_NAME='dcv_line' THEN
          SELECT voucher_header_id INTO voucher_key FROM erp.voucher_line WHERE id=(source->>'voucher_line_id')::bigint;
        END IF;
        IF TG_TABLE_NAME='labour_allowance_rules' THEN
          event_date:=COALESCE((source->>'effective_from')::date,'1900-01-01'::date);
        ELSE
          event_date:=(source->>'voucher_date')::date;
          IF event_date IS NULL THEN SELECT voucher_date INTO event_date FROM erp.voucher_header WHERE id=voucher_key; END IF;
        END IF;
        workers:=ARRAY[worker];
        IF TG_TABLE_NAME='voucher_header' THEN
          SELECT array_agg(DISTINCT id) INTO workers FROM (
            SELECT labour_id AS id FROM erp.voucher_line WHERE voucher_header_id=voucher_key
            UNION SELECT labour_id FROM erp.dcv_header WHERE voucher_id=voucher_key
            UNION SELECT dl.labour_id FROM erp.dcv_line dl JOIN erp.voucher_line vl ON vl.id=dl.voucher_line_id WHERE vl.voucher_header_id=voucher_key
            UNION SELECT buyer_labour_id FROM erp.sales_header WHERE voucher_id=voucher_key
          ) targets WHERE id IS NOT NULL;
        END IF;
        IF TG_TABLE_NAME='voucher_line' AND voucher_key IS NOT NULL THEN
          SELECT array_cat(workers,ARRAY[COALESCE(dl.labour_id,dh.labour_id)]) INTO workers FROM erp.dcv_header dh
            LEFT JOIN erp.dcv_line dl ON dl.voucher_line_id=(source->>'id')::bigint WHERE dh.voucher_id=voucher_key;
          IF NOT FOUND THEN workers:=ARRAY[worker]; END IF;
        END IF;
        FOREACH candidate IN ARRAY COALESCE(workers,ARRAY[]::bigint[]) LOOP
          IF candidate IS NULL THEN CONTINUE; END IF;
          PERFORM pg_advisory_xact_lock(hashtextextended('erp-labour-payroll:' || candidate,0));
          IF EXISTS(SELECT 1 FROM erp.labour_payroll_runs WHERE labour_id=candidate AND period_to>=event_date)
            THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
        END LOOP;
      END LOOP;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER guard_finalized_labour_lines BEFORE INSERT OR UPDATE OR DELETE ON erp.voucher_line FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_labour_earnings();
    CREATE TRIGGER guard_finalized_labour_dcv BEFORE INSERT OR UPDATE OR DELETE ON erp.dcv_header FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_labour_earnings();
    CREATE TRIGGER guard_finalized_labour_dcv_line BEFORE INSERT OR UPDATE OR DELETE ON erp.dcv_line FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_labour_earnings();
    CREATE TRIGGER guard_finalized_labour_purchase BEFORE INSERT OR UPDATE OR DELETE ON erp.sales_header FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_labour_earnings();
    CREATE TRIGGER guard_finalized_labour_header BEFORE UPDATE OR DELETE ON erp.voucher_header FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_labour_earnings();
    CREATE TRIGGER guard_finalized_labour_allowance BEFORE INSERT OR UPDATE OR DELETE ON erp.labour_allowance_rules FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_labour_earnings();

    CREATE FUNCTION erp.guard_finalized_employee_header_dates() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE worker bigint;
    BEGIN
      IF NEW.voucher_date IS NOT DISTINCT FROM OLD.voucher_date THEN RETURN NEW; END IF;
      FOR worker IN SELECT employee_id FROM erp.voucher_line WHERE voucher_header_id=OLD.id AND employee_id IS NOT NULL
        UNION SELECT employee_id FROM erp.commission_ledger WHERE voucher_id=OLD.id
        UNION SELECT buyer_employee_id FROM erp.sales_header WHERE voucher_id=OLD.id AND buyer_employee_id IS NOT NULL LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('erp-payroll:' || worker,0));
        IF EXISTS(SELECT 1 FROM erp.employee_payroll_runs WHERE employee_id=worker AND period_to>=LEAST(NEW.voucher_date,OLD.voucher_date))
          THEN RAISE EXCEPTION 'salary_period_finalized'; END IF;
      END LOOP;
      RETURN NEW;
    END $$;
    CREATE TRIGGER guard_finalized_employee_header_dates BEFORE UPDATE ON erp.voucher_header FOR EACH ROW EXECUTE FUNCTION erp.guard_finalized_employee_header_dates();
    CREATE INDEX IF NOT EXISTS idx_guarantee_employee_lines ON erp.voucher_line(employee_id,voucher_header_id) WHERE employee_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_guarantee_labour_lines ON erp.voucher_line(labour_id,voucher_header_id) WHERE labour_id IS NOT NULL;
  `);
};

exports.down = async () => {
  throw new Error('Guaranteed-pay history and finalized payroll must be preserved. Use a reviewed forward migration.');
};
