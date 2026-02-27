exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.voucher_type (code, name, requires_approval, affects_stock, affects_gl)
    VALUES ('GRN', 'Goods Receipt Note', false, true, false)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      requires_approval = EXCLUDED.requires_approval,
      affects_stock = EXCLUDED.affects_stock,
      affects_gl = EXCLUDED.affects_gl
  `);

  await knex.raw(`
    UPDATE erp.voucher_type
    SET name = 'General Purchase'
    WHERE code = 'PI'
  `);

  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('VOUCHER', 'GRN', 'Goods Receipt Note', 'Purchase')
    ON CONFLICT (scope_type, scope_key) DO UPDATE SET
      description = EXCLUDED.description,
      module_group = EXCLUDED.module_group
  `);

  await knex.raw(`
    UPDATE erp.permission_scope_registry
    SET description = 'General Purchase'
    WHERE scope_type = 'VOUCHER'
      AND scope_key = 'PI'
  `);

  await knex.raw(`
    INSERT INTO erp.approval_policy (entity_type, entity_key, action, requires_approval)
    VALUES ('VOUCHER_TYPE', 'GRN', 'create', false)
    ON CONFLICT (entity_type, entity_key, action) DO UPDATE SET
      requires_approval = EXCLUDED.requires_approval,
      updated_at = now()
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.purchase_grn_header_ext (
      voucher_id bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
      supplier_party_id bigint NOT NULL REFERENCES erp.parties(id),
      supplier_reference_no varchar(120),
      description text
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_purchase_grn_header_supplier
      ON erp.purchase_grn_header_ext (supplier_party_id)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.purchase_grn_invoice_alloc (
      id bigserial PRIMARY KEY,
      purchase_voucher_line_id bigint NOT NULL REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
      grn_voucher_line_id bigint NOT NULL REFERENCES erp.voucher_line(id) ON DELETE RESTRICT,
      qty_allocated numeric(18,3) NOT NULL CHECK (qty_allocated > 0),
      unit_rate numeric(18,4) NOT NULL DEFAULT 0 CHECK (unit_rate >= 0),
      amount numeric(18,2) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (purchase_voucher_line_id, grn_voucher_line_id)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_purchase_grn_alloc_grn_line
      ON erp.purchase_grn_invoice_alloc (grn_voucher_line_id)
  `);

  const hasGrnReferenceVoucherNo = await knex.schema.withSchema("erp").hasColumn("purchase_invoice_header_ext", "grn_reference_voucher_no");
  if (!hasGrnReferenceVoucherNo) {
    await knex.schema.withSchema("erp").table("purchase_invoice_header_ext", (table) => {
      table.bigInteger("grn_reference_voucher_no").nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasGrnReferenceVoucherNo = await knex.schema.withSchema("erp").hasColumn("purchase_invoice_header_ext", "grn_reference_voucher_no");
  if (hasGrnReferenceVoucherNo) {
    await knex.schema.withSchema("erp").table("purchase_invoice_header_ext", (table) => {
      table.dropColumn("grn_reference_voucher_no");
    });
  }

  await knex.raw("DROP TABLE IF EXISTS erp.purchase_grn_invoice_alloc");
  await knex.raw("DROP TABLE IF EXISTS erp.purchase_grn_header_ext");

  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type = 'VOUCHER_TYPE'
      AND entity_key = 'GRN'
      AND action = 'create'
  `);

  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'VOUCHER'
      AND scope_key = 'GRN'
  `);

  await knex.raw(`
    DELETE FROM erp.voucher_type
    WHERE code = 'GRN'
  `);

  await knex.raw(`
    UPDATE erp.voucher_type
    SET name = 'Purchase Invoice'
    WHERE code = 'PI'
  `);

  await knex.raw(`
    UPDATE erp.permission_scope_registry
    SET description = 'Purchase Invoice'
    WHERE scope_type = 'VOUCHER'
      AND scope_key = 'PI'
  `);
};
