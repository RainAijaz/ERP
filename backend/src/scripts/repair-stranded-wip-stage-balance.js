// Repairs phantom department WIP left behind by the "Follow Sequence" hand-off bug.
//
// Background. WIP is a per-department pool: a stage PUTS pairs into its own tray and TAKES
// them out of its predecessor's. Before the fix, a stage whose BOM route had
// enforce_sequence = false took from nobody -- so it credited its tray and the pairs sat
// there forever, while the stage after it reached further back and drained someone else.
// Those pairs are phantom: the goods physically moved on, only the pool never recorded it.
//
// How a phantom is identified. On a serial line the honest balance at a department is
//
//     expected = pairs ever completed AT that department
//              - pairs ever completed AT the NEXT department in the BOM routing
//
// i.e. what a stage produced that its successor has not yet taken up. Genuine
// work-in-progress satisfies this. A tray drained by the bug does not: its successor
// completed just as many pairs (it simply took them from the wrong tray), so expected is 0
// while the tray still holds stock. The surplus over `expected` is what this removes, and
// only ever the surplus -- it never invents pairs and never touches a tray whose successor
// is behind.
//
// Scope, deliberately narrow. It corrects the WIP pool ONLY: erp.wip_dept_balance plus a
// matching erp.wip_dept_ledger row so the movement stays auditable and a later rollback of
// the source voucher still reverses cleanly. It does NOT restate finished-goods stock value,
// GL, or commission. The same bug also left each skipped stage's labour cost out of the FG
// valuation, and this REPORTS that amount -- restating stock value touches WAC and
// downstream costing, which is a separate decision, not a side effect of this cleanup.
//
// Dry run by default; nothing is written without --apply:
//   node src/scripts/repair-stranded-wip-stage-balance.js                    # preview all
//   node src/scripts/repair-stranded-wip-stage-balance.js --article="CO2"    # preview some
//   node src/scripts/repair-stranded-wip-stage-balance.js --apply            # write
//
// Flags:
//   --article=NAME    limit to articles whose name matches (ILIKE %NAME%)
//   --sku-id=N        limit to one SKU
//   --branch-id=N     limit to one branch
//   --apply           commit; without it the transaction is rolled back

const TAG = "[repair-stranded-wip-stage-balance]";
const WIP_ON_HAND = "ON_HAND";

const toInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const round2 = (value) => Number(Number(value || 0).toFixed(2));
const pad = (value, width) =>
  String(value ?? "")
    .padEnd(width)
    .slice(0, width);
const padLeft = (value, width) =>
  String(value ?? "")
    .padStart(width)
    .slice(-width);

const hasColumnTx = async (trx, table, column) =>
  trx.schema.withSchema("erp").hasColumn(table, column);

// The routing the pool is measured against: the highest approved BOM version for the SKU's
// article, ordered the way production runs it.
const loadRoutingBySkuTx = async ({ trx, skuIds }) => {
  if (!skuIds.length) return new Map();
  const rows = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .join("erp.bom_header as bh", function joinApprovedBom() {
      this.on("bh.item_id", "i.id").andOn(
        "bh.status",
        trx.raw("?", ["APPROVED"]),
      );
    })
    .join("erp.bom_stage_routing as bsr", "bsr.bom_id", "bh.id")
    .join("erp.production_stages as ps", "ps.id", "bsr.stage_id")
    .select(
      "s.id as sku_id",
      "bh.id as bom_id",
      "bh.version_no",
      "bsr.sequence_no",
      "bsr.is_required",
      "bsr.enforce_sequence",
      "ps.id as stage_id",
      "ps.name as stage_name",
      "ps.dept_id",
    )
    .whereIn("s.id", skuIds)
    .andWhere("ps.is_active", true)
    .orderBy(["s.id", "bh.version_no", "bsr.sequence_no"]);

  const bySku = new Map();
  rows.forEach((row) => {
    const skuId = Number(row.sku_id);
    const existing = bySku.get(skuId);
    // Rows arrive version-ascending, so a newer version simply replaces what came before.
    if (!existing || Number(existing.versionNo) < Number(row.version_no)) {
      bySku.set(skuId, {
        bomId: Number(row.bom_id),
        versionNo: Number(row.version_no),
        routes: [],
      });
    }
    const target = bySku.get(skuId);
    if (Number(target.versionNo) !== Number(row.version_no)) return;
    target.routes.push({
      sequence_no: Number(row.sequence_no),
      stage_id: Number(row.stage_id),
      stage_name: String(row.stage_name || ""),
      dept_id: Number(row.dept_id),
      is_required: row.is_required !== false,
      enforce_sequence: row.enforce_sequence !== false,
    });
  });
  return bySku;
};

// Pairs ever PUT INTO each tray, per (branch, sku, dept). Deliberately the +1 rows only:
// what a department completed, independent of who later drained it -- which is the very
// thing the bug got wrong, so it cannot be part of the measurement.
const loadCompletedPairsTx = async ({
  trx,
  skuIds,
  branchId = null,
  ledgerHasStockState = true,
}) => {
  if (!skuIds.length) return new Map();
  let query = trx("erp.wip_dept_ledger")
    .select("branch_id", "sku_id", "dept_id")
    .sum({
      completed_pairs: trx.raw(
        "CASE WHEN direction = 1 THEN qty_pairs ELSE 0 END",
      ),
    })
    .whereIn("sku_id", skuIds)
    .groupBy("branch_id", "sku_id", "dept_id");
  if (ledgerHasStockState) query = query.andWhere("stock_state", WIP_ON_HAND);
  if (branchId) query = query.andWhere("branch_id", branchId);
  const rows = await query;
  return new Map(
    rows.map((row) => [
      `${Number(row.branch_id)}:${Number(row.sku_id)}:${Number(row.dept_id)}`,
      Number(row.completed_pairs || 0),
    ]),
  );
};

// The voucher the correction is booked against: the last DCV that credited this tray.
// Attributing it to a real voucher keeps the ledger trail honest, and means rolling that
// voucher back correctly reverses the repair along with the credit it is cancelling.
const loadLastCreditVoucherTx = async ({
  trx,
  branchId,
  skuId,
  deptId,
  ledgerHasStockState = true,
}) => {
  const row = await trx("erp.wip_dept_ledger")
    .select("source_voucher_id")
    .where({
      branch_id: branchId,
      sku_id: skuId,
      dept_id: deptId,
      direction: 1,
      ...(ledgerHasStockState ? { stock_state: WIP_ON_HAND } : {}),
    })
    .orderBy("id", "desc")
    .first();
  return toInt(row?.source_voucher_id);
};

// Detection + correction, factored out of the CLI so the regression test can drive it inside
// its own rolled-back transaction. Always returns what it found; `apply` decides whether the
// rows are actually written.
const repairStrandedWipTx = async ({ trx, apply = false, filters = {} }) => {
  const filterBranchId = toInt(filters.branchId);
  const filterSkuId = toInt(filters.skuId);
  const filterArticle = filters.article || null;

  const [balanceHasStockState, ledgerHasStockState] = await Promise.all([
    hasColumnTx(trx, "wip_dept_balance", "stock_state"),
    hasColumnTx(trx, "wip_dept_ledger", "stock_state"),
  ]);

  let balanceQuery = trx("erp.wip_dept_balance as wb")
    .join("erp.departments as d", "d.id", "wb.dept_id")
    .join("erp.skus as s", "s.id", "wb.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select(
      "wb.branch_id",
      "wb.sku_id",
      "wb.dept_id",
      "wb.qty_pairs",
      "wb.cost_value",
      "d.name as dept_name",
      "s.sku_code",
      "i.name as article",
    )
    .where("wb.qty_pairs", ">", 0)
    .orderBy(["i.name", "s.sku_code", "wb.branch_id", "wb.dept_id"]);
  if (balanceHasStockState) {
    balanceQuery = balanceQuery.andWhere("wb.stock_state", WIP_ON_HAND);
  }
  if (filterBranchId)
    balanceQuery = balanceQuery.andWhere("wb.branch_id", filterBranchId);
  if (filterSkuId)
    balanceQuery = balanceQuery.andWhere("wb.sku_id", filterSkuId);
  if (filterArticle) {
    balanceQuery = balanceQuery.whereRaw("i.name ilike ?", [
      `%${filterArticle}%`,
    ]);
  }

  const balances = await balanceQuery;
  if (!balances.length) return { corrections: [], skipped: [], applied: false };

  const skuIds = [...new Set(balances.map((row) => Number(row.sku_id)))];
  const [routingBySku, completedByKey] = await Promise.all([
    loadRoutingBySkuTx({ trx, skuIds }),
    loadCompletedPairsTx({
      trx,
      skuIds,
      branchId: filterBranchId,
      ledgerHasStockState,
    }),
  ]);

  const corrections = [];
  const skipped = [];

  for (const row of balances) {
    const branchId = Number(row.branch_id);
    const skuId = Number(row.sku_id);
    const deptId = Number(row.dept_id);
    const balancePairs = Number(row.qty_pairs || 0);
    const routing = routingBySku.get(skuId);

    if (!routing || routing.routes.length < 2) {
      skipped.push({ row, reason: "no approved BOM routing (2+ stages)" });
      continue;
    }
    const index = routing.routes.findIndex(
      (route) => Number(route.dept_id) === deptId,
    );
    if (index < 0) {
      // Orphaned: the routing was edited after these pairs were booked. Draining it is a
      // different judgement call, so report it and leave it alone.
      skipped.push({ row, reason: "department not in this SKU's routing" });
      continue;
    }
    if (index === routing.routes.length - 1) {
      skipped.push({
        row,
        reason: "final stage -- drains to stock, not to a successor",
      });
      continue;
    }

    const successor = routing.routes[index + 1];
    const completedHere = Number(
      completedByKey.get(`${branchId}:${skuId}:${deptId}`) || 0,
    );
    const completedNext = Number(
      completedByKey.get(`${branchId}:${skuId}:${Number(successor.dept_id)}`) ||
        0,
    );
    const expectedPairs = Math.max(0, completedHere - completedNext);
    const phantomPairs = Math.max(0, balancePairs - expectedPairs);
    if (phantomPairs <= 0) {
      skipped.push({
        row,
        reason: `genuine WIP (${expectedPairs} pair(s) not yet taken up by ${successor.stage_name})`,
      });
      continue;
    }

    const unitCost =
      balancePairs > 0 ? Number(row.cost_value || 0) / balancePairs : 0;
    const phantomCost = round2(unitCost * phantomPairs);
    const sourceVoucherId = await loadLastCreditVoucherTx({
      trx,
      branchId,
      skuId,
      deptId,
      ledgerHasStockState,
    });
    if (!sourceVoucherId) {
      skipped.push({
        row,
        reason: "no crediting voucher to book the correction against",
      });
      continue;
    }

    corrections.push({
      branchId,
      skuId,
      deptId,
      article: String(row.article || "-"),
      skuCode: String(row.sku_code || "-"),
      deptName: String(row.dept_name || "-"),
      successorName: String(successor.stage_name || "-"),
      balancePairs,
      expectedPairs,
      phantomPairs,
      phantomCost,
      sourceVoucherId,
    });
  }

  if (!apply || !corrections.length) {
    return { corrections, skipped, applied: false };
  }

  for (const fix of corrections) {
    await trx("erp.wip_dept_balance")
      .where({
        branch_id: fix.branchId,
        sku_id: fix.skuId,
        dept_id: fix.deptId,
        ...(balanceHasStockState ? { stock_state: WIP_ON_HAND } : {}),
      })
      .update({
        qty_pairs: trx.raw("greatest(qty_pairs - ?, 0)", [fix.phantomPairs]),
        cost_value: trx.raw("greatest(cost_value - ?, 0)", [fix.phantomCost]),
      });
    await trx("erp.wip_dept_ledger").insert({
      branch_id: fix.branchId,
      sku_id: fix.skuId,
      dept_id: fix.deptId,
      ...(ledgerHasStockState ? { stock_state: WIP_ON_HAND } : {}),
      txn_date: trx.raw("CURRENT_DATE"),
      direction: -1,
      qty_pairs: fix.phantomPairs,
      cost_value: fix.phantomCost,
      source_voucher_id: fix.sourceVoucherId,
    });
  }

  return { corrections, skipped, applied: true };
};

const runCli = async () => {
  require("dotenv").config();
  const knex = require("../db/knex");

  const argv = process.argv.slice(2);
  const hasFlag = (name) => argv.includes(`--${name}`);
  const readArg = (name) => {
    const prefix = `--${name}=`;
    const hit = argv.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const apply = hasFlag("apply");
  const filters = {
    article: readArg("article"),
    skuId: readArg("sku-id"),
    branchId: readArg("branch-id"),
  };

  console.log(
    `${TAG} ${apply ? "APPLY -- changes will be committed" : "DRY RUN -- nothing will be written"}`,
  );

  let result = { corrections: [], skipped: [], applied: false };
  try {
    await knex.transaction(async (trx) => {
      result = await repairStrandedWipTx({ trx, apply, filters });
      if (!apply) throw new Error("__ROLLBACK__");
    });
  } catch (err) {
    if (!String(err?.message || "").includes("__ROLLBACK__")) {
      console.error(`${TAG} ERROR:`, err?.message || err);
      await knex.destroy();
      process.exit(1);
    }
  }

  const { corrections, skipped } = result;
  console.log("");
  console.log(
    `${pad("ARTICLE", 26)} ${pad("SKU", 16)} ${pad("DEPARTMENT", 16)} ${padLeft("HELD", 7)} ${padLeft("KEEP", 7)} ${padLeft("REMOVE", 7)} ${padLeft("VALUE", 12)}  BOOKED TO`,
  );
  console.log("-".repeat(122));
  corrections.forEach((fix) => {
    console.log(
      `${pad(fix.article, 26)} ${pad(fix.skuCode, 16)} ${pad(fix.deptName, 16)} ${padLeft(fix.balancePairs, 7)} ${padLeft(fix.expectedPairs, 7)} ${padLeft(fix.phantomPairs, 7)} ${padLeft(fix.phantomCost.toFixed(2), 12)}  voucher ${fix.sourceVoucherId}`,
    );
  });
  if (!corrections.length) console.log("  (nothing to correct)");

  if (skipped.length) {
    console.log(`\n${TAG} left alone (${skipped.length}):`);
    skipped.forEach((entry) => {
      console.log(
        `  ${pad(entry.row.article, 26)} ${pad(entry.row.sku_code, 16)} ${pad(entry.row.dept_name, 16)} ${padLeft(entry.row.qty_pairs, 7)} pairs  -- ${entry.reason}`,
      );
    });
  }

  const totalPairs = corrections.reduce(
    (sum, fix) => sum + fix.phantomPairs,
    0,
  );
  const totalCost = round2(
    corrections.reduce((sum, fix) => sum + fix.phantomCost, 0),
  );
  console.log(
    `\n${TAG} ${corrections.length} tray(s), ${totalPairs} phantom pair(s), ${totalCost.toFixed(2)} of cost.`,
  );
  if (totalCost > 0) {
    console.log(
      `${TAG} NOTE: that ${totalCost.toFixed(2)} is labour the skipped stages never passed`,
    );
    console.log(
      `${TAG}       forward, so finished-goods stock was valued short by it. This script`,
    );
    console.log(
      `${TAG}       does NOT restate stock value -- decide that separately.`,
    );
  }
  if (corrections.length) {
    console.log(
      result.applied
        ? `\n${TAG} APPLIED -- ${corrections.length} tray(s) corrected.`
        : `\n${TAG} DRY RUN -- rolled back. Re-run with --apply to commit.`,
    );
  }

  await knex.destroy();
};

module.exports = { repairStrandedWipTx };

if (require.main === module) runCli();
