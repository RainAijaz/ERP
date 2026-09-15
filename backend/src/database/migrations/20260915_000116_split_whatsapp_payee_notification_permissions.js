const SCOPES = [
  {
    scope_key: "financial.whatsapp_notify_suppliers",
    description: "WhatsApp Supplier Payment Notifications",
    description_ur: "واٹس ایپ سپلائر ادائیگی اطلاعات",
  },
  {
    scope_key: "financial.whatsapp_notify_labours",
    description: "WhatsApp Labour Payment Notifications",
    description_ur: "واٹس ایپ لیبر ادائیگی اطلاعات",
  },
  {
    scope_key: "financial.whatsapp_notify_employees",
    description: "WhatsApp Employee Payment Notifications",
    description_ur: "واٹس ایپ ملازم ادائیگی اطلاعات",
  },
];

exports.up = async function up(knex) {
  for (const scope of SCOPES) {
    await knex.raw(
      `
      INSERT INTO erp.permission_scope_registry (
        scope_type, scope_key, description, module_group, description_ur, module_group_ur
      )
      VALUES ('SCREEN', ?, ?, 'Financial', ?, 'مالیاتی')
      ON CONFLICT (scope_type, scope_key) DO UPDATE SET
        description = EXCLUDED.description,
        module_group = EXCLUDED.module_group,
        description_ur = COALESCE(erp.permission_scope_registry.description_ur, EXCLUDED.description_ur),
        module_group_ur = COALESCE(erp.permission_scope_registry.module_group_ur, EXCLUDED.module_group_ur)
      `,
      [scope.scope_key, scope.description, scope.description_ur],
    );
  }

  await knex.raw(`
    INSERT INTO erp.role_permissions (
      role_id, scope_id,
      can_navigate, can_view, can_load, can_view_details,
      can_create, can_edit, can_delete, can_hard_delete,
      can_print, can_export_excel_csv, can_filter_all_branches,
      can_view_cost_fields, can_approve
    )
    SELECT
      r.id, s.id,
      true, true, true, true,
      true, true, true, true,
      true, true, true,
      true, true
    FROM erp.role_templates r
    CROSS JOIN erp.permission_scope_registry s
    WHERE r.is_admin = true
      AND s.scope_type = 'SCREEN'
      AND s.scope_key IN (
        'financial.whatsapp_notify_suppliers',
        'financial.whatsapp_notify_labours',
        'financial.whatsapp_notify_employees'
      )
    ON CONFLICT (role_id, scope_id) DO UPDATE SET
      can_navigate            = true,
      can_view                = true,
      can_load                = true,
      can_view_details        = true,
      can_create              = true,
      can_edit                = true,
      can_delete              = true,
      can_hard_delete         = true,
      can_print               = true,
      can_export_excel_csv    = true,
      can_filter_all_branches = true,
      can_view_cost_fields    = true,
      can_approve             = true;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.role_permissions rp
    USING erp.permission_scope_registry s
    WHERE s.id = rp.scope_id
      AND s.scope_type = 'SCREEN'
      AND s.scope_key IN (
        'financial.whatsapp_notify_suppliers',
        'financial.whatsapp_notify_labours',
        'financial.whatsapp_notify_employees'
      )
  `);

  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'SCREEN'
      AND scope_key IN (
        'financial.whatsapp_notify_suppliers',
        'financial.whatsapp_notify_labours',
        'financial.whatsapp_notify_employees'
      )
  `);
};
