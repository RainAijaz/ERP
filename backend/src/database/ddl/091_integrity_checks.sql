-- INVENTORY.SQL
-- =====================================================================
-- VALIDATION + SAFETY TRIGGERS
-- Inventory Transfers (STN_OUT / GRN_IN) + Stock Count
-- + Production integrity (DCV / Production lines / Auto child vouchers)
-- =====================================================================
-- Goal:
--   Same business rules as your longer script, but fewer lines and less repetition.
--
-- Philosophy:
--   1) Put *data-integrity* rules in DB (so bad data can’t enter even via scripts/imports).
--   2) Keep posting/costing/business calculations in backend (your voucher engine).
--
-- Depends on existing objects from your other files:
--   - erp.voucher_header, erp.voucher_line
--   - erp.assert_voucher_type_code(voucher_id, expected_code)
--   - enums: erp.voucher_line_kind, erp.stock_type, erp.loss_type, etc.
--   - tables: erp.reason_codes, erp.stock_count_header, erp.grn_in_header,
--             erp.stock_transfer_out_header, erp.production_line, erp.dcv_header,
--             erp.consumption_header, erp.labour_voucher_header, erp.labour_voucher_line,
--             erp.production_generated_links, erp.abnormal_loss_line, erp.wip_dept_balance
-- =====================================================================

SET search_path = erp;

-- =====================================================================
-- 0) SMALL HELPERS (reduce repeated code)
-- =====================================================================
-- Why helpers?
--   Your earlier version repeats the same "select voucher_type_code / join voucher_line"
--   logic across many trigger functions. These helpers cut that repetition.

-- 0.1 Guard: Voucher must be of a specific voucher_type_code
CREATE OR REPLACE FUNCTION erp.guard_voucher_type(p_voucher_id bigint, p_expected text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(p_voucher_id, p_expected);
END;
$$;

-- 0.2 Guard: Source voucher must be Production (FG/SFG)
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


-- =====================================================================
-- A) STOCK COUNT GUARDS
-- =====================================================================
-- Rules:
--   A1) If selected reason_codes.requires_notes = TRUE, notes must be non-empty.
--   A2) stock_count_header must attach only to STOCK_COUNT_ADJ voucher type.

-- A1) Notes required when reason requires notes (short form: EXISTS)
CREATE OR REPLACE FUNCTION erp.trg_stock_count_notes_required()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reason_code_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM erp.reason_codes rc
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

-- A2) Extension must belong to STOCK_COUNT_ADJ
CREATE OR REPLACE FUNCTION erp.trg_stock_count_type_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.guard_voucher_type(NEW.voucher_id, 'STOCK_COUNT_ADJ');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_count_type_guard ON erp.stock_count_header;
CREATE TRIGGER trg_stock_count_type_guard
BEFORE INSERT OR UPDATE ON erp.stock_count_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_stock_count_type_guard();


-- =====================================================================
-- B) TRANSFERS: STN_OUT header guard (dispatch/receive link integrity)
-- =====================================================================
-- Rules:
--   B1) stock_transfer_out_header.voucher_id must be STN_OUT
--   B2) If received_voucher_id present, it must be GRN_IN
-- Why in DB?
--   Prevents wrong voucher IDs being linked (even if backend/UI bugs).

CREATE OR REPLACE FUNCTION erp.trg_stn_out_type_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.guard_voucher_type(NEW.voucher_id, 'STN_OUT');

  IF NEW.received_voucher_id IS NOT NULL THEN
    PERFORM erp.guard_voucher_type(NEW.received_voucher_id, 'GRN_IN');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stn_out_type_guard ON erp.stock_transfer_out_header;
CREATE TRIGGER trg_stn_out_type_guard
BEFORE INSERT OR UPDATE ON erp.stock_transfer_out_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_stn_out_type_guard();

-- Speeds up Pending Incoming Transfers (destination branch worklist)
CREATE INDEX IF NOT EXISTS ix_transfer_dest_status_date
  ON erp.stock_transfer_out_header(dest_branch_id, status, dispatch_date);


-- =====================================================================
-- C) GRN_IN: destination branch-only receiving + receive-once
-- =====================================================================
-- Rules:
--   C1) GRN_IN voucher must be GRN_IN; against_stn_out_id must be STN_OUT
--   C2) GRN_IN voucher_header.branch_id must equal STN_OUT.dest_branch_id
--   C3) One-time receive: same STN_OUT cannot be received by multiple GRN_IN vouchers
--   C4) When GRN_IN links, mark transfer status=RECEIVED + set received_at + store linkage

-- C1 + C2) Destination branch restriction (single join, fewer queries)
CREATE OR REPLACE FUNCTION erp.trg_grn_in_dest_branch_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_grn_branch_id  bigint;
  v_dest_branch_id bigint;
BEGIN
  PERFORM erp.guard_voucher_type(NEW.voucher_id, 'GRN_IN');
  PERFORM erp.guard_voucher_type(NEW.against_stn_out_id, 'STN_OUT');

  SELECT vh.branch_id, sth.dest_branch_id
    INTO v_grn_branch_id, v_dest_branch_id
  FROM erp.voucher_header vh
  JOIN erp.stock_transfer_out_header sth
    ON sth.voucher_id = NEW.against_stn_out_id
  WHERE vh.id = NEW.voucher_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid GRN_IN (%)/STN_OUT (%) link (voucher missing or transfer header missing).',
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

-- C3 + C4) Receive once + mark transfer as received (short update-first logic)
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

  -- If update failed, distinguish "not found" vs "already received by someone else"
  IF NOT EXISTS (SELECT 1 FROM erp.stock_transfer_out_header WHERE voucher_id = NEW.against_stn_out_id) THEN
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


-- =====================================================================
-- D) PRODUCTION INTEGRITY (DB guards only, posting stays in backend)
-- =====================================================================
-- Includes:
--   D1) DCV header must attach to DCV voucher type
--   D2) Production line must attach to production voucher types and compute total_pairs rule
--   D3) Consumption/Labour headers must attach to correct voucher types and must reference PROD_FG/PROD_SFG
--   D4) One-to-one linking into production_generated_links (short upsert logic)
--   D5) Labour voucher line must attach to LABOUR_PROD and must be LABOUR line with qty integer pairs

-- D1) DCV header type guard
CREATE OR REPLACE FUNCTION erp.trg_dcv_type_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.guard_voucher_type(NEW.voucher_id, 'DCV');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dcv_type_guard ON erp.dcv_header;
CREATE TRIGGER trg_dcv_type_guard
BEFORE INSERT OR UPDATE ON erp.dcv_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_dcv_type_guard();

-- D2) Production line validation + compute total_pairs from voucher_line.qty
-- Notes:
--   - Uses one join to fetch voucher_id + type + sku + qty in one go (fewer lines).
--   - Keeps your PACKED (0.5 dozen) and LOOSE (integer pairs) rules.
CREATE OR REPLACE FUNCTION erp.trg_production_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_voucher_id bigint;
  v_kind       erp.voucher_line_kind;
  v_sku_id     bigint;
  v_qty        numeric(18,3);
  v_vtype      text;
BEGIN
  SELECT vl.voucher_id, vl.line_kind, vl.sku_id, vl.qty, vh.voucher_type_code
    INTO v_voucher_id, v_kind, v_sku_id, v_qty, v_vtype
  FROM erp.voucher_line vl
  JOIN erp.voucher_header vh ON vh.id = vl.voucher_id
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

  IF NEW.stock_type = 'PACKED' THEN
    IF (v_qty*2) <> trunc(v_qty*2) THEN
      RAISE EXCEPTION 'PACKED qty must be in 0.5 dozen increments';
    END IF;
    IF (v_qty*12) <> trunc(v_qty*12) THEN
      RAISE EXCEPTION 'PACKED qty must convert to whole pairs (qty*12 integer)';
    END IF;
    NEW.total_pairs := (v_qty*12)::int;
  ELSE
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
CREATE OR REPLACE FUNCTION erp.trg_consumption_header_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.guard_voucher_type(NEW.voucher_id, 'CONSUMP');
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
CREATE OR REPLACE FUNCTION erp.trg_labour_voucher_header_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.guard_voucher_type(NEW.voucher_id, 'LABOUR_PROD');
  PERFORM erp.assert_is_production_voucher(NEW.source_production_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_labour_voucher_header_validate ON erp.labour_voucher_header;
CREATE TRIGGER trg_labour_voucher_header_validate
BEFORE INSERT OR UPDATE ON erp.labour_voucher_header
FOR EACH ROW
EXECUTE FUNCTION erp.trg_labour_voucher_header_validate();

-- D4) Link consumption to production (one-to-one) using a short UPSERT
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

-- D4) Link labour voucher to production (one-to-one) using a short UPSERT
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

-- D5) Labour voucher line validation (one join, fewer lines)
CREATE OR REPLACE FUNCTION erp.trg_labour_voucher_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_voucher_id bigint;
  v_kind       erp.voucher_line_kind;
  v_qty        numeric(18,3);
  v_labour_id  bigint;
BEGIN
  SELECT vl.voucher_id, vl.line_kind, vl.qty, vl.labour_id
    INTO v_voucher_id, v_kind, v_qty, v_labour_id
  FROM erp.voucher_line vl
  WHERE vl.id = NEW.voucher_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher_line % not found', NEW.voucher_line_id;
  END IF;

  PERFORM erp.guard_voucher_type(v_voucher_id, 'LABOUR_PROD');

  IF v_kind <> 'LABOUR' THEN
    RAISE EXCEPTION 'Labour voucher lines must have line_kind=LABOUR.';
  END IF;

  IF v_labour_id IS NULL THEN
    RAISE EXCEPTION 'LABOUR line must have labour_id filled in voucher_line.';
  END IF;

  IF coalesce(v_qty,0) <= 0 OR v_qty <> trunc(v_qty) THEN
    RAISE EXCEPTION 'Labour qty must be a positive integer (pairs).';
  END IF;

  -- dept_id + sku_id live in extension table (kept as your rule)
  IF NEW.dept_id IS NULL OR NEW.sku_id IS NULL THEN
    RAISE EXCEPTION 'dept_id and sku_id are required in labour_voucher_line.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_labour_voucher_line_validate ON erp.labour_voucher_line;
CREATE TRIGGER trg_labour_voucher_line_validate
BEFORE INSERT OR UPDATE ON erp.labour_voucher_line
FOR EACH ROW
EXECUTE FUNCTION erp.trg_labour_voucher_line_validate();


-- =====================================================================
-- E) ABNORMAL LOSS LINE VALIDATION (compact)
-- =====================================================================
-- Rules:
--   - RM_LOSS   : must be ITEM line (decimal qty allowed)
--   - SFG/FG    : must be SKU line (qty integer pairs)
--   - DVC_ABANDON: must be SKU line + dept required + qty integer pairs
--                 and qty must not exceed WIP pool for (branch, sku, dept)

CREATE OR REPLACE FUNCTION erp.trg_abnormal_loss_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_voucher_id bigint;
  v_branch_id  bigint;
  v_kind       erp.voucher_line_kind;
  v_item_id    bigint;
  v_sku_id     bigint;
  v_qty        numeric(18,3);
  v_pool_qty   int;
BEGIN
  SELECT vl.voucher_id, vl.line_kind, vl.item_id, vl.sku_id, vl.qty
    INTO v_voucher_id, v_kind, v_item_id, v_sku_id, v_qty
  FROM erp.voucher_line vl
  WHERE vl.id = NEW.voucher_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher_line % not found', NEW.voucher_line_id;
  END IF;

  SELECT vh.branch_id INTO v_branch_id
  FROM erp.voucher_header vh
  WHERE vh.id = v_voucher_id;

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


-- =====================================================================
-- F) POSTING-TIME ASSERTS (helper functions for backend)
-- =====================================================================
-- These are not “UI validations”. They’re safety checks meant to be called
-- inside your posting transaction before touching stock_ledger / gl_post rows.

CREATE OR REPLACE FUNCTION erp.assert_voucher_is_approved(p_voucher_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE v_status erp.approval_status;
BEGIN
  SELECT status INTO v_status
  FROM erp.voucher_header
  WHERE id = p_voucher_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Voucher % not found', p_voucher_id;
  END IF;

  IF v_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Voucher % must be APPROVED before posting (current=%).', p_voucher_id, v_status;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION erp.assert_stock_count_can_post(p_voucher_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_is_approved(p_voucher_id);

  IF NOT EXISTS (SELECT 1 FROM erp.stock_count_header WHERE voucher_id = p_voucher_id) THEN
    RAISE EXCEPTION 'stock_count_header missing for voucher %', p_voucher_id;
  END IF;
END;
$$;

-- CHECKS FOR 010_FOUNDATION.SQL

-- This function return TRUE if the period is LOCKED or FROZEN for the given branch/date.
CREATE OR REPLACE FUNCTION erp.is_period_locked(p_branch_id bigint, p_date date)
RETURNS boolean AS $$
DECLARE v_status erp.period_status;
BEGIN
  SELECT pc.status INTO v_status
  FROM erp.period_control pc
  WHERE pc.branch_id = p_branch_id
    AND pc.period_year  = EXTRACT(YEAR FROM p_date)::int
    AND pc.period_month = EXTRACT(MONTH FROM p_date)::int
  LIMIT 1;

  RETURN COALESCE(v_status IN ('LOCKED','FROZEN'), false);
END;
$$ LANGUAGE plpgsql STABLE;

/* ==================================== APPROVAL DECISIONS BY ADMIN-ONLY (DB-LEVEL ENFORCEMENT) ================================== */

-- PURPOSE - It returns true/false based on -> “Is this user an active Admin?”
CREATE OR REPLACE FUNCTION erp.is_admin(p_user_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM erp.users u
    JOIN erp.role_templates r ON r.id = u.primary_role_id
    WHERE u.id = p_user_id
      AND lower(trim(r.name)) = 'admin'
      AND lower(trim(u.status)) = 'active'
  );
$$;

-- A trigger function is a piece of code that runs automatically (is "triggered") in response to a specific event
-- - Blocks deciding approval unless decided_by is Admin.
CREATE OR REPLACE FUNCTION erp.trg_approval_decider_admin_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Clear error message (instead of only CHECK constraint violation).
  IF NEW.status = 'PENDING' AND (NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot set decided_by/decided_at while status is PENDING.';
  END IF;

  -- If update attempts to decide (decided_by set OR status not pending),
  -- enforce decided_by and admin-only.
  IF (NEW.decided_by IS NOT NULL OR NEW.status <> 'PENDING') THEN

    -- If moving away from PENDING, decided_by must be present.
    IF NEW.status <> 'PENDING' AND NEW.decided_by IS NULL THEN
      RAISE EXCEPTION 'decided_by is required when changing approval status.';
    END IF;

    -- Admin-only decider.
    IF NEW.decided_by IS NOT NULL AND NOT erp.is_admin(NEW.decided_by) THEN
      RAISE EXCEPTION 'Only ADMIN can decide approval requests. User % is not ADMIN.', NEW.decided_by;
    END IF;

    -- Auto timestamp for consistent audit trail.
    IF NEW.decided_by IS NOT NULL AND NEW.decided_at IS NULL THEN
      NEW.decided_at := now();
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

-- Bind trigger: BEFORE UPDATE blocks invalid updates before they are written.
DROP TRIGGER IF EXISTS trg_approval_admin_only ON erp.approval_request;
CREATE TRIGGER trg_approval_admin_only
BEFORE UPDATE ON erp.approval_request
FOR EACH ROW
EXECUTE FUNCTION erp.trg_approval_decider_admin_only();

-- FOR MASTER_DATA.SQL
-- keep avg same as purchase at start (only on insert)
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

--FOR GL_STOCK.SQL
-- -----------------------------------------------------------------------------
-- DB ENFORCEMENT: Batch must balance (SUM(dr) = SUM(cr))
-- -----------------------------------------------------------------------------
-- Insert all gl_entry rows for a voucher/batch inside one TRANSACTION -> BEGIN---COMMIT
-- - We want to allow inserting multiple gl_entry rows first, then validate at COMMIT.
-- - DEFERRABLE INITIALLY DEFERRED => validates at transaction end (COMMIT).
CREATE OR REPLACE FUNCTION erp.assert_gl_batch_balanced(p_batch_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE v_dr numeric(18,2);
DECLARE v_cr numeric(18,2);
BEGIN
  IF p_batch_id IS NULL THEN
    RETURN;
  END IF;

  -- If batch row no longer exists (deleted), nothing to validate
  IF NOT EXISTS (SELECT 1 FROM erp.gl_batch b WHERE b.id = p_batch_id) THEN
    RETURN;
  END IF;

  -- Sum all debits and credits in this batch
  SELECT
    COALESCE(SUM(e.dr),0)::numeric(18,2),
    COALESCE(SUM(e.cr),0)::numeric(18,2)
  INTO v_dr, v_cr
  FROM erp.gl_entry e
  WHERE e.batch_id = p_batch_id;

  -- Fail the transaction if not balanced
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION
      'GL batch % not balanced: total DR=% total CR=% (difference=%).',
      p_batch_id, v_dr, v_cr, (v_dr - v_cr);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION erp.trg_gl_entry_enforce_batch_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT affects NEW.batch_id
  IF TG_OP = 'INSERT' THEN
    PERFORM erp.assert_gl_batch_balanced(NEW.batch_id);
    RETURN NEW;
  END IF;

  -- DELETE affects OLD.batch_id
  IF TG_OP = 'DELETE' THEN
    PERFORM erp.assert_gl_batch_balanced(OLD.batch_id);
    RETURN OLD;
  END IF;

  -- UPDATE can affect OLD batch and/or NEW batch (if moved between batches)
  PERFORM erp.assert_gl_batch_balanced(OLD.batch_id);
  PERFORM erp.assert_gl_batch_balanced(NEW.batch_id);
  RETURN NEW;
END;
$$;

-- Remove trigger if it already exists (so the script can be re-run safely)
DROP TRIGGER IF EXISTS gl_entry_batch_balance_chk ON erp.gl_entry;
CREATE CONSTRAINT TRIGGER gl_entry_batch_balance_chk
AFTER INSERT OR UPDATE OR DELETE ON erp.gl_entry
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION erp.trg_gl_entry_enforce_batch_balance();


--FOR BOM_PRODUCTION.SQL
-- =============================================================================
-- DB ENFORCEMENT: ref_approved_bom_id (if set) must point to an APPROVED BOM
-- =============================================================================
CREATE OR REPLACE FUNCTION erp.trg_bom_sfg_line_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_sfg_item_id bigint;
  v_ref_item_id bigint;
  v_ref_status  erp.approval_status;
BEGIN
  -- Find the item behind the SFG SKU
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

-- =============================================================================
-- DB ENFORCEMENT: BOM type validation (FG/SFG/RM correctness)
-- =============================================================================
-- Enforces:
-- 1) bom_header.level='FINISHED'      => bom_header.item_id must be items.item_type='FG'
-- 2) bom_header.level='SEMI_FINISHED' => bom_header.item_id must be items.item_type='SFG'
-- 3) bom_rm_line.rm_item_id           => must be items.item_type='RM'
-- 4) bom_variant_rule.target_rm_item_id (if set) => must be items.item_type='RM'
--
-- Note:
-- - This is DB-level safety to prevent wrong data even if UI/backend misses validation.
-- - Written rerunnable: CREATE OR REPLACE + DROP TRIGGER IF EXISTS
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) Validate bom_header.item_id matches bom_header.level
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION erp.trg_bom_header_validate_item_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_type erp.item_type;
BEGIN
  -- Fetch item type of the BOM's item
  SELECT i.item_type
  INTO v_item_type
  FROM erp.items i
  WHERE i.id = NEW.item_id;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'BOM item_id % not found in items.', NEW.item_id;
  END IF;

  -- Level -> required item_type mapping
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



-- -----------------------------------------------------------------------------
-- 2) Validate bom_rm_line.rm_item_id is RM
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION erp.trg_bom_rm_line_validate_rm_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_type erp.item_type;
BEGIN
  SELECT i.item_type
  INTO v_item_type
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



-- -----------------------------------------------------------------------------
-- 3) Validate bom_variant_rule.target_rm_item_id (if set) is RM
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION erp.trg_bom_variant_rule_validate_target_rm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_type erp.item_type;
BEGIN
  -- If no target item, nothing to validate
  IF NEW.target_rm_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.item_type
  INTO v_item_type
  FROM erp.items i
  WHERE i.id = NEW.target_rm_item_id;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION
      'bom_variant_rule.target_rm_item_id % not found in items.',
      NEW.target_rm_item_id;
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

--060_SALES_AR.SQL
-- Voucher-type integrity (prevents attaching SO header to wrong voucher)
CREATE OR REPLACE FUNCTION erp.trg_sales_order_header_vtype()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'SALES_ORDER');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sales_order_header_vtype ON erp.sales_order_header;
CREATE TRIGGER trg_sales_order_header_vtype
BEFORE INSERT OR UPDATE ON erp.sales_order_header
FOR EACH ROW EXECUTE FUNCTION erp.trg_sales_order_header_vtype();

CREATE OR REPLACE FUNCTION erp.trg_sales_header_vtype()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'SALES_VOUCHER');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sales_header_vtype ON erp.sales_header;
CREATE TRIGGER trg_sales_header_vtype
BEFORE INSERT OR UPDATE ON erp.sales_header
FOR EACH ROW EXECUTE FUNCTION erp.trg_sales_header_vtype();

-- Optional safety: ensure sales_line attaches only to SALES_VOUCHER and SKU lines
CREATE OR REPLACE FUNCTION erp.trg_sales_line_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_voucher_id bigint;
  v_kind       erp.voucher_line_kind;
BEGIN
  SELECT vl.voucher_id, vl.line_kind
    INTO v_voucher_id, v_kind
  FROM erp.voucher_line vl
  WHERE vl.id = NEW.voucher_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher_line % not found', NEW.voucher_line_id;
  END IF;

  PERFORM erp.assert_voucher_type_code(v_voucher_id, 'SALES_VOUCHER');

  IF v_kind <> 'SKU' THEN
    RAISE EXCEPTION 'sales_line must attach to SKU lines only (line_kind=SKU).';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sales_line_validate ON erp.sales_line;
CREATE TRIGGER trg_sales_line_validate
BEFORE INSERT OR UPDATE ON erp.sales_line
FOR EACH ROW EXECUTE FUNCTION erp.trg_sales_line_validate();


--070_PURCHASE_AP.SQL
-- ---------------------------------------------------------------------------
-- Helper functions (used by triggers)
-- ---------------------------------------------------------------------------

-- Ensure a voucher_id belongs to an expected voucher type code (e.g., 'PO','PI','PR','STN_OUT','GRN_IN')
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

-- -----------------------------------------------------------------------------
-- Trigger: validate that the header row is attached to the correct voucher type
-- -----------------------------------------------------------------------------
-- What this trigger protects you from:
-- - Someone accidentally inserting PI header extension against a non-PI voucher
-- - Someone linking a PO reference that is not actually a PO voucher
CREATE OR REPLACE FUNCTION erp.trg_purchase_invoice_header_ext_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'PI');
  IF NEW.po_voucher_id IS NOT NULL THEN
    PERFORM erp.assert_voucher_type_code(NEW.po_voucher_id, 'PO');
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_purchase_invoice_header_ext_validate ON erp.purchase_invoice_header_ext;
CREATE TRIGGER trg_purchase_invoice_header_ext_validate
BEFORE INSERT OR UPDATE ON erp.purchase_invoice_header_ext
FOR EACH ROW
EXECUTE FUNCTION erp.trg_purchase_invoice_header_ext_validate();

CREATE OR REPLACE FUNCTION erp.trg_purchase_return_header_ext_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'PR');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_return_header_ext_validate ON erp.purchase_return_header_ext;
CREATE TRIGGER trg_purchase_return_header_ext_validate
BEFORE INSERT OR UPDATE ON erp.purchase_return_header_ext
FOR EACH ROW
EXECUTE FUNCTION erp.trg_purchase_return_header_ext_validate();

-- ---------------------------------------------------------------------------
-- 10.5 Purchase line enforcement (PO/PI/PR rows must be RM lines)
-- ---------------------------------------------------------------------------
-- Your PO/PI/PR “rows” live in voucher_line. This enforces:
-- - For voucher types PO/PI/PR: only ITEM lines allowed (line_kind='ITEM')
-- - item_id must be RM
-- - qty must be > 0
CREATE OR REPLACE FUNCTION erp.trg_purchase_lines_require_rm_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_vt text;
BEGIN
  SELECT vh.voucher_type_code INTO v_vt
  FROM erp.voucher_header vh
  WHERE vh.id = NEW.voucher_id;

  IF v_vt IN ('PO','PI','PR') THEN
    IF NEW.line_kind <> 'ITEM' THEN
      RAISE EXCEPTION 'Voucher % (%): only ITEM lines allowed for purchase vouchers.', NEW.voucher_id, v_vt;
    END IF;

    IF NEW.item_id IS NULL THEN
      RAISE EXCEPTION 'Voucher % (%): item_id is required on purchase lines.', NEW.voucher_id, v_vt;
    END IF;

    PERFORM erp.assert_item_is_rm(NEW.item_id);

    IF NEW.qty <= 0 THEN
      RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for purchase lines.', NEW.voucher_id, v_vt;
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

-- ---------------------------------------------------------------------------
-- 10. PO-required enforcement at COMMIT (policy rules)
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES (high-level):
--   Some Purchase Invoices (PI) are NOT allowed unless they reference a Purchase Order (PO),
--   based on your policy rules table: erp.purchase_po_requirement_rule.
--
-- WHY THIS IS DONE IN DB (and why at COMMIT):
--   - The PI screen saves data in multiple steps inside ONE transaction:
--       1) voucher_header row
--       2) purchase_invoice_header_ext row (supplier, optional po_voucher_id)
--       3) many voucher_line rows (items, qty, rate, amount)
--   - The policy depends on TOTAL amount (SUM of voucher_line.amount) and which items/groups exist,
--     so we must check AFTER all lines are inserted/updated/deleted.
--   - Using a DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER means:
--       "Run the check at transaction end (COMMIT), not after each row insert."
--
-- WHEN IT RUNS:
--   A) Any time voucher_line changes (INSERT/UPDATE/DELETE) for any voucher:
--      -> the trigger calls enforce_po_requirement_for_purchase_invoice(voucher_id)
--      -> the function immediately RETURNS if that voucher_id is not a PI.
--   B) Any time the PI header extension changes (supplier or po_voucher_id changes):
--      -> the trigger calls enforce_po_requirement_for_purchase_invoice(voucher_id)
--   Both triggers are deferred, so they actually validate at COMMIT.
--
-- WHAT IT CHECKS:
--   1) Confirm voucher is PI (otherwise do nothing)
--   2) Read supplier + whether a PO is linked (po_voucher_id is not NULL)
--      - If header doesn’t exist yet inside the transaction, it SKIPS now;
--        it will be checked again at COMMIT once header exists, or when header trigger fires.
--   3) Compute PI total = SUM(voucher_line.amount) for that voucher
--   4) See if ANY active policy rule matches:
--        - min_amount (if set): total must be greater than min_amount
--        - supplier_party_id (if set): must match supplier
--        - rm_item_id (if set): invoice must contain that RM item
--        - rm_group_id (if set): invoice must contain an RM from that group
--   5) If a rule matches AND no PO is linked -> RAISE EXCEPTION
--      -> this aborts the COMMIT, so the PI cannot be saved without PO.
-- ---------------------------------------------------------------------------

-- Checks happen at COMMIT so your app can insert header + all lines first.
CREATE OR REPLACE FUNCTION erp.enforce_po_requirement_for_purchase_invoice(p_pi_voucher_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_supplier   bigint;
  v_total      numeric(18,2);
  v_has_po     boolean;
  v_policy_hit boolean;
BEGIN
  -- Only enforce for PI voucher type; for any other voucher_id, do nothing.
  IF NOT EXISTS (
    SELECT 1 FROM erp.voucher_header vh
    WHERE vh.id = p_pi_voucher_id AND vh.voucher_type_code = 'PI'
  ) THEN
    RETURN;
  END IF;

  -- Read supplier + whether PO is linked on the PI header extension.
  -- If header row isn't present yet in this transaction, skip for now.
  SELECT ph.supplier_party_id, (ph.po_voucher_id IS NOT NULL)
    INTO v_supplier, v_has_po
  FROM erp.purchase_invoice_header_ext ph
  WHERE ph.voucher_id = p_pi_voucher_id;

  IF v_supplier IS NULL THEN
    RETURN;
  END IF;

  -- Compute PI total from voucher lines (depends on all lines being inserted).
  SELECT COALESCE(SUM(vl.amount),0)::numeric(18,2)
    INTO v_total
  FROM erp.voucher_line vl
  WHERE vl.voucher_id = p_pi_voucher_id;

  -- Determine if ANY policy rule matches this invoice.
  -- If any match -> PO is required.
  SELECT EXISTS (
    SELECT 1
    FROM erp.purchase_po_requirement_rule r
    WHERE r.is_active = true

      -- Amount threshold rule (optional)
      AND (r.min_amount IS NULL OR v_total > r.min_amount)

      -- Supplier-specific rule (optional)
      AND (r.supplier_party_id IS NULL OR r.supplier_party_id = v_supplier)

      -- RM item presence rule (optional): invoice must contain that RM item
      AND (
        r.rm_item_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM erp.voucher_line vl
          WHERE vl.voucher_id = p_pi_voucher_id
            AND vl.item_id = r.rm_item_id
        )
      )

      -- RM group presence rule (optional): invoice must contain an item from that group
      AND (
        r.rm_group_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM erp.voucher_line vl
          JOIN erp.items it ON it.id = vl.item_id
          WHERE vl.voucher_id = p_pi_voucher_id
            AND it.group_id = r.rm_group_id
        )
      )
  ) INTO v_policy_hit;

  -- If policy applies but PI has no PO reference, block COMMIT.
  IF v_policy_hit AND NOT v_has_po THEN
    RAISE EXCEPTION
      'PO is required by purchase policy for PI voucher % (total=%) but po_voucher_id is NULL.',
      p_pi_voucher_id, v_total;
  END IF;
END;
$$;

-- Deferred check when PI lines change.
-- Note: trigger is on voucher_line (all vouchers), but function immediately returns
-- if the voucher is not a PI.
CREATE OR REPLACE FUNCTION erp.trg_pi_po_requirement_deferred_on_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT/UPDATE: validate the voucher that NEW line belongs to
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM erp.enforce_po_requirement_for_purchase_invoice(NEW.voucher_id);
    RETURN NEW;
  END IF;

  -- DELETE: validate the voucher that OLD line belonged to
  PERFORM erp.enforce_po_requirement_for_purchase_invoice(OLD.voucher_id);
  RETURN OLD;
END;
$$;

-- Constraint trigger:
-- - AFTER row change
-- - DEFERRABLE INITIALLY DEFERRED => runs at COMMIT
DROP TRIGGER IF EXISTS pi_po_requirement_chk ON erp.voucher_line;
CREATE CONSTRAINT TRIGGER pi_po_requirement_chk
AFTER INSERT OR UPDATE OR DELETE ON erp.voucher_line
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION erp.trg_pi_po_requirement_deferred_on_lines();

-- Deferred check when PI header changes (supplier or po_voucher_id changes).
-- Also runs at COMMIT (deferred), so order of inserts inside transaction doesn't matter.
CREATE OR REPLACE FUNCTION erp.trg_pi_po_requirement_deferred_on_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erp.enforce_po_requirement_for_purchase_invoice(NEW.voucher_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pi_po_requirement_hdr_chk ON erp.purchase_invoice_header_ext;
CREATE CONSTRAINT TRIGGER pi_po_requirement_hdr_chk
AFTER INSERT OR UPDATE ON erp.purchase_invoice_header_ext
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION erp.trg_pi_po_requirement_deferred_on_header();

-- HELPER FUNCTION - Ensure a voucher line that claims to reference an RM item is actually an RM item.
CREATE OR REPLACE FUNCTION erp.assert_item_is_rm(p_item_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_type erp.item_type;
BEGIN
  IF p_item_id IS NULL THEN
    RAISE EXCEPTION 'item_id cannot be NULL'
      USING ERRCODE = '23502'; -- not_null_violation
  END IF;

  SELECT i.item_type
    INTO v_type
  FROM erp.items i
  WHERE i.id = p_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid item_id=%. Item not found.', p_item_id
      USING ERRCODE = '23503'; -- foreign_key_violation (semantic match)
  END IF;

  IF v_type <> 'RM' THEN
    RAISE EXCEPTION 'Invalid item_id=%. Expected item_type=RM, got %.', p_item_id, v_type
      USING ERRCODE = '22000'; -- data_exception (generic)
  END IF;
END;
$$;
