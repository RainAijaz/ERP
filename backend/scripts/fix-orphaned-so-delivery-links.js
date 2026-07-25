"use strict";

/*
 * fix-orphaned-so-delivery-links.js
 *
 * Repairs sales-order deliveries whose line-level link was orphaned when the
 * sales order was edited BEFORE the reconcile fix (d6229fa) went live. Editing an
 * approved SO used to delete + reinsert its voucher_line rows with fresh ids, so
 * every delivery still pointed at a now-dead meta.sales_order_line_id. The join in
 * loadOpenSalesOrderLinesTx then finds 0 delivered and the order reads fully open.
 *
 * The header-level link (erp.sales_header.linked_sales_order_id -> SO header id)
 * is NOT orphaned by an edit, so we use it to find each delivery's true SO, then
 * re-point each delivery SALE line's meta.sales_order_line_id to the CURRENT live
 * SO line that carries the same sku. We only re-point a line whose current target
 * is not a live SO line, and only when exactly one live SO line has that sku
 * (matching the reconcile fix's own 1:1 safety rule). Ambiguous (>1 live line same
 * sku) and unresolvable (sku no longer on the SO) cases are REPORTED, never
 * guessed — a wrong re-point would silently mis-attribute deliveries.
 *
 * Usage:
 *   node scripts/fix-orphaned-so-delivery-links.js                 # dry-run, all orders
 *   node scripts/fix-orphaned-so-delivery-links.js --so 925        # dry-run, one SO header id
 *   node scripts/fix-orphaned-so-delivery-links.js --branch 207    # dry-run, one branch
 *   node scripts/fix-orphaned-so-delivery-links.js --apply         # COMMIT the fixes
 *
 * Flags combine, e.g.  --so 925 --apply
 */

const knex = require("../src/db/knex");

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const APPLY = hasFlag("--apply");
const ONLY_SO = flagVal("--so") ? Number(flagVal("--so")) : null;
const ONLY_BRANCH = flagVal("--branch") ? Number(flagVal("--branch")) : null;

const asInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

async function getMetaColumnType() {
  const row = await knex("information_schema.columns")
    .select("data_type")
    .where({ table_schema: "erp", table_name: "voucher_line", column_name: "meta" })
    .first();
  return row && row.data_type ? String(row.data_type) : "jsonb";
}

async function loadLiveSoLines() {
  // sku -> [lineIds] and a flat set of live ids, per SO header id
  let q = knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .where({
      "vh.voucher_type_code": "SALES_ORDER",
      "vh.status": "APPROVED",
      "vl.line_kind": "SKU",
    })
    .select("vh.id as so_id", "vl.id as line_id", "vl.sku_id");
  if (ONLY_SO) q = q.where("vh.id", ONLY_SO);
  if (ONLY_BRANCH) q = q.where("vh.branch_id", ONLY_BRANCH);

  const rows = await q;
  const bySo = new Map();
  for (const r of rows) {
    const soId = Number(r.so_id);
    if (!bySo.has(soId)) bySo.set(soId, { liveIds: new Set(), bySku: new Map() });
    const entry = bySo.get(soId);
    entry.liveIds.add(Number(r.line_id));
    const sku = Number(r.sku_id);
    if (!entry.bySku.has(sku)) entry.bySku.set(sku, []);
    entry.bySku.get(sku).push(Number(r.line_id));
  }
  return bySo;
}

async function loadDeliveryLines() {
  // Every non-rejected SALE delivery line, attributed to its SO via the durable
  // header link (sales_header.linked_sales_order_id).
  let q = knex("erp.sales_header as sh")
    .join("erp.voucher_header as svh", "svh.id", "sh.voucher_id")
    .join("erp.voucher_line as svl", "svl.voucher_header_id", "svh.id")
    .where({
      "svh.voucher_type_code": "SALES_VOUCHER",
      "svl.line_kind": "SKU",
    })
    .whereNot("svh.status", "REJECTED")
    .whereRaw("coalesce(svl.meta->>'movement_kind', '') = 'SALE'")
    .whereNotNull("sh.linked_sales_order_id")
    .select(
      "svl.id as delivery_line_id",
      "svl.sku_id",
      "svl.meta",
      knex.raw("svl.meta->>'sales_order_line_id' as current_so_line_id"),
      "sh.linked_sales_order_id as so_id",
      "svh.voucher_no",
      "svh.branch_id",
    );
  if (ONLY_SO) q = q.where("sh.linked_sales_order_id", ONLY_SO);
  if (ONLY_BRANCH) q = q.where("svh.branch_id", ONLY_BRANCH);
  return q;
}

async function main() {
  const metaType = await getMetaColumnType();
  const [liveBySo, deliveries] = await Promise.all([
    loadLiveSoLines(),
    loadDeliveryLines(),
  ]);

  const plan = []; // { delivery_line_id, so_id, voucher_no, branch_id, sku_id, from, to }
  const ambiguous = [];
  const unresolvable = [];
  let alreadyOk = 0;

  for (const d of deliveries) {
    const soId = Number(d.so_id);
    const live = liveBySo.get(soId);
    if (!live) {
      // SO not APPROVED / not in scope — can't attribute safely.
      unresolvable.push({ ...d, reason: "SO not found or not APPROVED" });
      continue;
    }
    const current = asInt(d.current_so_line_id);
    if (current && live.liveIds.has(current)) {
      alreadyOk += 1; // link already points at a live line — nothing to do
      continue;
    }
    const candidates = live.bySku.get(Number(d.sku_id)) || [];
    if (candidates.length === 1) {
      plan.push({
        delivery_line_id: Number(d.delivery_line_id),
        so_id: soId,
        voucher_no: d.voucher_no,
        branch_id: d.branch_id,
        sku_id: Number(d.sku_id),
        from: current || "(none)",
        to: candidates[0],
      });
    } else if (candidates.length === 0) {
      unresolvable.push({ ...d, reason: "sku no longer on this SO" });
    } else {
      ambiguous.push({ ...d, reason: `sku on ${candidates.length} live SO lines` });
    }
  }

  console.log(`\n=== Orphaned SO delivery-link backfill (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
  if (ONLY_SO) console.log(`Scope: SO header id ${ONLY_SO}`);
  if (ONLY_BRANCH) console.log(`Scope: branch ${ONLY_BRANCH}`);
  console.log(`Delivery SALE lines scanned : ${deliveries.length}`);
  console.log(`Already correctly linked    : ${alreadyOk}`);
  console.log(`Will re-point (fixable)     : ${plan.length}`);
  console.log(`Ambiguous (skipped)         : ${ambiguous.length}`);
  console.log(`Unresolvable (skipped)      : ${unresolvable.length}`);

  if (plan.length) {
    console.log(`\n--- Re-point plan ---`);
    for (const p of plan) {
      console.log(
        `SO ${p.so_id} (br ${p.branch_id}) SV#${p.voucher_no} line ${p.delivery_line_id} sku ${p.sku_id}: ${p.from} -> ${p.to}`,
      );
    }
  }
  if (ambiguous.length) {
    console.log(`\n--- AMBIGUOUS (needs manual review) ---`);
    for (const a of ambiguous)
      console.log(`SO ${a.so_id} SV#${a.voucher_no} line ${a.delivery_line_id} sku ${a.sku_id}: ${a.reason}`);
  }
  if (unresolvable.length) {
    console.log(`\n--- UNRESOLVABLE (needs manual review) ---`);
    for (const u of unresolvable)
      console.log(`SO ${u.so_id} SV#${u.voucher_no} line ${u.delivery_line_id} sku ${u.sku_id}: ${u.reason}`);
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN only — no rows changed. Re-run with --apply to commit.`);
    return;
  }
  if (!plan.length) {
    console.log(`\nNothing to apply.`);
    return;
  }

  await knex.transaction(async (trx) => {
    for (const p of plan) {
      const setExpr =
        metaType === "json"
          ? "jsonb_set(meta::jsonb, '{sales_order_line_id}', to_jsonb(?::bigint))::json"
          : "jsonb_set(meta::jsonb, '{sales_order_line_id}', to_jsonb(?::bigint))";
      await trx("erp.voucher_line")
        .where({ id: p.delivery_line_id })
        .update({ meta: trx.raw(setExpr, [p.to]) });
    }
  });
  console.log(`\nAPPLIED ${plan.length} re-point(s). Verify the order's Open Qty now reflects deliveries.`);
}

main()
  .then(() => knex.destroy())
  .catch(async (err) => {
    console.error(err);
    await knex.destroy();
    process.exitCode = 1;
  });
