-- =====================================================================
-- SALES.sql  (Sales Orders + Sales Voucher + Returns + Follow-up + Claims)
-- =====================================================================
-- Fits your Universal Voucher Engine:
--   - voucher_header = document header
--   - voucher_line   = grid lines
-- This file adds sales-specific enums + extension tables + guardrails.
-- =====================================================================

SET search_path = erp;

-- =====================================================================
-- 0) ENUMS (create-if-missing)
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE erp.sale_mode AS ENUM ('DIRECT','FROM_SO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.sale_payment_terms AS ENUM ('CASH','CREDIT');
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
-- 1) SALES ORDER (pending deliveries)
-- =====================================================================
-- Purpose:
--   Sales Order is a "delivery pending" document.
--   It can optionally receive partial/full payment at order time.
--   Lines are normal voucher_line SKU lines. We store only sales-order-specific fields here.

CREATE TABLE IF NOT EXISTS erp.sales_order_header (
  voucher_id              bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  customer_party_id       bigint NOT NULL REFERENCES erp.parties(id),
  salesman_employee_id    bigint NOT NULL REFERENCES erp.employees(id),
  -- optional advance/partial payment at order time
  payment_received_amount numeric(18,2) NOT NULL DEFAULT 0,
  receive_into_account_id bigint REFERENCES erp.accounts(id),
  CHECK (payment_received_amount >= 0),
  CHECK (payment_received_amount = 0 OR receive_into_account_id IS NOT NULL)
);

-- =====================================================================
-- 2) SALES VOUCHER (sale + returns in same grid; row-level exclusivity)
-- =====================================================================
-- Notes:
--   - CASH means immediate payment is expected.
--   - CREDIT means due date is required; received amount can be 0 or partial.
--   - If sale_mode = FROM_SO, linked_sales_order_id is mandatory, and customer_party_id must exist.

CREATE TABLE IF NOT EXISTS erp.sales_header (
  voucher_id               bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  sale_mode                erp.sale_mode NOT NULL DEFAULT 'DIRECT',
  payment_terms            erp.sale_payment_terms NOT NULL DEFAULT 'CASH',
  -- Party required for CREDIT and for FROM_SO (because delivery/customer ledger needs party)
  customer_party_id        bigint REFERENCES erp.parties(id),
  -- Cash-walkin (when customer_party_id is null)
  customer_name            text,
  customer_phone_number    text,
  salesman_employee_id     bigint REFERENCES erp.employees(id),
  linked_sales_order_id    bigint REFERENCES erp.voucher_header(id),
  payment_due_date         date, -- required if CREDIT
  receive_into_account_id  bigint REFERENCES erp.accounts(id),
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
    (payment_terms = 'CASH')
    OR
    (payment_terms = 'CREDIT' AND customer_party_id IS NOT NULL AND payment_due_date IS NOT NULL)
  ),

  -- If no party (cash walk-in), name+phone must exist
  CHECK (
    customer_party_id IS NOT NULL
    OR
    (COALESCE(trim(customer_name),'') <> '' AND COALESCE(trim(customer_phone_number),'') <> '')
  ),

  -- If any amount received, account must be selected
  CHECK (payment_received_amount = 0 OR receive_into_account_id IS NOT NULL),

  -- If CASH, enforce at least some received amount (strict “full = final” needs backend because final_amount isn’t stored here)
  CHECK (payment_terms <> 'CASH' OR payment_received_amount > 0)
);

-- =====================================================================
-- 3) RETURN REASONS (master) + seed
-- =====================================================================

CREATE TABLE IF NOT EXISTS erp.return_reasons (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  description   text NOT NULL,
  affects_stock boolean NOT NULL DEFAULT true,  -- e.g. MISSING_ITEMS => false (no stock increase)
  is_active     boolean NOT NULL DEFAULT true
);

-- =====================================================================
-- 4) SALES LINE EXTENSION (sale vs return exclusivity + packed/loose rules)
-- =====================================================================
-- voucher_line row must be a SKU line (article).
-- sale_qty/return_qty are in:
--   - DOZEN when stock_type = PACKED
--   - PAIR  when stock_type = LOOSE

CREATE TABLE IF NOT EXISTS erp.sales_line (
  voucher_line_id   bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  stock_type        erp.stock_type NOT NULL, -- PACKED/LOOSE
  sale_qty          numeric(18,3) NOT NULL DEFAULT 0,
  return_qty        numeric(18,3) NOT NULL DEFAULT 0,
  return_reason_id  bigint REFERENCES erp.return_reasons(id),
  pair_rate         numeric(18,2) NOT NULL DEFAULT 0,
  pair_discount     numeric(18,2) NOT NULL DEFAULT 0,
  total_discount    numeric(18,2) NOT NULL DEFAULT 0,
  total_amount      numeric(18,2) NOT NULL DEFAULT 0,

  CHECK (sale_qty >= 0 AND return_qty >= 0),
  -- Must be either sale OR return (not both) and not both zero
  CHECK (
    (sale_qty > 0 AND return_qty = 0)
    OR
    (return_qty > 0 AND sale_qty = 0)
  ),
  -- return reason required if return
  CHECK (
    (return_qty = 0 AND return_reason_id IS NULL)
    OR
    (return_qty > 0 AND return_reason_id IS NOT NULL)
  ),
  -- packed/loose validation applies to whichever qty is used on that row
  CHECK (
    stock_type = 'PACKED'
    AND (
      ((sale_qty   > 0 AND (sale_qty*2)=trunc(sale_qty*2)   AND (sale_qty*12)=trunc(sale_qty*12)))
      OR
      ((return_qty > 0 AND (return_qty*2)=trunc(return_qty*2) AND (return_qty*12)=trunc(return_qty*12)))
    )
    OR
    stock_type = 'LOOSE'
    AND (
      ((sale_qty   > 0 AND sale_qty=trunc(sale_qty)))
      OR
      ((return_qty > 0 AND return_qty=trunc(return_qty)))
    )
  )
);

-- =====================================================================
-- 6) CUSTOMER FOLLOW-UP STATUS (for balances report)
-- =====================================================================

CREATE TABLE IF NOT EXISTS erp.customer_followup (
  party_id       bigint PRIMARY KEY REFERENCES erp.parties(id) ON DELETE CASCADE,
  status         erp.customer_followup_status NOT NULL DEFAULT 'NONE',
  promise_date   date,
  promise_amount numeric(18,2),
  updated_by     bigint REFERENCES erp.users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Promise fields only when PROMISED
  CHECK (
    (status <> 'PROMISED' AND promise_date IS NULL AND promise_amount IS NULL)
    OR
    (status  = 'PROMISED' AND promise_date IS NOT NULL AND promise_amount IS NOT NULL AND promise_amount > 0)
  )
);

