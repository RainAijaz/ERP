// Integration tests for the WITHDRAWN approval status.
//
// Two claims hold the design together, and both are easy to break later:
//
//   1. The maker-checker rule still stands. A checker may never decide their
//      own request -- WITHDRAWN is the single exception, because it is by
//      definition the maker closing their own request rather than deciding it.
//   2. Confirming a voucher never strands its approval. Before WITHDRAWN
//      existed, resolvePendingVoucherApprovalsTx had to skip rows whose
//      requester was the confirmer (the DB forbade recording them as decider),
//      which left those rows PENDING on the approvals page forever.
//
// Everything is created and rolled back inside a transaction, so this leaves
// no rows behind.
//
//   node src/scripts/test-approval-withdraw-sync.js

const assert = require("assert");

const knex = require("../db/knex");
const {
  findPendingVoucherApprovalTx,
  resolvePendingVoucherApprovalsTx,
} = require("../utils/voucher-approval-sync");

const results = [];

const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
};

// Each case runs in its own transaction and always rolls back, so a failing
// assertion cannot leak fixture rows into the database.
const inRollback = async (fn) => {
  let caught = null;
  try {
    await knex.transaction(async (trx) => {
      try {
        await fn(trx);
      } catch (error) {
        caught = error;
      }
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!/__rollback__/.test(String(error?.message || ""))) throw error;
  }
  if (caught) throw caught;
};

const getFixtureIds = async () => {
  const branch = await knex("erp.branches").select("id").orderBy("id").first();
  const users = await knex("erp.users")
    .select("id")
    .orderBy("id")
    .limit(2);
  if (!branch || users.length < 2) return null;
  return { branchId: branch.id, makerId: users[0].id, otherId: users[1].id };
};

const insertPendingVoucherApproval = async (trx, { branchId, requestedBy }) => {
  // entity_id must look like a voucher id for the sync helpers to match it.
  const voucherId = 900000000 + Math.floor(Math.random() * 1000000);
  const [row] = await trx("erp.approval_request")
    .insert({
      branch_id: branchId,
      request_type: "VOUCHER",
      entity_type: "VOUCHER",
      entity_id: String(voucherId),
      summary: "withdraw-sync probe",
      status: "PENDING",
      requested_by: requestedBy,
      new_value: JSON.stringify({ action: "create" }),
    })
    .returning(["id"]);
  return { approvalId: row?.id || row, voucherId };
};

const run = async () => {
  const ids = await getFixtureIds();
  if (!ids) {
    console.log("SKIP: need at least one branch and two users in the database.");
    return true;
  }
  const { branchId, makerId, otherId } = ids;

  console.log("approval withdraw + voucher sync");

  await check("WITHDRAWN may be set by the requester themselves", async () => {
    await inRollback(async (trx) => {
      const { approvalId } = await insertPendingVoucherApproval(trx, {
        branchId,
        requestedBy: makerId,
      });
      await trx("erp.approval_request").where({ id: approvalId }).update({
        status: "WITHDRAWN",
        decided_by: makerId,
        decided_at: trx.fn.now(),
      });
      const row = await trx("erp.approval_request")
        .where({ id: approvalId })
        .first();
      assert.strictEqual(row.status, "WITHDRAWN");
      assert.strictEqual(Number(row.decided_by), Number(makerId));
      assert.ok(row.decided_at, "decided_at must be stamped");
    });
  });

  await check("APPROVED still may not be set by the requester", async () => {
    await inRollback(async (trx) => {
      const { approvalId } = await insertPendingVoucherApproval(trx, {
        branchId,
        requestedBy: makerId,
      });
      await assert.rejects(
        trx("erp.approval_request").where({ id: approvalId }).update({
          status: "APPROVED",
          decided_by: makerId,
          decided_at: trx.fn.now(),
        }),
        /approval_request_maker_checker_check/,
        "maker-checker rule must still block self-approval",
      );
    });
  });

  await check(
    "confirming someone else's voucher approves their pending request",
    async () => {
      await inRollback(async (trx) => {
        const { approvalId, voucherId } = await insertPendingVoucherApproval(
          trx,
          { branchId, requestedBy: makerId },
        );
        const resolved = await resolvePendingVoucherApprovalsTx({
          trx,
          voucherId,
          decidedBy: otherId,
          status: "APPROVED",
        });
        assert.strictEqual(resolved, 1);
        const row = await trx("erp.approval_request")
          .where({ id: approvalId })
          .first();
        assert.strictEqual(row.status, "APPROVED");
        assert.strictEqual(Number(row.decided_by), Number(otherId));
      });
    },
  );

  await check(
    "confirming your OWN voucher withdraws the pending request instead of stranding it",
    async () => {
      await inRollback(async (trx) => {
        const { approvalId, voucherId } = await insertPendingVoucherApproval(
          trx,
          { branchId, requestedBy: makerId },
        );
        const resolved = await resolvePendingVoucherApprovalsTx({
          trx,
          voucherId,
          decidedBy: makerId,
          status: "APPROVED",
        });
        assert.strictEqual(resolved, 1, "the row must not be skipped");
        const row = await trx("erp.approval_request")
          .where({ id: approvalId })
          .first();
        assert.strictEqual(row.status, "WITHDRAWN");
        assert.strictEqual(Number(row.decided_by), Number(makerId));
        // Nothing may be left waiting on the approvals page.
        const stillPending = await findPendingVoucherApprovalTx(trx, voucherId);
        assert.strictEqual(stillPending, null);
      });
    },
  );

  await check(
    "deleting your OWN voucher also clears the pending request",
    async () => {
      await inRollback(async (trx) => {
        const { approvalId, voucherId } = await insertPendingVoucherApproval(
          trx,
          { branchId, requestedBy: makerId },
        );
        const resolved = await resolvePendingVoucherApprovalsTx({
          trx,
          voucherId,
          decidedBy: makerId,
          status: "REJECTED",
        });
        assert.strictEqual(resolved, 1);
        const row = await trx("erp.approval_request")
          .where({ id: approvalId })
          .first();
        assert.strictEqual(row.status, "WITHDRAWN");
      });
    },
  );

  await check(
    "a voucher with both own and foreign pending requests resolves both",
    async () => {
      await inRollback(async (trx) => {
        const own = await insertPendingVoucherApproval(trx, {
          branchId,
          requestedBy: makerId,
        });
        // Second request pointing at the same voucher, from another user.
        const [foreign] = await trx("erp.approval_request")
          .insert({
            branch_id: branchId,
            request_type: "VOUCHER",
            entity_type: "VOUCHER",
            entity_id: String(own.voucherId),
            summary: "withdraw-sync probe (foreign)",
            status: "PENDING",
            requested_by: otherId,
            new_value: JSON.stringify({ action: "create" }),
          })
          .returning(["id"]);

        const resolved = await resolvePendingVoucherApprovalsTx({
          trx,
          voucherId: own.voucherId,
          decidedBy: makerId,
          status: "APPROVED",
        });
        assert.strictEqual(resolved, 2, "both rows must be closed");

        const ownRow = await trx("erp.approval_request")
          .where({ id: own.approvalId })
          .first();
        const foreignRow = await trx("erp.approval_request")
          .where({ id: foreign?.id || foreign })
          .first();
        assert.strictEqual(ownRow.status, "WITHDRAWN");
        assert.strictEqual(foreignRow.status, "APPROVED");
      });
    },
  );

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0;
};

run()
  .then(async (ok) => {
    await knex.destroy();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await knex.destroy();
    process.exit(1);
  });
