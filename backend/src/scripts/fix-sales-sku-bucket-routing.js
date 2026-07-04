// One-off reconciliation for stock_balance_sku rows corrupted by the packed/loose
// bucket-routing bug in sales-voucher-service.js (fixed alongside this script).
//
// Bug recap: applySalesSkuStockOutTx/InTx did not know which bucket (packed/DZN
// vs loose/pairs) a sale line was actually entered against. It always drew from
// whichever stock_balance_sku bucket sorted first with available stock, and any
// oversell shortfall was hardcoded onto the LOOSE bucket — even for lines the
// user entered in DZN mode. This can silently drive the loose bucket negative
// while the correct (packed) bucket sits healthy and untouched, and can also
// eventually trip the erp.stock_balance_sku wac>=0 CHECK constraint (a positive
// qty_pairs sitting on top of a deeply negative value inherited from the
// misroute) when that bucket's quantity later crosses back above zero — e.g.
// on voucher delete.
//
// Ground truth for "which bucket should this have used" is the voucher line's
// own erp.voucher_line.meta->>'is_packed' flag, recorded at the time the sale
// was entered (independent of which bucket the buggy code actually posted to).
// This script:
//   1. Finds erp.stock_ledger rows from SALES_VOUCHER postings (FG/SFG, with a
//      still-existing voucher_line) whose stored is_packed disagrees with the
//      line's recorded intent.
//   2. For every (branch, stock_state, category, sku_id) bucket touched by any
//      such row, recomputes BOTH the loose and packed running balances from
//      scratch by replaying ALL erp.stock_ledger rows for that sku — using the
//      corrected is_packed for sales rows, and the stored is_packed as-is for
//      any other voucher type (production/purchase/transfer are not affected
//      by this bug and are out of scope here).
//   3. Diffs the recomputed balances against what's currently stored and queues
//      an update, and queues an is_packed correction on the misrouted ledger
//      rows themselves (so a future delete/edit of that voucher reverses into
//      the correct bucket instead of re-creating the same corruption).
//
// Usage (from backend/):
//   node src/scripts/fix-sales-sku-bucket-routing.js            # dry run, prints + CSV only
//   node src/scripts/fix-sales-sku-bucket-routing.js --apply    # writes changes in one transaction
const fs = require("fs");
const path = require("path");
const knex = require("../db/knex");

const APPLY = process.argv.includes("--apply");

const roundCost2 = (value) => Number(Number(value || 0).toFixed(2));
const roundUnitCost6 = (value) => Number(Number(value || 0).toFixed(6));
const computeNonNegativeWac = (qty, value) => {
  const numericQty = Number(qty || 0);
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericQty) || Math.abs(numericQty) <= 0.0005) return 0;
  if (!Number.isFinite(numericValue)) return 0;
  const ratio = Math.abs(numericValue) / Math.abs(numericQty);
  return Number.isFinite(ratio) ? roundUnitCost6(ratio) : 0;
};
const bucketKeyOf = ({ branch_id, stock_state, category, sku_id }) =>
  `${branch_id}:${stock_state}:${category}:${sku_id}`;

// Ledger rows from SALES_VOUCHER postings whose stored is_packed disagrees
// with the voucher line's own recorded entry mode.
const loadMisroutedLedgerRows = () =>
  knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .join("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .where("vh.voucher_type_code", "SALES_VOUCHER")
    .whereIn("sl.category", ["FG", "SFG"])
    // sl.is_packed IS NULL means this row predates the packed/loose split
    // entirely (column didn't exist yet) — that's missing metadata, not a
    // misroute, and must NOT be "corrected" retroactively. Only rows where
    // the code actually recorded an explicit bucket that disagrees with the
    // line's own recorded intent are in scope.
    .whereNotNull("sl.is_packed")
    .whereRaw(
      `sl.is_packed IS DISTINCT FROM COALESCE((vl.meta->>'is_packed')::boolean, false)`,
    )
    .select(
      "sl.id",
      "sl.branch_id",
      "sl.stock_state",
      "sl.category",
      "sl.sku_id",
      "sl.is_packed as stored_is_packed",
      knex.raw(`COALESCE((vl.meta->>'is_packed')::boolean, false) as correct_is_packed`),
      "vh.voucher_no",
      "vh.voucher_type_code",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
    );

// Every ledger row for a given (branch, stock_state, category, sku) bucket,
// annotated with the corrected is_packed for SALES_VOUCHER rows (falls back to
// the stored value for every other voucher type, which this script does not
// audit).
const loadAllLedgerRowsForBucket = ({ branchId, stockState, category, skuId }) =>
  knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .where({
      "sl.branch_id": branchId,
      "sl.stock_state": stockState,
      "sl.category": category,
      "sl.sku_id": skuId,
    })
    .select(
      "sl.id",
      "sl.direction",
      "sl.qty_pairs",
      "sl.value",
      "sl.is_packed as stored_is_packed",
      "vh.voucher_type_code",
      knex.raw(`
        CASE
          -- Only reclassify rows the buggy code actually tagged with an
          -- explicit (wrong) bucket. NULL means this row predates the
          -- packed/loose split entirely and must be left as loose (its
          -- current effective treatment), not reinterpreted retroactively.
          WHEN vh.voucher_type_code = 'SALES_VOUCHER' AND vl.id IS NOT NULL AND sl.is_packed IS NOT NULL
            THEN COALESCE((vl.meta->>'is_packed')::boolean, false)
          ELSE COALESCE(sl.is_packed, false)
        END as effective_is_packed
      `),
    );

const run = async () => {
  console.log(`[fix-sales-sku-bucket-routing] mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  const misrouted = await loadMisroutedLedgerRows();
  if (!misrouted.length) {
    console.log("[fix-sales-sku-bucket-routing] no misrouted sales ledger rows found — nothing to do.");
    return;
  }
  console.log(`[fix-sales-sku-bucket-routing] misrouted sales ledger rows: ${misrouted.length}`);

  const bucketKeys = new Map();
  for (const row of misrouted) {
    const key = bucketKeyOf(row);
    if (!bucketKeys.has(key)) {
      bucketKeys.set(key, {
        branchId: Number(row.branch_id),
        stockState: row.stock_state,
        category: row.category,
        skuId: Number(row.sku_id),
      });
    }
  }
  console.log(`[fix-sales-sku-bucket-routing] affected sku buckets: ${bucketKeys.size}`);

  const ledgerUpdates = misrouted.map((row) => ({
    id: row.id,
    from_is_packed: row.stored_is_packed,
    to_is_packed: row.correct_is_packed,
    voucher_no: row.voucher_no,
    voucher_date: row.voucher_date,
    sku_id: row.sku_id,
    branch_id: row.branch_id,
  }));

  const balanceUpdates = [];
  const auditRows = [];

  for (const bucket of bucketKeys.values()) {
    const ledgerRows = await loadAllLedgerRowsForBucket(bucket);
    const totals = { true: { qty: 0, value: 0 }, false: { qty: 0, value: 0 } };
    for (const row of ledgerRows) {
      const bucketFlag = row.effective_is_packed === true ? "true" : "false";
      const direction = Number(row.direction) === -1 ? -1 : 1;
      totals[bucketFlag].qty += direction * Number(row.qty_pairs || 0);
      totals[bucketFlag].value = roundCost2(totals[bucketFlag].value + Number(row.value || 0));
    }

    const skuRow = await knex("erp.skus").select("sku_code").where({ id: bucket.skuId }).first();
    const subjectLabel = skuRow?.sku_code ? skuRow.sku_code : `SKU #${bucket.skuId}`;

    for (const isPackedFlag of ["false", "true"]) {
      const isPacked = isPackedFlag === "true";
      const correctQty = Math.round(totals[isPackedFlag].qty);
      const correctValue = roundCost2(totals[isPackedFlag].value);
      const correctWac = computeNonNegativeWac(correctQty, correctValue);

      const current = await knex("erp.stock_balance_sku")
        .select("qty_pairs", "value", "wac")
        .where({
          branch_id: bucket.branchId,
          stock_state: bucket.stockState,
          category: bucket.category,
          is_packed: isPacked,
          sku_id: bucket.skuId,
        })
        .first();

      const currentQty = Number(current?.qty_pairs || 0);
      const currentValue = Number(current?.value || 0);
      const currentWac = Number(current?.wac || 0);

      // Skip true no-ops (nothing stored and nothing computed).
      if (!current && correctQty === 0 && correctValue === 0) continue;
      const qtyDiff = Math.abs(currentQty - correctQty);
      const valueDiff = Math.abs(currentValue - correctValue);
      if (qtyDiff < 1 && valueDiff < 0.01) continue;

      balanceUpdates.push({
        branch_id: bucket.branchId,
        stock_state: bucket.stockState,
        category: bucket.category,
        is_packed: isPacked,
        sku_id: bucket.skuId,
        exists: Boolean(current),
        qty_pairs: correctQty,
        value: correctValue,
        wac: correctWac,
      });
      auditRows.push({
        branch_id: bucket.branchId,
        sku_id: bucket.skuId,
        sku_code: subjectLabel,
        is_packed: isPacked,
        old_qty_pairs: currentQty,
        new_qty_pairs: correctQty,
        old_value: currentValue,
        new_value: correctValue,
        old_wac: currentWac,
        new_wac: correctWac,
      });
    }
  }

  if (!balanceUpdates.length && !ledgerUpdates.length) {
    console.log("[fix-sales-sku-bucket-routing] nothing to correct.");
    return;
  }

  const csvHeader =
    "branch_id,sku_id,sku_code,is_packed,old_qty_pairs,new_qty_pairs,old_value,new_value,old_wac,new_wac";
  const csvBody = auditRows
    .map((r) =>
      [
        r.branch_id,
        r.sku_id,
        `"${String(r.sku_code).replace(/"/g, '""')}"`,
        r.is_packed,
        r.old_qty_pairs,
        r.new_qty_pairs,
        r.old_value.toFixed(2),
        r.new_value.toFixed(2),
        r.old_wac.toFixed(6),
        r.new_wac.toFixed(6),
      ].join(","),
    )
    .join("\n");
  const csvPath = path.resolve(
    process.cwd(),
    `sales-sku-bucket-fix-${new Date().toISOString().replace(/[:.]/g, "-")}${APPLY ? "" : "-dryrun"}.csv`,
  );
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`, "utf8");

  console.log(`[fix-sales-sku-bucket-routing] balance rows to correct: ${balanceUpdates.length}`);
  console.log(`[fix-sales-sku-bucket-routing] ledger rows to re-tag: ${ledgerUpdates.length}`);
  console.log(`[fix-sales-sku-bucket-routing] audit CSV: ${csvPath}`);
  for (const r of auditRows) {
    console.log(
      `  branch ${r.branch_id} ${r.sku_code} is_packed=${r.is_packed}: qty ${r.old_qty_pairs}->${r.new_qty_pairs}, value ${r.old_value.toFixed(2)}->${r.new_value.toFixed(2)}, wac ${r.old_wac.toFixed(2)}->${r.new_wac.toFixed(2)}`,
    );
  }
  for (const r of ledgerUpdates) {
    console.log(
      `  ledger #${r.id} (SKU ${r.sku_id}, voucher #${r.voucher_no} ${r.voucher_date}): is_packed ${r.from_is_packed} -> ${r.to_is_packed}`,
    );
  }

  if (!APPLY) {
    console.log("[fix-sales-sku-bucket-routing] DRY RUN — no changes written. Re-run with --apply to commit.");
    return;
  }

  await knex.transaction(async (trx) => {
    for (const update of balanceUpdates) {
      if (update.exists) {
        await trx("erp.stock_balance_sku")
          .where({
            branch_id: update.branch_id,
            stock_state: update.stock_state,
            category: update.category,
            is_packed: update.is_packed,
            sku_id: update.sku_id,
          })
          .update({
            qty_pairs: update.qty_pairs,
            value: update.value,
            wac: update.wac,
            last_txn_at: trx.fn.now(),
          });
      } else {
        await trx("erp.stock_balance_sku").insert({
          branch_id: update.branch_id,
          stock_state: update.stock_state,
          category: update.category,
          is_packed: update.is_packed,
          sku_id: update.sku_id,
          qty_pairs: update.qty_pairs,
          value: update.value,
          wac: update.wac,
          last_txn_at: trx.fn.now(),
        });
      }
    }
    for (const update of ledgerUpdates) {
      await trx("erp.stock_ledger")
        .where({ id: update.id })
        .update({ is_packed: update.to_is_packed });
    }
  });

  console.log("[fix-sales-sku-bucket-routing] changes committed.");
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[fix-sales-sku-bucket-routing] failed:", err);
    await knex.destroy();
    process.exit(1);
  });
