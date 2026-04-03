exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      ADD COLUMN IF NOT EXISTS transfer_ref_no text,
      ADD COLUMN IF NOT EXISTS stock_type erp.stock_category,
      ADD COLUMN IF NOT EXISTS transfer_reason text,
      ADD COLUMN IF NOT EXISTS transporter_name text
  `);

  await knex.raw(`
    ALTER TABLE erp.grn_in_header
      ADD COLUMN IF NOT EXISTS received_by_user_id bigint REFERENCES erp.users(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS received_at timestamptz
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_transfer_out_transfer_ref_no
      ON erp.stock_transfer_out_header (transfer_ref_no)
      WHERE transfer_ref_no IS NOT NULL
  `);

  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES
      ('VOUCHER', 'STN_OUT', 'Stock Transfer Out Voucher', 'Inventory'),
      ('VOUCHER', 'GRN_IN', 'Stock Transfer In Voucher', 'Inventory')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS erp.ux_stock_transfer_out_transfer_ref_no
  `);

  await knex.raw(`
    ALTER TABLE erp.grn_in_header
      DROP COLUMN IF EXISTS received_at,
      DROP COLUMN IF EXISTS received_by_user_id
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      DROP COLUMN IF EXISTS transporter_name,
      DROP COLUMN IF EXISTS transfer_reason,
      DROP COLUMN IF EXISTS stock_type,
      DROP COLUMN IF EXISTS transfer_ref_no
  `);
};
