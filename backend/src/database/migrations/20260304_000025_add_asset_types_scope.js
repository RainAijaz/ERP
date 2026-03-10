exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('SCREEN', 'master_data.asset_types', 'Asset Types Master', 'Master Data')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group
  `);

  await knex.raw(`
    INSERT INTO erp.entity_type_registry (code, name, description)
    VALUES ('ASSET_TYPE', 'Asset Type', 'Asset type registry record')
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'SCREEN' AND scope_key = 'master_data.asset_types'
  `);

  await knex.raw(`
    DELETE FROM erp.entity_type_registry
    WHERE code = 'ASSET_TYPE'
  `);
};
