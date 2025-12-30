-- 10) PURCHASE (PO, PI, PR) + AP open items + allocation

-- 10.1 Purchase policy rules (optional but supports “PO required above amount / supplier / item / group”)
CREATE TABLE IF NOT EXISTS purchase_policy_rule (
  id            bigserial PRIMARY KEY,
  is_active     boolean NOT NULL DEFAULT true,
  min_amount    numeric(18,2), -- if invoice > min_amount then PO required
  supplier_party_id bigint REFERENCES parties(id),
  rm_item_id    bigint REFERENCES items(id),
  rm_group_id   bigint REFERENCES product_groups(id),
  notes         text
);

-- 10.2 Purchase order header extension
CREATE TABLE IF NOT EXISTS purchase_order_header (
  voucher_id        bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  supplier_party_id bigint NOT NULL REFERENCES parties(id),
  notes             text
);

-- 10.3 Purchase invoice header extension
CREATE TABLE IF NOT EXISTS purchase_header (
  voucher_id        bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  supplier_party_id bigint NOT NULL REFERENCES parties(id),
  payment_type      erp.payment_type NOT NULL DEFAULT 'CREDIT',
  paid_from_account_id bigint REFERENCES accounts(id) -- required for cash purchase
);

-- 10.4 AP Open items + allocation
CREATE TABLE IF NOT EXISTS ap_invoice (
  purchase_voucher_id bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  party_id            bigint NOT NULL REFERENCES parties(id),
  invoice_amount      numeric(18,2) NOT NULL,
  due_date            date
);

CREATE TABLE IF NOT EXISTS ap_open_item (
  id               bigserial PRIMARY KEY,
  party_id         bigint NOT NULL REFERENCES parties(id),
  source_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  source_kind      text NOT NULL, -- INVOICE/PAYMENT/DEBIT_NOTE
  open_amount      numeric(18,2) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ap_allocation (
  id                   bigserial PRIMARY KEY,
  party_id             bigint NOT NULL REFERENCES parties(id),
  from_voucher_id      bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE, -- payment/debit note
  to_purchase_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  amount               numeric(18,2) NOT NULL CHECK (amount > 0),
  allocated_at         timestamptz NOT NULL DEFAULT now(),
  allocated_by         bigint NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS ix_ap_open_item_party_time ON ap_open_item(party_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ap_allocation_party_time ON ap_allocation(party_id, allocated_at);

