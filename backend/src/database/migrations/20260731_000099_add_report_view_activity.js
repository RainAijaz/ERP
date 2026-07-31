// Report views/loads are recorded in erp.activity_log, but both of the columns
// that describe them are FK-restricted lookups (entity_type_registry,
// audit_action_registry). Without these two codes every report-view insert
// fails with a foreign key violation, so this must run before the middleware
// can log anything.
exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.entity_type_registry (code, name, description)
    VALUES ('REPORT', 'Report', 'Report screen opened or run by a user')
    ON CONFLICT (code) DO NOTHING
  `);
  await knex.raw(`
    INSERT INTO erp.audit_action_registry (code, name, description)
    VALUES ('VIEW', 'View', 'Screen or report opened/loaded (read-only access)')
    ON CONFLICT (code) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  // Only drop the codes when nothing references them: activity_log rows FK onto
  // both, and deleting the lookup would either fail or orphan history.
  await knex.raw(`
    DELETE FROM erp.audit_action_registry
    WHERE code = 'VIEW'
      AND NOT EXISTS (SELECT 1 FROM erp.activity_log WHERE action = 'VIEW')
  `);
  await knex.raw(`
    DELETE FROM erp.entity_type_registry
    WHERE code = 'REPORT'
      AND NOT EXISTS (SELECT 1 FROM erp.activity_log WHERE entity_type = 'REPORT')
      AND NOT EXISTS (SELECT 1 FROM erp.approval_request WHERE entity_type = 'REPORT')
  `);
};
