exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.assets
    ADD COLUMN IF NOT EXISTS name_ur text
  `);

  await knex.raw(`
    ALTER TABLE erp.asset_type_registry
    ADD COLUMN IF NOT EXISTS name_ur text
  `);

  await knex.raw(`
    UPDATE erp.assets
    SET name_ur = COALESCE(NULLIF(trim(name_ur), ''), NULLIF(trim(name), ''))
    WHERE name_ur IS NULL OR trim(name_ur) = ''
  `);

  await knex.raw(`
    UPDATE erp.asset_type_registry
    SET name_ur = COALESCE(NULLIF(trim(name_ur), ''), NULLIF(trim(name), ''))
    WHERE name_ur IS NULL OR trim(name_ur) = ''
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.assets
    DROP COLUMN IF EXISTS name_ur
  `);

  await knex.raw(`
    ALTER TABLE erp.asset_type_registry
    DROP COLUMN IF EXISTS name_ur
  `);
};
