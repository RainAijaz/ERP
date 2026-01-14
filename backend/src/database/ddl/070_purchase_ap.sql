/* =============================================================================
   FILE: 070_purchase_module.sql
   PURPOSE
   - Purchase vouchers + enforcement around them:
     1) Purchase Order (PO) header extension + validations
     2) Purchase Invoice (PI) header extension + CASH/CREDIT rules + optional PO reference
     3) Purchase Return (PR) header extension + optional PI reference
     4) PO-required policy rules (supplier / RM item / RM group / min amount) enforced at COMMIT
     5) AP open items + allocations (optional but useful for payables tracking)

   ASSUMPTIONS
   - Voucher engine exists: erp.voucher_header, erp.voucher_line, erp.voucher_type
   - Parties: erp.parties with erp.party_type = CUSTOMER/SUPPLIER
   - Items: erp.items with erp.item_type = RM/SFG/FG
   - Multi-branch: erp.branches
   - Users: erp.users
   ============================================================================ */

SET search_path = erp;

-- ---------------------------------------------------------------------------
-- Small enums to prevent drift
-- ---------------------------------------------------------------------------

-- AP open item kind (no free-text values like "invoice"/"Invoice"/etc.)
DO $$ BEGIN
  CREATE TYPE erp.ap_source_kind AS ENUM ('INVOICE','PAYMENT','DEBIT_NOTE','CREDIT_NOTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- Purchase Return reason (ENUM so users can’t type random/typo values)
DO $$ BEGIN
  CREATE TYPE erp.purchase_return_reason AS ENUM (
    'DAMAGED',
    'WRONG_ITEM',
    'QUALITY_ISSUE',
    'EXCESS_QTY',
    'RATE_DISPUTE',
    'LATE_DELIVERY',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------------
-- 10.1 PO requirement policy rules
-- ---------------------------------------------------------------------------
-- If any active rule matches a PI - PURCHASE INVOICE, then PI must reference a PO (enforced at COMMIT).
CREATE TABLE IF NOT EXISTS erp.purchase_order_requirement_rule (
  id                 bigserial PRIMARY KEY,
  is_active          boolean NOT NULL DEFAULT true,
  branch_id          bigint REFERENCES erp.branches(id), -- NULL = applies to all branches
  min_amount         numeric(18,2),
  supplier_party_id  bigint REFERENCES erp.parties(id),
  rm_item_id         bigint REFERENCES erp.items(id),
  rm_group_id        bigint REFERENCES erp.product_groups(id),
  notes              text
);

-- ---------------------------------------------------------------------------
-- 10.2 Purchase Order header extension (PO)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.purchase_order_header_ext (
  voucher_id        bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  supplier_party_id bigint NOT NULL REFERENCES erp.parties(id),
  required_by_date  date  -- optional: when this PO is needed/expected (follow-up/aging)
);

-- ---------------------------------------------------------------------------
-- 10.3 Purchase Invoice header extension (PI)
-- ---------------------------------------------------------------------------
-- CASH:
--   - cash_paid_account_id REQUIRED (which cash/bank account paid)
-- CREDIT:
--   - cash_paid_account_id MUST be NULL (AP open item will carry the payable)
-- Optional:
--   - po_voucher_id links PI -> PO (used when PO is required by policy)
CREATE TABLE IF NOT EXISTS erp.purchase_invoice_header_ext (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  supplier_party_id    bigint NOT NULL REFERENCES erp.parties(id),

  payment_type         erp.payment_type NOT NULL DEFAULT 'CREDIT', -- CASH / CREDIT only
  cash_paid_account_id bigint REFERENCES erp.accounts(id),         -- required for CASH, NULL for CREDIT

  po_voucher_id        bigint REFERENCES erp.voucher_header(id),   -- optional PO link
  notes                text,
  CHECK (
  -- CREDIT purchase: nothing is paid now, so no "paid from" account
  (payment_type = 'CREDIT' AND cash_paid_account_id IS NULL)
  OR
  -- CASH purchase: paid now, so "paid from" account is mandatory
  (payment_type = 'CASH'   AND cash_paid_account_id IS NOT NULL)
)
);


-- ---------------------------------------------------------------------------
-- 10.4 Purchase Return header extension (PR)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.purchase_return_header_ext (
  voucher_id              bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  supplier_party_id       bigint NOT NULL REFERENCES erp.parties(id),
  reason                  erp.purchase_return_reason NOT NULL
);


-- Summary row per PI ( convenience)
CREATE TABLE IF NOT EXISTS erp.ap_invoice_summary (
  purchase_voucher_id bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  branch_id           bigint NOT NULL REFERENCES erp.branches(id),
  party_id            bigint NOT NULL REFERENCES erp.parties(id),
  invoice_amount      numeric(18,2) NOT NULL CHECK (invoice_amount >= 0)
);

