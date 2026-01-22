/* ============================================================================
   FILE: 010_administration.sql
   PURPOSE
   - Define ERP foundation objects:
     - ENUM types (fixed value sets used across the ERP)
     - Security foundation (branches, users, roles, permissions)
     - Audit + approvals queue (maker-checker)
     - Period lock control tables
   ============================================================================ */

SET search_path = erp;

/* ============================================================================
   ENUM TYPES
   ----------------------------------------------------------------------------
   - Use ENUMs only for small, stable sets that rarely change.
   - Each DO block makes the script re-runnable:
     if the type already exists, it won’t error.
   ============================================================================ */

DO $$ BEGIN
  -- Voucher line kind = what the voucher line references in UI/business logic.
  -- ITEM/SKU   => inventory-related line
  -- ACCOUNT    => direct GL account line
  -- PARTY      => customer/supplier line
  -- LABOUR     => labour rate/service line
  -- EMPLOYEE   => employee-related payable/receivable line
  CREATE TYPE erp.voucher_line_kind AS ENUM ('ITEM','SKU','ACCOUNT','PARTY','LABOUR','EMPLOYEE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Stock category indicates which inventory bucket is affected.
  -- RM  = Raw Material
  -- SFG = Semi-Finished Goods
  -- FG  = Finished Goods
  CREATE TYPE erp.stock_category AS ENUM ('RM','SFG','FG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Period control status controls whether a month is editable.
  -- OPEN   = normal operations
  -- LOCKED = stop routine edits/postings for the period (soft close)
  -- FROZEN = hard close / audited (typically requires admin override to change)
  CREATE TYPE erp.period_status AS ENUM ('OPEN','LOCKED','FROZEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Item classification used in master data for items/SKUs.
  -- Often matches stock_category but is kept separate to support master-level logic.
  CREATE TYPE erp.item_type AS ENUM ('RM','SFG','FG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- BOM level indicates what the BOM produces.
  -- FINISHED      = produces finished good
  -- SEMI_FINISHED = produces semi-finished good
  CREATE TYPE erp.bom_level AS ENUM ('FINISHED','SEMI_FINISHED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Bank transaction clearing status (for bank book / reconciliation).
  CREATE TYPE erp.bank_txn_status AS ENUM ('PENDING','CLEARED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Generic approval queue status (maker-checker).
  -- PENDING  = waiting for checker decision
  -- APPROVED = accepted by checker
  -- REJECTED = rejected by checker
  CREATE TYPE erp.approval_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Sales origin for sales voucher creation.
  -- DIRECT  = created directly
  -- FROM_SO = created from a Sales Order
  CREATE TYPE erp.sale_mode AS ENUM ('DIRECT','FROM_SO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Returnable gate pass outward lifecycle.
  -- PENDING            = issued but not returned
  -- PARTIALLY_RETURNED = some items returned
  -- CLOSED             = fully returned / closed
  CREATE TYPE erp.rgp_out_status AS ENUM ('PENDING','PARTIALLY_RETURNED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Permission scope type defines "what kind of UI object is being protected".
  -- MODULE  = module in sidebar
  -- SCREEN  = specific screen/page
  -- VOUCHER = voucher type (PV, SV, JV, etc.)
  -- REPORT  = report entry
  CREATE TYPE erp.permission_scope_type AS ENUM ('MODULE','SCREEN','VOUCHER','REPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Inventory state helps distinguish physical stock vs stock in transit.
  CREATE TYPE erp.stock_state AS ENUM ('ON_HAND','IN_TRANSIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


DO $$ BEGIN
  -- Loss type categorizes wastage/loss postings.
  -- RM_LOSS, SFG_LOSS, FG_LOSS are material losses by category.
  -- DVC_ABANDON is an example special loss bucket for abandoned/expired processes.
  CREATE TYPE erp.loss_type AS ENUM ('RM_LOSS','SFG_LOSS','FG_LOSS','DVC_ABANDON');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Production kind indicates what a production transaction outputs.
  CREATE TYPE erp.production_kind AS ENUM ('FG','SFG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Standard accounting type used for chart of accounts grouping.
  CREATE TYPE erp.account_type AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Party type categorizes a party record.
  -- NOTE: If your business requires BOTH (same party is customer + supplier),
  -- add 'BOTH' here (or model roles differently). For now it is restricted to two.
  CREATE TYPE erp.party_type AS ENUM ('CUSTOMER','SUPPLIER','BOTH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Payroll type defines how payroll is calculated/handled.
  CREATE TYPE erp.payroll_type AS ENUM ('MONTHLY','DAILY','PIECE_RATE','MULTIPLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


/* ============================================================================
   SECURITY FOUNDATION (BRANCHES, USERS, ROLES)
   ----------------------------------------------------------------------------
   - Multi-branch isolation: transactional tables should carry branch_id and
     the application must filter by branches assigned to the logged-in user.
   ============================================================================ */

-- Branch master: defines business units/factories/shops for data isolation.
CREATE TABLE IF NOT EXISTS branches (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,             -- stable short code (e.g., LHR01)
  name        text NOT NULL,                    -- display name (e.g., Lahore Factory)
  city        text,                             -- free text unless you build a lookup table later
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Role templates: standard prebuilt roles so you don't reassign rights per user repeatedly.
CREATE TABLE IF NOT EXISTS role_templates (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE,             -- e.g., Admin, Accounts, Storekeeper, Sales, Production
  description text
);

-- Users master: authentication identity + primary role assignment.
CREATE TABLE IF NOT EXISTS users (
  id              bigserial PRIMARY KEY,
  username        text NOT NULL UNIQUE,         -- login username (consider case-insensitive via citext later)
  password_hash   text NOT NULL,                -- store hash only (bcrypt/argon2/etc.), never plaintext
  email           text,                         -- optional but recommended for notifications
  primary_role_id bigint NOT NULL REFERENCES erp.role_templates(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'Active',-- active/inactive login control
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,

  -- Basic safety checks to prevent obviously broken rows.
  CHECK (length(username) >= 3),
  CHECK (length(password_hash) >= 20),

  -- Restrict user status to two states (case/space tolerant).
  CHECK (lower(trim(status)) IN ('active','inactive'))
);

-- Add unique constraint for email (case-insensitive) when present.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower
ON erp.users (lower(email))
WHERE email IS NOT NULL;

-- Basic email shape validation when email is provided.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_email_format'
      AND conrelid = 'erp.users'::regclass
  ) THEN
    ALTER TABLE erp.users
    ADD CONSTRAINT users_email_format
    CHECK (email IS NULL OR (position('@' in email) > 1 AND position('.' in email) > position('@' in email)));
  END IF;
END $$;

-- User-branch mapping: which branches a user is allowed to operate.
-- Rule enforced in application: user can only view/operate assigned branches.
CREATE TABLE IF NOT EXISTS user_branch (
  user_id   bigint NOT NULL REFERENCES erp.users(id) ON DELETE CASCADE,
  branch_id bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

-- Enforce: every user must have at least one branch assignment.
CREATE OR REPLACE FUNCTION erp.enforce_user_branch_assignment()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM erp.user_branch ub WHERE ub.user_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'User % must be assigned to at least one branch', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_require_branch ON erp.users;
CREATE CONSTRAINT TRIGGER trg_users_require_branch
AFTER INSERT OR UPDATE ON erp.users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION erp.enforce_user_branch_assignment();


/* ============================================================================
   PERMISSIONS (WHAT can be controlled + WHAT a role/user can do)
   ----------------------------------------------------------------------------
   Design:
   - permission_scope_registry = targets (developer-defined "things" like screens/vouchers)
   - role_permissions          = rights per role on each target
   - user_permissions_override = optional exceptions per user
   ============================================================================ */

-- Permission scope registry: stable targets the UI can attach permissions to.
-- scope_key should be a stable snake_case machine key (typos break permissions).
CREATE TABLE IF NOT EXISTS erp.permission_scope_registry (
  id          bigserial PRIMARY KEY,
  scope_type  erp.permission_scope_type NOT NULL,  -- MODULE / SCREEN / VOUCHER / REPORT
  scope_key   text NOT NULL,                       -- stable machine key (snake_case)
  description text,                                -- label shown in UI
  UNIQUE (scope_type, scope_key)
);

-- Role permissions: defines what a role can do per scope.
-- UI mapping:
--   can_view   => open/navigation
--   can_create => add/new
--   can_edit   => edit
--   can_delete => delete
--   can_print  => print
-- Workflow:
--   can_approve => checker decision (approve/reject)
--   can_post    => finalize/post into ledgers
--   can_unpost  => reverse posting (should be admin-only at application level)
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

-- User permission overrides: optional per-user exceptions.
-- NULL  => inherit from role_permissions
-- TRUE/FALSE => explicit override for that user on that scope
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


/* ============================================================================
   AUDIT / APPROVALS REGISTRIES
   ----------------------------------------------------------------------------
   These are extendable lookup tables (add codes by INSERT, no migrations).
   Used by activity_log and approval_request to avoid "string drift".
   ============================================================================ */

-- Entity types allowed in audit/approval (voucher header, item, sku, etc.).
CREATE TABLE IF NOT EXISTS erp.entity_type_registry (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,               -- stable code (e.g., 'VOUCHER_HEADER')
  name        text NOT NULL,                      -- human label
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Audit actions allowed in activity log (create/update/approve/post/etc.).
CREATE TABLE IF NOT EXISTS erp.audit_action_registry (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,               -- e.g., 'CREATE','UPDATE','APPROVE'
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Approval request types (voucher approvals, rate change approvals, etc.).
CREATE TABLE IF NOT EXISTS erp.approval_request_type_registry (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,               -- stable code (e.g., 'VOUCHER')
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);


/* ============================================================================
   SESSIONS + OPTIONAL 2FA (TOTP)
   ----------------------------------------------------------------------------
   - user_sessions supports logout/expiry/revocation + tracking
   - user_totp stores optional 2FA state and encrypted secret
   ============================================================================ */

-- User sessions: store token hash so leaked DB does not leak usable session tokens.
CREATE TABLE IF NOT EXISTS erp.user_sessions (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES erp.users(id) ON DELETE CASCADE,

  -- Hash of the session token (store raw token only on client).
  token_hash   text NOT NULL UNIQUE,

  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  -- Session expiry (can be rolling idle expiry or fixed expiry depending on app logic).
  expires_at   timestamptz NOT NULL,

  -- Optional security telemetry.
  ip_address   inet,
  user_agent   text,

  -- Revocation fields for logout / force signout.
  is_revoked   boolean NOT NULL DEFAULT false,
  revoked_at   timestamptz,

  CHECK (expires_at > created_at)
);

-- Optional per-user TOTP configuration (2FA).
-- secret_enc must be encrypted in application code; never store plaintext secret.
CREATE TABLE IF NOT EXISTS erp.user_totp (
  user_id    bigint PRIMARY KEY REFERENCES erp.users(id) ON DELETE CASCADE,
  is_enabled boolean NOT NULL DEFAULT false,
  secret_enc text,
  enabled_at timestamptz
);


/* ============================================================================
   PERIOD CONTROL (AUDIT FREEZE / LOCK)
   ----------------------------------------------------------------------------
   Enforces month-level lock/freeze per branch for accounting control.
   Application should prevent voucher edits/postings when status is LOCKED/FROZEN.
   ============================================================================ */

CREATE TABLE IF NOT EXISTS erp.period_control (
  id            bigserial PRIMARY KEY,
  branch_id     bigint NOT NULL REFERENCES erp.branches(id) ON DELETE CASCADE,
  period_year   int NOT NULL,
  period_month  int NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  status        erp.period_status NOT NULL DEFAULT 'OPEN',

  -- Who locked/froze the period (optional; depends on your workflow).
  locked_by     bigint REFERENCES erp.users(id),
  locked_at     timestamptz,

  -- Optional reason/explanation (especially useful for FREEZE).
  freeze_reason text,

  -- Ensure exactly one row per branch per year/month.
  UNIQUE (branch_id, period_year, period_month)
);


/* ============================================================================
   ACTIVITY LOG (AUDIT TRAIL)
   ----------------------------------------------------------------------------
   Records "who did what and when" across the ERP:
   - voucher create/edit/delete
   - rate changes
   - stock adjustments
   - permission changes
   - approvals/posting actions
   ============================================================================ */

CREATE TABLE IF NOT EXISTS erp.activity_log (
  id                bigserial PRIMARY KEY,
  branch_id          bigint REFERENCES erp.branches(id),
  user_id            bigint REFERENCES erp.users(id),

  -- Entity type is restricted to known codes in entity_type_registry.
  entity_type        text NOT NULL
                      REFERENCES erp.entity_type_registry(code)
                      ON DELETE RESTRICT,

  -- Entity id stored as text so it can point to different PK formats across tables.
  entity_id          text NOT NULL,

  -- Optional voucher subtype:
  -- This FK requires erp.voucher_type(code) to exist BEFORE this file runs.
  -- If voucher_type is created later, keep the column but add FK in a later migration.
  voucher_type_code  text NULL,
  -- Action restricted to known codes in audit_action_registry.
  action             text NOT NULL
                      REFERENCES erp.audit_action_registry(code)
                      ON DELETE RESTRICT,

  created_at         timestamptz NOT NULL DEFAULT now(),
  ip_address         inet
);


/* ============================================================================
   APPROVAL REQUEST (MAKER-CHECKER QUEUE)
   ----------------------------------------------------------------------------
   Holds pending approvals for changes that require a checker decision.
   - requester = maker
   - decider   = checker
   - maker cannot approve own request (enforced by CHECK)
   - old_value/new_value snapshots help reviewer see exact changes
   ============================================================================ */

CREATE TABLE IF NOT EXISTS erp.approval_request (
  id             bigserial PRIMARY KEY,
  branch_id      bigint NOT NULL REFERENCES erp.branches(id),

  -- Approval category (extendable by INSERT into approval_request_type_registry).
  request_type   text NOT NULL REFERENCES erp.approval_request_type_registry(code) ON DELETE RESTRICT,

  -- What kind of entity is being changed (extendable by INSERT into entity_type_registry).
  entity_type    text NOT NULL REFERENCES erp.entity_type_registry(code) ON DELETE RESTRICT,
  entity_id      text NOT NULL,

  -- Reviewer context: what changed (optional but very useful).
  summary        text,
  old_value      jsonb,
  new_value      jsonb,

  status         erp.approval_status NOT NULL DEFAULT 'PENDING',

  -- Maker / requester info.
  requested_by   bigint NOT NULL REFERENCES erp.users(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),

  -- Checker / decision info (NULL while pending).
  decided_by     bigint REFERENCES erp.users(id),
  decided_at     timestamptz,
  decision_notes text,

  -- Maker-checker rule: the requester cannot decide their own request.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),

  -- State consistency:
  -- - While PENDING: decided_by and decided_at must be NULL
  -- - Once decided (APPROVED/REJECTED): decided_by must be present
  CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
    OR
  (status <> 'PENDING' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);
