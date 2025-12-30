SET search_path = erp;

-- 1) Enums (keep minimal; prefer lookup tables where extension is likely)

DO $$ BEGIN
  CREATE TYPE erp.voucher_status AS ENUM ('DRAFT','PENDING','APPROVED','REJECTED','POSTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.voucher_line_kind AS ENUM ('ITEM','SKU','ACCOUNT','PARTY','LABOUR','EMPLOYEE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.stock_bucket AS ENUM ('RM','SFG','FG','TRANSIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.period_status AS ENUM ('OPEN','LOCKED','FROZEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.item_type AS ENUM ('RM','SFG','FG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.bom_level AS ENUM ('FINISHED','SEMI_FINISHED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.stock_status AS ENUM ('PACKED','LOOSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.bank_txn_status AS ENUM ('PENDING','CLEARED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.approval_status AS ENUM ('PENDING','APPROVED','REJECTED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.loss_type AS ENUM ('RM_LOSS','SFG_LOSS','FG_LOSS','DVC_ABANDON');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.sale_mode AS ENUM ('DIRECT','FROM_SO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.payment_type AS ENUM ('CASH','CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE erp.rgp_out_status AS ENUM ('PENDING','PARTIALLY_RETURNED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- 2) FOUNDATION: branches, users, roles/permissions, approvals, logs, audit freeze

-- 2.1 Branches
CREATE TABLE IF NOT EXISTS branches (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  city        text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2.2 Users
CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  user_type     text NOT NULL, -- Admin/Manager/Storekeeper/Salesman/Accounts/Production (keep flexible)
  status        text NOT NULL DEFAULT 'Active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS user_branch (
  user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id bigint NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

-- 2.3 Role templates + permissions
CREATE TABLE IF NOT EXISTS role_templates (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id bigint NOT NULL REFERENCES role_templates(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS permissions (
  id          bigserial PRIMARY KEY,
  scope_type  text NOT NULL,         -- MODULE/SCREEN/VOUCHER/REPORT
  scope_key   text NOT NULL,         -- e.g. 'sales_voucher', 'bom_approve'
  can_view    boolean NOT NULL DEFAULT false,
  can_create  boolean NOT NULL DEFAULT false,
  can_edit    boolean NOT NULL DEFAULT false,
  can_delete  boolean NOT NULL DEFAULT false,
  can_approve boolean NOT NULL DEFAULT false,
  UNIQUE(scope_type, scope_key)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       bigint NOT NULL REFERENCES role_templates(id) ON DELETE CASCADE,
  permission_id bigint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_permissions_override (
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id bigint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  can_view      boolean,
  can_create    boolean,
  can_edit      boolean,
  can_delete    boolean,
  can_approve   boolean,
  PRIMARY KEY (user_id, permission_id)
);

-- 2.4 Security add-ons (session timeout + optional TOTP)
CREATE TABLE IF NOT EXISTS user_sessions (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip_address    text,
  user_agent    text,
  is_revoked    boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ix_user_sessions_user ON user_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS user_totp (
  user_id      bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_enabled   boolean NOT NULL DEFAULT false,
  secret_enc   text,      -- encrypted secret (store encrypted; never plain)
  enabled_at   timestamptz
);

-- 2.5 Period control (Audit Freeze / Lock)
CREATE TABLE IF NOT EXISTS period_control (
  id            bigserial PRIMARY KEY,
  branch_id     bigint REFERENCES branches(id) ON DELETE CASCADE, -- NULL = all branches
  period_year   int NOT NULL,
  period_month  int NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  status        erp.period_status NOT NULL DEFAULT 'OPEN',
  locked_by     bigint REFERENCES users(id),
  locked_at     timestamptz,
  freeze_reason text,
  UNIQUE(branch_id, period_year, period_month)
);

-- 2.6 Activity log (for all changes)
CREATE TABLE IF NOT EXISTS activity_log (
  id          bigserial PRIMARY KEY,
  branch_id   bigint REFERENCES branches(id),
  user_id     bigint REFERENCES users(id),
  entity_type text NOT NULL,          -- 'voucher', 'rm_rate', 'sku_rate', 'permissions', etc.
  entity_id   text,                   -- e.g. voucher_id or code
  action      text NOT NULL,          -- CREATE/UPDATE/DELETE/APPROVE/REJECT/POST/CLEAR/FAIL
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip_address  text
);

CREATE INDEX IF NOT EXISTS ix_activity_log_branch_time ON activity_log(branch_id, created_at);
CREATE INDEX IF NOT EXISTS ix_activity_log_entity ON activity_log(entity_type, entity_id);

-- 2.7 Generic approvals queue (Pending Approvals screen)
CREATE TABLE IF NOT EXISTS approval_request (
  id            bigserial PRIMARY KEY,
  branch_id      bigint REFERENCES branches(id),
  request_type   text NOT NULL,      -- e.g. 'RM_RATE_CHANGE','SALE_RATE_CHANGE','BOM_APPROVAL','STOCK_COUNT','BANK_CLEARING','LABOUR_RATE','COMMISSION_RULE','RGP_OUT'
  entity_type    text NOT NULL,      -- table/module key
  entity_id      text NOT NULL,      -- primary key as text (or voucher_id)
  summary        text,
  old_value      jsonb,
  new_value      jsonb,
  status         erp.approval_status NOT NULL DEFAULT 'PENDING',
  requested_by   bigint NOT NULL REFERENCES users(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     bigint REFERENCES users(id),
  decided_at     timestamptz,
  decision_notes text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by) -- maker-checker
);

CREATE INDEX IF NOT EXISTS ix_approval_request_status ON approval_request(status, requested_at);
CREATE INDEX IF NOT EXISTS ix_approval_request_entity ON approval_request(entity_type, entity_id);

-- 2.8 Reason codes (stock count, loss, overrides)
CREATE TABLE IF NOT EXISTS reason_codes (
  id          bigserial PRIMARY KEY,
  module      text NOT NULL, -- 'STOCK_COUNT','LOSS','PERIOD_OVERRIDE', etc.
  code        text NOT NULL,
  description text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE(module, code)
);

-- ) BANK VOUCHER CLEARING WORKFLOW (pending/cleared/failed)

CREATE TABLE IF NOT EXISTS bank_voucher_header (
  voucher_id        bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  bank_account_id   bigint NOT NULL REFERENCES accounts(id),
  reference_no      text,
  status            erp.bank_txn_status NOT NULL DEFAULT 'PENDING',
  clearing_date     date,
  decided_by        bigint REFERENCES users(id),
  decided_at        timestamptz,
  CHECK (clearing_date IS NULL OR status IN ('CLEARED','FAILED'))
);



-- 14) ABNORMAL LOSS VOUCHER (line-level loss type, DVC_ABANDON is per SKU+dept)

CREATE TABLE IF NOT EXISTS loss_header (
  voucher_id     bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  reason_code_id bigint REFERENCES reason_codes(id),
  notes          text
);

CREATE TABLE IF NOT EXISTS loss_line (
  voucher_line_id bigint PRIMARY KEY REFERENCES voucher_line(id) ON DELETE CASCADE,
  loss_type       erp.loss_type NOT NULL,
  dept_id         bigint REFERENCES departments(id), -- required only for DVC_ABANDON
  qty_pairs       int NOT NULL DEFAULT 0,
  qty_rm          numeric(18,3) NOT NULL DEFAULT 0,
  CHECK (
    (loss_type='DVC_ABANDON' AND dept_id IS NOT NULL AND qty_pairs > 0 AND qty_rm=0)
    OR (loss_type IN ('RM_LOSS','SFG_LOSS','FG_LOSS') AND dept_id IS NULL)
  )
);

-- PERIOD LOCK / AUDIT FREEZE ENFORCEMENT (DB-side)

CREATE OR REPLACE FUNCTION erp.is_period_locked(p_branch_id bigint, p_date date)
RETURNS boolean AS $$
DECLARE v_status erp.period_status;
BEGIN
  SELECT pc.status INTO v_status
  FROM erp.period_control pc
  WHERE (pc.branch_id = p_branch_id OR pc.branch_id IS NULL)
    AND pc.period_year  = EXTRACT(YEAR FROM p_date)::int
    AND pc.period_month = EXTRACT(MONTH FROM p_date)::int
  ORDER BY pc.branch_id NULLS LAST
  LIMIT 1;

  RETURN (v_status IN ('LOCKED','FROZEN'));
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION erp.trg_enforce_period_on_voucher_header()
RETURNS trigger AS $$
DECLARE v_branch bigint;
DECLARE v_date   date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_branch := OLD.branch_id;
    v_date   := OLD.voucher_date;
  ELSE
    v_branch := NEW.branch_id;
    v_date   := NEW.voucher_date;
  END IF;

  IF erp.is_period_locked(v_branch, v_date) THEN
    RAISE EXCEPTION 'Period is LOCKED/FROZEN for branch % and date % (operation % blocked).', v_branch, v_date, TG_OP;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_period_voucher_header ON erp.voucher_header;
CREATE TRIGGER trg_period_voucher_header
BEFORE INSERT OR UPDATE OR DELETE ON erp.voucher_header
FOR EACH ROW EXECUTE FUNCTION erp.trg_enforce_period_on_voucher_header();

CREATE OR REPLACE FUNCTION erp.trg_enforce_period_on_voucher_line()
RETURNS trigger AS $$
DECLARE v_branch bigint;
DECLARE v_date   date;
DECLARE v_vid    bigint;
BEGIN
  v_vid := COALESCE(NEW.voucher_id, OLD.voucher_id);

  SELECT branch_id, voucher_date INTO v_branch, v_date
  FROM erp.voucher_header
  WHERE id = v_vid;

  IF erp.is_period_locked(v_branch, v_date) THEN
    RAISE EXCEPTION 'Period is LOCKED/FROZEN for branch % and date % (voucher_line % blocked).', v_branch, v_date, TG_OP;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_period_voucher_line ON erp.voucher_line;
CREATE TRIGGER trg_period_voucher_line
BEFORE INSERT OR UPDATE OR DELETE ON erp.voucher_line
FOR EACH ROW EXECUTE FUNCTION erp.trg_enforce_period_on_voucher_line();

