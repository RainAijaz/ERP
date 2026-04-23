exports.up = async function up(knex) {
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("employee_commission_rules");

  if (!hasTable) return;

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_emp_comm_employee_basis_type_scope_status
    ON erp.employee_commission_rules (
      employee_id,
      commission_basis,
      value_type,
      apply_on,
      status,
      sku_id,
      subgroup_id,
      group_id
    )
  `);
};

exports.down = async function down(knex) {
  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_emp_comm_employee_basis_type_scope_status",
  );
};
