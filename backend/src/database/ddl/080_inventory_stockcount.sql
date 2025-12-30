-- 12) INVENTORY: STN + Stock Count Adjustment (approval + reasons)

-- 12.1 STN outward/inward linkage (transit model)
CREATE TABLE IF NOT EXISTS stn_outward (
  voucher_id           bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  destination_branch_id bigint NOT NULL REFERENCES branches(id),
  dispatch_date        date NOT NULL DEFAULT CURRENT_DATE,
  gate_pass_no         text
);

CREATE TABLE IF NOT EXISTS stn_inward (
  voucher_id        bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  stn_out_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE RESTRICT,
  receive_date      date NOT NULL DEFAULT CURRENT_DATE
);

-- 12.2 Stock count adjustment (approval mandatory; shows selling rate but posts using cost)
CREATE TABLE IF NOT EXISTS stock_count_header (
  voucher_id      bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  item_type_scope erp.stock_bucket NOT NULL, -- RM/SFG/FG (use bucket)
  reason_code_id  bigint REFERENCES reason_codes(id),
  notes           text
);

CREATE TABLE IF NOT EXISTS stock_count_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES voucher_line(id) ON DELETE CASCADE,
  system_qty_snapshot numeric(18,3) NOT NULL, -- for RM or for display purposes
  system_qty_pairs_snapshot int NOT NULL DEFAULT 0, -- for FG/SFG
  physical_qty numeric(18,3) NOT NULL DEFAULT 0,
  physical_qty_pairs int NOT NULL DEFAULT 0,
  selling_rate_display numeric(18,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_stock_count_header_reason ON stock_count_header(reason_code_id);


-- 13) PRODUCTION (completion-based) + DCV/WIP pools + generated vouchers links

-- 13.1 WIP pool (per branch, SKU, department)
CREATE TABLE IF NOT EXISTS wip_dept_balance (
  branch_id          bigint NOT NULL REFERENCES branches(id),
  sku_id             bigint NOT NULL REFERENCES skus(id),
  dept_id            bigint NOT NULL REFERENCES departments(id),
  qty_pairs          int NOT NULL DEFAULT 0,
  cost_value         numeric(18,2) NOT NULL DEFAULT 0, -- hidden from worker roles (API permission)
  last_activity_date date,
  PRIMARY KEY (branch_id, sku_id, dept_id)
);

CREATE TABLE IF NOT EXISTS wip_dept_ledger (
  id               bigserial PRIMARY KEY,
  branch_id        bigint NOT NULL REFERENCES branches(id),
  sku_id           bigint NOT NULL REFERENCES skus(id),
  dept_id          bigint NOT NULL REFERENCES departments(id),
  txn_date         date NOT NULL,
  direction        smallint NOT NULL CHECK (direction IN (1, -1)),
  qty_pairs        int NOT NULL DEFAULT 0,
  cost_value       numeric(18,2) NOT NULL DEFAULT 0,
  source_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_wip_ledger_branch_date ON wip_dept_ledger(branch_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_wip_ledger_sku_dept ON wip_dept_ledger(branch_id, sku_id, dept_id, txn_date);

-- 13.2 Production voucher extension (Finished + Semi-finished)
CREATE TABLE IF NOT EXISTS production_header (
  voucher_id    bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  production_kind text NOT NULL, -- 'FG' or 'SFG'
  sku_id        bigint NOT NULL REFERENCES skus(id),
  stock_status  erp.stock_status NOT NULL,
  quantity      numeric(18,3) NOT NULL,
  total_pairs   int GENERATED ALWAYS AS (
    CASE WHEN stock_status='PACKED' THEN (quantity * 12)::int ELSE quantity::int END
  ) STORED,
  CHECK (
    (stock_status='PACKED' AND (quantity*2)=trunc(quantity*2) AND (quantity*12)=trunc(quantity*12))
    OR (stock_status='LOOSE' AND quantity=trunc(quantity))
  )
);

-- 13.3 DCV header extension (department completion voucher)
CREATE TABLE IF NOT EXISTS dcv_header (
  voucher_id bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  sku_id     bigint NOT NULL REFERENCES skus(id),
  dept_id    bigint NOT NULL REFERENCES departments(id),
  completed_qty_pairs int NOT NULL CHECK (completed_qty_pairs >= 0),
  labour_id  bigint REFERENCES labours(id),
  notes      text
);

-- 13.4 Links: production voucher -> auto-generated vouchers (consumption + labour)
CREATE TABLE IF NOT EXISTS production_generated_links (
  production_voucher_id bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  consumption_voucher_id bigint REFERENCES voucher_header(id) ON DELETE SET NULL,
  labour_voucher_id      bigint REFERENCES voucher_header(id) ON DELETE SET NULL
);

