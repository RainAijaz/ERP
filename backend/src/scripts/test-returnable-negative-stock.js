// Integration tests for dispatching raw material the branch does not have.
//
// The Returnable Dispatch picker used to list only (item, colour, size) buckets with
// ON_HAND qty > 0, which hid almost the whole raw-material master. It now lists every
// active raw material, and lending out more than is on hand is allowed -- but never
// silently: any shortfall forces the voucher through approvals with a summary that
// spells out the reason, and only an approved voucher drives stock negative.
//
// Four claims, each easy to break later:
//
//   1. The picker offers raw material with no stock at all, not just stocked buckets.
//   2. A short line queues for approval even for a user who could self-approve, and
//      the approval summary says why.
//   3. Approving posts the loan and takes ON_HAND negative, with inventory value and
//      therefore the trial balance untouched.
//   4. A line the branch can cover still saves directly, with no approval detour.
//
// These run against the configured database and clean up everything they create.
//
//   node src/scripts/test-returnable-negative-stock.js

const assert = require("assert");

const knex = require("../db/knex");
const returnableVoucherService = require("../services/returnables/returnable-voucher-service");

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

const buildReq = ({ branch, userId }) => ({
  branchId: branch.id,
  locale: "en",
  query: {},
  method: "POST",
  originalUrl: "/test/returnable-negative-stock",
  ip: "127.0.0.1",
  headers: {},
  body: {},
  user: { id: userId, isAdmin: true, username: "test-runner" },
  branchOptions: [{ id: branch.id, name: branch.name }],
  // Voucher services read permissions off res.locals.can. Everything is allowed here
  // on purpose: the negative-stock detour must hold even for a user who can approve.
  res: { locals: { can: () => true } },
});

const today = () => new Date().toISOString().slice(0, 10);
const inTwoWeeks = () =>
  new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

const readRmBucket = async ({ branchId, itemId, colorId, sizeId, stockState }) => {
  const row = await knex("erp.stock_balance_rm")
    .select("qty", "value")
    .where({ branch_id: branchId, stock_state: stockState, item_id: itemId })
    .whereRaw("COALESCE(color_id, 0) = ?", [Number(colorId || 0)])
    .whereRaw("COALESCE(size_id, 0) = ?", [Number(sizeId || 0)])
    .first();
  return { qty: Number(row?.qty || 0), value: Number(row?.value || 0) };
};

// Deleting a voucher row does not reverse the stock it posted, so the whole branch's
// RM balances are snapshotted up front and written back at the end. Restoring only the
// buckets a test names is not enough: a run that fails midway still moved stock.
// stock_balance_rm has no surrogate key, so rows are addressed by the natural one.
const rmRowKey = (row) =>
  [
    String(row.stock_state),
    Number(row.item_id),
    Number(row.color_id || 0),
    Number(row.size_id || 0),
  ].join(":");

const snapshotBranchRmStock = async (branchId) =>
  knex("erp.stock_balance_rm")
    .select("stock_state", "item_id", "color_id", "size_id", "qty", "value", "wac")
    .where({ branch_id: branchId });

const restoreBranchRmStock = async (branchId, snapshot) => {
  const whereRow = (query, row) =>
    query
      .where({
        branch_id: branchId,
        stock_state: row.stock_state,
        item_id: row.item_id,
      })
      .whereRaw("COALESCE(color_id, 0) = ?", [Number(row.color_id || 0)])
      .whereRaw("COALESCE(size_id, 0) = ?", [Number(row.size_id || 0)]);

  for (const row of snapshot) {
    await whereRow(knex("erp.stock_balance_rm"), row).update({
      qty: row.qty,
      value: row.value,
      wac: row.wac,
    });
  }

  // Buckets the run seeded into existence did not exist before and must not survive it.
  const known = new Set(snapshot.map(rmRowKey));
  const current = await snapshotBranchRmStock(branchId);
  for (const row of current) {
    if (known.has(rmRowKey(row))) continue;
    await whereRow(knex("erp.stock_balance_rm"), row).del();
  }
};

// A raw material this branch has never held: no stock_balance_rm row at all, which is
// the case the old picker could not represent.
const findUnstockedRmItem = async (branchId) =>
  knex("erp.items as i")
    .select("i.id", "i.name")
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
    .where("i.is_active", true)
    .whereNot("i.code", "RETURNABLE_ASSET_ITEM")
    .whereNotExists(function existsBucket() {
      this.select(1)
        .from("erp.stock_balance_rm as sb")
        .whereRaw("sb.item_id = i.id")
        .andWhere("sb.branch_id", branchId);
    })
    .orderBy("i.id")
    .first();

const findStockedRmBucket = async (branchId) => {
  const row = await knex("erp.stock_balance_rm as sb")
    .join("erp.items as i", "i.id", "sb.item_id")
    .select("sb.item_id", "sb.color_id", "sb.size_id", "sb.qty")
    .where({ "sb.branch_id": branchId, "sb.stock_state": "ON_HAND" })
    .where("sb.qty", ">=", 1)
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
    .orderBy("sb.qty", "desc")
    .first();
  if (!row) return null;
  return {
    itemId: Number(row.item_id),
    colorId: row.color_id === null ? null : Number(row.color_id),
    sizeId: row.size_id === null ? null : Number(row.size_id),
    qty: Number(row.qty),
  };
};

const findBranchWithRmStock = async () => {
  const row = await knex("erp.stock_balance_rm as sb")
    .join("erp.branches as b", "b.id", "sb.branch_id")
    .select("sb.branch_id", "b.name as branch_name")
    .where("sb.stock_state", "ON_HAND")
    .andWhere("sb.qty", ">", 1)
    .orderBy("sb.qty", "desc")
    .first();
  if (!row) return null;
  return { id: Number(row.branch_id), name: row.branch_name };
};

const findRecipientParty = async (branchId) =>
  knex("erp.parties as p")
    .leftJoin("erp.party_branch as pb", "pb.party_id", "p.id")
    .select("p.id", "p.name")
    .whereRaw("upper(coalesce(p.party_type::text, '')) IN ('SUPPLIER', 'OTHER')")
    .where("p.is_active", true)
    .andWhere((q) =>
      q.where("pb.branch_id", branchId).orWhereNull("pb.branch_id"),
    )
    .first();

const dispatchPayload = ({ partyId, line, remarks }) => ({
  voucher_date: today(),
  vendor_party_id: partyId,
  reason_code: "OTHERS",
  remarks,
  expected_return_date: inTwoWeeks(),
  lines: [line],
});

const deleteVoucherCompletely = async (voucherId) => {
  if (!voucherId) return;
  await knex.transaction(async (trx) => {
    await trx("erp.stock_ledger").where({ voucher_header_id: voucherId }).del();
    await trx("erp.rgp_outward_line")
      .whereIn(
        "voucher_line_id",
        trx("erp.voucher_line").select("id").where({
          voucher_header_id: voucherId,
        }),
      )
      .del();
    await trx("erp.rgp_outward").where({ voucher_id: voucherId }).del();
    await trx("erp.voucher_line")
      .where({ voucher_header_id: voucherId })
      .del();
    await trx("erp.voucher_header").where({ id: voucherId }).del();
  });
};

const run = async () => {
  const user = await knex("erp.users").select("id").orderBy("id").first();
  assert.ok(user, "No users in the database to attribute test records to.");

  const branch =
    (await findBranchWithRmStock()) ||
    (await knex("erp.branches").select("id", "name").orderBy("id").first());
  assert.ok(branch, "No branches in the database.");

  const req = buildReq({ branch, userId: user.id });
  const party = await findRecipientParty(branch.id);
  assert.ok(party, "No supplier or OTHER party available for this branch.");

  const unstocked = await findUnstockedRmItem(branch.id);
  const stocked = await findStockedRmBucket(branch.id);

  console.log(`\nBranch: ${branch.name} (id ${branch.id})`);
  console.log(`Recipient: ${party.name} (id ${party.id})`);
  console.log(
    unstocked
      ? `Unstocked raw material: ${unstocked.name} (id ${unstocked.id})`
      : "No raw material without a stock row -- shortfall tests will be skipped.",
  );
  console.log(
    stocked
      ? `Stocked bucket: item ${stocked.itemId}, on hand ${stocked.qty}\n`
      : "No raw material on hand -- the direct-save test will be skipped.\n",
  );

  const createdVoucherIds = [];
  const createdApprovalIds = [];
  const stockSnapshot = await snapshotBranchRmStock(branch.id);

  try {
    console.log("Picker");
    await check("picker lists raw material with no stock in this branch", async () => {
      if (!unstocked) return;
      const options =
        await returnableVoucherService.loadReturnableVoucherOptions(req);
      const buckets = options.rmStockBuckets || [];
      assert.ok(
        buckets.length > 0,
        "picker returned no raw material at all",
      );
      const offered = buckets.find(
        (bucket) => Number(bucket.item_id) === Number(unstocked.id),
      );
      assert.ok(
        offered,
        `expected ${unstocked.name} in the picker, got ${buckets.length} entries: ${buckets
          .map((bucket) => bucket.name)
          .join(", ")}`,
      );
      assert.strictEqual(
        Number(offered.available_qty || 0),
        0,
        "an unstocked item should be offered with zero available qty",
      );
    });

    await check("picker never offers the same bucket twice", async () => {
      const options =
        await returnableVoucherService.loadReturnableVoucherOptions(req);
      const keys = (options.rmStockBuckets || []).map((bucket) =>
        [
          Number(bucket.item_id),
          Number(bucket.color_id || 0),
          Number(bucket.size_id || 0),
        ].join(":"),
      );
      assert.strictEqual(
        keys.length,
        new Set(keys).size,
        `duplicate bucket keys in the picker: ${keys.join(", ")}`,
      );
    });

    console.log("\nApproval routing");
    let shortfallApprovalId = null;
    await check(
      "dispatching unstocked raw material queues for approval instead of failing",
      async () => {
        if (!unstocked) return;
        const created = await returnableVoucherService.createReturnableVoucher({
          req,
          voucherTypeCode: "RDV",
          scopeKey: "RDV",
          payload: dispatchPayload({
            partyId: party.id,
            remarks: "test: lend raw material the branch does not have",
            line: { entry_kind: "RM", item_id: unstocked.id, qty: 3 },
          }),
        });
        assert.strictEqual(
          created.queuedForApproval,
          true,
          "a short line must queue for approval even for an approver",
        );
        assert.strictEqual(
          created.permissionReroute,
          false,
          "this detour is about stock, not about missing permission",
        );
        shortfallApprovalId = created.approvalRequestId;
        assert.ok(shortfallApprovalId, "no approval request was created");
        createdApprovalIds.push(shortfallApprovalId);
      },
    );

    await check("approval summary explains why approval is required", async () => {
      if (!shortfallApprovalId) return;
      const row = await knex("erp.approval_request")
        .select("summary", "new_value")
        .where({ id: shortfallApprovalId })
        .first();
      assert.ok(row, "approval request row not found");
      const summary = String(row.summary || "");
      assert.ok(
        /approval required/i.test(summary),
        `summary does not state the reason: ${summary}`,
      );
      assert.ok(
        /negative/i.test(summary),
        `summary does not mention negative stock: ${summary}`,
      );
      assert.ok(
        summary.includes(unstocked.name),
        `summary does not name the raw material: ${summary}`,
      );
      assert.ok(
        /needs 3 more than the 0 on hand/.test(summary),
        `summary does not quantify the shortfall: ${summary}`,
      );
      const shortfalls = row.new_value?.negative_stock_lines || [];
      assert.strictEqual(
        shortfalls.length,
        1,
        "the payload should carry one shortfall for the approver to preview",
      );
      assert.strictEqual(Number(shortfalls[0].short_qty), 3);
    });

    console.log("\nStock effect of approving");
    await check("approving the request posts the loan and goes negative", async () => {
      if (!shortfallApprovalId || !unstocked) return;
      const bucketRef = {
        branchId: branch.id,
        itemId: unstocked.id,
        colorId: null,
        sizeId: null,
      };
      const before = {
        onHand: await readRmBucket({ ...bucketRef, stockState: "ON_HAND" }),
        out: await readRmBucket({
          ...bucketRef,
          stockState: "WITH_THIRD_PARTY",
        }),
      };
      const request = await knex("erp.approval_request")
        .select("new_value")
        .where({ id: shortfallApprovalId })
        .first();

      const created = await knex.transaction((trx) =>
        returnableVoucherService.applyReturnableVoucherCreatePayloadTx({
          trx,
          payload: request.new_value,
          approverId: user.id,
          req,
        }),
      );
      assert.ok(created?.id, "approval apply did not create a voucher");
      createdVoucherIds.push(created.id);

      const after = {
        onHand: await readRmBucket({ ...bucketRef, stockState: "ON_HAND" }),
        out: await readRmBucket({
          ...bucketRef,
          stockState: "WITH_THIRD_PARTY",
        }),
      };
      assert.ok(
        Math.abs(after.onHand.qty - (before.onHand.qty - 3)) < 0.001,
        `on-hand should have dropped by 3, went ${before.onHand.qty} -> ${after.onHand.qty}`,
      );
      assert.ok(
        after.onHand.qty < 0,
        `on-hand should now be negative, is ${after.onHand.qty}`,
      );
      assert.ok(
        Math.abs(after.out.qty - (before.out.qty + 3)) < 0.001,
        `with-third-party should have risen by 3, went ${before.out.qty} -> ${after.out.qty}`,
      );
      // A loan is a reclass, not a disposal: material the branch never held has no
      // cost to move, so total inventory value must not budge either way.
      assert.ok(
        Math.abs(
          after.onHand.value +
            after.out.value -
            (before.onHand.value + before.out.value),
        ) < 0.05,
        "lending changed total inventory value",
      );
    });

    await check("the approved dispatch posts no GL entries", async () => {
      if (!createdVoucherIds.length) return;
      const rows = await knex("erp.gl_entry as ge")
        .join("erp.gl_batch as gb", "gb.id", "ge.batch_id")
        .count({ n: "*" })
        .where("gb.source_voucher_id", createdVoucherIds[0])
        .first();
      assert.strictEqual(
        Number(rows?.n || 0),
        0,
        "a returnable loan must not touch the general ledger",
      );
    });

    console.log("\nControl: covered lines are unaffected");
    await check("a line the branch can cover still saves directly", async () => {
      if (!stocked) return;
      const created = await returnableVoucherService.createReturnableVoucher({
        req,
        voucherTypeCode: "RDV",
        scopeKey: "RDV",
        payload: dispatchPayload({
          partyId: party.id,
          remarks: "test: lend raw material the branch has",
          line: {
            entry_kind: "RM",
            item_id: stocked.itemId,
            color_id: stocked.colorId,
            size_id: stocked.sizeId,
            qty: 1,
          },
        }),
      });
      assert.strictEqual(
        created.queuedForApproval,
        false,
        "a covered line must not be dragged through approvals",
      );
      assert.ok(created.id, "covered line did not create a voucher");
      createdVoucherIds.push(created.id);
    });

    await check("an invalid item id is still rejected outright", async () => {
      await assert.rejects(
        () =>
          returnableVoucherService.createReturnableVoucher({
            req,
            voucherTypeCode: "RDV",
            scopeKey: "RDV",
            payload: dispatchPayload({
              partyId: party.id,
              remarks: "test: bogus item",
              line: { entry_kind: "RM", item_id: 99999999, qty: 1 },
            }),
          }),
        /invalid/i,
      );
    });
  } finally {
    for (const voucherId of createdVoucherIds) {
      await deleteVoucherCompletely(voucherId);
    }
    if (createdApprovalIds.length) {
      await knex("erp.approval_request")
        .whereIn("id", createdApprovalIds)
        .del();
    }
    await restoreBranchRmStock(branch.id, stockSnapshot);
    await knex.destroy();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
