// 20260716_000096_seed_labour_allowance_permissions.js
// Registering a SCREEN scope does not by itself grant anyone access: SCREEN
// scopes are NOT inherited from MODULE permissions (see middleware/core/auth.js
// `can`), so a brand-new screen is invisible to every non-admin role until it
// has explicit role_permissions rows. Only the "admin" role bypasses this.
//
// Mirror whatever roles already hold for the employee Allowances screen onto
// the new Labour Allowances screen, so the two behave identically out of the box.

const SOURCE_SCOPE_KEY = "hr_payroll.allowances";
const TARGET_SCOPE_KEY = "hr_payroll.labour_allowances";

exports.up = async function up(knex) {
  await knex.raw(
    `
    INSERT INTO erp.role_permissions (
      role_id, scope_id,
      can_view, can_create, can_edit, can_delete, can_print,
      can_approve, can_post, can_unpost, can_navigate, can_hard_delete,
      can_load, can_view_details, can_export_excel_csv,
      can_filter_all_branches, can_view_cost_fields
    )
    SELECT
      src.role_id, tgt.id,
      src.can_view, src.can_create, src.can_edit, src.can_delete, src.can_print,
      src.can_approve, src.can_post, src.can_unpost, src.can_navigate, src.can_hard_delete,
      src.can_load, src.can_view_details, src.can_export_excel_csv,
      src.can_filter_all_branches, src.can_view_cost_fields
    FROM erp.role_permissions src
    JOIN erp.permission_scope_registry srcs
      ON srcs.id = src.scope_id
     AND srcs.scope_type = 'SCREEN'
     AND srcs.scope_key = ?
    JOIN erp.permission_scope_registry tgt
      ON tgt.scope_type = 'SCREEN'
     AND tgt.scope_key = ?
    ON CONFLICT (role_id, scope_id) DO NOTHING;
  `,
    [SOURCE_SCOPE_KEY, TARGET_SCOPE_KEY],
  );
};

exports.down = async function down(knex) {
  // Must run before the scope row itself is dropped: role_permissions.scope_id
  // is ON DELETE RESTRICT, so leftover grants would block that rollback.
  await knex.raw(
    `
    DELETE FROM erp.role_permissions rp
    USING erp.permission_scope_registry r
    WHERE r.id = rp.scope_id
      AND r.scope_type = 'SCREEN'
      AND r.scope_key = ?;
  `,
    [TARGET_SCOPE_KEY],
  );
};
