const knex = require("../db/knex");
const { handleScreenApproval } = require("../middleware/approvals/screen-approval");
const { buildAuditContext } = require("../utils/activity-log-context");
const { insertActivityLog } = require("../utils/audit-log");
const { parseEditedPayload, sanitizeEditedValues } = require("../utils/approval-request-edit");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getAnyUserAndBranch = async () => {
  const user = await knex("erp.users").select("id").first();
  const branch = await knex("erp.branches").select("id").first();
  if (!user || !branch) throw new Error("Missing users/branches seed data.");
  return { userId: user.id, branchId: branch.id };
};

async function run() {
  const testScope = "test.audit.approval.enhancements";
  const cleanup = {
    approvalIds: [],
    activityIds: [],
  };

  try {
    console.log("[test-approval-audit-enhancements] start");

    const parsedInvalid = parseEditedPayload("bad-json");
    assert(Object.keys(parsedInvalid).length === 0, "parseEditedPayload should handle invalid JSON.");

    const parsedValid = parseEditedPayload('{"sale_rate":100}');
    assert(parsedValid.sale_rate === 100, "parseEditedPayload should parse valid JSON.");

    const editDelete = sanitizeEditedValues(
      { entity_id: "10", new_value: { _action: "toggle", is_active: false } },
      { is_active: true },
    );
    assert(editDelete.error === "approval_edit_delete_not_allowed", "Delete requests must not be editable.");

    const editUpdate = sanitizeEditedValues(
      { entity_id: "10", new_value: { _action: "update", sale_rate: 120, remarks: "old" } },
      { sale_rate: 130, remarks: "new" },
    );
    assert(!editUpdate.error && editUpdate.changedFields.length === 2, "Update edit should capture changed fields.");

    const auditContext = buildAuditContext(
      {
        method: "POST",
        originalUrl: "/x",
        query: { status: "PENDING" },
        body: { _csrf: "x", password: "y", sale_rate: 110 },
        res: { statusCode: 200 },
      },
      { source: "test", old_value: { a: 1 }, new_value: { a: 2 } },
    );
    assert(!auditContext.request_body.password, "Audit context must mask sensitive keys.");
    assert(!auditContext.request_body._csrf, "Audit context must mask csrf token.");

    const { userId, branchId } = await getAnyUserAndBranch();

    await insertActivityLog(knex, {
      branch_id: branchId,
      user_id: userId,
      entity_type: "UOM",
      entity_id: "NEW",
      action: "SUBMIT",
      context: { source: "test-script", smoke: true },
    });
    const inserted = await knex("erp.activity_log")
      .select("id", "context_json")
      .where({ user_id: userId, entity_type: "UOM", entity_id: "NEW", action: "SUBMIT" })
      .orderBy("id", "desc")
      .first();
    assert(inserted && inserted.context_json && inserted.context_json.smoke === true, "insertActivityLog should persist context_json.");
    cleanup.activityIds.push(inserted.id);

    await knex("erp.approval_policy").where({ entity_type: "SCREEN", entity_key: testScope }).del();

    const noPermReq = {
      branchId,
      ip: "127.0.0.1",
      user: {
        id: userId,
        isAdmin: false,
        permissions: {
          [`SCREEN:${testScope}`]: {
            can_create: false,
            can_edit: false,
            can_delete: false,
            can_navigate: true,
          },
        },
      },
    };

    const rerouted = await handleScreenApproval({
      req: noPermReq,
      scopeKey: testScope,
      action: "create",
      entityType: "UOM",
      entityId: "NEW",
      summary: "Script reroute test",
      oldValue: null,
      newValue: { name: "S1" },
      t: (key) => key,
    });
    assert(rerouted.queued === true, "No-permission action should route to approval queue.");
    cleanup.approvalIds.push(rerouted.requestId);

    await knex("erp.approval_policy")
      .insert({ entity_type: "SCREEN", entity_key: testScope, action: "create", requires_approval: true })
      .onConflict(["entity_type", "entity_key", "action"])
      .merge({ requires_approval: true });

    const allowedReq = {
      ...noPermReq,
      user: {
        ...noPermReq.user,
        permissions: {
          [`SCREEN:${testScope}`]: {
            can_create: true,
            can_edit: true,
            can_delete: true,
            can_navigate: true,
          },
        },
      },
    };

    const policyQueue = await handleScreenApproval({
      req: allowedReq,
      scopeKey: testScope,
      action: "create",
      entityType: "UOM",
      entityId: "NEW",
      summary: "Script policy test",
      oldValue: null,
      newValue: { name: "S2" },
      t: (key) => key,
    });
    assert(policyQueue.queued === true, "Policy-required action should queue for approval.");
    cleanup.approvalIds.push(policyQueue.requestId);

    console.log("[test-approval-audit-enhancements] all checks passed");
  } catch (err) {
    console.error("[test-approval-audit-enhancements] failed:", err.message);
  } finally {
    if (cleanup.approvalIds.length) {
      await knex("erp.approval_request").whereIn("id", cleanup.approvalIds.filter(Boolean)).del();
    }
    if (cleanup.activityIds.length) {
      await knex("erp.activity_log").whereIn("id", cleanup.activityIds.filter(Boolean)).del();
    }
    await knex("erp.approval_policy").where({ entity_type: "SCREEN", entity_key: testScope }).del();
    await knex.destroy();
  }
}

run();
