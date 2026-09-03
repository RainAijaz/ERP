// 20260903_000115_role_is_admin_flag.js
//
// Two related fixes, both behind the same root cause: "is this the admin role?"
// was answered by matching the role's NAME against the literal string "admin".
//
// 1) erp.role_templates.is_admin
//    middleware/core/auth.js derived req.user.isAdmin as
//      String(role.name).trim().toLowerCase() === "admin"
//    and req.user.isAdmin is what every permission check in the app short-circuits
//    on (res.locals.can, middleware/access/role-permissions.js,
//    middleware/approvals/screen-approval.js, branch scoping, ...). So renaming the
//    role to "Administrator", "Admins" or "Super Admin" -- or creating a second
//    admin role -- silently stripped that account of every bypass, with no error
//    anywhere: buttons just render disabled and clicks do nothing.
//    utils/approval-notifications.js already disagreed with auth.js, matching
//    ('admin', 'administrator'), so a role named "Administrator" received approval
//    e-mails while having no admin rights at all.
//    is_admin makes it a stored fact instead of a naming convention.
//
// 2) The admin permission baseline was missing six action columns.
//    ddl/092_seeds.sql grants the admin role every scope, but it was written
//    against the original seven action columns in ddl/010_administration.sql and
//    was never extended when later migrations added more. The result, verified on
//    a live database: all 34 VOUCHER grant rows had can_delete = true and
//    can_hard_delete = false -- and voucher screens check can_hard_delete, not
//    can_delete (can_delete is not even in VOUCHER_ACTIONS in
//    utils/scope-action-policy.js). The permissions screen labels the
//    can_hard_delete checkbox "Delete", so it read as granted when it was not.
//    Same gap for can_load, can_view_details, can_export_excel_csv,
//    can_filter_all_branches and can_view_cost_fields, which is why report
//    "All branches" filters were dead for everyone but a name-matched admin.
//
//    Only the admin baseline is repaired here. Non-admin roles keep exactly the
//    grants they have -- this must not hand delete rights to anyone else.
//
// can_post / can_unpost are deliberately left alone: they are not in ACTION_KEYS
// in utils/scope-action-policy.js, so nothing reads them.

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.role_templates
      ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
  `);

  // Backfill exactly the roles that auth.js already treated as admin, so no role
  // gains access it did not already have. Anything else is an explicit decision
  // an admin makes later by flipping the flag.
  await knex.raw(`
    UPDATE erp.role_templates
    SET is_admin = true
    WHERE lower(trim(name)) = 'admin';
  `);

  // Give every admin role the complete baseline across every registered scope.
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
  // The permission grants are not rolled back: they are what ddl/092_seeds.sql
  // always meant to grant, and revoking them would lock the admin out of screens
  // that worked before this migration ran.
  await knex.raw(`
    ALTER TABLE erp.role_templates
      DROP COLUMN IF EXISTS is_admin;
  `);
};
