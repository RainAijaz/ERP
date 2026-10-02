const { HttpError } = require("../../middleware/errors/http-error");
const knex = require("../../db/knex");
const { hasPermission, requiresApproval } = require("../../middleware/approvals/screen-approval");
const { queueAuditLog } = require("../../utils/audit-log");

const positiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const qty3 = (value) => Number(Number(value || 0).toFixed(3));
const money2 = (value) => Number(Number(value || 0).toFixed(2));
const cost6 = (value) => Number(Number(value || 0).toFixed(6));
const repackError = (code, detail = {}) => {
  const error = new HttpError(400, code);
  error.code = code;
  error.repack = detail;
  return error;
};
const dimensionWhere = (query, column, value) =>
  value == null ? query.whereNull(column) : query.where(column, Number(value));

const validateRuleTx = async (trx, input) => {
  const recoverItemId = positiveId(input.recover_rm_item_id);
  const rule = {
    item_id: positiveId(input.item_id),
    source_packing_type_id: positiveId(input.source_packing_type_id),
    target_packing_type_id: positiveId(input.target_packing_type_id),
    consume_rm_item_id: positiveId(input.consume_rm_item_id),
    pairs_per_pack: positiveId(input.pairs_per_pack),
    consume_qty_per_pack: qty3(input.consume_qty_per_pack),
    consume_color_id: positiveId(input.consume_color_id),
    consume_size_id: positiveId(input.consume_size_id),
    recover_rm_item_id: recoverItemId,
    recover_qty_per_pair: recoverItemId ? qty3(input.recover_qty_per_pair) : 0,
    recover_color_id: recoverItemId ? positiveId(input.recover_color_id) : null,
    recover_size_id: recoverItemId ? positiveId(input.recover_size_id) : null,
    is_active: input.is_active === true || input.is_active === "on" || input.is_active === "true",
  };
  if (!rule.item_id || !rule.source_packing_type_id || !rule.target_packing_type_id ||
      rule.source_packing_type_id === rule.target_packing_type_id ||
      !rule.consume_rm_item_id || !rule.pairs_per_pack ||
      !(rule.consume_qty_per_pack > 0) ||
      !Number.isFinite(rule.consume_qty_per_pack) ||
      !Number.isFinite(rule.recover_qty_per_pair) || rule.recover_qty_per_pair < 0 ||
      Boolean(rule.recover_rm_item_id) !== (rule.recover_qty_per_pair > 0)) {
    throw repackError("repack_rule_invalid");
  }
  const [item, sourcePacking, targetPacking, consumeRm, recoverRm] = await Promise.all([
    trx("erp.items").where({ id: rule.item_id, item_type: "FG", is_active: true }).first(),
    trx("erp.packing_types").where({ id: rule.source_packing_type_id, is_active: true }).first(),
    trx("erp.packing_types").where({ id: rule.target_packing_type_id, is_active: true }).first(),
    trx("erp.items").where({ id: rule.consume_rm_item_id, item_type: "RM", is_active: true }).first(),
    rule.recover_rm_item_id
      ? trx("erp.items").where({ id: rule.recover_rm_item_id, item_type: "RM", is_active: true }).first()
      : Promise.resolve(true),
  ]);
  if (!item || !sourcePacking || !targetPacking || !consumeRm || !recoverRm) {
    throw repackError("repack_rule_invalid");
  }
  if (rule.recover_rm_item_id === rule.consume_rm_item_id &&
      rule.recover_color_id === rule.consume_color_id &&
      rule.recover_size_id === rule.consume_size_id) {
    throw repackError("repack_rule_invalid");
  }
  if (rule.is_active) {
    const conflict = await trx("erp.packaging_conversion_rule")
      .select("id")
      .where({ item_id: rule.item_id,
        target_packing_type_id: rule.target_packing_type_id,
        is_active: true })
      .whereNot("source_packing_type_id", rule.source_packing_type_id)
      .first();
    if (conflict) throw repackError("repack_ambiguous_rule");
  }
  return rule;
};

const saveRuleTx = async ({ trx, input, userId }) => {
  const rule = await validateRuleTx(trx, input);
  const key = {
    item_id: rule.item_id,
    source_packing_type_id: rule.source_packing_type_id,
    target_packing_type_id: rule.target_packing_type_id,
  };
  const existing = await trx("erp.packaging_conversion_rule").where(key).first().forUpdate();
  if (existing) {
    await trx("erp.packaging_conversion_rule").where({ id: existing.id }).update({
      ...rule, updated_by: userId, updated_at: trx.fn.now(),
    });
    return { id: Number(existing.id), action: "UPDATE" };
  }
  const [created] = await trx("erp.packaging_conversion_rule")
    .insert({ ...rule, created_by: userId, updated_by: userId })
    .returning("id");
  return { id: Number(created.id), action: "CREATE" };
};

const submitRule = async ({ req, input }) => {
  const outcome = await knex.transaction(async (trx) => {
    const rule = await validateRuleTx(trx, input || {});
    const existing = await trx("erp.packaging_conversion_rule")
      .where({ item_id: rule.item_id,
        source_packing_type_id: rule.source_packing_type_id,
        target_packing_type_id: rule.target_packing_type_id }).first();
    const action = existing ? "edit" : "create";
    const canApply = hasPermission(req.user, "master_data.products.skus", action);
    const policyRequiresApproval = await requiresApproval("master_data.products.skus", action);
    if (!canApply || (policyRequiresApproval && !req.user?.isAdmin)) {
      const [item, sourcePacking, targetPacking] = await Promise.all([
        trx("erp.items").select("name").where({ id: rule.item_id }).first(),
        trx("erp.packing_types").select("name").where({ id: rule.source_packing_type_id }).first(),
        trx("erp.packing_types").select("name").where({ id: rule.target_packing_type_id }).first(),
      ]);
      const [request] = await trx("erp.approval_request").insert({
        branch_id: req.branchId, request_type: "MASTER_DATA_CHANGE",
        entity_type: "PACKAGING_CONVERSION_RULE",
        entity_id: existing ? String(existing.id) : "NEW",
        summary: String(req?.res?.locals?.t?.("repack_approval_summary") ||
          "Packaging conversion: {item} / {source} → {target}")
          .replace("{item}", item.name)
          .replace("{source}", sourcePacking.name)
          .replace("{target}", targetPacking.name),
        old_value: existing || null, new_value: rule,
        status: "PENDING", requested_by: req.user.id,
        requested_at: trx.fn.now(),
      }).returning("id");
      return { queued: true, id: Number(request.id) };
    }
    return saveRuleTx({ trx, input: rule, userId: req.user.id });
  });
  if (!outcome.queued) {
    queueAuditLog(req, { entityType: "PACKAGING_CONVERSION_RULE",
      entityId: outcome.id, action: outcome.action });
  }
  return outcome;
};

const loadRulePageTx = async (db, selectedId = null) => {
  const [rules, items, packings, materials, colors, sizes] = await Promise.all([
    db("erp.packaging_conversion_rule as r")
      .join("erp.items as i", "i.id", "r.item_id")
      .join("erp.packing_types as a", "a.id", "r.source_packing_type_id")
      .join("erp.packing_types as b", "b.id", "r.target_packing_type_id")
      .join("erp.items as m", "m.id", "r.consume_rm_item_id")
      .leftJoin("erp.items as rec", "rec.id", "r.recover_rm_item_id")
      .select("r.*", "i.code as item_code", "i.name as item_name", "a.name as source_name", "b.name as target_name",
        "m.name as consume_name", "rec.name as recover_name")
      .orderBy("i.name").orderBy("a.name"),
    db("erp.items").select("id", "code", "name").where({ item_type: "FG", is_active: true }).orderBy("name"),
    db("erp.packing_types").select("id", "name").where({ is_active: true }).orderBy("name"),
    db("erp.items as i")
      .join("erp.uom as u", "u.id", "i.base_uom_id")
      .select("i.id", "i.code", "i.name", "u.code as uom_code")
      .where({ "i.item_type": "RM", "i.is_active": true }).orderBy("i.name"),
    db("erp.colors").select("id", "name").where({ is_active: true }).orderBy("name"),
    db("erp.sizes").select("id", "name").where({ is_active: true }).orderBy("name"),
  ]);
  return { rules, items, packings, materials, colors, sizes,
    selected: rules.find((rule) => Number(rule.id) === Number(selectedId)) || null };
};

const findSourceTx = async ({ trx, target, sourcePackingTypeId }) => {
  const query = trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .select("s.id", "s.sku_code")
    .where({ "v.item_id": target.item_id, "v.packing_type_id": sourcePackingTypeId,
      "v.is_active": true, "s.is_active": true });
  for (const key of ["size_id", "grade_id", "color_id"]) {
    query.whereRaw(`v.${key} IS NOT DISTINCT FROM ?`, [target[key] ?? null]);
  }
  return query.limit(2);
};

const canCoverRepackShortfallTx = async ({ trx, branchId, targetSkuId,
  shortage, isPacked, currentVoucherId = null,
  plannedSourceDeductions = new Map(), repackReservations = new Map(),
  repackMaterialReservations = new Map() }) => {
  if (!(shortage > 0)) return true;
  const target = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .select("v.item_id", "v.size_id", "v.grade_id", "v.color_id", "v.packing_type_id")
    .where({ "s.id": targetSkuId, "s.is_active": true, "v.is_active": true }).first();
  if (!target?.packing_type_id) return false;
  const rules = await trx("erp.packaging_conversion_rule")
    .where({ item_id: target.item_id, target_packing_type_id: target.packing_type_id,
      is_active: true }).limit(2);
  if (rules.length !== 1) return false;
  const rule = rules[0];
  const sources = await findSourceTx({ trx, target,
    sourcePackingTypeId: rule.source_packing_type_id });
  if (sources.length !== 1) return false;
  const sourceId = Number(sources[0].id);
  const [sourceBalance, materialBalance] = await Promise.all([
    trx("erp.stock_balance_sku").select("qty_pairs")
      .where({ branch_id: branchId, stock_state: "ON_HAND", category: "FG",
        is_packed: isPacked, sku_id: sourceId }).first(),
    (() => {
      const query = trx("erp.stock_balance_rm").select("qty")
        .where({ branch_id: branchId, stock_state: "ON_HAND",
          item_id: rule.consume_rm_item_id });
      dimensionWhere(query, "color_id", rule.consume_color_id);
      dimensionWhere(query, "size_id", rule.consume_size_id);
      return query.first();
    })(),
  ]);
  let sourceQty = Number(sourceBalance?.qty_pairs || 0);
  let materialQty = Number(materialBalance?.qty || 0);
  if (currentVoucherId) {
    const previous = await trx("erp.sales_packaging_conversion as pc")
      .leftJoin("erp.stock_ledger as sl", "sl.id", "pc.consume_ledger_id")
      .select("pc.qty_pairs", "pc.is_packed", "sl.qty as consumed_qty")
      .where({ "pc.voucher_header_id": currentVoucherId,
        "pc.source_sku_id": sourceId,
        "pc.target_sku_id": targetSkuId,
        "pc.rule_id": rule.id });
    for (const row of previous) {
      if (row.is_packed !== isPacked) continue;
      sourceQty += Number(row.qty_pairs || 0);
      materialQty += Number(row.consumed_qty || 0);
    }
  }
  const packs = Math.ceil(shortage / Number(rule.pairs_per_pack));
  const neededMaterial = qty3(packs * Number(rule.consume_qty_per_pack));
  const sourceBucket = `${sourceId}:${isPacked ? 1 : 0}`;
  const materialBucket = `${rule.consume_rm_item_id}:${rule.consume_color_id || 0}:${rule.consume_size_id || 0}`;
  const unreservedSource = sourceQty
    - Number(plannedSourceDeductions.get(sourceBucket) || 0)
    - Number(repackReservations.get(sourceBucket) || 0);
  const unreservedMaterial = materialQty - Number(repackMaterialReservations.get(materialBucket) || 0);
  if (unreservedSource + 0.0005 < shortage || unreservedMaterial + 0.0005 < neededMaterial) {
    return false;
  }
  repackReservations.set(sourceBucket,
    Number(repackReservations.get(sourceBucket) || 0) + shortage);
  repackMaterialReservations.set(materialBucket,
    Number(repackMaterialReservations.get(materialBucket) || 0) + neededMaterial);
  return true;
};

const rmBalanceTx = async ({ trx, branchId, itemId, colorId, sizeId }) => {
  await trx("erp.stock_balance_rm").insert({ branch_id: branchId, stock_state: "ON_HAND",
    item_id: itemId, color_id: colorId, size_id: sizeId, qty: 0, value: 0, wac: 0 })
    .onConflict().ignore();
  const query = trx("erp.stock_balance_rm")
    .select("qty", "value", "wac")
    .where({ branch_id: branchId, stock_state: "ON_HAND", item_id: itemId });
  dimensionWhere(query, "color_id", colorId);
  dimensionWhere(query, "size_id", sizeId);
  return query.first().forUpdate();
};

const moveRmTx = async ({ trx, branchId, voucherId, voucherLineId, voucherDate,
  itemId, colorId, sizeId, qty, direction, valueOverride = null }) => {
  const current = await rmBalanceTx({ trx, branchId, itemId, colorId, sizeId });
  const available = Number(current?.qty || 0);
  if (direction < 0 && available + 0.0005 < qty) {
    throw repackError("repack_material_short", { itemId, required: qty, available });
  }
  let unitCost = Number(current?.wac || 0);
  if (unitCost <= 0 && available > 0) unitCost = Number(current?.value || 0) / available;
  if (direction > 0 && unitCost <= 0 && valueOverride === null) {
    const historyQuery = trx("erp.stock_ledger")
      .select("unit_cost")
      .where({ branch_id: branchId, stock_state: "ON_HAND",
        category: "RM", item_id: itemId });
    dimensionWhere(historyQuery, "color_id", colorId);
    dimensionWhere(historyQuery, "size_id", sizeId);
    const history = await historyQuery.orderBy("txn_date", "desc")
      .orderBy("id", "desc").first();
    unitCost = Number(history?.unit_cost || 0);
  }
  if (valueOverride !== null) unitCost = Number(valueOverride) / qty;
  if (!Number.isFinite(unitCost) || unitCost < 0) throw repackError("repack_cost_invalid");
  const value = valueOverride === null ? money2(qty * unitCost) : money2(valueOverride);
  const nextQty = qty3(available + direction * qty);
  const nextValue = nextQty <= 0 ? 0 : money2(Number(current?.value || 0) + direction * value);
  if (nextValue < -0.005) throw repackError("repack_cost_invalid");
  const query = trx("erp.stock_balance_rm")
    .where({ branch_id: branchId, stock_state: "ON_HAND", item_id: itemId });
  dimensionWhere(query, "color_id", colorId);
  dimensionWhere(query, "size_id", sizeId);
  await query.update({ qty: nextQty, value: Math.max(0, nextValue),
    wac: nextQty > 0 ? cost6(Math.max(0, nextValue) / nextQty) : 0,
    last_txn_at: trx.fn.now() });
  const [ledger] = await trx("erp.stock_ledger").insert({
    branch_id: branchId, category: "RM", stock_state: "ON_HAND", item_id: itemId,
    sku_id: null, color_id: colorId, size_id: sizeId,
    voucher_header_id: voucherId, voucher_line_id: voucherLineId, txn_date: voucherDate,
    direction, qty, qty_pairs: 0, unit_cost: cost6(unitCost), value: direction * value,
  }).returning("id");
  return { value, ledgerId: Number(ledger.id) };
};

const maybeRepackSaleLineTx = async ({ trx, branchId, voucherId, voucherLineId,
  voucherDate, targetSkuId, qtyPairs, isPacked, stockOut, stockIn }) => {
  const target = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .select("v.item_id", "v.size_id", "v.grade_id", "v.color_id", "v.packing_type_id")
    .where({ "s.id": targetSkuId, "s.is_active": true, "v.is_active": true }).first();
  if (!target?.packing_type_id) return null;
  const rules = await trx("erp.packaging_conversion_rule")
    .where({ item_id: target.item_id, target_packing_type_id: target.packing_type_id,
      is_active: true }).limit(2);
  if (!rules.length) return null;
  if (rules.length !== 1) throw repackError("repack_ambiguous_rule");
  const rule = rules[0];
  const destination = await trx("erp.stock_balance_sku")
    .select("qty_pairs")
    .where({ branch_id: branchId, stock_state: "ON_HAND", category: "FG",
      is_packed: isPacked, sku_id: targetSkuId }).first().forUpdate();
  const shortage = Math.max(0, qtyPairs - Number(destination?.qty_pairs || 0));
  if (shortage === 0) return null;
  const sourceSkus = await findSourceTx({ trx, target, sourcePackingTypeId: rule.source_packing_type_id });
  if (sourceSkus.length !== 1) throw repackError("repack_source_missing");
  const sourceSkuId = Number(sourceSkus[0].id);
  const source = await trx("erp.stock_balance_sku")
    .select("qty_pairs").where({ branch_id: branchId, stock_state: "ON_HAND",
      category: "FG", is_packed: isPacked, sku_id: sourceSkuId }).first().forUpdate();
  if (Number(source?.qty_pairs || 0) < shortage) {
    throw repackError("repack_source_short", {
      sku: sourceSkus[0].sku_code, required: shortage,
      available: Number(source?.qty_pairs || 0),
    });
  }
  const consumeQty = qty3(Math.ceil(shortage / Number(rule.pairs_per_pack)) *
    Number(rule.consume_qty_per_pack));
  const recoverQty = rule.recover_rm_item_id
    ? qty3(shortage * Number(rule.recover_qty_per_pair)) : 0;
  if (consumeQty <= 0 || (rule.recover_rm_item_id && recoverQty <= 0)) {
    throw repackError("repack_rule_invalid");
  }
  const sourceValue = await stockOut({ trx, branchId, skuId: sourceSkuId,
    category: "FG", qtyPairsOut: shortage, voucherId, voucherLineId,
    voucherDate, isPacked });
  const consumed = await moveRmTx({ trx, branchId, voucherId, voucherLineId,
    voucherDate, itemId: Number(rule.consume_rm_item_id),
    colorId: rule.consume_color_id, sizeId: rule.consume_size_id,
    qty: consumeQty, direction: -1 });
  const recovered = rule.recover_rm_item_id ? await moveRmTx({ trx, branchId,
    voucherId, voucherLineId, voucherDate, itemId: Number(rule.recover_rm_item_id),
    colorId: rule.recover_color_id, sizeId: rule.recover_size_id,
    qty: recoverQty, direction: 1 }) : null;
  const targetValue = money2(sourceValue + consumed.value - Number(recovered?.value || 0));
  if (targetValue < 0) throw repackError("repack_cost_invalid");
  await stockIn({ trx, branchId, skuId: targetSkuId, category: "FG",
    qtyPairsIn: shortage, valueIn: targetValue, voucherId, voucherLineId,
    voucherDate, isPacked });
  await trx("erp.sales_packaging_conversion").insert({
    voucher_header_id: voucherId, voucher_line_id: voucherLineId, rule_id: rule.id,
    source_sku_id: sourceSkuId, target_sku_id: targetSkuId, qty_pairs: shortage,
    is_packed: isPacked, source_value: sourceValue,
    packaging_value: consumed.value, recovered_value: Number(recovered?.value || 0),
    had_recovery: Boolean(recovered),
    consume_ledger_id: consumed.ledgerId, recover_ledger_id: recovered?.ledgerId || null,
  });
  return { sourceSkuId, targetSkuId, qtyPairs: shortage };
};

const rollbackRepackMaterialsTx = async ({ trx, voucherId }) => {
  const events = await trx("erp.sales_packaging_conversion")
    .where({ voucher_header_id: voucherId }).orderBy("id", "desc");
  for (const event of events) {
    if (!event.consume_ledger_id || (event.had_recovery && !event.recover_ledger_id)) {
      throw repackError("repack_rollback_missing");
    }
    const ids = [event.recover_ledger_id, event.consume_ledger_id].filter(Boolean);
    for (const id of ids) {
      const ledger = await trx("erp.stock_ledger").where({ id }).first();
      if (!ledger) throw repackError("repack_rollback_missing");
      const reverse = await moveRmTx({ trx, branchId: Number(ledger.branch_id), voucherId,
        voucherLineId: ledger.voucher_line_id, voucherDate: ledger.txn_date,
        itemId: Number(ledger.item_id), colorId: ledger.color_id, sizeId: ledger.size_id,
        qty: Number(ledger.qty), direction: -Number(ledger.direction),
        valueOverride: Math.abs(Number(ledger.value)) });
      await trx("erp.stock_ledger").where({ id }).del();
      await trx("erp.stock_ledger").where({ id: reverse.ledgerId }).del();
    }
  }
  const orphan = await trx("erp.stock_ledger")
    .select("id")
    .where({ voucher_header_id: voucherId, category: "RM" })
    .first();
  if (orphan) throw repackError("repack_rollback_missing");
  if (events.length) await trx("erp.sales_packaging_conversion")
    .where({ voucher_header_id: voucherId }).del();
};

module.exports = { validateRuleTx, saveRuleTx, submitRule, loadRulePageTx,
  canCoverRepackShortfallTx, maybeRepackSaleLineTx, rollbackRepackMaterialsTx };
