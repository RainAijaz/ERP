exports.up = async function up(knex) {
  // Ensure voucher type metadata exists for migrated databases (not just fresh seed setups).
  await knex.raw(`
    INSERT INTO erp.voucher_type (code, name, requires_approval, affects_stock, affects_gl)
    VALUES ('OPENING_STOCK', 'Opening Stock Voucher', true, true, true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      requires_approval = EXCLUDED.requires_approval,
      affects_stock = EXCLUDED.affects_stock,
      affects_gl = EXCLUDED.affects_gl
  `);

  // Register voucher permission scope so role matrix can control OPENING_STOCK access.
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('VOUCHER', 'OPENING_STOCK', 'Opening Stock Voucher', 'Inventory')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group
  `);

  // Default approval policy: create requires approval; edit/delete can be relaxed by admins later.
  await knex.raw(`
    INSERT INTO erp.approval_policy (entity_type, entity_key, action, requires_approval)
    VALUES
      ('VOUCHER_TYPE', 'OPENING_STOCK', 'create', true),
      ('VOUCHER_TYPE', 'OPENING_STOCK', 'edit', false),
      ('VOUCHER_TYPE', 'OPENING_STOCK', 'delete', false)
    ON CONFLICT (entity_type, entity_key, action) DO UPDATE SET
      requires_approval = EXCLUDED.requires_approval,
      updated_at = now()
  `);
};

exports.down = async function down(knex) {
  // Remove approval policies first to avoid dangling references to removed scope/type entries.
  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type = 'VOUCHER_TYPE'
      AND entity_key = 'OPENING_STOCK'
      AND action IN ('create', 'edit', 'delete')
  `);

  // Remove permission scope registration for OPENING_STOCK.
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'VOUCHER'
      AND scope_key = 'OPENING_STOCK'
  `);

  // Keep voucher_type row if operational vouchers already exist.
  await knex.raw(`
    DELETE FROM erp.voucher_type vt
    WHERE vt.code = 'OPENING_STOCK'
      AND NOT EXISTS (
        SELECT 1
        FROM erp.voucher_header vh
        WHERE vh.voucher_type_code = vt.code
      )
  `);
};
