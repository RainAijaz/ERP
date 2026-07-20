// Durable retry queue for WhatsApp payment notifications.
//
// Transient failures (WhatsApp down / send error) previously left a FAILED row
// and the message text was lost. These columns let the row itself act as the
// queue: the rendered message is stored so it can be re-sent verbatim, and the
// worker uses next_retry_at/attempts for backoff.

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.whatsapp_notification_log
      ADD COLUMN IF NOT EXISTS message_body    text,
      ADD COLUMN IF NOT EXISTS attempts        integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
      ADD COLUMN IF NOT EXISTS next_retry_at   timestamptz
  `);

  // The original CHECK only allowed SENT/FAILED; QUEUED is the awaiting-retry state.
  await knex.raw(`
    ALTER TABLE erp.whatsapp_notification_log
      DROP CONSTRAINT IF EXISTS whatsapp_notification_log_status_chk
  `);
  await knex.raw(`
    ALTER TABLE erp.whatsapp_notification_log
      ADD CONSTRAINT whatsapp_notification_log_status_chk
      CHECK (status IN ('SENT', 'FAILED', 'QUEUED'))
  `);

  // Worker lookup: due queued rows, oldest first.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS whatsapp_notification_log_retry_idx
      ON erp.whatsapp_notification_log (status, next_retry_at)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS erp.whatsapp_notification_log_retry_idx
  `);
  // Anything still queued has no meaning once the columns go, so settle them
  // as FAILED before restoring the two-value constraint.
  await knex.raw(`
    UPDATE erp.whatsapp_notification_log
       SET status = 'FAILED',
           failure_reason = COALESCE(failure_reason, 'retry_support_removed')
     WHERE status = 'QUEUED'
  `);
  await knex.raw(`
    ALTER TABLE erp.whatsapp_notification_log
      DROP CONSTRAINT IF EXISTS whatsapp_notification_log_status_chk
  `);
  await knex.raw(`
    ALTER TABLE erp.whatsapp_notification_log
      ADD CONSTRAINT whatsapp_notification_log_status_chk
      CHECK (status IN ('SENT', 'FAILED'))
  `);
  await knex.raw(`
    ALTER TABLE erp.whatsapp_notification_log
      DROP COLUMN IF EXISTS message_body,
      DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS last_attempt_at,
      DROP COLUMN IF EXISTS next_retry_at
  `);
};
