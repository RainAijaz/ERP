/* =============================================================================
   FILE: 099_consumable_purchase_category.sql
   PURPOSE
   - Adds CONSUMABLE as a valid purchase_category on purchase_invoice_header_ext.
   - Consumable purchases are indirect materials (cotton waste, nails, lubricants)
     that are expensed directly to an expense account and never hit inventory.
   - GRN and Purchase Return intentionally keep RAW_MATERIAL / ASSET only.
   ============================================================================ */

SET search_path = erp;

ALTER TABLE erp.purchase_invoice_header_ext
  DROP CONSTRAINT IF EXISTS purchase_invoice_header_ext_purchase_category_check;

ALTER TABLE erp.purchase_invoice_header_ext
  ADD CONSTRAINT purchase_invoice_header_ext_purchase_category_check
  CHECK (purchase_category IN ('RAW_MATERIAL', 'ASSET', 'CONSUMABLE'));
