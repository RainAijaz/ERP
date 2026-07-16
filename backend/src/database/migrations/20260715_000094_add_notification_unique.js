// Adds a unique index on (approval_request_id, user_id) so notification
// fan-out is idempotent even under concurrent backfill sweeps (the bell's
// GET /notifications and the SSE connect can run the sweep at the same time).
// A plain unique index still allows multiple rows with NULL approval_request_id
// (Postgres treats NULLs as distinct), which future non-approval notifications
// may use.
const INDEX = "uq_notification_request_user";

exports.up = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable("notification");
  if (!hasTable) return;

  // Defensively remove any pre-existing duplicates, keeping the earliest row.
  await knex.raw(`
    DELETE FROM erp.notification n
    USING erp.notification d
    WHERE n.approval_request_id IS NOT NULL
      AND n.approval_request_id = d.approval_request_id
      AND n.user_id = d.user_id
      AND n.id > d.id
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX}
      ON erp.notification (approval_request_id, user_id)
  `);
};

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS erp.${INDEX}`);
};
