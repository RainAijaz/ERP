const knex = require("../db/knex");
const { handleScreenApproval } = require("../middleware/approvals/screen-approval");
const { applyMasterDataChange } = require("../utils/approval-applier");

const ensureEntityType = async (code, name, description) => {
  await knex("erp.entity_type_registry").insert({ code, name, description }).onConflict("code").ignore();
};

const getAnyUser = async () => {
  const user = await knex("erp.users").select("id", "username").first();
  if (!user) throw new Error("No users found in erp.users");
  return user;
};

const cleanup = async ({ policyKeys = [], approvalIds = [] }) => {
  if (policyKeys.length) {
    await knex("erp.approval_policy").where({ entity_type: "SCREEN" }).whereIn("entity_key", policyKeys).del();
  }
  if (approvalIds.length) {
    await knex("erp.approval_request").whereIn("id", approvalIds).del();
  }
  await knex("erp.uom").where({ code: "TESTUOM" }).del();
};

async function run() {
  const approvalIds = [];
  const testScopeKey = "test.basic_info.units";
  const policyKeys = [testScopeKey];

  try {
    console.log("🧪 Testing approval + permission flow (SCREEN)...");

    await ensureEntityType("UOM", "Unit of Measure", "Basic info: units");

    const user = await getAnyUser();
    const baseReq = {
      branchId: 1,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: false,
        permissions: {
          "SCREEN:test.basic_info.units": {
            can_create: true,
            can_edit: true,
            can_delete: true,
            can_navigate: true,
          },
        },
      },
    };

    // Case 1: No approval policy required, permission granted -> should not queue
    await knex("erp.approval_policy").where({ entity_type: "SCREEN", entity_key: testScopeKey, action: "create" }).del();

    const result1 = await handleScreenApproval({
      req: baseReq,
      scopeKey: testScopeKey,
      action: "create",
      entityType: "UOM",
      entityId: "NEW",
      summary: "Create UOM",
      oldValue: null,
      newValue: { code: "TESTUOM", name: "Test UOM", name_ur: "ٹیسٹ" },
      t: (k) => k,
    });

    if (result1.queued) throw new Error("Expected non-queued approval for allowed action");
    console.log("✅ Case 1 passed (no approval required)");

    // Case 2: Approval required, user lacks permission -> should queue
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
          "SCREEN:test.basic_info.units": {
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
      summary: "Create UOM",
      oldValue: null,
      newValue: { code: "TESTUOM", name: "Test UOM", name_ur: "ٹیسٹ" },
      t: (k) => k,
    });

    if (!result2.queued) throw new Error("Expected queued approval when approval is required");
    if (!result2.requestId) throw new Error("Expected approval_request_id to be returned");
    approvalIds.push(result2.requestId);
    console.log("✅ Case 2 passed (approval queued)");

    // Case 3: Apply master data change
    const trx = await knex.transaction();
    try {
      const applied = await applyMasterDataChange(
        trx,
        {
          entity_type: "UOM",
          entity_id: "NEW",
          new_value: { code: "TESTUOM", name: "Test UOM", name_ur: "ٹیسٹ" },
        },
        baseReq.user.id,
      );
      if (!applied) throw new Error("applyMasterDataChange returned false");
      await trx.rollback();
      console.log("✅ Case 3 passed (apply master data change)");
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    console.log("🎉 All approval tests passed");
  } catch (err) {
    console.error("❌ Approval test failed:", err.message);
  } finally {
    await cleanup({ policyKeys, approvalIds });
    await knex.destroy();
  }
}

run();
