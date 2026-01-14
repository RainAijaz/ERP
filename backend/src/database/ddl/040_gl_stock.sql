SET search_path = erp;

-- =============================================================================
-- 5) SYSTEM LEDGERS: GL + STOCK
-- =============================================================================
-- Goal:
--   These tables are the “final books” of the ERP:
--   1) GL (General Ledger) = accounting postings
--   2) Stock ledger        = inventory movements at cost (WAC), never sale rate
--
-- Design idea:
--   - Each voucher that affects GL creates ONE gl_batch
--   - That gl_batch contains multiple gl_entry rows (debit/credit lines)
--   - Each voucher that affects stock writes stock_ledger rows (per line/item)
--   - stock_balance_* are fast running totals for performance
--   - stock_snapshot_* are saved closing balances for reporting/audit
-- =============================================================================

-- =============================================================================
-- 5.1 GL posting
-- =============================================================================

-- One GL batch per source voucher (one voucher -> one posting batch).
-- source_voucher_id is UNIQUE to prevent double-posting the same voucher.
CREATE TABLE IF NOT EXISTS gl_batch (
  id                bigserial PRIMARY KEY,  -- internal batch id
  source_voucher_id bigint NOT NULL UNIQUE REFERENCES voucher_header(id) ON DELETE CASCADE -- which voucher created this batch
);

-- Each row is ONE debit OR ONE credit line inside a batch.
-- Rule: a line must be one-sided (dr>0 xor cr>0).
CREATE TABLE IF NOT EXISTS gl_entry (
  id         bigserial PRIMARY KEY,
  batch_id   bigint NOT NULL REFERENCES gl_batch(id) ON DELETE CASCADE, -- which batch this entry belongs to
  branch_id  bigint NOT NULL REFERENCES branches(id), -- branch accounting
  entry_date date NOT NULL,                           -- posting date (usually voucher_date)
  account_id bigint NOT NULL REFERENCES accounts(id),  -- GL account
  dept_id    bigint REFERENCES departments(id),        -- optional: dept tagging for expense reports
  party_id   bigint REFERENCES parties(id),            -- optional: customer/supplier tagging
  dr         numeric(18,2) NOT NULL DEFAULT 0,         -- debit amount (0 if credit line)
  cr         numeric(18,2) NOT NULL DEFAULT 0,         -- credit amount (0 if debit line)
  narration  text,                                    -- optional description
  CHECK ((dr = 0 AND cr > 0) OR (cr = 0 AND dr > 0))   -- enforce one-sided line
);

-- =============================================================================
--  Stock ledger (WAC stored; never selling rate)
-- =============================================================================
-- stock_ledger = audit trail of every stock movement (IN/OUT)
-- category tells WHAT it is (RM vs SFG vs FG)
--   RM      => tracked at item level  (item_id filled, sku_id NULL)
--   SFG/FG  => tracked at SKU level   (sku_id filled)

CREATE TABLE IF NOT EXISTS erp.stock_ledger (
  id              bigserial PRIMARY KEY,
  branch_id       bigint NOT NULL REFERENCES erp.branches(id), -- owner branch (source for OUT / destination for IN)
  category        erp.stock_category NOT NULL,                 -- RM / SFG / FG
  stock_state     erp.stock_state NOT NULL DEFAULT 'ON_HAND',  -- ON_HAND / IN_TRANSIT
  item_id         bigint REFERENCES erp.items(id),             -- ONLY for RM
  sku_id          bigint REFERENCES erp.skus(id),              -- ONLY for SFG/FG

  voucher_header_id      bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  voucher_line_id bigint REFERENCES erp.voucher_line(id) ON DELETE SET NULL,
  txn_date        date NOT NULL,
  direction       smallint NOT NULL CHECK (direction IN (1, -1)), -- +1 in, -1 out
  qty             numeric(18,3) NOT NULL DEFAULT 0,    
  qty_pairs   int NOT NULL DEFAULT 0,        
  unit_cost       numeric(18,6) NOT NULL DEFAULT 0,            -- WAC unit cost
  value           numeric(18,2) NOT NULL DEFAULT 0,            -- signed value (direction * qty * unit_cost)
  -- Enforce correct key usage by category:
  CHECK (
    (category = 'RM'  AND item_id IS NOT NULL AND sku_id IS NULL)
    OR
    (category IN ('SFG','FG') AND sku_id IS NOT NULL AND item_id IS NULL)
  )
);

-- =============================================================================
-- Fast balances (running totals)
-- =============================================================================

-- RM balance (item-level) split by state (ON_HAND vs IN_TRANSIT)
CREATE TABLE IF NOT EXISTS erp.stock_balance_rm (
  branch_id   bigint NOT NULL REFERENCES erp.branches(id),
  stock_state erp.stock_state NOT NULL DEFAULT 'ON_HAND',
  item_id     bigint NOT NULL REFERENCES erp.items(id),
  qty         numeric(18,3) NOT NULL DEFAULT 0,
  wac         numeric(18,6) NOT NULL DEFAULT 0,
  value       numeric(18,2) NOT NULL DEFAULT 0,
  last_txn_at timestamptz,
  PRIMARY KEY (branch_id, stock_state, item_id)
);

-- SKU balance (SFG/FG) split by state (ON_HAND vs IN_TRANSIT)
CREATE TABLE IF NOT EXISTS erp.stock_balance_sku (
  branch_id   bigint NOT NULL REFERENCES erp.branches(id),
  stock_state erp.stock_state NOT NULL DEFAULT 'ON_HAND',
  category    erp.stock_category NOT NULL CHECK (category IN ('SFG','FG')),
  status      erp.stock_type NOT NULL DEFAULT LOOSE ,
  sku_id      bigint NOT NULL REFERENCES erp.skus(id),
  qty_pairs   int NOT NULL DEFAULT 0,
  wac         numeric(18,6) NOT NULL DEFAULT 0,
  value       numeric(18,2) NOT NULL DEFAULT 0,
  last_txn_at timestamptz,
  PRIMARY KEY (branch_id, stock_state, category, sku_id)
);

-- =============================================================================
-- Month-end snapshots (required for audit + period close)
-- =============================================================================
-- Snapshot = saved closing balance at month-end, so reports don't need to recompute old months
-- and you can audit "what was stock at close of Dec 2025" even after new transactions happen.

CREATE TABLE IF NOT EXISTS erp.stock_snapshot_month_end_rm (
  branch_id       bigint NOT NULL REFERENCES erp.branches(id),
  snapshot_yyyymm int NOT NULL, -- YYYYMM (e.g., 202512)
  stock_state     erp.stock_state NOT NULL,
  item_id         bigint NOT NULL REFERENCES erp.items(id),
  closing_qty     numeric(18,3) NOT NULL,
  closing_value   numeric(18,2) NOT NULL,
  closing_wac     numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_yyyymm, stock_state, item_id)
);

CREATE TABLE IF NOT EXISTS erp.stock_snapshot_month_end_sku (
  branch_id         bigint NOT NULL REFERENCES erp.branches(id),
  snapshot_yyyymm   int NOT NULL,
  stock_state       erp.stock_state NOT NULL,
  category          erp.stock_category NOT NULL CHECK (category IN ('SFG','FG')),
  sku_id            bigint NOT NULL REFERENCES erp.skus(id),
  closing_qty_pairs int NOT NULL,
  closing_value     numeric(18,2) NOT NULL,
  closing_wac       numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_yyyymm, stock_state, category, sku_id)
);

-- =============================================================================
-- Optional daily snapshots (for fast dashboards; keep last N days via cleanup job)
-- =============================================================================

CREATE TABLE IF NOT EXISTS erp.stock_snapshot_daily_rm (
  branch_id     bigint NOT NULL REFERENCES erp.branches(id),
  snapshot_date date NOT NULL,
  stock_state   erp.stock_state NOT NULL,
  item_id       bigint NOT NULL REFERENCES erp.items(id),
  qty           numeric(18,3) NOT NULL,
  value         numeric(18,2) NOT NULL,
  wac           numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_date, stock_state, item_id)
);

CREATE TABLE IF NOT EXISTS erp.stock_snapshot_daily_sku (
  branch_id     bigint NOT NULL REFERENCES erp.branches(id),
  snapshot_date date NOT NULL,
  stock_state   erp.stock_state NOT NULL,
  category      erp.stock_category NOT NULL CHECK (category IN ('SFG','FG')),
  sku_id        bigint NOT NULL REFERENCES erp.skus(id),
  qty_pairs     int NOT NULL,
  value         numeric(18,2) NOT NULL,
  wac           numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_date, stock_state, category, sku_id)
);
