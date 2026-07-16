// 20260715_000094_labour_allowances_and_allowance_duration.js
// Adds an adjustable effective-date window (effective_from / effective_to) to
// employee allowance rules, and introduces a parallel labour_allowance_rules
// table + screen (hr_payroll.labour_allowances) so labours can be configured
// with allowances the same way employees are.

exports.up = async function up(knex) {
  // 1) Duration window on existing employee allowance rules (nullable = open-ended)
  await knex.schema.withSchema("erp").alterTable("employee_allowance_rules", (table) => {
    table.date("effective_from").nullable();
    table.date("effective_to").nullable();
  });

  // 2) New labour allowance rules table, mirroring the employee structure.
  const hasLabourAllowance = await knex.schema
    .withSchema("erp")
    .hasTable("labour_allowance_rules");
  if (!hasLabourAllowance) {
    await knex.schema.withSchema("erp").createTable("labour_allowance_rules", (table) => {
      table.bigIncrements("id").primary();
      table
        .bigInteger("labour_id")
        .notNullable()
        .references("id")
        .inTable("erp.labours")
        .onDelete("RESTRICT");
      table.text("allowance_type").notNullable();
      table.text("amount_type").notNullable().defaultTo("FIXED");
      table.decimal("amount", 18, 2).notNullable().defaultTo(0);
      table.text("frequency").notNullable().defaultTo("MONTHLY");
      table.boolean("taxable").notNullable().defaultTo(false);
      table.date("effective_from").nullable();
      table.date("effective_to").nullable();
      table.text("status").notNullable().defaultTo("active");
      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
    });

    await knex.raw(`
      ALTER TABLE erp.labour_allowance_rules
        ADD CONSTRAINT labour_allowance_rules_amount_type_chk
        CHECK (amount_type IN ('FIXED','PERCENT_BASIC'));
      ALTER TABLE erp.labour_allowance_rules
        ADD CONSTRAINT labour_allowance_rules_frequency_chk
        CHECK (frequency IN ('MONTHLY','DAILY'));
      ALTER TABLE erp.labour_allowance_rules
        ADD CONSTRAINT labour_allowance_rules_status_chk
        CHECK (lower(trim(status)) IN ('active','inactive'));
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_labour_allow_labour
        ON erp.labour_allowance_rules(labour_id);
    `);
  }

  // 3) Register the new screen scope so permissions/access can target it.
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('SCREEN','hr_payroll.labour_allowances','Labour Allowances', 'HR & Payroll')
    ON CONFLICT (scope_type, scope_key) DO NOTHING;
  `);

  // 4) Approval policy — same guardrails as employee allowances.
  await knex.raw(`
    INSERT INTO erp.approval_policy(entity_type, entity_key, action, requires_approval)
    VALUES
      ('SCREEN','hr_payroll.labour_allowances','create',true),
      ('SCREEN','hr_payroll.labour_allowances','edit',true),
      ('SCREEN','hr_payroll.labour_allowances','delete',true),
      ('SCREEN','hr_payroll.labour_allowances','hard_delete',true)
    ON CONFLICT (entity_type, entity_key, action)
    DO UPDATE SET requires_approval = EXCLUDED.requires_approval, updated_at = now();
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type='SCREEN' AND entity_key = 'hr_payroll.labour_allowances';
  `);
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type='SCREEN' AND scope_key = 'hr_payroll.labour_allowances';
  `);

  await knex.schema.withSchema("erp").dropTableIfExists("labour_allowance_rules");

  await knex.schema.withSchema("erp").alterTable("employee_allowance_rules", (table) => {
    table.dropColumn("effective_from");
    table.dropColumn("effective_to");
  });
};
