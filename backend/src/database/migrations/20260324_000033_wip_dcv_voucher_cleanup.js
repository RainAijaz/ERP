exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.assert_is_production_voucher(p_voucher_id bigint)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE v_type text;
    BEGIN
      SELECT vh.voucher_type_code INTO v_type
      FROM erp.voucher_header vh
      WHERE vh.id = p_voucher_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Voucher % not found', p_voucher_id;
      END IF;

      IF v_type NOT IN ('DCV','PROD_FG','PROD_SFG') THEN
        RAISE EXCEPTION 'Expected production source voucher (DCV/PROD_FG/PROD_SFG), got % for voucher %', v_type, p_voucher_id;
      END IF;
    END;
    $$;
  `);

  await knex.raw(`
    DELETE FROM erp.role_permissions
    WHERE scope_id IN (
      SELECT id
      FROM erp.permission_scope_registry
      WHERE scope_type = 'VOUCHER'
        AND scope_key IN ('PROD_FG', 'PROD_SFG')
    );

    DELETE FROM erp.user_permissions_override
    WHERE scope_id IN (
      SELECT id
      FROM erp.permission_scope_registry
      WHERE scope_type = 'VOUCHER'
        AND scope_key IN ('PROD_FG', 'PROD_SFG')
    );

    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'VOUCHER'
      AND scope_key IN ('PROD_FG', 'PROD_SFG');
  `);

  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type = 'VOUCHER_TYPE'
      AND entity_key IN ('PROD_FG', 'PROD_SFG');

    DELETE FROM erp.voucher_type vt
    WHERE vt.code IN ('PROD_FG', 'PROD_SFG')
      AND NOT EXISTS (
        SELECT 1
        FROM erp.voucher_header vh
        WHERE vh.voucher_type_code = vt.code
      );
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.assert_is_production_voucher(p_voucher_id bigint)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE v_type text;
    BEGIN
      SELECT vh.voucher_type_code INTO v_type
      FROM erp.voucher_header vh
      WHERE vh.id = p_voucher_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Voucher % not found', p_voucher_id;
      END IF;

      IF v_type NOT IN ('PROD_FG','PROD_SFG') THEN
        RAISE EXCEPTION 'Expected production voucher (PROD_FG/PROD_SFG), got % for voucher %', v_type, p_voucher_id;
      END IF;
    END;
    $$;
  `);

  await knex.raw(`
    INSERT INTO erp.voucher_type (code, name, requires_approval, affects_stock, affects_gl)
    VALUES
      ('PROD_SFG', 'Semi-Finished Production Voucher', false, true, true),
      ('PROD_FG', 'Finished Production Voucher', false, true, true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      requires_approval = EXCLUDED.requires_approval,
      affects_stock = EXCLUDED.affects_stock,
      affects_gl = EXCLUDED.affects_gl;

    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES
      ('VOUCHER','PROD_SFG','Semi-Finished Production Voucher', 'Production'),
      ('VOUCHER','PROD_FG','Finished Production Voucher', 'Production'),
      ('VOUCHER','LABOUR_PROD','General Labour Production Voucher', 'Production'),
      ('VOUCHER','CONSUMP','Consumption Voucher', 'Production')
    ON CONFLICT (scope_type, scope_key) DO NOTHING;

    INSERT INTO erp.approval_policy (entity_type, entity_key, action, requires_approval)
    VALUES
      ('VOUCHER_TYPE', 'PROD_SFG', 'create', false),
      ('VOUCHER_TYPE', 'PROD_FG', 'create', false)
    ON CONFLICT (entity_type, entity_key, action) DO UPDATE SET
      requires_approval = EXCLUDED.requires_approval,
      updated_at = now();
  `);
};
