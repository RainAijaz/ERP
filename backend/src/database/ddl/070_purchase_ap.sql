/* =============================================================================
   FILE: 070_purchase_module.sql
   PURPOSE
   - Purchase vouchers + related guardrails built on top of the Universal Voucher Engine:
     â€¢ Purchase Order (PO)          -> header extension table
     â€¢ Purchase Invoice (PI)        -> header extension + CASH/CREDIT rule + optional PO link
     â€¢ Purchase Return (PR)         -> header extension + controlled reason list
     â€¢ PO-required policy rules     -> configuration table (enforced by backend/commit checks)
     â€¢ AP invoice summary (optional)-> cached summary row for faster reports

   HOW THIS MODULE FITS YOUR DESIGN
   - voucher_header is the â€œdocument headerâ€� for numbering, branch, date, maker/checker.
   - voucher_line holds the grid lines.
   - These *_header_ext tables add module-specific fields without duplicating voucher engine.

   IMPORTANT NOTES (ENFORCED OUTSIDE THIS FILE)
   - Party type checks (supplier_party_id must be SUPPLIER) are enforced in integrity_checks.sql / backend.
   - Voucher type checks (voucher_id must be PO/PI/PR voucher types) are enforced in integrity_checks.sql / backend.
   - po_voucher_id must reference a PO of the same supplier and correct branch (enforced in integrity_checks.sql / backend).
   ============================================================================ */

SET search_path = erp;

-- -----------------------------------------------------------------------------
-- Controlled enums (small fixed sets; prevents drift/typos in user input)
-- -----------------------------------------------------------------------------

-- Purchase Return reasons: controlled set so users cannot type random values.
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


-- -----------------------------------------------------------------------------
-- PO requirement policy rules (configuration)
-- -----------------------------------------------------------------------------
-- If any ACTIVE rule matches a Purchase Invoice (PI), then PI MUST reference a PO.
--
-- Matching semantics:
--   - NULL means â€œdo not filter by this fieldâ€�
--   - A rule matches when ALL non-NULL filters match
--   - min_amount (if provided) should be evaluated against the PI total (define gross/net in backend)
--
-- Enforcement:
--   - These rules are enforced by backend / integrity_checks.sql at save/submit/post time.
CREATE TABLE IF NOT EXISTS erp.purchase_order_requirement_rule (
  id                 bigserial PRIMARY KEY,
  is_active          boolean NOT NULL DEFAULT true,

  -- NULL = applies to all branches; else only for a specific branch
  branch_id          bigint REFERENCES erp.branches(id),

  -- Optional filters (NULL = ignore)
  min_amount         numeric(18,2),
  supplier_party_id  bigint REFERENCES erp.parties(id),
  rm_item_id         bigint REFERENCES erp.items(id),
  rm_group_id        bigint REFERENCES erp.product_groups(id),

  notes              text
);

-- Helps policy checks and admin screens (active rules per branch)
CREATE INDEX IF NOT EXISTS idx_po_req_rule_active_branch
  ON erp.purchase_order_requirement_rule (is_active, branch_id);

-- Optional: when you frequently filter rules by supplier as well
CREATE INDEX IF NOT EXISTS idx_po_req_rule_supplier
  ON erp.purchase_order_requirement_rule (supplier_party_id)
  WHERE supplier_party_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- Purchase Order (PO) header extension
-- -----------------------------------------------------------------------------
-- voucher_id must be a PO voucher (enforced in integrity_checks.sql/backend).
-- supplier_party_id must be SUPPLIER (enforced in integrity_checks.sql/backend).
CREATE TABLE IF NOT EXISTS erp.purchase_order_header_ext (
  voucher_id        bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  supplier_party_id bigint NOT NULL REFERENCES erp.parties(id),
  required_by_date  date  -- optional: expected/needed date for follow-up and aging
);

-- Fast list/filter: POs by supplier
CREATE INDEX IF NOT EXISTS idx_po_header_supplier
  ON erp.purchase_order_header_ext (supplier_party_id);


-- -----------------------------------------------------------------------------
-- Purchase Invoice (PI) header extension
-- -----------------------------------------------------------------------------
-- voucher_id must be a PI voucher (enforced in integrity_checks.sql/backend).
-- supplier_party_id must be SUPPLIER (enforced in integrity_checks.sql/backend).
--
-- CASH vs CREDIT rule:
--   â€¢ CREDIT: cash_paid_account_id must be NULL (nothing paid now; AP carries payable)
--   â€¢ CASH:   cash_paid_account_id must be NOT NULL (paid now; specify cash/bank account)
--
-- po_voucher_id (optional):
--   â€¢ used when PO is required by policy or when user wants linking
--   â€¢ must reference a PO, and should match supplier + branch (enforced in integrity_checks.sql/backend)
CREATE TABLE IF NOT EXISTS erp.purchase_invoice_header_ext (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  supplier_party_id    bigint NOT NULL REFERENCES erp.parties(id),

  payment_type         erp.payment_type NOT NULL DEFAULT 'CREDIT', -- CASH / CREDIT only
  cash_paid_account_id bigint REFERENCES erp.accounts(id),         -- required for CASH, NULL for CREDIT

  po_voucher_id        bigint REFERENCES erp.voucher_header(id),   -- optional PO link
  notes                text,

  CHECK (
    (payment_type = 'CREDIT' AND cash_paid_account_id IS NULL)
    OR
    (payment_type = 'CASH'   AND cash_paid_account_id IS NOT NULL)
  )
);

-- Fast list/filter: PIs by supplier
CREATE INDEX IF NOT EXISTS idx_pi_header_supplier
  ON erp.purchase_invoice_header_ext (supplier_party_id);


-- -----------------------------------------------------------------------------
-- Purchase Return (PR) header extension
-- -----------------------------------------------------------------------------
-- voucher_id must be a PR voucher (enforced in integrity_checks.sql/backend).
-- supplier_party_id must be SUPPLIER (enforced in integrity_checks.sql/backend).
CREATE TABLE IF NOT EXISTS erp.purchase_return_header_ext (
  voucher_id        bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  supplier_party_id bigint NOT NULL REFERENCES erp.parties(id),
  reason            erp.purchase_return_reason NOT NULL
);


-- -----------------------------------------------------------------------------
-- AP invoice summary (optional cached table)
-- -----------------------------------------------------------------------------
-- This table is a convenience summary row for reporting (AP aging, supplier balances, etc.).
-- It duplicates information derivable from vouchers, so it MUST be treated as a cache:
--   - maintained by backend/posting engine
--   - do not edit manually
CREATE TABLE IF NOT EXISTS erp.ap_invoice_summary (
  purchase_voucher_id bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  branch_id           bigint NOT NULL REFERENCES erp.branches(id),
  party_id            bigint NOT NULL REFERENCES erp.parties(id),
  invoice_amount      numeric(18,2) NOT NULL CHECK (invoice_amount >= 0)
);

-- Helpful for branch-wise AP reports
CREATE INDEX IF NOT EXISTS idx_ap_invoice_summary_branch
  ON erp.ap_invoice_summary (branch_id);

-- Helpful for supplier-wise AP reports
CREATE INDEX IF NOT EXISTS idx_ap_invoice_summary_party
  ON erp.ap_invoice_summary (party_id);
