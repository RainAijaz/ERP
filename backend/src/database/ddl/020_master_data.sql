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
  name text NOT NULL
);

-- =============================================================================
-- PRODUCT GROUPING (GROUPS / SUBGROUPS / SHOE CATEGORY)
-- =============================================================================

-- High-level product groups (e.g., EVA / PU / PCU / Footwear).
-- applies_* flags allow hiding irrelevant groups in RM/SFG/FG screens.
CREATE TABLE IF NOT EXISTS erp.product_groups (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  applies_rm    boolean NOT NULL DEFAULT true,
  applies_sfg   boolean NOT NULL DEFAULT true,
  applies_fg    boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  CHECK (applies_rm OR applies_sfg OR applies_fg)
);

-- Product subgroup within a group (e.g., Boots, Kids, Sports, etc.)
-- code is a stable snake_case key to prevent drift/typos across UI and backend.
CREATE TABLE IF NOT EXISTS erp.product_subgroups (
  id        bigserial PRIMARY KEY,
  group_id  bigint NOT NULL REFERENCES erp.product_groups(id) ON DELETE RESTRICT,
  code      text NOT NULL,          -- stable key (snake_case)
  name      text NOT NULL,          -- display name
  is_active boolean NOT NULL DEFAULT true,

  UNIQUE (group_id, code),
  UNIQUE (group_id, name),

  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,80}$')
);

-- Shoe category / audience segmentation (men, women, boys, girls, unisex).
-- code is a stable snake_case key for consistent filtering and reporting.
CREATE TABLE IF NOT EXISTS erp.shoe_category (
  id        bigserial PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,40}$')
);

-- =============================================================================
-- VARIANT DIMENSIONS (USED BY FG + SFG SKUs)
-- =============================================================================

-- NOTE: storing size as text supports values like "7/10", "9/10", "40", "41", etc.
CREATE TABLE IF NOT EXISTS erp.sizes (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS erp.colors (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS erp.grades (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS erp.packing_types (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

-- =============================================================================
-- ACCOUNTS (COA STRUCTURE) + ACCOUNT-BRANCH MAPPING
-- =============================================================================

-- Account subgroups: a flexible layer under the fixed erp.account_group enum.
-- Example: ASSET -> cash_bank, receivables, inventory; EXPENSE -> salaries, utilities, etc.
CREATE TABLE IF NOT EXISTS erp.account_subgroups (
  id         bigserial PRIMARY KEY,
  group_code erp.account_group NOT NULL,
  code       text NOT NULL,               -- stable key (snake_case)
  name       text NOT NULL,
  is_contra  boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,

  UNIQUE (group_code, code),
  UNIQUE (group_code, name),

  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,80}$')
);

-- Accounts master (Chart of Accounts).
-- created_by/approved_by fields support maker-checker for master data.
CREATE TABLE IF NOT EXISTS erp.accounts (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  subgroup_id   bigint NOT NULL REFERENCES erp.account_subgroups(id) ON DELETE RESTRICT,

  is_active     boolean NOT NULL DEFAULT true,
  lock_posting  boolean NOT NULL DEFAULT false, -- if true, app should block postings to this account

  created_by    bigint REFERENCES erp.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
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

-- Party groups (e.g., Wholesale, Retail, Suppliers - Leather, etc.)
CREATE TABLE IF NOT EXISTS erp.party_groups (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

-- Parties master.
-- branch_id enforces master-data isolation per branch (matches your rule).
-- Credit rules are enforced for customers only via CHECK constraints.
CREATE TABLE IF NOT EXISTS erp.parties (
  id             bigserial PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,

  party_type     erp.party_type NOT NULL, -- CUSTOMER / SUPPLIER (or BOTH if you later add it)
  branch_id      bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,

  group_id       bigint REFERENCES erp.party_groups(id),

  address        text,
  phone1         text,
  phone2         text,
  city           text,

  credit_allowed boolean NOT NULL DEFAULT false,
  credit_limit   numeric(18,2) NOT NULL DEFAULT 0,

  is_active      boolean NOT NULL DEFAULT true,

  created_by     bigint NOT NULL REFERENCES erp.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    bigint REFERENCES erp.users(id),
  approved_at    timestamptz,

  -- Maker-checker: approver cannot be the creator.
  CHECK (approved_by IS NULL OR approved_by <> created_by),

  -- Credit rules:
  -- - Only customers can have credit.
  -- - If credit is not allowed => limit must be 0.
  -- - If credit is allowed => limit must be > 0.
  CHECK (party_type = 'CUSTOMER' OR (credit_allowed = false AND credit_limit = 0)),
  CHECK (
    (credit_allowed = false AND credit_limit = 0)
    OR
    (credit_allowed = true AND credit_limit > 0)
  )
);

-- =============================================================================
-- DEPARTMENTS (FOR HR + COST ALLOCATION)
-- =============================================================================

-- Departments represent "where cost happened" (production/non-production).
-- is_production helps separate production overhead vs non-production overhead in reports.
CREATE TABLE IF NOT EXISTS erp.departments (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  is_production boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true
);

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
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,

  group_id         bigint NOT NULL REFERENCES erp.product_groups(id),
  subgroup_id      bigint REFERENCES erp.product_subgroups(id),
  shoe_category_id bigint REFERENCES erp.shoe_category(id),

  base_uom_id      bigint NOT NULL REFERENCES erp.uom(id),

  is_active        boolean NOT NULL DEFAULT true,
  min_stock_level  numeric(18,3) NOT NULL DEFAULT -1,

  created_by       bigint REFERENCES erp.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by      bigint REFERENCES erp.users(id),
  approved_at      timestamptz,

  CHECK (approved_by IS NULL OR approved_by <> created_by)
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

-- Optional RM-specific size dimension (kept separate in case RM needs a different size scheme).
-- If you don't need RM sizes, you can remove this table later.
CREATE TABLE IF NOT EXISTS erp.rm_sizes (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

-- RM purchase rates (as agreed: keep simple for now):
-- - color_id is NOT NULL (so every rate is color-specific)
-- - Exactly one rate per (rm_item_id, color_id)
-- NOTE: RM/SFG/FG enforcement (rm_item_id must be RM) will be implemented in integrity_checks.sql.
CREATE TABLE IF NOT EXISTS erp.rm_purchase_rates (
  id               bigserial PRIMARY KEY,
  rm_item_id       bigint NOT NULL REFERENCES erp.items(id) ON DELETE CASCADE,
  color_id         bigint NOT NULL REFERENCES erp.colors(id),

  purchase_rate     numeric(18,4) NOT NULL,
  avg_purchase_rate numeric(18,4) NOT NULL, -- keep in sync via triggers/app later

  is_active        boolean NOT NULL DEFAULT true,

  created_by       bigint NOT NULL REFERENCES erp.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by      bigint REFERENCES erp.users(id),
  approved_at      timestamptz,

  CHECK (purchase_rate >= 0),
  CHECK (avg_purchase_rate >= 0),
  CHECK (approved_by IS NULL OR approved_by <> created_by),

  UNIQUE (rm_item_id, color_id)
);

-- =============================================================================
-- EMPLOYEES + BRANCH MAPPING
-- =============================================================================

-- Employees master (HR).
-- Branch mapping is many-to-many: an employee can be associated with multiple branches.
CREATE TABLE IF NOT EXISTS erp.employees (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,

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
  name     text NOT NULL,

  cnic     text,
  phone    text,

  dept_id  bigint REFERENCES erp.departments(id),

  status   text NOT NULL DEFAULT 'active',
  CHECK (lower(trim(status)) IN ('active','inactive'))
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

-- Speeds up common joins: items -> variants -> skus.
CREATE INDEX IF NOT EXISTS idx_variants_item_id
ON erp.variants (item_id);

-- Speeds up rate lookups: "latest rates for this RM item".
CREATE INDEX IF NOT EXISTS idx_rm_purchase_rates_item_id
ON erp.rm_purchase_rates (rm_item_id);

-- Optional “active only” filtering support for master lists.
CREATE INDEX IF NOT EXISTS idx_items_is_active
ON erp.items (is_active);

CREATE INDEX IF NOT EXISTS idx_skus_is_active
ON erp.skus (is_active);
