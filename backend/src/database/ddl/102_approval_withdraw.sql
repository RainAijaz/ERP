-- =====================================================================
-- 102_approval_withdraw.sql
-- Let a requester withdraw their own PENDING approval request instead of
-- needing an admin to reject it (which both burns approver attention and
-- pollutes the REJECTED tab with rows nobody actually rejected).
--
-- A withdrawal is recorded as status='WITHDRAWN' with
--   decided_by = requested_by, decided_at = now()
-- so the existing "once decided, decided_by/decided_at are present" CHECK
-- keeps holding and the approvals page can render the withdrawal time in
-- the column it already has. Only the maker-checker CHECK has to give.
--
-- IMPORTANT: do NOT add this file to 999_all.sql. That manifest wraps every
-- file in a single BEGIN/COMMIT, and PostgreSQL refuses to use a new enum
-- label in the same transaction that added it ("unsafe use of new value of
-- enum type"). Run it standalone, where psql autocommits each statement:
--   psql -U postgres -d erp -v ON_ERROR_STOP=1 -f src/database/ddl/102_approval_withdraw.sql
-- =====================================================================

-- 1. New approval status. NOTE: erp.approval_status is shared with
--    erp.voucher_header.status, so this label becomes technically legal
--    there too. Nothing writes it on vouchers -- a withdrawn create-voucher
--    request still leaves its header REJECTED, same as a rejection does.
ALTER TYPE erp.approval_status ADD VALUE IF NOT EXISTS 'WITHDRAWN';

-- 2. Relax the maker-checker rule for withdrawals only.
--    The original CHECK is an unnamed inline constraint from CREATE TABLE
--    (auto-named approval_request_check / _check1), so find it by definition
--    rather than by name.
DO $$
DECLARE v text;
BEGIN
  SELECT conname INTO v
  FROM pg_constraint
  WHERE conrelid = 'erp.approval_request'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%decided_by%<>%requested_by%'
    AND pg_get_constraintdef(oid) NOT ILIKE '%status%';
  IF v IS NOT NULL THEN
    EXECUTE 'ALTER TABLE erp.approval_request DROP CONSTRAINT ' || quote_ident(v);
  END IF;
END $$;

ALTER TABLE erp.approval_request
  DROP CONSTRAINT IF EXISTS approval_request_maker_checker_check;

-- A checker still may not decide their own request; a maker may withdraw it.
ALTER TABLE erp.approval_request
  ADD CONSTRAINT approval_request_maker_checker_check CHECK (
    decided_by IS NULL
    OR status = 'WITHDRAWN'
    OR decided_by <> requested_by
  );
