/* ============================================================================
   FILE: 010_foundation.sql
   PURPOSE
   - Define ERP foundation objects:
     1) ENUM types (fixed value sets used across the ERP)
     2) Security foundation (branches, users, roles, permissions)
     3) Audit + approvals queue (maker-checker)
     4) Period lock control tables 

   KEY DESIGN DECISIONS
   - Some "text keys" MUST NOT drift (typos break permissions, logs, approvals).
   - For stable tiny sets: use ENUM (e.g., period_status).
   - For extendable sets: use REGISTRY TABLE + FK (add codes by INSERT, no migrations).
   - Add CHECK constraints to enforce key formatting (snake_case, UPPER_CASE).
   ============================================================================ */

SET search_path = erp;

/* ============================================================================
   1) ENUM TYPES
   ============================================================================ */


DO $$ BEGIN
  -- Voucher line kind = what the line references.
  CREATE TYPE erp.voucher_line_kind AS ENUM ('ITEM','SKU','ACCOUNT','PARTY','LABOUR','EMPLOYEE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  --  indicates inventory category affected.
  CREATE TYPE erp.stock_category AS ENUM ('RM','SFG','FG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Period control status for audit lock/freeze.
  CREATE TYPE erp.period_status AS ENUM ('OPEN','LOCKED','FROZEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Item classification in master data.
  CREATE TYPE erp.item_type AS ENUM ('RM','SFG','FG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- BOM level.
  CREATE TYPE erp.bom_level AS ENUM ('FINISHED','SEMI_FINISHED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Bank clearing status.
  CREATE TYPE erp.bank_txn_status AS ENUM ('PENDING','CLEARED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Generic approvals queue status.
  CREATE TYPE erp.approval_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Sales origin.
  CREATE TYPE erp.sale_mode AS ENUM ('DIRECT','FROM_SO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Returnable gate pass outward status.
  CREATE TYPE erp.rgp_out_status AS ENUM ('PENDING','PARTIALLY_RETURNED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Permission scopes define category of access control.
  CREATE TYPE erp.permission_scope_type AS ENUM ('MODULE','SCREEN','VOUCHER','REPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.stock_state AS ENUM ('ON_HAND','IN_TRANSIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


/* ============================================================================
   2) FOUNDATION TABLES (multi-branch + security + approvals)
   ============================================================================ */
-- /* ===================================================  2.1 Branches =================================================== 

-- Multi-branch isolation: every transactional table carries branch_id.
CREATE TABLE IF NOT EXISTS branches (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,             -- e.g. LHR01
  name        text NOT NULL,                    -- e.g. Lahore Factory
  city        text,                             -- keep free text unless you build a cities lookup table
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- /* ===================================================  2.2 Role templates =================================================== 
-- Defines standard roles: Admin, Accounts, Storekeeper, Salesman, Production, etc.
CREATE TABLE IF NOT EXISTS role_templates (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text
);

-- /* ======================================================  2.3 USERS ========================================================= 
CREATE TABLE IF NOT EXISTS users (
  id              bigserial PRIMARY KEY,
  username        text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  primary_role_id bigint NOT NULL REFERENCES erp.role_templates(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'Active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,

  -- Basic safety checks:
  CHECK (length(username) >= 3),
  CHECK (length(password_hash) >= 20),

  -- Restrict user status:
  CHECK (lower(trim(status)) IN ('active','inactive'))
);

-- /* ==========================================   2.4 User-branch mapping  =========================================================== 
-- A user can be allowed to operate multiple branches.
CREATE TABLE IF NOT EXISTS user_branch (
  user_id   bigint NOT NULL REFERENCES erp.users(id) ON DELETE CASCADE,
  branch_id bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);
-- ====================================================================================================================================
-- PERMISSIONS (Targets + Rules)
-- This section is designed to match your UI where Admin can set rights such as:
--   Navigation / Add / Edit / Delete / Print
-- and also workflow rights:
--   Approve / Post / Unpost
--
-- IMPORTANT DESIGN CHOICE
--   1) permission_scope_registry = "WHAT can be controlled" (developer seeds these)
--   2) role_permissions          = "WHAT a role can do"    (Admin sets later via UI)
--   3) user_permissions_override = optional per-user exceptions

-- /* =================================   2.5 PERMISSION SCOPE REGISTRY (permission targets) ================================== 
CREATE TABLE IF NOT EXISTS erp.permission_scope_registry (
  id          bigserial PRIMARY KEY,
  scope_type  erp.permission_scope_type NOT NULL,  -- MODULE / SCREEN / VOUCHER / REPORT
  scope_key   text NOT NULL,                       -- stable machine key (snake_case)
  description text,                                -- label shown in UI (optional)
  UNIQUE (scope_type, scope_key)
);

-- Anti-typo guard:
-- Even if ONLY developers insert scope_keys, this prevents silent permission bugs:
--   'Sales_Voucher' vs 'sales_voucher'
--   ' sales_voucher ' (spaces)
-- If keys drift, joins break and users get denied without obvious errors.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'permission_scope_registry_scope_key_chk'
      AND conrelid = 'erp.permission_scope_registry'::regclass
  ) THEN
    ALTER TABLE erp.permission_scope_registry
      ADD CONSTRAINT permission_scope_registry_scope_key_chk
      CHECK (
        scope_key = lower(trim(scope_key))
        AND scope_key ~ '^[a-z0-9_]{3,80}$'
      );
  END IF;
END $$;

-- /* =================================  2.6 ROLE PERMISSIONS (rules per role per permission target) ================================== */-----------------------------------------------------------------------------
-- UI mapping:
--   can_view   => Navigation / Open
--   can_create => Add
--   can_edit   => Edit
--   can_delete => Delete
--   can_print  => Print
--
-- Workflow:
--   can_approve => approve/reject (maker-checker decision)
--   can_post    => post/finalize into ledgers
--   can_unpost  => reverse posting (should be admin-only in app)
CREATE TABLE IF NOT EXISTS erp.role_permissions (
  role_id     bigint NOT NULL REFERENCES erp.role_templates(id) ON DELETE CASCADE,
  scope_id    bigint NOT NULL REFERENCES erp.permission_scope_registry(id) ON DELETE RESTRICT,

  can_view    boolean NOT NULL DEFAULT false,
  can_create  boolean NOT NULL DEFAULT false,
  can_edit    boolean NOT NULL DEFAULT false,
  can_delete  boolean NOT NULL DEFAULT false,
  can_print   boolean NOT NULL DEFAULT false,

  can_approve boolean NOT NULL DEFAULT false,
  can_post    boolean NOT NULL DEFAULT false,
  can_unpost  boolean NOT NULL DEFAULT false,

  PRIMARY KEY (role_id, scope_id)
);
/* ================================= 2.7 USER PERMISSION OVERRIDES (optional per-user exceptions) ================================== */

-- NULL => inherit from role_permissions
-- TRUE/FALSE => override
CREATE TABLE IF NOT EXISTS erp.user_permissions_override (
  user_id     bigint NOT NULL REFERENCES erp.users(id) ON DELETE CASCADE,
  scope_id    bigint NOT NULL REFERENCES erp.permission_scope_registry(id) ON DELETE RESTRICT,

  can_view    boolean,
  can_create  boolean,
  can_edit    boolean,
  can_delete  boolean,
  can_print   boolean,

  can_approve boolean,
  can_post    boolean,
  can_unpost  boolean,

  PRIMARY KEY (user_id, scope_id)
);

-- Put this BEFORE activity_log / approval_request tables that reference these registries
SET search_path = erp;

-- --------------------------------------------------------------------
-- 1) ENTITY TYPE REGISTRY
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.entity_type_registry (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,          -- stable key used in code (e.g., 'VOUCHER_HEADER')
  name        text NOT NULL,                 -- human label (e.g., 'Voucher')
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------
-- 2) AUDIT ACTION REGISTRY
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.audit_action_registry (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,          -- e.g., 'CREATE','UPDATE','APPROVE'
  name        text NOT NULL,                 -- human label
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------
-- 3) APPROVAL REQUEST TYPE REGISTRY
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.approval_request_type_registry (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,          -- stable key (e.g., 'VOUCHER')
  name        text NOT NULL,                 -- human label
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

  
/* ================================================= Sessions ========================================================= */

-- Supports logout/expiry/revocation + tracking.--
CREATE TABLE IF NOT EXISTS erp.user_sessions (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES erp.users(id) ON DELETE CASCADE,
  -- Token itself must be random/unpredictable; store its hash for safer DB exposure.
  token_hash   text NOT NULL UNIQUE,
  -- When the session row was created (login time).
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Last time this session was used (touch/update on each authenticated request).
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Rolling idle expiry deadline.
  -- On each request: set expires_at = now() + idle_timeout (e.g., 30–60 minutes).
  expires_at   timestamptz NOT NULL,
  -- Client IP address at time of creation/last use (inet is best type in Postgres).
  ip_address   inet,
  user_agent text,
  -- Server-side revocation switch for logout/forced sign-out.
  is_revoked   boolean NOT NULL DEFAULT false,
  -- When the session was revoked (null if never revoked).
  revoked_at   timestamptz,

  CHECK (expires_at > created_at)
);

-- 2.9 Optional TOTP 2FA support
-- secret_enc must be encrypted (never store plaintext secrets).
CREATE TABLE IF NOT EXISTS user_totp (
  user_id    bigint PRIMARY KEY REFERENCES erp.users(id) ON DELETE CASCADE,
  is_enabled boolean NOT NULL DEFAULT false,
  secret_enc text,
  enabled_at timestamptz
);
/* ======================================= AUDIT FREEZE / PERIOD CONTROL ========================================================= */
-- 2.10 Period control (Lock/Freeze)
CREATE TABLE IF NOT EXISTS period_control (
  id            bigserial PRIMARY KEY,
  branch_id     bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,
  period_year   int NOT NULL,
  period_month  int NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  status        erp.period_status NOT NULL DEFAULT 'OPEN',
  locked_by     bigint REFERENCES erp.users(id),
  locked_at     timestamptz,
  freeze_reason text,                         
  UNIQUE (branch_id, period_year, period_month)
);

/* ================================================= ACTIVITY LOG ================================================================== */
-- 2.11 Activity log (generic audit trail)
-- action + entity_type are restricted (FK to registries) to avoid drift.
-- CREATE TABLE IF NOT EXISTS activity_log (
--   id          bigserial PRIMARY KEY,
--   branch_id   bigint REFERENCES erp.branches(id),
--   user_id     bigint REFERENCES erp.users(id),
--   voucher_type text NOT NULL REFERENCES erp.voucher_type(code) ON DELETE RESTRICT,
--   voucher_id   text,                              -- keep text: supports multiple PK styles
--   action      text NOT NULL REFERENCES erp.audit_action_registry(code) ON DELETE RESTRICT,
--   created_at  timestamptz NOT NULL DEFAULT now(),
--   ip_address  inet
-- );
CREATE TABLE IF NOT EXISTS erp.activity_log (
  id                bigserial PRIMARY KEY,
  branch_id          bigint REFERENCES erp.branches(id),
  user_id            bigint REFERENCES erp.users(id),
  -- What kind of thing was affected (voucher header, item, sku, etc.)
  entity_type        text NOT NULL
                      REFERENCES erp.entity_type_registry(code)
                      ON DELETE RESTRICT,
  -- Which exact record (kept as text to support multiple PK styles)
  entity_id          text NOT NULL,
  -- Optional subtype for vouchers only (fast filtering/reporting)
  voucher_type_code  text NULL
                      REFERENCES erp.voucher_type(code)
                      ON DELETE RESTRICT
                      ON UPDATE CASCADE,
  -- What happened
  action             text NOT NULL
                      REFERENCES erp.audit_action_registry(code)
                      ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ip_address         inet
);



/* ==================================== APPROVAL REQUEST ============================================ ================================== */
-- 2.12 Approval queue (maker-checker)
-- request_type + entity_type are restricted by registries (extendable by INSERT).
-- entity_id remains text (it can point to different PK formats across tables).
CREATE TABLE IF NOT EXISTS approval_request (
  id            bigserial PRIMARY KEY,
  branch_id     bigint NOT NULL REFERENCES erp.branches(id),

  request_type  text NOT NULL REFERENCES erp.approval_request_type_registry(code) ON DELETE RESTRICT,
  entity_type   text NOT NULL REFERENCES erp.entity_type_registry(code) ON DELETE RESTRICT,
  entity_id     text NOT NULL,

  summary       text,
  old_value     jsonb,
  new_value     jsonb,

  status        erp.approval_status NOT NULL DEFAULT 'PENDING',
  requested_by  bigint NOT NULL REFERENCES erp.users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),

  decided_by    bigint REFERENCES erp.users(id),
  decided_at    timestamptz,
  decision_notes text,

  -- Maker-checker: approver/decider cannot be requester.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),

  -- Consistency constraints:
  -- - While PENDING: decided_by and decided_at must be NULL
  -- - Once decided (status <> PENDING): decided_by must be present
  CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
    OR
    (status <> 'PENDING' AND decided_by IS NOT NULL)
  )
);


