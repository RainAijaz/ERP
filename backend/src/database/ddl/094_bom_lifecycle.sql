SET search_path = erp;

ALTER TABLE IF EXISTS erp.bom_header
  ADD COLUMN IF NOT EXISTS is_active boolean;

UPDATE erp.bom_header
SET is_active = true
WHERE is_active IS NULL;

ALTER TABLE IF EXISTS erp.bom_header
  ALTER COLUMN is_active SET DEFAULT true;

ALTER TABLE IF EXISTS erp.bom_header
  ALTER COLUMN is_active SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_bom_header_item_active
ON erp.bom_header(item_id, is_active);
