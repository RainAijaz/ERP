// Integration tests for the mandatory decision note on a closed approval request.
//
// Two claims hold this feature together, and they pull in opposite directions:
//
//   1. A human closing a request MUST record why. The reject and withdraw
//      routes refuse a blank note, and approval_request_decision_notes_check
//      backs that up at the DB level so no future code path can skip it.
//   2. The automated closers must keep working. Deleting a voucher on its own
//      screen auto-closes its lingering PENDING approval with nobody at the
//      keyboard -- if that path ever writes a NULL note again it will start
//      throwing a constraint violation in production, on eight voucher-delete
//      paths at once. That is the regression this file exists to catch.
//
// APPROVED is deliberately exempt from the constraint: approvers clear queues in
// bulk and a forced note there would only produce noise.
//
// Everything is created and rolled back inside a transaction, so this leaves no
// rows behind.
//
//   node src/scripts/test-approval-reject-reason.js

const assert = require("assert");

const knex = require("../db/knex");
const {
  resolvePendingVoucherApprovalsTx,
} = require("../utils/voucher-approval-sync");
const {
  MAX_DECISION_NOTE_LENGTH,
  SYSTEM_DECISION_NOTES,
  normalizeDecisionNote,
  resolveDecisionNoteText,
  systemNoteForVoucherResolution,
} = require("../utils/approval-decision-notes");
const { resolveTranslation } = require("../middleware/core/locale");

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
  const users = await knex("erp.users").select("id").orderBy("id").limit(2);
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
      summary: "reject-reason probe",
      status: "PENDING",
      requested_by: requestedBy,
      new_value: JSON.stringify({ action: "create" }),
    })
    .returning(["id"]);
  return { approvalId: row?.id || row, voucherId };
};

const isDecisionNoteViolation = (error) =>
  /approval_request_decision_notes_check/.test(String(error?.message || ""));

const run = async () => {
  const ids = await getFixtureIds();
  if (!ids) {
    console.log("SKIP: need at least one branch and two users in the database.");
    return true;
  }
  const { branchId, makerId, otherId } = ids;

  console.log("approval decision notes");

  await check("REJECTED without a note is refused by the DB", async () => {
    await inRollback(async (trx) => {
      const { approvalId } = await insertPendingVoucherApproval(trx, {
        branchId,
        requestedBy: makerId,
      });
      await assert.rejects(
        () =>
          trx("erp.approval_request").where({ id: approvalId }).update({
            status: "REJECTED",
            decided_by: otherId,
            decided_at: trx.fn.now(),
            decision_notes: null,
          }),
        isDecisionNoteViolation,
        "a note-less rejection must violate approval_request_decision_notes_check",
      );
    });
  });

  await check("REJECTED with a whitespace-only note is refused", async () => {
    await inRollback(async (trx) => {
      const { approvalId } = await insertPendingVoucherApproval(trx, {
        branchId,
        requestedBy: makerId,
      });
      await assert.rejects(
        () =>
          trx("erp.approval_request").where({ id: approvalId }).update({
            status: "REJECTED",
            decided_by: otherId,
            decided_at: trx.fn.now(),
            decision_notes: "   \n  ",
          }),
        isDecisionNoteViolation,
        "btrim() must treat a whitespace-only note as empty",
      );
    });
  });

  await check("REJECTED with a real reason is accepted and stored", async () => {
    await inRollback(async (trx) => {
      const { approvalId } = await insertPendingVoucherApproval(trx, {
        branchId,
        requestedBy: makerId,
      });
      const reason = "Rate does not match the approved price list.";
      await trx("erp.approval_request").where({ id: approvalId }).update({
        status: "REJECTED",
        decided_by: otherId,
        decided_at: trx.fn.now(),
        decision_notes: reason,
      });
      const row = await trx("erp.approval_request")
        .where({ id: approvalId })
        .first();
      assert.strictEqual(row.status, "REJECTED");
      assert.strictEqual(row.decision_notes, reason);
    });
  });

  await check("WITHDRAWN without a note is refused by the DB", async () => {
    await inRollback(async (trx) => {
      const { approvalId } = await insertPendingVoucherApproval(trx, {
        branchId,
        requestedBy: makerId,
      });
      await assert.rejects(
        () =>
          trx("erp.approval_request").where({ id: approvalId }).update({
            status: "WITHDRAWN",
            decided_by: makerId,
            decided_at: trx.fn.now(),
            decision_notes: null,
          }),
        isDecisionNoteViolation,
        "withdrawing must record a reason too",
      );
    });
  });

  await check("APPROVED without a note is still allowed", async () => {
    await inRollback(async (trx) => {
      const { approvalId } = await insertPendingVoucherApproval(trx, {
        branchId,
        requestedBy: makerId,
      });
      await trx("erp.approval_request").where({ id: approvalId }).update({
        status: "APPROVED",
        decided_by: otherId,
        decided_at: trx.fn.now(),
        decision_notes: null,
      });
      const row = await trx("erp.approval_request")
        .where({ id: approvalId })
        .first();
      assert.strictEqual(row.status, "APPROVED");
      assert.strictEqual(row.decision_notes, null);
    });
  });

  // The regression guard. If someone "cleans up" the sentinel back to NULL,
  // every voucher delete that carries a pending approval starts failing.
  await check(
    "deleting a voucher still auto-closes its approval as REJECTED",
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
          status: "REJECTED",
        });
        assert.strictEqual(resolved, 1, "the pending row must be closed");

        const row = await trx("erp.approval_request")
          .where({ id: approvalId })
          .first();
        assert.strictEqual(row.status, "REJECTED");
        assert.strictEqual(
          row.decision_notes,
          SYSTEM_DECISION_NOTES.VOUCHER_DELETED,
          "the auto-closer must record a sentinel, never NULL",
        );
      });
    },
  );

  await check(
    "a requester resolving their own voucher closes as WITHDRAWN with a sentinel",
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
        assert.strictEqual(resolved, 1);

        const row = await trx("erp.approval_request")
          .where({ id: approvalId })
          .first();
        assert.strictEqual(row.status, "WITHDRAWN");
        assert.strictEqual(
          row.decision_notes,
          SYSTEM_DECISION_NOTES.SELF_RESOLVED,
        );
      });
    },
  );

  await check("sentinels render translated, human text passes through", () => {
    const en = (k) => resolveTranslation("en", k);
    const ur = (k) => resolveTranslation("ur", k);

    assert.strictEqual(
      resolveDecisionNoteText(SYSTEM_DECISION_NOTES.VOUCHER_DELETED, en),
      "Closed automatically: the voucher was deleted.",
    );
    // The whole point of storing a token rather than prose: an Urdu requester
    // reads this in Urdu.
    const urText = resolveDecisionNoteText(
      SYSTEM_DECISION_NOTES.VOUCHER_DELETED,
      ur,
    );
    assert.notStrictEqual(urText, SYSTEM_DECISION_NOTES.VOUCHER_DELETED);
    assert.notStrictEqual(urText, "Closed automatically: the voucher was deleted.");

    assert.strictEqual(resolveDecisionNoteText("  Wrong rate  ", en), "Wrong rate");
    assert.strictEqual(resolveDecisionNoteText("", en), "");
    assert.strictEqual(resolveDecisionNoteText(null, en), "");
  });

  await check("note normalization trims, caps, and rejects blanks", () => {
    assert.strictEqual(normalizeDecisionNote("  spaced  "), "spaced");
    assert.strictEqual(normalizeDecisionNote("   \n\t "), "");
    assert.strictEqual(normalizeDecisionNote(null), "");
    assert.strictEqual(normalizeDecisionNote(undefined), "");
    assert.strictEqual(
      normalizeDecisionNote("x".repeat(MAX_DECISION_NOTE_LENGTH + 400)).length,
      MAX_DECISION_NOTE_LENGTH,
    );
    assert.strictEqual(
      systemNoteForVoucherResolution("REJECTED"),
      SYSTEM_DECISION_NOTES.VOUCHER_DELETED,
    );
    assert.strictEqual(
      systemNoteForVoucherResolution("APPROVED"),
      SYSTEM_DECISION_NOTES.VOUCHER_CONFIRMED,
    );
  });

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
