// rm-uom-stock-conversion.js
// Purpose: Re-express an RM item's existing stock when its base unit of measure
// changes. Stock quantities (stock_balance_rm.qty, stock_ledger.qty) carry no
// uom_id of their own, so switching an item's base_uom_id silently reinterprets
// every stored number. This helper converts those numbers using an active
// erp.uom_conversions rule so the change is safe instead of blocked.
//
// Invariants preserved (matching how inventory posting maintains balances):
//   - Monetary `value` is the accumulator of record and stays UNCHANGED — a KG
//     of stock is worth the same whether we call it 1 KG or 1000 g.
//   - qty is scaled by the conversion multiplier k (qty_new = qty * k).
//   - Per-unit cost is scaled by 1/k so value = qty * cost still holds:
//       * stock_balance_rm.wac  -> recomputed as value / qty_new (0 when qty≈0),
//         mirroring computeNonNegativeWac() in inventory-voucher-service.js.
//       * stock_ledger.unit_cost -> scaled by 1/k.
//
// factor semantics (erp.uom_conversions): a row (from_uom_id -> to_uom_id, factor)
// means 1 from-unit = `factor` to-units, i.e. qty_to = qty_from * factor.

"use strict";

/**
 * Resolve the multiplier k such that a quantity expressed in `fromUomId` becomes
 * `qty * k` when expressed in `toUomId`, using active conversion rules in either
 * direction. Returns null when no active rule connects the two units.
 *
 * @param {import("knex").Knex | import("knex").Knex.Transaction} db
 * @param {number} fromUomId  the item's current (old) base uom
 * @param {number} toUomId    the item's new base uom
 * @returns {Promise<number|null>}
 */
async function getUomConversionMultiplier(db, fromUomId, toUomId) {
  const from = Number(fromUomId);
  const to = Number(toUomId);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    return null;
  }
  if (from === to) return 1;

  // Direct rule: 1 from-unit = factor to-units  ->  qty_to = qty_from * factor
  const direct = await db("erp.uom_conversions")
    .select("factor")
    .where({ from_uom_id: from, to_uom_id: to, is_active: true })
    .first();
  if (direct && Number(direct.factor) > 0) return Number(direct.factor);

  // Reverse rule: 1 to-unit = factor from-units -> qty_to = qty_from / factor
  const reverse = await db("erp.uom_conversions")
    .select("factor")
    .where({ from_uom_id: to, to_uom_id: from, is_active: true })
    .first();
  if (reverse && Number(reverse.factor) > 0) return 1 / Number(reverse.factor);

  return null;
}

/**
 * Convert all stored stock for an RM item from `oldUomId` to `newUomId`.
 * Updates every stock_balance_rm row (all branches / stock states / variants)
 * and every RM stock_ledger row for the item. `value` is left untouched.
 *
 * @param {import("knex").Knex.Transaction} trx  MUST be a transaction — the
 *   caller writes items.base_uom_id in the same unit of work.
 * @param {number} itemId
 * @param {number} oldUomId
 * @param {number} newUomId
 * @returns {Promise<{ converted: boolean, multiplier: number|null }>}
 *   converted:false means no active conversion rule exists — the caller should
 *   block the UOM change rather than corrupt the numbers.
 */
async function convertRmStockUom(trx, itemId, oldUomId, newUomId) {
  const item = Number(itemId);
  const k = await getUomConversionMultiplier(trx, oldUomId, newUomId);
  if (k === null || !(k > 0)) {
    return { converted: false, multiplier: null };
  }
  // Same unit (or an identity rule): nothing to re-express.
  if (k === 1) return { converted: true, multiplier: 1 };

  // Running balances: qty *= k, value fixed, wac = value / qty_new (0 when qty≈0).
  await trx("erp.stock_balance_rm")
    .where({ item_id: item })
    .update({
      qty: trx.raw("ROUND(qty * ?::numeric, 3)", [k]),
      wac: trx.raw(
        "CASE WHEN ROUND(qty * ?::numeric, 3) <= 0.0005 THEN 0 " +
          "ELSE ROUND(value / ROUND(qty * ?::numeric, 3), 6) END",
        [k, k],
      ),
    });

  // Ledger movements: qty *= k, unit_cost /= k, value fixed.
  await trx("erp.stock_ledger")
    .where({ item_id: item, category: "RM" })
    .update({
      qty: trx.raw("ROUND(qty * ?::numeric, 3)", [k]),
      unit_cost: trx.raw("ROUND(unit_cost / ?::numeric, 6)", [k]),
    });

  return { converted: true, multiplier: k };
}

module.exports = { getUomConversionMultiplier, convertRmStockUom };
