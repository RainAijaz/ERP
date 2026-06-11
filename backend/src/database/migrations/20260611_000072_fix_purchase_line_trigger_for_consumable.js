exports.up = async function up(knex) {
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

      -- Read purchase_category from the appropriate header extension table.
      -- Falls back to RAW_MATERIAL if the column does not exist yet.
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

      -- ── ASSET lines ────────────────────────────────────────────────────
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

      -- ── CONSUMABLE lines ───────────────────────────────────────────────
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

      -- ── RAW_MATERIAL lines (default) ───────────────────────────────────
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

exports.down = async function down(knex) {
  // Restore the original trigger that had the CONSUMABLE bug
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.trg_purchase_lines_require_rm_item()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_vt text;
      v_category text := 'RAW_MATERIAL';
    BEGIN
      SELECT vh.voucher_type_code INTO v_vt
      FROM erp.voucher_header vh
      WHERE vh.id = NEW.voucher_header_id;

      IF v_vt IN ('PO','PI','PR','GRN') THEN
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

        IF v_vt IN ('PI','PR','GRN') AND NEW.line_kind = 'ACCOUNT' THEN
          v_category := 'ASSET';
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

        IF NEW.line_kind <> 'ITEM' THEN
          RAISE EXCEPTION 'Voucher % (%): only ITEM lines allowed for purchase vouchers.', NEW.voucher_header_id, v_vt;
        END IF;
        IF NEW.item_id IS NULL THEN
          RAISE EXCEPTION 'Voucher % (%): item_id is required on purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
        PERFORM erp.assert_item_is_rm(NEW.item_id);
        IF NEW.qty <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$;
  `);
};
