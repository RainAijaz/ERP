-- =====================================================================
-- 080_inventory_transfers_stockcount.sql  (MODULE PATCH)
-- =====================================================================

SET search_path = erp;

-- ---------------------------------------------------------------------
-- 0) ENUMS (create only if missing)
-- ---------------------------------------------------------------------
-- Transfer workflow status (for Pending Incoming Transfers screen)
DO $$ BEGIN
  CREATE TYPE erp.stock_transfer_status AS ENUM ('DISPATCHED','RECEIVED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =====================================================================
-- 1) REASON CODES (global list + mapping to voucher types)
-- =====================================================================

CREATE TABLE IF NOT EXISTS erp.reason_codes (
  id             bigserial PRIMARY KEY,
  code           text NOT NULL UNIQUE,        -- stable machine key: 'DAMAGE', 'WRONG_SIZE', etc.
  name           text NOT NULL,               -- UI label
  description    text,
  requires_notes boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- restrict a reason to specific voucher types
-- Assumption: erp.voucher_type(code) exists and code is UNIQUE/PK.
CREATE TABLE IF NOT EXISTS erp.reason_code_voucher_type_map (
  reason_code_id    bigint NOT NULL REFERENCES erp.reason_codes(id) ON DELETE CASCADE,
  voucher_type_code text   NOT NULL REFERENCES erp.voucher_type(code) ON DELETE RESTRICT,
  PRIMARY KEY (reason_code_id, voucher_type_code)
);

-- =====================================================================
-- 2) TRANSFERS: STN_OUT dispatch + GRN_IN receive (Against STN_OUT)
-- This is your “Virtual Transit Location” model.
--
-- Posting behavior (voucher posting engine):
--   STN_OUT:
--     Source branch: ON_HAND OUT
--     Destination branch: IN_TRANSIT IN
--     Accounting: NONE (stn_gl_mode = NONE)
--
--   GRN_IN (Against STN_OUT):
--     Destination branch: IN_TRANSIT OUT
--     Destination branch: ON_HAND IN
-- =====================================================================

-- Transfer workflow table (single source of truth)
CREATE TABLE IF NOT EXISTS erp.stock_transfer_out_header (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE, -- STN_OUT voucher id
  source_branch_id     bigint NOT NULL REFERENCES erp.branches(id),
  dest_branch_id       bigint NOT NULL REFERENCES erp.branches(id),
  dispatch_date        date NOT NULL DEFAULT CURRENT_DATE,

  status               erp.stock_transfer_status NOT NULL DEFAULT 'DISPATCHED',

  -- When received: link to GRN_IN voucher at destination
  received_voucher_id  bigint UNIQUE REFERENCES erp.voucher_header(id),
  received_at          timestamptz,

  CHECK (source_branch_id <> dest_branch_id)
);


-- 4.2 GRN_IN header extension: “Receive Transfer Voucher Screen”
-- The screen key requirement: Against STN_OUT (dropdown/search)
CREATE TABLE IF NOT EXISTS erp.grn_in_header (
  voucher_id         bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  against_stn_out_id bigint NOT NULL UNIQUE REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  received_date      date NOT NULL DEFAULT CURRENT_DATE,
  notes              text
);

-- =====================================================================
-- 5) STOCK COUNT ADJUSTMENT (Approval-gated)
-- Requirement:
--   - Workers enter physical quantities + selling_rate_display
--   - System captures snapshots (system_qty_snapshot/system_qty_pairs_snapshot)
--   - NO stock/ledger impact until ADMIN approves AND voucher is posted
--   - On approval/post: voucher locked, ledger + GL auto-posted (posting engine)
-- =====================================================================

CREATE TABLE IF NOT EXISTS erp.stock_count_header (
  voucher_id        bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,

  item_type_scope   erp.stock_category NOT NULL,       -- RM/SFG/FG
  reason_code_id    bigint REFERENCES erp.reason_codes(id) ON DELETE RESTRICT,
  notes             text,

  -- Approval gating (kept here so you don't depend on voucher_header structure)
  approval_status   erp.approval_status NOT NULL DEFAULT 'PENDING',
  submitted_at      timestamptz,
  approved_by       bigint REFERENCES erp.users(id),
  approved_at       timestamptz,
  rejected_by       bigint REFERENCES erp.users(id),
  rejected_at       timestamptz
);

CREATE TABLE IF NOT EXISTS erp.stock_count_line (
  voucher_line_id               bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,

  -- System snapshots at the time of count (for audit/approval)
  system_qty_snapshot           numeric(18,3) NOT NULL DEFAULT 0,
  -- Physical counted quantities
  physical_qty                  numeric(18,3) NOT NULL DEFAULT 0,
  -- Selling rate shown on screen (display only, not used for posting cost)
  selling_rate_display          numeric(18,2) NOT NULL DEFAULT 0
);

