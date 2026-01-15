SET search_path = erp;

-- =============================================================================
-- 040_GL_STOCK.sql
-- =============================================================================
-- Goal:
--   These tables are the “final books” of the ERP:
--   1) GL (General Ledger) = accounting postings
--   2) Stock ledger        = inventory movements at cost (WAC), never sale rate
--
-- Design:
--   - Each voucher that affects GL creates ONE gl_batch
--   - That gl_batch contains multiple gl_entry rows (debit/credit lines)
--   - Each voucher that affects stock writes stock_ledger rows (per line/item)
--   - stock_balance_* are fast running totals for performance
--   - stock_snapshot_* are saved closing balances for reporting/audit
-- =============================================================================

-- =============================================================================
-- GL posting
-- =============================================================================

-- One GL batch per source voucher (prevents double-posting).
CREATE TABLE IF NOT EXISTS erp.gl_batch (
  id                bigserial PRIMARY KEY,
  source_voucher_id bigint NOT NULL UNIQUE
                    REFERENCES erp.voucher_header(id)
                    ON DELETE CASCADE
);

-- Each row is ONE debit OR ONE credit line inside a batch (one-sided posting).
CREATE TABLE IF NOT EXISTS erp.gl_entry (
  id         bigserial PRIMARY KEY,
  batch_id   bigint NOT NULL REFERENCES erp.gl_batch(id) ON DELETE CASCADE,
  branch_id  bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  entry_date date NOT NULL, -- usually voucher_date (or posting date)
  account_id bigint NOT NULL REFERENCES erp.accounts(id) ON DELETE RESTRICT,
  dept_id    bigint REFERENCES erp.departments(id) ON DELETE RESTRICT,
  party_id   bigint REFERENCES erp.parties(id) ON DELETE RESTRICT,

  dr         numeric(18,2) NOT NULL DEFAULT 0,
  cr         numeric(18,2) NOT NULL DEFAULT 0,
  narration  text,

  -- Basic numeric safety:
  CHECK (dr >= 0 AND cr >= 0),

  -- One-sided rule:
  CHECK ((dr = 0 AND cr > 0) OR (cr = 0 AND dr > 0))
);

-- Join/performance helpers (FKs are not auto-indexed in Postgres).
CREATE INDEX IF NOT EXISTS idx_gl_entry_batch_id
  ON erp.gl_entry(batch_id);

CREATE INDEX IF NOT EXISTS idx_gl_entry_account_date
  ON erp.gl_entry(account_id, entry_date);

CREATE INDEX IF NOT EXISTS idx_gl_entry_branch_date
  ON erp.gl_entry(branch_id, entry_date);

-- =============================================================================
-- Stock ledger (WAC stored; never selling rate)
-- =============================================================================
-- stock_ledger = audit trail of every stock movement (IN/OUT)
-- category tells WHAT it is (RM vs SFG vs FG)
--   RM      => tracked at item level  (item_id filled, sku_id NULL)
--   SFG/FG  => tracked at SKU level   (sku_id filled, item_id NULL)
-- direction:
--   +1 = IN, -1 = OUT
CREATE TABLE IF NOT EXISTS erp.stock_ledger (
  id               bigserial PRIMARY KEY,
  branch_id        bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  category         erp.stock_category NOT NULL,                 -- RM / SFG / FG
  stock_state      erp.stock_state NOT NULL DEFAULT 'ON_HAND',  -- ON_HAND / IN_TRANSIT

  item_id          bigint REFERENCES erp.items(id) ON DELETE RESTRICT, -- ONLY for RM
  sku_id           bigint REFERENCES erp.skus(id)  ON DELETE RESTRICT, -- ONLY for SFG/FG

  voucher_header_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  voucher_line_id   bigint REFERENCES erp.voucher_line(id) ON DELETE SET NULL,

  txn_date         date NOT NULL,
  direction        smallint NOT NULL CHECK (direction IN (1, -1)), -- +1 in, -1 out

  qty              numeric(18,3) NOT NULL DEFAULT 0,  -- RM qty (or optional for SKU if you ever store both)
  qty_pairs        int NOT NULL DEFAULT 0,            -- pair-based quantity for SFG/FG

  unit_cost        numeric(18,6) NOT NULL DEFAULT 0,  -- WAC unit cost
  value            numeric(18,2) NOT NULL DEFAULT 0,  -- signed value (direction * qty * unit_cost)

  -- Basic numeric safety:
  CHECK (qty >= 0),
  CHECK (qty_pairs >= 0),
  CHECK (unit_cost >= 0),

  -- Enforce correct key usage by category:
  CHECK (
    (category = 'RM' AND item_id IS NOT NULL AND sku_id IS NULL)
    OR
    (category IN ('SFG','FG') AND sku_id IS NOT NULL AND item_id IS NULL)
  )
);

-- Common filters: branch/date and voucher drill-down.
CREATE INDEX IF NOT EXISTS idx_stock_ledger_branch_date
  ON erp.stock_ledger(branch_id, txn_date);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_voucher
  ON erp.stock_ledger(voucher_header_id);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_sku_date
  ON erp.stock_ledger(sku_id, txn_date);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_item_date
  ON erp.stock_ledger(item_id, txn_date);

-- =============================================================================
-- Fast balances (running totals)
-- =============================================================================

-- RM running balance (item-level), split by stock_state.
CREATE TABLE IF NOT EXISTS erp.stock_balance_rm (
  branch_id   bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  stock_state erp.stock_state NOT NULL DEFAULT 'ON_HAND',
  item_id     bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,

  qty         numeric(18,3) NOT NULL DEFAULT 0,
  wac         numeric(18,6) NOT NULL DEFAULT 0,
  value       numeric(18,2) NOT NULL DEFAULT 0,
  last_txn_at timestamptz,

  CHECK (qty >= 0),
  CHECK (wac >= 0),
  CHECK (value >= 0),

  PRIMARY KEY (branch_id, stock_state, item_id)
);

-- SKU running balance (SFG/FG), split by stock_state.
-- is_packed is an entry/measurement mode flag:
--   false = LOOSE (pairs/integer entry)
--   true  = PACKED (dozen/step entry)
-- If you keep this column, it MUST be part of the identity to avoid collisions.
CREATE TABLE IF NOT EXISTS erp.stock_balance_sku (
  branch_id   bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  stock_state erp.stock_state NOT NULL DEFAULT 'ON_HAND',
  category    erp.stock_category NOT NULL CHECK (category IN ('SFG','FG')),

  is_packed   boolean NOT NULL DEFAULT true, -- false=LOOSE, true=PACKED

  sku_id      bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,

  qty_pairs   int NOT NULL DEFAULT 0,
  wac         numeric(18,6) NOT NULL DEFAULT 0,
  value       numeric(18,2) NOT NULL DEFAULT 0,
  last_txn_at timestamptz,

  CHECK (qty_pairs >= 0),
  CHECK (wac >= 0),
  CHECK (value >= 0),

  PRIMARY KEY (branch_id, stock_state, category, is_packed, sku_id)
);

-- =============================================================================
-- Month-end snapshots (audit + period close)
-- =============================================================================
-- Snapshot = saved closing balance at month-end so historical reporting doesn't need recomputation.
-- snapshot_yyyymm format: YYYYMM (e.g., 202512).
CREATE TABLE IF NOT EXISTS erp.stock_snapshot_month_end_rm (
  branch_id       bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  snapshot_yyyymm int NOT NULL,
  stock_state     erp.stock_state NOT NULL,
  item_id         bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,

  closing_qty     numeric(18,3) NOT NULL,
  closing_value   numeric(18,2) NOT NULL,
  closing_wac     numeric(18,6) NOT NULL,

  CHECK (snapshot_yyyymm % 100 BETWEEN 1 AND 12),

  PRIMARY KEY (branch_id, snapshot_yyyymm, stock_state, item_id)
);

CREATE TABLE IF NOT EXISTS erp.stock_snapshot_month_end_sku (
  branch_id         bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  snapshot_yyyymm   int NOT NULL,
  stock_state       erp.stock_state NOT NULL,
  category          erp.stock_category NOT NULL CHECK (category IN ('SFG','FG')),
  sku_id            bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,

  closing_qty_pairs int NOT NULL,
  closing_value     numeric(18,2) NOT NULL,
  closing_wac       numeric(18,6) NOT NULL,

  CHECK (snapshot_yyyymm % 100 BETWEEN 1 AND 12),

  PRIMARY KEY (branch_id, snapshot_yyyymm, stock_state, category, sku_id)
);

-- =============================================================================
-- Optional daily snapshots (fast dashboards; keep last N days via cleanup job)
-- =============================================================================

CREATE TABLE IF NOT EXISTS erp.stock_snapshot_daily_rm (
  branch_id     bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  snapshot_date date NOT NULL,
  stock_state   erp.stock_state NOT NULL,
  item_id       bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,

  qty           numeric(18,3) NOT NULL,
  value         numeric(18,2) NOT NULL,
  wac           numeric(18,6) NOT NULL,

  PRIMARY KEY (branch_id, snapshot_date, stock_state, item_id)
);

CREATE TABLE IF NOT EXISTS erp.stock_snapshot_daily_sku (
  branch_id     bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  snapshot_date date NOT NULL,
  stock_state   erp.stock_state NOT NULL,
  category      erp.stock_category NOT NULL CHECK (category IN ('SFG','FG')),
  sku_id        bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,

  qty_pairs     int NOT NULL,
  value         numeric(18,2) NOT NULL,
  wac           numeric(18,6) NOT NULL,

  PRIMARY KEY (branch_id, snapshot_date, stock_state, category, sku_id)
);
