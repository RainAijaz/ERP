exports.up = async (knex) => {
  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES
      ('SCREEN','administration.branches','Branches', 'Administration'),
      ('SCREEN','administration.users','Users', 'Administration'),
      ('SCREEN','administration.roles','Roles', 'Administration')
    ON CONFLICT (scope_type, scope_key) DO NOTHING;
  `);

  await knex.raw(`
    WITH legacy AS (
      SELECT
        rp.role_id,
        rp.can_navigate,
        rp.can_view,
        rp.can_create,
        rp.can_edit,
        rp.can_delete,
        rp.can_print,
        rp.can_approve,
        CASE s.scope_key
          WHEN 'setup:branches' THEN 'administration.branches'
          WHEN 'setup:users' THEN 'administration.users'
          WHEN 'setup:roles' THEN 'administration.roles'
        END AS new_scope_key
      FROM erp.role_permissions rp
      JOIN erp.permission_scope_registry s ON s.id = rp.scope_id
      WHERE s.scope_type = 'SCREEN'
        AND s.scope_key IN ('setup:branches','setup:users','setup:roles')
    ),
    targets AS (
      SELECT
        l.role_id,
        l.can_navigate,
        l.can_view,
        l.can_create,
        l.can_edit,
        l.can_delete,
        l.can_,
        l.can_approve,
        r.id AS scope_id
      FROM legacy l
      JOIN erp.permission_scope_registry r
        ON r.scope_type = 'SCREEN'
       AND r.scope_key = l.new_scope_key
    )
    INSERT INTO erp.role_permissions (
      role_id,
      scope_id,
      can_navigate,
      can_view,
      can_create,
      can_edit,
      can_delete,
      can_print,
      can_approve
    )
    SELECT
      role_id,
      scope_id,
      can_navigate,
      can_view,
      can_create,
      can_edit,
      can_delete,
      can_print,
      can_approve
    FROM targets
    ON CONFLICT (role_id, scope_id) DO UPDATE SET
      can_navigate = erp.role_permissions.can_navigate OR EXCLUDED.can_navigate,
      can_view = erp.role_permissions.can_view OR EXCLUDED.can_view,
      can_create = erp.role_permissions.can_create OR EXCLUDED.can_create,
      can_edit = erp.role_permissions.can_edit OR EXCLUDED.can_edit,
      can_delete = erp.role_permissions.can_delete OR EXCLUDED.can_delete,
      can_print = erp.role_permissions.can_print OR EXCLUDED.can_print,
      can_approve = erp.role_permissions.can_approve OR EXCLUDED.can_approve;
  `);

  await knex.raw(`
    WITH legacy AS (
      SELECT
        upo.user_id,
        upo.can_navigate,
        upo.can_view,
        upo.can_create,
        upo.can_edit,
        upo.can_delete,
        upo.can_print,
        upo.can_approve,
        CASE s.scope_key
          WHEN 'setup:branches' THEN 'administration.branches'
          WHEN 'setup:users' THEN 'administration.users'
          WHEN 'setup:roles' THEN 'administration.roles'
        END AS new_scope_key
      FROM erp.user_permissions_override upo
      JOIN erp.permission_scope_registry s ON s.id = upo.scope_id
      WHERE s.scope_type = 'SCREEN'
        AND s.scope_key IN ('setup:branches','setup:users','setup:roles')
    ),
    targets AS (
      SELECT
        l.user_id,
        l.can_navigate,
        l.can_view,
        l.can_create,
        l.can_edit,
        l.can_delete,
        l.can_print,
        l.can_approve,
        r.id AS scope_id
      FROM legacy l
      JOIN erp.permission_scope_registry r
        ON r.scope_type = 'SCREEN'
       AND r.scope_key = l.new_scope_key
    )
    INSERT INTO erp.user_permissions_override (
      user_id,
      scope_id,
      can_navigate,
      can_view,
      can_create,
      can_edit,
      can_delete,
      can_print,
      can_approve
    )
    SELECT
      user_id,
      scope_id,
      can_navigate,
      can_view,
      can_create,
      can_edit,
      can_delete,
      can_print,
      can_approve
    FROM targets
    ON CONFLICT (user_id, scope_id) DO UPDATE SET
      can_navigate = CASE
        WHEN erp.user_permissions_override.can_navigate IS TRUE OR EXCLUDED.can_navigate IS TRUE THEN TRUE
        WHEN erp.user_permissions_override.can_navigate IS FALSE OR EXCLUDED.can_navigate IS FALSE THEN FALSE
        ELSE NULL
      END,
      can_view = CASE
        WHEN erp.user_permissions_override.can_view IS TRUE OR EXCLUDED.can_view IS TRUE THEN TRUE
        WHEN erp.user_permissions_override.can_view IS FALSE OR EXCLUDED.can_view IS FALSE THEN FALSE
        ELSE NULL
      END,
      can_create = CASE
        WHEN erp.user_permissions_override.can_create IS TRUE OR EXCLUDED.can_create IS TRUE THEN TRUE
        WHEN erp.user_permissions_override.can_create IS FALSE OR EXCLUDED.can_create IS FALSE THEN FALSE
        ELSE NULL
      END,
      can_edit = CASE
        WHEN erp.user_permissions_override.can_edit IS TRUE OR EXCLUDED.can_edit IS TRUE THEN TRUE
        WHEN erp.user_permissions_override.can_edit IS FALSE OR EXCLUDED.can_edit IS FALSE THEN FALSE
        ELSE NULL
      END,
      can_delete = CASE
        WHEN erp.user_permissions_override.can_delete IS TRUE OR EXCLUDED.can_delete IS TRUE THEN TRUE
        WHEN erp.user_permissions_override.can_delete IS FALSE OR EXCLUDED.can_delete IS FALSE THEN FALSE
        ELSE NULL
      END,
      can_print = CASE
        WHEN erp.user_permissions_override.can_print IS TRUE OR EXCLUDED.can_print IS TRUE THEN TRUE
        WHEN erp.user_permissions_override.can_print IS FALSE OR EXCLUDED.can_print IS FALSE THEN FALSE
        ELSE NULL
      END,
      can_approve = CASE
        WHEN erp.user_permissions_override.can_approve IS TRUE OR EXCLUDED.can_approve IS TRUE THEN TRUE
        WHEN erp.user_permissions_override.can_approve IS FALSE OR EXCLUDED.can_approve IS FALSE THEN FALSE
        ELSE NULL
      END;
  `);
};

exports.down = async () => {
  // No-op: migration only normalizes legacy permission keys into current keys.
};
