exports.up = async function up(knex) {
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON erp.activity_log (created_at DESC)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_activity_log_user_created_at ON erp.activity_log (user_id, created_at DESC)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_activity_log_branch_created_at ON erp.activity_log (branch_id, created_at DESC)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_activity_log_entity_created_at ON erp.activity_log (entity_type, created_at DESC)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_activity_log_action_created_at ON erp.activity_log (action, created_at DESC)");
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.idx_activity_log_action_created_at");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_activity_log_entity_created_at");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_activity_log_branch_created_at");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_activity_log_user_created_at");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_activity_log_created_at");
};
