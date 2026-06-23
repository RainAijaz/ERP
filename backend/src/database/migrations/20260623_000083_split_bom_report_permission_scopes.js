exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES
      ('REPORT', 'master_data.bom.reports.version_history',     'BOM Version History Report',     'Master Data'),
      ('REPORT', 'master_data.bom.reports.cost_breakdown',      'BOM Cost Breakdown Report',      'Master Data'),
      ('REPORT', 'master_data.bom.reports.lifecycle_status',    'BOM Lifecycle Status Report',    'Master Data'),
      ('REPORT', 'master_data.bom.reports.change_log',          'BOM Change Log Report',          'Master Data'),
      ('REPORT', 'master_data.bom.reports.approval_queue_aging','BOM Approval Queue Aging Report','Master Data')
    ON CONFLICT (scope_type, scope_key) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'REPORT'
      AND scope_key IN (
        'master_data.bom.reports.version_history',
        'master_data.bom.reports.cost_breakdown',
        'master_data.bom.reports.lifecycle_status',
        'master_data.bom.reports.change_log',
        'master_data.bom.reports.approval_queue_aging'
      )
  `);
};
