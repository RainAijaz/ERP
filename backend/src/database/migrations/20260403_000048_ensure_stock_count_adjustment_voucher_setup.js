exports.up = async function up(knex) {
  // Voucher type metadata is required for numbering, permissions, and approval policy routing.
  await knex.raw(`
    INSERT INTO erp.voucher_type (code, name, requires_approval, affects_stock, affects_gl)
    VALUES ('STOCK_COUNT_ADJ', 'Stock Count Voucher', true, true, true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      requires_approval = EXCLUDED.requires_approval,
      affects_stock = EXCLUDED.affects_stock,
      affects_gl = EXCLUDED.affects_gl
  `);

  // Permission scope must exist so role matrix and gatekeeper can evaluate voucher access.
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('VOUCHER', 'STOCK_COUNT_ADJ', 'Stock Count Voucher', 'Inventory')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group
  `);

  // Approval defaults: create/edit/delete all require approval by policy.
  await knex.raw(`
    INSERT INTO erp.approval_policy (entity_type, entity_key, action, requires_approval)
    VALUES
      ('VOUCHER_TYPE', 'STOCK_COUNT_ADJ', 'create', true),
      ('VOUCHER_TYPE', 'STOCK_COUNT_ADJ', 'edit', true),
      ('VOUCHER_TYPE', 'STOCK_COUNT_ADJ', 'delete', true)
    ON CONFLICT (entity_type, entity_key, action) DO UPDATE SET
      requires_approval = EXCLUDED.requires_approval,
      updated_at = now()
  `);

  // Seed reasons in global reason_codes and map them to STOCK_COUNT_ADJ for dropdown filtering.
  await knex.raw(`
    INSERT INTO erp.reason_codes (code, name, description, requires_notes, is_active)
    VALUES
      ('PHYSICAL_COUNT', 'Physical Count Correction', 'Mismatch found during physical count.', true, true),
      ('DAMAGE', 'Damage Write-off', 'Items damaged and adjusted out of stock.', true, true),
      ('SHORTAGE', 'Shortage', 'Counted quantity is lower than system stock.', true, true),
      ('EXCESS', 'Excess Found', 'Counted quantity is higher than system stock.', true, true),
      ('SYSTEM_CORRECTION', 'System Correction', 'Operational correction to align records.', true, true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      requires_notes = EXCLUDED.requires_notes,
      is_active = EXCLUDED.is_active
  `);

  await knex.raw(`
    INSERT INTO erp.reason_code_voucher_type_map (reason_code_id, voucher_type_code)
    SELECT rc.id, 'STOCK_COUNT_ADJ'
    FROM erp.reason_codes rc
    WHERE rc.code IN ('PHYSICAL_COUNT', 'DAMAGE', 'SHORTAGE', 'EXCESS', 'SYSTEM_CORRECTION')
    ON CONFLICT (reason_code_id, voucher_type_code) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  // Remove reason map first; keep reason codes only when not referenced elsewhere.
  await knex.raw(`
    DELETE FROM erp.reason_code_voucher_type_map
    WHERE voucher_type_code = 'STOCK_COUNT_ADJ'
      AND reason_code_id IN (
        SELECT id
        FROM erp.reason_codes
        WHERE code IN ('PHYSICAL_COUNT', 'DAMAGE', 'SHORTAGE', 'EXCESS', 'SYSTEM_CORRECTION')
      )
  `);

  await knex.raw(`
    DELETE FROM erp.reason_codes rc
    WHERE rc.code IN ('PHYSICAL_COUNT', 'DAMAGE', 'SHORTAGE', 'EXCESS', 'SYSTEM_CORRECTION')
      AND NOT EXISTS (
        SELECT 1
        FROM erp.stock_count_header sch
        WHERE sch.reason_code_id = rc.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM erp.reason_code_voucher_type_map m
        WHERE m.reason_code_id = rc.id
      )
  `);

  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type = 'VOUCHER_TYPE'
      AND entity_key = 'STOCK_COUNT_ADJ'
      AND action IN ('create', 'edit', 'delete')
  `);

  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'VOUCHER'
      AND scope_key = 'STOCK_COUNT_ADJ'
  `);

  await knex.raw(`
    DELETE FROM erp.voucher_type vt
    WHERE vt.code = 'STOCK_COUNT_ADJ'
      AND NOT EXISTS (
        SELECT 1
        FROM erp.voucher_header vh
        WHERE vh.voucher_type_code = vt.code
      )
  `);
};
