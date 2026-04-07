exports.up = async function up(knex) {
  const hasUsers = await knex.schema.withSchema("erp").hasTable("users");
  if (hasUsers) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_users_login_lower_username
      ON erp.users ((lower(username)))
    `);
  }

  const hasApprovalRequest = await knex.schema
    .withSchema("erp")
    .hasTable("approval_request");
  if (hasApprovalRequest) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_approval_request_user_status_decided_at
      ON erp.approval_request (requested_by, status, decided_at DESC)
      WHERE status IN ('APPROVED', 'REJECTED')
    `);
  }
};

exports.down = async function down(knex) {
  await knex.raw(
    "DROP INDEX IF EXISTS erp.idx_approval_request_user_status_decided_at",
  );
  await knex.raw("DROP INDEX IF EXISTS erp.idx_users_login_lower_username");
};
