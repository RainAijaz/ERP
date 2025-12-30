-- 15) OUTWARD & RETURNABLE (RGP) + asset movement history

CREATE TABLE IF NOT EXISTS assets (
  id          bigserial PRIMARY KEY,
  asset_code  text UNIQUE, -- serial/asset code
  asset_type  text NOT NULL, -- mould/tool/knife/fixture/other
  description text NOT NULL,
  home_branch_id bigint REFERENCES branches(id),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS rgp_outward (
  voucher_id          bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  vendor_party_id     bigint NOT NULL REFERENCES parties(id),
  reason              text NOT NULL, -- Repair/Sharpening/Calibration/Trial
  expected_return_date date,
  status              erp.rgp_out_status NOT NULL DEFAULT 'PENDING'
);

CREATE TABLE IF NOT EXISTS rgp_outward_line (
  voucher_line_id  bigint PRIMARY KEY REFERENCES voucher_line(id) ON DELETE CASCADE,
  asset_id         bigint REFERENCES assets(id),
  item_type        text NOT NULL, -- mould/tool/knife/fixture/other
  item_description text NOT NULL,
  serial_no        text,
  qty              numeric(18,3) NOT NULL DEFAULT 1,
  condition_out    text NOT NULL, -- Good/Worn/Damaged
  remarks          text
);

CREATE TABLE IF NOT EXISTS rgp_inward (
  voucher_id         bigint PRIMARY KEY REFERENCES voucher_header(id) ON DELETE CASCADE,
  rgp_out_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE RESTRICT,
  return_date        date NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS rgp_inward_line (
  id                bigserial PRIMARY KEY,
  rgp_in_voucher_id bigint NOT NULL REFERENCES voucher_header(id) ON DELETE CASCADE,
  rgp_out_line_voucher_line_id bigint NOT NULL REFERENCES voucher_line(id) ON DELETE RESTRICT,
  returned_qty      numeric(18,3) NOT NULL DEFAULT 0,
  condition_in      text NOT NULL, -- OK/Repaired/Damaged/Scrap
  remarks           text
);

CREATE INDEX IF NOT EXISTS ix_rgp_out_vendor_status ON rgp_outward(vendor_party_id, status);
CREATE INDEX IF NOT EXISTS ix_rgp_in_outref ON rgp_inward(rgp_out_voucher_id, return_date);

