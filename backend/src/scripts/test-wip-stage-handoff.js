// Regression test for the department WIP hand-off ("whose tray do I take the pairs from?").
//
// The bug this pins down: a BOM stage with "Follow Sequence" unchecked used to credit its
// own WIP pool and debit NOBODY, because one resolver field answered two different
// questions -- "may this stage start?" (the gate, correctly driven by enforce_sequence)
// and "whose pool do my pairs come out of?" (the hand-off, which has nothing to do with
// enforce_sequence). The stage's pairs were then stranded forever: no later stage names it
// as a predecessor, and it is not the final stage, so it never posts to stock either.
//
// Everything runs inside ONE transaction that is always rolled back, so the dev database is
// untouched. It drives the REAL posting path (ensureProductionVoucherDerivedDataTx), not a
// re-implementation -- a green run here means the shipped code settles the chain.
//
// Usage (from backend/):
//   npm run test:wip-stage-handoff

require("dotenv").config();
const knex = require("../db/knex");
const {
  ensureProductionVoucherDerivedDataTx,
} = require("../services/production/production-voucher-service");
const {
  adjustWipBalanceTx,
  insertWipLedgerTx,
} = require("../services/production/wip-pool");
const { repairStrandedWipTx } = require("./repair-stranded-wip-stage-balance");

const TAG = "[test-wip-stage-handoff]";
const PAIRS = 660;

let passed = 0;
let failed = 0;

const check = (label, actual, expected) => {
  const ok = Number(actual) === Number(expected);
  if (ok) {
    passed += 1;
    console.log(`    PASS  ${label} = ${actual}`);
  } else {
    failed += 1;
    console.log(`    FAIL  ${label} = ${actual}, expected ${expected}`);
  }
};

const seedScenario = async ({ trx, token, routes }) => {
  const safe = String(token)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 20);

  const user = await trx("erp.users").select("id").orderBy("id").first();
  const branch = await trx("erp.branches")
    .select("id")
    .where({ is_active: true })
    .orderBy("id")
    .first();
  const pairUom = await trx("erp.uom")
    .select("id")
    .whereRaw("is_active = true AND UPPER(code) = 'PAIR'")
    .first();
  const group = await trx("erp.product_groups")
    .select("id")
    .where({ is_active: true })
    .orderBy("id")
    .first();
  const size = await trx("erp.sizes")
    .select("id")
    .where({ is_active: true })
    .orderBy("id")
    .first();
  const color = await trx("erp.colors")
    .select("id")
    .where({ is_active: true })
    .orderBy("id")
    .first();
  if (!user || !branch || !pairUom || !group || !size || !color) {
    throw new Error(
      "dev database is missing a user/branch/PAIR uom/group/size/colour",
    );
  }

  const creatorId = Number(user.id);
  const branchId = Number(branch.id);

  const stages = [];
  for (const route of routes) {
    const [deptRow] = await trx("erp.departments")
      .insert({
        name: `WIPTEST ${route.label} ${safe}`.slice(0, 120),
        name_ur: `WIPTEST ${route.label} ${safe}`.slice(0, 120),
        is_production: true,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const deptId = Number(deptRow?.id || deptRow);

    const [stageRow] = await trx("erp.production_stages")
      .insert({
        code: `WIPT${route.label}${safe}`.slice(0, 80).toUpperCase(),
        name: `WIPTEST Stage ${route.label} ${safe}`.slice(0, 120),
        name_ur: `WIPTEST Stage ${route.label} ${safe}`.slice(0, 120),
        dept_id: deptId,
        is_active: true,
        created_by: creatorId,
      })
      .returning(["id"]);
    const stageId = Number(stageRow?.id || stageRow);

    const [labourRow] = await trx("erp.labours")
      .insert({
        code: `WIPTL${route.label}${safe}`.slice(0, 40).toUpperCase(),
        name: `WIPTEST Labour ${route.label} ${safe}`.slice(0, 120),
        name_ur: `WIPTEST Labour ${route.label} ${safe}`.slice(0, 120),
        dept_id: deptId,
        status: "ACTIVE",
      })
      .returning(["id"]);
    const labourId = Number(labourRow?.id || labourRow);
    await trx("erp.labour_department").insert({
      labour_id: labourId,
      dept_id: deptId,
    });
    await trx("erp.labour_branch").insert({
      labour_id: labourId,
      branch_id: branchId,
    });

    stages.push({ ...route, deptId, stageId, labourId });
  }

  const [itemRow] = await trx("erp.items")
    .insert({
      code: `WIPTFG${safe}`.slice(0, 40).toUpperCase(),
      name: `WIPTEST FG ${safe}`.slice(0, 120),
      name_ur: `WIPTEST FG ${safe}`.slice(0, 120),
      item_type: "FG",
      group_id: Number(group.id),
      base_uom_id: Number(pairUom.id),
      is_active: true,
      created_by: creatorId,
    })
    .returning(["id"]);
  const itemId = Number(itemRow?.id || itemRow);

  const [variantRow] = await trx("erp.variants")
    .insert({
      item_id: itemId,
      size_id: Number(size.id),
      color_id: Number(color.id),
      is_active: true,
      created_by: creatorId,
    })
    .returning(["id"]);
  const variantId = Number(variantRow?.id || variantRow);

  const [skuRow] = await trx("erp.skus")
    .insert({
      variant_id: variantId,
      sku_code: `WIPT-${safe}`.slice(0, 60),
      is_active: true,
    })
    .returning(["id"]);
  const skuId = Number(skuRow?.id || skuRow);

  // Approved BOM, no RM and no SFG lines: this test is only about the WIP hand-off, and an
  // empty material list keeps the generated-consumption step a no-op.
  const [bomRow] = await trx("erp.bom_header")
    .insert({
      bom_no: `WIPT-${safe}`.slice(0, 40),
      item_id: itemId,
      level: "FINISHED",
      status: "APPROVED",
      version_no: 1,
      output_qty: 1,
      output_uom_id: Number(pairUom.id),
      created_by: creatorId,
      approved_by: creatorId,
      approved_at: trx.fn.now(),
    })
    .returning(["id"]);
  const bomId = Number(bomRow?.id || bomRow);

  await trx("erp.bom_stage_routing").insert(
    stages.map((stage, index) => ({
      bom_id: bomId,
      stage_id: stage.stageId,
      sequence_no: index + 1,
      is_required: stage.isRequired !== false,
      enforce_sequence: stage.enforceSequence !== false,
    })),
  );

  await trx("erp.bom_labour_line").insert(
    stages.map((stage) => ({
      bom_id: bomId,
      dept_id: stage.deptId,
      labour_id: stage.labourId,
      rate_type: "PER_PAIR",
      rate_value: stage.rate,
      size_scope: "ALL",
    })),
  );

  return {
    branchId,
    creatorId,
    skuId,
    itemId,
    pairUomId: Number(pairUom.id),
    stages,
  };
};

// Build the DCV exactly the way saveProductionVoucherCoreTx does: one SKU line per
// (article x department), the per-line department in erp.dcv_line, and dcv_header carrying
// the FIRST department in BOM stage order.
const seedDcv = async ({ trx, fixture, postedStages, voucherDate }) => {
  const nextNoRow = await trx("erp.voucher_header")
    .max({ max_no: "voucher_no" })
    .where({ branch_id: fixture.branchId, voucher_type_code: "DCV" })
    .first();
  const voucherNo = Number(nextNoRow?.max_no || 0) + 1;

  const [headerRow] = await trx("erp.voucher_header")
    .insert({
      voucher_type_code: "DCV",
      voucher_no: voucherNo,
      branch_id: fixture.branchId,
      voucher_date: voucherDate,
      status: "APPROVED",
      created_by: fixture.creatorId,
      approved_by: fixture.creatorId,
      approved_at: trx.fn.now(),
    })
    .returning(["id"]);
  const voucherId = Number(headerRow?.id || headerRow);

  await trx("erp.dcv_header").insert({
    voucher_id: voucherId,
    dept_id: postedStages[0].deptId,
    labour_id: postedStages[0].labourId,
  });

  let lineNo = 0;
  for (const stage of postedStages) {
    lineNo += 1;
    const [lineRow] = await trx("erp.voucher_line")
      .insert({
        voucher_header_id: voucherId,
        line_no: lineNo,
        line_kind: "SKU",
        sku_id: fixture.skuId,
        uom_id: fixture.pairUomId,
        qty: PAIRS,
        rate: stage.rate,
        amount: Number((PAIRS * stage.rate).toFixed(2)),
        meta: JSON.stringify({
          unit: "PAIR",
          status: "LOOSE",
          total_pairs: PAIRS,
          dcv_entry_row: 1,
        }),
      })
      .returning(["id"]);
    const voucherLineId = Number(lineRow?.id || lineRow);
    await trx("erp.dcv_line").insert({
      voucher_line_id: voucherLineId,
      dept_id: stage.deptId,
      labour_id: stage.labourId,
      stage_id: stage.stageId,
    });
  }

  return voucherId;
};

const readPools = async ({ trx, branchId, skuId }) => {
  const rows = await trx("erp.wip_dept_balance")
    .select("dept_id", "qty_pairs", "cost_value")
    .where({ branch_id: branchId, sku_id: skuId });
  return new Map(rows.map((row) => [Number(row.dept_id), row]));
};

const runScenario = async ({ trx, name, routes, postOnly = null }) => {
  console.log(`\n  ${name}`);
  const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const fixture = await seedScenario({ trx, token, routes });
  const postedStages = postOnly
    ? fixture.stages.filter((stage) => postOnly.includes(stage.label))
    : fixture.stages;
  const voucherDate = "2026-08-25";

  const voucherId = await seedDcv({ trx, fixture, postedStages, voucherDate });
  await ensureProductionVoucherDerivedDataTx({
    trx,
    voucherId,
    voucherTypeCode: "DCV",
    actorUserId: fixture.creatorId,
  });

  const pools = await readPools({
    trx,
    branchId: fixture.branchId,
    skuId: fixture.skuId,
  });
  for (const stage of fixture.stages) {
    const pool = pools.get(Number(stage.deptId));
    check(`${stage.label} tray pairs`, Number(pool?.qty_pairs || 0), 0);
  }

  const stock = await trx("erp.stock_balance_sku")
    .select("qty_pairs", "value")
    .where({ branch_id: fixture.branchId, sku_id: fixture.skuId })
    .first();
  check("FG stock pairs", Number(stock?.qty_pairs || 0), PAIRS);

  // Every posted department's labour must reach the finished-goods value. Under the bug the
  // skipped stage's amount stayed behind in its pool and FG came out undervalued.
  const expectedValue = postedStages.reduce(
    (sum, stage) => sum + Number((PAIRS * stage.rate).toFixed(2)),
    0,
  );
  check("FG stock value", Number(stock?.value || 0), expectedValue);
};

// Scenario F: the guard on how far back the drain may reach. A strict chain A -> B -> C, and
// only A has been completed. C must still be REFUSED -- walking the chain must never let it
// reach past its sequence-enforced predecessor and help itself to A's tray, which would turn
// a hard stage-flow error into a silent double-draw.
const runGateStopsChainScenario = async ({ trx }) => {
  console.log(`\n  F. strict chain refuses to reach past a short predecessor`);
  const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const fixture = await seedScenario({
    trx,
    token,
    routes: [
      { label: "A", rate: 20, enforceSequence: true },
      { label: "B", rate: 30, enforceSequence: true },
      { label: "C", rate: 40, enforceSequence: true },
    ],
  });
  const [stageA, stageB, stageC] = fixture.stages;
  const voucherDate = "2026-08-25";

  // Only stage A runs, so B's tray is empty and C has nothing legitimate to take.
  const firstVoucherId = await seedDcv({
    trx,
    fixture,
    postedStages: [stageA],
    voucherDate,
  });
  await ensureProductionVoucherDerivedDataTx({
    trx,
    voucherId: firstVoucherId,
    voucherTypeCode: "DCV",
    actorUserId: fixture.creatorId,
  });

  const secondVoucherId = await seedDcv({
    trx,
    fixture,
    postedStages: [stageC],
    voucherDate,
  });

  // A failed post must not leave half a movement behind, so give it its own savepoint.
  let blocked = false;
  let message = "";
  try {
    await trx.transaction(async (inner) => {
      await ensureProductionVoucherDerivedDataTx({
        trx: inner,
        voucherId: secondVoucherId,
        voucherTypeCode: "DCV",
        actorUserId: fixture.creatorId,
      });
    });
  } catch (err) {
    blocked = true;
    message = String(err?.message || "");
  }

  check("stage C was refused", blocked ? 1 : 0, 1);
  check(
    "refusal names the stage-flow shortage",
    /previous stage WIP is insufficient/i.test(message) ? 1 : 0,
    1,
  );

  const pools = await readPools({
    trx,
    branchId: fixture.branchId,
    skuId: fixture.skuId,
  });
  check(
    "A tray untouched by the refused post",
    Number(pools.get(Number(stageA.deptId))?.qty_pairs || 0),
    PAIRS,
  );
  check(
    "B tray still empty",
    Number(pools.get(Number(stageB.deptId))?.qty_pairs || 0),
    0,
  );
};

// Writes one WIP pool movement by hand, using the same primitives the voucher path uses.
// Needed because only the PRE-FIX code produced a phantom tray, so the repair scenarios have
// to reconstruct that ledger shape rather than post their way into it.
const bookWip = async ({
  trx,
  fixture,
  voucherId,
  deptId,
  direction,
  pairs,
  cost,
  date,
}) => {
  await adjustWipBalanceTx({
    trx,
    branchId: fixture.branchId,
    skuId: fixture.skuId,
    deptId,
    qtyDelta: direction === 1 ? pairs : -pairs,
    costDelta: direction === 1 ? cost : -cost,
    activityDate: date,
  });
  await insertWipLedgerTx({
    trx,
    branchId: fixture.branchId,
    skuId: fixture.skuId,
    deptId,
    txnDate: date,
    direction,
    qtyPairs: pairs,
    costValue: cost,
    sourceVoucherId: voucherId,
  });
};

// Scenario D: the exact ledger the pre-fix code left behind, captured by running the old
// resolver against fixture A -- stage A credited then drained by C, stage B credited and
// never drained, stage C credited then relieved to stock. B's 660 are phantom.
const runRepairScenario = async ({ trx }) => {
  console.log(`\n  D. repair removes a phantom tray, leaves genuine WIP alone`);
  const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const fixture = await seedScenario({
    trx,
    token,
    routes: [
      { label: "A", rate: 20, enforceSequence: true },
      { label: "B", rate: 30, enforceSequence: false },
      { label: "C", rate: 40, enforceSequence: true },
    ],
  });
  const [stageA, stageB, stageC] = fixture.stages;
  const date = "2026-08-25";
  const voucherId = await seedDcv({
    trx,
    fixture,
    postedStages: fixture.stages,
    voucherDate: date,
  });

  const book = (deptId, direction, pairs, cost) =>
    bookWip({ trx, fixture, voucherId, deptId, direction, pairs, cost, date });

  await book(stageA.deptId, 1, PAIRS, PAIRS * 20);
  await book(stageB.deptId, 1, PAIRS, PAIRS * 30);
  await book(stageA.deptId, -1, PAIRS, PAIRS * 20);
  await book(stageC.deptId, 1, PAIRS, PAIRS * 60);
  await book(stageC.deptId, -1, PAIRS, PAIRS * 60);

  const before = await readPools({
    trx,
    branchId: fixture.branchId,
    skuId: fixture.skuId,
  });
  check(
    "B tray before repair",
    Number(before.get(Number(stageB.deptId))?.qty_pairs || 0),
    PAIRS,
  );

  const result = await repairStrandedWipTx({
    trx,
    apply: true,
    filters: { skuId: fixture.skuId, branchId: fixture.branchId },
  });
  check("trays corrected", result.corrections.length, 1);
  check(
    "phantom pairs removed",
    Number(result.corrections[0]?.phantomPairs || 0),
    PAIRS,
  );
  check(
    "phantom cost removed",
    Number(result.corrections[0]?.phantomCost || 0),
    PAIRS * 30,
  );

  const after = await readPools({
    trx,
    branchId: fixture.branchId,
    skuId: fixture.skuId,
  });
  for (const stage of fixture.stages) {
    check(
      `${stage.label} tray after repair`,
      Number(after.get(Number(stage.deptId))?.qty_pairs || 0),
      0,
    );
  }
};

// Scenario E: an honest half-finished line. A completed 660, B has taken up only 400, so 260
// really are waiting at A and 400 really are at B. The repair must not touch either.
const runGenuineWipScenario = async ({ trx }) => {
  console.log(`\n  E. repair leaves a genuinely half-finished line untouched`);
  const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const fixture = await seedScenario({
    trx,
    token,
    routes: [
      { label: "A", rate: 20, enforceSequence: true },
      { label: "B", rate: 30, enforceSequence: false },
      { label: "C", rate: 40, enforceSequence: true },
    ],
  });
  const [stageA, stageB] = fixture.stages;
  const date = "2026-08-25";
  const voucherId = await seedDcv({
    trx,
    fixture,
    postedStages: fixture.stages,
    voucherDate: date,
  });
  const book = (deptId, direction, pairs, cost) =>
    bookWip({ trx, fixture, voucherId, deptId, direction, pairs, cost, date });

  await book(stageA.deptId, 1, PAIRS, PAIRS * 20);
  await book(stageA.deptId, -1, 400, 400 * 20);
  await book(stageB.deptId, 1, 400, 400 * 50);

  const result = await repairStrandedWipTx({
    trx,
    apply: true,
    filters: { skuId: fixture.skuId, branchId: fixture.branchId },
  });
  check("trays corrected", result.corrections.length, 0);

  const after = await readPools({
    trx,
    branchId: fixture.branchId,
    skuId: fixture.skuId,
  });
  check(
    "A tray kept",
    Number(after.get(Number(stageA.deptId))?.qty_pairs || 0),
    PAIRS - 400,
  );
  check(
    "B tray kept",
    Number(after.get(Number(stageB.deptId))?.qty_pairs || 0),
    400,
  );
};

const run = async () => {
  console.log(
    `${TAG} driving real DCV posting inside a rolled-back transaction`,
  );
  try {
    await knex.transaction(async (trx) => {
      // The reported production bug: middle stage with "Follow Sequence" unchecked.
      await runScenario({
        trx,
        name: 'A. three mandatory stages, MIDDLE has "Follow Sequence" OFF',
        routes: [
          { label: "A", rate: 20, enforceSequence: true },
          { label: "B", rate: 30, enforceSequence: false },
          { label: "C", rate: 40, enforceSequence: true },
        ],
      });

      // Regression guard: the ordinary strict chain must be unchanged.
      await runScenario({
        trx,
        name: "B. three mandatory stages, all sequence-enforced",
        routes: [
          { label: "A", rate: 20, enforceSequence: true },
          { label: "B", rate: 30, enforceSequence: true },
          { label: "C", rate: 40, enforceSequence: true },
        ],
      });

      // An OPTIONAL middle stage that production actually bypassed: the last stage has to
      // fall back through the empty tray to the one before it.
      await runScenario({
        trx,
        name: "C. optional middle stage bypassed, only A and C posted",
        routes: [
          { label: "A", rate: 20, enforceSequence: true },
          { label: "B", rate: 30, isRequired: false, enforceSequence: true },
          { label: "C", rate: 40, enforceSequence: true },
        ],
        postOnly: ["A", "C"],
      });

      await runGateStopsChainScenario({ trx });
      await runRepairScenario({ trx });
      await runGenuineWipScenario({ trx });

      console.log(`\n${TAG} rolling back -- the dev database keeps nothing`);
      throw new Error("__ROLLBACK__");
    });
  } catch (err) {
    if (!String(err?.message || "").includes("__ROLLBACK__")) {
      console.error(`\n${TAG} ERROR:`, err?.message || err);
      failed += 1;
    }
  }

  console.log(`\n${TAG} ${passed} passed, ${failed} failed`);
  await knex.destroy();
  process.exit(failed ? 1 : 0);
};

run();
