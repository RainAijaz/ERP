// Existing voucher approval reconciliation records a maker closing their own
// pending request as WITHDRAWN. Fresh DDL has this enum value, but upgraded
// databases need the same change through Knex migrations.

exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TYPE erp.approval_status ADD VALUE IF NOT EXISTS 'WITHDRAWN'
  `);

  await knex.raw(`
    DO $$
    DECLARE v text;
    BEGIN
      SELECT conname INTO v
      FROM pg_constraint
      WHERE conrelid = 'erp.approval_request'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%decided_by%<>%requested_by%'
        AND pg_get_constraintdef(oid) NOT ILIKE '%WITHDRAWN%';
      IF v IS NOT NULL THEN
        EXECUTE 'ALTER TABLE erp.approval_request DROP CONSTRAINT ' || quote_ident(v);
      END IF;
    END $$
  `);

  await knex.raw(`
    ALTER TABLE erp.approval_request
    DROP CONSTRAINT IF EXISTS approval_request_maker_checker_check
  `);

  await knex.raw(`
    ALTER TABLE erp.approval_request
    ADD CONSTRAINT approval_request_maker_checker_check CHECK (
      decided_by IS NULL
      OR status = 'WITHDRAWN'
      OR decided_by <> requested_by
    )
  `);
};

exports.down = async function down(knex) {
  const { rows } = await knex.raw(`
    SELECT 1
    FROM erp.approval_request
    WHERE status = 'WITHDRAWN'
    LIMIT 1
  `);

  if (rows.length) return;

  await knex.raw(`
    ALTER TABLE erp.approval_request
    DROP CONSTRAINT IF EXISTS approval_request_maker_checker_check
  `);

  await knex.raw(`
    ALTER TABLE erp.approval_request
    ADD CONSTRAINT approval_request_maker_checker_check CHECK (
      decided_by IS NULL
      OR decided_by <> requested_by
    )
  `);
};
