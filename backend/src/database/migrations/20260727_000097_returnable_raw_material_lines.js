// Returnable Gate Pass was asset-only (moulds/tools). This lets a raw material be
// lent to a third party and tracked back.
//
// Stock treatment: the material never leaves the branch's inventory value, it only
// changes stock_state (ON_HAND -> WITH_THIRD_PARTY on dispatch, back on receipt).
// Every stock report already filters stock_state = 'ON_HAND', so loaned material
// drops out of usable stock and BOM availability without any GL entry.
//
// ALTER TYPE ... ADD VALUE is run with the migration transaction disabled: on some
// PostgreSQL versions a value added inside a transaction cannot be used until commit.
exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TYPE erp.stock_state ADD VALUE IF NOT EXISTS 'WITH_THIRD_PARTY'
  `);

  // RM lines reference a real item instead of an asset. asset_id was already
  // nullable; item_type_code / condition_out_code only make sense for assets.
  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    ADD COLUMN IF NOT EXISTS item_id bigint REFERENCES erp.items(id) ON DELETE RESTRICT
  `);

  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    ALTER COLUMN item_type_code DROP NOT NULL
  `);

  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    ALTER COLUMN condition_out_code DROP NOT NULL
  `);

  // Exactly one of asset_id / item_id identifies the line. Existing rows always
  // carry asset_id, so this holds for historical data.
  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    DROP CONSTRAINT IF EXISTS rgp_outward_line_subject_check
  `);

  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    ADD CONSTRAINT rgp_outward_line_subject_check
    CHECK (num_nonnulls(asset_id, item_id) = 1)
  `);

  // Asset lines keep their type + dispatch condition; RM lines must not carry them.
  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    DROP CONSTRAINT IF EXISTS rgp_outward_line_asset_fields_check
  `);

  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    ADD CONSTRAINT rgp_outward_line_asset_fields_check
    CHECK (
      (asset_id IS NOT NULL
        AND item_type_code IS NOT NULL
        AND condition_out_code IS NOT NULL)
      OR
      (item_id IS NOT NULL
        AND item_type_code IS NULL
        AND condition_out_code IS NULL)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_outward_line_item
      ON erp.rgp_outward_line(item_id)
  `);

  // Return condition is likewise asset-only.
  await knex.raw(`
    ALTER TABLE erp.rgp_inward_line
    ALTER COLUMN condition_in_code DROP NOT NULL
  `);
};

exports.down = async function down(knex) {
  // The enum value is intentionally left in place: PostgreSQL cannot drop an enum
  // value, and rolling it back would require rewriting every dependent column.
  // item_type_code / condition_out_code are likewise left nullable — restoring
  // NOT NULL would fail on any RM row written before the rollback.
  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    DROP CONSTRAINT IF EXISTS rgp_outward_line_asset_fields_check
  `);

  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    DROP CONSTRAINT IF EXISTS rgp_outward_line_subject_check
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS erp.idx_rgp_outward_line_item
  `);

  await knex.raw(`
    ALTER TABLE erp.rgp_outward_line
    DROP COLUMN IF EXISTS item_id
  `);
};
