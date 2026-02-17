exports.up = async function up(knex) {
  await knex.schema.withSchema("erp").createTable("employee_commission_rules", (table) => {
    table.bigIncrements("id").primary();
    table.bigInteger("employee_id").notNullable().references("id").inTable("erp.employees").onDelete("RESTRICT");
    table.text("apply_on").notNullable().defaultTo("SKU");
    table.bigInteger("sku_id").nullable().references("id").inTable("erp.skus").onDelete("RESTRICT");
    table.bigInteger("subgroup_id").nullable().references("id").inTable("erp.product_subgroups").onDelete("RESTRICT");
    table.bigInteger("group_id").nullable().references("id").inTable("erp.product_groups").onDelete("RESTRICT");
    table.text("commission_basis").notNullable().defaultTo("NET_SALES_PERCENT");
    table.text("value_type").notNullable().defaultTo("PERCENT");
    table.decimal("value", 18, 2).notNullable().defaultTo(0);
    table.boolean("reverse_on_returns").notNullable().defaultTo(true);
    table.text("status").notNullable().defaultTo("active");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema("erp").createTable("employee_allowance_rules", (table) => {
    table.bigIncrements("id").primary();
    table.bigInteger("employee_id").notNullable().references("id").inTable("erp.employees").onDelete("RESTRICT");
    table.text("allowance_type").notNullable();
    table.text("amount_type").notNullable().defaultTo("FIXED");
    table.decimal("amount", 18, 2).notNullable().defaultTo(0);
    table.text("frequency").notNullable().defaultTo("MONTHLY");
    table.boolean("taxable").notNullable().defaultTo(false);
    table.text("status").notNullable().defaultTo("active");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema("erp").createTable("labour_rate_rules", (table) => {
    table.bigIncrements("id").primary();
    table.boolean("applies_to_all_labours").notNullable().defaultTo(false);
    table.bigInteger("labour_id").nullable().references("id").inTable("erp.labours").onDelete("RESTRICT");
    table.bigInteger("dept_id").notNullable().references("id").inTable("erp.departments").onDelete("RESTRICT");
    table.text("apply_on").notNullable().defaultTo("SKU");
    table.bigInteger("sku_id").nullable().references("id").inTable("erp.skus").onDelete("RESTRICT");
    table.bigInteger("subgroup_id").nullable().references("id").inTable("erp.product_subgroups").onDelete("RESTRICT");
    table.bigInteger("group_id").nullable().references("id").inTable("erp.product_groups").onDelete("RESTRICT");
    table.text("rate_type").notNullable().defaultTo("PER_PAIR");
    table.decimal("rate_value", 18, 2).notNullable().defaultTo(0);
    table.text("status").notNullable().defaultTo("active");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ADD CONSTRAINT employee_commission_rules_apply_on_chk
      CHECK (apply_on IN ('SKU','SUBGROUP','GROUP','ALL'));
    ALTER TABLE erp.employee_commission_rules
      ADD CONSTRAINT employee_commission_rules_basis_chk
      CHECK (commission_basis IN ('NET_SALES_PERCENT','GROSS_MARGIN_PERCENT','FIXED_PER_UNIT','FIXED_PER_INVOICE'));
    ALTER TABLE erp.employee_commission_rules
      ADD CONSTRAINT employee_commission_rules_value_type_chk
      CHECK (value_type IN ('PERCENT','FIXED'));
    ALTER TABLE erp.employee_commission_rules
      ADD CONSTRAINT employee_commission_rules_status_chk
      CHECK (lower(trim(status)) IN ('active','inactive'));

    ALTER TABLE erp.employee_allowance_rules
      ADD CONSTRAINT employee_allowance_rules_amount_type_chk
      CHECK (amount_type IN ('FIXED','PERCENT_BASIC'));
    ALTER TABLE erp.employee_allowance_rules
      ADD CONSTRAINT employee_allowance_rules_frequency_chk
      CHECK (frequency IN ('MONTHLY','DAILY'));
    ALTER TABLE erp.employee_allowance_rules
      ADD CONSTRAINT employee_allowance_rules_status_chk
      CHECK (lower(trim(status)) IN ('active','inactive'));

    ALTER TABLE erp.labour_rate_rules
      ADD CONSTRAINT labour_rate_rules_apply_on_chk
      CHECK (apply_on IN ('SKU','SUBGROUP','GROUP','FLAT'));
    ALTER TABLE erp.labour_rate_rules
      ADD CONSTRAINT labour_rate_rules_rate_type_chk
      CHECK (rate_type IN ('PER_DOZEN','PER_PAIR'));
    ALTER TABLE erp.labour_rate_rules
      ADD CONSTRAINT labour_rate_rules_status_chk
      CHECK (lower(trim(status)) IN ('active','inactive'));
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_emp_comm_employee ON erp.employee_commission_rules(employee_id);
    CREATE INDEX IF NOT EXISTS idx_emp_allow_employee ON erp.employee_allowance_rules(employee_id);
    CREATE INDEX IF NOT EXISTS idx_labour_rate_labour ON erp.labour_rate_rules(labour_id);
    CREATE INDEX IF NOT EXISTS idx_labour_rate_dept ON erp.labour_rate_rules(dept_id);
  `);

  await knex.raw(`
    INSERT INTO erp.approval_policy(entity_type, entity_key, action, requires_approval)
    VALUES
      ('SCREEN','hr_payroll.employees','create',true),
      ('SCREEN','hr_payroll.employees','edit',true),
      ('SCREEN','hr_payroll.employees','delete',true),
      ('SCREEN','hr_payroll.employees','hard_delete',true),
      ('SCREEN','hr_payroll.labours','create',true),
      ('SCREEN','hr_payroll.labours','edit',true),
      ('SCREEN','hr_payroll.labours','delete',true),
      ('SCREEN','hr_payroll.labours','hard_delete',true),
      ('SCREEN','hr_payroll.commissions','create',true),
      ('SCREEN','hr_payroll.commissions','edit',true),
      ('SCREEN','hr_payroll.commissions','delete',true),
      ('SCREEN','hr_payroll.commissions','hard_delete',true),
      ('SCREEN','hr_payroll.allowances','create',true),
      ('SCREEN','hr_payroll.allowances','edit',true),
      ('SCREEN','hr_payroll.allowances','delete',true),
      ('SCREEN','hr_payroll.allowances','hard_delete',true),
      ('SCREEN','hr_payroll.labour_rates','create',true),
      ('SCREEN','hr_payroll.labour_rates','edit',true),
      ('SCREEN','hr_payroll.labour_rates','delete',true),
      ('SCREEN','hr_payroll.labour_rates','hard_delete',true)
    ON CONFLICT (entity_type, entity_key, action)
    DO UPDATE SET requires_approval = EXCLUDED.requires_approval, updated_at = now();
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.trg_validate_active_employee_labour_refs()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_emp_status text;
      v_lab_status text;
    BEGIN
      IF NEW.employee_id IS NOT NULL THEN
        SELECT lower(trim(status)) INTO v_emp_status FROM erp.employees WHERE id = NEW.employee_id;
        IF v_emp_status IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION 'Selected employee is inactive and cannot be used in transactions.';
        END IF;
      END IF;
      IF NEW.labour_id IS NOT NULL THEN
        SELECT lower(trim(status)) INTO v_lab_status FROM erp.labours WHERE id = NEW.labour_id;
        IF v_lab_status IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION 'Selected labour is inactive and cannot be used in transactions.';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_validate_active_employee_labour_refs ON erp.voucher_line;
    CREATE TRIGGER trg_validate_active_employee_labour_refs
    BEFORE INSERT OR UPDATE OF employee_id, labour_id
    ON erp.voucher_line
    FOR EACH ROW
    EXECUTE FUNCTION erp.trg_validate_active_employee_labour_refs();
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.trg_validate_active_salesman()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_emp_status text;
    BEGIN
      IF NEW.salesman_employee_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT lower(trim(status)) INTO v_emp_status FROM erp.employees WHERE id = NEW.salesman_employee_id;
      IF v_emp_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'Selected salesman is inactive and cannot be used in sales transactions.';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.sales_header') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_validate_active_salesman ON erp.sales_header;
        CREATE TRIGGER trg_validate_active_salesman
        BEFORE INSERT OR UPDATE OF salesman_employee_id
        ON erp.sales_header
        FOR EACH ROW
        EXECUTE FUNCTION erp.trg_validate_active_salesman();
      END IF;
      IF to_regclass('erp.sales_order_header') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_validate_active_salesman_order ON erp.sales_order_header;
        CREATE TRIGGER trg_validate_active_salesman_order
        BEFORE INSERT OR UPDATE OF salesman_employee_id
        ON erp.sales_order_header
        FOR EACH ROW
        EXECUTE FUNCTION erp.trg_validate_active_salesman();
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_validate_active_employee_labour_refs ON erp.voucher_line;
    DROP TRIGGER IF EXISTS trg_validate_active_salesman ON erp.sales_header;
    DROP TRIGGER IF EXISTS trg_validate_active_salesman_order ON erp.sales_order_header;
    DROP FUNCTION IF EXISTS erp.trg_validate_active_employee_labour_refs();
    DROP FUNCTION IF EXISTS erp.trg_validate_active_salesman();
  `);

  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type='SCREEN'
      AND entity_key IN (
        'hr_payroll.employees',
        'hr_payroll.labours',
        'hr_payroll.commissions',
        'hr_payroll.allowances',
        'hr_payroll.labour_rates'
      );
  `);

  await knex.schema.withSchema("erp").dropTableIfExists("labour_rate_rules");
  await knex.schema.withSchema("erp").dropTableIfExists("employee_allowance_rules");
  await knex.schema.withSchema("erp").dropTableIfExists("employee_commission_rules");
};
