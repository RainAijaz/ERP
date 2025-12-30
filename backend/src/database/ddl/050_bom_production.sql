-- 6) BOM (versioned, approvals, variant rules)

CREATE TABLE IF NOT EXISTS bom_header (
  id             bigserial PRIMARY KEY,
  bom_no         text NOT NULL UNIQUE,
  item_id        bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT, -- FG or SFG article
  level          erp.bom_level NOT NULL,
  output_qty     numeric(18,3) NOT NULL DEFAULT 1,
  output_uom_id  bigint NOT NULL REFERENCES uom(id),
  status         erp.voucher_status NOT NULL DEFAULT 'DRAFT',
  version_no     int NOT NULL,
  created_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    bigint REFERENCES users(id),
  approved_at    timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  UNIQUE(item_id, level, version_no)
);

CREATE INDEX IF NOT EXISTS ix_bom_header_item_status ON bom_header(item_id, status);

CREATE TABLE IF NOT EXISTS bom_rm_line (
  id              bigserial PRIMARY KEY,
  bom_id          bigint NOT NULL REFERENCES bom_header(id) ON DELETE CASCADE,
  rm_item_id      bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  color_id        bigint REFERENCES colors(id),
  dept_id         bigint NOT NULL REFERENCES departments(id),
  qty             numeric(18,3) NOT NULL,
  uom_id          bigint NOT NULL REFERENCES uom(id),
  normal_loss_pct numeric(6,3) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bom_sfg_line (
  id                  bigserial PRIMARY KEY,
  bom_id              bigint NOT NULL REFERENCES bom_header(id) ON DELETE CASCADE,
  sfg_item_id         bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  required_qty        numeric(18,3) NOT NULL,
  uom_id              bigint NOT NULL REFERENCES uom(id),
  ref_approved_bom_id bigint REFERENCES bom_header(id) -- enforce APPROVED in app/backend
);

-- Labour master + rates (used by BOM costing and DCV)
CREATE TABLE IF NOT EXISTS labours (
  id       bigserial PRIMARY KEY,
  code     text NOT NULL UNIQUE,
  name     text NOT NULL,
  cnic     text,
  phone    text,
  production_category text, -- finished/semi-finished (flex)
  dept_id  bigint REFERENCES departments(id),
  status   text NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS bom_labour_line (
  id          bigserial PRIMARY KEY,
  bom_id      bigint NOT NULL REFERENCES bom_header(id) ON DELETE CASCADE,
  size_scope  text NOT NULL DEFAULT 'ALL', -- ALL/SPECIFIC
  size_id     bigint REFERENCES sizes(id),
  dept_id     bigint NOT NULL REFERENCES departments(id),
  labour_id   bigint NOT NULL REFERENCES labours(id) ON DELETE RESTRICT,
  rate_type   text NOT NULL, -- PER_DOZEN / PER_PAIR
  rate_value  numeric(18,4) NOT NULL,
  -- total is calculated by app using header output_qty; never stored as editable
  CHECK (
    (size_scope = 'ALL' AND size_id IS NULL)
    OR (size_scope = 'SPECIFIC' AND size_id IS NOT NULL)
  )
);

-- Variant rules (normalized)
CREATE TABLE IF NOT EXISTS bom_variant_rule (
  id            bigserial PRIMARY KEY,
  bom_id        bigint NOT NULL REFERENCES bom_header(id) ON DELETE CASCADE,

  size_scope    text NOT NULL DEFAULT 'ALL', -- ALL/SPECIFIC
  size_id       bigint REFERENCES sizes(id),
  packing_scope text NOT NULL DEFAULT 'ALL',
  packing_type_id bigint REFERENCES packing_types(id),
  color_scope   text NOT NULL DEFAULT 'ALL',
  color_id      bigint REFERENCES colors(id),

  action_type   text NOT NULL, -- ADD_RM/REMOVE_RM/REPLACE_RM/ADJUST_QTY/CHANGE_LOSS
  material_scope text NOT NULL, -- ALL/GROUP/SINGLE
  target_rm_item_id bigint REFERENCES items(id),
  target_group_id   bigint REFERENCES product_groups(id),

  new_value     jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. { "qty": 1.2 } or { "pct": 5 } or { "loss_pct": 2.5 } or replace map
  CHECK (
    (size_scope = 'ALL' AND size_id IS NULL) OR (size_scope = 'SPECIFIC' AND size_id IS NOT NULL)
  )
);

-- Wire voucher_line FK to labours/employees after employees exist later (employee table below)
DO $$ BEGIN
  ALTER TABLE voucher_line
    ADD CONSTRAINT fk_voucher_line_labour
    FOREIGN KEY (labour_id) REFERENCES labours(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


