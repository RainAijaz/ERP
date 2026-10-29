const { createHash } = require("node:crypto");
const { resolveStockUnitCost } = require("../../utils/stock-cost");
const money = (n) => Number(Number(n || 0).toFixed(2));
const rate = (n) => Number(Number(n || 0).toFixed(6));
const id = (n) => Number(n || 0);
const stockKey = (r) => [r.branch_id, r.stock_state, r.category, r.sku_id, r.category === "FG" && (r.effective_is_packed ?? r.is_packed) === true ? 1 : 0].join(":");
const wipKey = (r) => [r.branch_id, r.stock_state, r.sku_id, r.dept_id].join(":");
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const dateKey = (v) => v instanceof Date ? v.toISOString() : String(v || "");

// Reconcile costs from the posted ledger, never from today's BOM or labour rates.
// Quantities and voucher status are immutable inputs. Negative inventory carries
// its last documented receipt cost; receipt price differences at zero quantity
// are explicit value-only adjustments rather than silently discarded balances.
const buildSfgValuationPlan = (data, { skuIds = [] } = {}) => {
  const selected = new Set((skuIds.length ? skuIds : data.stock.filter((r) => r.category === "SFG" && r.voucher_type_code === "STN_OUT" && Number(r.value) === 0).map((r) => r.sku_id)).map(id));
  const stock = data.stock.filter((r) => r.status === "APPROVED");
  const wip = data.wip.filter((r) => r.status === "APPROVED");
  const pools = new Map(), wipPools = new Map(), dispatchCosts = new Map(), lineCosts = new Map();
  const changes = [], wipChanges = [], adjustments = [], blockers = [];
  const events = new Map();
  const addEvent = (row, name, voucherId) => {
    if (!events.has(voucherId)) events.set(voucherId, { id: voucherId, date: dateKey(row.txn_date), stock: [], wip: [] });
    events.get(voucherId)[name].push(row);
  };
  stock.forEach((r) => addEvent(r, "stock", id(r.voucher_header_id)));
  wip.forEach((r) => addEvent(r, "wip", id(r.source_voucher_id)));
  const getPool = (row) => {
    const key = stockKey(row);
    if (!pools.has(key)) pools.set(key, { key, row, qty: 0, oldValue: 0, value: 0, lastRate: 0, lastDeltaRate: 0, touched: false });
    return pools.get(key);
  };
  const recordStock = (row, nextValue, unitCost = null) => {
    const p = getPool(row), old = Number(row.value), delta = money(nextValue - old);
    p.qty += Number(row.direction) * Number(row.qty_pairs || 0);
    p.oldValue = money(p.oldValue + old); p.value = money(p.value + nextValue);
    const nextUnitCost = unitCost === null ? delta && Number(row.qty_pairs) > 0 ? rate(Math.abs(nextValue) / Number(row.qty_pairs)) : Number(row.unit_cost) : unitCost;
    if (Number(row.qty_pairs) > 0 && Number(row.direction) === 1 && nextValue > 0) p.lastRate = nextUnitCost;
    if (Number(row.qty_pairs) > 0 && Number(row.direction) === 1) p.lastDeltaRate = rate(delta / Number(row.qty_pairs));
    if (delta || unitCost !== null && Math.abs(Number(row.unit_cost) - nextUnitCost) > 0.0000005) {
      p.touched = true;
      changes.push({ id: id(row.id), voucherId: id(row.voucher_header_id), before: { value: old, unit_cost: Number(row.unit_cost) },
        after: { value: money(nextValue), unit_cost: nextUnitCost } });
    }
    return delta;
  };
  const sourceRate = (row) => {
    const p = getPool(row);
    return resolveStockUnitCost({qty:p.qty,value:p.value,lastUnitCost:p.lastRate || Number(row.unit_cost)});
  };
  const isSelected = (r) => r.category === "SFG" && selected.has(id(r.sku_id));
  const orderedEvents = [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const event of orderedEvents) {
    const componentGroups = new Map(), outputDeltas = new Map();
    const changeStart = changes.length, wipChangeStart = wipChanges.length;
    const touchedThisEvent = new Set();
    const regular = [], productionIn = [], valueOnly = [];
    event.stock.sort((a, b) => id(a.id) - id(b.id));
    for (const row of event.stock) {
      if (!Number(row.qty_pairs)) valueOnly.push(row);
      else if (row.voucher_type_code === "DCV" && Number(row.direction) === 1) productionIn.push(row);
      else regular.push(row);
    }
    for (const row of regular) {
      const p = getPool(row), qty = Number(row.qty_pairs || 0);
      let next = Number(row.value), delta = 0, unitCost = null;
      if (isSelected(row)) {
        if (row.voucher_type_code === "STN_OUT") {
          if (Number(row.direction) === -1) {
            unitCost = sourceRate(row);
            if (!(unitCost > 0)) blockers.push({ skuId: id(row.sku_id), voucherId: event.id, reason: "No documented source cost for transfer" });
            dispatchCosts.set(id(row.voucher_line_id), unitCost);
          }
          unitCost = dispatchCosts.get(id(row.voucher_line_id)) || 0;
          next = money(Number(row.direction) * qty * unitCost);
        } else if (row.voucher_type_code === "GRN_IN") {
          const sourceLineId = id(row.line_meta?.stn_line_id);
          if (!dispatchCosts.has(sourceLineId)) blockers.push({ skuId: id(row.sku_id), voucherId: event.id, reason: "Receipt has no preceding dispatch cost" });
          unitCost = dispatchCosts.get(sourceLineId) || 0;
          next = money(Number(row.direction) * qty * unitCost);
        } else if (Number(row.direction) === -1) {
          unitCost = sourceRate(row);
          next = money(-qty * unitCost);
        }
      } else if (row.category === "FG" && Number(row.direction) === -1 && !["STN_OUT", "GRN_IN"].includes(row.voucher_type_code)) {
        const poolDelta = money(p.value - p.oldValue);
        delta = p.qty > 0 ? money(-poolDelta * Math.min(qty, p.qty) / p.qty) : money(-qty * p.lastDeltaRate);
        next = money(next + delta);
      }
      if (isSelected(row) && ["STN_OUT", "GRN_IN"].includes(row.voucher_type_code) && qty > 0)
        lineCosts.set(id(row.voucher_line_id), unitCost);
      delta = recordStock(row, next, unitCost); touchedThisEvent.add(stockKey(row));
      if (row.voucher_type_code === "DCV" && row.category === "SFG" && Number(row.direction) === -1 && id(row.output_sku_id)) {
        const groupKey = [row.output_sku_id, row.voucher_line_id].join(":");
        if (!componentGroups.has(groupKey)) componentGroups.set(groupKey, { row, old: 0, delta: 0 });
        const group = componentGroups.get(groupKey); group.old += Math.abs(Number(row.value)); group.delta = money(group.delta - delta);
      }
    }
    const wipRows = event.wip.sort((a, b) => id(a.id) - id(b.id));
    const pendingOld = new Map(), candidateInputs = [];
    for (const row of wipRows) {
      const sku = id(row.sku_id);
      if (Number(row.direction) === -1) pendingOld.set(sku, (pendingOld.get(sku) || 0) + Number(row.cost_value));
      else {
        candidateInputs.push({ row, previousCost: money(pendingOld.get(sku) || 0) });
        pendingOld.set(sku, 0);
      }
    }
    const componentByWipId = new Map();
    for (const group of componentGroups.values()) {
      if (!group.delta) continue;
      const row = group.row, outputSkuId = id(row.output_sku_id);
      let candidates = candidateInputs.filter((c) => id(c.row.sku_id) === outputSkuId);
      if (id(row.line_dept_id)) candidates = candidates.filter((c) => id(c.row.dept_id) === id(row.line_dept_id));
      else candidates = candidates.filter((c) => same(Number(c.row.cost_value) - c.previousCost - group.old, Number(row.labour_value)));
      if (candidates.length === 1) {
        const targetId = id(candidates[0].row.id);
        componentByWipId.set(targetId, money((componentByWipId.get(targetId) || 0) + group.delta));
      } else if (!wipRows.some((r) => id(r.sku_id) === outputSkuId)) {
        outputDeltas.set(outputSkuId, money((outputDeltas.get(outputSkuId) || 0) + group.delta));
      } else blockers.push({ skuId: id(row.sku_id), voucherId: event.id, reason: "Cannot uniquely match component consumption to its production stage" });
    }
    const pending = new Map();
    for (const row of wipRows) {
      const key = wipKey(row), sku = id(row.sku_id), qty = Number(row.qty_pairs || 0);
      if (!wipPools.has(key)) wipPools.set(key, { row, qty: 0, delta: 0 });
      const p = wipPools.get(key); let delta = 0;
      if (Number(row.direction) === -1) {
        if (p.qty > 0) delta = money(p.delta * Math.min(qty, p.qty) / p.qty);
        else if (Math.abs(p.delta) > 0.005) blockers.push({ skuId: sku, voucherId: event.id, reason: "WIP cost change has no quantity to allocate" });
        pending.set(sku, money((pending.get(sku) || 0) + delta));
      } else {
        delta = money((pending.get(sku) || 0) + (componentByWipId.get(id(row.id)) || 0));
        pending.set(sku, 0);
      }
      p.qty += Number(row.direction) * qty;
      p.delta = money(p.delta + Number(row.direction) * delta);
      if (delta) wipChanges.push({ id: id(row.id), voucherId: event.id, before: Number(row.cost_value), after: money(Number(row.cost_value) + delta) });
    }
    for (const [sku, delta] of pending) {
      if (!delta) continue;
      const outputs = productionIn.filter((r) => id(r.sku_id) === sku);
      if (outputs.length) outputDeltas.set(sku, money((outputDeltas.get(sku) || 0) + delta));
      else if (event.stock.some((r) => r.voucher_type_code === "DCV") && wipRows.some((r) => Number(r.direction) === 1 && id(r.sku_id) !== sku))
        blockers.push({ skuId: sku, voucherId: event.id, reason: "Changed WIP conversion requires an explicit target link" });
    }
    for (const row of productionIn) {
      const outputRows = productionIn.filter((r) => id(r.sku_id) === id(row.sku_id));
      const totalPairs = outputRows.reduce((n, r) => n + Number(r.qty_pairs), 0);
      const delta = money((outputDeltas.get(id(row.sku_id)) || 0) * Number(row.qty_pairs) / totalPairs);
      recordStock(row, money(Number(row.value) + delta)); touchedThisEvent.add(stockKey(row));
    }
    if (event.stock.some((r) => r.voucher_type_code === "DCV") && componentGroups.size) {
      const stockDelta = changes.slice(changeStart).reduce((n,r)=>n+r.after.value-r.before.value,0);
      const wipDelta = wipChanges.slice(wipChangeStart).reduce((n,r)=>{
        const source = event.wip.find((w)=>id(w.id)===r.id);
        return n + Number(source.direction)*(r.after-r.before);
      },0);
      if (Math.abs(money(stockDelta+wipDelta)) > 0.05)
        for (const group of componentGroups.values()) if (group.delta) blockers.push({skuId:id(group.row.sku_id),voucherId:event.id,reason:"Production cost does not balance between components, WIP and output"});
    }
    for (const row of valueOnly) { recordStock(row, Number(row.value)); touchedThisEvent.add(stockKey(row)); }
    for (const key of touchedThisEvent) {
      const p = pools.get(key);
      if (p.qty !== 0 || Math.abs(p.value) < 0.005) continue;
      const amount = isSelected(p.row) ? money(-p.value) : p.touched ? money(p.oldValue - p.value) : 0;
      if (!amount) continue;
      adjustments.push({ voucherId: event.id, branchId: id(p.row.branch_id), skuId: id(p.row.sku_id), category: p.row.category,
        stockState: p.row.stock_state, isPacked: p.row.category === "FG" && (p.row.effective_is_packed ?? p.row.is_packed) === true, value: amount,
        date: event.date, reason: "NEGATIVE_STOCK_PRICE_DIFFERENCE" });
      p.value = money(p.value + amount);
    }
  }
  for (const change of changes) {
    const row = stock.find((r)=>id(r.id)===change.id);
    if (!Number.isFinite(change.after.value) || Number(row.direction)*change.after.value < -0.005 || change.after.unit_cost < 0)
      blockers.push({skuId:id(row.sku_id),voucherId:change.voucherId,reason:"Reconciled cost has an invalid sign"});
  }
  const balanceChanges = [];
  for (const before of data.balances) {
    const p = pools.get(stockKey(before)); if (!p || !p.touched && !isSelected(before)) continue;
    if (id(before.qty_pairs) !== p.qty) blockers.push({ skuId: id(before.sku_id), reason: "Ledger quantity and stock balance disagree" });
    const nextValue = isSelected(before) ? p.value : money(Number(before.value) + p.value - p.oldValue);
    const next = { value: nextValue, wac: p.qty === 0 ? 0 : rate(Math.abs(nextValue / p.qty)) };
    if (!same(before.value, next.value) || Math.abs(Number(before.wac) - next.wac) > 0.0000005)
      balanceChanges.push({ key: stockKey(before), identity: { branch_id: id(before.branch_id), stock_state: before.stock_state,
        category: before.category, is_packed: before.is_packed === true, sku_id: id(before.sku_id) },
        qty: id(before.qty_pairs), before: { value: Number(before.value), wac: Number(before.wac) }, after: next });
  }
  const wipBalanceChanges = [];
  for (const before of data.wipBalances) {
    const p = wipPools.get(wipKey(before)); if (!p || !p.delta) continue;
    const next = money(Number(before.cost_value) + p.delta);
    if (next < -0.005) blockers.push({ skuId: id(before.sku_id), reason: "Reconciled WIP value would be negative" });
    wipBalanceChanges.push({ identity: {branch_id:id(before.branch_id),stock_state:before.stock_state,sku_id:id(before.sku_id),dept_id:id(before.dept_id)},
      qty: Number(before.qty_pairs), before: Number(before.cost_value), after: next });
  }
  const lineChanges = [];
  for (const before of data.lines || []) {
    if (!lineCosts.has(id(before.id)) || before.meta?.is_wip === true) continue;
    const unitCost = lineCosts.get(id(before.id));
    const factor = Number(before.meta?.uom_factor_to_base || 1);
    const next = { rate: Number((unitCost * factor).toFixed(4)), amount: money(Number(before.qty) * factor * unitCost),
      meta: { ...before.meta, unit_cost_base: unitCost } };
    if (!same(before.amount, next.amount) || Math.abs(Number(before.rate) - next.rate) > 0.00005 || Number(before.meta?.unit_cost_base || 0) !== unitCost)
      lineChanges.push({ id:id(before.id), voucherId:id(before.voucher_header_id), before:{rate:Number(before.rate),amount:Number(before.amount),meta:before.meta}, after:next });
  }
  const hash = createHash("sha256").update(JSON.stringify({ stock, wip, balances: data.balances, wipBalances: data.wipBalances, lines: data.lines, skuIds: [...selected].sort() })).digest("hex");
  return { hash, skuIds: [...selected], changes, wipChanges, lineChanges, adjustments, balanceChanges, wipBalanceChanges,
    blockers: [...new Map(blockers.map((b) => [JSON.stringify(b), b])).values()],
    shortages: [...pools.values()].filter((p) => isSelected(p.row) && p.qty < 0).map((p) => ({branchId:id(p.row.branch_id),skuId:id(p.row.sku_id),qty:p.qty,value:p.value})) };
};
module.exports = { buildSfgValuationPlan };