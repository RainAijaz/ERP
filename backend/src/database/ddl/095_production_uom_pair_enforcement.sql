/*
  ============================================================================
  095_production_uom_pair_enforcement.sql
  ============================================================================
  Purpose
  -------
  Enforce a single canonical base UOM rule for production items:
  - Finished Goods (FG) and Semi-Finished Goods (SFG) must use PAIR as base UOM.

  What this migration does
  ------------------------
  1) Normalizes/creates canonical UOM masters:
     - PAIR (code: PAIR, name: Pair)
     - Dozen (code: DZN, name: Dozen)
  2) Ensures bidirectional UOM conversion rows exist and are active:
     - Pair -> Dozen = 0.083333
     - Dozen -> Pair = 12
  3) Performs one-time data correction:
     - Updates existing FG/SFG items to base_uom_id = PAIR.
  4) Adds a DB trigger guard to prevent future invalid FG/SFG base UOM values.

  Design notes
  ------------
  - Idempotent: Safe to run multiple times. Existing rows are reused/updated.
  - Conflict-safe: Uses ON CONFLICT and duplicate checks before code/name rewrites.
  - Strict enforcement: Trigger validates both INSERT and relevant UPDATE operations.
  ============================================================================
*/

-- Run all unqualified table/function references in ERP schema.
SET search_path = erp;

-- Ensure canonical UOM rows exist for production quantity handling.
-- This block also standardizes names/codes where safe, without breaking duplicates.
DO $$
DECLARE
  -- Canonical IDs resolved/created during migration.
  v_pair_id bigint;
  v_dzn_id bigint;
  -- Helper used to decide whether DZN code can be rewritten safely.
  v_dzn_code text;
BEGIN
  -- 1) Resolve PAIR UOM by code first (preferred canonical match).
  SELECT id INTO v_pair_id
  FROM erp.uom
  WHERE lower(code) = 'pair'
  ORDER BY id
  LIMIT 1;

  -- 2) Fallback: resolve PAIR by name if code is not canonical yet.
  IF v_pair_id IS NULL THEN
    SELECT id INTO v_pair_id
    FROM erp.uom
    WHERE lower(name) = 'pair'
    ORDER BY id
    LIMIT 1;
  END IF;

  -- 3) Create PAIR if still missing.
  IF v_pair_id IS NULL THEN
    INSERT INTO erp.uom (code, name, is_active, created_at)
    VALUES ('PAIR', 'Pair', true, now())
    RETURNING id INTO v_pair_id;
  ELSE
    -- 4) Normalize existing PAIR row:
    --    - Force canonical code to PAIR
    --    - Set canonical name "Pair" only if it is safe (no duplicate "pair" name)
    --    - Ensure active status
    UPDATE erp.uom
    SET code = 'PAIR',
        name = CASE
          WHEN lower(name) = 'pair'
            OR NOT EXISTS (
              SELECT 1 FROM erp.uom u2 WHERE lower(u2.name) = 'pair' AND u2.id <> v_pair_id
            )
          THEN 'Pair'
          ELSE name
        END,
        is_active = true,
        updated_at = now()
    WHERE id = v_pair_id;
  END IF;

  -- 5) Resolve Dozen by canonical short code first (DZN).
  SELECT id INTO v_dzn_id
  FROM erp.uom
  WHERE lower(code) = 'dzn'
  ORDER BY id
  LIMIT 1;

  -- 6) Fallbacks for legacy code/name variants (DOZEN, name Dozen, name DZN).
  IF v_dzn_id IS NULL THEN
    SELECT id INTO v_dzn_id
    FROM erp.uom
    WHERE lower(code) = 'dozen'
    ORDER BY id
    LIMIT 1;
  END IF;

  IF v_dzn_id IS NULL THEN
    SELECT id INTO v_dzn_id
    FROM erp.uom
    WHERE lower(name) IN ('dozen', 'dzn')
    ORDER BY id
    LIMIT 1;
  END IF;

  -- 7) Create Dozen if still missing.
  IF v_dzn_id IS NULL THEN
    INSERT INTO erp.uom (code, name, is_active, created_at)
    VALUES ('DZN', 'Dozen', true, now())
    RETURNING id INTO v_dzn_id;
  ELSE
    -- 8) Existing Dozen row found; inspect current code for safe rewrite behavior.
    SELECT lower(code) INTO v_dzn_code
    FROM erp.uom
    WHERE id = v_dzn_id;

    -- 9) If code is not DZN and DZN is not used elsewhere, normalize both code/name.
    IF v_dzn_code <> 'dzn'
      AND NOT EXISTS (
        SELECT 1 FROM erp.uom WHERE lower(code) = 'dzn' AND id <> v_dzn_id
      ) THEN
      UPDATE erp.uom
      SET code = 'DZN',
          name = CASE
            WHEN lower(name) = 'dozen'
              OR NOT EXISTS (
                SELECT 1 FROM erp.uom u2 WHERE lower(u2.name) = 'dozen' AND u2.id <> v_dzn_id
              )
            THEN 'Dozen'
            ELSE name
          END,
          is_active = true,
          updated_at = now()
      WHERE id = v_dzn_id;
    ELSE
      -- 10) Otherwise preserve existing code (to avoid conflicts), only normalize name
      --     when safe, and ensure active status.
      UPDATE erp.uom
      SET name = CASE
            WHEN lower(name) = 'dozen'
              OR NOT EXISTS (
                SELECT 1 FROM erp.uom u2 WHERE lower(u2.name) = 'dozen' AND u2.id <> v_dzn_id
              )
            THEN 'Dozen'
            ELSE name
          END,
          is_active = true,
          updated_at = now()
      WHERE id = v_dzn_id;
    END IF;
  END IF;

  -- 11) Final guard: ensure at least one DZN-coded row exists.
  --     If not, create one with conflict protection.
  SELECT id INTO v_dzn_id
  FROM erp.uom
  WHERE lower(code) = 'dzn'
  ORDER BY id
  LIMIT 1;

  IF v_dzn_id IS NULL THEN
    INSERT INTO erp.uom (code, name, is_active, created_at)
    VALUES ('DZN', 'Dozen', true, now())
    ON CONFLICT (code) DO NOTHING;

    SELECT id INTO v_dzn_id
    FROM erp.uom
    WHERE lower(code) = 'dzn'
    ORDER BY id
    LIMIT 1;
  END IF;

  -- 12) Ensure Pair -> Dozen conversion exists and is active.
  --     Upsert keeps factor synchronized on reruns.
  INSERT INTO erp.uom_conversions (from_uom_id, to_uom_id, factor, is_active, created_at)
  VALUES (v_pair_id, v_dzn_id, 0.083333, true, now())
  ON CONFLICT (from_uom_id, to_uom_id)
  DO UPDATE SET
    factor = EXCLUDED.factor,
    is_active = true,
    updated_at = now();

  -- 13) Ensure Dozen -> Pair conversion exists and is active.
  INSERT INTO erp.uom_conversions (from_uom_id, to_uom_id, factor, is_active, created_at)
  VALUES (v_dzn_id, v_pair_id, 12, true, now())
  ON CONFLICT (from_uom_id, to_uom_id)
  DO UPDATE SET
    factor = EXCLUDED.factor,
    is_active = true,
    updated_at = now();

  -- 14) One-time data fix before trigger enforcement:
  --     force all existing FG/SFG items to canonical PAIR base UOM.
  UPDATE erp.items
  SET base_uom_id = v_pair_id,
      updated_at = now()
  WHERE item_type IN ('FG', 'SFG')
    AND base_uom_id IS DISTINCT FROM v_pair_id;
END;
$$;

-- DB-level guard: FG/SFG must always remain in PAIR.
CREATE OR REPLACE FUNCTION erp.trg_items_enforce_pair_for_production()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Canonical PAIR UOM ID resolved at runtime.
  v_pair_uom_id bigint;
BEGIN
  -- Enforce only for production item types.
  IF NEW.item_type IN ('FG', 'SFG') THEN
    -- Resolve canonical PAIR UOM.
    SELECT id
      INTO v_pair_uom_id
    FROM erp.uom
    WHERE upper(code) = 'PAIR'
    ORDER BY id
    LIMIT 1;

    -- Hard stop if reference master is missing.
    IF v_pair_uom_id IS NULL THEN
      RAISE EXCEPTION 'PAIR UOM must exist before creating/updating FG/SFG items.';
    END IF;

    -- Hard stop if FG/SFG base_uom_id is not PAIR.
    IF NEW.base_uom_id IS DISTINCT FROM v_pair_uom_id THEN
      RAISE EXCEPTION
        'Invalid base_uom_id for item_type=%. FG/SFG must use PAIR (uom_id=%).',
        NEW.item_type,
        v_pair_uom_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Recreate trigger to ensure latest function definition is active.
DROP TRIGGER IF EXISTS trg_items_enforce_pair_for_production ON erp.items;
CREATE TRIGGER trg_items_enforce_pair_for_production
-- Trigger fires before insert and before changes to item_type/base_uom_id.
BEFORE INSERT OR UPDATE OF item_type, base_uom_id ON erp.items
FOR EACH ROW
EXECUTE FUNCTION erp.trg_items_enforce_pair_for_production();
