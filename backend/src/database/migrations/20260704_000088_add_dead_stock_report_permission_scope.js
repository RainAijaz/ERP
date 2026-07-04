exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('REPORT', 'dead_stock_report', 'Slow-Moving / Dead Stock Report', 'Inventory')
    ON CONFLICT (scope_type, scope_key) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'REPORT' AND scope_key = 'dead_stock_report'
  `);
};
