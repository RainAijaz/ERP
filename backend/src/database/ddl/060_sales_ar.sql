-- =====================================================================
-- SALES.sql  (Sales Orders + Sales Voucher + Returns + Follow-up + Claims)
-- =====================================================================
-- Fits your Universal Voucher Engine:
--   - voucher_header = document header (number, date, branch, approval status)
--   - voucher_line   = grid lines (SKU/account/party/etc)
--
-- This file adds sales-specific:
--   - sales_order_header   : Sales Order header extension (pending deliveries)
--   - sales_header         : Sales Voucher header extension (cash/credit + delivery)
--   - return_reasons       : master list of return reasons
--   - sales_line           : per-line sale vs return exclusivity + packed/loose qty rules
--   - customer_followup    : per-customer follow-up status for receivables collection
--
-- IMPORTANT ENFORCEMENTS (done in integrity_checks.sql / backend)
--   - Voucher type correctness:
--       * sales_order_header.voucher_id must be voucher_type_code = 'SO'
--       * sales_header.voucher_id must be voucher_type_code = 'SV' (or your sales voucher code)
--       * sales_line.voucher_line_id must belong to that sales voucher
--   - Party correctness:
--       * customer_party_id must reference erp.parties where party_type='CUSTOMER'
--   - Line correctness:
--       * sales_line must extend voucher_line rows where line_kind='SKU' and sku_id IS NOT NULL
-- =====================================================================

SET search_path = erp;

-- =====================================================================
-- ENUMS (create-if-missing)
-- NOTE: These must match your foundation definitions if they already exist.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE erp.payment_type AS ENUM ('CASH','CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Use enum keys (no spaces) to keep APIs clean
  CREATE TYPE erp.delivery_method AS ENUM ('CUSTOMER_PICKUP','OUR_DELIVERY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.customer_followup_status AS ENUM
    ('NONE','CALLED','PROMISED','DISPUTED','PARTIAL','COLLECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
-- SALES ORDER (pending deliveries)
-- =====================================================================
-- Purpose:
--   Sales Order is a "delivery pending" document.
--   It can optionally receive partial/full payment at order time.
--   Lines are normal voucher_line SKU lines; this table stores ONLY sales-order header fields.
--
-- Enforcement notes:
--   - voucher_id must be a Sales Order voucher type (enforced later in integrity_checks.sql)
--   - customer_party_id must be party_type='CUSTOMER' (enforced later)
CREATE TABLE IF NOT EXISTS erp.sales_order_header (
  voucher_id              bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  customer_party_id       bigint NOT NULL REFERENCES erp.parties(id) ON DELETE RESTRICT,
  salesman_employee_id    bigint NOT NULL REFERENCES erp.employees(id) ON DELETE RESTRICT,

  -- Optional advance/partial payment at order time
  payment_received_amount numeric(18,2) NOT NULL DEFAULT 0,
  receive_into_account_id bigint REFERENCES erp.accounts(id) ON DELETE RESTRICT,

  CHECK (payment_received_amount >= 0),
  CHECK (payment_received_amount = 0 OR receive_into_account_id IS NOT NULL)
);

-- =====================================================================
-- SALES VOUCHER header
-- =====================================================================
-- Notes:
--   - payment_type=CASH  => some amount should be received now
--   - payment_type=CREDIT=> customer_party_id + payment_due_date required
--   - sale_mode=FROM_SO  => linked_sales_order_id required + customer_party_id required
--
-- Enforcement notes:
--   - voucher_id must be a Sales Voucher voucher type (enforced later in integrity_checks.sql)
--   - customer_party_id must be party_type='CUSTOMER' (enforced later)
CREATE TABLE IF NOT EXISTS erp.sales_header (
  voucher_id               bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,

  sale_mode                erp.sale_mode NOT NULL DEFAULT 'DIRECT',

  -- Naming fix: this is payment TYPE (CASH/CREDIT), not "terms"
  payment_type             erp.payment_type NOT NULL DEFAULT 'CASH',

  -- Party required for CREDIT and for FROM_SO (because delivery/customer ledger needs party)
  customer_party_id        bigint REFERENCES erp.parties(id) ON DELETE RESTRICT,

  -- Cash walk-in (when customer_party_id is NULL)
  customer_name            text,
  customer_phone_number    text,

  salesman_employee_id     bigint REFERENCES erp.employees(id) ON DELETE RESTRICT,
  linked_sales_order_id    bigint REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,

  payment_due_date         date, -- required if CREDIT
  receive_into_account_id  bigint REFERENCES erp.accounts(id) ON DELETE RESTRICT,
  payment_received_amount  numeric(18,2) NOT NULL DEFAULT 0,

  delivery_method          erp.delivery_method NOT NULL DEFAULT 'CUSTOMER_PICKUP',
  extra_discount           numeric(18,2) NOT NULL DEFAULT 0,

  CHECK (payment_received_amount >= 0),
  CHECK (extra_discount >= 0),

  -- FROM_SO requires link + party
  CHECK (
    (sale_mode = 'DIRECT' AND linked_sales_order_id IS NULL)
    OR
    (sale_mode = 'FROM_SO' AND linked_sales_order_id IS NOT NULL AND customer_party_id IS NOT NULL)
  ),

  -- CREDIT requires party + due date
  CHECK (
    (payment_type = 'CASH')
    OR
    (payment_type = 'CREDIT' AND customer_party_id IS NOT NULL AND payment_due_date IS NOT NULL)
  ),

  -- If no party (cash walk-in), name+phone must exist
  CHECK (
    customer_party_id IS NOT NULL
    OR
    (COALESCE(trim(customer_name),'') <> '' AND COALESCE(trim(customer_phone_number),'') <> '')
  ),

  -- If any amount received, account must be selected
  CHECK (payment_received_amount = 0 OR receive_into_account_id IS NOT NULL),

  -- If CASH, enforce at least some received amount
  CHECK (payment_type <> 'CASH' OR payment_received_amount > 0)
);

-- Helpful for “Sales by Customer” listing / reporting
CREATE INDEX IF NOT EXISTS idx_sales_header_customer_party
  ON erp.sales_header(customer_party_id);

-- =====================================================================
-- RETURN REASONS (master)
-- =====================================================================
-- Anti-typo guard:
--   code must be uppercase snake-ish key like: WRONG_SIZE, DAMAGE, DEFECT, CLAIM_ONLY
CREATE TABLE IF NOT EXISTS erp.return_reasons (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  description   text NOT NULL,
  affects_stock boolean NOT NULL DEFAULT true,  -- e.g. CLAIM_ONLY => false (no stock increase)
  is_active     boolean NOT NULL DEFAULT true,

  CHECK (code = upper(trim(code)) AND code ~ '^[A-Z0-9_]{3,40}$')
);

-- =====================================================================
-- SALES LINE EXTENSION (sale vs return exclusivity + packed/loose rules)
-- =====================================================================
-- voucher_line row must be a SKU line (article). Enforced later:
--   - voucher_line.line_kind='SKU'
--   - voucher_line.sku_id IS NOT NULL
--
-- Quantity meaning:
--   is_packed = true  => user enters quantities in DOZEN units, allowing 0.5 steps
--                       Example: 1.0 = 12 pairs, 0.5 = 6 pairs
--                       We enforce "multiple of 0.5" by checking (qty * 2) is an integer.
--   is_packed = false => user enters quantities in PAIRS (must be whole number)
--
-- Pricing totals:
--   pair_rate / discounts / totals are maintained by backend (do not trust direct user input).
CREATE TABLE IF NOT EXISTS erp.sales_line (
  voucher_line_id   bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,

  is_packed         boolean NOT NULL DEFAULT false,  -- false = LOOSE (pairs), true = PACKED (dozen entry mode)
  sale_qty          numeric(18,3) NOT NULL DEFAULT 0,
  return_qty        numeric(18,3) NOT NULL DEFAULT 0,

  return_reason_id  bigint REFERENCES erp.return_reasons(id) ON DELETE RESTRICT,

  pair_rate         numeric(18,2) NOT NULL DEFAULT 0,
  pair_discount     numeric(18,2) NOT NULL DEFAULT 0,
  total_discount    numeric(18,2) NOT NULL DEFAULT 0,
  total_amount      numeric(18,2) NOT NULL DEFAULT 0,

  CHECK (sale_qty >= 0 AND return_qty >= 0),

  -- Must be either SALE or RETURN (not both)
  CHECK (
    (sale_qty > 0 AND return_qty = 0)
    OR
    (return_qty > 0 AND sale_qty = 0)
  ),

  -- Return reason required if this row is a return
  CHECK (
    (return_qty = 0 AND return_reason_id IS NULL)
    OR
    (return_qty > 0 AND return_reason_id IS NOT NULL)
  ),

  -- Packed/loose validation applies to whichever qty is used on that row:
  --   - PACKED: qty must be a multiple of 0.5 (qty*2 is an integer)
  --   - LOOSE : qty must be an integer
  CHECK (
    (
      is_packed = true AND (
        (sale_qty   > 0 AND (sale_qty   * 2) = trunc(sale_qty   * 2))
        OR
        (return_qty > 0 AND (return_qty * 2) = trunc(return_qty * 2))
      )
    )
    OR
    (
      is_packed = false AND (
        (sale_qty   > 0 AND sale_qty   = trunc(sale_qty))
        OR
        (return_qty > 0 AND return_qty = trunc(return_qty))
      )
    )
  )
);

-- Optional but useful for “Returns by Reason” reports
CREATE INDEX IF NOT EXISTS idx_sales_line_return_reason
  ON erp.sales_line(return_reason_id);

-- =====================================================================
-- CUSTOMER FOLLOW-UP STATUS (for balances/collection report)
-- =====================================================================
-- Stores the latest follow-up state per customer.
-- Enforcement note:
--   party_id must be party_type='CUSTOMER' (enforced later in integrity_checks.sql/backend)
CREATE TABLE IF NOT EXISTS erp.customer_followup (
  party_id       bigint PRIMARY KEY REFERENCES erp.parties(id) ON DELETE CASCADE,
  status         erp.customer_followup_status NOT NULL DEFAULT 'NONE',
  promise_date   date,
  promise_amount numeric(18,2),
  updated_by     bigint REFERENCES erp.users(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Promise fields only when PROMISED
  CHECK (
    (status <> 'PROMISED' AND promise_date IS NULL AND promise_amount IS NULL)
    OR
    (status  = 'PROMISED' AND promise_date IS NOT NULL AND promise_amount IS NOT NULL AND promise_amount > 0)
  )
);

-- Helpful for "Follow-up list by status" screen
CREATE INDEX IF NOT EXISTS idx_customer_followup_status
  ON erp.customer_followup(status);
