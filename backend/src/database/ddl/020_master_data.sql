-- =============================================================================
-- 020_master_data.sql
-- PURPOSE
--   Master/setup tables that rarely change day-to-day:
--     - Units of Measure (UOM)
--     - Product grouping (groups/subgroups) + shoe category
--     - Variant dimensions (size/color/grade/packing)
--     - Chart of Accounts structure (account subgroups + accounts + branch mapping)
--     - Parties (customers/suppliers) + party groups
--     - Departments (production + non-production)
--     - Items master (RM/SFG/FG)
--     - Variants + SKUs (supports BOTH FG and SFG variants)
--     - Raw material purchase rates (approval-controlled; color-specific)
--     - Employees + branch mapping
--     - Labours + branch mapping
-- =============================================================================

SET search_path = erp;

-- =============================================================================
-- UOM (UNITS OF MEASURE)
-- =============================================================================

-- Units of Measure used across the ERP (PCS, DOZEN, KG, METER, PAIR, etc.)
-- code is the short stable code used in UI/reports; name is the human label.
CREATE TABLE IF NOT EXISTS erp.uom (
  id   bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  name_ur text,
  is_active boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz
);

-- Unit conversions (e.g., 1 BOX = 10 PCS)
CREATE TABLE IF NOT EXISTS erp.uom_conversions (
  id           bigserial PRIMARY KEY,
  from_uom_id  bigint NOT NULL REFERENCES erp.uom(id) ON DELETE RESTRICT,
  to_uom_id    bigint NOT NULL REFERENCES erp.uom(id) ON DELETE RESTRICT,
  factor       numeric(18,6) NOT NULL,
  created_by   bigint REFERENCES erp.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  is_active    boolean NOT NULL DEFAULT true,
  updated_by   bigint REFERENCES erp.users(id),
  updated_at   timestamptz,

  CHECK (factor > 0),
  CHECK (from_uom_id <> to_uom_id),
  UNIQUE (from_uom_id, to_uom_id)
);

-- =============================================================================
-- PRODUCT GROUPING (GROUPS / SUBGROUPS / SHOE CATEGORY)
-- =============================================================================

-- High-level product groups (e.g., EVA / PU / PCU / Footwear).
-- applies_* flags allow hiding irrelevant groups in RM/SFG/FG screens.
CREATE TABLE IF NOT EXISTS erp.product_groups (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  name_ur       text NOT NULL UNIQUE,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    bigint REFERENCES erp.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint REFERENCES erp.users(id),
  updated_at    timestamptz
);

-- Mapping table for product group applicability (RM/SFG/FG).
CREATE TABLE IF NOT EXISTS erp.product_group_item_types (
  group_id  bigint NOT NULL REFERENCES erp.product_groups(id) ON DELETE CASCADE,
  item_type erp.item_type NOT NULL,
  PRIMARY KEY (group_id, item_type)
);

-- Mapping table for product sub-group applicability (RM/SFG/FG).
CREATE TABLE IF NOT EXISTS erp.product_subgroup_item_types (
  subgroup_id bigint NOT NULL REFERENCES erp.product_subgroups(id) ON DELETE CASCADE,
  item_type   erp.item_type NOT NULL,
  PRIMARY KEY (subgroup_id, item_type)
);

-- Product subgroup within a group 
-- code is a stable snake_case key to prevent drift/typos across UI and backend.
CREATE TABLE IF NOT EXISTS erp.product_subgroups (
  id        bigserial PRIMARY KEY,
  group_id  bigint REFERENCES erp.product_groups(id) ON DELETE RESTRICT,
  code      text NOT NULL,          -- stable key (snake_case)
  name      text NOT NULL,          -- display name
  name_ur   text,
  is_active boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz,

  UNIQUE (group_id, code),
  UNIQUE (group_id, name),

  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,80}$')
);

-- Shoe category / audience segmentation (men, women, boys, girls, unisex).
-- code is a stable snake_case key for consistent filtering and reporting.
CREATE TABLE IF NOT EXISTS erp.product_types (
  id        bigserial PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  name      text NOT NULL UNIQUE,
  name_ur   text,
  is_active boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz,
  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,40}$')
);

-- =============================================================================
-- VARIANT DIMENSIONS (USED BY FG + SFG SKUs)
-- =============================================================================

-- NOTE: storing size as text supports values like "7/10", "9/10", "40", "41", etc.
CREATE TABLE IF NOT EXISTS erp.sizes (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  name_ur text,
  is_active  boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz
);

-- Size applicability (RM/SFG/FG). Allows one size to be used in multiple item types.
CREATE TABLE IF NOT EXISTS erp.size_item_types (
  size_id  bigint NOT NULL REFERENCES erp.sizes(id) ON DELETE CASCADE,
  item_type erp.item_type NOT NULL,
  PRIMARY KEY (size_id, item_type)
);

CREATE TABLE IF NOT EXISTS erp.colors (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  name_ur text,
  is_active  boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS erp.grades (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  name_ur text,
  is_active  boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS erp.packing_types (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  name_ur text,
  is_active  boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz
);

-- =============================================================================
-- ACCOUNTS (COA STRUCTURE) + ACCOUNT-BRANCH MAPPING
-- =============================================================================

-- Account groups: a flexible layer under the fixed erp.account_type enum.
-- Example: ASSET -> cash_bank, receivables, inventory; EXPENSE -> salaries, utilities, etc.
CREATE TABLE IF NOT EXISTS erp.account_groups (
  id         bigserial PRIMARY KEY,
  account_type erp.account_type NOT NULL,
  code       text NOT NULL,               -- stable key (snake_case)
  name       text NOT NULL,
  name_ur    text,
  is_contra  boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz,

  UNIQUE (account_type, code),
  UNIQUE (account_type, name),

  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,80}$')
);

-- Accounts master (Chart of Accounts).
-- created_by/approved_by fields support maker-checker for master data.
CREATE TABLE IF NOT EXISTS erp.accounts (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL UNIQUE,
  name_ur       text,
  subgroup_id   bigint NOT NULL REFERENCES erp.account_groups(id) ON DELETE RESTRICT,

  is_active     boolean NOT NULL DEFAULT true,
  lock_posting  boolean NOT NULL DEFAULT false, -- if true, app should block postings to this account

  created_by    bigint REFERENCES erp.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint REFERENCES erp.users(id),
  updated_at    timestamptz,
  approved_by   bigint REFERENCES erp.users(id),
  approved_at   timestamptz,

  -- Maker-checker: approver cannot be the creator.
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

-- Optional: restrict which accounts can be used in which branch (if your business requires it).
CREATE TABLE IF NOT EXISTS erp.account_branch (
  account_id bigint NOT NULL REFERENCES erp.accounts(id)  ON DELETE CASCADE,
  branch_id  bigint NOT NULL REFERENCES erp.branches(id)  ON DELETE CASCADE,
  PRIMARY KEY (account_id, branch_id)
);

-- =============================================================================
-- PARTIES (CUSTOMERS / SUPPLIERS) + PARTY GROUPS
-- =============================================================================

-- City master (for party addresses + filters).
CREATE TABLE IF NOT EXISTS erp.cities (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  name_ur    text,
  is_active  boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz
);

-- Party groups (e.g., Wholesale, Retail, Suppliers - Leather, etc.)
CREATE TABLE IF NOT EXISTS erp.party_groups (
  id         bigserial PRIMARY KEY,
  party_type erp.party_type NOT NULL DEFAULT 'BOTH',
  name       text NOT NULL UNIQUE,
  name_ur    text,
  is_active  boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES erp.users(id),
  updated_at timestamptz
);

-- Parties master.
-- branch_id enforces master-data isolation per branch (matches your rule).
-- Credit rules are enforced for customers only via CHECK constraints.
CREATE TABLE IF NOT EXISTS erp.parties (
  id             bigserial PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name           text NOT NULL UNIQUE,
  name_ur        text,

  party_type     erp.party_type NOT NULL, -- CUSTOMER / SUPPLIER (or BOTH if you later add it)
  branch_id      bigint REFERENCES erp.branches(id) ON DELETE CASCADE,

  group_id       bigint REFERENCES erp.party_groups(id),

  city_id        bigint REFERENCES erp.cities(id),
  address        text,
  phone1         text,
  phone2         text,
  city           text,

  credit_allowed boolean NOT NULL DEFAULT false,
  credit_limit   numeric(18,2) NOT NULL DEFAULT 0,

  is_active      boolean NOT NULL DEFAULT true,

  created_by     bigint NOT NULL REFERENCES erp.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint REFERENCES erp.users(id),
  updated_at     timestamptz,
  approved_by    bigint REFERENCES erp.users(id),
  approved_at    timestamptz,

  -- Maker-checker: approver cannot be the creator.
  CHECK (approved_by IS NULL OR approved_by <> created_by),

  -- Credit rules removed to allow credit for suppliers if needed.
);

-- Ensure audit fields exist for existing databases.
ALTER TABLE IF EXISTS erp.accounts
  ADD COLUMN IF NOT EXISTS updated_by bigint REFERENCES erp.users(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

ALTER TABLE IF EXISTS erp.parties
  ADD COLUMN IF NOT EXISTS updated_by bigint REFERENCES erp.users(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Update party credit defaults (for new records).
ALTER TABLE IF EXISTS erp.parties
  ALTER COLUMN credit_allowed SET DEFAULT true,
  ALTER COLUMN credit_limit SET DEFAULT 500000;

-- Drop legacy credit check constraints (if present).
DO $$ DECLARE
  _constraint text;
BEGIN
  FOR _constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'erp.parties'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~* '(credit_allowed|credit_limit|party_type)'
  LOOP
    EXECUTE format('ALTER TABLE erp.parties DROP CONSTRAINT IF EXISTS %I', _constraint);
  END LOOP;
END $$;

-- =============================================================================
-- DEPARTMENTS (FOR HR + COST ALLOCATION)
-- =============================================================================

-- Departments represent "where cost happened" (production/non-production).
-- is_production helps separate production overhead vs non-production overhead in reports.
CREATE TABLE IF NOT EXISTS erp.departments (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  name_ur       text,
  is_production boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    bigint REFERENCES erp.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint REFERENCES erp.users(id),
  updated_at    timestamptz
);

-- =============================================================================
-- CASE-INSENSITIVE UNIQUENESS (DISPLAY NAMES + CODES)
-- =============================================================================
-- Enforce case-insensitive uniqueness for names/codes (e.g., "BALLMAN" vs "ballman").
CREATE UNIQUE INDEX IF NOT EXISTS uom_code_lower_uidx ON erp.uom (lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS uom_name_lower_uidx ON erp.uom (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS product_groups_name_lower_uidx ON erp.product_groups (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS product_subgroups_name_lower_uidx
ON erp.product_subgroups (COALESCE(group_id, 0), lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS product_subgroups_code_lower_uidx
ON erp.product_subgroups (COALESCE(group_id, 0), lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS product_types_code_lower_uidx ON erp.product_types (lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS product_types_name_lower_uidx ON erp.product_types (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS sizes_name_lower_uidx ON erp.sizes (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS colors_name_lower_uidx ON erp.colors (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS grades_name_lower_uidx ON erp.grades (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS packing_types_name_lower_uidx ON erp.packing_types (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS cities_name_lower_uidx ON erp.cities (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS account_groups_code_lower_uidx ON erp.account_groups (account_type, lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS account_groups_name_lower_uidx ON erp.account_groups (account_type, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS party_groups_name_lower_uidx ON erp.party_groups (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS departments_name_lower_uidx ON erp.departments (lower(name));

-- =============================================================================
-- ITEMS MASTER (RM / SFG / FG)
-- =============================================================================

-- Items master: core definitions for RM, SFG, and FG.
-- min_stock_level:
--   -1 => not maintained / ignore
--   >= 0 => reorder/min-level logic can be used in reports
CREATE TABLE IF NOT EXISTS erp.items (
  id               bigserial PRIMARY KEY,
  item_type        erp.item_type NOT NULL, -- RM / SFG / FG
  code             text NOT NULL,
  name             text NOT NULL,
  name_ur          text,

  group_id         bigint NOT NULL REFERENCES erp.product_groups(id),
  subgroup_id      bigint REFERENCES erp.product_subgroups(id),
  product_type_id  bigint REFERENCES erp.product_types(id),

  base_uom_id      bigint NOT NULL REFERENCES erp.uom(id),

  uses_sfg         boolean NOT NULL DEFAULT false,
  sfg_part_type    text,

  is_active        boolean NOT NULL DEFAULT true,
  min_stock_level  numeric(18,3) NOT NULL DEFAULT -1,

  created_by       bigint REFERENCES erp.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       bigint REFERENCES erp.users(id),
  updated_at       timestamptz,
  approved_by      bigint REFERENCES erp.users(id),
  approved_at      timestamptz,

  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (item_type = 'FG' OR (uses_sfg = false AND sfg_part_type IS NULL)),
  CHECK (sfg_part_type IS NULL OR sfg_part_type IN ('UPPER', 'STEP'))
);

ALTER TABLE IF EXISTS erp.items
  ADD COLUMN IF NOT EXISTS updated_by bigint REFERENCES erp.users(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Finished product usage of semi-finished items.
CREATE TABLE IF NOT EXISTS erp.item_usage (
  fg_item_id  bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
  sfg_item_id bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
  PRIMARY KEY (fg_item_id, sfg_item_id)
);

-- =============================================================================
-- VARIANTS + SKUs (FG + SFG)
-- =============================================================================

-- Variants represent a unique combination of dimensions for an item.
-- Dimensions are optional (NULL) because not every item uses all dimensions.
-- To prevent duplicates when some dimensions are NULL, we enforce uniqueness
-- using a COALESCE-based unique index below (not a plain UNIQUE constraint).
CREATE TABLE IF NOT EXISTS erp.variants (
  id              bigserial PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,

  size_id         bigint REFERENCES erp.sizes(id),
  grade_id        bigint REFERENCES erp.grades(id),
  color_id        bigint REFERENCES erp.colors(id),
  packing_type_id bigint REFERENCES erp.packing_types(id),

  -- sale_rate is kept here for convenience; app/business rules decide when it is editable/used.
  sale_rate       numeric(18,2) NOT NULL DEFAULT 0,

  is_active       boolean NOT NULL DEFAULT true,

  created_by      bigint REFERENCES erp.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint REFERENCES erp.users(id),
  updated_at      timestamptz DEFAULT CURRENT_TIMESTAMP, 
  approved_by     bigint REFERENCES erp.users(id),
  approved_at     timestamptz,

  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

-- Uniqueness for variants, treating NULL dimension IDs as 0.
-- Without this, Postgres would allow duplicates when any of the dimension columns are NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_variants_identity
ON erp.variants (
  item_id,
  COALESCE(size_id, 0),
  COALESCE(grade_id, 0),
  COALESCE(color_id, 0),
  COALESCE(packing_type_id, 0)
);

-- SKU: sellable/trackable code per variant (barcode optional).
CREATE TABLE IF NOT EXISTS erp.skus (
  id         bigserial PRIMARY KEY,
  variant_id bigint NOT NULL REFERENCES erp.variants(id) ON DELETE RESTRICT,
  sku_code   text NOT NULL UNIQUE,
  barcode    text,
  is_active  boolean NOT NULL DEFAULT true
);

-- =============================================================================
-- RAW MATERIAL PURCHASE RATES (COLOR-SPECIFIC)
-- =============================================================================

-- Optional: allow parties to be available in multiple branches.
CREATE TABLE IF NOT EXISTS erp.party_branch (
  party_id  bigint NOT NULL REFERENCES erp.parties(id) ON DELETE CASCADE,
  branch_id bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,
  PRIMARY KEY (party_id, branch_id)
);

-- RM purchase rates (as agreed: keep simple for now):
-- - color_id is NOT NULL (so every rate is color-specific)
-- - Exactly one rate per (rm_item_id, color_id)
-- NOTE: RM/SFG/FG enforcement (rm_item_id must be RM) will be implemented in integrity_checks.sql.
CREATE TABLE IF NOT EXISTS erp.rm_purchase_rates (
  id               bigserial PRIMARY KEY,
  rm_item_id       bigint NOT NULL REFERENCES erp.items(id) ON DELETE CASCADE,
  color_id         bigint REFERENCES erp.colors(id),
  size_id          bigint REFERENCES erp.sizes(id),

  purchase_rate     numeric(18,4) NOT NULL,
  avg_purchase_rate numeric(18,4) NOT NULL, -- keep in sync via triggers/app later

  is_active        boolean NOT NULL DEFAULT true,

  created_by       bigint NOT NULL REFERENCES erp.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by      bigint REFERENCES erp.users(id),
  approved_at      timestamptz,

  CHECK (purchase_rate >= 0),
  CHECK (avg_purchase_rate >= 0),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

ALTER TABLE IF EXISTS erp.rm_purchase_rates
  ADD COLUMN IF NOT EXISTS size_id bigint REFERENCES erp.sizes(id);

ALTER TABLE IF EXISTS erp.rm_purchase_rates
  DROP CONSTRAINT IF EXISTS rm_purchase_rates_rm_item_id_color_id_key;

-- Uniqueness across RM + color + size (NULL treated as 0 for "one color/one size").
CREATE UNIQUE INDEX IF NOT EXISTS ux_rm_purchase_rates_identity
ON erp.rm_purchase_rates (
  rm_item_id,
  COALESCE(color_id, 0),
  COALESCE(size_id, 0)
);

-- =============================================================================
-- EMPLOYEES + BRANCH MAPPING
-- =============================================================================

-- Employees master (HR).
-- Branch mapping is many-to-many: an employee can be associated with multiple branches.
CREATE TABLE IF NOT EXISTS erp.employees (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL UNIQUE,
  name_ur       text,

  cnic          text,
  phone         text,

  department_id bigint REFERENCES erp.departments(id),
  designation   text,

  payroll_type  erp.payroll_type NOT NULL DEFAULT 'MONTHLY',
  basic_salary  numeric(18,2) NOT NULL DEFAULT 0,

  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),

  CHECK (basic_salary >= 0),
  CHECK (lower(trim(status)) IN ('active','inactive'))
);

-- Employee-to-branch mapping.
CREATE TABLE IF NOT EXISTS erp.employee_branch (
  employee_id bigint NOT NULL REFERENCES erp.employees(id) ON DELETE CASCADE,
  branch_id   bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, branch_id)
);

-- =============================================================================
-- LABOURS + BRANCH MAPPING
-- =============================================================================

-- Labours master (separate from employees for contractors/daily-wage labour handling).
-- dept_id links labour to a department for cost allocation/reporting.
CREATE TABLE IF NOT EXISTS erp.labours (
  id       bigserial PRIMARY KEY,
  code     text NOT NULL UNIQUE,
  name     text NOT NULL UNIQUE,
  name_ur  text,

  cnic     text,
  phone    text,

  dept_id  bigint REFERENCES erp.departments(id),

  status   text NOT NULL DEFAULT 'active',
  CHECK (lower(trim(status)) IN ('active','inactive'))
);

-- Labour-to-department mapping (supports labour assignment to multiple production departments).
-- dept_id on erp.labours remains as backward-compatible primary/default department.
CREATE TABLE IF NOT EXISTS erp.labour_department (
  labour_id bigint NOT NULL REFERENCES erp.labours(id) ON DELETE CASCADE,
  dept_id   bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
  PRIMARY KEY (labour_id, dept_id)
);

-- Labour-to-branch mapping.
CREATE TABLE IF NOT EXISTS erp.labour_branch (
  labour_id bigint NOT NULL REFERENCES erp.labours(id) ON DELETE CASCADE,
  branch_id bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,
  PRIMARY KEY (labour_id, branch_id)
);

-- =============================================================================
-- SAFE EARLY INDEXES (PERFORMANCE / JOIN HELPERS)
-- =============================================================================

-- Speeds up "accounts available in branch" joins/filters.
CREATE INDEX IF NOT EXISTS idx_account_branch_branch_id
ON erp.account_branch (branch_id);

-- Speeds up branch isolation queries: "parties for this branch".
CREATE INDEX IF NOT EXISTS idx_parties_branch_id
ON erp.parties (branch_id);

-- Speeds up city-based filters on parties.
CREATE INDEX IF NOT EXISTS idx_parties_city_id
ON erp.parties (city_id);

-- Speeds up "parties available in branch" joins/filters.
CREATE INDEX IF NOT EXISTS idx_party_branch_branch_id
ON erp.party_branch (branch_id);

-- Speeds up common joins: items -> variants -> skus.
CREATE INDEX IF NOT EXISTS idx_variants_item_id
ON erp.variants (item_id);

-- Speeds up rate lookups: "latest rates for this RM item".
CREATE INDEX IF NOT EXISTS idx_rm_purchase_rates_item_id
ON erp.rm_purchase_rates (rm_item_id);

CREATE INDEX IF NOT EXISTS idx_labour_department_dept_id
ON erp.labour_department (dept_id);

-- Optional active-only filtering support for master lists.
CREATE INDEX IF NOT EXISTS idx_items_is_active
ON erp.items (is_active);

CREATE INDEX IF NOT EXISTS idx_skus_is_active
ON erp.skus (is_active);

-- =============================================================================
-- ITEM UNIQUENESS (RM PER GROUP, OTHERS GLOBAL)
-- =============================================================================
-- RM: allow same name/code across groups, but unique within group (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_rm_code_per_group
ON erp.items (group_id, lower(code))
WHERE item_type = 'RM';

CREATE UNIQUE INDEX IF NOT EXISTS ux_items_rm_name_per_group
ON erp.items (group_id, lower(name))
WHERE item_type = 'RM';

-- Non-RM: keep global uniqueness (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_non_rm_code_global
ON erp.items (lower(code))
WHERE item_type <> 'RM';

CREATE UNIQUE INDEX IF NOT EXISTS ux_items_non_rm_name_global
ON erp.items (lower(name))
WHERE item_type <> 'RM';

