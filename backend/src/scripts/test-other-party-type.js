// Integration tests for party_type = 'OTHER'.
//
// An OTHER party is one the business neither buys from nor sells to, but still
// hands goods to on a returnable gate pass (sister concern, neighbouring factory,
// employee). The whole design rests on two claims that are easy to break later:
//
//   1. OTHER is selectable wherever a returnable gate pass needs a recipient.
//   2. OTHER is invisible everywhere a trading partner is expected — purchase,
//      sales, and the financial-voucher party picker (which posts to a
//      receivable/payable control account that an OTHER party does not have).
//
// These run against the configured database and clean up everything they create.
//
//   node src/scripts/test-other-party-type.js

const assert = require("assert");

const knex = require("../db/knex");
const { resolveTranslation } = require("../middleware/core/locale");
const returnableVoucherService = require("../services/returnables/returnable-voucher-service");
const returnableReportService = require("../services/returnables/returnable-report-service");
const purchaseVoucherService = require("../services/purchase/purchase-voucher-service");
const salesVoucherService = require("../services/sales/sales-voucher-service");
const financialVoucherService = require("../services/financial/voucher-service");
const partiesRoutes = require("../routes/master_data/parties");

const OTHER_PARTY_NAME = "ZZ Test Neighbour (OTHER)";
const CUSTOMER_PARTY_NAME = "ZZ Test Customer (control)";

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
  originalUrl: "/test/other-party-type",
  ip: "127.0.0.1",
  headers: {},
  body: {},
  user: { id: userId, isAdmin: true, username: "test-runner" },
  branchOptions: [{ id: branch.id, name: branch.name }],
  // Voucher services read permissions off res.locals.can.
  res: { locals: { can: () => true } },
});

const names = (rows) => (rows || []).map((row) => String(row.name || ""));

// Lending needs a branch that actually holds raw material on hand.
const findBranchWithRmStock = async () => {
  const bucket = await knex("erp.stock_balance_rm as sb")
    .join("erp.branches as b", "b.id", "sb.branch_id")
    .select(
      "sb.branch_id",
      "b.name as branch_name",
      "sb.item_id",
      "sb.color_id",
      "sb.size_id",
      "sb.qty",
      "sb.value",
    )
    .where("sb.stock_state", "ON_HAND")
    .andWhere("sb.qty", ">", 1)
    .orderBy("sb.qty", "desc")
    .first();
  if (!bucket) return null;
  return {
    branch: { id: Number(bucket.branch_id), name: bucket.branch_name },
    bucket: {
      itemId: Number(bucket.item_id),
      colorId: bucket.color_id === null ? null : Number(bucket.color_id),
      sizeId: bucket.size_id === null ? null : Number(bucket.size_id),
      qty: Number(bucket.qty),
      value: Number(bucket.value),
    },
  };
};

const readRmBucket = async ({ branchId, bucket, stockState }) => {
  const row = await knex("erp.stock_balance_rm")
    .select("qty", "value")
    .where({
      branch_id: branchId,
      stock_state: stockState,
      item_id: bucket.itemId,
    })
    .whereRaw("COALESCE(color_id, 0) = ?", [Number(bucket.colorId || 0)])
    .whereRaw("COALESCE(size_id, 0) = ?", [Number(bucket.sizeId || 0)])
    .first();
  return { qty: Number(row?.qty || 0), value: Number(row?.value || 0) };
};

const createParty = async ({ name, code, partyType, branchId, userId }) => {
  const [row] = await knex("erp.parties")
    .insert({
      code,
      name,
      name_ur: name,
      party_type: partyType,
      branch_id: branchId,
      created_by: userId,
      is_active: true,
    })
    .returning("id");
  const id = Number(row?.id ?? row);
  await knex("erp.party_branch").insert({ party_id: id, branch_id: branchId });
  return id;
};

const run = async () => {
  const user = await knex("erp.users").select("id").orderBy("id").first();
  assert.ok(user, "No users in the database to attribute test records to.");

  const stock = await findBranchWithRmStock();
  const fallbackBranch = await knex("erp.branches")
    .select("id", "name")
    .orderBy("id")
    .first();
  assert.ok(fallbackBranch, "No branches in the database.");

  const branch = stock?.branch || fallbackBranch;
  const req = buildReq({ branch, userId: user.id });

  const createdPartyIds = [];
  const createdVoucherIds = [];
  // Tracked separately from createdVoucherIds: the journal voucher created by the
  // save-guard control test posts GL entries quite legitimately, so the
  // "no GL entries" assertion must look at the dispatch alone.
  let dispatchVoucherId = null;
  let restoreStock = null;

  try {
    const otherPartyId = await createParty({
      name: OTHER_PARTY_NAME,
      code: "ZZ_TEST_OTHER",
      partyType: "OTHER",
      branchId: branch.id,
      userId: user.id,
    });
    createdPartyIds.push(otherPartyId);

    const customerPartyId = await createParty({
      name: CUSTOMER_PARTY_NAME,
      code: "ZZ_TEST_CUST",
      partyType: "CUSTOMER",
      branchId: branch.id,
      userId: user.id,
    });
    createdPartyIds.push(customerPartyId);

    console.log(`\nBranch: ${branch.name} (id ${branch.id})`);
    console.log(
      stock
        ? `RM bucket for the lending test: item ${stock.bucket.itemId}, on hand ${stock.bucket.qty}\n`
        : "No raw material on hand — the end-to-end lending test will be skipped.\n",
    );

    console.log("Schema");
    await check("party_type enum contains OTHER", async () => {
      const rows = await knex.raw(
        `select enumlabel from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'party_type'`,
      );
      const labels = rows.rows.map((row) => row.enumlabel);
      assert.ok(
        labels.includes("OTHER"),
        `expected OTHER in party_type, got: ${labels.join(", ")}`,
      );
    });

    await check("Parties master offers Other in the type dropdown", () => {
      const field = partiesRoutes.preview.page.fields.find(
        (item) => item.name === "party_type",
      );
      assert.ok(field, "party_type field missing from the parties page config");
      const values = field.options.map((option) => option.value);
      assert.deepStrictEqual(values, ["CUSTOMER", "SUPPLIER", "OTHER"]);
    });

    console.log("\nLabels");
    await check("returnable party label is 'Sent To', not 'Vendor'", () => {
      assert.strictEqual(resolveTranslation("en", "vendor_party"), "Sent To");
      assert.strictEqual(
        resolveTranslation("en", "select_vendor"),
        "Select Party",
      );
    });

    await check("other_party resolves in English and Urdu", () => {
      assert.strictEqual(resolveTranslation("en", "other_party"), "Other");
      const urdu = resolveTranslation("ur", "other_party");
      assert.ok(urdu, "no Urdu translation for other_party");
      assert.notStrictEqual(
        urdu,
        "ترجمہ درکار",
        "other_party fell through to the missing-translation placeholder",
      );
    });

    await check("relabelled keys have Urdu translations", () => {
      ["vendor_party", "select_vendor"].forEach((key) => {
        const urdu = resolveTranslation("ur", key);
        assert.ok(urdu, `no Urdu translation for ${key}`);
        assert.notStrictEqual(
          urdu,
          "ترجمہ درکار",
          `${key} fell through to the missing-translation placeholder`,
        );
      });
    });

    console.log("\nReturnables accept OTHER");
    await check("dispatch picker lists the OTHER party", async () => {
      const options =
        await returnableVoucherService.loadReturnableVoucherOptions(req);
      assert.ok(
        names(options.vendors).includes(OTHER_PARTY_NAME),
        `OTHER party missing from the dispatch picker (${options.vendors.length} listed)`,
      );
    });

    await check("dispatch picker still lists suppliers", async () => {
      const options =
        await returnableVoucherService.loadReturnableVoucherOptions(req);
      const supplierIds = await knex("erp.parties")
        .select("id")
        .whereRaw("upper(coalesce(party_type::text,'')) = 'SUPPLIER'")
        .where("is_active", true);
      if (!supplierIds.length) return; // nothing to prove on a supplier-less database
      assert.ok(
        options.vendors.length > 0,
        "dispatch picker returned nothing even though suppliers exist",
      );
    });

    await check("dispatch picker hides customers", async () => {
      const options =
        await returnableVoucherService.loadReturnableVoucherOptions(req);
      assert.ok(
        !names(options.vendors).includes(CUSTOMER_PARTY_NAME),
        "a CUSTOMER party leaked into the returnable dispatch picker",
      );
    });

    await check("returnables report filter lists the OTHER party", async () => {
      const data =
        await returnableReportService.getReturnablesControlReportPageData({
          req,
          input: {},
        });
      assert.ok(
        names(data.options.vendors).includes(OTHER_PARTY_NAME),
        "OTHER party missing from the returnables report filter",
      );
    });

    console.log("\nTrading screens reject OTHER");
    await check("purchase supplier picker hides the OTHER party", async () => {
      const options =
        await purchaseVoucherService.loadPurchaseVoucherOptions(req);
      assert.ok(
        !names(options.suppliers).includes(OTHER_PARTY_NAME),
        "OTHER party leaked into the purchase supplier picker",
      );
    });

    await check("sales customer picker hides the OTHER party", async () => {
      const options = await salesVoucherService.loadSalesVoucherOptions(
        req,
        {},
      );
      assert.ok(
        !names(options.customers).includes(OTHER_PARTY_NAME),
        "OTHER party leaked into the sales customer picker",
      );
    });

    await check(
      "sales customer picker still lists the control customer",
      async () => {
        const options = await salesVoucherService.loadSalesVoucherOptions(
          req,
          {},
        );
        assert.ok(
          names(options.customers).includes(CUSTOMER_PARTY_NAME),
          "the control CUSTOMER party is missing — the exclusion test above proves nothing",
        );
      },
    );

    await check(
      "financial voucher party picker hides the OTHER party",
      async () => {
        // Mirrors the query in routes/vouchers/financial-router-factory.js. A PARTY
        // line posts to a receivable/payable control account and OTHER has neither.
        const rows = await knex("erp.parties as p")
          .select("p.id", "p.name")
          .where({ "p.is_active": true })
          .whereRaw(
            "upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','SUPPLIER','BOTH')",
          );
        assert.ok(
          !names(rows).includes(OTHER_PARTY_NAME),
          "OTHER party leaked into the financial voucher party picker",
        );
        assert.ok(
          names(rows).includes(CUSTOMER_PARTY_NAME),
          "the control CUSTOMER party is missing from the financial picker",
        );
      },
    );

    console.log("\nFinancial voucher save-time guard");
    // The picker no longer offers an OTHER party, but a request that did not come
    // from the form (script, import, hand-built POST) still reaches the save path.
    // It must fail as a clean 400 naming the line, not as an opaque 500 from GL
    // posting further down the same transaction.
    const buildJournalLines = (partyId) => [
      { party_id: partyId, debit: 100, credit: 0, description: "test" },
      { account_id: null, party_id: customerPartyId, debit: 0, credit: 100 },
    ];

    await check(
      "a PARTY line on an OTHER party is a 400, not a 500",
      async () => {
        let threw = null;
        try {
          await financialVoucherService.createVoucher({
            req,
            voucherTypeCode: "JOURNAL_VOUCHER",
            scopeKey: "JOURNAL_VOUCHER",
            voucherDate: new Date().toISOString().slice(0, 10),
            remarks: "test: OTHER party on a journal line",
            lines: buildJournalLines(otherPartyId),
          });
        } catch (error) {
          threw = error;
        }
        assert.ok(threw, "an OTHER party was accepted on a voucher line");
        assert.strictEqual(
          threw.status,
          400,
          `expected a 400, got ${threw.status || "no status (would surface as 500)"}: ${threw.message}`,
        );
        assert.match(threw.message, /neither a customer nor a supplier/i);
        assert.match(threw.message, /^Line 1:/);
      },
    );

    await check("a PARTY line on a missing party is a 400", async () => {
      let threw = null;
      try {
        await financialVoucherService.createVoucher({
          req,
          voucherTypeCode: "JOURNAL_VOUCHER",
          scopeKey: "JOURNAL_VOUCHER",
          voucherDate: new Date().toISOString().slice(0, 10),
          remarks: "test: missing party on a journal line",
          lines: buildJournalLines(2147483000),
        });
      } catch (error) {
        threw = error;
      }
      assert.ok(threw, "a non-existent party was accepted on a voucher line");
      assert.strictEqual(threw.status, 400, `expected a 400: ${threw.message}`);
      assert.match(threw.message, /party does not exist/i);
    });

    await check(
      "the guard does not reject a legitimate customer party line",
      async () => {
        // Without this control the two tests above would also pass if the guard
        // rejected every party line.
        const saved = await financialVoucherService.createVoucher({
          req,
          voucherTypeCode: "JOURNAL_VOUCHER",
          scopeKey: "JOURNAL_VOUCHER",
          voucherDate: new Date().toISOString().slice(0, 10),
          remarks: "test: customer party on a journal line",
          lines: [
            { party_id: customerPartyId, debit: 100, credit: 0 },
            { party_id: customerPartyId, debit: 0, credit: 100 },
          ],
        });
        assert.ok(
          saved?.id,
          `a valid customer party line was rejected: ${JSON.stringify(saved)}`,
        );
        createdVoucherIds.push(Number(saved.id));
      },
    );

    console.log("\nEnd-to-end dispatch");
    await check("dispatch to a CUSTOMER party is rejected", async () => {
      let threw = null;
      try {
        await returnableVoucherService.createReturnableVoucher({
          req,
          voucherTypeCode: "RDV",
          scopeKey: "RDV",
          payload: {
            voucher_date: new Date().toISOString().slice(0, 10),
            vendor_party_id: customerPartyId,
            reason_code: "OTHERS",
            remarks: "test: customer must be rejected",
            expected_return_date: new Date(Date.now() + 14 * 86400000)
              .toISOString()
              .slice(0, 10),
            lines: [{ entry_kind: "RM", item_id: 1, qty: 1 }],
          },
        });
      } catch (error) {
        threw = error;
      }
      assert.ok(threw, "dispatch to a CUSTOMER party was accepted");
      assert.strictEqual(
        threw.status,
        400,
        `expected a 400, got ${threw.status}: ${threw.message}`,
      );
      assert.match(threw.message, /party is invalid/i);
    });

    if (!stock) {
      console.log(
        "  SKIP  lending raw material to an OTHER party (no RM on hand)",
      );
    } else {
      await check(
        "lending raw material to an OTHER party posts a value-neutral reclass",
        async () => {
          const LEND_QTY = 1;
          const before = {
            onHand: await readRmBucket({
              branchId: branch.id,
              bucket: stock.bucket,
              stockState: "ON_HAND",
            }),
            out: await readRmBucket({
              branchId: branch.id,
              bucket: stock.bucket,
              stockState: "WITH_THIRD_PARTY",
            }),
          };
          restoreStock = before;

          const today = new Date();
          const created =
            await returnableVoucherService.createReturnableVoucher({
              req,
              voucherTypeCode: "RDV",
              scopeKey: "RDV",
              payload: {
                voucher_date: today.toISOString().slice(0, 10),
                vendor_party_id: otherPartyId,
                reason_code: "OTHERS",
                remarks: "test: lend raw material to a neighbour",
                expected_return_date: new Date(Date.now() + 14 * 86400000)
                  .toISOString()
                  .slice(0, 10),
                lines: [
                  {
                    entry_kind: "RM",
                    item_id: stock.bucket.itemId,
                    color_id: stock.bucket.colorId,
                    size_id: stock.bucket.sizeId,
                    qty: LEND_QTY,
                  },
                ],
              },
            });

          assert.ok(
            created?.id,
            `voucher was not saved: ${JSON.stringify(created)}`,
          );
          createdVoucherIds.push(Number(created.id));
          dispatchVoucherId = Number(created.id);

          const saved = await knex("erp.rgp_outward")
            .select("vendor_party_id")
            .where({ voucher_id: created.id })
            .first();
          assert.strictEqual(
            Number(saved?.vendor_party_id),
            otherPartyId,
            "the OTHER party was not recorded on the dispatch",
          );

          const after = {
            onHand: await readRmBucket({
              branchId: branch.id,
              bucket: stock.bucket,
              stockState: "ON_HAND",
            }),
            out: await readRmBucket({
              branchId: branch.id,
              bucket: stock.bucket,
              stockState: "WITH_THIRD_PARTY",
            }),
          };

          assert.ok(
            Math.abs(after.onHand.qty - (before.onHand.qty - LEND_QTY)) < 0.005,
            `on-hand qty should drop by ${LEND_QTY}: ${before.onHand.qty} -> ${after.onHand.qty}`,
          );
          assert.ok(
            Math.abs(after.out.qty - (before.out.qty + LEND_QTY)) < 0.005,
            `with-third-party qty should rise by ${LEND_QTY}: ${before.out.qty} -> ${after.out.qty}`,
          );
          // Lending is not a disposal: value only changes bucket, never total.
          assert.ok(
            Math.abs(
              after.onHand.value +
                after.out.value -
                (before.onHand.value + before.out.value),
            ) < 0.05,
            "total inventory value changed — lending must be value-neutral",
          );
        },
      );

      await check("lending posts no GL entries", async () => {
        if (!dispatchVoucherId) return;
        // gl_entry reaches its voucher through gl_batch.source_voucher_id.
        const entries = await knex("erp.gl_entry as ge")
          .join("erp.gl_batch as gb", "gb.id", "ge.batch_id")
          .count({ n: "*" })
          .where("gb.source_voucher_id", dispatchVoucherId)
          .first();
        assert.strictEqual(
          Number(entries?.n || 0),
          0,
          "a returnable loan must not touch the general ledger",
        );
      });
    }
  } finally {
    for (const voucherId of createdVoucherIds) {
      await knex("erp.stock_ledger")
        .where({ voucher_header_id: voucherId })
        .del();
      // Defensive: a loan should post nothing, but never leave orphans behind if
      // that assumption ever breaks.
      const batches = await knex("erp.gl_batch")
        .select("id")
        .where({ source_voucher_id: voucherId });
      if (batches.length) {
        const batchIds = batches.map((batch) => batch.id);
        await knex("erp.gl_entry").whereIn("batch_id", batchIds).del();
        await knex("erp.gl_batch").whereIn("id", batchIds).del();
      }
      await knex("erp.voucher_header").where({ id: voucherId }).del();
    }
    if (stock && restoreStock) {
      const where = (state) =>
        knex("erp.stock_balance_rm")
          .where({
            branch_id: stock.branch.id,
            stock_state: state,
            item_id: stock.bucket.itemId,
          })
          .whereRaw("COALESCE(color_id, 0) = ?", [
            Number(stock.bucket.colorId || 0),
          ])
          .whereRaw("COALESCE(size_id, 0) = ?", [
            Number(stock.bucket.sizeId || 0),
          ]);
      await where("ON_HAND").update({
        qty: restoreStock.onHand.qty,
        value: restoreStock.onHand.value,
      });
      await where("WITH_THIRD_PARTY").update({
        qty: restoreStock.out.qty,
        value: restoreStock.out.value,
      });
    }
    if (createdPartyIds.length) {
      await knex("erp.party_branch").whereIn("party_id", createdPartyIds).del();
      await knex("erp.parties").whereIn("id", createdPartyIds).del();
    }
  }
};

run()
  .then(async () => {
    await knex.destroy();
    const failed = results.filter((row) => !row.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} checks passed.`,
    );
    if (failed.length) {
      console.log("Failed:");
      failed.forEach((row) => console.log(`  - ${row.name}`));
      process.exit(1);
    }
  })
  .catch(async (error) => {
    console.error("\nTest run aborted:", error);
    await knex.destroy();
    process.exit(1);
  });
