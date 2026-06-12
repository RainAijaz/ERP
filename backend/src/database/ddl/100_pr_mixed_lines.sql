/* =============================================================================
   FILE: 100_pr_mixed_lines.sql
   PURPOSE
   - Allows Purchase Return (PR) vouchers to contain BOTH raw-material lines
     (line_kind='ITEM') and indirect/consumable lines (line_kind='ACCOUNT')
     in a single voucher.
   - Adds 'MIXED' and 'CONSUMABLE' as valid purchase_category values on
     purchase_return_header_ext.
   - Updates the integrity trigger so CONSUMABLE ACCOUNT lines are accepted
     on PR (and correctly validated for PI where they were previously broken
     by the ASSET override workaround).
   ============================================================================ */

SET search_path = erp;

-- 1. Widen purchase_return_header_ext.purchase_category constraint
ALTER TABLE erp.purchase_return_header_ext
  DROP CONSTRAINT IF EXISTS purchase_return_header_ext_purchase_category_check;

ALTER TABLE erp.purchase_return_header_ext
  ADD CONSTRAINT purchase_return_header_ext_purchase_category_check
  CHECK (purchase_category IN ('RAW_MATERIAL', 'ASSET', 'CONSUMABLE', 'MIXED'));

-- 2. Replace the purchase-line integrity trigger to handle CONSUMABLE + MIXED.
--    Key changes vs 091_integrity_checks.sql version:
--    a) The blanket "ACCOUNT line → treat as ASSET" workaround is replaced by
--       a smarter check: if meta contains a numeric asset_id → ASSET,
--       otherwise → CONSUMABLE.
--    b) CONSUMABLE validation block added (account_id required, qty/rate > 0,
--       no fixed_assets group restriction).
--    c) MIXED category maps per-line: ITEM lines → RAW_MATERIAL rules,
--       ACCOUNT lines → CONSUMABLE rules.
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

  -- Read header-level purchase_category (may be NULL if header ext not yet committed)
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
    v_category := 'RAW_MATERIAL'; -- PO always raw material
  END IF;

  v_category := upper(coalesce(v_category, 'RAW_MATERIAL'));

  -- During approval replay the header ext may not exist yet when lines are
  -- inserted.  Use the line itself to distinguish ASSET vs CONSUMABLE:
  --   • ACCOUNT line with numeric asset_id in meta  → ASSET
  --   • ACCOUNT line without asset_id in meta       → CONSUMABLE
  IF v_vt IN ('PI','PR','GRN') AND NEW.line_kind = 'ACCOUNT'
     AND v_category NOT IN ('ASSET','CONSUMABLE','MIXED') THEN
    IF COALESCE(NEW.meta->>'asset_id', '') ~ '^[0-9]+$' THEN
      v_category := 'ASSET';
    ELSE
      v_category := 'CONSUMABLE';
    END IF;
  END IF;

  -- For MIXED vouchers, derive per-line effective category from line_kind.
  IF v_category = 'MIXED' THEN
    IF NEW.line_kind = 'ACCOUNT' THEN
      v_category := 'CONSUMABLE';
    ELSE
      v_category := 'RAW_MATERIAL';
    END IF;
  END IF;

  -- ── ASSET validation ──────────────────────────────────────────────────────
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

  -- ── CONSUMABLE validation ─────────────────────────────────────────────────
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

  -- ── RAW_MATERIAL validation ───────────────────────────────────────────────
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

-- Re-attach trigger (DROP IF EXISTS + CREATE is idempotent)
DROP TRIGGER IF EXISTS trg_purchase_lines_require_rm_item ON erp.voucher_line;
CREATE TRIGGER trg_purchase_lines_require_rm_item
BEFORE INSERT OR UPDATE ON erp.voucher_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_purchase_lines_require_rm_item();
