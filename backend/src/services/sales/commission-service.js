const { HttpError } = require("../../middleware/errors/http-error");

const SALES_VOUCHER_CODE = "SALES_VOUCHER";
const PRECEDENCE = ["SKU", "SUBGROUP", "GROUP", "ALL"];
const PAIRS_PER_DOZEN = 12;
const BASIS = {
  NET_SALES_PERCENT: "NET_SALES_PERCENT",
  GROSS_MARGIN_PERCENT: "GROSS_MARGIN_PERCENT",
  FIXED_PER_UNIT: "FIXED_PER_UNIT",
  FIXED_PER_INVOICE: "FIXED_PER_INVOICE",
};

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveSalesHeaderPayload = (body = {}) => {
  const source = body.sales || body.sales_header || {};
  return {
    sale_mode: String(source.sale_mode || "DIRECT").trim().toUpperCase(),
    payment_type: String(source.payment_type || "CASH").trim().toUpperCase(),
    customer_party_id: source.customer_party_id ? Number(source.customer_party_id) : null,
    customer_name: source.customer_name ? String(source.customer_name).trim() : null,
    customer_phone_number: source.customer_phone_number ? String(source.customer_phone_number).trim() : null,
    salesman_employee_id: source.salesman_employee_id ? Number(source.salesman_employee_id) : (body.salesman_employee_id ? Number(body.salesman_employee_id) : null),
    linked_sales_order_id: source.linked_sales_order_id ? Number(source.linked_sales_order_id) : null,
    payment_due_date: source.payment_due_date || null,
    receive_into_account_id: source.receive_into_account_id ? Number(source.receive_into_account_id) : null,
    payment_received_amount: toNumber(source.payment_received_amount, 0),
    delivery_method: String(source.delivery_method || "CUSTOMER_PICKUP").trim().toUpperCase(),
    extra_discount: toNumber(source.extra_discount, 0),
  };
};

const resolveSalesLinePayload = (line = {}) => {
  const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
  const rowStatus = String(meta.row_status || line.row_status || line.status || "LOOSE")
    .trim()
    .toUpperCase();
  const isPacked = Boolean(meta.is_packed) || rowStatus === "PACKED";
  const saleQtyRaw = meta.sale_qty ?? (toNumber(line.qty, 0) > 0 ? line.qty : 0);
  const returnQtyRaw = meta.return_qty ?? 0;
  const saleQty = toNumber(saleQtyRaw, 0);
  const returnQty = toNumber(returnQtyRaw, 0);
  const rowAmount = toNumber(meta.total_amount ?? line.amount, 0);
  const grossMarginAmount = toNumber(meta.gross_margin_amount ?? meta.gross_margin ?? 0, 0);
  return {
    row_status: rowStatus,
    is_packed: isPacked,
    sale_qty: saleQty,
    return_qty: returnQty,
    return_reason_id: meta.return_reason_id ? Number(meta.return_reason_id) : null,
    pair_rate: toNumber(meta.pair_rate ?? line.rate, 0),
    pair_discount: toNumber(meta.pair_discount, 0),
    total_discount: toNumber(meta.total_discount, 0),
    total_amount: rowAmount,
    gross_margin_amount: grossMarginAmount,
  };
};

const buildItemContext = async (trx, skuIds) => {
  if (!skuIds.length) return new Map();
  const rows = await trx("erp.skus as s")
    .join("erp.variants as v", "s.variant_id", "v.id")
    .join("erp.items as i", "v.item_id", "i.id")
    .select("s.id as sku_id", "i.id as item_id", "i.subgroup_id", "i.group_id", "i.base_uom_id")
    .whereIn("s.id", skuIds);
  return new Map(rows.map((row) => [Number(row.sku_id), row]));
};

const buildConversionMap = async (trx, uomPairs) => {
  if (!uomPairs.length) return new Map();
  const uniqueUomIds = [...new Set(uomPairs.flatMap(([fromUomId, toUomId]) => [Number(fromUomId), Number(toUomId)]).filter((id) => Number.isFinite(id) && id > 0))];
  if (!uniqueUomIds.length) return new Map();
  const rows = await trx("erp.uom_conversions")
    .select("from_uom_id", "to_uom_id", "factor")
    .whereIn("from_uom_id", uniqueUomIds)
    .whereIn("to_uom_id", uniqueUomIds)
    .andWhere({ is_active: true });
  const map = new Map();
  rows.forEach((row) => {
    map.set(`${Number(row.from_uom_id)}:${Number(row.to_uom_id)}`, toNumber(row.factor, 0));
  });
  return map;
};

const convertToBaseQty = ({ qty, fromUomId, baseUomId, conversionMap, t }) => {
  const numericQty = toNumber(qty, 0);
  if (!baseUomId || !fromUomId || Number(fromUomId) === Number(baseUomId)) return numericQty;
  const directFactor = conversionMap.get(`${Number(fromUomId)}:${Number(baseUomId)}`);
  if (Number.isFinite(directFactor) && directFactor > 0) return numericQty * directFactor;
  const reverseFactor = conversionMap.get(`${Number(baseUomId)}:${Number(fromUomId)}`);
  if (Number.isFinite(reverseFactor) && reverseFactor > 0) return numericQty / reverseFactor;
  throw new HttpError(400, t("error_invalid_value"));
};

// Loads active commission rules for an employee filtered by commission_type.
const buildRuleMatchIndex = async (trx, salesmanEmployeeId, commissionType) => {
  if (!salesmanEmployeeId) return [];
  return trx("erp.employee_commission_rules as ecr")
    .select(
      "id",
      "apply_on",
      "sku_id",
      "subgroup_id",
      "group_id",
      "commission_basis",
      trx.raw(`COALESCE(NULLIF(to_jsonb(ecr)->>'rate_type', ''), 'PER_PAIR') as rate_type`),
      "value",
      "reverse_on_returns",
      "value_type",
    )
    .where({
      "ecr.employee_id": salesmanEmployeeId,
      "ecr.status": "active",
      "ecr.commission_type": commissionType,
    });
};

const pickRuleByPrecedence = (rules, basis, context) => {
  for (const scope of PRECEDENCE) {
    const matched = rules.find((rule) => {
      if (String(rule.commission_basis) !== basis) return false;
      if (String(rule.apply_on) !== scope) return false;
      if (scope === "SKU") return Number(rule.sku_id) === Number(context.skuId);
      if (scope === "SUBGROUP") return Number(rule.subgroup_id) === Number(context.subgroupId);
      if (scope === "GROUP") return Number(rule.group_id) === Number(context.groupId);
      return true;
    });
    if (matched) return { rule: matched, precedence: scope };
  }
  return null;
};

const evaluateSign = ({ saleQty, returnQty, reverseOnReturns }) => {
  if (toNumber(saleQty, 0) > 0) return 1;
  if (toNumber(returnQty, 0) > 0) return reverseOnReturns ? -1 : 0;
  return 0;
};

const computeLineCommissionBreakdown = ({ line, salesLine, matchedRules, qtyInPair }) => {
  const entries = [];
  let lineTotal = 0;

  matchedRules.forEach(({ rule, precedence }) => {
    const sign = evaluateSign({
      saleQty: salesLine.sale_qty,
      returnQty: salesLine.return_qty,
      reverseOnReturns: Boolean(rule.reverse_on_returns),
    });
    if (sign === 0) return;

    const rate = toNumber(rule.value, 0);
    const basis = String(rule.commission_basis || "");
    let computed = 0;

    if (basis === BASIS.NET_SALES_PERCENT) {
      computed = roundMoney(toNumber(salesLine.total_amount, 0) * (rate / 100) * sign);
    } else if (basis === BASIS.GROSS_MARGIN_PERCENT) {
      computed = roundMoney(toNumber(salesLine.gross_margin_amount, 0) * (rate / 100) * sign);
    } else if (basis === BASIS.FIXED_PER_UNIT) {
      const rateType = String(rule.rate_type || "PER_PAIR").trim().toUpperCase();
      const unitQty = rateType === "PER_DOZEN"
        ? Number((toNumber(qtyInPair, 0) / PAIRS_PER_DOZEN).toFixed(6))
        : toNumber(qtyInPair, 0);
      computed = roundMoney(unitQty * rate * sign);
    }

    if (basis === BASIS.FIXED_PER_INVOICE) {
      entries.push({
        rule_id: Number(rule.id),
        basis,
        precedence,
        rate,
        value_type: String(rule.value_type || ""),
        computed_amount: 0,
        deferred_invoice_amount: true,
      });
      return;
    }

    lineTotal = roundMoney(lineTotal + computed);
    entries.push({
      rule_id: Number(rule.id),
      basis,
      precedence,
      rate,
      value_type: String(rule.value_type || ""),
      computed_amount: computed,
      deferred_invoice_amount: false,
    });
  });

  return { entries, lineTotal };
};

const applyInvoiceLevelCommissions = ({ lineBreakdowns, matchedRulesByLine, salesLines }) => {
  const deferred = new Map();
  matchedRulesByLine.forEach((matched, idx) => {
    matched.forEach(({ rule, precedence }) => {
      if (String(rule.commission_basis) !== BASIS.FIXED_PER_INVOICE) return;
      const sign = evaluateSign({
        saleQty: salesLines[idx].sale_qty,
        returnQty: salesLines[idx].return_qty,
        reverseOnReturns: Boolean(rule.reverse_on_returns),
      });
      const key = Number(rule.id);
      if (!deferred.has(key)) {
        deferred.set(key, {
          firstLineIdx: idx,
          rule,
          precedence,
          hasSale: false,
          hasReturnReverse: false,
        });
      }
      const row = deferred.get(key);
      if (sign > 0) row.hasSale = true;
      if (sign < 0) row.hasReturnReverse = true;
    });
  });

  deferred.forEach((state) => {
    const rate = toNumber(state.rule.value, 0);
    const amount = state.hasSale ? roundMoney(rate) : (state.hasReturnReverse ? roundMoney(rate * -1) : 0);
    if (!amount) return;
    const target = lineBreakdowns[state.firstLineIdx];
    const invoiceEntry = target.entries.find((entry) => entry.rule_id === Number(state.rule.id) && entry.basis === BASIS.FIXED_PER_INVOICE);
    if (!invoiceEntry) return;
    invoiceEntry.computed_amount = amount;
    invoiceEntry.deferred_invoice_amount = false;
    target.lineTotal = roundMoney(target.lineTotal + amount);
  });
};

// Shared core: calculates commission for one employee's rules against a set of lines.
// Lines must have sku_id, qty, uom_id, and meta with is_packed/sale_qty/return_qty/total_amount/gross_margin_amount.
// Returns { totalCommission, lineBreakdowns } — lineBreakdowns is indexed by the original lines array position.
const computeEmployeeCommissionOnLines = async ({ trx, rules, lines, t }) => {
  if (!rules.length) return { totalCommission: 0, lineBreakdowns: [] };

  const skuLines = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => String(line.line_kind || "").toUpperCase() === "SKU" && Number(line.sku_id) > 0);

  if (!skuLines.length) return { totalCommission: 0, lineBreakdowns: [] };

  const skuIds = [...new Set(skuLines.map(({ line }) => Number(line.sku_id)))];
  const itemContextMap = await buildItemContext(trx, skuIds);

  const uomPairs = skuLines
    .map(({ line }) => {
      const itemContext = itemContextMap.get(Number(line.sku_id));
      const fromUomId = Number(line.uom_id || itemContext?.base_uom_id || 0);
      const toUomId = Number(itemContext?.base_uom_id || 0);
      return [fromUomId, toUomId];
    })
    .filter(([fromUomId, toUomId]) => Number.isFinite(fromUomId) && Number.isFinite(toUomId) && fromUomId > 0 && toUomId > 0);
  const conversionMap = await buildConversionMap(trx, uomPairs);

  const matchedRulesByLine = [];
  const lineBreakdowns = [];

  for (const { line, idx } of skuLines) {
    const context = itemContextMap.get(Number(line.sku_id));
    if (!context) continue;
    const salesLine = resolveSalesLinePayload(line);
    if (!salesLine.is_packed) continue;

    // Sales voucher SKU lines store qty in pairs (base units) but uom_id may be a
    // non-base unit (e.g. dozen). Using line.qty with line.uom_id would double-convert
    // (pairs → dozens → pairs × factor). Use meta.total_pairs when present; fall back
    // to UOM conversion for other contexts (e.g. transfer lines) that lack that field.
    const totalPairsFromMeta = line.meta?.total_pairs;
    const qtyInBaseUnit = totalPairsFromMeta != null
      ? toNumber(totalPairsFromMeta, 0)
      : convertToBaseQty({
          qty: toNumber(line.qty, 0),
          fromUomId: Number(line.uom_id || context.base_uom_id || 0),
          baseUomId: Number(context.base_uom_id || 0),
          conversionMap,
          t,
        });

    const matchedRules = [BASIS.NET_SALES_PERCENT, BASIS.GROSS_MARGIN_PERCENT, BASIS.FIXED_PER_UNIT, BASIS.FIXED_PER_INVOICE]
      .map((basis) =>
        pickRuleByPrecedence(rules, basis, {
          skuId: Number(line.sku_id),
          subgroupId: Number(context.subgroup_id || 0),
          groupId: Number(context.group_id || 0),
        }),
      )
      .filter(Boolean);

    if (!matchedRules.length) continue;

    matchedRulesByLine[idx] = matchedRules;
    lineBreakdowns[idx] = computeLineCommissionBreakdown({
      line,
      salesLine,
      matchedRules,
      qtyInPair: qtyInBaseUnit,
    });
  }

  applyInvoiceLevelCommissions({
    lineBreakdowns,
    matchedRulesByLine,
    salesLines: lines.map((line) => resolveSalesLinePayload(line)),
  });

  let totalCommission = 0;
  lines.forEach((_, idx) => {
    const bd = lineBreakdowns[idx];
    if (!bd) return;
    totalCommission = roundMoney(totalCommission + bd.lineTotal);
  });

  return { totalCommission, lineBreakdowns };
};

const enrichSalesVoucherLines = async ({ trx, lines, salesmanEmployeeId, t }) => {
  const skuLines = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => String(line.line_kind || "").toUpperCase() === "SKU" && Number(line.sku_id) > 0);

  if (!salesmanEmployeeId || !skuLines.length) {
    return { lines, totalCommission: 0 };
  }

  const rules = await buildRuleMatchIndex(trx, salesmanEmployeeId, "SALESMAN_SALE");
  const { totalCommission, lineBreakdowns } = await computeEmployeeCommissionOnLines({ trx, rules, lines, t });

  const enriched = lines.map((line, idx) => {
    const breakdown = lineBreakdowns[idx];
    if (!breakdown) return line;
    const currentMeta = line.meta && typeof line.meta === "object" ? line.meta : {};
    return {
      ...line,
      meta: {
        ...currentMeta,
        commission: {
          total_amount: breakdown.lineTotal,
          entries: breakdown.entries,
        },
      },
    };
  });

  return { lines: enriched, totalCommission };
};

// Normalizes stock-transfer lines so they look like packed sales lines for commission calculation.
// Transfer lines from erp.voucher_line have qty/rate/amount but no sale meta.
const normalizeTransferLinesForCommission = (lines) =>
  lines.map((line) => {
    const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
    // Transfer lines store qty in the ENTERED unit (e.g. 2 dozen) and the pair count
    // separately in meta.transfer_qty_pairs (24). Surface it as total_pairs so the
    // commission math reads pairs directly instead of depending on line.uom_id — a
    // caller that forgets to select uom_id would otherwise silently treat "2 dozen"
    // as "2 pairs" (and a PER_DOZEN rule would then divide that by 12 again).
    const transferQtyPairs = toNumber(meta.transfer_qty_pairs, 0);
    return {
      ...line,
      meta: {
        ...meta,
        ...(transferQtyPairs > 0 ? { total_pairs: transferQtyPairs } : {}),
        row_status: "PACKED",
        is_packed: true,
        sale_qty: toNumber(line.qty, 0),
        return_qty: 0,
        total_amount: toNumber(line.amount || (toNumber(line.qty, 0) * toNumber(line.rate, 0)), 0),
        gross_margin_amount: 0,
      },
    };
  });

// Normalizes production output so it looks like packed sales lines for commission
// calculation. Callers pass the pair count that was actually posted into stock and
// the value posted with it, so there is no UOM ambiguity here — production works in
// pairs end to end. is_packed is forced because the flag is meaningless for
// manufactured output but the shared calculator skips lines without it.
const normalizeProductionLinesForCommission = (lines) =>
  lines.map((line) => {
    const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
    const totalPairs = toNumber(
      meta.total_pairs ?? line.total_pairs ?? line.qty,
      0,
    );
    return {
      ...line,
      line_kind: "SKU",
      meta: {
        ...meta,
        total_pairs: totalPairs,
        row_status: "PACKED",
        is_packed: true,
        sale_qty: totalPairs,
        return_qty: 0,
        total_amount: toNumber(line.amount, 0),
        gross_margin_amount: 0,
      },
    };
  });

// Computes BRANCH_SALE or TRANSFER ledger entries for all eligible employees at a branch.
// For BRANCH_SALE: lines are sales voucher lines (already have packed meta).
// For TRANSFER:    lines are stock-transfer SKU lines (caller must normalize first).
const computeLedgerEntriesForBranch = async ({ trx, lines, branchId, commissionType, t }) => {
  if (!branchId || !lines.length) return [];

  const branchEmployees = await trx("erp.employee_branch")
    .where({ branch_id: branchId })
    .select("employee_id");

  if (!branchEmployees.length) return [];

  const entries = [];

  for (const { employee_id } of branchEmployees) {
    const rules = await buildRuleMatchIndex(trx, employee_id, commissionType);
    if (!rules.length) continue;

    const { totalCommission, lineBreakdowns } = await computeEmployeeCommissionOnLines({ trx, rules, lines, t });
    if (totalCommission === 0) continue;

    const linesDetail = lines
      .map((line, idx) => {
        const bd = lineBreakdowns[idx];
        if (!bd || !bd.entries.length) return null;
        return {
          sku_id: line.sku_id,
          line_no: line.line_no,
          total_amount: bd.lineTotal,
          entries: bd.entries,
        };
      })
      .filter(Boolean);

    entries.push({
      employee_id: Number(employee_id),
      commission_type: commissionType,
      total_amount: totalCommission,
      lines_detail: linesDetail,
    });
  }

  return entries;
};

// Upserts commission ledger rows (one per employee+type per voucher).
const writeCommissionLedgerTx = async (trx, voucherId, entries) => {
  if (!entries.length) return;
  const rows = entries.map((e) => ({
    voucher_id: voucherId,
    employee_id: e.employee_id,
    commission_type: e.commission_type,
    total_amount: e.total_amount,
    lines_detail: JSON.stringify(e.lines_detail || []),
  }));
  await trx("erp.commission_ledger")
    .insert(rows)
    .onConflict(["voucher_id", "employee_id", "commission_type"])
    .merge(["total_amount", "lines_detail"]);
};

const buildSalesLineRows = (lines = []) =>
  lines
    .map((line, index) => ({ line, lineNo: Number(line.line_no || index + 1) }))
    .filter(({ line }) => String(line.line_kind || "").toUpperCase() === "SKU" && Number(line.sku_id) > 0)
    .map(({ line, lineNo }) => ({
      line_no: lineNo,
      payload: resolveSalesLinePayload(line),
    }));

// ---------------------------------------------------------------------------
// SALESMAN_SALE storage
//
// Unlike the other commission types, salesman commission is not kept in
// erp.commission_ledger. It lives on the sale itself: each SKU line's
// meta.commission breakdown, plus one auto-generated EMPLOYEE voucher_line that
// is what the employee ledger and balances reports actually read.
//
// The EMPLOYEE row's storage convention (absolute amount/rate, direction carried
// in meta.debit/meta.credit) is single-sourced here so the save path and the
// retroactive recompute cannot drift apart.
// ---------------------------------------------------------------------------

const SALES_COMMISSION_LINE_DESCRIPTION = "Auto sales commission accrual";

const buildAutoSalesCommissionLineRow = ({
  salesmanEmployeeId,
  totalCommission,
  lineNo,
  description = SALES_COMMISSION_LINE_DESCRIPTION,
}) => {
  const normalizedCommission = roundMoney(toNumber(totalCommission, 0));
  const normalizedAmount = roundMoney(Math.abs(normalizedCommission));
  return {
    line_no: Number(lineNo),
    line_kind: "EMPLOYEE",
    employee_id: Number(salesmanEmployeeId),
    qty: 0,
    rate: normalizedAmount,
    amount: normalizedAmount,
    reference_no: null,
    meta: {
      auto_sales_commission: true,
      sales_commission: true,
      debit: normalizedCommission > 0 ? normalizedAmount : 0,
      credit: normalizedCommission < 0 ? normalizedAmount : 0,
      description,
    },
  };
};

const isAutoSalesCommissionLine = (line) => {
  if (String(line?.line_kind || "").toUpperCase() !== "EMPLOYEE") return false;
  const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
  return meta.auto_sales_commission === true || meta.auto_sales_commission === "true";
};

// Recomputes a single approved sales voucher's salesman commission against
// TODAY'S active rules, and returns a write descriptor rather than writing.
// Read-only on purpose: the approvals queue puts time between plan and apply.
//
// Self-loading — everything enrichSalesVoucherLines needs is already persisted in
// voucher_line.meta, and the salesman is on erp.sales_header. That is what makes a
// retroactive recompute possible without the original request payload.
const planSalesmanCommissionRecomputeTx = async ({ db, voucherId, t }) => {
  const normalizedVoucherId = Number(voucherId);
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0) return null;

  const header = await db("erp.voucher_header")
    .select("id", "voucher_type_code", "status")
    .where({ id: normalizedVoucherId })
    .first();
  if (!header) return null;
  if (String(header.voucher_type_code || "").toUpperCase() !== SALES_VOUCHER_CODE) return null;
  if (String(header.status || "").toUpperCase() !== "APPROVED") return null;

  const salesHeader = await db("erp.sales_header")
    .select("salesman_employee_id")
    .where({ voucher_id: normalizedVoucherId })
    .first();
  const salesmanEmployeeId = Number(salesHeader?.salesman_employee_id || 0);
  if (!(salesmanEmployeeId > 0)) return null;

  const allLines = await db("erp.voucher_line")
    .select("id", "line_no", "line_kind", "sku_id", "employee_id", "uom_id", "qty", "rate", "amount", "meta")
    .where({ voucher_header_id: normalizedVoucherId })
    .orderBy("line_no", "asc");

  const skuLines = allLines.filter(
    (line) => String(line.line_kind || "").toUpperCase() === "SKU" && Number(line.sku_id) > 0,
  );
  if (!skuLines.length) return null;

  const employeeLine = allLines.find(isAutoSalesCommissionLine) || null;

  const { lines: enrichedLines, totalCommission } = await enrichSalesVoucherLines({
    trx: db,
    lines: skuLines,
    salesmanEmployeeId,
    t,
  });

  // enrichSalesVoucherLines only ADDS meta.commission. A line whose rule has since
  // been deleted would keep its stale breakdown while the header total drops, so
  // the drill-down would silently disagree with the employee ledger. Null means
  // "delete the key".
  const skuLineUpdates = [];
  enrichedLines.forEach((enriched, index) => {
    const original = skuLines[index];
    const originalMeta =
      original?.meta && typeof original.meta === "object" ? original.meta : {};
    const nextCommission = enriched?.meta?.commission || null;
    const hadCommission = originalMeta.commission != null;
    if (!nextCommission && !hadCommission) return;
    skuLineUpdates.push({
      voucher_line_id: Number(original.id),
      meta_commission: nextCommission,
    });
  });

  const previousAmount = employeeLine
    ? (() => {
        const meta = employeeLine.meta && typeof employeeLine.meta === "object" ? employeeLine.meta : {};
        const debit = toNumber(meta.debit, 0);
        const credit = toNumber(meta.credit, 0);
        // Mirrors RESOLVED_DEBIT_SQL in hr-payroll-report-service: when neither
        // direction is set the reports fall back to the raw amount column.
        if (debit === 0 && credit === 0) return toNumber(employeeLine.amount, 0);
        return roundMoney(debit - credit);
      })()
    : null;

  return {
    voucher_id: normalizedVoucherId,
    employee_id: salesmanEmployeeId,
    previous_amount: previousAmount,
    new_amount: roundMoney(toNumber(totalCommission, 0)),
    write: {
      voucher_id: normalizedVoucherId,
      salesman_employee_id: salesmanEmployeeId,
      total_commission: roundMoney(toNumber(totalCommission, 0)),
      sku_line_updates: skuLineUpdates,
      employee_line_id: employeeLine ? Number(employeeLine.id) : null,
    },
  };
};

// Executes a descriptor from planSalesmanCommissionRecomputeTx.
//
// Deliberately never touches qty/rate/amount/sku_id/line_no on a SKU line: sales
// GL posting sums SKU line amounts only, so leaving them alone is what keeps a
// commission rewrite GL-neutral.
const applySalesmanCommissionWriteTx = async ({ trx, write, provenance = null }) => {
  if (!write) return { skuLinesUpdated: 0, employeeLineAction: "none" };

  let skuLinesUpdated = 0;
  for (const update of write.sku_line_updates || []) {
    // Re-read inside the transaction and merge: SKU meta carries uom_factor_to_base,
    // discounts, sales_order_line_id and movement_kind that must survive.
    const row = await trx("erp.voucher_line")
      .select("meta")
      .where({ id: update.voucher_line_id })
      .first();
    if (!row) continue;
    const currentMeta = row.meta && typeof row.meta === "object" ? row.meta : {};
    const nextMeta = { ...currentMeta };
    if (update.meta_commission) {
      nextMeta.commission = update.meta_commission;
    } else {
      delete nextMeta.commission;
    }
    await trx("erp.voucher_line").where({ id: update.voucher_line_id }).update({ meta: nextMeta });
    skuLinesUpdated += 1;
  }

  const totalCommission = roundMoney(toNumber(write.total_commission, 0));
  const built = buildAutoSalesCommissionLineRow({
    salesmanEmployeeId: write.salesman_employee_id,
    totalCommission,
    lineNo: 0,
  });
  const metaPatch = {
    ...built.meta,
    ...(provenance ? { commission_recalc: provenance } : {}),
  };

  if (write.employee_line_id) {
    const row = await trx("erp.voucher_line")
      .select("meta")
      .where({ id: write.employee_line_id })
      .first();
    const currentMeta = row?.meta && typeof row.meta === "object" ? row.meta : {};
    // amount/rate move together with the meta directions. Zeroing only the meta
    // would make the reports fall back to the stale amount column and re-credit it.
    await trx("erp.voucher_line")
      .where({ id: write.employee_line_id })
      .update({
        amount: built.amount,
        rate: built.rate,
        meta: { ...currentMeta, ...metaPatch },
      });
    return { skuLinesUpdated, employeeLineAction: "updated" };
  }

  // Nothing to insert for a zero result — an absent line and a zero line read the same.
  if (Math.abs(totalCommission) < 0.005) {
    return { skuLinesUpdated, employeeLineAction: "none" };
  }

  // Vouchers created through the generic voucher-engine route get SKU commission
  // but never an EMPLOYEE line. Lock the header first so max(line_no)+1 cannot
  // race a concurrent edit into a UNIQUE(voucher_header_id, line_no) violation.
  await trx("erp.voucher_header").where({ id: write.voucher_id }).forUpdate().first();
  const maxRow = await trx("erp.voucher_line")
    .where({ voucher_header_id: write.voucher_id })
    .max("line_no as max_line_no")
    .first();
  const nextLineNo = Number(maxRow?.max_line_no || 0) + 1;

  await trx("erp.voucher_line").insert({
    voucher_header_id: write.voucher_id,
    line_no: nextLineNo,
    line_kind: "EMPLOYEE",
    employee_id: Number(write.salesman_employee_id),
    qty: 0,
    rate: built.rate,
    amount: built.amount,
    meta: metaPatch,
  });
  return { skuLinesUpdated, employeeLineAction: "inserted" };
};

const prepareSalesVoucherData = async ({ trx, voucherTypeCode, body, lines, t }) => {
  if (String(voucherTypeCode || "").toUpperCase() !== SALES_VOUCHER_CODE) {
    return {
      lines,
      salesHeader: null,
      salesLines: [],
      totalCommission: 0,
    };
  }

  const salesHeader = resolveSalesHeaderPayload(body || {});
  const enrichedResult = await enrichSalesVoucherLines({
    trx,
    lines,
    salesmanEmployeeId: salesHeader.salesman_employee_id,
    t,
  });
  const salesLines = buildSalesLineRows(enrichedResult.lines);

  return {
    lines: enrichedResult.lines,
    salesHeader,
    salesLines,
    totalCommission: enrichedResult.totalCommission,
  };
};

module.exports = {
  prepareSalesVoucherData,
  computeLedgerEntriesForBranch,
  normalizeTransferLinesForCommission,
  normalizeProductionLinesForCommission,
  writeCommissionLedgerTx,
  buildAutoSalesCommissionLineRow,
  isAutoSalesCommissionLine,
  planSalesmanCommissionRecomputeTx,
  applySalesmanCommissionWriteTx,
  SALES_VOUCHER_CODE,
  SALES_COMMISSION_LINE_DESCRIPTION,
};
