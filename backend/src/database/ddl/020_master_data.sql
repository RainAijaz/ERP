-- 3) MASTER DATA: UOM, groups/subgroups, dimensions, accounts/parties, products/SKUs

-- 3.1 UOM & dimensions
CREATE TABLE IF NOT EXISTS uom (
  id   bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE, -- PCS/DOZEN/KG/METER
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS product_groups (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS product_subgroups (
  id       bigserial PRIMARY KEY,
  group_id bigint NOT NULL REFERENCES product_groups(id) ON DELETE RESTRICT,
  name     text NOT NULL,
  UNIQUE(group_id, name)
);

CREATE TABLE IF NOT EXISTS sizes (id bigserial PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS colors (id bigserial PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS grades (id bigserial PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS packing_types (id bigserial PRIMARY KEY, name text NOT NULL UNIQUE);

-- 3.2 Accounts & Parties
CREATE TABLE IF NOT EXISTS account_groups (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS accounts (
  id           bigserial PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  type         text NOT NULL, -- Expense/Income/Asset/Liability/Capital
  group_id     bigint REFERENCES account_groups(id),
  is_active    boolean NOT NULL DEFAULT true,
  lock_posting boolean NOT NULL DEFAULT false,
  created_by   bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  bigint REFERENCES users(id),
  approved_at  timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by) -- maker-checker for approvals if used
);

-- Accounts allocated to multiple branches (per your spec)
CREATE TABLE IF NOT EXISTS account_branch (
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  branch_id  bigint NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, branch_id)
);

CREATE TABLE IF NOT EXISTS party_groups (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS parties (
  id             bigserial PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  party_type     text NOT NULL, -- Customer/Supplier/Both
  address        text,
  phone1         text,
  phone2         text,
  city           text,
  group_id       bigint REFERENCES party_groups(id),
  credit_allowed boolean NOT NULL DEFAULT false,
  credit_limit   numeric(18,2) NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     bigint REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    bigint REFERENCES users(id),
  approved_at    timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE INDEX IF NOT EXISTS ix_parties_group ON parties(group_id);

-- 3.3 Departments (accounting + production)
CREATE TABLE IF NOT EXISTS departments (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  is_production boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true
);

-- 3.4 Items (RM/SFG/FG)
CREATE TABLE IF NOT EXISTS items (
  id           bigserial PRIMARY KEY,
  item_type    erp.item_type NOT NULL, -- RM/SFG/FG
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  group_id     bigint REFERENCES product_groups(id),
  subgroup_id  bigint REFERENCES product_subgroups(id),
  base_uom_id  bigint NOT NULL REFERENCES uom(id),
  is_active    boolean NOT NULL DEFAULT true,
  min_stock_level numeric(18,3) NOT NULL DEFAULT 0, -- mainly RM; harmless for others
  created_by   bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  bigint REFERENCES users(id),
  approved_at  timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE INDEX IF NOT EXISTS ix_items_type ON items(item_type);
CREATE INDEX IF NOT EXISTS ix_items_group ON items(group_id, subgroup_id);

-- 3.5 Finished product variants + SKU table (global SKUs, branch stock separate)
CREATE TABLE IF NOT EXISTS variants (
  id              bigserial PRIMARY KEY,
  fg_item_id       bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  size_id          bigint REFERENCES sizes(id),
  grade_id         bigint REFERENCES grades(id),
  color_id         bigint REFERENCES colors(id),
  packing_type_id  bigint REFERENCES packing_types(id),
  sale_rate        numeric(18,2) NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       bigint REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by      bigint REFERENCES users(id),
  approved_at      timestamptz,
  UNIQUE (fg_item_id, size_id, grade_id, color_id, packing_type_id),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE IF NOT EXISTS skus (
  id         bigserial PRIMARY KEY,
  variant_id bigint NOT NULL REFERENCES variants(id) ON DELETE RESTRICT,
  sku_code   text NOT NULL UNIQUE,
  barcode    text,
  is_active  boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS ix_skus_variant ON skus(variant_id);

-- 3.6 Raw material purchase rates (approval-controlled; color-specific)
CREATE TABLE IF NOT EXISTS rm_rate_header (
  id             bigserial PRIMARY KEY,
  rm_item_id     bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  status         erp.voucher_status NOT NULL DEFAULT 'DRAFT',
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  created_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    bigint REFERENCES users(id),
  approved_at    timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE IF NOT EXISTS rm_rate_line (
  id            bigserial PRIMARY KEY,
  header_id     bigint NOT NULL REFERENCES rm_rate_header(id) ON DELETE CASCADE,
  color_id      bigint REFERENCES colors(id),
  purchase_rate numeric(18,4) NOT NULL,
  UNIQUE(header_id, color_id)
);

CREATE INDEX IF NOT EXISTS ix_rm_rate_header_item_status ON rm_rate_header(rm_item_id, status);

-- 3.7 Global stock status rule (packed/loose)
CREATE TABLE IF NOT EXISTS stock_status_rule (
  id               smallint PRIMARY KEY DEFAULT 1,
  packed_unit_code text NOT NULL DEFAULT 'DOZEN',
  loose_unit_code  text NOT NULL DEFAULT 'PAIR',
  packed_pairs_per_unit int NOT NULL DEFAULT 12,
  packed_qty_step  numeric(18,3) NOT NULL DEFAULT 0.5, -- 0.5 dozen allowed
  enforced          boolean NOT NULL DEFAULT true
);
