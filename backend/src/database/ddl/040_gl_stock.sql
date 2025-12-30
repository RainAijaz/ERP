-- 5) SYSTEM LEDGERS: GL + STOCK

-- 5.1 GL posting
CREATE TABLE IF NOT EXISTS gl_batch (
  id                bigserial PRIMARY KEY,
  source_voucher_id bigint NOT NULL UNIQUE REFERENCES voucher_header(id) ON DELETE CASCADE,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  posted_by         bigint NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS gl_entry (
  id         bigserial PRIMARY KEY,
  batch_id   bigint NOT NULL REFERENCES gl_batch(id) ON DELETE CASCADE,
  branch_id  bigint NOT NULL REFERENCES branches(id),
  entry_date date NOT NULL,
  account_id bigint NOT NULL REFERENCES accounts(id),
  dept_id    bigint REFERENCES departments(id),
  party_id   bigint REFERENCES parties(id),
  dr         numeric(18,2) NOT NULL DEFAULT 0,
  cr         numeric(18,2) NOT NULL DEFAULT 0,
  narration  text,
  CHECK ((dr = 0 AND cr > 0) OR (cr = 0 AND dr > 0))
);

CREATE INDEX IF NOT EXISTS ix_gl_entry_branch_date ON gl_entry(branch_id, entry_date);
CREATE INDEX IF NOT EXISTS ix_gl_entry_account_date ON gl_entry(account_id, entry_date);

-- 5.2 Stock ledger (WAC stored; never selling rate)
CREATE TABLE IF NOT EXISTS stock_ledger (
  id              bigserial PRIMARY KEY,
  branch_id       bigint NOT NULL REFERENCES branches(id),
  bucket          erp.stock_bucket NOT NULL,
  item_id         bigint REFERENCES items(id), -- RM
  sku_id          bigint REFERENCES skus(id),  -- SFG/FG/TRANSIT
  voucher_id      bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  voucher_line_id bigint REFERENCES voucher_line(id) ON DELETE SET NULL,
  txn_date        date NOT NULL,
  direction       smallint NOT NULL CHECK (direction IN (1, -1)),
  qty             numeric(18,3) NOT NULL DEFAULT 0,  -- RM
  qty_pairs       int NOT NULL DEFAULT 0,            -- FG/SFG integer pairs
  unit_cost       numeric(18,6) NOT NULL DEFAULT 0,  -- WAC used
  value           numeric(18,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (bucket = 'RM' AND item_id IS NOT NULL AND sku_id IS NULL)
    OR (bucket IN ('SFG','FG','TRANSIT') AND sku_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_stock_ledger_branch_date ON stock_ledger(branch_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_stock_ledger_sku ON stock_ledger(branch_id, bucket, sku_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_stock_ledger_item ON stock_ledger(branch_id, bucket, item_id, txn_date);

-- Fast balances (split to avoid NULL-in-PK issues)
CREATE TABLE IF NOT EXISTS stock_balance_rm (
  branch_id   bigint NOT NULL REFERENCES branches(id),
  item_id     bigint NOT NULL REFERENCES items(id),
  qty         numeric(18,3) NOT NULL DEFAULT 0,
  value       numeric(18,2) NOT NULL DEFAULT 0,
  wac         numeric(18,6) NOT NULL DEFAULT 0,
  last_txn_at timestamptz,
  PRIMARY KEY (branch_id, item_id)
);

CREATE TABLE IF NOT EXISTS stock_balance_sku (
  branch_id   bigint NOT NULL REFERENCES branches(id),
  bucket      erp.stock_bucket NOT NULL CHECK (bucket IN ('SFG','FG','TRANSIT')),
  sku_id      bigint NOT NULL REFERENCES skus(id),
  qty_pairs   int NOT NULL DEFAULT 0,
  value       numeric(18,2) NOT NULL DEFAULT 0,
  wac         numeric(18,6) NOT NULL DEFAULT 0,
  last_txn_at timestamptz,
  PRIMARY KEY (branch_id, bucket, sku_id)
);

-- Month-end snapshots (required)
CREATE TABLE IF NOT EXISTS stock_snapshot_month_end_rm (
  branch_id    bigint NOT NULL REFERENCES branches(id),
  snapshot_yyyymm int NOT NULL, -- e.g. 202512
  item_id      bigint NOT NULL REFERENCES items(id),
  closing_qty  numeric(18,3) NOT NULL,
  closing_value numeric(18,2) NOT NULL,
  closing_wac  numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_yyyymm, item_id)
);

CREATE TABLE IF NOT EXISTS stock_snapshot_month_end_sku (
  branch_id    bigint NOT NULL REFERENCES branches(id),
  snapshot_yyyymm int NOT NULL,
  bucket       erp.stock_bucket NOT NULL CHECK (bucket IN ('SFG','FG','TRANSIT')),
  sku_id       bigint NOT NULL REFERENCES skus(id),
  closing_qty_pairs int NOT NULL,
  closing_value numeric(18,2) NOT NULL,
  closing_wac  numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_yyyymm, bucket, sku_id)
);

-- Optional daily snapshots (keep last 30 days at app level via cleanup job)
CREATE TABLE IF NOT EXISTS stock_snapshot_daily_rm (
  branch_id    bigint NOT NULL REFERENCES branches(id),
  snapshot_date date NOT NULL,
  item_id      bigint NOT NULL REFERENCES items(id),
  qty          numeric(18,3) NOT NULL,
  value        numeric(18,2) NOT NULL,
  wac          numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_date, item_id)
);

CREATE TABLE IF NOT EXISTS stock_snapshot_daily_sku (
  branch_id    bigint NOT NULL REFERENCES branches(id),
  snapshot_date date NOT NULL,
  bucket       erp.stock_bucket NOT NULL CHECK (bucket IN ('SFG','FG','TRANSIT')),
  sku_id       bigint NOT NULL REFERENCES skus(id),
  qty_pairs    int NOT NULL,
  value        numeric(18,2) NOT NULL,
  wac          numeric(18,6) NOT NULL,
  PRIMARY KEY (branch_id, snapshot_date, bucket, sku_id)
);

