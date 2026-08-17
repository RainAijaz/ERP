// Rejecting or withdrawing an approval request must record why.
//
// erp.approval_request.decision_notes has existed since 010_administration.sql
// but nothing ever wrote it -- the reject route dropped the field entirely, so
// a requester was told THAT their request was rejected and never why. Now that
// both routes require a typed reason, this constraint keeps it that way: a
// future code path cannot silently close a request without one.
//
// APPROVED is exempt on purpose (approvers clear queues in bulk). Paths that
// close a request with no human present -- a voucher deleted on its own screen,
// via utils/voucher-approval-sync.js -- write a SYSTEM: sentinel from
// utils/approval-decision-notes.js, so they satisfy this too.
//
// NOT VALID because every historical REJECTED row carries a NULL note and there
// is nothing honest to backfill them with. New and updated rows are still fully
// checked; only the existing-row scan is skipped. Run VALIDATE CONSTRAINT later
// only if those rows are ever backfilled.
//
// Explicitly named: the sibling state-consistency CHECK on this table is
// unnamed, which is why 102_approval_withdraw.sql has to hunt constraints via
// pg_get_constraintdef(...) ILIKE. Don't inflict that on the next person.
const CONSTRAINT_NAME = "approval_request_decision_notes_check";

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'erp.approval_request'::regclass`,
    [CONSTRAINT_NAME],
  );
  if (rows.length) return;

  // The predicate has two traps in it, both caught by
  // src/scripts/test-approval-reject-reason.js -- do not "simplify" it:
  //   - btrim(x) <> '' would NOT work: single-argument btrim strips spaces
  //     ONLY, so a note of pure newlines or tabs sails through.
  //   - COALESCE is load-bearing: `NULL ~ '...'` evaluates to NULL, and a CHECK
  //     passes on NULL, so without it a note-less rejection is accepted.
  await knex.raw(`
    ALTER TABLE erp.approval_request
      ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (
        status NOT IN ('REJECTED','WITHDRAWN')
        OR COALESCE(decision_notes, '') ~ '[^[:space:]]'
      ) NOT VALID
  `);
};

exports.down = async function down(knex) {
  await knex.raw(
    `ALTER TABLE erp.approval_request DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`,
  );
};
