// A browser retry must resolve to the voucher created by its first request.
// Existing documents keep NULL and are unaffected.
exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE erp.voucher_header
      ADD COLUMN IF NOT EXISTS submission_key uuid,
      ADD COLUMN IF NOT EXISTS submission_hash char(64);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_voucher_header_submission_key
      ON erp.voucher_header (submission_key)
      WHERE submission_key IS NOT NULL;
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    DROP INDEX IF EXISTS erp.uq_voucher_header_submission_key;
    ALTER TABLE erp.voucher_header
      DROP COLUMN IF EXISTS submission_hash,
      DROP COLUMN IF EXISTS submission_key;
  `);
};
