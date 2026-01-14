SET search_path = erp;

-- =============================================================================
-- 6) BOM (global, versioned, maker-checker, variant rules)
--   - BOM is SAME for all branches (no branch_id here)
--   - RM has NO color/size dimension anymore (so bom_rm_line has NO color_id)
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



-- -----------------------------------------------------------------------------
-- bom_header
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.bom_header (
  id             bigserial PRIMARY KEY,
  bom_no         text NOT NULL UNIQUE, -- document number shown in UI

  item_id        bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT, -- FG or SFG article
  level          erp.bom_level NOT NULL,

  output_qty     numeric(18,3) NOT NULL DEFAULT 1, ---- recipe is defined for this output quantity (the “batch size” of the BOM)
  output_uom_id  bigint NOT NULL REFERENCES erp.uom(id),

  -- Using approval_status enum, but BOM should not be POSTED
  status         erp.approval_status NOT NULL DEFAULT 'approval_status',
  version_no     int NOT NULL DEFAULT 1,

  created_by     bigint NOT NULL REFERENCES erp.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    bigint REFERENCES erp.users(id),
  approved_at    timestamptz,

  CHECK (output_qty > 0),
  CHECK (version_no > 0),
  CHECK (approved_by IS NULL OR approved_by <> created_by),

  -- Limit statuses for BOM (no POSTED)
  CHECK (status IN ('approval_status','PENDING','APPROVED','REJECTED')),

  -- Approval consistency:
  -- - approval_status/Pending => no approver fields
  -- - Approved/Rejected => approver fields must exist
  CHECK (
    (status IN ('approval_status','PENDING') AND approved_by IS NULL AND approved_at IS NULL)
    OR
    (status IN ('APPROVED','REJECTED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),

  UNIQUE (item_id, level, version_no)
);

CREATE INDEX IF NOT EXISTS ix_bom_header_item_status
ON erp.bom_header(item_id, status);


-- -----------------------------------------------------------------------------
-- bom_rm_line (NO color_id now)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.bom_rm_line (
  id              bigserial PRIMARY KEY,
  bom_id          bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  rm_item_id      bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
  dept_id         bigint NOT NULL REFERENCES erp.departments(id),

  qty             numeric(18,3) NOT NULL,
  uom_id          bigint NOT NULL REFERENCES erp.uom(id),

  normal_loss_pct numeric(6,3) NOT NULL DEFAULT 0,

  CHECK (qty > 0),
  CHECK (normal_loss_pct >= 0 AND normal_loss_pct <= 100),

  -- avoid duplicate same RM in same dept for same BOM (adjust if you need duplicates)
  UNIQUE (bom_id, rm_item_id, dept_id)
);
-- IF AN ARTICLE HAS MULTIPLE COLORS THEN DOES ITS SEMI FINISHED ITEM HAS MULTIPLE COLORS AS WELL? 
-- (WHY IMPORTANT - TO KNOW HOW MUCH STOCK IS AVAILABLE IN EACH COLOR, AND PRICE DIFFERENCE IF ANY)
-- SFG consumption lines that can vary by Finished size
CREATE TABLE IF NOT EXISTS erp.bom_sfg_line (
  id              bigserial PRIMARY KEY,
  bom_id          bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  -- Which FINISHED size does this line apply to?
  fg_size_id      bigint NOT NULL REFERENCES erp.sizes(id),      

  -- Which SFG size/variant is consumed (SFG has SKUs in your design)
  sfg_sku_id      bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,

  required_qty    numeric(18,3) NOT NULL,
  uom_id          bigint NOT NULL REFERENCES erp.uom(id),

  -- link to the APPROVED BOM of that SFG item 
  ref_approved_bom_id bigint REFERENCES erp.bom_header(id),

  CHECK (required_qty > 0),
  -- Avoid duplicates for same mapping inside one BOM
  UNIQUE (bom_id, fg_size_id, sfg_sku_id)
);
-- -----------------------------------------------------------------------------
-- bom_labour_line (rates for BOM costing + DCV)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.bom_labour_line (
  id          bigserial PRIMARY KEY,
  bom_id      bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  -- applies to all sizes or a specific size (FG variant size)
  size_scope  erp.bom_scope NOT NULL DEFAULT 'ALL',
  size_id     bigint REFERENCES erp.sizes(id),

  dept_id     bigint NOT NULL REFERENCES erp.departments(id),
  labour_id   bigint NOT NULL REFERENCES erp.labours(id) ON DELETE RESTRICT,

  -- tells whether this rate is priced per PAIR or per DOZEN (cannot be inferred from output_qty)
  rate_type   erp.labour_rate_type NOT NULL DEFAULT 'PER_PAIR',

  rate_value  numeric(18,4) NOT NULL,
  CHECK (rate_value >= 0),
  CHECK (
    (size_scope = 'ALL' AND size_id IS NULL)
    OR
    (size_scope = 'SPECIFIC' AND size_id IS NOT NULL)
  ),

  -- avoid duplicates
  UNIQUE (bom_id, dept_id, labour_id, size_scope, size_id, rate_type)
);


-- -----------------------------------------------------------------------------
-- bom_variant_rule (rules apply to PRODUCT variants, not RM variants)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.bom_variant_rule (
  id               bigserial PRIMARY KEY,
  bom_id           bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,

  size_scope       erp.bom_scope NOT NULL DEFAULT 'ALL',
  size_id          bigint REFERENCES erp.sizes(id),

  packing_scope    erp.bom_scope NOT NULL DEFAULT 'ALL',
  packing_type_id  bigint REFERENCES erp.packing_types(id),

  color_scope      erp.bom_scope NOT NULL DEFAULT 'ALL',
  color_id         bigint REFERENCES erp.colors(id),

  action_type      erp.bom_rule_action_type NOT NULL,   --  E.G. ADJUST_QTY:    { "qty": 1.2 },  CHANGE_LOSS:   { "loss_pct": 2.5 }
  material_scope   erp.bom_scope NOT NULL,
  target_rm_item_id bigint REFERENCES erp.items(id),   -- target of the rule (depends on material_scope)
  new_value        jsonb NOT NULL DEFAULT '{}'::jsonb,

  CHECK (
    (size_scope = 'ALL' AND size_id IS NULL) OR (size_scope = 'SPECIFIC' AND size_id IS NOT NULL)
  ),
  CHECK (
    (packing_scope = 'ALL' AND packing_type_id IS NULL) OR (packing_scope = 'SPECIFIC' AND packing_type_id IS NOT NULL)
  ),
  CHECK (
    (color_scope = 'ALL' AND color_id IS NULL) OR (color_scope = 'SPECIFIC' AND color_id IS NOT NULL)
  ),
  CHECK (
    (material_scope = 'ALL'   AND target_rm_item_id IS NULL) OR   (material_scope = 'SPECIFIC' AND target_rm_item_id IS NOT NULL )
  )
);

-- =============================================================================
-- Wire voucher_line.labour_id FK (safe rerunnable block)
-- =============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_voucher_line_labour'
      AND conrelid = 'erp.voucher_line'::regclass
  ) THEN
    ALTER TABLE erp.voucher_line
      ADD CONSTRAINT fk_voucher_line_labour
      FOREIGN KEY (labour_id) REFERENCES erp.labours(id) ON DELETE RESTRICT;
  END IF;
END $$;

