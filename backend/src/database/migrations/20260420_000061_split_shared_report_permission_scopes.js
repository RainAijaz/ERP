const REPORT_SCOPE_TYPE = "REPORT";

const SPLIT_SCOPE_MAPPINGS = [
  {
    oldScopeKey: "purchase_report",
    newScopeKey: "supplier_listings_report",
    description: "supplier_listings",
    moduleGroup: "Purchase",
  },
  {
    oldScopeKey: "production_report",
    newScopeKey: "planned_consumption_report",
    description: "planned_consumption",
    moduleGroup: "Production",
  },
  {
    oldScopeKey: "production_report",
    newScopeKey: "department_wip_report",
    description: "department_wip_report",
    moduleGroup: "Production",
  },
  {
    oldScopeKey: "production_report",
    newScopeKey: "department_wip_balances_report",
    description: "department_wip_balances_report",
    moduleGroup: "Production",
  },
  {
    oldScopeKey: "production_report",
    newScopeKey: "department_wip_ledger_report",
    description: "department_wip_ledger_report",
    moduleGroup: "Production",
  },
  {
    oldScopeKey: "stock_item_activity",
    newScopeKey: "stock_transfer_report",
    description: "stock_transfer_report",
    moduleGroup: "Inventory",
  },
  {
    oldScopeKey: "pending_returnables",
    newScopeKey: "overdue_returnables_report",
    description: "overdue_returnables",
    moduleGroup: "Outward & Returnable",
  },
  {
    oldScopeKey: "sales_report",
    newScopeKey: "customer_balances_report",
    description: "customer_balances_report",
    moduleGroup: "Sales",
  },
  {
    oldScopeKey: "sales_report",
    newScopeKey: "customer_ledger_report",
    description: "customer_ledger_report",
    moduleGroup: "Sales",
  },
  {
    oldScopeKey: "sales_report",
    newScopeKey: "customer_listings",
    description: "customer_listings",
    moduleGroup: "Sales",
  },
  {
    oldScopeKey: "sales_report",
    newScopeKey: "customer_contact_analysis",
    description: "customer_contact_analysis",
    moduleGroup: "Sales",
  },
  {
    oldScopeKey: "sales_report",
    newScopeKey: "sales_order_report",
    description: "sales_order_report",
    moduleGroup: "Sales",
  },
  {
    oldScopeKey: "sales_report",
    newScopeKey: "sale_return_report",
    description: "sale_return_report",
    moduleGroup: "Sales",
  },
  {
    oldScopeKey: "sales_report",
    newScopeKey: "sales_discount_report",
    description: "sales_discount_report",
    moduleGroup: "Sales",
  },
];

const PERMISSION_COLUMNS = [
  "can_navigate",
  "can_view",
  "can_load",
  "can_view_details",
  "can_create",
  "can_edit",
  "can_delete",
  "can_hard_delete",
  "can_print",
  "can_export_excel_csv",
  "can_filter_all_branches",
  "can_view_cost_fields",
  "can_approve",
];

const getScopeId = async (trx, scopeKey) => {
  const row = await trx("erp.permission_scope_registry")
    .select("id")
    .where({ scope_type: REPORT_SCOPE_TYPE, scope_key: scopeKey })
    .first();
  return Number(row?.id || 0) || null;
};

const copyRolePermissions = async (trx, oldScopeId, newScopeId) => {
  const sourceRows = await trx("erp.role_permissions")
    .select(["role_id", ...PERMISSION_COLUMNS])
    .where({ scope_id: oldScopeId });

  for (const row of sourceRows) {
    const exists = await trx("erp.role_permissions")
      .select("role_id")
      .where({ role_id: row.role_id, scope_id: newScopeId })
      .first();
    if (exists) continue;

    const insertRow = {
      role_id: row.role_id,
      scope_id: newScopeId,
    };
    PERMISSION_COLUMNS.forEach((column) => {
      insertRow[column] = row[column];
    });
    await trx("erp.role_permissions").insert(insertRow);
  }
};

const copyUserOverrides = async (trx, oldScopeId, newScopeId) => {
  const sourceRows = await trx("erp.user_permissions_override")
    .select(["user_id", ...PERMISSION_COLUMNS])
    .where({ scope_id: oldScopeId });

  for (const row of sourceRows) {
    const exists = await trx("erp.user_permissions_override")
      .select("user_id")
      .where({ user_id: row.user_id, scope_id: newScopeId })
      .first();
    if (exists) continue;

    const insertRow = {
      user_id: row.user_id,
      scope_id: newScopeId,
    };
    PERMISSION_COLUMNS.forEach((column) => {
      insertRow[column] = row[column];
    });
    await trx("erp.user_permissions_override").insert(insertRow);
  }
};

exports.up = async function up(knex) {
  const trx = await knex.transaction();
  try {
    for (const mapping of SPLIT_SCOPE_MAPPINGS) {
      await trx("erp.permission_scope_registry")
        .insert({
          scope_type: REPORT_SCOPE_TYPE,
          scope_key: mapping.newScopeKey,
          description: mapping.description,
          module_group: mapping.moduleGroup,
        })
        .onConflict(["scope_type", "scope_key"])
        .merge({
          description: mapping.description,
          module_group: mapping.moduleGroup,
        });

      const oldScopeId = await getScopeId(trx, mapping.oldScopeKey);
      const newScopeId = await getScopeId(trx, mapping.newScopeKey);
      if (!oldScopeId || !newScopeId) continue;

      await copyRolePermissions(trx, oldScopeId, newScopeId);
      await copyUserOverrides(trx, oldScopeId, newScopeId);
    }

    await trx.commit();
  } catch (err) {
    await trx.rollback();
    throw err;
  }
};

exports.down = async function down(knex) {
  const trx = await knex.transaction();
  try {
    const newScopeKeys = SPLIT_SCOPE_MAPPINGS.map((mapping) => mapping.newScopeKey);
    const scopeRows = await trx("erp.permission_scope_registry")
      .select("id")
      .where({ scope_type: REPORT_SCOPE_TYPE })
      .whereIn("scope_key", newScopeKeys);
    const scopeIds = scopeRows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (scopeIds.length) {
      await trx("erp.user_permissions_override").whereIn("scope_id", scopeIds).del();
      await trx("erp.role_permissions").whereIn("scope_id", scopeIds).del();
      await trx("erp.permission_scope_registry")
        .where({ scope_type: REPORT_SCOPE_TYPE })
        .whereIn("scope_key", newScopeKeys)
        .del();
    }

    await trx.commit();
  } catch (err) {
    await trx.rollback();
    throw err;
  }
};
