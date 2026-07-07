// Read-only audit: finds STOCK_COUNT_ADJ (Physical Count Correction) voucher
// lines whose STORED "System Qty" snapshot disagrees with what a correct
// point-in-time recomputation gives (as of the exact moment this voucher was
// last saved, excluding only that voucher's own posted contribution).
//
// Why this is needed: a bug (fixed 2026-07-07 in inventory-voucher-service.js)
// let editing a correction voucher compute "System Qty" against a baseline
// still polluted by that same voucher's own prior save. The code fix stops
// this going forward, but any voucher that was edited more than once *before*
// the fix may already have a wrong stored snapshot -- and, more importantly,
// the diff computed from that wrong snapshot is what actually got posted to
// the stock ledger, so the live stock balance for that item/SKU may still be
// off by the same amount today. This script only reports drift; it does not
// write anything.
//
// Precision note: "as of" boundaries use erp.voucher_header.created_at /
// erp.activity_log timestamps (not voucher_date), so two vouchers dated the
// same calendar day are still ordered correctly relative to each other --
// voucher_date alone is too coarse and would flag same-day siblings as false
// drift. The one residual gap: if an "other" contributing voucher was ITSELF
// edited after this voucher's last save, its stock_ledger rows only reflect
// its latest edit (editing deletes and reposts ledger rows, so intermediate
// history isn't retained) -- there's no way to recover its exact state as of
// an earlier timestamp from current data alone. This is rare but means a
// flagged delta should still be sanity-checked against real context before
// acting on it, especially for high-value lines.
//
// Usage (from backend/):
//   node src/scripts/audit-stock-count-system-qty-drift.js
//   node src/scripts/audit-stock-count-system-qty-drift.js --branch-id=1
//   node src/scripts/audit-stock-count-system-qty-drift.js --from-date=2026-01-01 --to-date=2026-07-07
const fs = require("fs");
const path = require("path");
const knex = require("../db/knex");

const FG_PACKED_FLAG_SQL = `
CASE
  WHEN sln.is_packed IS NOT NULL THEN sln.is_packed
  WHEN pl.is_packed IS NOT NULL THEN pl.is_packed
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'PACKED' THEN true
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'LOOSE' THEN false
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('true','t','1','yes') THEN true
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('false','f','0','no') THEN false
  ELSE false
END`;

const getArg = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=").trim() : null;
};

const branchIdFilter = (() => {
  const raw = getArg("branch-id");
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
})();
const fromDate = getArg("from-date");
const toDate = getArg("to-date");
// The self-pollution bug can only affect a voucher that was actually EDITED
// after its first save (a fresh create has no prior effect to pollute with).
// Default to edited-only so the report stays focused on vouchers that could
// actually have this bug.
const includeUnedited = process.argv.includes("--include-unedited");

const roundQty3 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 1000) / 1000;
const toNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const hasColumn = async (table, column) => {
  const row = await knex("information_schema.columns")
    .select("column_name")
    .where({ table_schema: "erp", table_name: table, column_name: column })
    .first();
  return Boolean(row);
};

// Mirrors loadRmSystemSnapshotByKeyTx's exclusion math, but point-in-time
// (as of the exact timestamp this voucher was last saved) rather than
// "live" -- ledger-sum based, same technique already used for FG/SFG in the
// main service. Timestamp (not voucher_date) so same-day vouchers are still
// ordered correctly relative to each other.
const computeTrueRmSystemQty = async ({
  branchId,
  itemId,
  colorId,
  sizeId,
  asOfTimestamp,
  excludeVoucherId,
  hasVariantDimensions,
}) => {
  let query = knex("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .select(
      knex.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty, 0) ELSE -COALESCE(sl.qty, 0) END), 0) as qty",
      ),
    )
    .where({
      "sl.branch_id": branchId,
      "sl.stock_state": "ON_HAND",
      "sl.category": "RM",
      "sl.item_id": itemId,
    })
    .andWhere("vh.created_at", "<=", asOfTimestamp)
    .andWhere("sl.voucher_header_id", "!=", excludeVoucherId);
  if (hasVariantDimensions) {
    query = query
      .andWhere((qb) => {
        if (colorId) qb.where("sl.color_id", colorId);
        else qb.whereNull("sl.color_id");
      })
      .andWhere((qb) => {
        if (sizeId) qb.where("sl.size_id", sizeId);
        else qb.whereNull("sl.size_id");
      });
  }
  const row = await query.first();
  return roundQty3(row?.qty || 0);
};

// Current WAC (unit cost), for a defensible value-impact estimate -- vl.rate
// on these lines is the SKU's SALE rate (see validateStockCountAdjustmentPayloadTx
// in inventory-voucher-service.js), not cost, so using it would overstate
// financial exposure by the retail markup.
const getRmUnitCost = async ({ branchId, itemId, colorId, sizeId, hasVariantDimensions }) => {
  let query = knex("erp.stock_balance_rm as sb")
    .select("sb.wac")
    .where({ "sb.branch_id": branchId, "sb.stock_state": "ON_HAND", "sb.item_id": itemId });
  if (hasVariantDimensions) {
    query = query
      .andWhere((qb) => {
        if (colorId) qb.where("sb.color_id", colorId);
        else qb.whereNull("sb.color_id");
      })
      .andWhere((qb) => {
        if (sizeId) qb.where("sb.size_id", sizeId);
        else qb.whereNull("sb.size_id");
      });
  }
  const row = await query.first();
  return toNumber(row?.wac, 0);
};

const getFgUnitCost = async ({ branchId, skuId, stockType, isPacked }) => {
  const row = await knex("erp.stock_balance_sku")
    .select("wac")
    .where({
      branch_id: branchId,
      stock_state: "ON_HAND",
      category: stockType,
      is_packed: isPacked,
      sku_id: skuId,
    })
    .first();
  return toNumber(row?.wac, 0);
};

const computeTrueFgSystemQtyPairs = async ({
  branchId,
  skuId,
  isPacked,
  asOfTimestamp,
  excludeVoucherId,
}) => {
  const row = await knex("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .select(
      knex.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END), 0) as qty_pairs",
      ),
    )
    .where({
      "sl.branch_id": branchId,
      "sl.stock_state": "ON_HAND",
      "sl.sku_id": skuId,
    })
    .whereIn("sl.category", ["FG", "SFG"])
    .whereRaw(`${FG_PACKED_FLAG_SQL} = ?`, [isPacked])
    .andWhere("vh.created_at", "<=", asOfTimestamp)
    .andWhere("sl.voucher_header_id", "!=", excludeVoucherId)
    .first();
  return roundQty3(row?.qty_pairs || 0);
};

const run = async () => {
  console.log(
    `[audit-stock-count-drift] scanning STOCK_COUNT_ADJ vouchers` +
      (branchIdFilter ? `, branch_id=${branchIdFilter}` : "") +
      (fromDate ? `, from=${fromDate}` : "") +
      (toDate ? `, to=${toDate}` : ""),
  );

  const hasRmVariantDims =
    (await hasColumn("stock_ledger", "color_id")) &&
    (await hasColumn("stock_ledger", "size_id"));

  let voucherQuery = knex("erp.voucher_header as vh")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.branch_id",
      "vh.created_at",
      knex.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
    )
    .where({ voucher_type_code: "STOCK_COUNT_ADJ", status: "APPROVED" })
    .orderBy("vh.id", "asc");
  if (branchIdFilter) voucherQuery = voucherQuery.andWhere("vh.branch_id", branchIdFilter);
  if (fromDate) voucherQuery = voucherQuery.andWhere("vh.voucher_date", ">=", fromDate);
  if (toDate) voucherQuery = voucherQuery.andWhere("vh.voucher_date", "<=", toDate);

  let vouchers = await voucherQuery;
  console.log(`[audit-stock-count-drift] approved vouchers in scope: ${vouchers.length}`);

  if (!includeUnedited) {
    const editedRows = await knex("erp.activity_log")
      .distinct("entity_id")
      .where({
        entity_type: "VOUCHER",
        voucher_type_code: "STOCK_COUNT_ADJ",
        action: "UPDATE",
      });
    const editedIds = new Set(editedRows.map((r) => Number(r.entity_id)));
    vouchers = vouchers.filter((v) => editedIds.has(Number(v.id)));
    console.log(
      `[audit-stock-count-drift] restricting to vouchers with at least one edit: ${vouchers.length} (pass --include-unedited to check all)`,
    );
  }

  const drifted = [];
  let checked = 0;

  for (const voucher of vouchers) {
    const lastEditRow = await knex("erp.activity_log")
      .select("created_at")
      .where({
        entity_type: "VOUCHER",
        entity_id: String(voucher.id),
        voucher_type_code: "STOCK_COUNT_ADJ",
        action: "UPDATE",
      })
      .orderBy("created_at", "desc")
      .first();
    const asOfTimestamp = lastEditRow?.created_at || voucher.created_at;

    const lines = await knex("erp.voucher_line as vl")
      .leftJoin("erp.stock_count_line as scl", "scl.voucher_line_id", "vl.id")
      .select(
        "vl.id",
        "vl.line_kind",
        "vl.item_id",
        "vl.sku_id",
        "vl.meta",
        "vl.rate",
        "scl.system_qty_snapshot",
        "scl.system_qty_pairs_snapshot",
      )
      .where({ "vl.voucher_header_id": voucher.id });

    for (const line of lines) {
      const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
      const lineKind = String(line?.line_kind || "").toUpperCase();
      const stockType =
        String(meta.stock_type || "").toUpperCase() ||
        (lineKind === "ITEM" ? "RM" : lineKind === "SKU" ? "FG" : null);
      if (!stockType) continue;
      checked += 1;

      if (stockType === "RM") {
        const itemId = Number(line.item_id || 0);
        if (!itemId) continue;
        const colorId = Number(meta.color_id || 0) || null;
        const sizeId = Number(meta.size_id || 0) || null;
        const stored = roundQty3(line.system_qty_snapshot || 0);
        const trueQty = await computeTrueRmSystemQty({
          branchId: Number(voucher.branch_id),
          itemId,
          colorId,
          sizeId,
          asOfTimestamp,
          excludeVoucherId: voucher.id,
          hasVariantDimensions: hasRmVariantDims,
        });
        const delta = roundQty3(stored - trueQty);
        if (Math.abs(delta) >= 0.005) {
          const unitCost = await getRmUnitCost({
            branchId: Number(voucher.branch_id),
            itemId,
            colorId,
            sizeId,
            hasVariantDimensions: hasRmVariantDims,
          });
          drifted.push({
            voucher_id: voucher.id,
            voucher_no: voucher.voucher_no,
            voucher_date: voucher.voucher_date,
            branch_id: voucher.branch_id,
            stock_type: "RM",
            key: `item ${itemId}${colorId ? ` color ${colorId}` : ""}${sizeId ? ` size ${sizeId}` : ""}`,
            stored_system_qty: stored,
            true_system_qty: trueQty,
            delta,
            sale_rate: toNumber(line.rate, 0),
            unit_cost: unitCost,
            est_cost_impact: roundQty3(delta * unitCost),
          });
        }
        continue;
      }

      if (stockType === "FG" || stockType === "SFG") {
        const skuId = Number(line.sku_id || 0);
        if (!skuId) continue;
        const isPacked =
          String(meta.row_status || "").toUpperCase() === "PACKED";
        const stored = roundQty3(line.system_qty_pairs_snapshot || 0);
        const trueQtyPairs = await computeTrueFgSystemQtyPairs({
          branchId: Number(voucher.branch_id),
          skuId,
          isPacked,
          asOfTimestamp,
          excludeVoucherId: voucher.id,
        });
        const delta = roundQty3(stored - trueQtyPairs);
        if (Math.abs(delta) >= 0.005) {
          const unitCost = await getFgUnitCost({
            branchId: Number(voucher.branch_id),
            skuId,
            stockType,
            isPacked,
          });
          drifted.push({
            voucher_id: voucher.id,
            voucher_no: voucher.voucher_no,
            voucher_date: voucher.voucher_date,
            branch_id: voucher.branch_id,
            stock_type: `${stockType}${isPacked ? " (PACKED)" : " (LOOSE)"}`,
            key: `sku ${skuId}`,
            stored_system_qty: stored,
            true_system_qty: trueQtyPairs,
            delta,
            sale_rate: toNumber(line.rate, 0),
            unit_cost: unitCost,
            est_cost_impact: roundQty3(delta * unitCost),
          });
        }
      }
    }
  }

  console.log(`[audit-stock-count-drift] lines checked: ${checked}`);
  console.log(`[audit-stock-count-drift] lines with drift: ${drifted.length}`);

  if (!drifted.length) {
    console.log("[audit-stock-count-drift] no drift found.");
    await knex.destroy();
    return;
  }

  const csvHeader =
    "voucher_id,voucher_no,voucher_date,branch_id,stock_type,key,stored_system_qty,true_system_qty,delta,sale_rate,unit_cost,est_cost_impact";
  const csvBody = drifted
    .map((r) =>
      [
        r.voucher_id,
        r.voucher_no,
        r.voucher_date,
        r.branch_id,
        r.stock_type,
        `"${r.key}"`,
        r.stored_system_qty,
        r.true_system_qty,
        r.delta,
        r.sale_rate,
        r.unit_cost,
        r.est_cost_impact,
      ].join(","),
    )
    .join("\n");
  const csvPath = path.resolve(
    process.cwd(),
    `stock-count-drift-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
  );
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`, "utf8");

  const totalCostImpact = roundQty3(
    drifted.reduce((sum, r) => sum + toNumber(r.est_cost_impact, 0), 0),
  );
  console.log(
    `[audit-stock-count-drift] total estimated COST impact (at unit cost, not sale rate): ${totalCostImpact.toFixed(2)}`,
  );
  console.log(`[audit-stock-count-drift] report CSV: ${csvPath}`);
  drifted.slice(0, 25).forEach((r) => {
    console.log(
      `  voucher #${r.voucher_no} (${r.voucher_date}, branch ${r.branch_id}) ${r.stock_type} ${r.key}: stored=${r.stored_system_qty} true=${r.true_system_qty} delta=${r.delta} cost_impact=${r.est_cost_impact}`,
    );
  });
  if (drifted.length > 25) {
    console.log(`  ... and ${drifted.length - 25} more (see CSV)`);
  }

  await knex.destroy();
};

run()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("[audit-stock-count-drift] failed:", err);
    try {
      await knex.destroy();
    } catch (e) {}
    process.exit(1);
  });
