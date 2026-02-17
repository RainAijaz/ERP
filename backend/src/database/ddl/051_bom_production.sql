SET search_path = erp;

-- =============================================================================
-- 051_bom_production.sql
-- =============================================================================
-- BOM (global, versioned, maker-checker, variant rules)
--   - BOM is global (same for all branches) => no branch_id
--   - Maker-checker statuses: DRAFT -> PENDING -> APPROVED/REJECTED
--   - RM lines can be color-specific (aligned with color-specific RM purchase rates)
--
-- Integrity rules enforced in integrity_checks.sql:
--   - bom_header.item_id must be FG/SFG only (RM not allowed)
--   - bom_header.level must match item_type:
--       FINISHED      => item_type = FG
--       SEMI_FINISHED => item_type = SFG
-- =============================================================================

/* ---------------------------
   Small enums to prevent drift
----------------------------*/
DO $$ BEGIN
  CREATE TYPE erp.bom_scope AS ENUM ('ALL','SPECIFIC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.labour_rate_type AS ENUM ('PER_DOZEN','PER_PAIR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.bom_rule_action_type AS ENUM ('ADD_RM','REMOVE_RM','REPLACE_RM','ADJUST_QTY','CHANGE_LOSS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.bom_status AS ENUM ('DRAFT','PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- bom_header
-- -----------------------------------------------------------------------------
-- One BOM document per item/level/version.
-- item_id points to the produced article (FG or SFG).
-- level indicates whether this is a FINISHED BOM or SEMI_FINISHED BOM.
-- NOTE: level<->item_type alignment is enforced in integrity_checks.sql (trigger).
CREATE TABLE IF NOT EXISTS erp.bom_header (
  id             bigserial PRIMARY KEY,
  bom_no         text NOT NULL UNIQUE, -- document number shown in UI

  item_id        bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
  level          erp.bom_level NOT NULL, -- FINISHED / SEMI_FINISHED

  -- Recipe is defined for this output quantity (batch size).
  output_qty     numeric(18,3) NOT NULL DEFAULT 1,
  output_uom_id  bigint NOT NULL REFERENCES erp.uom(id),

  status         erp.bom_status NOT NULL DEFAULT 'DRAFT',
  version_no     int NOT NULL DEFAULT 1,

  created_by     bigint NOT NULL REFERENCES erp.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    bigint REFERENCES erp.users(id),
  approved_at    timestamptz,

  CHECK (output_qty > 0),
  CHECK (version_no > 0),

  -- Maker-checker consistency:
  CHECK (
    (status IN ('DRAFT','PENDING') AND approved_by IS NULL AND approved_at IS NULL)
    OR
    (status IN ('APPROVED','REJECTED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),

  UNIQUE (item_id, level, version_no)
);

CREATE INDEX IF NOT EXISTS ix_bom_header_item_status
ON erp.bom_header(item_id, status);

-- One active draft per item+level across the system.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_header_single_draft
ON erp.bom_header (item_id, level)
WHERE status = 'DRAFT';

-- -----------------------------------------------------------------------------
-- bom_rm_line (RM consumption lines)
-- -----------------------------------------------------------------------------
-- RM lines can be color-specific to support:
--   - stock available by color
--   - cost differences by color
CREATE TABLE IF NOT EXISTS erp.bom_rm_line (
  id              bigserial PRIMARY KEY,
  bom_id          bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  rm_item_id      bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
  color_id        bigint REFERENCES erp.colors(id),
  size_id         bigint REFERENCES erp.sizes(id),
  dept_id         bigint NOT NULL REFERENCES erp.departments(id),

  qty             numeric(18,3) NOT NULL,
  uom_id          bigint NOT NULL REFERENCES erp.uom(id),

  normal_loss_pct numeric(6,3) NOT NULL DEFAULT 0,

  CHECK (qty > 0),
  CHECK (normal_loss_pct >= 0 AND normal_loss_pct <= 100),

  -- Avoid duplicates for same RM+dept within one BOM (color-specific if provided).
  UNIQUE (bom_id, rm_item_id, dept_id, color_id, size_id)
);

-- -----------------------------------------------------------------------------
-- bom_sfg_line (SFG consumption lines varying by finished size)
-- -----------------------------------------------------------------------------
-- Finished BOM can consume SFG SKUs, and required mapping may vary by FG size.
-- ref_approved_bom_id is intended to point to the APPROVED BOM of the SFG item.
-- Status+item matching is enforced later in integrity_checks.sql (trigger).
CREATE TABLE IF NOT EXISTS erp.bom_sfg_line (
  id                  bigserial PRIMARY KEY,
  bom_id              bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  -- Which FINISHED size does this line apply to?
  fg_size_id          bigint NOT NULL REFERENCES erp.sizes(id),

  -- Which SFG SKU is consumed (SFG has SKUs in your design)
  sfg_sku_id          bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,

  required_qty        numeric(18,3) NOT NULL,
  uom_id              bigint NOT NULL REFERENCES erp.uom(id),

  -- Intended to reference the APPROVED BOM of the SFG item behind sfg_sku_id
  ref_approved_bom_id bigint REFERENCES erp.bom_header(id),

  CHECK (required_qty > 0),

  UNIQUE (bom_id, fg_size_id, sfg_sku_id)
);

-- -----------------------------------------------------------------------------
-- bom_labour_line (rates for BOM costing + DCV)
-- -----------------------------------------------------------------------------
-- Labour cost lines can apply to ALL sizes or a SPECIFIC finished size.
-- rate_type tells whether this rate is per PAIR or per DOZEN.
CREATE TABLE IF NOT EXISTS erp.bom_labour_line (
  id          bigserial PRIMARY KEY,
  bom_id      bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  size_scope  erp.bom_scope NOT NULL DEFAULT 'ALL',
  size_id     bigint REFERENCES erp.sizes(id),

  dept_id     bigint NOT NULL REFERENCES erp.departments(id),
  labour_id   bigint NOT NULL REFERENCES erp.labours(id) ON DELETE RESTRICT,

  rate_type   erp.labour_rate_type NOT NULL DEFAULT 'PER_PAIR',
  rate_value  numeric(18,4) NOT NULL,

  CHECK (rate_value >= 0),
  CHECK (
    (size_scope = 'ALL' AND size_id IS NULL)
    OR
    (size_scope = 'SPECIFIC' AND size_id IS NOT NULL)
  ),

  UNIQUE (bom_id, dept_id, labour_id, size_scope, size_id, rate_type)
);

-- -----------------------------------------------------------------------------
-- bom_variant_rule (rules apply to PRODUCT variant dimensions, not RM variants)
-- -----------------------------------------------------------------------------
-- Rules adjust RM consumption/loss based on finished variant dimensions.
-- action_type + new_value is interpreted by your BOM engine (app logic).
CREATE TABLE IF NOT EXISTS erp.bom_variant_rule (
  id                 bigserial PRIMARY KEY,
  bom_id             bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  size_scope         erp.bom_scope NOT NULL DEFAULT 'ALL',
  size_id            bigint REFERENCES erp.sizes(id),

  packing_scope      erp.bom_scope NOT NULL DEFAULT 'ALL',
  packing_type_id    bigint REFERENCES erp.packing_types(id),

  color_scope        erp.bom_scope NOT NULL DEFAULT 'ALL',
  color_id           bigint REFERENCES erp.colors(id),

  action_type        erp.bom_rule_action_type NOT NULL,

  material_scope     erp.bom_scope NOT NULL,
  target_rm_item_id  bigint REFERENCES erp.items(id),

  new_value          jsonb NOT NULL DEFAULT '{}'::jsonb,

  CHECK (
    (size_scope = 'ALL' AND size_id IS NULL)
    OR
    (size_scope = 'SPECIFIC' AND size_id IS NOT NULL)
  ),
  CHECK (
    (packing_scope = 'ALL' AND packing_type_id IS NULL)
    OR
    (packing_scope = 'SPECIFIC' AND packing_type_id IS NOT NULL)
  ),
  CHECK (
    (color_scope = 'ALL' AND color_id IS NULL)
    OR
    (color_scope = 'SPECIFIC' AND color_id IS NOT NULL)
  ),
  CHECK (
    (material_scope = 'ALL' AND target_rm_item_id IS NULL)
    OR
    (material_scope = 'SPECIFIC' AND target_rm_item_id IS NOT NULL)
  )
);

-- Uniqueness for variant rules (prevents duplicate/ambiguous rules).
-- Uses COALESCE to treat NULL ids as a stable "bucket" for uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_variant_rule_unique
ON erp.bom_variant_rule (
  bom_id,
  size_scope,        COALESCE(size_id, 0),
  packing_scope,     COALESCE(packing_type_id, 0),
  color_scope,       COALESCE(color_id, 0),
  action_type,
  material_scope,    COALESCE(target_rm_item_id, 0)
);

-- -----------------------------------------------------------------------------
-- bom_change_log (immutable line-level audit trail)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.bom_change_log (
  id          bigserial PRIMARY KEY,
  bom_id      bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,
  version_no  int NOT NULL,
  request_id  bigint REFERENCES erp.approval_request(id) ON DELETE SET NULL,
  section     text NOT NULL,
  entity_key  text NOT NULL,
  change_type text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  changed_by  bigint REFERENCES erp.users(id) ON DELETE SET NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (change_type IN ('ADDED', 'UPDATED', 'REMOVED'))
);

CREATE INDEX IF NOT EXISTS idx_bom_change_log_bom_version
ON erp.bom_change_log (bom_id, version_no, changed_at DESC);
