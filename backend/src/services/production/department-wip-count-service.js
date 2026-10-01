const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { canAccessScope } = require("../../middleware/access/role-permissions");
const { toLocalDateOnly } = require("../../utils/date-only");
const { localizedNameSelect, resolveLocale } = require("../../utils/localized-name");
const { insertActivityLog } = require("../../utils/audit-log");
const { resolveVoucherApprovalRequiredTx } = require("../../utils/voucher-approval-policy");
const {
  WIP_ON_HAND,
  adjustWipBalanceTx,
  insertWipLedgerTx,
  resolveWipUnitCost,
} = require("./wip-pool");

const TYPE = "STOCK_COUNT_ADJ";
const REASON_CODE = "DEPT_WIP_COUNT";
const positiveId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const countQty = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 2147483647 ? n : null;
};
const manualUnitCost = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0.01 && amount <= 10000000
    && Number(amount.toFixed(4)) === amount ? amount : null;
};
const recentWipUnitCostTx = async (trx, branchId, skuId, deptId) => {
  const row = await trx("erp.wip_dept_ledger")
    .select("qty_pairs", "cost_value")
    .where({ branch_id: branchId, sku_id: skuId, dept_id: deptId, stock_state: WIP_ON_HAND })
    .where("qty_pairs", ">", 0).where("cost_value", ">", 0)
    .orderBy("id", "desc").first();
  return row ? Number(row.cost_value) / Number(row.qty_pairs) : 0;
};

const loadDepartmentWipCountDepartments = async (req) => {
  const locale = resolveLocale(req.locale);
  return knex("erp.departments")
    .select("id", localizedNameSelect("departments", "name", locale))
    .where({ is_active: true, is_production: true })
    .orderBy("name");
};

const isDepartmentWipCountReasonTx = async (db, reasonCodeId) => {
  const id = positiveId(reasonCodeId);
  if (!id) return false;
  const row = await db("erp.reason_codes as rc")
    .join("erp.reason_code_voucher_type_map as map", "map.reason_code_id", "rc.id")
    .select("rc.code")
    .where({ "rc.id": id, "rc.is_active": true, "map.voucher_type_code": TYPE })
    .first();
  return row?.code === REASON_CODE;
};

const loadDepartmentWipCountDetails = async ({ req, voucherId }) => {
  const header = await knex("erp.wip_count_header")
    .select("dept_id", "reason_code_id", "reason_notes")
    .where({ voucher_id: voucherId }).first();
  if (!header) return null;
  const locale = resolveLocale(req.locale);
  const lines = await knex("erp.voucher_line as vl")
    .join("erp.skus as s", "s.id", "vl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("vl.sku_id", "vl.qty", "vl.meta", "s.sku_code", localizedNameSelect("i", "article_name", locale))
    .where("vl.voucher_header_id", voucherId).orderBy("vl.line_no");
  return { ...header, lines };
};

const loadDepartmentWipCountArticles = async ({ req, deptId, db = knex }) => {
  const id = positiveId(deptId);
  const department = id && await db("erp.departments").select("id")
    .where({ id, is_active: true, is_production: true }).first();
  if (!department) throw new HttpError(400, "wip_count_invalid_department");
  const locale = resolveLocale(req.locale);
  const [history, balances] = await Promise.all([
    db("erp.wip_dept_ledger").distinct("sku_id")
      .where({ branch_id: req.branchId, dept_id: id, stock_state: WIP_ON_HAND }),
    db("erp.wip_dept_balance").select("sku_id", "qty_pairs")
      .where({ branch_id: req.branchId, dept_id: id, stock_state: WIP_ON_HAND }),
  ]);
  const skuIds = [...new Set([...history, ...balances].map((row) => Number(row.sku_id)).filter(positiveId))];
  if (!skuIds.length) return [];
  const skus = await db("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id as sku_id", "s.sku_code", localizedNameSelect("i", "article_name", locale))
    .whereIn("s.id", skuIds)
    .whereIn("i.item_type", ["FG", "SFG"]).orderBy("s.sku_code");
  const bySku = new Map(balances.map((row) => [Number(row.sku_id), Number(row.qty_pairs)]));
  return skus.map((row) => ({ ...row, system_qty: bySku.get(Number(row.sku_id)) || 0 }));
};

const loadDepartmentWipCountCandidates = async ({ req, deptId, db = knex }) => {
  const id = positiveId(deptId);
  const department = id && await db("erp.departments").select("id")
    .where({ id, is_active: true, is_production: true }).first();
  if (!department) throw new HttpError(400, "wip_count_invalid_department");
  const locale = resolveLocale(req.locale);
  return db("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id as sku_id", "s.sku_code", localizedNameSelect("i", "article_name", locale))
    .where({ "s.is_active": true, "v.is_active": true, "i.is_active": true })
    .whereIn("i.item_type", ["FG", "SFG"]).orderBy("s.sku_code");
};

const applyDepartmentWipCountTx = async ({ trx, voucherId }) => {
  const header = await trx("erp.voucher_header as vh")
    .join("erp.wip_count_header as wc", "wc.voucher_id", "vh.id")
    .select("vh.id", "vh.branch_id", "vh.voucher_date", "vh.status", "wc.dept_id")
    .where({ "vh.id": voucherId, "vh.voucher_type_code": TYPE }).first();
  if (!header || header.status !== "APPROVED") throw new HttpError(400, "wip_count_invalid_voucher");
  const posted = await trx("erp.wip_dept_ledger").where({ source_voucher_id: voucherId }).first();
  if (posted) return;
  const lines = await trx("erp.voucher_line").select("sku_id", "qty", "meta")
    .where({ voucher_header_id: voucherId }).orderBy("line_no");
  if (!lines.length) throw new HttpError(400, "wip_count_lines_required");

  // Validate every snapshot before posting any movement. Row locks protect each balance
  // from concurrent production postings until this transaction commits.
  const movements = [];
  for (const line of lines) {
    const skuId = positiveId(line.sku_id);
    const counted = countQty(line.qty);
    const expected = countQty(line.meta?.system_qty);
    if (!skuId || counted === null || expected === null) throw new HttpError(400, "wip_count_invalid_line");
    await trx("erp.wip_dept_balance").insert({
      branch_id: header.branch_id, stock_state: WIP_ON_HAND, sku_id: skuId,
      dept_id: header.dept_id, qty_pairs: 0, cost_value: 0,
    }).onConflict(["branch_id", "stock_state", "sku_id", "dept_id"]).ignore();
    const pool = await trx("erp.wip_dept_balance")
      .select("qty_pairs", "cost_value")
      .where({ branch_id: header.branch_id, stock_state: WIP_ON_HAND, sku_id: skuId, dept_id: header.dept_id })
      .forUpdate().first();
    if (Number(pool.qty_pairs) !== expected || Number(pool.cost_value) !== Number(line.meta?.system_cost)) {
      throw new HttpError(409, "wip_count_stale_balance");
    }
    const latestLedger = await trx("erp.wip_dept_ledger")
      .where({ branch_id: header.branch_id, stock_state: WIP_ON_HAND, sku_id: skuId, dept_id: header.dept_id })
      .max({ id: "id" }).first();
    if (Number(latestLedger?.id || 0) !== Number(line.meta?.system_ledger_id || 0)) {
      throw new HttpError(409, "wip_count_stale_balance");
    }
    const delta = counted - expected;
    if (!delta) continue;
    let unitCost = resolveWipUnitCost(pool);
    if (delta > 0 && !(unitCost > 0)) {
      unitCost = await recentWipUnitCostTx(trx, header.branch_id, skuId, header.dept_id);
      if (!(unitCost > 0)) unitCost = manualUnitCost(line.meta?.manual_unit_cost);
      if (!(unitCost > 0)) throw new HttpError(400, "wip_count_missing_cost");
    }
    const cost = delta < 0
      ? (counted === 0
        ? Number(pool.cost_value)
        : Math.floor(Math.round(Number(pool.cost_value) * 100) * Math.abs(delta) / expected) / 100)
      : Number((delta * unitCost).toFixed(2));
    movements.push({ skuId, delta, cost });
  }
  for (const movement of movements) {
    await adjustWipBalanceTx({
      trx, branchId: header.branch_id, stockState: WIP_ON_HAND,
      skuId: movement.skuId, deptId: header.dept_id,
      qtyDelta: movement.delta, costDelta: Math.sign(movement.delta) * movement.cost,
      activityDate: toLocalDateOnly(header.voucher_date),
    });
    await insertWipLedgerTx({
      trx, branchId: header.branch_id, stockState: WIP_ON_HAND,
      skuId: movement.skuId, deptId: header.dept_id, txnDate: toLocalDateOnly(header.voucher_date),
      direction: Math.sign(movement.delta), qtyPairs: Math.abs(movement.delta),
      costValue: movement.cost, sourceVoucherId: voucherId,
    });
  }
};

const createDepartmentWipCount = async ({ req, payload, db = knex }) => db.transaction(async (trx) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!positiveId(req.branchId)) throw new HttpError(400, "Branch context is required");
  const deptId = positiveId(payload?.dept_id);
  const reasonCodeId = positiveId(payload?.reason_code_id);
  const reasonNotes = String(payload?.reason_notes || "").trim();
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const countDate = toLocalDateOnly(new Date());
  if (String(payload?.voucher_date || "") !== countDate) {
    throw new HttpError(400, "wip_count_today_only");
  }
  if (!deptId || !reasonCodeId || !reasonNotes || reasonNotes.length > 1000 || !lines.length || lines.length > 500) {
    throw new HttpError(400, "wip_count_invalid_input");
  }
  const department = await trx("erp.departments").where({ id: deptId, is_active: true, is_production: true }).first();
  const validReason = await isDepartmentWipCountReasonTx(trx, reasonCodeId);
  if (!department || !validReason) throw new HttpError(400, "wip_count_invalid_input");
  const allowedSkus = await loadDepartmentWipCountArticles({ req, deptId, db: trx });
  const candidates = await loadDepartmentWipCountCandidates({ req, deptId, db: trx });
  const allowed = new Set(candidates.map((row) => Number(row.sku_id)));
  const automatic = new Set(allowedSkus.map((row) => Number(row.sku_id)));
  automatic.forEach((skuId) => allowed.add(skuId));
  const seen = new Set();
  const normalized = [];
  for (const line of lines) {
    const skuId = positiveId(line?.sku_id);
    const expected = countQty(line?.system_qty);
    const counted = countQty(line?.counted_qty);
    const suppliedCost = line?.manual_unit_cost;
    const unitCost = manualUnitCost(suppliedCost);
    if (!skuId || !allowed.has(skuId) || seen.has(skuId) || expected === null || counted === null) {
      throw new HttpError(400, "wip_count_invalid_line");
    }
    if (suppliedCost !== "" && suppliedCost !== null && suppliedCost !== undefined && unitCost === null) {
      throw new HttpError(400, "wip_count_invalid_unit_cost");
    }
    seen.add(skuId);
    const pool = await trx("erp.wip_dept_balance").select("qty_pairs", "cost_value")
      .where({ branch_id: req.branchId, stock_state: WIP_ON_HAND, sku_id: skuId, dept_id: deptId })
      .forUpdate().first();
    const latestLedger = await trx("erp.wip_dept_ledger")
      .where({ branch_id: req.branchId, stock_state: WIP_ON_HAND, sku_id: skuId, dept_id: deptId })
      .max({ id: "id" }).first();
    const current = Number(pool?.qty_pairs || 0);
    if (expected !== current) throw new HttpError(409, "wip_count_stale_balance");
    if (counted > current && !(resolveWipUnitCost(pool) > 0)
      && !(await recentWipUnitCostTx(trx, req.branchId, skuId, deptId) > 0) && !(unitCost > 0)) {
      throw new HttpError(400, "wip_count_missing_cost");
    }
    normalized.push({ skuId, expected, counted, cost: Number(pool?.cost_value || 0), ledgerId: Number(latestLedger?.id || 0),
      manualAdded: !automatic.has(skuId), manualCost: unitCost });
  }
  if (!normalized.some((line) => line.expected !== line.counted)) {
    throw new HttpError(400, "wip_count_no_variance");
  }
  const canCreate = canAccessScope(req, "VOUCHER", TYPE, "create");
  const canApprove = req.user?.isAdmin === true || canAccessScope(req, "VOUCHER", TYPE, "approve");
  const policyRequiresApproval = await resolveVoucherApprovalRequiredTx({ trx, voucherTypeCode: TYPE, action: "create" });
  const queued = !canCreate || (policyRequiresApproval && !canApprove);
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?), ?::integer)", [TYPE, req.branchId]);
  const latest = await trx("erp.voucher_header").where({ branch_id: req.branchId, voucher_type_code: TYPE })
    .max({ no: "voucher_no" }).first();
  const voucherNo = Number(latest?.no || 0) + 1;
  const [header] = await trx("erp.voucher_header").insert({
    voucher_type_code: TYPE, voucher_no: voucherNo, branch_id: req.branchId,
    voucher_date: countDate, status: queued ? "PENDING" : "APPROVED",
    created_by: req.user.id, approved_by: queued ? null : req.user.id,
    approved_at: queued ? null : trx.fn.now(), remarks: reasonNotes,
  }).returning(["id"]);
  const voucherId = Number(header.id);
  await trx("erp.wip_count_header").insert({ voucher_id: voucherId, dept_id: deptId, reason_code_id: reasonCodeId, reason_notes: reasonNotes });
  await trx("erp.voucher_line").insert(normalized.map((line, index) => ({
    voucher_header_id: voucherId, line_no: index + 1, line_kind: "SKU", sku_id: line.skuId,
    qty: line.counted, meta: { system_qty: line.expected, system_cost: line.cost, system_ledger_id: line.ledgerId,
      manual_added: line.manualAdded, manual_unit_cost: line.manualCost },
  })));
  if (queued) {
    await trx("erp.approval_request").insert({
      branch_id: req.branchId, request_type: "VOUCHER", entity_type: "VOUCHER",
      entity_id: String(voucherId), summary: `Department WIP count (Stock Count #${voucherNo})`,
      new_value: { action: "create", voucher_type_code: TYPE, voucher_id: voucherId, wip_count: true,
        dept_id: deptId, reason_code_id: reasonCodeId, reason_notes: reasonNotes,
        lines: normalized.map(({ skuId, expected, counted, manualAdded, manualCost }) => ({ sku_id: skuId, system_qty: expected,
          counted_qty: counted, manual_added: manualAdded, manual_unit_cost: manualCost })) },
      requested_by: req.user.id,
    });
  } else {
    await applyDepartmentWipCountTx({ trx, voucherId });
  }
  await insertActivityLog(trx, {
    branch_id: req.branchId, user_id: req.user.id, entity_type: "VOUCHER",
    entity_id: voucherId, voucher_type_code: TYPE, action: "CREATE",
    context: { message: `${req.user.id} performed CREATE on ${voucherId} at ${new Date().toISOString()}.`, pending_approval: queued },
  });
  return { id: voucherId, voucherNo, status: queued ? "PENDING" : "APPROVED",
    queuedForApproval: queued, permissionReroute: !canCreate };
});

module.exports = { TYPE, REASON_CODE, loadDepartmentWipCountDepartments,
  isDepartmentWipCountReasonTx, loadDepartmentWipCountDetails,
  loadDepartmentWipCountArticles, loadDepartmentWipCountCandidates,
  createDepartmentWipCount, applyDepartmentWipCountTx };
