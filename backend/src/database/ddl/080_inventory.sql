-- =====================================================================
-- 080_inventory.sql 
-- =====================================================================
-- PURPOSE
--   Adds:
--     1) Global reason codes (for voucher screens like stock count, loss, etc.)
--     2) Stock transfer workflow: STN_OUT dispatch -> GRN_IN receive (Against STN_OUT)
--     3) Stock count adjustment (approval-gated via voucher_header workflow)
--
-- BUILT ON TOP OF VOUCHER ENGINE
--   - voucher_header = document header (number, date, branch, status, maker/checker)
--   - voucher_line   = document lines (grid)
--
-- IMPORTANT NOTES
--   - Voucher type matching rules (e.g., STN_OUT / GRN_IN) are enforced later in
--   - For stock count lines:
--       * RM counts use voucher_line.line_kind='ITEM' + voucher_line.qty (decimal allowed)
--       * SFG/FG counts use voucher_line.line_kind='SKU'  + voucher_line.qty_pairs (integer pairs)
--     These rules are enforced later in integrity_checks.sql/backend.
-- =====================================================================

SET search_path = erp;

-- ---------------------------------------------------------------------
-- ENUMS (create only if missing)
-- ---------------------------------------------------------------------
DO $$ BEGIN
  -- Transfer workflow status (for "Pending Incoming Transfers" screen)
  CREATE TYPE erp.stock_transfer_status AS ENUM ('DISPATCHED','RECEIVED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- REASON CODES (global list + optional mapping to voucher types)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.reason_codes (
  id             bigserial PRIMARY KEY,
  code           text NOT NULL UNIQUE,        -- stable machine key: DAMAGE, WRONG_SIZE, etc.
  name           text NOT NULL,               -- UI label
  description    text,
  requires_notes boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (code = upper(trim(code)) AND code ~ '^[A-Z0-9_]{3,40}$')
);

-- Restrict a reason to specific voucher types (helps UI filtering; optional integrity layer)
CREATE TABLE IF NOT EXISTS erp.reason_code_voucher_type_map (
  reason_code_id    bigint NOT NULL REFERENCES erp.reason_codes(id) ON DELETE CASCADE,
  voucher_type_code text   NOT NULL REFERENCES erp.voucher_type(code) ON DELETE RESTRICT,
  PRIMARY KEY (reason_code_id, voucher_type_code)
);

CREATE INDEX IF NOT EXISTS idx_reason_code_vt_map_voucher_type
  ON erp.reason_code_voucher_type_map(voucher_type_code);

-- ---------------------------------------------------------------------
-- TRANSFERS: STN_OUT dispatch + GRN_IN receive (Against STN_OUT)
-- ---------------------------------------------------------------------
-- Virtual Transit model using stock_state:
--   STN_OUT posting:
--     Source branch (voucher_header.branch_id): ON_HAND OUT
--     Destination branch:                      IN_TRANSIT IN
--   GRN_IN posting (Against STN_OUT):
--     Destination branch:                      IN_TRANSIT OUT
--     Destination branch:                      ON_HAND IN
--
-- IMPORTANT:
--   - voucher_id must be voucher_type_code='STN_OUT' (enforced later in integrity_checks.sql)
--   - received_voucher_id must be voucher_type_code='GRN_IN' and branch must match dest_branch_id
--     (enforced later in integrity_checks.sql)
CREATE TABLE IF NOT EXISTS erp.stock_transfer_out_header (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE, -- STN_OUT voucher id
  dest_branch_id       bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  dispatch_date        date NOT NULL DEFAULT CURRENT_DATE,

  status               erp.stock_transfer_status NOT NULL DEFAULT 'DISPATCHED',

  -- When received: link to GRN_IN voucher (one receive per dispatch)
  received_voucher_id  bigint UNIQUE REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  received_at          timestamptz
);

-- Index for "pending incoming transfers" at destination
CREATE INDEX IF NOT EXISTS idx_stock_transfer_out_dest_status
  ON erp.stock_transfer_out_header(dest_branch_id, status);

-- GRN_IN header extension: “Receive Transfer Voucher Screen”
-- against_stn_out_id is UNIQUE => one GRN_IN per STN_OUT
-- IMPORTANT:
--   - voucher_id must be voucher_type_code='GRN_IN' (enforced later in integrity_checks.sql)
--   - against_stn_out_id must point to STN_OUT (enforced later)
--   - voucher_header.branch_id of GRN_IN must match dest_branch_id of STN_OUT (enforced later)
CREATE TABLE IF NOT EXISTS erp.grn_in_header (
  voucher_id         bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  against_stn_out_id bigint NOT NULL UNIQUE REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  received_date      date NOT NULL DEFAULT CURRENT_DATE,
  notes              text
);

CREATE INDEX IF NOT EXISTS idx_grn_in_against_stn
  ON erp.grn_in_header(against_stn_out_id);

-- ---------------------------------------------------------------------
-- STOCK COUNT ADJUSTMENT (Approval-gated via voucher_header workflow)
-- ---------------------------------------------------------------------
-- Requirement:
--   - Workers enter physical quantities + selling_rate_display
--   - System captures system_qty_snapshot (RM) OR system_qty_pairs_snapshot (SFG/FG)
--   - NO ledger impact until voucher is approved
--
-- IMPORTANT:
--   - This table stores only extra fields for the stock count screen.
--   - Approval status should come from voucher_header.status (single source of truth).
CREATE TABLE IF NOT EXISTS erp.stock_count_header (
  voucher_id        bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,

  item_type_scope   erp.stock_category NOT NULL,       -- RM/SFG/FG
  reason_code_id    bigint REFERENCES erp.reason_codes(id) ON DELETE RESTRICT,
  notes             text
);

-- Line extension:
--   - RM: use system_qty_snapshot + physical_qty (decimal)
--   - SFG/FG: use system_qty_pairs_snapshot + physical_qty_pairs (integer pairs)
-- Enforced later: voucher_line.kind + correct column usage.
CREATE TABLE IF NOT EXISTS erp.stock_count_line (
  voucher_line_id           bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,

  -- System snapshot at time of count (RM-only)
  system_qty_snapshot       numeric(18,3) NOT NULL DEFAULT 0 CHECK (system_qty_snapshot >= 0),
  -- Physical counted qty (RM-only)
  physical_qty              numeric(18,3) NOT NULL DEFAULT 0 CHECK (physical_qty >= 0),

  -- System snapshot at time of count (SFG/FG only; integer pairs)
  system_qty_pairs_snapshot int NOT NULL DEFAULT 0 CHECK (system_qty_pairs_snapshot >= 0),
  -- Physical counted qty (SFG/FG only; integer pairs)
  physical_qty_pairs        int NOT NULL DEFAULT 0 CHECK (physical_qty_pairs >= 0),

  -- Selling rate shown on screen (display only; posting uses cost/WAC, not this)
  selling_rate_display      numeric(18,2) NOT NULL DEFAULT 0 CHECK (selling_rate_display >= 0)

  -- NOTE:
  --   Which columns are valid depends on voucher_line.line_kind and item_type_scope:
  --     RM   => line_kind='ITEM' => use system_qty_snapshot/physical_qty
  --     SFG/FG=> line_kind='SKU'  => use system_qty_pairs_snapshot/physical_qty_pairs
  --   Enforced later in integrity_checks.sql/backend.
);
