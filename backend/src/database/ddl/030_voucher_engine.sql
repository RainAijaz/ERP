-- 4) UNIVERSAL VOUCHER ENGINE (all modules)

CREATE TABLE IF NOT EXISTS voucher_type (
  code                  text PRIMARY KEY, -- SV, SO, PV, PR, CV, BV, JV, STN_OUT, STN_IN, OPN, SCA, FP, SFP, DCV, ALV, RGP_OUT, RGP_IN...
  name                  text NOT NULL,
  requires_approval     boolean NOT NULL DEFAULT false,
  affects_stock         boolean NOT NULL DEFAULT false,
  affects_gl            boolean NOT NULL DEFAULT true,
  default_status_on_save erp.voucher_status NOT NULL DEFAULT 'POSTED'
);

CREATE TABLE IF NOT EXISTS voucher_header (
  id                bigserial PRIMARY KEY,
  voucher_type_code text NOT NULL REFERENCES voucher_type(code),
  voucher_no        text NOT NULL, -- app-generated/sequence (unique per branch+type)
  branch_id         bigint NOT NULL REFERENCES branches(id),
  voucher_date      date NOT NULL,
  status            erp.voucher_status NOT NULL DEFAULT 'POSTED',
  remarks           text,
  created_by        bigint NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  approved_by       bigint REFERENCES users(id),
  approved_at       timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  UNIQUE (branch_id, voucher_type_code, voucher_no)
);

CREATE INDEX IF NOT EXISTS ix_voucher_header_branch_date ON voucher_header(branch_id, voucher_date);
CREATE INDEX IF NOT EXISTS ix_voucher_header_type_date   ON voucher_header(voucher_type_code, voucher_date);

CREATE TABLE IF NOT EXISTS voucher_line (
  id          bigserial PRIMARY KEY,
  voucher_id  bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  line_no     int NOT NULL,
  line_kind   erp.voucher_line_kind NOT NULL,

  item_id     bigint REFERENCES items(id),
  sku_id      bigint REFERENCES skus(id),
  account_id  bigint REFERENCES accounts(id),
  party_id    bigint REFERENCES parties(id),
  labour_id   bigint, -- FK added after labours
  employee_id bigint, -- FK added after employees

  dept_id     bigint REFERENCES departments(id),
  uom_id      bigint REFERENCES uom(id),

  qty         numeric(18,3) NOT NULL DEFAULT 0,  -- RM quantity etc
  rate        numeric(18,4) NOT NULL DEFAULT 0,
  amount      numeric(18,2) NOT NULL DEFAULT 0,

  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE(voucher_id, line_no),
  CHECK (num_nonnulls(item_id, sku_id, account_id, party_id, labour_id, employee_id) >= 1)
);

CREATE INDEX IF NOT EXISTS ix_voucher_line_voucher ON voucher_line(voucher_id);
CREATE INDEX IF NOT EXISTS ix_voucher_line_item ON voucher_line(item_id);
CREATE INDEX IF NOT EXISTS ix_voucher_line_sku  ON voucher_line(sku_id);
