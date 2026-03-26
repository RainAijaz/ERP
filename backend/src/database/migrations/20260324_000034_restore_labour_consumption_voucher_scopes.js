exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES
      ('VOUCHER','LABOUR_PROD','General Labour Production Voucher', 'Production'),
      ('VOUCHER','CONSUMP','Consumption Voucher', 'Production')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'VOUCHER'
      AND scope_key IN ('LABOUR_PROD', 'CONSUMP');
  `);
};
