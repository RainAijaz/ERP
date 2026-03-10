exports.up = async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'rgp_out_status' AND n.nspname = 'erp'
      ) THEN
        CREATE TYPE erp.rgp_out_status AS ENUM ('PENDING','PARTIALLY_RETURNED','CLOSED');
      END IF;
    END $$;
  `);

  await knex.raw(`
    INSERT INTO erp.voucher_type (code, name, requires_approval, affects_stock, affects_gl)
    VALUES
      ('RDV', 'Returnable Dispatch Voucher', false, false, false),
      ('RRV', 'Returnable Receipt Voucher', false, false, false)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      requires_approval = EXCLUDED.requires_approval,
      affects_stock = EXCLUDED.affects_stock,
      affects_gl = EXCLUDED.affects_gl
  `);

  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES
      ('VOUCHER', 'RDV', 'Returnable Dispatch Voucher', 'Outward & Returnable'),
      ('VOUCHER', 'RRV', 'Returnable Receipt Voucher', 'Outward & Returnable')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group
  `);

  await knex.raw(`
    INSERT INTO erp.approval_policy (entity_type, entity_key, action, requires_approval)
    VALUES
      ('VOUCHER_TYPE', 'RDV', 'create', false),
      ('VOUCHER_TYPE', 'RRV', 'create', false)
    ON CONFLICT (entity_type, entity_key, action) DO UPDATE SET
      requires_approval = EXCLUDED.requires_approval,
      updated_at = now()
  `);

  await knex.raw(`
    INSERT INTO erp.rgp_reason_registry (code, name, description, is_active)
    VALUES
      ('REPAIR', 'Repair', 'Sent for repair', true),
      ('CALIBRATION', 'Calibration', 'Calibration', true),
      ('SHARPENING', 'Sharpening', 'Sharpening', true),
      ('REFURBISH', 'Refurbishment / Overhaul', 'Refurbishment / Overhaul', true),
      ('COATING_TREATMENT', 'Coating / Surface Treatment', 'Coating / Surface Treatment', true),
      ('MODIFICATION', 'Modification', 'Modification', true),
      ('OTHERS', 'Others', 'Others', true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_active = EXCLUDED.is_active
  `);

  await knex.raw(`
    INSERT INTO erp.rgp_condition_registry (code, name, description, is_active)
    VALUES
      ('NEW', 'Unused', 'Unused', true),
      ('GOOD_WORKING', 'Fully Working', 'Fully Working', true),
      ('WORKING_MINOR_WEAR', 'Working, Minor Wear', 'Working, Minor Wear', true),
      ('DAMAGED', 'Damaged', 'Damaged condition', true),
      ('NON_FUNCTIONAL', 'Non-Functional', 'Non-Functional', true),
      ('INCOMPLETE', 'Missing Parts', 'Missing Parts', true),
      ('RUSTED_CORRODED', 'Rusted', 'Rusted', true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_active = EXCLUDED.is_active
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.assets (
      id bigserial PRIMARY KEY,
      asset_code text UNIQUE,
      asset_type_code text NOT NULL REFERENCES erp.asset_type_registry(code) ON DELETE RESTRICT,
      description text NOT NULL,
      home_branch_id bigint REFERENCES erp.branches(id) ON DELETE RESTRICT,
      is_active boolean NOT NULL DEFAULT true
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_assets_home_branch
      ON erp.assets(home_branch_id)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.rgp_outward (
      voucher_id bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
      vendor_party_id bigint NOT NULL REFERENCES erp.parties(id) ON DELETE RESTRICT,
      reason_code text NOT NULL REFERENCES erp.rgp_reason_registry(code) ON DELETE RESTRICT,
      expected_return_date date,
      status erp.rgp_out_status NOT NULL DEFAULT 'PENDING'
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_outward_vendor
      ON erp.rgp_outward(vendor_party_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_outward_status
      ON erp.rgp_outward(status)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.rgp_outward_line (
      voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
      asset_id bigint REFERENCES erp.assets(id) ON DELETE RESTRICT,
      item_type_code text NOT NULL REFERENCES erp.asset_type_registry(code) ON DELETE RESTRICT,
      item_description text NOT NULL,
      serial_no text,
      qty numeric(18,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
      condition_out_code text NOT NULL REFERENCES erp.rgp_condition_registry(code) ON DELETE RESTRICT,
      remarks text
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_outward_line_asset
      ON erp.rgp_outward_line(asset_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_outward_line_type
      ON erp.rgp_outward_line(item_type_code)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.rgp_inward (
      voucher_id bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
      rgp_out_voucher_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
      return_date date NOT NULL DEFAULT CURRENT_DATE
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_inward_out_voucher
      ON erp.rgp_inward(rgp_out_voucher_id)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.rgp_inward_line (
      id bigserial PRIMARY KEY,
      rgp_in_voucher_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
      rgp_out_voucher_line_id bigint NOT NULL REFERENCES erp.voucher_line(id) ON DELETE RESTRICT,
      returned_qty numeric(18,3) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
      condition_in_code text NOT NULL REFERENCES erp.rgp_condition_registry(code) ON DELETE RESTRICT,
      remarks text
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_inward_line_in_voucher
      ON erp.rgp_inward_line(rgp_in_voucher_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rgp_inward_line_out_line
      ON erp.rgp_inward_line(rgp_out_voucher_line_id)
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP TABLE IF EXISTS erp.rgp_inward_line");
  await knex.raw("DROP TABLE IF EXISTS erp.rgp_inward");
  await knex.raw("DROP TABLE IF EXISTS erp.rgp_outward_line");
  await knex.raw("DROP TABLE IF EXISTS erp.rgp_outward");
  await knex.raw("DROP TABLE IF EXISTS erp.assets");

  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type = 'VOUCHER_TYPE'
      AND entity_key IN ('RDV', 'RRV')
      AND action = 'create'
  `);

  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'VOUCHER'
      AND scope_key IN ('RDV', 'RRV')
  `);

  await knex.raw(`
    DELETE FROM erp.voucher_type
    WHERE code IN ('RDV', 'RRV')
  `);
};
