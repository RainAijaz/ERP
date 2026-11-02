const { HttpError } = require("../../middleware/errors/http-error");
const { resolveStockUnitCost } = require("../../utils/stock-cost");
const {
  loadBomProfileBySkuTx,
  buildConsumptionLinesFromShortfall,
  buildLabourLinesFromShortfall,
  buildSfgRequirementsForStage,
  enrichConsumptionLinesWithRmRatesTx,
} = require("../production/production-voucher-service");

const invalidCost = () => new HttpError(409, "sfg_bom_cost_incomplete");

// An approved BOM is a documented STANDARD cost for new movements whose stock
// has never been valued. It is not a retroactive replacement for receipt costs.
// Keep the calculation and its inputs on the voucher for approval and audit.
const resolveBomStockCostTx = async ({ trx, branchId, skuId, path = [] }) => {
  try {
    skuId = Number(skuId);
    if (!Number.isSafeInteger(skuId) || skuId <= 0 || path.includes(skuId) || path.length >= 15) {
      throw invalidCost();
    }
    const profile = await loadBomProfileBySkuTx({ trx, skuId });
    if (!profile) return null;
    const pairs = Number(profile.outputQty) * Number(profile.outputUomFactorToPair);
    if (!Number.isInteger(pairs) || pairs <= 0) throw invalidCost();
    const departments = [...new Set([...profile.rmLines, ...profile.labourLines].map(row => row.dept_id))];
    const shortfallPlan = departments.map(dept_id => ({ dept_id, shortfall_pairs: pairs }));
    const materialLines = buildConsumptionLinesFromShortfall({
      skuLine: { sku_id: skuId }, shortfallPlan, bomProfile: profile,
    });
    const pricedMaterials = await enrichConsumptionLinesWithRmRatesTx({ trx, lines: materialLines });
    const materials = [];
    let materialCost = 0;
    for (const line of pricedMaterials) {
      if (!Number.isFinite(line.rate) || !(line.rate > 0)) throw invalidCost();
      const cost = Number(line.qty) * Number(line.rate);
      if (!Number.isFinite(cost) || cost < 0) throw invalidCost();
      materialCost += cost;
      materials.push({ item_id: line.item_id, color_id: line.meta.rm_color_id, size_id: line.meta.rm_size_id,
        qty: line.qty, uom_id: line.uom_id, bom_qty: line.meta.bom_consumption_qty,
        bom_uom_id: line.meta.bom_consumption_uom_id, factor_to_base: line.meta.consumption_factor_to_base,
        rate: line.rate, cost });
    }
    const labourLines = buildLabourLinesFromShortfall({
      skuLine: { sku_id: skuId }, shortfallPlan, bomProfile: profile, roundCosts: false,
    });
    if (profile.labourLines.some(line => !Number.isFinite(line.rate_value) || line.rate_value < 0 || !["PER_PAIR", "PER_DOZEN"].includes(line.rate_type))) {
      throw invalidCost();
    }
    const labourCost = labourLines.reduce((sum, line) => sum + line.amount, 0);
    const components = [];
    let componentCost = 0;
    // Reuse production's exact-SKU/size and whole-pair requirement validation.
    const stageIds = [...new Set(profile.sfgLines.map(row => row.consumed_in_stage_id))];
    for (const stageId of stageIds) {
      const requirements = buildSfgRequirementsForStage({ bomProfile: profile, stageId, producedPairs: pairs });
      for (const line of requirements) {
        const quantity = Number(line.required_pairs);
        if (!Number.isFinite(quantity) || !(quantity > 0)) throw invalidCost();
        const pool = await trx("erp.stock_ledger").where({ branch_id: branchId, sku_id: line.sfg_sku_id, category: "SFG", stock_state: "ON_HAND" })
          .sum({ value: "value" }).select(trx.raw("coalesce(sum(direction * qty_pairs), 0) as qty")).first();
        const receipt = await trx("erp.stock_ledger as sl").join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
          .where({ "sl.branch_id": branchId, "sl.sku_id": line.sfg_sku_id, "sl.category": "SFG", "sl.stock_state": "ON_HAND", "sl.direction": 1, "vh.status": "APPROVED" })
          .where("sl.unit_cost", ">", 0).orderBy("sl.txn_date", "desc").orderBy("sl.id", "desc").select("sl.unit_cost").first();
        let rate = resolveStockUnitCost({ qty: pool?.qty, value: pool?.value, lastUnitCost: receipt?.unit_cost });
        let child = null;
        if (!(rate > 0)) {
          child = await resolveBomStockCostTx({ trx, branchId, skuId: line.sfg_sku_id, path: [...path, skuId] });
          rate = child?.unitCost || 0;
        }
        if (!(rate > 0)) throw invalidCost();
        const cost = quantity * rate;
        componentCost += cost;
        components.push({ sku_id: line.sfg_sku_id, qty_pairs: quantity, unit_cost: rate, cost, bom_cost: child?.snapshot || null });
      }
    }
    const total = materialCost + labourCost + componentCost;
    if (!Number.isFinite(total) || !(total > 0)) throw invalidCost();
    return {
      unitCost: Number((total / pairs).toFixed(6)),
      snapshot: { source: "APPROVED_BOM", bom_id: profile.bomId, bom_version: profile.bomVersion, output_pairs: pairs,
        material_cost: materialCost, labour_cost: labourCost, component_cost: componentCost,
        materials, labour: labourLines.map(line => ({ labour_id: line.labour_id, dept_id: line.dept_id, rate: line.rate, amount: line.amount })), components },
    };
  } catch (err) {
    console.error("Error in BomStockCostService:", err);
    throw err;
  }
};

module.exports = { resolveBomStockCostTx };
