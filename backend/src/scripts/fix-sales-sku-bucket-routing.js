// One-off reconciliation for stock_balance_sku rows corrupted by the packed/loose
// bucket-routing bug in sales-voucher-service.js. Packed and loose are distinct
// physical stock (sealed carton/dozen vs individual pairs), not interchangeable
// buckets of the same count: a sale entered as Dozen/packed must only ever
// affect the packed bucket (going negative if it runs short), never loose, and
// vice versa. Sales OUT draws/shortfalls used to ignore which unit the line was
// actually entered against, picking whichever stock_balance_sku bucket sorted
// first with stock instead -- and worse, even after that ordering was fixed,
// briefly still spilled a shortfall into the OTHER bucket rather than going
// negative on the declared one. Sales IN (return) credits were also hardcoded
// onto the LOOSE bucket regardless of declared unit. All of that is now fixed
// in sales-voucher-service.js: applySalesSkuStockOutTx/InTx only ever touch the
// single bucket the line declared, full stop.
//
// This is a full chronological replay, not a row-by-row relabel, so that the
// same declared-bucket-only rule can be applied consistently across the whole
// history regardless of which buggy behavior produced any given row.
//
// Ground truth for "which bucket a sale should draw from" is the voucher
// line's own erp.voucher_line.meta->>'is_packed' flag, recorded at entry time
// independent of which bucket the code actually posted to.
//
// For every (branch, category, sku_id) bucket that has ever had a SALES_VOUCHER
// FG/SFG posting, this script replays the ENTIRE stock_ledger history for that
// SKU in insertion order (id asc, which reflects true application order even
// for backdated vouchers):
//   - Non-sales rows (production/purchase/transfer/stock-count/etc.) are
//     applied exactly as historically recorded -- out of scope, not touched.
//   - SALES_VOUCHER IN (return) rows credit the declared bucket only.
//   - SALES_VOUCHER OUT rows debit the declared bucket only, going negative if
//     it runs short -- never touching the other bucket, matching the live
//     code's (now-corrected) behavior.
// A sale that a buggy prior version of the code split across both buckets in
// one DB transaction is grouped by voucher_line_id and replayed as a single
// event moving its full total qty into the declared bucket, since under the
// current rule that split should never have happened.
// The simulated final balances are diffed against currently stored
// stock_balance_sku rows to produce the correction set.
//
// stock_ledger.is_packed is retagged onto the declared bucket for every
// physical row of a sales-OUT event. Usually that's a single row. When a
// prior buggy version split one sale across both buckets as two rows, all of
// those rows are retagged onto the declared bucket too (their qty/value are
// left intact, so total movement is preserved) -- this keeps a later
// edit/delete's rollback, which replays each ledger row by its own is_packed,
// crediting stock back to the same single bucket this correction debited
// rather than leaking qty into the other bucket. Such consolidated split
// events are additionally logged to a review CSV purely as an audit trail;
// no manual action is required. The stock_balance_sku correction (the
// operationally important part -- available-stock checks, WAC/COGS,
// stock-count comparisons) is applied regardless, derived from the total
// qty/value moved rather than how the stored rows happen to be split.
//
// Usage (from backend/):
//   node src/scripts/fix-sales-sku-bucket-routing.js            # dry run, prints + CSVs only
//   node src/scripts/fix-sales-sku-bucket-routing.js --apply    # writes changes in one transaction
const fs = require("fs");
const path = require("path");
const knex = require("../db/knex");

const APPLY = process.argv.includes("--apply");

const roundCost2 = (value) => Number(Number(value || 0).toFixed(2));
const roundUnitCost6 = (value) => Number(Number(value || 0).toFixed(6));
const roundQty = (value) => Math.round(Number(value || 0));
const computeNonNegativeWac = (qty, value) => {
  const numericQty = Number(qty || 0);
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericQty) || Math.abs(numericQty) <= 0.0005) return 0;
  if (!Number.isFinite(numericValue)) return 0;
  const ratio = Math.abs(numericValue) / Math.abs(numericQty);
  return Number.isFinite(ratio) ? roundUnitCost6(ratio) : 0;
};
const resolveUnitCost = ({ qty = 0, value = 0, wac = 0 }) => {
  const numericQty = Number(qty || 0);
  const numericValue = Number(value || 0);
  const numericWac = Number(wac || 0);
  if (numericQty > 0 && numericValue > 0) return roundUnitCost6(numericValue / numericQty);
  if (numericWac > 0) return roundUnitCost6(numericWac);
  return 0;
};

// Every (branch, category, sku_id) bucket that has ever had a SALES_VOUCHER
// FG/SFG posting -- the full universe that needs re-simulating, not just rows
// a (necessarily imperfect) heuristic flags as obviously wrong.
const loadCandidateBuckets = () =>
  knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .where("vh.voucher_type_code", "SALES_VOUCHER")
    .whereIn("sl.category", ["FG", "SFG"])
    .distinct("sl.branch_id", "sl.category", "sl.sku_id")
    .select("sl.branch_id", "sl.category", "sl.sku_id");

// Full ledger history for one SKU/branch/category bucket, oldest first (id
// order = true application order, robust to backdated voucher_date), each
// sales row carrying its own voucher_line's declared packed/loose intent.
const loadBucketLedgerHistory = ({ branchId, category, skuId }) =>
  knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .where({
      "sl.branch_id": branchId,
      "sl.stock_state": "ON_HAND",
      "sl.category": category,
      "sl.sku_id": skuId,
    })
    .select(
      "sl.id",
      "sl.direction",
      "sl.qty_pairs",
      "sl.value",
      "sl.unit_cost",
      "sl.is_packed as stored_is_packed",
      "sl.voucher_line_id",
      "vh.voucher_type_code",
      "vh.voucher_no",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
      knex.raw(
        `CASE WHEN vl.id IS NOT NULL THEN (vl.meta->>'is_packed')::boolean ELSE NULL END as declared_is_packed`,
      ),
    )
    .orderBy("sl.id", "asc");

const groupIntoEvents = (history) => {
  const events = [];
  let i = 0;
  while (i < history.length) {
    const row = history[i];
    const isSalesOut =
      row.voucher_type_code === "SALES_VOUCHER" &&
      Number(row.direction) === -1 &&
      row.voucher_line_id != null &&
      row.declared_is_packed !== null;
    if (isSalesOut) {
      const group = [row];
      let j = i + 1;
      while (
        j < history.length &&
        history[j].voucher_type_code === "SALES_VOUCHER" &&
        Number(history[j].direction) === -1 &&
        history[j].voucher_line_id === row.voucher_line_id
      ) {
        group.push(history[j]);
        j += 1;
      }
      events.push({ kind: "SALES_OUT", rows: group, declaredIsPacked: Boolean(row.declared_is_packed) });
      i = j;
    } else {
      events.push({ kind: "OTHER", rows: [row] });
      i += 1;
    }
  }
  return events;
};

// Replays one bucket's full history. Returns final simulated balances, the
// list of ledger rows that can be safely retagged (unambiguous single-bucket
// events), and a list of events that need a human look (oversold both
// buckets combined, or a simulated split that doesn't match the stored row
// shape).
const simulateBucket = (history) => {
  const events = groupIntoEvents(history);
  const sim = { true: { qty: 0, value: 0 }, false: { qty: 0, value: 0 } };
  let lastUnitCost = 0;
  const safeRetags = [];
  const needsReview = [];

  for (const event of events) {
    if (event.kind === "OTHER") {
      const row = event.rows[0];
      const direction = Number(row.direction) === -1 ? -1 : 1;
      const isSalesIn =
        row.voucher_type_code === "SALES_VOUCHER" &&
        direction === 1 &&
        row.declared_is_packed !== null;
      // Sales returns always credit the declared bucket (never split by the
      // live code); everything else keeps its own recorded/inferred bucket.
      const flag = isSalesIn ? row.declared_is_packed === true : row.stored_is_packed === true;
      const bucket = sim[String(flag)];
      bucket.qty = roundQty(bucket.qty + direction * Number(row.qty_pairs || 0));
      bucket.value = roundCost2(bucket.value + Number(row.value || 0));
      if (Number(row.unit_cost || 0) > 0) lastUnitCost = Number(row.unit_cost);

      if (isSalesIn) {
        const currentFlagMatches = row.stored_is_packed === flag;
        if (!currentFlagMatches) {
          safeRetags.push({ id: row.id, from_is_packed: row.stored_is_packed, to_is_packed: flag });
        }
      }
      continue;
    }

    // Declared-bucket-only: debit the SAME bucket the line was entered
    // against, in full, going negative if it runs short. Never touch the
    // other bucket -- packed and loose aren't interchangeable stock.
    const declared = event.declaredIsPacked;
    const totalQty = event.rows.reduce((sum, r) => sum + Number(r.qty_pairs || 0), 0);
    const bucket = sim[String(declared)];
    const availableQty = Number(bucket.qty || 0);
    let consumedValue = 0;
    if (availableQty > 0) {
      const consume = Math.min(availableQty, totalQty);
      const unitCost = resolveUnitCost({
        qty: bucket.qty,
        value: bucket.value,
        wac: computeNonNegativeWac(bucket.qty, bucket.value),
      });
      consumedValue = roundCost2(consume * unitCost);
      if (unitCost > 0) lastUnitCost = unitCost;
    }
    const remaining = totalQty - Math.max(availableQty, 0);
    let shortageValue = 0;
    if (remaining > 0) {
      const fallbackUnitCost = lastUnitCost;
      shortageValue = roundCost2(remaining * fallbackUnitCost);
    }
    const nextQty = roundQty(bucket.qty - totalQty);
    const nextValueRaw = bucket.value - consumedValue - shortageValue;
    bucket.qty = nextQty;
    bucket.value = nextQty > 0 ? Math.max(roundCost2(nextValueRaw), 0) : roundCost2(nextValueRaw);

    // Retag every physical row for this event onto the declared bucket --
    // whether the event posted as a single row, or (under a prior buggy
    // version) got split across both buckets as two rows. Consolidating all
    // rows onto the declared bucket keeps a future edit/delete's rollback --
    // which replays each ledger row by its own is_packed -- crediting stock
    // back to the same single bucket this correction debited, instead of
    // leaking qty into the other bucket. Row qty/value are NOT changed, only
    // the is_packed tag, so the ledger's total movement is preserved.
    for (const row of event.rows) {
      if (row.stored_is_packed !== declared) {
        safeRetags.push({ id: row.id, from_is_packed: row.stored_is_packed, to_is_packed: declared });
      }
    }
    if (event.rows.length > 1) {
      needsReview.push({
        reason: "legacy-cross-bucket-split-consolidated",
        voucher_no: event.rows[0].voucher_no,
        voucher_date: event.rows[0].voucher_date,
        note: `this sale posted ${event.rows.length} ledger rows split across buckets under a prior buggy version; all rows have been retagged onto the declared bucket (${declared ? "PACKED" : "LOOSE"}) and stock_balance_sku recomputed -- logged for audit, no manual action needed`,
      });
    }
  }

  return { sim, safeRetags, needsReview };
};

const run = async () => {
  console.log(`[fix-sales-sku-bucket-routing] mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  const buckets = await loadCandidateBuckets();
  console.log(`[fix-sales-sku-bucket-routing] candidate sku buckets: ${buckets.length}`);

  const balanceUpdates = [];
  const auditRows = [];
  const ledgerRetags = [];
  const reviewRows = [];

  for (const bucket of buckets) {
    const branchId = Number(bucket.branch_id);
    const category = bucket.category;
    const skuId = Number(bucket.sku_id);
    const history = await loadBucketLedgerHistory({ branchId, category, skuId });
    if (!history.length) continue;

    const { sim, safeRetags, needsReview } = simulateBucket(history);

    for (const retag of safeRetags) {
      ledgerRetags.push({ ...retag, branch_id: branchId, sku_id: skuId });
    }
    for (const review of needsReview) {
      reviewRows.push({ ...review, branch_id: branchId, sku_id: skuId });
    }

    const skuRow = await knex("erp.skus").select("sku_code").where({ id: skuId }).first();
    const subjectLabel = skuRow?.sku_code ? skuRow.sku_code : `SKU #${skuId}`;

    for (const isPackedFlag of ["false", "true"]) {
      const isPacked = isPackedFlag === "true";
      const correctQty = roundQty(sim[isPackedFlag].qty);
      const correctValue = roundCost2(sim[isPackedFlag].value);
      const correctWac = computeNonNegativeWac(correctQty, correctValue);

      const current = await knex("erp.stock_balance_sku")
        .select("qty_pairs", "value", "wac")
        .where({
          branch_id: branchId,
          stock_state: "ON_HAND",
          category,
          is_packed: isPacked,
          sku_id: skuId,
        })
        .first();

      const currentQty = Number(current?.qty_pairs || 0);
      const currentValue = Number(current?.value || 0);
      const currentWac = Number(current?.wac || 0);

      if (!current && correctQty === 0 && correctValue === 0) continue;
      const qtyDiff = Math.abs(currentQty - correctQty);
      const valueDiff = Math.abs(currentValue - correctValue);
      if (qtyDiff < 1 && valueDiff < 0.01) continue;

      balanceUpdates.push({
        branch_id: branchId,
        stock_state: "ON_HAND",
        category,
        is_packed: isPacked,
        sku_id: skuId,
        exists: Boolean(current),
        qty_pairs: correctQty,
        value: correctValue,
        wac: correctWac,
      });
      auditRows.push({
        branch_id: branchId,
        sku_id: skuId,
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

  if (!balanceUpdates.length && !ledgerRetags.length && !reviewRows.length) {
    console.log("[fix-sales-sku-bucket-routing] nothing to correct.");
    await knex.destroy();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = APPLY ? "" : "-dryrun";

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
  const csvPath = path.resolve(process.cwd(), `sales-sku-bucket-fix-${stamp}${suffix}.csv`);
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`, "utf8");

  let reviewCsvPath = null;
  if (reviewRows.length) {
    const reviewHeader = "branch_id,sku_id,voucher_no,voucher_date,reason,note";
    const reviewBody = reviewRows
      .map((r) =>
        [r.branch_id, r.sku_id, r.voucher_no, r.voucher_date, r.reason, `"${r.note.replace(/"/g, '""')}"`].join(","),
      )
      .join("\n");
    reviewCsvPath = path.resolve(process.cwd(), `sales-sku-bucket-fix-review-${stamp}${suffix}.csv`);
    fs.writeFileSync(reviewCsvPath, `${reviewHeader}\n${reviewBody}\n`, "utf8");
  }

  console.log(`[fix-sales-sku-bucket-routing] balance rows to correct: ${balanceUpdates.length}`);
  console.log(`[fix-sales-sku-bucket-routing] ledger rows to re-tag: ${ledgerRetags.length}`);
  console.log(`[fix-sales-sku-bucket-routing] legacy split events auto-consolidated (logged for audit): ${reviewRows.length}`);
  console.log(`[fix-sales-sku-bucket-routing] audit CSV: ${csvPath}`);
  if (reviewCsvPath) console.log(`[fix-sales-sku-bucket-routing] review CSV: ${reviewCsvPath}`);
  for (const r of auditRows) {
    console.log(
      `  branch ${r.branch_id} ${r.sku_code} is_packed=${r.is_packed}: qty ${r.old_qty_pairs}->${r.new_qty_pairs}, value ${r.old_value.toFixed(2)}->${r.new_value.toFixed(2)}, wac ${r.old_wac.toFixed(2)}->${r.new_wac.toFixed(2)}`,
    );
  }
  for (const r of ledgerRetags) {
    console.log(`  ledger #${r.id} (SKU ${r.sku_id}, branch ${r.branch_id}): is_packed ${r.from_is_packed} -> ${r.to_is_packed}`);
  }
  for (const r of reviewRows) {
    console.log(`  REVIEW branch ${r.branch_id} SKU ${r.sku_id} voucher #${r.voucher_no} ${r.voucher_date}: ${r.note}`);
  }

  if (!APPLY) {
    console.log("[fix-sales-sku-bucket-routing] DRY RUN — no changes written. Re-run with --apply to commit.");
    await knex.destroy();
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
    for (const retag of ledgerRetags) {
      await trx("erp.stock_ledger").where({ id: retag.id }).update({ is_packed: retag.to_is_packed });
    }
  });

  console.log("[fix-sales-sku-bucket-routing] changes committed.");
  await knex.destroy();
};

run()
  .then(async () => {
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[fix-sales-sku-bucket-routing] failed:", err);
    try {
      await knex.destroy();
    } catch (e) {}
    process.exit(1);
  });
