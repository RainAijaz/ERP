-- =============================================================================
-- 020_master_data.sql
-- PURPOSE
--   Master/setup tables that rarely change day-to-day:
--     - Units of Measure (UOM)
--     - Product grouping + variant dimensions (size/color/grade/packing)
--     - Accounts + Parties (customers/suppliers)
--     - Departments (production + non-production)
--     - Items master (RM/SFG/FG)
--     - Variants + SKUs (NOW supports BOTH FG and SFG variants because SFG has sizes)
--     - Raw Material purchase rates (approval-controlled; color-specific)
--     - Global packed/loose stock rule definition (business rule)
--
-- IMPORTANT NOTES
--   - Assumes these exist already (from 010_foundation.sql):
--       users, branches
--   - Assumes schema search_path already set to erp (or set it here).
--   - "items" is the master for RM/SFG/FG.
--   - "variants/skus" are for ANY item that has variants (FG and also SFG now).
-- =============================================================================

SET search_path = erp;

-- =============================================================================
-- 3.1 UOM & PRODUCT DIMENSIONS
-- =============================================================================

-- Units of Measure used across the ERP.
-- Example codes: PCS, DOZEN, KG, METER, PAIR
CREATE TABLE IF NOT EXISTS uom (
  id   bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,  -- short system code used in UI + reports
  name text NOT NULL          -- human readable display name
);

-- High-level product groups (e.g., EVA / PU / PCU )
CREATE TABLE IF NOT EXISTS erp.product_groups (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  applies_rm    boolean NOT NULL DEFAULT true,
  applies_sfg   boolean NOT NULL DEFAULT true,
  applies_fg    boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  CHECK (applies_rm OR applies_sfg OR applies_fg)
);

-- Product subgroup within a group (e.g., Boots, Ballman, Kids, etc.)
CREATE TABLE IF NOT EXISTS erp.product_subgroups (
  id       bigserial PRIMARY KEY,
  group_id bigint NOT NULL REFERENCES erp.product_groups(id) ON DELETE RESTRICT,
  code     text NOT NULL,           -- e.g., boots, kids, ballman
  name     text NOT NULL,           -- display label
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (group_id, code),
  UNIQUE (group_id, name),
  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,80}$')
);

CREATE TABLE IF NOT EXISTS erp.shoe_category (
  id        bigserial PRIMARY KEY,
  code      text NOT NULL UNIQUE,   -- men, women, boys, girls, unisex
  name      text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CHECK (code = lower(trim(code)) AND code ~ '^[a-z0-9_]{2,40}$')
);

-- Variant dimensions (used by both FG and SFG SKUs).
-- NOTE: storing "7/10" or "9/10" as text is fine; your UI can enforce valid options.
CREATE TABLE IF NOT EXISTS sizes (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS colors (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS grades (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS packing_types (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

-- =============================================================================
-- 3.2 ACCOUNTS & PARTIES
-- =============================================================================
DO $$ BEGIN
  CREATE TYPE erp.account_group AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Party type: only two allowed values
DO $$ BEGIN
  CREATE TYPE erp.party_type AS ENUM ('CUSTOMER','SUPPLIER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


CREATE TABLE IF NOT EXISTS erp.account_subgroups(
  id bigserial PRIMARY KEY,
  group_code erp.account_group NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  is_contra boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE(group_code,code),
  UNIQUE(group_code,name),
  CHECK(code=lower(trim(code)) AND code~'^[a-z0-9_]{2,80}$')
);

CREATE TABLE IF NOT EXISTS erp.accounts (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  subgroup_id bigint NOT NULL REFERENCES erp.account_subgroups(id) ON DELETE RESTRICT,
  is_active   boolean NOT NULL DEFAULT true,
  lock_posting boolean NOT NULL DEFAULT false,
  created_by  bigint REFERENCES erp.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_by bigint REFERENCES erp.users(id),
  approved_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE IF NOT EXISTS erp.account_branch (
  account_id bigint NOT NULL REFERENCES erp.accounts(id)  ON DELETE CASCADE,
  branch_id  bigint NOT NULL REFERENCES erp.branches(id)  ON DELETE CASCADE,
  PRIMARY KEY (account_id, branch_id)
);

-- Party groups (e.g., "Wholesale", "Retail", "Suppliers - Leather", etc.)
CREATE TABLE IF NOT EXISTS party_groups (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS erp.parties (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  party_type erp.party_type NOT NULL,
  branch_id  bigint NOT NULL REFERENCES erp.branches(id)  ON DELETE CASCADE,
  group_id bigint REFERENCES erp.party_groups(id),
  address text,
  phone1 text,
  phone2 text,
  city text,
  credit_allowed boolean NOT NULL DEFAULT false,
  credit_limit numeric(18,2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by bigint NOT NULL REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by bigint REFERENCES erp.users(id),
  approved_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (party_type = 'CUSTOMER' OR (credit_allowed = false AND credit_limit = 0)),
  CHECK ((credit_allowed = false AND credit_limit = 0) OR (credit_allowed = true AND credit_limit > 0))
);

-- =============================================================================
-- 3.3 DEPARTMENTS
-- =============================================================================

-- Departments are your "WHERE / WHY cost happened" .
-- is_production helps reports separate production overhead vs non-production.
CREATE TABLE IF NOT EXISTS departments (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  is_production boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS erp.items (
  id bigserial PRIMARY KEY,
  item_type erp.item_type NOT NULL, -- RM / SFG / FG
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  group_id bigint NOT NULL REFERENCES erp.product_groups(id),
  subgroup_id bigint REFERENCES erp.product_subgroups(id),
  shoe_category_id bigint REFERENCES erp.shoe_category(id),
  base_uom_id bigint NOT NULL REFERENCES erp.uom(id),
  is_active boolean NOT NULL DEFAULT true,
  min_stock_level numeric(18,3) NOT NULL DEFAULT -1,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by bigint REFERENCES erp.users(id),
  approved_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

-- VARIANTS WILL BE USED BY SEMI FINISHED AND FINISHED PRODUCTS ONLY
CREATE TABLE IF NOT EXISTS erp.variants (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
  size_id bigint REFERENCES erp.sizes(id),
  grade_id bigint REFERENCES erp.grades(id),
  color_id bigint REFERENCES erp.colors(id),
  packing_type_id bigint REFERENCES erp.packing_types(id),
  sale_rate numeric(18,2) NOT NULL DEFAULT 0, -- backend will enforce: FG only
  is_active boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by bigint REFERENCES erp.users(id),
  approved_at timestamptz,
  UNIQUE (item_id, size_id, grade_id, color_id, packing_type_id),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE IF NOT EXISTS erp.skus (
  id bigserial PRIMARY KEY,
  variant_id bigint NOT NULL REFERENCES erp.variants(id) ON DELETE RESTRICT,
  sku_code text NOT NULL UNIQUE,
  barcode text,
  is_active boolean NOT NULL DEFAULT true
);


CREATE TABLE IF NOT EXISTS erp.rm_sizes (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS erp.rm_purchase_rates (
  id bigserial PRIMARY KEY,
  rm_item_id bigint NOT NULL REFERENCES erp.items(id) ON DELETE CASCADE,

  purchase_rate     numeric(18,4) NOT NULL,
  avg_purchase_rate numeric(18,4) NOT NULL, -- keep in sync via triggers/app later

  is_active boolean NOT NULL DEFAULT true,

  created_by bigint NOT NULL REFERENCES erp.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by bigint REFERENCES erp.users(id),
  approved_at timestamptz,

  CHECK (purchase_rate >= 0),
  CHECK (avg_purchase_rate >= 0),
  CHECK (approved_by IS NULL OR approved_by <> created_by),

  UNIQUE (rm_item_id)
);


-- -----------------------------------------------------------------------------
-- labours (master)
-- -----------------------------------------------------------------------------
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

-- =============================================================================
-- 3.7 GLOBAL PACKED/LOOSE STOCK RULE
-- =============================================================================

-- This table stores your ONE global rule:
--   PACKED => unit DOZEN, allowed step 0.5, pairs per dozen = 12
--   LOOSE  => unit PAIR, only allowed integer
-- Your app will enforce the rule in UI; DB constraints exist elsewhere on production/sales lines.
CREATE TABLE IF NOT EXISTS stock_type_rule (
  id                 smallint PRIMARY KEY DEFAULT 1, -- always 1 row
  packed_unit_code   text NOT NULL DEFAULT 'DOZEN',
  loose_unit_code    text NOT NULL DEFAULT 'PAIR',
  packed_pairs_per_unit int NOT NULL DEFAULT 12,
  packed_qty_step    numeric(18,3) NOT NULL DEFAULT 0.5,
  enforced           boolean NOT NULL DEFAULT true
);


