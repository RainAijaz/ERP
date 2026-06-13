-- =====================================================================
-- 101_staff_credit_sales.sql
-- Allow employees and labours to buy on credit directly in the sales
-- voucher. Introduces buyer_employee_id and buyer_labour_id columns on
-- sales_header, a dedicated staff_receivable_control account group, and
-- migrates any existing "Staff Receivable" account into that group.
-- =====================================================================

-- 1. Add dedicated account group for Staff Receivable so GL posting can
--    target it separately from the regular AR control account.
INSERT INTO erp.account_groups (account_type, code, name)
VALUES ('ASSET', 'staff_receivable_control', 'Staff Receivable')
ON CONFLICT DO NOTHING;

-- 2. Move any account currently in accounts_receivable_control whose
--    name matches "staff receivable" (case-insensitive) into the new group.
UPDATE erp.accounts
SET subgroup_id = (
  SELECT id FROM erp.account_groups WHERE code = 'staff_receivable_control'
)
WHERE subgroup_id = (
  SELECT id FROM erp.account_groups WHERE code = 'accounts_receivable_control'
)
AND lower(name) LIKE '%staff%receiv%';

-- 3. New buyer columns on sales_header.
ALTER TABLE erp.sales_header
  ADD COLUMN IF NOT EXISTS buyer_employee_id bigint REFERENCES erp.employees(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS buyer_labour_id   bigint REFERENCES erp.labours(id)   ON DELETE RESTRICT;

-- 4. At most one buyer type can be set at a time.
ALTER TABLE erp.sales_header
  DROP CONSTRAINT IF EXISTS sales_header_single_buyer_check;
ALTER TABLE erp.sales_header
  ADD CONSTRAINT sales_header_single_buyer_check CHECK (
    (CASE WHEN customer_party_id  IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN buyer_employee_id  IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN buyer_labour_id    IS NOT NULL THEN 1 ELSE 0 END) <= 1
  );

-- 5. Replace the CREDIT-requires-party constraint to also accept
--    employee/labour buyers.
DO $$
DECLARE v text;
BEGIN
  SELECT conname INTO v
  FROM pg_constraint
  WHERE conrelid = 'erp.sales_header'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%payment_type%CREDIT%customer_party_id%';
  IF v IS NOT NULL THEN
    EXECUTE 'ALTER TABLE erp.sales_header DROP CONSTRAINT ' || quote_ident(v);
  END IF;
END $$;

ALTER TABLE erp.sales_header
  ADD CONSTRAINT sales_header_credit_buyer_check CHECK (
    (payment_type = 'CASH')
    OR (payment_type = 'CREDIT' AND (
      customer_party_id IS NOT NULL
      OR buyer_employee_id IS NOT NULL
      OR buyer_labour_id  IS NOT NULL
    ))
  );

-- 6. Replace the cash-walk-in constraint (name+phone required when no party)
--    to also exempt employee/labour buyers.
DO $$
DECLARE v text;
BEGIN
  SELECT conname INTO v
  FROM pg_constraint
  WHERE conrelid = 'erp.sales_header'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%customer_party_id%customer_name%';
  IF v IS NOT NULL THEN
    EXECUTE 'ALTER TABLE erp.sales_header DROP CONSTRAINT ' || quote_ident(v);
  END IF;
END $$;

ALTER TABLE erp.sales_header
  ADD CONSTRAINT sales_header_walk_in_check CHECK (
    customer_party_id  IS NOT NULL
    OR buyer_employee_id IS NOT NULL
    OR buyer_labour_id   IS NOT NULL
    OR (COALESCE(trim(customer_name), '')        <> ''
    AND COALESCE(trim(customer_phone_number), '') <> '')
  );
