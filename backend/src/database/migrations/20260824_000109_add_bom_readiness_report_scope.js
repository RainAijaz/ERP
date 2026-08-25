const REPORT_SCOPE_TYPE = "REPORT";
const NEW_SCOPE_KEY = "master_data.bom.reports.readiness";
// Readiness is the report Lifecycle Status should have been, so it inherits that
// scope's grants. Registering the scope alone would leave the report invisible to
// every non-admin (admins bypass the check), which reads as a broken page rather
// than a missing permission.
const SOURCE_SCOPE_KEY = "master_data.bom.reports.lifecycle_status";

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

const copyGrants = async (trx, table, ownerColumn, sourceScopeId, newScopeId) => {
  const sourceRows = await trx(table)
    .select([ownerColumn, ...PERMISSION_COLUMNS])
    .where({ scope_id: sourceScopeId });

  for (const row of sourceRows) {
    const exists = await trx(table)
      .select(ownerColumn)
      .where({ [ownerColumn]: row[ownerColumn], scope_id: newScopeId })
      .first();
    if (exists) continue;

    const insertRow = { [ownerColumn]: row[ownerColumn], scope_id: newScopeId };
    PERMISSION_COLUMNS.forEach((column) => {
      insertRow[column] = row[column];
    });
    await trx(table).insert(insertRow);
  }
};

exports.up = async function up(knex) {
  const trx = await knex.transaction();
  try {
    await trx("erp.permission_scope_registry")
      .insert({
        scope_type: REPORT_SCOPE_TYPE,
        scope_key: NEW_SCOPE_KEY,
        description: "BOM Readiness Report",
        module_group: "Master Data",
      })
      .onConflict(["scope_type", "scope_key"])
      .merge({
        description: "BOM Readiness Report",
        module_group: "Master Data",
      });

    const newScopeId = await getScopeId(trx, NEW_SCOPE_KEY);
    const sourceScopeId = await getScopeId(trx, SOURCE_SCOPE_KEY);
    if (newScopeId && sourceScopeId) {
      await copyGrants(
        trx,
        "erp.role_permissions",
        "role_id",
        sourceScopeId,
        newScopeId,
      );
      await copyGrants(
        trx,
        "erp.user_permissions_override",
        "user_id",
        sourceScopeId,
        newScopeId,
      );
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
    const scopeId = await getScopeId(trx, NEW_SCOPE_KEY);
    if (scopeId) {
      await trx("erp.user_permissions_override")
        .where({ scope_id: scopeId })
        .del();
      await trx("erp.role_permissions").where({ scope_id: scopeId }).del();
      await trx("erp.permission_scope_registry")
        .where({ scope_type: REPORT_SCOPE_TYPE, scope_key: NEW_SCOPE_KEY })
        .del();
    }
    await trx.commit();
  } catch (err) {
    await trx.rollback();
    throw err;
  }
};
