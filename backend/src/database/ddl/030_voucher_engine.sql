-- =============================================================================
-- 4) UNIVERSAL VOUCHER ENGINE (all modules)
-- =============================================================================
-- Goal:
--   One common engine that every module uses (Sales, Purchase, Production, etc.)
--   so reporting, approvals, audit, posting logic stays consistent.
--
-- Tables:
--   voucher_type   = defines each voucher "template" (SV, PV, JV, etc.)
--   voucher_header = one row per voucher document (top portion of the form)
--   voucher_line   = multiple rows per voucher (grid/lines inside the form)
-- =============================================================================
SET search_path = erp;

-- -----------------------------------------------------------------------------
-- voucher_type
-- -----------------------------------------------------------------------------
-- This is the "master list" of voucher types your ERP supports.
-- Example rows:
--   code='SV'  name='Sales Voucher'
--   code='PV'  name='Purchase Invoice'
--   code='JV'  name='Journal Voucher'
-- Each type can behave differently via flags:
--   requires_approval = should it go through maker-checker?
--   affects_stock     = does it change stock quantities/values?
--   affects_gl        = does it create GL entries?
--   default_status_on_save = status when user presses "Save" initially
--     (recommended: PENDING, then user submits/post later)
CREATE TABLE IF NOT EXISTS erp.voucher_type(
  code text PRIMARY KEY,                  -- short stable key: SV, PV, JV, etc.
  name text NOT NULL,                     -- display name shown in UI
  requires_approval boolean NOT NULL DEFAULT false, -- needs approval workflow?
  affects_stock boolean NOT NULL DEFAULT false,     -- changes inventory?
  affects_gl boolean NOT NULL DEFAULT true,         -- creates GL postings?
);

-- -----------------------------------------------------------------------------
-- voucher_header
-- -----------------------------------------------------------------------------
-- One row per voucher document.
-- Think of this as the top part of the voucher screen:
--   voucher no, date, branch, status, remarks, created_by, approvals etc.
CREATE TABLE IF NOT EXISTS erp.voucher_header(
  id bigserial PRIMARY KEY,               -- internal DB identity
  voucher_type_code text NOT NULL REFERENCES erp.voucher_type(code), -- which template/type is this?
  voucher_no bigint NOT NULL,               -- document number visible to user (app-generated)
  branch_id bigint NOT NULL REFERENCES erp.branches(id), -- which branch this voucher belongs to
  voucher_date date NOT NULL,             -- accounting date
  book_no     text ,
  status erp.approval_status NOT NULL DEFAULT 'PENDING',   -- approval_status/PENDING/APPROVED/REJECTED
  created_by bigint NOT NULL REFERENCES erp.users(id),  -- maker user id
  created_at timestamptz NOT NULL DEFAULT now(),        -- creation timestamp
  approved_by bigint REFERENCES erp.users(id),          -- checker user id (if used)
  approved_at timestamptz,                              -- approval timestamp (if used)
  remarks text,                           -- optional notes on voucher

  -- Consistency rule:
  --   If voucher is still PENDING, it must NOT have approval fields.
  --   If voucher is APPROVED/REJECTED, approval fields may exist (app decides exact policy).
  CHECK(
    (status IN ('PENDING') AND approved_by IS NULL AND approved_at IS NULL)
    OR
    (status IN ('APPROVED','REJECTED'))
  ),

  -- Unique voucher number per branch per voucher type.
  -- This lets each branch have its own numbering series for each voucher type.
  UNIQUE(branch_id,voucher_type_code,voucher_no)
);

-- -----------------------------------------------------------------------------
-- voucher_line
-- -----------------------------------------------------------------------------
-- Each voucher has multiple lines (grid rows).
-- A line can represent different kinds of things:
--   ITEM     -> item-level inventory posting (RM/SFG/FG)
--   SKU      -> sku-level posting (size/grade/color/packing variant)
--   ACCOUNT  -> GL account posting line
--   PARTY    -> customer/supplier control posting line (if you want party lines)
--   LABOUR   -> labour cost posting line
--   EMPLOYEE -> employee cost posting line
--
-- IMPORTANT RULE:
--   Exactly ONE of these references must be filled per line.


CREATE TABLE IF NOT EXISTS voucher_line (
  id          bigserial PRIMARY KEY,
  voucher_header_id  bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  line_no     int NOT NULL,
  line_kind   erp.voucher_line_kind NOT NULL,

  item_id     bigint REFERENCES items(id),
  sku_id      bigint REFERENCES skus(id),
  account_id  bigint REFERENCES accounts(id),
  party_id    bigint REFERENCES parties(id),
  labour_id   bigint, -- FK added after labours
  employee_id bigint REFERENCES employees(id), -- FK added after employees
  
  uom_id      bigint REFERENCES uom(id), 
  qty         numeric(18,3) NOT NULL DEFAULT 0,  -- RM quantity etc
  rate        numeric(18,4) NOT NULL DEFAULT 0,
  amount      numeric(18,2) NOT NULL DEFAULT 0,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE(voucher_id,line_no),
  CHECK (line_no > 0),
  CHECK (num_nonnulls(item_id, sku_id, account_id, party_id, labour_id, employee_id) = 1),
  CHECK (
    (line_kind='ITEM' AND item_id IS NOT NULL) OR
    (line_kind='SKU' AND sku_id IS NOT NULL) OR
    (line_kind='ACCOUNT' AND account_id IS NOT NULL) OR
    (line_kind='PARTY' AND party_id IS NOT NULL) OR
    (line_kind='LABOUR' AND labour_id IS NOT NULL) OR
    (line_kind='EMPLOYEE' AND employee_id IS NOT NULL)
  )
);

