-- =====================================================================
-- 090_rgp_assets.sql
-- =====================================================================
-- PURPOSE
--   Adds Asset tracking + Returnable Gate Pass (RGP) outward/inward documents.
--   Used when you send returnable items (moulds, tools, fixtures, etc.) outside
--   to a vendor for repair/sharpening/calibration/trial and then receive them back
--   later (fully or partially).
--
-- HOW IT WORKS (HIGH LEVEL)
--   - Built on top of the common voucher engine:
--       * voucher_header = document header (number, date, branch, status, maker/checker)
--       * voucher_line   = document lines (items grid)
--   - RGP Outward:
--       * rgp_outward      links a voucher_header to the outward transaction (vendor + reason + status)
--       * rgp_outward_line extends voucher_line with the asset/item sent out + outward condition
--   - RGP Inward:
--       * rgp_inward       links a voucher_header to the return transaction and points to the original outward voucher
--       * rgp_inward_line  records returned quantities + inward condition against the original outward voucher lines
--
-- TABLES CREATED IN THIS FILE
--   Registries (to avoid typos; extendable by INSERT)
--     - asset_type_registry       : MOULD/TOOL/KNIFE/FIXTURE/OTHER...
--     - rgp_reason_registry       : REPAIR/SHARPEN/CALIBRATE/TRIAL...
--     - rgp_condition_registry    : GOOD/WORN/DAMAGED/OK/REPAIRED/SCRAP...
--
--   Masters / Documents
--     - assets                    : Asset master (optional; codes/serials + home branch)
--     - rgp_outward               : Outward header extension (vendor, reason, expected return, status)
--     - rgp_outward_line          : Outward line extension (asset/manual item, qty, condition_out)
--     - rgp_inward                : Inward header extension (links to outward voucher + return date)
--     - rgp_inward_line           : Inward lines (returned_qty + condition_in) linked to outward lines
--
-- IMPORTANT NOTES
--   - This file defines tables + indexes only.
--   - Workflow rules (e.g., outward.status auto-update to PARTIALLY_RETURNED/CLOSED,
--     total returned_qty <= outward qty, inward lines must belong to that outward voucher)
--     are enforced by backend and/or integrity_checks.sql triggers.
-- =====================================================================

SET search_path = erp;

-- --------------------------------------------------------------------
-- Registries (avoid free-text drift; allow future additions without migrations)
-- --------------------------------------------------------------------

-- Asset / item categories for RGP and asset master
-- Examples: MOULD, TOOL, KNIFE, FIXTURE, JIG, OTHER
CREATE TABLE IF NOT EXISTS erp.asset_type_registry (
  code        text PRIMARY KEY,              -- stable key
  name        text NOT NULL,                 -- label shown in UI
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  CHECK (code = upper(trim(code)) AND code ~ '^[A-Z0-9_]{3,40}$')
);

-- Reasons for sending items out
-- Examples: REPAIR, SHARPEN, CALIBRATE, TRIAL
CREATE TABLE IF NOT EXISTS erp.rgp_reason_registry (
  code        text PRIMARY KEY,              -- stable key
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  CHECK (code = upper(trim(code)) AND code ~ '^[A-Z0-9_]{3,40}$')
);

-- Condition states used on outward/inward
-- Examples: GOOD, WORN, DAMAGED, OK, REPAIRED, SCRAP
CREATE TABLE IF NOT EXISTS erp.rgp_condition_registry (
  code        text PRIMARY KEY,              -- stable key
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  CHECK (code = upper(trim(code)) AND code ~ '^[A-Z0-9_]{2,40}$')
);

-- --------------------------------------------------------------------
-- Assets master (optional; allows tracking moulds/tools/etc by code/serial)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.assets (
  id              bigserial PRIMARY KEY,
  asset_code      text UNIQUE, -- serial/asset code (if you have one)
  asset_type_code text NOT NULL REFERENCES erp.asset_type_registry(code) ON DELETE RESTRICT,
  description     text NOT NULL,
  home_branch_id  bigint REFERENCES erp.branches(id) ON DELETE RESTRICT,
  is_active       boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_assets_home_branch
  ON erp.assets(home_branch_id);

-- --------------------------------------------------------------------
-- RGP outward header (sent out to vendor for repair/sharpening/etc.)
-- voucher_id points to voucher_header for numbering/branch/date/status workflow
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.rgp_outward (
  voucher_id            bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  vendor_party_id       bigint NOT NULL REFERENCES erp.parties(id) ON DELETE RESTRICT,
  reason_code           text NOT NULL REFERENCES erp.rgp_reason_registry(code) ON DELETE RESTRICT,
  expected_return_date  date,
  status                erp.rgp_out_status NOT NULL DEFAULT 'PENDING'
);

CREATE INDEX IF NOT EXISTS idx_rgp_outward_vendor
  ON erp.rgp_outward(vendor_party_id);

CREATE INDEX IF NOT EXISTS idx_rgp_outward_status
  ON erp.rgp_outward(status);

-- --------------------------------------------------------------------
-- RGP outward lines (assets/items sent out)
-- asset_id is optional: track via assets table OR enter manual description.
-- NOTE: validation such as "asset_id OR manual fields" should be enforced later
-- in integrity_checks.sql/backend (not by FK alone).
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.rgp_outward_line (
  voucher_line_id    bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,

  asset_id           bigint REFERENCES erp.assets(id) ON DELETE RESTRICT,

  item_type_code     text NOT NULL REFERENCES erp.asset_type_registry(code) ON DELETE RESTRICT,
  item_description   text NOT NULL,
  serial_no          text,

  qty                numeric(18,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  condition_out_code text NOT NULL REFERENCES erp.rgp_condition_registry(code) ON DELETE RESTRICT,
  remarks            text
);

CREATE INDEX IF NOT EXISTS idx_rgp_outward_line_asset
  ON erp.rgp_outward_line(asset_id);

CREATE INDEX IF NOT EXISTS idx_rgp_outward_line_type
  ON erp.rgp_outward_line(item_type_code);

-- --------------------------------------------------------------------
-- RGP inward header (returns against a specific outward voucher)
-- Status updates on outward (PARTIALLY_RETURNED / CLOSED) are enforced by backend
-- and/or integrity_checks.sql (based on total returned vs outward qty).
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.rgp_inward (
  voucher_id          bigint PRIMARY KEY REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  rgp_out_voucher_id  bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE RESTRICT,
  return_date         date NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS idx_rgp_inward_out_voucher
  ON erp.rgp_inward(rgp_out_voucher_id);

-- --------------------------------------------------------------------
-- RGP inward lines (returned quantities against outward lines)
-- rgp_out_voucher_line_id points to the original outward voucher_line row.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp.rgp_inward_line (
  id                     bigserial PRIMARY KEY,
  rgp_in_voucher_id       bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
  rgp_out_voucher_line_id bigint NOT NULL REFERENCES erp.voucher_line(id) ON DELETE RESTRICT,

  returned_qty            numeric(18,3) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  condition_in_code       text NOT NULL REFERENCES erp.rgp_condition_registry(code) ON DELETE RESTRICT,
  remarks                 text
);

CREATE INDEX IF NOT EXISTS idx_rgp_inward_line_in_voucher
  ON erp.rgp_inward_line(rgp_in_voucher_id);

CREATE INDEX IF NOT EXISTS idx_rgp_inward_line_out_line
  ON erp.rgp_inward_line(rgp_out_voucher_line_id);
