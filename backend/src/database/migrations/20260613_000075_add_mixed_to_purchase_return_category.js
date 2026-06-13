exports.up = async function up(knex) {
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("purchase_return_header_ext");
  if (!hasTable) return;

  // Drop both possible constraint names (canonical + short legacy name)
  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      DROP CONSTRAINT IF EXISTS purchase_return_header_ext_purchase_category_check
  `);
  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      DROP CONSTRAINT IF EXISTS purchase_return_hdr_purchase_category_chk
  `);

  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      ADD CONSTRAINT purchase_return_header_ext_purchase_category_check
      CHECK (purchase_category IN ('RAW_MATERIAL', 'ASSET', 'CONSUMABLE', 'MIXED'))
  `);

  // Update the integrity trigger to handle MIXED category:
  // ITEM lines in a MIXED voucher → RAW_MATERIAL rules
  // ACCOUNT lines in a MIXED voucher → CONSUMABLE rules
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.trg_purchase_lines_require_rm_item()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_vt       text;
      v_category text := 'RAW_MATERIAL';
    BEGIN
      SELECT vh.voucher_type_code INTO v_vt
      FROM erp.voucher_header vh
      WHERE vh.id = NEW.voucher_header_id;

      IF v_vt NOT IN ('PO','PI','PR','GRN') THEN
        RETURN NEW;
      END IF;

      IF v_vt = 'PI' THEN
        BEGIN
          SELECT ph.purchase_category INTO v_category
          FROM erp.purchase_invoice_header_ext ph
          WHERE ph.voucher_id = NEW.voucher_header_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
          v_category := NULL;
        END;
      ELSIF v_vt = 'PR' THEN
        BEGIN
          SELECT ph.purchase_category INTO v_category
          FROM erp.purchase_return_header_ext ph
          WHERE ph.voucher_id = NEW.voucher_header_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
          v_category := NULL;
        END;
      ELSIF v_vt = 'GRN' THEN
        BEGIN
          SELECT gh.purchase_category INTO v_category
          FROM erp.purchase_grn_header_ext gh
          WHERE gh.voucher_id = NEW.voucher_header_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
          v_category := NULL;
        END;
      ELSE
        v_category := 'RAW_MATERIAL';
      END IF;

      v_category := upper(coalesce(v_category, 'RAW_MATERIAL'));

      -- During approval replay the header ext may not exist yet when lines are
      -- inserted. Use line_kind to infer ASSET vs CONSUMABLE in that case.
      IF v_vt IN ('PI','PR','GRN') AND NEW.line_kind = 'ACCOUNT'
         AND v_category NOT IN ('ASSET','CONSUMABLE','MIXED') THEN
        IF COALESCE(NEW.meta->>'asset_id', '') ~ '^[0-9]+$' THEN
          v_category := 'ASSET';
        ELSE
          v_category := 'CONSUMABLE';
        END IF;
      END IF;

      -- Resolve MIXED to per-line effective category
      IF v_category = 'MIXED' THEN
        IF NEW.line_kind = 'ACCOUNT' THEN
          v_category := 'CONSUMABLE';
        ELSE
          v_category := 'RAW_MATERIAL';
        END IF;
      END IF;

      -- ── ASSET validation ──────────────────────────────────────────────────
      IF v_category = 'ASSET' THEN
        IF NEW.line_kind <> 'ACCOUNT' THEN
          RAISE EXCEPTION 'Voucher % (%): only ACCOUNT lines allowed for ASSET purchase category.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.account_id IS NULL THEN
          RAISE EXCEPTION 'Voucher % (%): account_id is required for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.item_id IS NOT NULL THEN
          RAISE EXCEPTION 'Voucher % (%): item_id must be NULL for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF COALESCE(NEW.meta->>'asset_id', '') !~ '^[0-9]+$' THEN
          RAISE EXCEPTION 'Voucher % (%): asset_id is required in meta for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        PERFORM 1
        FROM erp.accounts a
        JOIN erp.account_groups ag ON ag.id = a.subgroup_id
        WHERE a.id = NEW.account_id
          AND lower(coalesce(ag.code, '')) = 'fixed_assets';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Voucher % (%): account_id % must belong to fixed_assets group for ASSET purchase lines.',
            NEW.voucher_header_id, v_vt, NEW.account_id;
        END IF;
        IF NEW.qty <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF v_vt <> 'GRN' AND COALESCE(NEW.rate, 0) <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): rate must be > 0 for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        RETURN NEW;
      END IF;

      -- ── CONSUMABLE validation ─────────────────────────────────────────────
      IF v_category = 'CONSUMABLE' THEN
        IF NEW.line_kind <> 'ACCOUNT' THEN
          RAISE EXCEPTION 'Voucher % (%): only ACCOUNT lines allowed for CONSUMABLE purchase category.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.account_id IS NULL THEN
          RAISE EXCEPTION 'Voucher % (%): account_id is required for CONSUMABLE purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.qty <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for CONSUMABLE purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF COALESCE(NEW.rate, 0) <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): rate must be > 0 for CONSUMABLE purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        RETURN NEW;
      END IF;

      -- ── RAW_MATERIAL validation ───────────────────────────────────────────
      IF NEW.line_kind <> 'ITEM' THEN
        RAISE EXCEPTION 'Voucher % (%): only ITEM lines allowed for purchase vouchers (category: %).', NEW.voucher_header_id, v_vt, v_category;
      END IF;
      IF NEW.item_id IS NULL THEN
        RAISE EXCEPTION 'Voucher % (%): item_id is required on purchase lines.', NEW.voucher_header_id, v_vt;
      END IF;
      PERFORM erp.assert_item_is_rm(NEW.item_id);
      IF NEW.qty <= 0 THEN
        RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for purchase lines.', NEW.voucher_header_id, v_vt;
      END IF;

      RETURN NEW;
    END;
    $$;
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema
    .withSchema("erp")
    .hasTable("purchase_return_header_ext");
  if (!hasTable) return;

  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      DROP CONSTRAINT IF EXISTS purchase_return_header_ext_purchase_category_check
  `);
  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      DROP CONSTRAINT IF EXISTS purchase_return_hdr_purchase_category_chk
  `);

  await knex.raw(`
    ALTER TABLE erp.purchase_return_header_ext
      ADD CONSTRAINT purchase_return_hdr_purchase_category_chk
      CHECK (purchase_category IN ('RAW_MATERIAL', 'ASSET', 'CONSUMABLE'))
  `);

  // Restore 072 trigger (CONSUMABLE support, no MIXED)
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.trg_purchase_lines_require_rm_item()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_vt       text;
      v_category text := 'RAW_MATERIAL';
    BEGIN
      SELECT vh.voucher_type_code INTO v_vt
      FROM erp.voucher_header vh
      WHERE vh.id = NEW.voucher_header_id;

      IF v_vt NOT IN ('PO','PI','PR','GRN') THEN
        RETURN NEW;
      END IF;

      IF v_vt = 'PI' THEN
        BEGIN
          SELECT ph.purchase_category INTO v_category
          FROM erp.purchase_invoice_header_ext ph
          WHERE ph.voucher_id = NEW.voucher_header_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
          v_category := 'RAW_MATERIAL';
        END;
      ELSIF v_vt = 'PR' THEN
        BEGIN
          SELECT ph.purchase_category INTO v_category
          FROM erp.purchase_return_header_ext ph
          WHERE ph.voucher_id = NEW.voucher_header_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
          v_category := 'RAW_MATERIAL';
        END;
      ELSIF v_vt = 'GRN' THEN
        BEGIN
          SELECT gh.purchase_category INTO v_category
          FROM erp.purchase_grn_header_ext gh
          WHERE gh.voucher_id = NEW.voucher_header_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
          v_category := 'RAW_MATERIAL';
        END;
      ELSE
        v_category := 'RAW_MATERIAL';
      END IF;

      v_category := upper(coalesce(v_category, 'RAW_MATERIAL'));

      IF v_category = 'ASSET' THEN
        IF NEW.line_kind <> 'ACCOUNT' THEN
          RAISE EXCEPTION 'Voucher % (%): only ACCOUNT lines allowed for ASSET purchase category.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.account_id IS NULL THEN
          RAISE EXCEPTION 'Voucher % (%): account_id is required for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.item_id IS NOT NULL THEN
          RAISE EXCEPTION 'Voucher % (%): item_id must be NULL for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF COALESCE(NEW.meta->>'asset_id', '') !~ '^[0-9]+$' THEN
          RAISE EXCEPTION 'Voucher % (%): asset_id is required in voucher_line.meta for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        PERFORM 1
        FROM erp.accounts a
        JOIN erp.account_groups ag ON ag.id = a.subgroup_id
        WHERE a.id = NEW.account_id
          AND lower(coalesce(ag.code, '')) = 'fixed_assets';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Voucher % (%): account_id % must belong to fixed_assets group for ASSET purchase lines.',
            NEW.voucher_header_id, v_vt, NEW.account_id;
        END IF;
        IF NEW.qty <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF v_vt <> 'GRN' AND COALESCE(NEW.rate, 0) <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): rate must be > 0 for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        RETURN NEW;
      END IF;

      IF v_category = 'CONSUMABLE' THEN
        IF NEW.line_kind <> 'ACCOUNT' THEN
          RAISE EXCEPTION 'Voucher % (%): only ACCOUNT lines allowed for CONSUMABLE purchase category.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.account_id IS NULL THEN
          RAISE EXCEPTION 'Voucher % (%): account_id is required for CONSUMABLE purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.item_id IS NOT NULL THEN
          RAISE EXCEPTION 'Voucher % (%): item_id must be NULL for CONSUMABLE purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.qty <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for CONSUMABLE purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        IF COALESCE(NEW.rate, 0) <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): rate must be > 0 for CONSUMABLE purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.line_kind <> 'ITEM' THEN
        RAISE EXCEPTION 'Voucher % (%): only ITEM lines allowed for RAW_MATERIAL purchase vouchers.', NEW.voucher_header_id, v_vt;
      END IF;
      IF NEW.item_id IS NULL THEN
        RAISE EXCEPTION 'Voucher % (%): item_id is required on purchase lines.', NEW.voucher_header_id, v_vt;
      END IF;
      PERFORM erp.assert_item_is_rm(NEW.item_id);
      IF NEW.qty <= 0 THEN
        RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for purchase lines.', NEW.voucher_header_id, v_vt;
      END IF;

      RETURN NEW;
    END;
    $$;
  `);
};
