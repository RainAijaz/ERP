const knex = require("../db/knex");
const { HttpError } = require("../middleware/errors/http-error");
const { handleScreenApproval } = require("../middleware/approvals/screen-approval");

const getAnyUser = async () => {
  const user = await knex("erp.users").select("id", "username").first();
  if (!user) throw new Error("No users found in erp.users");
  return user;
};

const getAnyBranchId = async () => {
  const branch = await knex("erp.branches").select("id").first();
  if (!branch) throw new Error("No branches found in erp.branches");
  return branch.id;
};

const cleanup = async ({ policyKeys = [], approvalIds = [] }) => {
  if (policyKeys.length) {
    await knex("erp.approval_policy").where({ entity_type: "SCREEN" }).whereIn("entity_key", policyKeys).del();
  }
  if (approvalIds.length) {
    await knex("erp.approval_request").whereIn("id", approvalIds).del();
  }
};

const filterApprovalScreens = (screenScopes = []) => {
  const excludedScreens = new Set(["administration.audit_logs", "administration.approvals", "administration.approval_settings", "administration.permissions", "administration.branches"]);

  return screenScopes.filter((scope) => {
    if (!scope || !scope.scope_key) return false;
    if (scope.scope_key.startsWith("administration.")) return false;
    if (excludedScreens.has(scope.scope_key)) return false;
    if (scope.scope_key.includes(".approval") || scope.scope_key.includes(".versions")) return false;
    return true;
  });
};

async function run() {
  const approvalIds = [];
  const testScopeKey = "test.approvals.screen";
  const policyKeys = [testScopeKey];

  try {
    console.log("🧪 Testing approval + permission screens...");

    const user = await getAnyUser();
    const branchId = await getAnyBranchId();

    // Screen list filtering for approval settings
    const screenScopes = await knex("erp.permission_scope_registry").select("scope_key", "description", "module_group").where({ scope_type: "SCREEN" });
    const filteredScreens = filterApprovalScreens(screenScopes);

    const invalid = filteredScreens.filter((s) => s.scope_key.startsWith("administration.") || s.scope_key.includes(".approval") || s.scope_key.includes(".versions"));
    if (invalid.length) {
      throw new Error(`Approval settings filter failed. Invalid keys present: ${invalid.map((x) => x.scope_key).join(", ")}`);
    }
    console.log(`✅ Approval settings screen filter OK (${filteredScreens.length} screens).`);

    // Approval handling cases
    const baseReq = {
      branchId,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: false,
        permissions: {
          [`SCREEN:${testScopeKey}`]: {
            can_create: true,
            can_edit: true,
            can_delete: true,
            can_navigate: true,
          },
        },
      },
    };

    await knex("erp.approval_policy").where({ entity_type: "SCREEN", entity_key: testScopeKey }).del();

    // Case 1: no approval required, allowed
    const result1 = await handleScreenApproval({
      req: baseReq,
      scopeKey: testScopeKey,
      action: "create",
      entityType: "UOM",
      entityId: "NEW",
      summary: "Create Test",
      oldValue: null,
      newValue: { name: "TEST" },
      t: (k) => k,
    });
    if (result1.queued) throw new Error("Case 1 failed: should not queue.");
    console.log("✅ Case 1 passed (no approval required).");

    // Case 2: approval required, user lacks permission -> queued
    await knex("erp.approval_policy").insert({
      entity_type: "SCREEN",
      entity_key: testScopeKey,
      action: "create",
      requires_approval: true,
    });

    const noPermReq = {
      ...baseReq,
      user: {
        ...baseReq.user,
        permissions: {
          [`SCREEN:${testScopeKey}`]: {
            can_create: false,
            can_edit: false,
            can_delete: false,
            can_navigate: true,
          },
        },
      },
    };

    const result2 = await handleScreenApproval({
      req: noPermReq,
      scopeKey: testScopeKey,
      action: "create",
      entityType: "UOM",
      entityId: "NEW",
      summary: "Create Test",
      oldValue: null,
      newValue: { name: "TEST" },
      t: (k) => k,
    });
    if (!result2.queued) throw new Error("Case 2 failed: should queue.");
    approvalIds.push(result2.requestId);
    console.log("✅ Case 2 passed (approval queued).");

    // Case 3: approval required, user has permission -> queued
    const result3 = await handleScreenApproval({
      req: baseReq,
      scopeKey: testScopeKey,
      action: "create",
      entityType: "UOM",
      entityId: "NEW",
      summary: "Create Test",
      oldValue: null,
      newValue: { name: "TEST" },
      t: (k) => k,
    });
    if (!result3.queued) throw new Error("Case 3 failed: should queue.");
    approvalIds.push(result3.requestId);
    console.log("✅ Case 3 passed (approval queued even with permission).");

    // Case 4: no approval required, no permission -> 403
    await knex("erp.approval_policy").where({ entity_type: "SCREEN", entity_key: testScopeKey, action: "create" }).del();

    let threw = false;
    try {
      await handleScreenApproval({
        req: noPermReq,
        scopeKey: testScopeKey,
        action: "create",
        entityType: "UOM",
        entityId: "NEW",
        summary: "Create Test",
        oldValue: null,
        newValue: { name: "TEST" },
        t: (k) => k,
      });
    } catch (err) {
      threw = err instanceof HttpError && err.status === 403;
    }
    if (!threw) throw new Error("Case 4 failed: expected permission denied.");
    console.log("✅ Case 4 passed (permission denied when no approval policy).");

    // Admin checks
    const adminReq = {
      branchId,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: true,
        permissions: {},
      },
    };

    await knex("erp.approval_policy").insert({
      entity_type: "SCREEN",
      entity_key: testScopeKey,
      action: "edit",
      requires_approval: true,
    });

    const adminResult = await handleScreenApproval({
      req: adminReq,
      scopeKey: testScopeKey,
      action: "edit",
      entityType: "UOM",
      entityId: "NEW",
      summary: "Admin Test",
      oldValue: null,
      newValue: { name: "TEST" },
      t: (k) => k,
    });
    if (adminResult.queued) throw new Error("Admin case failed: should bypass approval policy.");
    console.log("✅ Admin case passed (approval policy bypassed).");

    console.log("🎉 All approval/permission screen tests passed.");
  } catch (err) {
    console.error("❌ Approval/permission screen tests failed:", err.message);
  } finally {
    await cleanup({ policyKeys, approvalIds });
    await knex.destroy();
  }
}

run();
