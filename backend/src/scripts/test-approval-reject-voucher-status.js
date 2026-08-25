// Integration tests for what a closed approval request does to its voucher.
//
// The claim under test: a voucher header still sitting on PENDING when its
// last approval request is closed must not stay PENDING. It never posted --
// only the approve path writes stock and GL, and it flips the status as it
// does -- and no request is left that could ever approve it, so leaving it
// PENDING shows a rejected voucher as "Pending" on the voucher screen forever.
//
// The regression this pins: unwindPendingApprovalRequestTx used to gate that
// flip on new_value.action === "create". createApprovalRequest keeps one
// PENDING request per voucher and rewrites it in place, so re-saving a queued
// Physical Count Correction relabelled its original create request as
// "update" -- and rejecting it then closed the request but left the stock
// count reading "Pending". Six such headers were stranded locally.
//
// Everything is created and rolled back inside a transaction, so this leaves
// no rows behind.
//
//   node src/scripts/test-approval-reject-voucher-status.js

// Must precede every require: pulling in the approvals router loads the
// notification utils, and this machine's .env points at the LIVE sales group.
process.env.WHATSAPP_CLIENT_DISABLED = "1";

const assert = require("assert");

const knex = require("../db/knex");
const {
  unwindPendingApprovalRequestTx,
} = require("../routes/administration/approvals");

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

// A voucher + its queued request, in whatever combination a case needs.
const seedVoucherWithRequest = async (
  trx,
  { branchId, makerId, headerStatus, action },
) => {
  const nextNo = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: "STOCK_COUNT_ADJ" })
    .max({ value: "voucher_no" })
    .first();

  // voucher_header_check: a decided header must carry its decider, and a
  // PENDING one must not.
  const decided = headerStatus !== "PENDING";
  const [header] = await trx("erp.voucher_header")
    .insert({
      voucher_type_code: "STOCK_COUNT_ADJ",
      voucher_no: Number(nextNo?.value || 0) + 1,
      branch_id: branchId,
      voucher_date: new Date().toISOString().slice(0, 10),
      status: headerStatus,
      created_by: makerId,
      approved_by: decided ? makerId : null,
      approved_at: decided ? trx.fn.now() : null,
      remarks: "reject-status probe",
    })
    .returning(["id", "voucher_no"]);

  const voucherId = Number(header.id);
  const [request] = await trx("erp.approval_request")
    .insert({
      branch_id: branchId,
      request_type: "VOUCHER",
      entity_type: "VOUCHER",
      entity_id: String(voucherId),
      summary: `reject-status probe #${header.voucher_no}`,
      status: "PENDING",
      requested_by: makerId,
      new_value: JSON.stringify({ action, voucher_id: voucherId }),
    })
    .returning(["id"]);

  const full = await trx("erp.approval_request")
    .where({ id: request.id })
    .first();
  return { voucherId, request: full };
};

const headerStatusOf = async (trx, voucherId) => {
  const row = await trx("erp.voucher_header")
    .select("status")
    .where({ id: voucherId })
    .first();
  return String(row?.status || "");
};

const run = async () => {
  const ids = await getFixtureIds();
  if (!ids) {
    console.log("SKIP: need at least one branch and two users in the database.");
    return true;
  }
  const { branchId, makerId, otherId } = ids;

  console.log("closing an approval request vs the voucher header status");

  await check(
    'rejecting a "create" request closes the pending voucher',
    async () => {
      await inRollback(async (trx) => {
        const { voucherId, request } = await seedVoucherWithRequest(trx, {
          branchId,
          makerId,
          headerStatus: "PENDING",
          action: "create",
        });
        await unwindPendingApprovalRequestTx(trx, request, otherId);
        assert.strictEqual(await headerStatusOf(trx, voucherId), "REJECTED");
      });
    },
  );

  // The regression itself: a re-saved pending stock count carries action
  // "update" on the very request that is holding its creation open.
  await check(
    'rejecting an "update" request closes a still-PENDING voucher',
    async () => {
      await inRollback(async (trx) => {
        const { voucherId, request } = await seedVoucherWithRequest(trx, {
          branchId,
          makerId,
          headerStatus: "PENDING",
          action: "update",
        });
        await unwindPendingApprovalRequestTx(trx, request, otherId);
        assert.strictEqual(
          await headerStatusOf(trx, voucherId),
          "REJECTED",
          "a rejected stock count must not still read PENDING",
        );
      });
    },
  );

  await check(
    'rejecting an "update" request leaves an APPROVED voucher posted',
    async () => {
      await inRollback(async (trx) => {
        const { voucherId, request } = await seedVoucherWithRequest(trx, {
          branchId,
          makerId,
          headerStatus: "APPROVED",
          action: "update",
        });
        await unwindPendingApprovalRequestTx(trx, request, otherId);
        assert.strictEqual(
          await headerStatusOf(trx, voucherId),
          "APPROVED",
          "rejecting a queued edit must never unpost the voucher",
        );
      });
    },
  );

  await check(
    'rejecting a "delete" request never deletes the voucher',
    async () => {
      await inRollback(async (trx) => {
        const { voucherId, request } = await seedVoucherWithRequest(trx, {
          branchId,
          makerId,
          headerStatus: "PENDING",
          action: "delete",
        });
        await unwindPendingApprovalRequestTx(trx, request, otherId);
        assert.strictEqual(
          await headerStatusOf(trx, voucherId),
          "PENDING",
          "a rejected deletion must not be what deletes the voucher",
        );
      });
    },
  );

  await check(
    "a voucher with another live request is left for that request to decide",
    async () => {
      await inRollback(async (trx) => {
        const { voucherId, request } = await seedVoucherWithRequest(trx, {
          branchId,
          makerId,
          headerStatus: "PENDING",
          action: "update",
        });
        await trx("erp.approval_request").insert({
          branch_id: branchId,
          request_type: "VOUCHER",
          entity_type: "VOUCHER",
          entity_id: String(voucherId),
          summary: "second live request",
          status: "PENDING",
          requested_by: makerId,
          new_value: JSON.stringify({ action: "create" }),
        });
        await unwindPendingApprovalRequestTx(trx, request, otherId);
        assert.strictEqual(
          await headerStatusOf(trx, voucherId),
          "PENDING",
          "voiding the header would strand the other pending request",
        );
      });
    },
  );

  // Returnable create-on-approve requests all share entity_id 'NEW' -- no
  // voucher exists yet. Number('NEW') is NaN, so the whole block is skipped;
  // if it ever were not, the "other pending request" lookup would match all of
  // them at once. Nothing to assert on a header, so assert it stays a no-op.
  await check("an entity_id of 'NEW' is left alone", async () => {
    await inRollback(async (trx) => {
      const [row] = await trx("erp.approval_request")
        .insert({
          branch_id: branchId,
          request_type: "VOUCHER",
          entity_type: "VOUCHER",
          entity_id: "NEW",
          summary: "reject-status probe NEW",
          status: "PENDING",
          requested_by: makerId,
          new_value: JSON.stringify({ action: "create" }),
        })
        .returning(["id"]);
      const request = await trx("erp.approval_request")
        .where({ id: row.id })
        .first();

      const before = await trx("erp.voucher_header")
        .where({ status: "PENDING" })
        .count({ n: "*" })
        .first();
      await unwindPendingApprovalRequestTx(trx, request, otherId);
      const after = await trx("erp.voucher_header")
        .where({ status: "PENDING" })
        .count({ n: "*" })
        .first();

      assert.strictEqual(
        Number(after.n),
        Number(before.n),
        "a 'NEW' request must not touch any voucher header",
      );
    });
  });

  await check("withdrawal closes the voucher the same way a rejection does", async () => {
    await inRollback(async (trx) => {
      const { voucherId, request } = await seedVoucherWithRequest(trx, {
        branchId,
        makerId,
        headerStatus: "PENDING",
        action: "update",
      });
      // The withdraw route passes the requester as the closer.
      await unwindPendingApprovalRequestTx(trx, request, makerId);
      assert.strictEqual(await headerStatusOf(trx, voucherId), "REJECTED");
      const row = await trx("erp.voucher_header")
        .select("approved_by")
        .where({ id: voucherId })
        .first();
      assert.strictEqual(Number(row.approved_by), Number(makerId));
    });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? ` -- ${failed.length} FAILED` : ""),
  );
  return failed.length === 0;
};

run()
  .then(async (ok) => {
    await knex.destroy();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("test-approval-reject-voucher-status failed:", err);
    await knex.destroy();
    process.exit(1);
  });
