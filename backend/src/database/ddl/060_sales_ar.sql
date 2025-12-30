-- 7) HR: employees + allowances + payroll type support

CREATE TABLE IF NOT EXISTS employees (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  cnic        text,
  phone       text,
  dept_id     bigint REFERENCES departments(id),
  designation text,
  payroll_type text NOT NULL DEFAULT 'MONTHLY', -- MONTHLY/DAILY/PIECE/MULTIPLE
  basic_salary numeric(18,2) NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'Active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE voucher_line
    ADD CONSTRAINT fk_voucher_line_employee
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Employee allowances (per row)
CREATE TABLE IF NOT EXISTS employee_allowance (
  id           bigserial PRIMARY KEY,
  employee_id  bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  allowance_type text NOT NULL, -- House/Mobile/Food/Attendance/etc
  amount_type  text NOT NULL,   -- FIXED / PCT_BASIC
  amount_value numeric(18,2) NOT NULL,
  frequency    text NOT NULL DEFAULT 'MONTHLY', -- MONTHLY/DAILY
  taxable      boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE(employee_id, allowance_type, frequency)
);


-- 8) COMMISSION RULES (salesman-wise; specificity priority SKU > SUBGROUP > GROUP > FLAT)

CREATE TABLE IF NOT EXISTS commission_rule_header (
  id             bigserial PRIMARY KEY,
  salesman_user_id bigint REFERENCES users(id), -- NULL = All salesmen
  status         erp.voucher_status NOT NULL DEFAULT 'DRAFT',
  created_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    bigint REFERENCES users(id),
  approved_at    timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE IF NOT EXISTS commission_rule_line (
  id           bigserial PRIMARY KEY,
  header_id    bigint NOT NULL REFERENCES commission_rule_header(id) ON DELETE CASCADE,
  apply_on     text NOT NULL, -- SKU/SUBGROUP/GROUP/FLAT
  sku_id       bigint REFERENCES skus(id),
  subgroup_id  bigint REFERENCES product_subgroups(id),
  group_id     bigint REFERENCES product_groups(id),
  basis        text NOT NULL, -- PCT_NET_SALES / PCT_GROSS_MARGIN / FIXED_PER_UNIT / FIXED_PER_INVOICE
  value_type   text NOT NULL, -- PCT / FIXED
  value        numeric(18,4) NOT NULL,
  reverse_on_returns boolean NOT NULL DEFAULT true,
  CHECK (
    (apply_on='SKU' AND sku_id IS NOT NULL AND subgroup_id IS NULL AND group_id IS NULL)
    OR (apply_on='SUBGROUP' AND subgroup_id IS NOT NULL AND sku_id IS NULL AND group_id IS NULL)
    OR (apply_on='GROUP' AND group_id IS NOT NULL AND sku_id IS NULL AND subgroup_id IS NULL)
    OR (apply_on='FLAT' AND sku_id IS NULL AND subgroup_id IS NULL AND group_id IS NULL)
  )
);

-- 9) SALES (SO, SV) + AR allocations (FIFO + skip disputed)

-- 9.1 Sales Order header extension
CREATE TABLE IF NOT EXISTS sales_order_header (
  voucher_id        bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  customer_party_id bigint REFERENCES parties(id), -- for credit/delivery orders
  customer_name_cash text,   -- for cash walk-in order (optional)
  customer_phone_cash text,  -- for cash walk-in order (optional)
  salesman_user_id  bigint REFERENCES users(id),
  notes             text
);

-- 9.2 Sales Voucher header extension
CREATE TABLE IF NOT EXISTS sales_header (
  voucher_id          bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  sale_mode           erp.sale_mode NOT NULL DEFAULT 'DIRECT',
  payment_type        erp.payment_type NOT NULL DEFAULT 'CASH',
  customer_party_id   bigint REFERENCES parties(id), -- mandatory for credit/delivery
  customer_name_cash  text, -- for cash sale without party
  customer_phone_cash text, -- mandatory if cash sale without party (enforce in app)
  salesman_user_id    bigint REFERENCES users(id),
  due_date            date, -- required if credit
  receive_into_account_id bigint REFERENCES accounts(id), -- cash/bank account if payment received
  delivery_method     text, -- customer pickup / our delivery
  linked_sales_order_id bigint REFERENCES voucher_header(id),
  payment_received_amount numeric(18,2) NOT NULL DEFAULT 0
);

-- 9.3 Sales line extension (enforces mutual exclusivity sale vs return + return reason)
CREATE TABLE IF NOT EXISTS return_reasons (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  description text NOT NULL,
  affects_stock boolean NOT NULL DEFAULT true, -- DEFECTED => false (no stock increase)
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sales_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES voucher_line(id) ON DELETE CASCADE,
  stock_status    erp.stock_status NOT NULL,
  sale_qty        numeric(18,3) NOT NULL DEFAULT 0,   -- in DOZEN if PACKED else PAIR (UI rule)
  return_qty      numeric(18,3) NOT NULL DEFAULT 0,
  return_reason_id bigint REFERENCES return_reasons(id),
  pair_rate       numeric(18,2) NOT NULL DEFAULT 0,
  pair_discount   numeric(18,2) NOT NULL DEFAULT 0,
  total_discount  numeric(18,2) NOT NULL DEFAULT 0,
  total_pairs     int GENERATED ALWAYS AS (
    CASE
      WHEN stock_status='PACKED' THEN (sale_qty * 12)::int
      ELSE sale_qty::int
    END
  ) STORED,
  CHECK (
    -- mutual exclusivity: either sale or return per row
    (sale_qty > 0 AND return_qty = 0) OR (return_qty > 0 AND sale_qty = 0) OR (sale_qty=0 AND return_qty=0)
  ),
  CHECK (
    -- return reason required when return_qty > 0
    (return_qty = 0 AND return_reason_id IS NULL) OR (return_qty > 0 AND return_reason_id IS NOT NULL)
  ),
  CHECK (
    -- packed rules: multiples of 0.5 and qty*12 integer
    (stock_status='PACKED' AND (sale_qty*2)=trunc(sale_qty*2) AND (sale_qty*12)=trunc(sale_qty*12))
    OR
    -- loose rules: integer qty
    (stock_status='LOOSE' AND sale_qty=trunc(sale_qty))
  )
);

-- 9.4 Claims (row-level optional)
CREATE TABLE IF NOT EXISTS sales_claim (
  id              bigserial PRIMARY KEY,
  sales_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  voucher_line_id  bigint REFERENCES voucher_line(id) ON DELETE SET NULL,
  customer_party_id bigint REFERENCES parties(id),
  customer_name    text,
  customer_phone   text,
  claim_pairs      int NOT NULL DEFAULT 0,
  claim_amount     numeric(18,2) NOT NULL DEFAULT 0,
  issue            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 9.5 Customer follow-up status
CREATE TABLE IF NOT EXISTS customer_followup (
  party_id       bigint PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'NONE', -- NONE/CALLED/PROMISED/DISPUTED/PARTIAL/COLLECTED
  promise_date   date,
  promise_amount numeric(18,2),
  updated_by     bigint REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 9.6 AR Open items + allocation (voucher-based)
CREATE TABLE IF NOT EXISTS ar_invoice (
  sales_voucher_id bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  party_id         bigint NOT NULL REFERENCES parties(id),
  invoice_amount   numeric(18,2) NOT NULL,
  due_date         date,
  dispute_status   text NOT NULL DEFAULT 'NONE' -- NONE/DISPUTED/HOLD
);

CREATE TABLE IF NOT EXISTS ar_open_item (
  id               bigserial PRIMARY KEY,
  party_id         bigint NOT NULL REFERENCES parties(id),
  source_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  source_kind      text NOT NULL, -- INVOICE/RECEIPT/CREDIT_NOTE
  open_amount      numeric(18,2) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ar_allocation (
  id                    bigserial PRIMARY KEY,
  party_id              bigint NOT NULL REFERENCES parties(id),
  from_voucher_id       bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  to_sales_voucher_id   bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  amount                numeric(18,2) NOT NULL CHECK (amount > 0),
  allocated_at          timestamptz NOT NULL DEFAULT now(),
  allocated_by          bigint NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS ix_ar_open_item_party_time ON ar_open_item(party_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ar_allocation_party_time ON ar_allocation(party_id, allocated_at);
