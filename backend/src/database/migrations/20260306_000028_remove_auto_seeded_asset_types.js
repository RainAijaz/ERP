const REMOVAL_CODES = [
  "MOULD",
  "TOOL",
  "KNIFE",
  "FIXTURE",
  "OTHER",
  "ASSET_TYPE_",
  "ASSET_TYPE_MOULD",
];

exports.up = async function up(knex) {
  const codeList = REMOVAL_CODES.map((code) => `'${code}'`).join(",");
  await knex.raw(`
    DO $$
    BEGIN
      UPDATE erp.asset_type_registry atr
      SET is_active = false
      WHERE upper(atr.code) IN (${codeList})
        AND (
          EXISTS (
            SELECT 1
            FROM erp.assets a
            WHERE upper(a.asset_type_code) = upper(atr.code)
          )
          OR EXISTS (
            SELECT 1
            FROM erp.rgp_outward_line rol
            WHERE upper(rol.item_type_code) = upper(atr.code)
          )
        );

      DELETE FROM erp.asset_type_registry atr
      WHERE upper(atr.code) IN (${codeList})
        AND NOT EXISTS (
          SELECT 1
          FROM erp.assets a
          WHERE upper(a.asset_type_code) = upper(atr.code)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM erp.rgp_outward_line rol
          WHERE upper(rol.item_type_code) = upper(atr.code)
        );
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    INSERT INTO erp.asset_type_registry (code, name, description, is_active)
    VALUES
      ('MOULD', 'Mould', 'Mould / die returnable asset', true),
      ('TOOL', 'Tool', 'Tooling / fixture returnable asset', true),
      ('KNIFE', 'Knife', 'Knife / blade returnable asset', true),
      ('FIXTURE', 'Fixture', 'Fixture / gauge returnable asset', true),
      ('OTHER', 'Other', 'Other returnable asset', true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_active = EXCLUDED.is_active
  `);
};

