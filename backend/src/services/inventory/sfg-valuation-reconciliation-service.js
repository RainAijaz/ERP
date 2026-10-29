const knex = require("../../db/knex");
const { buildSfgValuationPlan } = require("./sfg-valuation-plan");
const { FG_PACKED_FLAG_SQL } = require("../../utils/stock-packing");

const loadValuationDataTx = async (trx) => {
  const stock = await trx("erp.stock_ledger as sl")
    .join("erp.voucher_header as vh", "vh.id", "sl.voucher_header_id")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_stages as ps", "ps.id", "pl.stage_id")
    .whereIn("sl.category", ["SFG", "FG"])
    .select("sl.*", "vh.voucher_type_code", "vh.voucher_no", "vh.status",
      "vl.sku_id as output_sku_id", "vl.meta as line_meta", "vl.amount as labour_value", "ps.dept_id as line_dept_id")
    .select(trx.raw(`${FG_PACKED_FLAG_SQL} as effective_is_packed`))
    .orderBy("sl.id");
  const wip = await trx("erp.wip_dept_ledger as wl")
    .join("erp.voucher_header as vh", "vh.id", "wl.source_voucher_id")
    .select("wl.*", "vh.voucher_type_code", "vh.status").orderBy("wl.id");
  const balances = await trx("erp.stock_balance_sku")
    .orderBy(["branch_id", "stock_state", "category", "sku_id", "is_packed"]);
  const wipBalances = await trx("erp.wip_dept_balance")
    .orderBy(["branch_id", "stock_state", "sku_id", "dept_id"]);
  const lines = await trx("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .whereIn("vh.voucher_type_code", ["STN_OUT", "GRN_IN"]).whereNotNull("vl.sku_id")
    .select("vl.id", "vl.voucher_header_id", "vl.qty", "vl.rate", "vl.amount", "vl.meta").orderBy("vl.id");
  return { stock, wip, balances, wipBalances, lines };
};

const previewSfgValuation = async ({ skuIds = [], eligibleOnly = false } = {}) => knex.transaction(async (trx) => {
  await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  const data = await loadValuationDataTx(trx);
  return eligibleOnly ? buildEligibleSfgPlan(data, skuIds) : buildSfgValuationPlan(data, { skuIds });
});


const { HttpError } = require("../../middleware/errors/http-error");
const { canAccessScope } = require("../../middleware/access/role-permissions");
const { insertActivityLog } = require("../../utils/audit-log");
const { resolveTranslation } = require("../../middleware/core/locale");
const { randomUUID } = require("node:crypto");
const REPAIR_MODE = "SFG_VALUATION_RECONCILIATION";
const translate = (req, key) => req?.res?.locals?.t?.(key) || resolveTranslation(req?.locale || "en", key);
const validateSkuIds = (skuIds) => {
  if (!Array.isArray(skuIds) || skuIds.some((n) => !Number.isSafeInteger(Number(n)) || Number(n) <= 0))
    throw new HttpError(400, "Invalid SKU filter");
  return [...new Set(skuIds.map(Number))].sort((a, b) => a - b);
};
const hasRepairPermission = (req) => Boolean(req?.user?.isAdmin ||
  canAccessScope(req, "VOUCHER", "STN_OUT", "edit") && canAccessScope(req, "VOUCHER", "STN_OUT", "approve") &&
  canAccessScope(req, "REPORT", "stock_ledger", "filter_all_branches"));

const applySfgValuationPlanTx = async ({ trx, req, skuIds, expectedHash, approvalRequestId = null }) => {
  if (!req?.user?.id) throw new HttpError(401, translate(req, "generic_error"));
  skuIds = validateSkuIds(skuIds || []);
  if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ""))) throw new HttpError(400, translate(req, "valuation_preview_changed"));
  // Freeze stock writers while checking the reviewed baseline and applying its
  // cost-only changes. Readers remain available; timeout rolls everything back.
  await trx.raw("SET LOCAL lock_timeout = '5s'");
  await trx.raw("LOCK TABLE erp.voucher_header, erp.voucher_line, erp.stock_ledger, erp.stock_balance_sku, erp.wip_dept_ledger, erp.wip_dept_balance IN SHARE ROW EXCLUSIVE MODE");
  const data = await loadValuationDataTx(trx);
  const plan = buildSfgValuationPlan(data, { skuIds });
  if (plan.hash !== expectedHash) throw new HttpError(409, translate(req, "valuation_preview_changed"));
  if (plan.blockers.length) throw new HttpError(409, translate(req, "valuation_unresolved"));
  const anchor = data.stock.find((r) => r.voucher_type_code === "STN_OUT" && plan.skuIds.includes(Number(r.sku_id)));
  if (!anchor) return { applied: false, queuedForApproval: false, changed: 0, hash: plan.hash };
  const branchId = Number(anchor.branch_id), voucherId = Number(anchor.voucher_header_id);
  if (!hasRepairPermission(req) && approvalRequestId) throw new HttpError(409, translate(req, "approval_submitted"));
  if (!hasRepairPermission(req)) {
    const values = { mode: REPAIR_MODE, action: "valuation_reconciliation", voucher_type_code: "STN_OUT",
      voucher_id: voucherId, sku_ids: plan.skuIds, expected_hash: expectedHash };
    let pending = await trx("erp.approval_request").where({entity_type:"VOUCHER",entity_id:String(voucherId),status:"PENDING"})
      .whereRaw("new_value->>'mode' = ?", [REPAIR_MODE]).select("id").first();
    if (!pending) {
      const [created] = await trx("erp.approval_request").insert({ branch_id:branchId,request_type:"VOUCHER",entity_type:"VOUCHER",
        entity_id:String(voucherId),summary:translate(req,"valuation_reconciliation"),new_value:values,status:"PENDING",requested_by:req.user.id }).returning("id");
      pending = created;
    }
    await insertActivityLog(trx, { branchId, userId:req.user.id,entityType:"VOUCHER",entityId:voucherId,action:"UPDATE",
      voucherTypeCode:"STN_OUT",context:{mode:REPAIR_MODE,queued_for_approval:true,approval_request_id:pending.id,hash:plan.hash} });
    return { applied:false,queuedForApproval:true,approvalRequestId:Number(pending.id),message:translate(req,"approval_submitted") };
  }
  const batchId = randomUUID(), at = new Date().toISOString();
  const audit = {mode:REPAIR_MODE,batch_id:batchId,at,hash:plan.hash,sku_ids:plan.skuIds,approval_request_id:approvalRequestId,
    stock_entries:plan.changes,wip_entries:plan.wipChanges,lines:plan.lineChanges,stock_balances:plan.balanceChanges,wip_balances:plan.wipBalanceChanges,adjustments:[]};
  for (const row of plan.changes) await trx("erp.stock_ledger").where({id:row.id}).update(row.after);
  for (const row of plan.wipChanges) await trx("erp.wip_dept_ledger").where({id:row.id}).update({cost_value:row.after});
  for (const row of plan.lineChanges) await trx("erp.voucher_line").where({id:row.id}).update(row.after);
  for (const row of plan.adjustments) {
    const source = data.stock.find((r) => Number(r.voucher_header_id) === row.voucherId);
    const [entry] = await trx("erp.stock_ledger").insert({branch_id:row.branchId,category:row.category,stock_state:row.stockState,
      sku_id:row.skuId,voucher_header_id:row.voucherId,voucher_line_id:null,txn_date:source.txn_date,direction:row.value>=0?1:-1,
      qty:0,qty_pairs:0,unit_cost:0,value:row.value,is_packed:row.isPacked}).returning("id");
    audit.adjustments.push({...row,id:Number(entry.id)});
  }
  for (const row of plan.balanceChanges) await trx("erp.stock_balance_sku").where(row.identity).update(row.after);
  for (const row of plan.wipBalanceChanges) await trx("erp.wip_dept_balance").where(row.identity).update({cost_value:row.after});
  // A complete before/after journal is committed atomically with the repair.
  // It also retains the inserted value-only entry IDs for a checked reversal.
  await insertActivityLog(trx, { branchId,userId:req.user.id,entityType:"VOUCHER",entityId:voucherId,action:"UPDATE",
    voucherTypeCode:"STN_OUT",context:audit });
  const check = await loadValuationDataTx(trx);
  const stockQty = (rows) => rows.map((r)=>[r.id, r.qty_pairs, r.direction]);
  if (JSON.stringify(stockQty(data.stock)) !== JSON.stringify(stockQty(check.stock.filter((r)=>!audit.adjustments.some((a)=>a.id===Number(r.id))))))
    throw new Error("Valuation repair changed stock quantities");
  const wipQty = (rows) => rows.map((r)=>[r.id,r.qty_pairs,r.direction]);
  if (JSON.stringify(wipQty(data.wip)) !== JSON.stringify(wipQty(check.wip)))
    throw new Error("Valuation repair changed WIP quantities");
  const repeat = buildSfgValuationPlan(check, {skuIds:plan.skuIds});
  if (repeat.blockers.length || repeat.changes.length || repeat.wipChanges.length || repeat.lineChanges.length || repeat.adjustments.length || repeat.balanceChanges.length || repeat.wipBalanceChanges.length)
    throw new Error("Valuation reconciliation did not reach a stable, repeatable result");
  return {applied:true,queuedForApproval:false,batchId,hash:plan.hash,stockEntries:plan.changes.length,wipEntries:plan.wipChanges.length,
    transferLines:plan.lineChanges.length,stockBalances:plan.balanceChanges.length,wipBalances:plan.wipBalanceChanges.length,
    valueAdjustments:plan.adjustments.length,shortages:plan.shortages,message:translate(req,"valuation_reconciled")};
};
// Only unambiguous components are eligible for a bulk repair. Missing costs,
// quantity drift and ambiguous stage links stay visible for review.
const buildEligibleSfgPlan = (data, skuIds = []) => {
  let plan = buildSfgValuationPlan(data, { skuIds });
  let selected = [...plan.skuIds];
  const skipped = new Map();
  const inputsByOutput = new Map();
  for (const row of data.stock) {
    if (row.category !== "SFG" || Number(row.direction) !== -1 || !row.output_sku_id) continue;
    const output = Number(row.output_sku_id), input = Number(row.sku_id);
    if (output === input) continue;
    if (!inputsByOutput.has(output)) inputsByOutput.set(output, new Set());
    inputsByOutput.get(output).add(input);
  }
  const roots = (sku, visited = new Set()) => {
    if (visited.has(sku)) return [];
    visited.add(sku);
    return [...(selected.includes(sku) ? [sku] : []),
      ...[...(inputsByOutput.get(sku) || [])].flatMap((n) => roots(n, visited))];
  };
  while (plan.blockers.length && selected.length) {
    const excluded = new Set();
    for (const blocker of plan.blockers) {
      for (const sku of roots(Number(blocker.skuId))) {
        excluded.add(sku);
        if (!skipped.has(sku)) skipped.set(sku, new Set());
        skipped.get(sku).add(blocker.reason);
      }
    }
    if (!excluded.size) break;
    selected = selected.filter((sku) => !excluded.has(sku));
    if (!selected.length) break;
    plan = buildSfgValuationPlan(data, { skuIds: selected });
  }
  return { ...plan, skipped: [...skipped].map(([skuId, reasons]) => ({skuId,reasons:[...reasons]})) };
};

const reconcileSfgValuation = async (args) => {
  try { return await knex.transaction((trx) => applySfgValuationPlanTx({...args,trx})); }
  catch (err) { console.error("Error in SfgValuationReconciliationService:", err); throw err; }
};
module.exports = { loadValuationDataTx, previewSfgValuation, applySfgValuationPlanTx, reconcileSfgValuation, buildEligibleSfgPlan, REPAIR_MODE };