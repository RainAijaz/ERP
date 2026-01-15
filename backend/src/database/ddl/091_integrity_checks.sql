-- =============================================================================
-- INVENTORY_INTEGRITY_CHECKS.sql
-- =============================================================================
-- PURPOSE
--   DB-level integrity + safety triggers for modules built on the voucher engine.
--   This file does NOT do posting/costing. It only blocks invalid/wrong links.
--
-- INCLUDES (GUARDS / TRIGGERS)
--   A) Stock Count
--      - Notes required when reason_codes.requires_notes = true
--      - stock_count_header must attach to voucher_type_code = 'STOCK_COUNT_ADJ'
--
--   B) Inventory Transfers (STN_OUT / GRN_IN)
--      - stock_transfer_out_header must attach to 'STN_OUT'
--      - received_voucher_id (if set) must be 'GRN_IN'
--      - grn_in_header must attach to 'GRN_IN' and against_stn_out_id must be 'STN_OUT'
--      - GRN_IN branch must equal STN_OUT.dest_branch_id
--      - Receive-once guard: one STN_OUT can be received by only one GRN_IN
--      - You cannot create a “Stock Transfer Out” voucher where the destination branch is the same as the source branch.
--
--   C) Production / Auto-child vouchers
--      - dcv_header must attach to 'DCV'
--      - production_line must attach to PROD_FG/PROD_SFG and compute total_pairs from voucher_line.qty
--      - consumption_header must attach to 'CONSUMP' and reference PROD_FG/PROD_SFG
--      - labour_voucher_header must attach to 'LABOUR_PROD' and reference PROD_FG/PROD_SFG
--      - production_generated_links enforced one-to-one by UPSERT guards
--      - labour_voucher_line must attach to 'LABOUR_PROD' and voucher_line must be LABOUR line (qty integer)
--
--   D) Abnormal Loss
--      - RM_LOSS must be ITEM line
--      - SFG_LOSS/FG_LOSS must be SKU line with integer pairs qty
--      - DVC_ABANDON must be SKU line + dept_id required + qty integer + qty <= WIP pool
--
--   E) BOM Enforcement
--      - bom_header.level must match items.item_type (FINISHED->FG, SEMI_FINISHED->SFG)
--      - bom_rm_line.rm_item_id must be RM
--      - bom_variant_rule.target_rm_item_id (if set) must be RM
--      - bom_sfg_line.ref_approved_bom_id (if set) must be APPROVED and must belong to same SFG item
--
--   F) Purchase Enforcement
--      - purchase_invoice_header_ext must attach to 'PI', optional po_voucher_id must be 'PO'
--      - purchase_return_header_ext must attach to 'PR'
--      - purchase voucher lines (PO/PI/PR) must be ITEM lines with RM item_id and qty > 0
--      - PO requirement policy enforced at COMMIT (DEFERRABLE INITIALLY DEFERRED)
--
--   G) Sales Enforcement
--      - sales_order_header must attach to 'SALES_ORDER'
--      - sales_header must attach to 'SALES_VOUCHER'
--      - sales_line must attach to SKU voucher_line of SALES_VOUCHER
--
-- NOTE
--   This script is designed to be re-runnable:
--   - CREATE OR REPLACE FUNCTION
--   - DROP TRIGGER IF EXISTS
--   - Guarded creation for optional modules/tables using to_regclass() checks
-- =============================================================================

SET search_path = erp;

-- =============================================================================
-- 0) SMALL HELPERS (shared)
-- =============================================================================

-- 0.1 Voucher type guard: blocks linking the wrong voucher_id to an extension table.
CREATE OR REPLACE FUNCTION erp.assert_voucher_type_code(p_voucher_id bigint, p_expected_type text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE v_type text;
BEGIN
  SELECT vh.voucher_type_code
    INTO v_type
  FROM erp.voucher_header vh
  WHERE vh.id = p_voucher_id;

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'Voucher % not found.', p_voucher_id;
  END IF;

  IF v_type <> p_expected_type THEN
    RAISE EXCEPTION 'Voucher % must be type %, found %.', p_voucher_id, p_expected_type, v_type;
  END IF;
END;
$$;

-- 0.2 Guard: Source voucher must be a production voucher (FG/SFG).
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

-- 0.3 Helper: ensure an item_id is RM (used by purchase line enforcement).
CREATE OR REPLACE FUNCTION erp.assert_item_is_rm(p_item_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE v_type erp.item_type;
BEGIN
  IF p_item_id IS NULL THEN
    RAISE EXCEPTION 'item_id cannot be NULL'
      USING ERRCODE = '23502';
  END IF;

  SELECT i.item_type
    INTO v_type
  FROM erp.items i
  WHERE i.id = p_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid item_id=%. Item not found.', p_item_id
      USING ERRCODE = '23503';
  END IF;

  IF v_type <> 'RM' THEN
    RAISE EXCEPTION 'Invalid item_id=%. Expected item_type=RM, got %.', p_item_id, v_type
      USING ERRCODE = '22000';
  END IF;
END;
$$;

-- =============================================================================
-- A) STOCK COUNT GUARDS
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('erp.stock_count_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

-- A1) Notes required when selected reason_code.requires_notes = true
CREATE OR REPLACE FUNCTION erp.trg_stock_count_notes_required()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reason_code_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM erp.reason_codes rc
       WHERE rc.id = NEW.reason_code_id AND rc.requires_notes
     )
     AND trim(coalesce(NEW.notes, '')) = '' THEN
    RAISE EXCEPTION 'Notes are required for the selected reason code.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_count_notes_required ON erp.stock_count_header;
CREATE TRIGGER trg_stock_count_notes_required
BEFORE INSERT OR UPDATE ON erp.stock_count_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_stock_count_notes_required();

-- A2) Extension must belong to STOCK_COUNT_ADJ voucher type
CREATE OR REPLACE FUNCTION erp.trg_stock_count_type_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'STOCK_COUNT_ADJ');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_count_type_guard ON erp.stock_count_header;
CREATE TRIGGER trg_stock_count_type_guard
BEFORE INSERT OR UPDATE ON erp.stock_count_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_stock_count_type_guard();

-- =============================================================================
-- B) TRANSFERS: STN_OUT + GRN_IN
-- =============================================================================

-- B1/B2) stock_transfer_out_header must be STN_OUT, and received_voucher_id (if set) must be GRN_IN.
DO $$
BEGIN
  IF to_regclass('erp.stock_transfer_out_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_stn_out_type_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'STN_OUT');

  IF NEW.received_voucher_id IS NOT NULL THEN
    PERFORM erp.assert_voucher_type_code(NEW.received_voucher_id, 'GRN_IN');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stn_out_type_guard ON erp.stock_transfer_out_header;
CREATE TRIGGER trg_stn_out_type_guard
BEFORE INSERT OR UPDATE ON erp.stock_transfer_out_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_stn_out_type_guard();

-- Helps Pending Incoming Transfers list (destination branch worklist)
CREATE INDEX IF NOT EXISTS ix_transfer_dest_status_date
  ON erp.stock_transfer_out_header(dest_branch_id, status, dispatch_date);

-- Optional guard: prevent self-transfer even when CHECK is removed.
DO $$
BEGIN
  IF to_regclass('erp.stock_transfer_out_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_stock_transfer_out_no_self_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_source_branch bigint;
BEGIN
  SELECT branch_id INTO v_source_branch
  FROM erp.voucher_header
  WHERE id = NEW.voucher_id;

  IF v_source_branch IS NULL THEN
    RAISE EXCEPTION 'voucher_header % not found', NEW.voucher_id;
  END IF;

  IF NEW.dest_branch_id = v_source_branch THEN
    RAISE EXCEPTION 'Cannot transfer to same branch (branch_id=%).', v_source_branch;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_transfer_out_no_self_transfer ON erp.stock_transfer_out_header;
CREATE TRIGGER trg_stock_transfer_out_no_self_transfer
BEFORE INSERT OR UPDATE ON erp.stock_transfer_out_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_stock_transfer_out_no_self_transfer();

-- C1/C2) GRN_IN must be GRN_IN; against STN_OUT must be STN_OUT; GRN_IN branch must equal STN_OUT.dest_branch_id
DO $$
BEGIN
  IF to_regclass('erp.grn_in_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_grn_in_dest_branch_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_grn_branch_id  bigint;
  v_dest_branch_id bigint;
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'GRN_IN');
  PERFORM erp.assert_voucher_type_code(NEW.against_stn_out_id, 'STN_OUT');

  SELECT vh.branch_id, sth.dest_branch_id
    INTO v_grn_branch_id, v_dest_branch_id
  FROM erp.voucher_header vh
  JOIN erp.stock_transfer_out_header sth
    ON sth.voucher_id = NEW.against_stn_out_id
  WHERE vh.id = NEW.voucher_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Invalid GRN_IN (%)/STN_OUT (%) link (voucher missing or transfer header missing).',
      NEW.voucher_id, NEW.against_stn_out_id;
  END IF;

  IF v_grn_branch_id <> v_dest_branch_id THEN
    RAISE EXCEPTION
      'GRN_IN branch mismatch: GRN_IN branch_id=% but STN_OUT destination branch_id=%.',
      v_grn_branch_id, v_dest_branch_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grn_in_dest_branch_only ON erp.grn_in_header;
CREATE TRIGGER trg_grn_in_dest_branch_only
BEFORE INSERT OR UPDATE ON erp.grn_in_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_grn_in_dest_branch_only();

-- C3/C4) Receive-once + mark transfer as received
CREATE OR REPLACE FUNCTION erp.trg_grn_in_receive_once_and_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE erp.stock_transfer_out_header sth
     SET received_voucher_id = NEW.voucher_id,
         received_at         = now(),
         status              = 'RECEIVED'
   WHERE sth.voucher_id = NEW.against_stn_out_id
     AND (sth.received_voucher_id IS NULL OR sth.received_voucher_id = NEW.voucher_id);

  IF FOUND THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM erp.stock_transfer_out_header WHERE voucher_id = NEW.against_stn_out_id
  ) THEN
    RAISE EXCEPTION 'STN_OUT % not found in stock_transfer_out_header.', NEW.against_stn_out_id;
  END IF;

  RAISE EXCEPTION 'STN_OUT % already received by another GRN_IN voucher.', NEW.against_stn_out_id;
END;
$$;

DROP TRIGGER IF EXISTS trg_grn_in_receive_once_and_close ON erp.grn_in_header;
CREATE TRIGGER trg_grn_in_receive_once_and_close
AFTER INSERT OR UPDATE OF against_stn_out_id ON erp.grn_in_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_grn_in_receive_once_and_close();

-- =============================================================================
-- D) PRODUCTION INTEGRITY
-- =============================================================================

-- D1) DCV header type guard
DO $$
BEGIN
  IF to_regclass('erp.dcv_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_dcv_type_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'DCV');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dcv_type_guard ON erp.dcv_header;
CREATE TRIGGER trg_dcv_type_guard
BEFORE INSERT OR UPDATE ON erp.dcv_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_dcv_type_guard();

-- D2) Production line validation + compute total_pairs from voucher_line.qty
-- Meaning:
--   - is_packed = true  => voucher_line.qty is in DOZEN units, allowed step 0.5 dozen
--   - is_packed = false => voucher_line.qty is in PAIRS, must be integer
DO $$
BEGIN
  IF to_regclass('erp.production_line') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_production_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_header_id  bigint;
  v_kind       erp.voucher_line_kind;
  v_sku_id     bigint;
  v_qty        numeric(18,3);
  v_vtype      text;
BEGIN
  SELECT vl.voucher_header_id, vl.line_kind, vl.sku_id, vl.qty, vh.voucher_type_code
    INTO v_header_id, v_kind, v_sku_id, v_qty, v_vtype
  FROM erp.voucher_line   vl
  JOIN erp.voucher_header vh ON vh.id = vl.voucher_header_id
  WHERE vl.id = NEW.voucher_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher_line % not found', NEW.voucher_line_id;
  END IF;

  IF v_kind <> 'SKU' OR v_sku_id IS NULL THEN
    RAISE EXCEPTION 'Production lines must be SKU lines (line_kind=SKU, sku_id required).';
  END IF;

  IF v_vtype NOT IN ('PROD_FG','PROD_SFG') THEN
    RAISE EXCEPTION 'Not a production voucher (expected PROD_FG/PROD_SFG). Got %', v_vtype;
  END IF;

  IF coalesce(v_qty,0) <= 0 THEN
    RAISE EXCEPTION 'Production quantity must be > 0';
  END IF;

  IF NEW.is_packed = true THEN
    -- Packed entry is in DOZEN with 0.5-dozen increments (e.g., 1.0, 1.5, 2.0).
    IF (v_qty * 2) <> trunc(v_qty * 2) THEN
      RAISE EXCEPTION 'PACKED qty must be in 0.5 dozen increments';
    END IF;

    -- Convert dozen -> pairs (12 pairs per dozen)
    NEW.total_pairs := (v_qty * 12)::int;

  ELSE
    -- Loose entry is direct pairs (integer only)
    IF v_qty <> trunc(v_qty) THEN
      RAISE EXCEPTION 'LOOSE qty must be integer pairs';
    END IF;

    NEW.total_pairs := v_qty::int;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_production_line_validate ON erp.production_line;
CREATE TRIGGER trg_production_line_validate
BEFORE INSERT OR UPDATE ON erp.production_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_production_line_validate();

-- D3) Consumption header must be CONSUMP and must reference production voucher
DO $$
BEGIN
  IF to_regclass('erp.consumption_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_consumption_header_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'CONSUMP');
  PERFORM erp.assert_is_production_voucher(NEW.source_production_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_consumption_header_validate ON erp.consumption_header;
CREATE TRIGGER trg_consumption_header_validate
BEFORE INSERT OR UPDATE ON erp.consumption_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_consumption_header_validate();

-- D3) Labour voucher header must be LABOUR_PROD and must reference production voucher
DO $$
BEGIN
  IF to_regclass('erp.labour_voucher_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_labour_voucher_header_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'LABOUR_PROD');
  PERFORM erp.assert_is_production_voucher(NEW.source_production_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_labour_voucher_header_validate ON erp.labour_voucher_header;
CREATE TRIGGER trg_labour_voucher_header_validate
BEFORE INSERT OR UPDATE ON erp.labour_voucher_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_labour_voucher_header_validate();

-- D4) Link consumption to production (one-to-one) using UPSERT
DO $$
BEGIN
  IF to_regclass('erp.production_generated_links') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_link_consumption_to_production()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_rows int;
BEGIN
  INSERT INTO erp.production_generated_links (production_voucher_id, consumption_voucher_id)
  VALUES (NEW.source_production_id, NEW.voucher_id)
  ON CONFLICT (production_voucher_id) DO UPDATE
    SET consumption_voucher_id = EXCLUDED.consumption_voucher_id
  WHERE erp.production_generated_links.consumption_voucher_id IS NULL
     OR erp.production_generated_links.consumption_voucher_id = EXCLUDED.consumption_voucher_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Production voucher % already has a different consumption voucher.', NEW.source_production_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_consumption_to_production ON erp.consumption_header;
CREATE TRIGGER trg_link_consumption_to_production
AFTER INSERT OR UPDATE OF source_production_id ON erp.consumption_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_link_consumption_to_production();

-- D4) Link labour voucher to production (one-to-one) using UPSERT
CREATE OR REPLACE FUNCTION erp.trg_link_labour_to_production()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_rows int;
BEGIN
  INSERT INTO erp.production_generated_links (production_voucher_id, labour_voucher_id)
  VALUES (NEW.source_production_id, NEW.voucher_id)
  ON CONFLICT (production_voucher_id) DO UPDATE
    SET labour_voucher_id = EXCLUDED.labour_voucher_id
  WHERE erp.production_generated_links.labour_voucher_id IS NULL
     OR erp.production_generated_links.labour_voucher_id = EXCLUDED.labour_voucher_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Production voucher % already has a different labour voucher.', NEW.source_production_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_labour_to_production ON erp.labour_voucher_header;
CREATE TRIGGER trg_link_labour_to_production
AFTER INSERT OR UPDATE OF source_production_id ON erp.labour_voucher_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_link_labour_to_production();

-- D5) Labour voucher line validation
-- NOTE: sku_id should be taken from voucher_line (line_kind=LABOUR already pins labour_id).
-- This guard enforces: LABOUR_PROD voucher + voucher_line.line_kind='LABOUR' + qty integer pairs + dept_id required.
DO $$
BEGIN
  IF to_regclass('erp.labour_voucher_line') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_labour_voucher_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_header_id  bigint;
  v_kind       erp.voucher_line_kind;
  v_qty        numeric(18,3);
  v_labour_id  bigint;
BEGIN
  SELECT vl.voucher_header_id, vl.line_kind, vl.qty, vl.labour_id
    INTO v_header_id, v_kind, v_qty, v_labour_id
  FROM erp.voucher_line vl
  WHERE vl.id = NEW.voucher_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher_line % not found', NEW.voucher_line_id;
  END IF;

  PERFORM erp.assert_voucher_type_code(v_header_id, 'LABOUR_PROD');

  IF v_kind <> 'LABOUR' THEN
    RAISE EXCEPTION 'Labour voucher lines must have line_kind=LABOUR.';
  END IF;

  IF v_labour_id IS NULL THEN
    RAISE EXCEPTION 'LABOUR line must have labour_id filled in voucher_line.';
  END IF;

  IF coalesce(v_qty,0) <= 0 OR v_qty <> trunc(v_qty) THEN
    RAISE EXCEPTION 'Labour qty must be a positive integer (pairs).';
  END IF;

  IF NEW.dept_id IS NULL THEN
    RAISE EXCEPTION 'dept_id is required in labour_voucher_line.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_labour_voucher_line_validate ON erp.labour_voucher_line;
CREATE TRIGGER trg_labour_voucher_line_validate
BEFORE INSERT OR UPDATE ON erp.labour_voucher_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_labour_voucher_line_validate();

-- Helpful index for audits/joins (if tables exist)
CREATE INDEX IF NOT EXISTS idx_prod_links_consumption
  ON erp.production_generated_links(consumption_voucher_id);

CREATE INDEX IF NOT EXISTS idx_prod_links_labour
  ON erp.production_generated_links(labour_voucher_id);

-- =============================================================================
-- E) ABNORMAL LOSS LINE VALIDATION
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('erp.abnormal_loss_line') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_abnormal_loss_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_header_id  bigint;
  v_branch_id  bigint;
  v_kind       erp.voucher_line_kind;
  v_item_id    bigint;
  v_sku_id     bigint;
  v_qty        numeric(18,3);
  v_pool_qty   int;
BEGIN
  SELECT vl.voucher_header_id, vl.line_kind, vl.item_id, vl.sku_id, vl.qty
    INTO v_header_id, v_kind, v_item_id, v_sku_id, v_qty
  FROM erp.voucher_line vl
  WHERE vl.id = NEW.voucher_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher_line % not found', NEW.voucher_line_id;
  END IF;

  SELECT vh.branch_id INTO v_branch_id
  FROM erp.voucher_header vh
  WHERE vh.id = v_header_id;

  IF coalesce(v_qty,0) <= 0 THEN
    RAISE EXCEPTION 'Loss quantity must be > 0';
  END IF;

  IF NEW.loss_type = 'RM_LOSS' THEN
    IF v_kind <> 'ITEM' OR v_item_id IS NULL THEN
      RAISE EXCEPTION 'RM_LOSS must use an ITEM line (item_id).';
    END IF;

  ELSIF NEW.loss_type IN ('SFG_LOSS','FG_LOSS') THEN
    IF v_kind <> 'SKU' OR v_sku_id IS NULL THEN
      RAISE EXCEPTION 'SFG/FG loss must use a SKU line (sku_id).';
    END IF;
    IF v_qty <> trunc(v_qty) THEN
      RAISE EXCEPTION 'SFG/FG loss qty must be integer pairs.';
    END IF;

  ELSE -- DVC_ABANDON
    IF v_kind <> 'SKU' OR v_sku_id IS NULL THEN
      RAISE EXCEPTION 'DVC_ABANDON must use a SKU line (sku_id).';
    END IF;
    IF NEW.dept_id IS NULL THEN
      RAISE EXCEPTION 'DVC_ABANDON requires dept_id.';
    END IF;
    IF v_qty <> trunc(v_qty) THEN
      RAISE EXCEPTION 'DVC_ABANDON qty must be integer pairs.';
    END IF;

    SELECT b.qty_pairs INTO v_pool_qty
    FROM erp.wip_dept_balance b
    WHERE b.branch_id = v_branch_id
      AND b.sku_id    = v_sku_id
      AND b.dept_id   = NEW.dept_id;

    IF coalesce(v_pool_qty,0) < v_qty::int THEN
      RAISE EXCEPTION
        'DVC_ABANDON qty % exceeds pending WIP qty % for branch %, sku %, dept %.',
        v_qty::int, coalesce(v_pool_qty,0), v_branch_id, v_sku_id, NEW.dept_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_abnormal_loss_line_validate ON erp.abnormal_loss_line;
CREATE TRIGGER trg_abnormal_loss_line_validate
BEFORE INSERT OR UPDATE ON erp.abnormal_loss_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_abnormal_loss_line_validate();

-- =============================================================================
-- F) BOM ENFORCEMENT
-- =============================================================================

-- F1) ref_approved_bom_id must be APPROVED and must match the SFG item behind sfg_sku_id
DO $$
BEGIN
  IF to_regclass('erp.bom_sfg_line') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_bom_sfg_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_sfg_item_id bigint;
  v_ref_item_id bigint;
  v_ref_status  erp.bom_status;
BEGIN
  -- Find the item behind the SFG SKU (sku -> variant -> item)
  SELECT i.id
  INTO v_sfg_item_id
  FROM erp.skus s
  JOIN erp.variants v ON v.id = s.variant_id
  JOIN erp.items i    ON i.id = v.item_id
  WHERE s.id = NEW.sfg_sku_id;

  IF v_sfg_item_id IS NULL THEN
    RAISE EXCEPTION 'Invalid sfg_sku_id %.', NEW.sfg_sku_id;
  END IF;

  IF (SELECT item_type FROM erp.items WHERE id = v_sfg_item_id) <> 'SFG' THEN
    RAISE EXCEPTION 'sfg_sku_id % does not belong to an SFG item.', NEW.sfg_sku_id;
  END IF;

  -- If ref BOM provided: must be approved + must be for same SFG item
  IF NEW.ref_approved_bom_id IS NOT NULL THEN
    SELECT bh.item_id, bh.status
    INTO v_ref_item_id, v_ref_status
    FROM erp.bom_header bh
    WHERE bh.id = NEW.ref_approved_bom_id;

    IF v_ref_item_id IS NULL THEN
      RAISE EXCEPTION 'ref_approved_bom_id % not found.', NEW.ref_approved_bom_id;
    END IF;

    IF v_ref_status <> 'APPROVED' THEN
      RAISE EXCEPTION 'ref_approved_bom_id % must be APPROVED (current=%).',
        NEW.ref_approved_bom_id, v_ref_status;
    END IF;

    IF v_ref_item_id <> v_sfg_item_id THEN
      RAISE EXCEPTION 'ref_approved_bom_id % is for item %, but sfg_sku_id % is for item %.',
        NEW.ref_approved_bom_id, v_ref_item_id, NEW.sfg_sku_id, v_sfg_item_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bom_sfg_line_validate ON erp.bom_sfg_line;
CREATE TRIGGER trg_bom_sfg_line_validate
BEFORE INSERT OR UPDATE ON erp.bom_sfg_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_bom_sfg_line_validate();

-- F2) bom_header.level must match items.item_type (FINISHED->FG, SEMI_FINISHED->SFG)
DO $$
BEGIN
  IF to_regclass('erp.bom_header') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_bom_header_validate_item_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_item_type erp.item_type;
BEGIN
  SELECT i.item_type
    INTO v_item_type
  FROM erp.items i
  WHERE i.id = NEW.item_id;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'BOM item_id % not found in items.', NEW.item_id;
  END IF;

  IF NEW.level = 'FINISHED' AND v_item_type <> 'FG' THEN
    RAISE EXCEPTION
      'Invalid BOM: level=FINISHED requires item_type=FG. item_id=% has item_type=%.',
      NEW.item_id, v_item_type;
  END IF;

  IF NEW.level = 'SEMI_FINISHED' AND v_item_type <> 'SFG' THEN
    RAISE EXCEPTION
      'Invalid BOM: level=SEMI_FINISHED requires item_type=SFG. item_id=% has item_type=%.',
      NEW.item_id, v_item_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bom_header_validate_item_type ON erp.bom_header;
CREATE TRIGGER trg_bom_header_validate_item_type
BEFORE INSERT OR UPDATE OF item_id, level ON erp.bom_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_bom_header_validate_item_type();

-- F3) bom_rm_line.rm_item_id must be RM
DO $$
BEGIN
  IF to_regclass('erp.bom_rm_line') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_bom_rm_line_validate_rm_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_item_type erp.item_type;
BEGIN
  SELECT i.item_type INTO v_item_type
  FROM erp.items i
  WHERE i.id = NEW.rm_item_id;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'bom_rm_line.rm_item_id % not found in items.', NEW.rm_item_id;
  END IF;

  IF v_item_type <> 'RM' THEN
    RAISE EXCEPTION
      'Invalid bom_rm_line: rm_item_id % must be item_type=RM (found=%).',
      NEW.rm_item_id, v_item_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bom_rm_line_validate_rm_item ON erp.bom_rm_line;
CREATE TRIGGER trg_bom_rm_line_validate_rm_item
BEFORE INSERT OR UPDATE OF rm_item_id ON erp.bom_rm_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_bom_rm_line_validate_rm_item();

-- F4) bom_variant_rule.target_rm_item_id (if set) must be RM
DO $$
BEGIN
  IF to_regclass('erp.bom_variant_rule') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_bom_variant_rule_validate_target_rm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_item_type erp.item_type;
BEGIN
  IF NEW.target_rm_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.item_type INTO v_item_type
  FROM erp.items i
  WHERE i.id = NEW.target_rm_item_id;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'bom_variant_rule.target_rm_item_id % not found in items.', NEW.target_rm_item_id;
  END IF;

  IF v_item_type <> 'RM' THEN
    RAISE EXCEPTION
      'Invalid bom_variant_rule: target_rm_item_id % must be item_type=RM (found=%).',
      NEW.target_rm_item_id, v_item_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bom_variant_rule_validate_target_rm ON erp.bom_variant_rule;
CREATE TRIGGER trg_bom_variant_rule_validate_target_rm
BEFORE INSERT OR UPDATE OF target_rm_item_id ON erp.bom_variant_rule
FOR EACH ROW
EXECUTE FUNCTION erp.trg_bom_variant_rule_validate_target_rm();

-- =============================================================================
-- G) SALES ENFORCEMENT
-- =============================================================================

-- Sales Order header vtype
CREATE OR REPLACE FUNCTION erp.trg_sales_order_header_vtype()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'SALES_ORDER');
  RETURN NEW;
END;
$fn$;

-- Sales voucher header vtype
CREATE OR REPLACE FUNCTION erp.trg_sales_header_vtype()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'SALES_VOUCHER');
  RETURN NEW;
END;
$fn$;

-- Sales line validate
CREATE OR REPLACE FUNCTION erp.trg_sales_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_header_id bigint;
  v_kind      erp.voucher_line_kind;
BEGIN
  SELECT vl.voucher_header_id, vl.line_kind
    INTO v_header_id, v_kind
  FROM erp.voucher_line vl
  WHERE vl.id = NEW.voucher_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher_line % not found', NEW.voucher_line_id;
  END IF;

  PERFORM erp.assert_voucher_type_code(v_header_id, 'SALES_VOUCHER');

  IF v_kind <> 'SKU' THEN
    RAISE EXCEPTION 'sales_line must attach to SKU lines only (line_kind=SKU).';
  END IF;

  RETURN NEW;
END;
$fn$;
DO $do$
BEGIN
  IF to_regclass('erp.sales_order_header') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_sales_order_header_vtype ON erp.sales_order_header';
    EXECUTE 'CREATE TRIGGER trg_sales_order_header_vtype
             BEFORE INSERT OR UPDATE ON erp.sales_order_header
             FOR EACH ROW EXECUTE FUNCTION erp.trg_sales_order_header_vtype()';
  END IF;

  IF to_regclass('erp.sales_header') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_sales_header_vtype ON erp.sales_header';
    EXECUTE 'CREATE TRIGGER trg_sales_header_vtype
             BEFORE INSERT OR UPDATE ON erp.sales_header
             FOR EACH ROW EXECUTE FUNCTION erp.trg_sales_header_vtype()';
  END IF;

  IF to_regclass('erp.sales_line') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_sales_line_validate ON erp.sales_line';
    EXECUTE 'CREATE TRIGGER trg_sales_line_validate
             BEFORE INSERT OR UPDATE ON erp.sales_line
             FOR EACH ROW EXECUTE FUNCTION erp.trg_sales_line_validate()';
  END IF;
END
$do$;
-- =============================================================================
-- H) PURCHASE ENFORCEMENT
-- =============================================================================

-- H1) purchase_invoice_header_ext must attach to PI, and po_voucher_id (if set) must attach to PO
CREATE OR REPLACE FUNCTION erp.trg_purchase_invoice_header_ext_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'PI');

  IF NEW.po_voucher_id IS NOT NULL THEN
    PERFORM erp.assert_voucher_type_code(NEW.po_voucher_id, 'PO');
  END IF;

  RETURN NEW;
END;
$fn$;

-- Purchase return header ext must attach to PR
CREATE OR REPLACE FUNCTION erp.trg_purchase_return_header_ext_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'PR');
  RETURN NEW;
END;
$fn$;
DO $do$
BEGIN
  IF to_regclass('erp.purchase_invoice_header_ext') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_purchase_invoice_header_ext_validate ON erp.purchase_invoice_header_ext';
    EXECUTE 'CREATE TRIGGER trg_purchase_invoice_header_ext_validate
             BEFORE INSERT OR UPDATE ON erp.purchase_invoice_header_ext
             FOR EACH ROW EXECUTE FUNCTION erp.trg_purchase_invoice_header_ext_validate()';
  END IF;

  IF to_regclass('erp.purchase_return_header_ext') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_purchase_return_header_ext_validate ON erp.purchase_return_header_ext';
    EXECUTE 'CREATE TRIGGER trg_purchase_return_header_ext_validate
             BEFORE INSERT OR UPDATE ON erp.purchase_return_header_ext
             FOR EACH ROW EXECUTE FUNCTION erp.trg_purchase_return_header_ext_validate()';
  END IF;
END
$do$;

-- H2) Purchase voucher lines enforcement (PO/PI/PR must be ITEM RM lines with qty > 0)
-- Implemented as a trigger on voucher_line (covers all inserts/updates).
CREATE OR REPLACE FUNCTION erp.trg_purchase_lines_require_rm_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_vt text;
BEGIN
  SELECT vh.voucher_type_code INTO v_vt
  FROM erp.voucher_header vh
  WHERE vh.id = NEW.voucher_header_id;

  IF v_vt IN ('PO','PI','PR') THEN
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

DROP TRIGGER IF EXISTS trg_purchase_lines_require_rm_item ON erp.voucher_line;
CREATE TRIGGER trg_purchase_lines_require_rm_item
BEFORE INSERT OR UPDATE ON erp.voucher_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_purchase_lines_require_rm_item();

-- H3) PO-required enforcement at COMMIT (policy rules)
-- Uses your correct table name: erp.purchase_order_requirement_rule
-- IMPORTANT:
--   This logic is deferred to COMMIT because PI amount and item presence depend on all lines being inserted first.
CREATE OR REPLACE FUNCTION erp.enforce_po_requirement_for_purchase_invoice(p_pi_voucher_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_supplier   bigint;
  v_total      numeric(18,2);
  v_has_po     boolean;
  v_policy_hit boolean;
  v_has_group_col boolean;
  v_group_col_name text;
BEGIN
  -- Only enforce for PI vouchers
  IF NOT EXISTS (
    SELECT 1
    FROM erp.voucher_header vh
    WHERE vh.id = p_pi_voucher_id AND vh.voucher_type_code = 'PI'
  ) THEN
    RETURN;
  END IF;

  -- Read supplier + whether PO is linked
  SELECT ph.supplier_party_id, (ph.po_voucher_id IS NOT NULL)
    INTO v_supplier, v_has_po
  FROM erp.purchase_invoice_header_ext ph
  WHERE ph.voucher_id = p_pi_voucher_id;

  -- If header not present yet in the transaction, skip for now (will be checked at COMMIT via triggers)
  IF v_supplier IS NULL THEN
    RETURN;
  END IF;

  -- Total from voucher lines
  SELECT COALESCE(SUM(vl.amount),0)::numeric(18,2)
    INTO v_total
  FROM erp.voucher_line vl
  WHERE vl.voucher_header_id = p_pi_voucher_id;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='erp' AND table_name='items' AND column_name='group_id'
  ) THEN
    v_group_col_name := 'group_id';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='erp' AND table_name='items' AND column_name='product_group_id'
  ) THEN
    v_group_col_name := 'product_group_id';
  ELSE
    v_group_col_name := NULL; -- group filtering will be skipped if schema doesn’t support it
  END IF;

  -- Determine if ANY active policy rule matches this invoice (=> PO required)
  IF v_group_col_name IS NULL THEN
    -- No group column available; enforce only amount/supplier/rm_item rules
    SELECT EXISTS (
      SELECT 1
      FROM erp.purchase_order_requirement_rule r
      WHERE r.is_active = true
        AND (r.min_amount IS NULL OR v_total > r.min_amount)
        AND (r.supplier_party_id IS NULL OR r.supplier_party_id = v_supplier)
        AND (
          r.rm_item_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM erp.voucher_line vl
            WHERE vl.voucher_header_id = p_pi_voucher_id
              AND vl.item_id = r.rm_item_id
          )
        )
        AND (r.rm_group_id IS NULL)  -- cannot evaluate without group column
    ) INTO v_policy_hit;
  ELSE
    -- Group column exists; enforce full rule set using dynamic SQL for the group column
    EXECUTE format($f$
      SELECT EXISTS (
        SELECT 1
        FROM erp.purchase_order_requirement_rule r
        WHERE r.is_active = true
          AND (r.min_amount IS NULL OR $1 > r.min_amount)
          AND (r.supplier_party_id IS NULL OR r.supplier_party_id = $2)
          AND (
            r.rm_item_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM erp.voucher_line vl
              WHERE vl.voucher_header_id = $3
                AND vl.item_id = r.rm_item_id
            )
          )
          AND (
            r.rm_group_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM erp.voucher_line vl
              JOIN erp.items it ON it.id = vl.item_id
              WHERE vl.voucher_header_id = $3
                AND it.%I = r.rm_group_id
            )
          )
      )
    $f$, v_group_col_name)
    INTO v_policy_hit
    USING v_total, v_supplier, p_pi_voucher_id;
  END IF;

  IF v_policy_hit AND NOT v_has_po THEN
    RAISE EXCEPTION
      'PO is required by purchase policy for PI voucher % (total=%) but po_voucher_id is NULL.',
      p_pi_voucher_id, v_total;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION erp.trg_pi_po_requirement_deferred_on_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM erp.enforce_po_requirement_for_purchase_invoice(NEW.voucher_header_id);
    RETURN NEW;
  END IF;

  PERFORM erp.enforce_po_requirement_for_purchase_invoice(OLD.voucher_header_id);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS pi_po_requirement_chk ON erp.voucher_line;
CREATE CONSTRAINT TRIGGER pi_po_requirement_chk
AFTER INSERT OR UPDATE OR DELETE ON erp.voucher_line
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION erp.trg_pi_po_requirement_deferred_on_lines();

CREATE OR REPLACE FUNCTION erp.trg_pi_po_requirement_deferred_on_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.enforce_po_requirement_for_purchase_invoice(NEW.voucher_id);
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('erp.purchase_invoice_header_ext') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS pi_po_requirement_hdr_chk ON erp.purchase_invoice_header_ext';
    EXECUTE 'CREATE CONSTRAINT TRIGGER pi_po_requirement_hdr_chk
             AFTER INSERT OR UPDATE ON erp.purchase_invoice_header_ext
             DEFERRABLE INITIALLY DEFERRED
             FOR EACH ROW
             EXECUTE FUNCTION erp.trg_pi_po_requirement_deferred_on_header()';
  END IF;
END $$;

-- =============================================================================
-- OPTIONAL: RM purchase rate init avg (only if table exists)
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('erp.rm_purchase_rates') IS NULL THEN
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION erp.trg_rm_rate_init_avg()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.avg_purchase_rate IS NULL OR NEW.avg_purchase_rate = 0 THEN
    NEW.avg_purchase_rate := NEW.purchase_rate;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rm_rate_init_avg ON erp.rm_purchase_rates;
CREATE TRIGGER trg_rm_rate_init_avg
BEFORE INSERT ON erp.rm_purchase_rates
FOR EACH ROW
EXECUTE FUNCTION erp.trg_rm_rate_init_avg();
