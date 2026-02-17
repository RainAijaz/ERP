const { HttpError } = require("../../middleware/errors/http-error");

const SALES_VOUCHER_CODE = "SALES_VOUCHER";
const PRECEDENCE = ["SKU", "SUBGROUP", "GROUP", "ALL"];
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
  const isPacked = Boolean(meta.is_packed);
  const saleQtyRaw = meta.sale_qty ?? (toNumber(line.qty, 0) > 0 ? line.qty : 0);
  const returnQtyRaw = meta.return_qty ?? 0;
  const saleQty = toNumber(saleQtyRaw, 0);
  const returnQty = toNumber(returnQtyRaw, 0);
  const rowAmount = toNumber(meta.total_amount ?? line.amount, 0);
  const grossMarginAmount = toNumber(meta.gross_margin_amount ?? meta.gross_margin ?? 0, 0);
  return {
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
  throw new HttpError(400, t("error_invalid_value") || "Invalid value");
};

const buildRuleMatchIndex = async (trx, salesmanEmployeeId) => {
  if (!salesmanEmployeeId) return [];
  return trx("erp.employee_commission_rules")
    .select("id", "apply_on", "sku_id", "subgroup_id", "group_id", "commission_basis", "value", "reverse_on_returns", "value_type")
    .where({ employee_id: salesmanEmployeeId, status: "active" });
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

const computeLineCommissionBreakdown = ({ line, salesLine, matchedRules, qtyInBaseUnit }) => {
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
      computed = roundMoney(toNumber(qtyInBaseUnit, 0) * rate * sign);
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

const enrichSalesVoucherLines = async ({ trx, lines, salesmanEmployeeId, t }) => {
  const skuLines = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => String(line.line_kind || "").toUpperCase() === "SKU" && Number(line.sku_id) > 0);
  if (!salesmanEmployeeId || !skuLines.length) {
    return {
      lines,
      totalCommission: 0,
    };
  }

  const skuIds = [...new Set(skuLines.map(({ line }) => Number(line.sku_id)))];
  const itemContextMap = await buildItemContext(trx, skuIds);
  const rules = await buildRuleMatchIndex(trx, salesmanEmployeeId);

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
  let totalCommission = 0;

  for (const { line, idx } of skuLines) {
    const context = itemContextMap.get(Number(line.sku_id));
    if (!context) continue;
    const salesLine = resolveSalesLinePayload(line);
    const qtyForRule = toNumber(line.qty, 0);
    const qtyInBaseUnit = convertToBaseQty({
      qty: qtyForRule,
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

    matchedRulesByLine[idx] = matchedRules;
    const breakdown = computeLineCommissionBreakdown({
      line,
      salesLine,
      matchedRules,
      qtyInBaseUnit,
    });
    lineBreakdowns[idx] = breakdown;
  }

  applyInvoiceLevelCommissions({
    lineBreakdowns,
    matchedRulesByLine,
    salesLines: lines.map((line) => resolveSalesLinePayload(line)),
  });

  const enriched = lines.map((line, idx) => {
    const breakdown = lineBreakdowns[idx];
    if (!breakdown) return line;
    totalCommission = roundMoney(totalCommission + breakdown.lineTotal);
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

  return {
    lines: enriched,
    totalCommission,
  };
};

const buildSalesLineRows = (lines = []) =>
  lines
    .map((line, index) => ({ line, lineNo: Number(line.line_no || index + 1) }))
    .filter(({ line }) => String(line.line_kind || "").toUpperCase() === "SKU" && Number(line.sku_id) > 0)
    .map(({ line, lineNo }) => ({
      line_no: lineNo,
      payload: resolveSalesLinePayload(line),
    }));

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
  SALES_VOUCHER_CODE,
};

