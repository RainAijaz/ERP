// Read-only audit: finds STOCK_COUNT_ADJ (Physical Count Correction) voucher
// lines whose STORED "System Qty" snapshot disagrees with what a correct
// point-in-time recomputation gives (as of the voucher's own date, excluding
// only that voucher's own posted contribution).
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
// Default to edited-only to avoid false positives from same-day sibling
// vouchers touching the same item/SKU, which the voucher_date-scoped
// recompute below can't otherwise distinguish from genuine self-pollution.
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
// (as of a given voucher date) rather than "live" -- ledger-sum based, same
// technique already used for FG/SFG in the main service.
const computeTrueRmSystemQty = async ({
  branchId,
  itemId,
  colorId,
  sizeId,
  asOfDate,
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
    .andWhere("vh.voucher_date", "<=", asOfDate)
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

const computeTrueFgSystemQtyPairs = async ({
  branchId,
  skuId,
  isPacked,
  asOfDate,
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
    .andWhere("vh.voucher_date", "<=", asOfDate)
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
          asOfDate: voucher.voucher_date,
          excludeVoucherId: voucher.id,
          hasVariantDimensions: hasRmVariantDims,
        });
        const delta = roundQty3(stored - trueQty);
        if (Math.abs(delta) >= 0.005) {
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
            rate: toNumber(line.rate, 0),
            est_value_impact: roundQty3(delta * toNumber(line.rate, 0)),
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
          asOfDate: voucher.voucher_date,
          excludeVoucherId: voucher.id,
        });
        const delta = roundQty3(stored - trueQtyPairs);
        if (Math.abs(delta) >= 0.005) {
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
            rate: toNumber(line.rate, 0),
            est_value_impact: roundQty3(delta * toNumber(line.rate, 0)),
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
    "voucher_id,voucher_no,voucher_date,branch_id,stock_type,key,stored_system_qty,true_system_qty,delta,rate,est_value_impact";
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
        r.rate,
        r.est_value_impact,
      ].join(","),
    )
    .join("\n");
  const csvPath = path.resolve(
    process.cwd(),
    `stock-count-drift-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
  );
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`, "utf8");

  const totalValueImpact = roundQty3(
    drifted.reduce((sum, r) => sum + toNumber(r.est_value_impact, 0), 0),
  );
  console.log(`[audit-stock-count-drift] total estimated value impact: ${totalValueImpact.toFixed(2)}`);
  console.log(`[audit-stock-count-drift] report CSV: ${csvPath}`);
  drifted.slice(0, 25).forEach((r) => {
    console.log(
      `  voucher #${r.voucher_no} (${r.voucher_date}, branch ${r.branch_id}) ${r.stock_type} ${r.key}: stored=${r.stored_system_qty} true=${r.true_system_qty} delta=${r.delta}`,
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
