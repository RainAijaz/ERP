exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.assets
    ADD COLUMN IF NOT EXISTS name text
  `);

  await knex.raw(`
    ALTER TABLE erp.assets
    ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES erp.users(id) ON DELETE SET NULL
  `);

  await knex.raw(`
    ALTER TABLE erp.assets
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()
  `);

  await knex.raw(`
    ALTER TABLE erp.assets
    ADD COLUMN IF NOT EXISTS updated_by bigint REFERENCES erp.users(id) ON DELETE SET NULL
  `);

  await knex.raw(`
    ALTER TABLE erp.assets
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
  `);

  await knex.raw(`
    UPDATE erp.assets
    SET name = COALESCE(NULLIF(trim(name), ''), NULLIF(trim(description), ''), asset_code, 'Asset')
    WHERE name IS NULL OR trim(name) = ''
  `);

  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('SCREEN', 'master_data.returnable_assets', 'Returnable Assets Master', 'Master Data')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group
  `);

  await knex.raw(`
    INSERT INTO erp.entity_type_registry (code, name, description)
    VALUES ('ASSET', 'Asset', 'Returnable asset master record')
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'SCREEN' AND scope_key = 'master_data.returnable_assets'
  `);

  await knex.raw(`
    DELETE FROM erp.entity_type_registry
    WHERE code = 'ASSET'
  `);
};
