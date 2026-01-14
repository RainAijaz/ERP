-- =====================================================================
-- 051_production_completion_planning_loss.sql  (MODULE PATCH)
-- Completion-based production + DCV/WIP pools + planning + loss voucher
-- =====================================================================

SET search_path = erp;

-- ---------------------------------------------------------------------
-- 0) ENUMS (create-if-missing)
-- ---------------------------------------------------------------------

DO $$ BEGIN
  -- Packed/Loose rule for pair-based goods (UI entry mode).
  CREATE TYPE erp.stock_type AS ENUM ('PACKED','LOOSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.loss_type AS ENUM ('RM_LOSS','SFG_LOSS','FG_LOSS','DVC_ABANDON');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.production_kind AS ENUM ('FG','SFG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------
-- 1) CORE: WIP department pool (fast balance + audit ledger)
-- ---------------------------------------------------------------------
-- Purpose:
--   DCV posts "IN" to this pool (completed dept output waiting for FG).
--   FG production consumes "OUT" from this pool (skip re-consuming RM/labour).
-- Confidentiality:
--   cost_value exists in DB but should be hidden from worker roles via API.

CREATE TABLE IF NOT EXISTS erp.wip_dept_balance (
  branch_id          bigint NOT NULL REFERENCES erp.branches(id),
  sku_id             bigint NOT NULL REFERENCES erp.skus(id),
  dept_id            bigint NOT NULL REFERENCES erp.departments(id),
  qty_pairs          int NOT NULL DEFAULT 0 CHECK (qty_pairs >= 0),
  cost_value         numeric(18,2) NOT NULL DEFAULT 0 CHECK (cost_value >= 0),
  last_activity_date date,
  PRIMARY KEY (branch_id, sku_id, dept_id)
);

CREATE TABLE IF NOT EXISTS erp.wip_dept_ledger (
  id                bigserial PRIMARY KEY,
  branch_id         bigint NOT NULL REFERENCES erp.branches(id),
  sku_id            bigint NOT NULL REFERENCES erp.skus(id),
  dept_id           bigint NOT NULL REFERENCES erp.departments(id),
  txn_date          date NOT NULL,
  direction         smallint NOT NULL CHECK (direction IN (1, -1)), -- +1 IN, -1 OUT
  qty_pairs         int NOT NULL DEFAULT 0 CHECK (qty_pairs >= 0),
  cost_value        numeric(18,2) NOT NULL DEFAULT 0 CHECK (cost_value >= 0),
  source_voucher_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 2) DCV: Department Completion Voucher extension 
-- ---------------------------------------------------------------------
-- Worker enters: SKU, Dept, Completed Qty (pairs), Labour
-- Backend does:
--   - Dept RM consumption (at WAC)
--   - Dept labour posting
--   - Adds to WIP dept pool (balance + ledger IN)
--
-- Note: Approval/locking comes from voucher_header.status in your engine.

CREATE TABLE IF NOT EXISTS erp.dcv_header (
  voucher_id          bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  dept_id             bigint NOT NULL REFERENCES erp.departments(id),
  labour_id           bigint REFERENCES erp.labours(id)
);

-- ---------------------------------------------------------------------
-- 3) Production Completion (FG/SFG) voucher extension
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS erp.production_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  stock_type    erp.stock_type NOT NULL,
  total_pairs     int NOT NULL CHECK (total_pairs > 0)
);

-- ---------------------------------------------------------------------
-- 4) Links: Production voucher -> auto-generated vouchers
-- ---------------------------------------------------------------------
-- Purpose:
--   When production completion is saved/posted, backend creates:
--     - consumption voucher (RM/SFG consumption from BOM)
--     - labour voucher (labour cost per SKU/dept)
--   This table keeps linkages for audit and reports.

CREATE TABLE IF NOT EXISTS erp.production_generated_links (
  production_voucher_id  bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  consumption_voucher_id bigint REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  labour_voucher_id      bigint REFERENCES erp.voucher_header(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp.consumption_header (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  source_production_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp.labour_voucher_header (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  source_production_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp.labour_voucher_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  dept_id         bigint NOT NULL REFERENCES erp.departments(id),
  sku_id          bigint NOT NULL REFERENCES erp.skus(id)
);

-- ---------------------------------------------------------------------
-- 5) Production Planning (future plan; does NOT post stock/GL)
-- ---------------------------------------------------------------------
-- Purpose:
--   Plan FG/SFG production in advance.
--   Pending Consumption Report derives RM requirements from plan lines + BOM.
-- Header extension: tells UI whether this plan is FG or SFG
CREATE TABLE IF NOT EXISTS erp.production_plan_header (
  voucher_id   bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  plan_kind    erp.production_kind NOT NULL   -- FG or SFG (shown on header)
);

CREATE TABLE IF NOT EXISTS erp.production_plan_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  stock_status    erp.stock_status NOT NULL,
  total_pairs     int NOT NULL CHECK (total_pairs > 0)
);

-- ---------------------------------------------------------------------
-- 6) Abnormal Loss voucher (one voucher type; loss_type per line)
-- ---------------------------------------------------------------------
-- Requirement:
--   One voucher type for losses; each line has loss_type:
--     RM_LOSS / SFG_LOSS / FG_LOSS / DVC_ABANDON
--
-- Design:
--   Use voucher_header + voucher_line, plus this line extension:
--     abnormal_loss_line(voucher_line_id, loss_type, dept_id)
--   Quantity rules:
--     - For SKU losses + DVC_ABANDON: voucher_line.qty must be integer (pairs)
--     - For RM losses: voucher_line.qty can be decimal (kg/meter/etc)
--   Validations:
--     - DVC_ABANDON requires dept_id
--     - DVC_ABANDON requires SKU line_kind
--     - DVC_ABANDON qty_pairs <= wip_dept_balance.qty_pairs for (branch, sku, dept)
--   Posting:
--     - RM/SFG/FG loss affects inventory (stock ledger OUT, GL at cost)
--     - DVC_ABANDON affects ONLY WIP pool + GL (no stock ledger)

CREATE TABLE IF NOT EXISTS erp.abnormal_loss_header (
  voucher_id     bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  reason_code_id bigint REFERENCES erp.reason_codes(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp.abnormal_loss_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  loss_type       erp.loss_type NOT NULL,
  dept_id         bigint REFERENCES erp.departments(id)   -- required for DVC_ABANDON
);


