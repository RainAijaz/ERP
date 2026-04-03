SET search_path = erp;

-- =============================================================================
-- 098_allow_negative_stock_balance_sku.sql
-- =============================================================================
-- Allow controlled negative inventory for SKU balances (FG/SFG).
-- Existing databases may have auto-named CHECK constraints, so we drop by
-- inspecting expression text instead of hardcoding only one constraint name.

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'erp'
      AND t.relname = 'stock_balance_sku'
      AND c.contype = 'c'
      AND (
        pg_get_constraintdef(c.oid) ILIKE '%qty_pairs%>=%'
        OR pg_get_constraintdef(c.oid) ILIKE '%value%>=%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE erp.stock_balance_sku DROP CONSTRAINT IF EXISTS %I',
      rec.conname
    );
  END LOOP;
END
$$;

-- Keep weighted-average cost non-negative.
ALTER TABLE erp.stock_balance_sku
  DROP CONSTRAINT IF EXISTS stock_balance_sku_wac_check;

ALTER TABLE erp.stock_balance_sku
  ADD CONSTRAINT stock_balance_sku_wac_check
  CHECK (wac >= 0);

