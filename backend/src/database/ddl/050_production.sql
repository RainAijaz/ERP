-- =====================================================================
-- 050_production.sql
-- =====================================================================
-- PURPOSE
--   Production + WIP module patch built on top of the generic voucher engine.
--   This file adds production-specific extension tables and supporting ledgers
--   for completion-based production, department WIP pooling, planning, and losses.
--
-- TABLES CREATED IN THIS FILE
--   WIP (Department pool)
--     - wip_dept_balance             : Running balance of WIP by (branch, sku, department)
--     - wip_dept_ledger              : Audit ledger of WIP movements (IN/OUT) linked to source vouchers
--
--   DCV (Department Completion Voucher extensions)
--     - dcv_header                   : Extends voucher_header for DCV (dept + optional labour reference)
--
--   Production Completion extensions
--     - production_line              : Extends voucher_line for production completion (pairs + entry mode)
--
--   Auto-generated voucher linkages (audit/reporting)
--     - production_generated_links   : Links production voucher to generated consumption/labour vouchers
--     - consumption_header           : Extends voucher_header for auto-generated consumption voucher (1:1 per production)
--     - labour_voucher_header        : Extends voucher_header for auto-generated labour voucher (1:1 per production)
--     - labour_voucher_line          : Extends voucher_line for labour voucher (dept tagging; sku_id stays on base voucher_line)
--
--   Production Planning (non-posting)
--     - production_plan_header       : Extends voucher_header for production plans (FG/SFG kind)
--     - production_plan_line         : Extends voucher_line for plan lines (pairs + entry mode)
--
--   Abnormal Loss (voucher extensions)
--     - abnormal_loss_header         : Extends voucher_header for loss vouchers (optional reason code)
--     - abnormal_loss_line           : Extends voucher_line for loss type + dept tagging
--
-- IMPORTANT NOTES
--   - This file defines tables + indexes only.
--   - Voucher-type matching (e.g., dcv_header must point to voucher_type_code='DCV'),
--     posting rules, and advanced validations (e.g., DVC_ABANDON rules) are enforced
--     later in integrity_checks.sql and/or backend posting logic.
-- =====================================================================

SET search_path = erp;

-- ---------------------------------------------------------------------
-- WIP department pool (fast balance + audit ledger)
-- ---------------------------------------------------------------------
-- Purpose:
--   - DCV posts "IN" to this pool (dept output completed, waiting for next stage)
--   - FG/SFG production consumes "OUT" from this pool (do not re-consume RM/labour)
--
-- Security note:
--   - cost_value exists in DB but should be restricted at API/role level for workers.
CREATE TABLE IF NOT EXISTS erp.wip_dept_balance (
  branch_id          bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  sku_id             bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,
  dept_id            bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
  qty_pairs          int NOT NULL DEFAULT 0 CHECK (qty_pairs >= 0),
  cost_value         numeric(18,2) NOT NULL DEFAULT 0 CHECK (cost_value >= 0),
  last_activity_date date,
  PRIMARY KEY (branch_id, sku_id, dept_id)
);

-- Ledger = append-only audit trail of WIP pool movements.
-- NOTE:
--   - This table intentionally does NOT enforce "no duplicate rows" because
--     a single voucher can contain multiple lines for the same SKU + dept + direction.
--   - Duplicate-prevention (for accidental re-posting) must be handled by posting logic
CREATE TABLE IF NOT EXISTS erp.wip_dept_ledger (
  id                bigserial PRIMARY KEY,
  branch_id         bigint NOT NULL REFERENCES erp.branches(id) ON DELETE RESTRICT,
  sku_id            bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,
  dept_id           bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
  txn_date          date NOT NULL,
  direction         smallint NOT NULL CHECK (direction IN (1, -1)), -- +1 IN, -1 OUT
  qty_pairs         int NOT NULL DEFAULT 0 CHECK (qty_pairs >= 0),
  cost_value        numeric(18,2) NOT NULL DEFAULT 0 CHECK (cost_value >= 0),
  source_voucher_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Fast audit drill-down by voucher (very common query)
CREATE INDEX IF NOT EXISTS idx_wip_dept_ledger_source_voucher
  ON erp.wip_dept_ledger(source_voucher_id);

-- Useful for WIP statements by branch/dept/sku and date filtering
CREATE INDEX IF NOT EXISTS idx_wip_dept_ledger_branch_dept_sku_date
  ON erp.wip_dept_ledger(branch_id, dept_id, sku_id, txn_date);

-- ---------------------------------------------------------------------
-- DCV: Department Completion Voucher extension
-- ---------------------------------------------------------------------
-- Worker enters: Dept + optional Labour + completed output.
-- Backend/engine (on posting/approval) should:
--   - consume dept RM at WAC (stock ledger OUT for RM)
--   - post dept labour cost (GL)
--   - add WIP pool IN (wip_dept_balance + wip_dept_ledger)
--
-- Enforcement note:
--   - voucher_id must be a voucher_header of the DCV voucher_type_code
--     (enforce in integrity_checks.sql trigger).
CREATE TABLE IF NOT EXISTS erp.dcv_header (
  voucher_id bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  dept_id    bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
  labour_id  bigint REFERENCES erp.labours(id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------
-- Production Completion line extension (FG/SFG completion vouchers)
-- ---------------------------------------------------------------------
-- total_pairs is the physical completed quantity.
CREATE TABLE IF NOT EXISTS erp.production_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  is_packed       boolean NOT NULL DEFAULT false,  -- false=LOOSE, true=PACKED (entry mode)
  total_pairs     int NOT NULL CHECK (total_pairs > 0)
);

-- ---------------------------------------------------------------------
-- Links: Production voucher -> auto-generated vouchers
-- ---------------------------------------------------------------------
-- When a production completion is approved, backend generates:
--   - consumption voucher (RM/SFG consumption from BOM)
--   - labour voucher (labour cost per SKU/dept)
-- This table keeps the linkage for audit and reporting.
CREATE TABLE IF NOT EXISTS erp.production_generated_links (
  production_voucher_id  bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  consumption_voucher_id bigint REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  labour_voucher_id      bigint REFERENCES erp.voucher_header(id) ON DELETE RESTRICT
);

-- Indexes for reverse lookups (find production from generated vouchers)
CREATE INDEX IF NOT EXISTS idx_prod_links_consumption_voucher
  ON erp.production_generated_links(consumption_voucher_id);

CREATE INDEX IF NOT EXISTS idx_prod_links_labour_voucher
  ON erp.production_generated_links(labour_voucher_id);

-- Consumption voucher header extension (1:1 per production voucher)
CREATE TABLE IF NOT EXISTS erp.consumption_header (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  source_production_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  UNIQUE (source_production_id) -- enforce one consumption voucher per production voucher
);

-- Labour voucher header extension (1:1 per production voucher)
CREATE TABLE IF NOT EXISTS erp.labour_voucher_header (
  voucher_id           bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  source_production_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  UNIQUE (source_production_id) -- enforce one labour voucher per production voucher
);

-- Helpful for reports and drill-down screens
CREATE INDEX IF NOT EXISTS idx_consumption_header_source_production
  ON erp.consumption_header(source_production_id);

CREATE INDEX IF NOT EXISTS idx_labour_voucher_header_source_production
  ON erp.labour_voucher_header(source_production_id);

-- Labour voucher line extension:
-- dept tagging is not present on base voucher_line, so keep it here.
-- NOTE: sku_id is already present in voucher_line (when line_kind='SKU'), so do not duplicate it here.
CREATE TABLE IF NOT EXISTS erp.labour_voucher_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  dept_id         bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------
-- Production Planning (does NOT post stock/GL)
-- ---------------------------------------------------------------------
-- Plan FG/SFG production in advance.
-- Pending Consumption report derives RM requirements from plan lines + BOM.
CREATE TABLE IF NOT EXISTS erp.production_plan_header (
  voucher_id bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  plan_kind  erp.production_kind NOT NULL   -- FG or SFG (shown on header)
);

CREATE TABLE IF NOT EXISTS erp.production_plan_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  is_packed       boolean NOT NULL DEFAULT false,  -- false=LOOSE, true=PACKED (entry mode)
  total_pairs     int NOT NULL CHECK (total_pairs > 0)
);

-- ---------------------------------------------------------------------
-- Abnormal Loss voucher (one voucher type; loss_type per line)
-- ---------------------------------------------------------------------
-- One voucher type for losses; each line carries loss_type:
--   RM_LOSS / SFG_LOSS / FG_LOSS / DVC_ABANDON
--
-- This file defines the extension tables only.
-- Validations and posting rules are enforced by backend and/or integrity_checks.sql:
--   - DVC_ABANDON requires dept_id
--   - DVC_ABANDON requires voucher_line.line_kind = 'SKU'
--   - DVC_ABANDON qty_pairs <= wip_dept_balance.qty_pairs for (branch, sku, dept)
--   - RM losses may allow decimal qty; SKU losses should be whole pairs
--
-- Posting:
--   - RM/SFG/FG loss => stock ledger OUT + GL at cost
--   - DVC_ABANDON    => WIP pool OUT + GL only (no stock ledger)
CREATE TABLE IF NOT EXISTS erp.abnormal_loss_header (
  voucher_id     bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  -- Dependency: erp.reason_codes must exist before applying this FK.
  reason_code_id bigint REFERENCES erp.reason_codes(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp.abnormal_loss_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
  loss_type       erp.loss_type NOT NULL,
  dept_id         bigint REFERENCES erp.departments(id) ON DELETE RESTRICT -- required for DVC_ABANDON (enforced later)
);

-- Report filters: loss type and dept
CREATE INDEX IF NOT EXISTS idx_abnormal_loss_line_type_dept
  ON erp.abnormal_loss_line(loss_type, dept_id);
