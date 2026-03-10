const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog, queueAuditLog } = require("../../utils/audit-log");
const { toLocalDateOnly } = require("../../utils/date-only");
const { syncVoucherGlPostingTx } = require("../financial/gl-posting-service");
const {
  evaluateSalesDiscountPolicy,
  loadActiveSalesDiscountPolicyMapTx,
} = require("./sales-discount-policy-service");

const SALES_VOUCHER_TYPES = {
  salesOrder: "SALES_ORDER",
  salesVoucher: "SALES_VOUCHER",
};

const SALES_PAYMENT_TYPES = ["CASH", "CREDIT"];
const SALES_MODES = ["DIRECT", "FROM_SO"];
const SALES_DELIVERY_METHODS = ["CUSTOMER_PICKUP", "OUR_DELIVERY"];
const ROW_STATUS_VALUES = ["PACKED", "LOOSE"];
const PAIRS_PER_PACKED_UNIT = 12;

let approvalRequestHasVoucherTypeCodeColumn;

const toDateOnly = toLocalDateOnly;

const normalizeText = (value, max = 1000) => {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
};

const toPositiveInt = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const toNonNegativeNumber = (value, decimals = 2) => {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(decimals));
};

const toPositiveNumber = (value, decimals = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(decimals));
};

const parseVoucherNo = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const normalizePaymentType = (value) => {
  const text = String(value || "CASH")
    .trim()
    .toUpperCase();
  return SALES_PAYMENT_TYPES.includes(text) ? text : "CASH";
};

const normalizeSaleMode = (value) => {
  const text = String(value || "DIRECT")
    .trim()
    .toUpperCase();
  return SALES_MODES.includes(text) ? text : "DIRECT";
};

const normalizeDeliveryMethod = (value) => {
  const text = String(value || "CUSTOMER_PICKUP")
    .trim()
    .toUpperCase();
  return SALES_DELIVERY_METHODS.includes(text) ? text : "CUSTOMER_PICKUP";
};

const normalizeRowStatus = (value) => {
  const text = String(value || "LOOSE")
    .trim()
    .toUpperCase();
  return ROW_STATUS_VALUES.includes(text) ? text : "LOOSE";
};

const toBool = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value || "")
    .trim()
    .toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
};

const approxEq = (a, b, epsilon = 0.0001) =>
  Math.abs(Number(a || 0) - Number(b || 0)) <= epsilon;

const isValidPhoneNumber = (value) => {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^\+?[0-9()\-\s]{7,15}$/.test(text);
};

const pairsFromQty = ({ qty, isPacked }) => {
  const numericQty = Number(qty || 0);
  if (!Number.isFinite(numericQty) || numericQty <= 0) return 0;
  const multiplier = isPacked ? PAIRS_PER_PACKED_UNIT : 1;
  return Number((numericQty * multiplier).toFixed(3));
};

const ensureQtyByStatus = ({ lineNo, qty, isPacked }) => {
  if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) {
    throw new HttpError(
      400,
      `Line ${lineNo}: quantity must be greater than zero`,
    );
  }
  if (isPacked) {
    const doubled = Number((Number(qty) * 2).toFixed(4));
    if (!Number.isInteger(doubled)) {
      throw new HttpError(
        400,
        `Line ${lineNo}: packed quantity must be in 0.5 steps`,
      );
    }
    return;
  }
  if (!Number.isInteger(Number(qty))) {
    throw new HttpError(
      400,
      `Line ${lineNo}: loose quantity must be whole pairs`,
    );
  }
};

const canDo = (req, scopeType, scopeKey, action) => {
  const check = req?.res?.locals?.can;
  if (typeof check !== "function") return false;
  return check(scopeType, scopeKey, action);
};

const canApproveVoucherAction = (req, scopeKey) =>
  req?.user?.isAdmin === true || canDo(req, "VOUCHER", scopeKey, "approve");

const requiresApprovalForAction = async (trx, voucherTypeCode, action) => {
  const policy = await trx("erp.approval_policy")
    .select("requires_approval")
    .where({ entity_type: "VOUCHER_TYPE", entity_key: voucherTypeCode, action })
    .first();
  if (policy) return policy.requires_approval === true;
  if (action !== "create") return false;
  const voucherType = await trx("erp.voucher_type")
    .select("requires_approval")
    .where({ code: voucherTypeCode })
    .first();
  if (!voucherType) throw new HttpError(400, "Invalid voucher type");
  return voucherType.requires_approval === true;
};

const hasApprovalRequestVoucherTypeCodeColumnTx = async (trx) => {
  if (typeof approvalRequestHasVoucherTypeCodeColumn === "boolean") {
    return approvalRequestHasVoucherTypeCodeColumn;
  }
  try {
    approvalRequestHasVoucherTypeCodeColumn = await trx.schema
      .withSchema("erp")
      .hasColumn("approval_request", "voucher_type_code");
    return approvalRequestHasVoucherTypeCodeColumn;
  } catch (err) {
    console.error("Error in SalesVoucherService:", err);
    approvalRequestHasVoucherTypeCodeColumn = false;
    return false;
  }
};

const validateCustomerTx = async ({ trx, req, customerPartyId }) => {
  const normalizedCustomerId = toPositiveInt(customerPartyId);
  if (!normalizedCustomerId) throw new HttpError(400, "Customer is required");

  let query = trx("erp.parties as p")
    .select("p.id", "p.name", "p.phone1")
    .where({ "p.id": normalizedCustomerId, "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','BOTH')");
  query = query.where(function wherePartyScope() {
    this.where("p.branch_id", req.branchId).orWhereExists(
      function wherePartyBranchMap() {
        this.select(1)
          .from("erp.party_branch as pb")
          .whereRaw("pb.party_id = p.id")
          .andWhere("pb.branch_id", req.branchId);
      },
    );
  });
  const customer = await query.first();
  if (!customer)
    throw new HttpError(400, "Customer is invalid for current branch");
  return {
    id: Number(customer.id),
    name: String(customer.name || "").trim(),
    phone1: normalizeText(customer.phone1, 30),
  };
};

const validateSalesmanTx = async ({ trx, req, salesmanEmployeeId }) => {
  const normalizedSalesmanId = toPositiveInt(salesmanEmployeeId);
  if (!normalizedSalesmanId) throw new HttpError(400, "Salesman is required");
  const employee = await trx("erp.employees as e")
    .select("e.id", "e.name")
    .where({ "e.id": normalizedSalesmanId })
    .whereRaw("lower(coalesce(e.status, '')) = 'active'")
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.employee_branch as eb")
        .whereRaw("eb.employee_id = e.id")
        .andWhere("eb.branch_id", req.branchId);
    })
    .first();
  if (!employee)
    throw new HttpError(400, "Salesman is invalid for current branch");
  return {
    id: Number(employee.id),
    name: String(employee.name || "").trim(),
  };
};

const validateReceiveAccountTx = async ({ trx, req, receiveIntoAccountId }) => {
  const normalizedAccountId = toPositiveInt(receiveIntoAccountId);
  if (!normalizedAccountId)
    throw new HttpError(400, "Receive account is required");
  const account = await trx("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .select("a.id", "apc.code as posting_class_code")
    .where({ "a.id": normalizedAccountId, "a.is_active": true })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .andWhere("ab.branch_id", req.branchId);
    })
    .first();
  if (!account)
    throw new HttpError(400, "Receive account is invalid for current branch");
  const postingClassCode = String(account.posting_class_code || "")
    .trim()
    .toLowerCase();
  if (postingClassCode !== "cash") {
    throw new HttpError(400, "Receive account must be a cash account");
  }
  return Number(account.id);
};

const fetchSkuMapTx = async ({ trx, skuIds = [] }) => {
  const normalized = [
    ...new Set((skuIds || []).map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!normalized.length) return new Map();
  const rows = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .select(
      "s.id",
      "s.sku_code",
      "v.sale_rate",
      "i.name as item_name",
      "i.group_id",
      "pg.name as product_group_name",
      "i.base_uom_id",
      "u.name as base_uom_name",
    )
    .whereIn("s.id", normalized)
    .where({ "s.is_active": true, "i.is_active": true });
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const fetchReturnReasonMapTx = async ({ trx, reasonIds = [] }) => {
  const normalized = [
    ...new Set(
      (reasonIds || []).map((id) => toPositiveInt(id)).filter(Boolean),
    ),
  ];
  if (!normalized.length) return new Map();
  const rows = await trx("erp.return_reasons")
    .select("id", "code", "description")
    .whereIn("id", normalized)
    .where({ is_active: true });
  return new Map(rows.map((row) => [Number(row.id), row]));
};

const evaluateVoucherDiscountPolicyTx = async ({
  trx,
  lines = [],
  extraDiscount = 0,
}) => {
  const policyGroupIds = [
    ...new Set(
      (lines || [])
        .map((line) => toPositiveInt(line?.discount_policy?.product_group_id))
        .filter(Boolean),
    ),
  ];

  if (!policyGroupIds.length) {
    return {
      lines: [],
      hasViolation: false,
      violationCount: 0,
      totalExtraDiscount: Number(Number(extraDiscount || 0).toFixed(2)),
      totalEligibleGross: 0,
      totalExcessDiscount: 0,
      maxEffectivePairDiscount: 0,
      maxAllowedPairDiscount: 0,
      violatedGroups: [],
    };
  }

  const policyByGroupId = await loadActiveSalesDiscountPolicyMapTx({
    trx,
    productGroupIds: policyGroupIds,
  });

  return evaluateSalesDiscountPolicy({
    saleLines: (lines || []).map((line) => ({
      lineNo: Number(line.line_no || 0),
      productGroupId: Number(line?.discount_policy?.product_group_id || 0) || null,
      productGroupName: String(line?.discount_policy?.product_group_name || "").trim(),
      qtyPairs: Number(line?.discount_policy?.qty_pairs || 0),
      grossAmount: Number(line?.discount_policy?.gross_amount || 0),
      pairDiscount: Number(line?.discount_policy?.pair_discount || 0),
    })),
    extraDiscount,
    policyByGroupId,
  });
};

const getNextVoucherNoTx = async (trx, branchId, voucherTypeCode) => {
  const latest = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .max({ value: "voucher_no" })
    .first();
  return Number(latest?.value || 0) + 1;
};

const fetchLinkedSalesOrderHeaderTx = async ({
  trx,
  req,
  linkedSalesOrderId,
}) => {
  const normalizedOrderId = toPositiveInt(linkedSalesOrderId);
  if (!normalizedOrderId) throw new HttpError(400, "Sales order is required");

  const row = await trx("erp.voucher_header as vh")
    .join("erp.sales_order_header as soh", "soh.voucher_id", "vh.id")
    .select(
      "vh.id",
      "soh.customer_party_id",
      "soh.salesman_employee_id",
      "soh.receive_into_account_id",
    )
    .where({
      "vh.id": normalizedOrderId,
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": SALES_VOUCHER_TYPES.salesOrder,
      "vh.status": "APPROVED",
    })
    .first();
  if (!row) throw new HttpError(400, "Linked sales order is invalid");
  return {
    id: Number(row.id),
    customerPartyId: Number(row.customer_party_id),
    salesmanEmployeeId: Number(row.salesman_employee_id),
    receiveIntoAccountId: Number(row.receive_into_account_id || 0) || null,
  };
};

const loadSalesOrderReceivableSummaryMapTx = async ({
  trx,
  req,
  salesOrderIds = [],
  excludeSalesVoucherId = null,
}) => {
  const normalizedIds = [
    ...new Set(
      (salesOrderIds || []).map((id) => toPositiveInt(id)).filter(Boolean),
    ),
  ];
  if (!normalizedIds.length) return new Map();

  const excludedVoucherId = toPositiveInt(excludeSalesVoucherId);

  let linkedReceivedQuery = trx("erp.sales_header as sh")
    .join("erp.voucher_header as svh", "svh.id", "sh.voucher_id")
    .select(
      "sh.linked_sales_order_id as sales_order_id",
      trx.raw(
        "sum(coalesce(sh.payment_received_amount, 0)) as linked_received_amount",
      ),
    )
    .whereIn("sh.linked_sales_order_id", normalizedIds)
    .where({
      "svh.branch_id": req.branchId,
      "svh.voucher_type_code": SALES_VOUCHER_TYPES.salesVoucher,
    })
    .whereNot("svh.status", "REJECTED")
    .groupBy("sh.linked_sales_order_id");

  if (excludedVoucherId) {
    linkedReceivedQuery = linkedReceivedQuery.whereNot(
      "svh.id",
      excludedVoucherId,
    );
  }

  const [orderRows, totalRows, linkedReceivedRows] = await Promise.all([
    trx("erp.voucher_header as vh")
      .join("erp.sales_order_header as soh", "soh.voucher_id", "vh.id")
      .select(
        "vh.id as sales_order_id",
        "soh.payment_received_amount as sales_order_advance_amount",
      )
      .whereIn("vh.id", normalizedIds)
      .where({
        "vh.branch_id": req.branchId,
        "vh.voucher_type_code": SALES_VOUCHER_TYPES.salesOrder,
      }),
    trx("erp.voucher_line as vl")
      .select("vl.voucher_header_id as sales_order_id")
      .sum({ total_order_amount: "vl.amount" })
      .whereIn("vl.voucher_header_id", normalizedIds)
      .where({ "vl.line_kind": "SKU" })
      .groupBy("vl.voucher_header_id"),
    linkedReceivedQuery,
  ]);

  const totalByOrderId = new Map(
    (totalRows || []).map((row) => [
      Number(row.sales_order_id),
      Number(row.total_order_amount || 0),
    ]),
  );

  const linkedReceivedByOrderId = new Map(
    (linkedReceivedRows || []).map((row) => [
      Number(row.sales_order_id),
      Number(row.linked_received_amount || 0),
    ]),
  );

  const summaryMap = new Map();
  (orderRows || []).forEach((row) => {
    const orderId = Number(row.sales_order_id || 0);
    const advanceAmount = Number(row.sales_order_advance_amount || 0);
    const totalOrderAmount = Number(totalByOrderId.get(orderId) || 0);
    const linkedReceivedAmount = Number(
      linkedReceivedByOrderId.get(orderId) || 0,
    );
    const previousPaymentsReceived = Number(
      (Math.max(0, advanceAmount) + Math.max(0, linkedReceivedAmount)).toFixed(
        2,
      ),
    );
    summaryMap.set(orderId, {
      salesOrderAdvanceAmount: Number(Math.max(0, advanceAmount).toFixed(2)),
      linkedVouchersReceivedAmount: Number(
        Math.max(0, linkedReceivedAmount).toFixed(2),
      ),
      totalOrderAmount: Number(Math.max(0, totalOrderAmount).toFixed(2)),
      previousPaymentsReceived,
    });
  });

  return summaryMap;
};

const fetchSalesOrderReceivableSummaryTx = async ({
  trx,
  req,
  linkedSalesOrderId,
  excludeSalesVoucherId = null,
}) => {
  const normalizedOrderId = toPositiveInt(linkedSalesOrderId);
  if (!normalizedOrderId) {
    return {
      salesOrderAdvanceAmount: 0,
      linkedVouchersReceivedAmount: 0,
      totalOrderAmount: 0,
      previousPaymentsReceived: 0,
    };
  }
  const summaryMap = await loadSalesOrderReceivableSummaryMapTx({
    trx,
    req,
    salesOrderIds: [normalizedOrderId],
    excludeSalesVoucherId,
  });
  return (
    summaryMap.get(normalizedOrderId) || {
      salesOrderAdvanceAmount: 0,
      linkedVouchersReceivedAmount: 0,
      totalOrderAmount: 0,
      previousPaymentsReceived: 0,
    }
  );
};

const loadOpenSalesOrderLinesTx = async ({
  trx,
  req,
  linkedSalesOrderId = null,
  excludeSalesVoucherId = null,
}) => {
  const linkedOrderId = toPositiveInt(linkedSalesOrderId);
  const excludedVoucherId = toPositiveInt(excludeSalesVoucherId);

  let orderLinesQuery = trx("erp.voucher_header as vh")
    .join("erp.sales_order_header as soh", "soh.voucher_id", "vh.id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.skus as s", "s.id", "vl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select(
      "vh.id as sales_order_id",
      "vh.voucher_no as sales_order_voucher_no",
      "vh.book_no as sales_order_book_no",
      "vh.voucher_date as sales_order_voucher_date",
      "soh.customer_party_id",
      "soh.salesman_employee_id",
      "soh.payment_received_amount as sales_order_payment_received_amount",
      "soh.receive_into_account_id as sales_order_receive_into_account_id",
      "vl.id as sales_order_line_id",
      "vl.line_no as sales_order_line_no",
      "vl.sku_id",
      "vl.qty as ordered_pairs",
      "vl.meta as sales_order_line_meta",
      "s.sku_code",
      "i.name as item_name",
      "v.sale_rate",
    )
    .where({
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": SALES_VOUCHER_TYPES.salesOrder,
      "vh.status": "APPROVED",
      "vl.line_kind": "SKU",
    });
  if (linkedOrderId) {
    orderLinesQuery = orderLinesQuery.where("vh.id", linkedOrderId);
  }

  let deliveredPairsQuery = trx("erp.voucher_header as svh")
    .join("erp.sales_header as sh", "sh.voucher_id", "svh.id")
    .join("erp.voucher_line as svl", "svl.voucher_header_id", "svh.id")
    .select(
      "sh.linked_sales_order_id as sales_order_id",
      trx.raw(
        "cast(svl.meta->>'sales_order_line_id' as bigint) as sales_order_line_id",
      ),
      trx.raw("sum(svl.qty) as delivered_pairs"),
    )
    .where({
      "svh.branch_id": req.branchId,
      "svh.voucher_type_code": SALES_VOUCHER_TYPES.salesVoucher,
      "svl.line_kind": "SKU",
    })
    .whereNot("svh.status", "REJECTED")
    .whereNotNull("sh.linked_sales_order_id")
    .whereRaw("coalesce(svl.meta->>'movement_kind', '') = 'SALE'")
    .whereRaw("coalesce(svl.meta->>'sales_order_line_id', '') ~ '^[0-9]+$'");
  if (linkedOrderId) {
    deliveredPairsQuery = deliveredPairsQuery.where(
      "sh.linked_sales_order_id",
      linkedOrderId,
    );
  }
  if (excludedVoucherId) {
    deliveredPairsQuery = deliveredPairsQuery.whereNot(
      "svh.id",
      excludedVoucherId,
    );
  }
  deliveredPairsQuery = deliveredPairsQuery.groupBy(
    "sh.linked_sales_order_id",
    trx.raw("cast(svl.meta->>'sales_order_line_id' as bigint)"),
  );

  const [orderLines, deliveredRows] = await Promise.all([
    orderLinesQuery
      .orderBy("vh.voucher_no", "desc")
      .orderBy("vl.line_no", "asc"),
    deliveredPairsQuery,
  ]);

  const deliveredPairsByLineKey = new Map(
    (deliveredRows || []).map((row) => [
      `${Number(row.sales_order_id)}:${Number(row.sales_order_line_id)}`,
      Number(row.delivered_pairs || 0),
    ]),
  );

  return (orderLines || [])
    .map((row) => {
      const meta =
        row.sales_order_line_meta &&
        typeof row.sales_order_line_meta === "object"
          ? row.sales_order_line_meta
          : {};
      const rowStatus = normalizeRowStatus(meta.row_status);
      const isPacked = toBool(meta.is_packed) || rowStatus === "PACKED";
      const orderedPairs = Number(row.ordered_pairs || 0);
      const deliveredPairs = Number(
        deliveredPairsByLineKey.get(
          `${Number(row.sales_order_id)}:${Number(row.sales_order_line_id)}`,
        ) || 0,
      );
      const safeDeliveredPairs = Math.max(
        0,
        Math.min(orderedPairs, deliveredPairs),
      );
      const openPairs = Number((orderedPairs - safeDeliveredPairs).toFixed(3));
      if (openPairs <= 0) return null;

      const orderedQty = isPacked
        ? Number((orderedPairs / PAIRS_PER_PACKED_UNIT).toFixed(3))
        : Number(orderedPairs.toFixed(3));
      const deliveredQty = isPacked
        ? Number((safeDeliveredPairs / PAIRS_PER_PACKED_UNIT).toFixed(3))
        : Number(safeDeliveredPairs.toFixed(3));
      const openQty = Number((orderedQty - deliveredQty).toFixed(3));

      return {
        sales_order_id: Number(row.sales_order_id),
        sales_order_voucher_no: Number(row.sales_order_voucher_no),
        sales_order_book_no: String(row.sales_order_book_no || "").trim(),
        sales_order_voucher_date: toDateOnly(row.sales_order_voucher_date),
        customer_party_id: Number(row.customer_party_id),
        salesman_employee_id: Number(row.salesman_employee_id),
        sales_order_payment_received_amount: Number(
          row.sales_order_payment_received_amount || 0,
        ),
        sales_order_receive_into_account_id:
          Number(row.sales_order_receive_into_account_id || 0) || null,
        sales_order_line_id: Number(row.sales_order_line_id),
        sales_order_line_no: Number(row.sales_order_line_no),
        sku_id: Number(row.sku_id),
        sku_code: String(row.sku_code || "").trim(),
        item_name: String(row.item_name || "").trim(),
        row_status: rowStatus,
        is_packed: isPacked,
        ordered_pairs: Number(orderedPairs.toFixed(3)),
        delivered_pairs: Number(safeDeliveredPairs.toFixed(3)),
        open_pairs: Number(openPairs.toFixed(3)),
        ordered_qty: Number(orderedQty.toFixed(3)),
        delivered_qty: Number(deliveredQty.toFixed(3)),
        open_qty: Number(openQty.toFixed(3)),
        pair_rate:
          toPositiveNumber(meta.pair_rate, 2) ||
          toPositiveNumber(row.sale_rate, 2) ||
          0,
        pair_discount: toNonNegativeNumber(meta.pair_discount, 2) || 0,
      };
    })
    .filter(Boolean);
};

const normalizeSalesOrderLinesTx = async ({
  trx,
  rawLines = [],
  allowRateDiscountOverride = false,
}) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const skuIds = lines
    .map((line) => toPositiveInt(line?.sku_id || line?.skuId))
    .filter(Boolean);
  const uniqueSkuIds = [...new Set(skuIds)];
  const skuMap = await fetchSkuMapTx({ trx, skuIds: uniqueSkuIds });
  if (skuMap.size !== uniqueSkuIds.length)
    throw new HttpError(400, "One or more selected SKUs are invalid");

  return lines.map((line, index) => {
    const lineNo = index + 1;
    const skuId = toPositiveInt(line?.sku_id || line?.skuId);
    const sku = skuMap.get(Number(skuId));
    if (!sku) throw new HttpError(400, `Line ${lineNo}: SKU is invalid`);

    const rowStatus = normalizeRowStatus(line?.row_status || line?.status);
    const isPacked =
      rowStatus === "PACKED" || toBool(line?.is_packed || line?.isPacked);
    const saleQty = toPositiveNumber(
      line?.sale_qty || line?.saleQty || line?.qty,
      3,
    );
    if (!saleQty)
      throw new HttpError(400, `Line ${lineNo}: sale quantity is required`);
    ensureQtyByStatus({ lineNo, qty: saleQty, isPacked });
    const totalPairs = pairsFromQty({ qty: saleQty, isPacked });

    const autoPairRate = toPositiveNumber(sku.sale_rate, 2);
    const pairRateInput = toPositiveNumber(
      line?.pair_rate || line?.pairRate || line?.rate,
      2,
    );
    const pairRate = pairRateInput || autoPairRate;
    if (!pairRate)
      throw new HttpError(400, `Line ${lineNo}: pair rate is required`);
    if (
      !allowRateDiscountOverride &&
      autoPairRate &&
      !approxEq(pairRate, autoPairRate)
    ) {
      throw new HttpError(400, `Line ${lineNo}: rate override is not allowed`);
    }

    const pairDiscount = toNonNegativeNumber(
      line?.pair_discount || line?.pairDiscount || 0,
      2,
    );
    if (pairDiscount === null)
      throw new HttpError(400, `Line ${lineNo}: pair discount is invalid`);
    if (pairDiscount >= pairRate)
      throw new HttpError(
        400,
        `Line ${lineNo}: pair discount must be less than pair rate`,
      );

    const totalDiscount = Number((totalPairs * pairDiscount).toFixed(2));
    const lineTotal = Number(
      (totalPairs * (pairRate - pairDiscount)).toFixed(2),
    );
    return {
      line_no: lineNo,
      line_kind: "SKU",
      sku_id: Number(skuId),
      uom_id: toPositiveInt(sku.base_uom_id),
      qty: Number(totalPairs.toFixed(3)),
      rate: Number(pairRate.toFixed(2)),
      amount: lineTotal,
      reference_no: normalizeText(line?.reference_no || line?.referenceNo, 120),
      meta: {
        row_status: rowStatus,
        is_packed: isPacked,
        sale_qty: Number(saleQty.toFixed(3)),
        return_qty: 0,
        pair_rate: Number(pairRate.toFixed(2)),
        pair_discount: Number(pairDiscount.toFixed(2)),
        total_discount: Number(totalDiscount.toFixed(2)),
        total_amount: Number(lineTotal.toFixed(2)),
        total_pairs: Number(totalPairs.toFixed(3)),
      },
      discount_policy: {
        product_group_id: Number(sku.group_id || 0) || null,
        product_group_name: String(sku.product_group_name || "").trim(),
        qty_pairs: Number(totalPairs.toFixed(3)),
        gross_amount: Number((totalPairs * pairRate).toFixed(2)),
        pair_discount: Number(pairDiscount.toFixed(2)),
      },
      sales_line: null,
      summary: {
        line_total: Number(lineTotal.toFixed(2)),
      },
    };
  });
};

const loadSalesOrderLineEditStateTx = async ({
  trx,
  req,
  salesOrderId,
  excludeSalesVoucherId = null,
}) => {
  const linkedOrderId = toPositiveInt(salesOrderId);
  if (!linkedOrderId) return [];
  const excludedVoucherId = toPositiveInt(excludeSalesVoucherId);

  const orderLinesQuery = trx("erp.voucher_header as vh")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .select(
      "vh.id as sales_order_id",
      "vl.id as sales_order_line_id",
      "vl.line_no",
      "vl.sku_id",
      "vl.qty as ordered_pairs",
      "vl.rate",
      "vl.meta",
    )
    .where({
      "vh.id": linkedOrderId,
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": SALES_VOUCHER_TYPES.salesOrder,
      "vl.line_kind": "SKU",
    })
    .orderBy("vl.line_no", "asc");

  let deliveredPairsQuery = trx("erp.voucher_header as svh")
    .join("erp.sales_header as sh", "sh.voucher_id", "svh.id")
    .join("erp.voucher_line as svl", "svl.voucher_header_id", "svh.id")
    .select(
      trx.raw(
        "cast(svl.meta->>'sales_order_line_id' as bigint) as sales_order_line_id",
      ),
      trx.raw("sum(svl.qty) as delivered_pairs"),
    )
    .where({
      "svh.branch_id": req.branchId,
      "svh.voucher_type_code": SALES_VOUCHER_TYPES.salesVoucher,
      "sh.linked_sales_order_id": linkedOrderId,
      "svl.line_kind": "SKU",
    })
    .whereNot("svh.status", "REJECTED")
    .whereRaw("coalesce(svl.meta->>'movement_kind', '') = 'SALE'")
    .whereRaw("coalesce(svl.meta->>'sales_order_line_id', '') ~ '^[0-9]+$'");

  if (excludedVoucherId) {
    deliveredPairsQuery = deliveredPairsQuery.whereNot("svh.id", excludedVoucherId);
  }

  deliveredPairsQuery = deliveredPairsQuery.groupBy(
    trx.raw("cast(svl.meta->>'sales_order_line_id' as bigint)"),
  );

  const [orderLines, deliveredRows] = await Promise.all([
    orderLinesQuery,
    deliveredPairsQuery,
  ]);

  const deliveredByLineId = new Map(
    (deliveredRows || []).map((row) => [
      Number(row.sales_order_line_id || 0),
      Number(row.delivered_pairs || 0),
    ]),
  );

  return (orderLines || []).map((row) => {
    const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
    const orderedPairs = Number(row.ordered_pairs || 0);
    const deliveredPairs = Number(
      Math.max(
        0,
        Math.min(
          orderedPairs,
          Number(deliveredByLineId.get(Number(row.sales_order_line_id || 0)) || 0),
        ),
      ).toFixed(3),
    );
    const rowStatus = normalizeRowStatus(meta.row_status);
    const pairDiscount = toNonNegativeNumber(meta.pair_discount, 2) || 0;
    return {
      sales_order_line_id: Number(row.sales_order_line_id || 0),
      line_no: Number(row.line_no || 0),
      sku_id: Number(row.sku_id || 0) || null,
      row_status: rowStatus,
      ordered_pairs: Number(orderedPairs.toFixed(3)),
      delivered_pairs: deliveredPairs,
      rate: Number(toPositiveNumber(meta.pair_rate, 2) || toPositiveNumber(row.rate, 2) || 0),
      pair_discount: Number(pairDiscount.toFixed(2)),
    };
  });
};

const validateSalesOrderEditableLines = ({
  existingLines = [],
  nextLines = [],
}) => {
  const nextLineByNo = new Map(
    (nextLines || []).map((line) => [Number(line.line_no || 0), line]),
  );

  (existingLines || []).forEach((existingLine) => {
    const lineNo = Number(existingLine.line_no || 0);
    const deliveredPairs = Number(existingLine.delivered_pairs || 0);
    if (deliveredPairs <= 0) return;

    const nextLine = nextLineByNo.get(lineNo);
    if (!nextLine) {
      throw new HttpError(
        400,
        `Line ${lineNo}: delivered sales order row cannot be removed`,
      );
    }

    if (Number(nextLine.sku_id || 0) !== Number(existingLine.sku_id || 0)) {
      throw new HttpError(
        400,
        `Line ${lineNo}: article cannot be changed after delivery`,
      );
    }

    if (
      String(nextLine.meta?.row_status || "").trim().toUpperCase() !==
      String(existingLine.row_status || "").trim().toUpperCase()
    ) {
      throw new HttpError(
        400,
        `Line ${lineNo}: status cannot be changed after delivery`,
      );
    }

    if (
      !approxEq(Number(nextLine.rate || 0), Number(existingLine.rate || 0), 0.01)
    ) {
      throw new HttpError(
        400,
        `Line ${lineNo}: rate cannot be changed after delivery`,
      );
    }

    if (
      !approxEq(
        Number(nextLine.meta?.pair_discount || 0),
        Number(existingLine.pair_discount || 0),
        0.01,
      )
    ) {
      throw new HttpError(
        400,
        `Line ${lineNo}: discount cannot be changed after delivery`,
      );
    }

    if (Number(nextLine.qty || 0) + 0.0001 < deliveredPairs) {
      throw new HttpError(
        400,
        `Line ${lineNo}: quantity cannot be less than already delivered quantity`,
      );
    }

    if (
      deliveredPairs >= Number(existingLine.ordered_pairs || 0) - 0.0001 &&
      !approxEq(Number(nextLine.qty || 0), Number(existingLine.ordered_pairs || 0), 0.001)
    ) {
      throw new HttpError(
        400,
        `Line ${lineNo}: fully delivered row cannot be changed`,
      );
    }
  });
};

const normalizeSalesVoucherLinesTx = async ({
  trx,
  req,
  rawLines = [],
  saleMode,
  linkedSalesOrderId = null,
  excludeSalesVoucherId = null,
  allowRateDiscountOverride = false,
}) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");

  const reasonIds = lines
    .map((line) =>
      toPositiveInt(line?.return_reason_id || line?.returnReasonId),
    )
    .filter(Boolean);
  const reasonMap = await fetchReturnReasonMapTx({ trx, reasonIds });
  if (reasonMap.size !== [...new Set(reasonIds)].length)
    throw new HttpError(400, "One or more return reasons are invalid");

  let linkedOrder = null;
  let pendingSoLineMap = new Map();
  if (saleMode === "FROM_SO") {
    linkedOrder = await fetchLinkedSalesOrderHeaderTx({
      trx,
      req,
      linkedSalesOrderId,
    });
    const pendingSoLines = await loadOpenSalesOrderLinesTx({
      trx,
      req,
      linkedSalesOrderId,
      excludeSalesVoucherId,
    });
    pendingSoLineMap = new Map(
      pendingSoLines.map((line) => [Number(line.sales_order_line_id), line]),
    );
    if (!pendingSoLineMap.size) {
      throw new HttpError(400, "Selected sales order has no pending lines");
    }
  }

  const skuIds = lines
    .map((line) => {
      const sourceLineId = toPositiveInt(
        line?.sales_order_line_id || line?.salesOrderLineId,
      );
      if (saleMode === "FROM_SO" && sourceLineId) {
        const source = pendingSoLineMap.get(Number(sourceLineId));
        if (source) return Number(source.sku_id);
      }
      return toPositiveInt(line?.sku_id || line?.skuId);
    })
    .filter(Boolean);
  const uniqueSkuIds = [...new Set(skuIds)];
  const skuMap = await fetchSkuMapTx({ trx, skuIds: uniqueSkuIds });
  if (skuMap.size !== uniqueSkuIds.length)
    throw new HttpError(400, "One or more selected SKUs are invalid");

  const consumedPairsBySourceLine = new Map();
  let salesTotal = 0;
  let returnsTotal = 0;
  return {
    linkedOrder,
    lines: lines.map((line, index) => {
      const lineNo = index + 1;
      const sourceLineId = toPositiveInt(
        line?.sales_order_line_id || line?.salesOrderLineId,
      );
      const soSourceLine =
        saleMode === "FROM_SO"
          ? pendingSoLineMap.get(Number(sourceLineId || 0))
          : null;
      if (saleMode === "FROM_SO" && !soSourceLine) {
        throw new HttpError(
          400,
          `Line ${lineNo}: select a pending sales order line`,
        );
      }

      const skuId = soSourceLine
        ? Number(soSourceLine.sku_id)
        : toPositiveInt(line?.sku_id || line?.skuId);
      const sku = skuMap.get(Number(skuId));
      if (!sku) throw new HttpError(400, `Line ${lineNo}: SKU is invalid`);
      if (
        soSourceLine &&
        toPositiveInt(line?.sku_id || line?.skuId) &&
        Number(line.sku_id || line.skuId) !== Number(soSourceLine.sku_id)
      ) {
        throw new HttpError(
          400,
          `Line ${lineNo}: selected SKU does not match sales order line`,
        );
      }

      const rowStatus = soSourceLine
        ? normalizeRowStatus(soSourceLine.row_status)
        : normalizeRowStatus(line?.row_status || line?.status);
      const isPacked = soSourceLine
        ? toBool(soSourceLine.is_packed)
        : rowStatus === "PACKED" || toBool(line?.is_packed || line?.isPacked);
      const saleQty = toNonNegativeNumber(
        line?.sale_qty || line?.saleQty || 0,
        3,
      );
      const returnQty = toNonNegativeNumber(
        line?.return_qty || line?.returnQty || 0,
        3,
      );
      if (saleQty === null || returnQty === null)
        throw new HttpError(400, `Line ${lineNo}: quantities are invalid`);
      if ((saleQty > 0 && returnQty > 0) || (saleQty <= 0 && returnQty <= 0)) {
        throw new HttpError(
          400,
          `Line ${lineNo}: enter either sale quantity or return quantity`,
        );
      }
      if (saleMode === "FROM_SO" && returnQty > 0) {
        throw new HttpError(
          400,
          `Line ${lineNo}: returns cannot be posted in From Sales Order mode`,
        );
      }

      const usedQty = saleQty > 0 ? saleQty : returnQty;
      ensureQtyByStatus({ lineNo, qty: usedQty, isPacked });
      const totalPairs = pairsFromQty({ qty: usedQty, isPacked });
      if (soSourceLine) {
        const consumedPairs = Number(
          consumedPairsBySourceLine.get(
            Number(soSourceLine.sales_order_line_id),
          ) || 0,
        );
        const nextConsumedPairs = Number(
          (consumedPairs + totalPairs).toFixed(3),
        );
        if (nextConsumedPairs > Number(soSourceLine.open_pairs || 0) + 0.0001) {
          throw new HttpError(
            400,
            `Line ${lineNo}: quantity exceeds pending sales order balance`,
          );
        }
        consumedPairsBySourceLine.set(
          Number(soSourceLine.sales_order_line_id),
          nextConsumedPairs,
        );
      }

      const returnReasonId = toPositiveInt(
        line?.return_reason_id || line?.returnReasonId,
      );
      if (returnQty > 0 && !returnReasonId)
        throw new HttpError(400, `Line ${lineNo}: return reason is required`);
      if (returnQty === 0 && returnReasonId)
        throw new HttpError(
          400,
          `Line ${lineNo}: return reason is only valid for return qty`,
        );

      const autoPairRate = soSourceLine
        ? toPositiveNumber(soSourceLine.pair_rate, 2) ||
          toPositiveNumber(sku.sale_rate, 2)
        : toPositiveNumber(sku.sale_rate, 2);
      const pairRateInput = toPositiveNumber(
        line?.pair_rate || line?.pairRate || line?.rate,
        2,
      );
      const pairRate = pairRateInput || autoPairRate;
      if (!pairRate)
        throw new HttpError(400, `Line ${lineNo}: pair rate is required`);
      if (
        !allowRateDiscountOverride &&
        autoPairRate &&
        !approxEq(pairRate, autoPairRate)
      ) {
        throw new HttpError(
          400,
          `Line ${lineNo}: rate override is not allowed`,
        );
      }

      const autoPairDiscount = soSourceLine
        ? toNonNegativeNumber(soSourceLine.pair_discount || 0, 2) || 0
        : 0;
      const pairDiscountInput = soSourceLine
        ? autoPairDiscount
        : toNonNegativeNumber(
            line?.pair_discount || line?.pairDiscount || autoPairDiscount,
            2,
          );
      const pairDiscount =
        pairDiscountInput === null
          ? null
          : Number(pairDiscountInput.toFixed(2));
      if (pairDiscount === null)
        throw new HttpError(400, `Line ${lineNo}: pair discount is invalid`);
      if (pairDiscount >= pairRate)
        throw new HttpError(
          400,
          `Line ${lineNo}: pair discount must be less than pair rate`,
        );

      const totalDiscount = Number((totalPairs * pairDiscount).toFixed(2));
      const lineTotal = Number(
        (totalPairs * (pairRate - pairDiscount)).toFixed(2),
      );
      const movementKind = saleQty > 0 ? "SALE" : "RETURN";
      if (saleQty > 0) salesTotal = Number((salesTotal + lineTotal).toFixed(2));
      if (returnQty > 0)
        returnsTotal = Number((returnsTotal + lineTotal).toFixed(2));

      return {
        line_no: lineNo,
        line_kind: "SKU",
        sku_id: Number(skuId),
        uom_id: toPositiveInt(sku.base_uom_id),
        qty: Number(totalPairs.toFixed(3)),
        rate: Number(pairRate.toFixed(2)),
        amount:
          movementKind === "RETURN"
            ? Number((-1 * lineTotal).toFixed(2))
            : Number(lineTotal.toFixed(2)),
        reference_no: normalizeText(
          line?.reference_no || line?.referenceNo,
          120,
        ),
        meta: {
          row_status: rowStatus,
          is_packed: isPacked,
          sale_qty: Number(saleQty.toFixed(3)),
          return_qty: Number(returnQty.toFixed(3)),
          return_reason_id: returnReasonId || undefined,
          pair_rate: Number(pairRate.toFixed(2)),
          pair_discount: Number(pairDiscount.toFixed(2)),
          total_discount: Number(totalDiscount.toFixed(2)),
          total_amount: Number(lineTotal.toFixed(2)),
          total_pairs: Number(totalPairs.toFixed(3)),
          movement_kind: movementKind,
          sales_order_line_id: soSourceLine
            ? Number(soSourceLine.sales_order_line_id)
            : toPositiveInt(
                line?.sales_order_line_id || line?.salesOrderLineId,
              ) || undefined,
        },
        discount_policy: {
          product_group_id: Number(sku.group_id || 0) || null,
          product_group_name: String(sku.product_group_name || "").trim(),
          qty_pairs: movementKind === "SALE" ? Number(totalPairs.toFixed(3)) : 0,
          gross_amount:
            movementKind === "SALE"
              ? Number((totalPairs * pairRate).toFixed(2))
              : 0,
          pair_discount: Number(pairDiscount.toFixed(2)),
        },
        sales_line: {
          is_packed: isPacked,
          sale_qty: Number(saleQty.toFixed(3)),
          return_qty: Number(returnQty.toFixed(3)),
          return_reason_id: returnReasonId || null,
          pair_rate: Number(pairRate.toFixed(2)),
          pair_discount: Number(pairDiscount.toFixed(2)),
          total_discount: Number(totalDiscount.toFixed(2)),
          total_amount: Number(lineTotal.toFixed(2)),
        },
        summary: {
          line_total: Number(lineTotal.toFixed(2)),
        },
      };
    }),
    totals: {
      totalSalesAmount: Number(salesTotal.toFixed(2)),
      totalReturnsAmount: Number(returnsTotal.toFixed(2)),
    },
  };
};

const validateSalesPayloadTx = async ({
  trx,
  req,
  voucherTypeCode,
  payload,
  currentVoucherId = null,
  excludeSalesVoucherId = null,
  allowRateDiscountOverride = false,
  allowCashPaymentOverride = false,
}) => {
  const voucherDate = toDateOnly(payload?.voucher_date);
  if (!voucherDate) throw new HttpError(400, "Voucher date is required");

  if (voucherTypeCode === SALES_VOUCHER_TYPES.salesOrder) {
    const customer = await validateCustomerTx({
      trx,
      req,
      customerPartyId: payload?.customer_party_id,
    });
    const salesman = await validateSalesmanTx({
      trx,
      req,
      salesmanEmployeeId: payload?.salesman_employee_id,
    });
    const advanceReceive = toBool(payload?.advance_receive);
    let paymentReceivedAmount = toNonNegativeNumber(
      payload?.payment_received_amount || 0,
      2,
    );
    if (paymentReceivedAmount === null)
      throw new HttpError(400, "Payment received amount is invalid");
    const lines = await normalizeSalesOrderLinesTx({
      trx,
      rawLines: payload?.lines || [],
      allowRateDiscountOverride,
    });
    const currentSalesOrderId = toPositiveInt(currentVoucherId);
    if (currentSalesOrderId) {
      const existingLineStates = await loadSalesOrderLineEditStateTx({
        trx,
        req,
        salesOrderId: currentSalesOrderId,
      });
      validateSalesOrderEditableLines({
        existingLines: existingLineStates,
        nextLines: lines,
      });
    }
    const totalSalesAmount = Number(
      lines
        .reduce((sum, line) => sum + Number(line.summary.line_total || 0), 0)
        .toFixed(2),
    );
    const extraDiscount = toNonNegativeNumber(payload?.extra_discount || 0, 2);
    if (extraDiscount === null)
      throw new HttpError(400, "Extra discount is invalid");
    const finalAmount = Number((totalSalesAmount - extraDiscount).toFixed(2));
    if (finalAmount < 0)
      throw new HttpError(400, "Final amount cannot be negative");
    const discountPolicy = await evaluateVoucherDiscountPolicyTx({
      trx,
      lines,
      extraDiscount,
    });
    if (!advanceReceive) {
      paymentReceivedAmount = 0;
    }
    if (Number(paymentReceivedAmount) > Number(finalAmount) + 0.0001) {
      throw new HttpError(
        400,
        "Advance received amount cannot exceed voucher total amount",
      );
    }
    if (advanceReceive && Number(paymentReceivedAmount) <= 0) {
      throw new HttpError(
        400,
        "Advance receive is enabled but no advanced payment amount was entered",
      );
    }
    const receiveIntoAccountId = advanceReceive
      ? await validateReceiveAccountTx({
          trx,
          req,
          receiveIntoAccountId: payload?.receive_into_account_id,
        })
      : null;
    const bookNo = normalizeText(
      payload?.reference_no || payload?.book_no,
      120,
    );
    if (!bookNo) throw new HttpError(400, "Bill number is required");
    return {
      voucherDate,
      bookNo,
      referenceNo: bookNo,
      remarks: normalizeText(payload?.description || payload?.remarks, 1000),
      customerPartyId: customer.id,
      customerName: customer.name,
      customerPhoneNumber: normalizeText(
        payload?.customer_phone_number || customer.phone1,
        30,
      ),
      salesmanEmployeeId: salesman.id,
      advanceReceive,
      receiveIntoAccountId,
      paymentReceivedAmount: Number(paymentReceivedAmount.toFixed(2)),
      deliveryMethod: normalizeDeliveryMethod(payload?.delivery_method),
      saleMode: "DIRECT",
      paymentType: "CASH",
      linkedSalesOrderId: null,
      paymentDueDate: null,
      extraDiscount: Number(extraDiscount.toFixed(2)),
      discountPolicyExceeded: discountPolicy.hasViolation,
      discountPolicy,
      lines,
      totals: {
        totalSalesAmount,
        totalReturnsAmount: 0,
        extraDiscount: Number(extraDiscount.toFixed(2)),
        finalAmount,
      },
    };
  }

  if (voucherTypeCode !== SALES_VOUCHER_TYPES.salesVoucher) {
    throw new HttpError(400, "Invalid sales voucher type");
  }

  const bookNo = normalizeText(payload?.reference_no || payload?.book_no, 120);
  if (!bookNo) throw new HttpError(400, "Bill number is required");

  const saleMode = normalizeSaleMode(payload?.sale_mode);
  const paymentType = normalizePaymentType(payload?.payment_type);
  if (saleMode === "FROM_SO" && paymentType !== "CREDIT") {
    throw new HttpError(400, "Sales order reference requires credit sale");
  }
  const linkedSalesOrderId =
    saleMode === "FROM_SO"
      ? toPositiveInt(payload?.linked_sales_order_id)
      : null;
  const normalizedLines = await normalizeSalesVoucherLinesTx({
    trx,
    req,
    rawLines: payload?.lines || [],
    saleMode,
    linkedSalesOrderId,
    excludeSalesVoucherId,
    allowRateDiscountOverride,
  });

  let customerPartyId = toPositiveInt(payload?.customer_party_id);
  let salesmanEmployeeId = toPositiveInt(payload?.salesman_employee_id);
  if (normalizedLines.linkedOrder) {
    customerPartyId = normalizedLines.linkedOrder.customerPartyId;
    salesmanEmployeeId = normalizedLines.linkedOrder.salesmanEmployeeId;
  }
  const customer = customerPartyId
    ? await validateCustomerTx({ trx, req, customerPartyId })
    : null;
  if (paymentType === "CREDIT" && !customer)
    throw new HttpError(400, "Customer is required for credit sale");
  if (!salesmanEmployeeId) throw new HttpError(400, "Salesman is required");
  const salesman = await validateSalesmanTx({ trx, req, salesmanEmployeeId });
  let paymentDueDate =
    paymentType === "CREDIT" ? toDateOnly(payload?.payment_due_date) : null;

  const extraDiscount = toNonNegativeNumber(payload?.extra_discount || 0, 2);
  if (extraDiscount === null)
    throw new HttpError(400, "Extra discount is invalid");
  if (saleMode === "FROM_SO" && extraDiscount > 0) {
    throw new HttpError(
      400,
      "Extra discount is not allowed for sales order reference",
    );
  }
  const finalAmount = Number(
    (
      normalizedLines.totals.totalSalesAmount -
      normalizedLines.totals.totalReturnsAmount -
      extraDiscount
    ).toFixed(2),
  );
  if (finalAmount < 0 && (paymentType !== "CASH" || saleMode === "FROM_SO")) {
    throw new HttpError(
      400,
      "Negative final amount is only allowed for direct cash refund settlement",
    );
  }
  const discountPolicy =
    saleMode === "FROM_SO"
      ? {
          lines: [],
          hasViolation: false,
          violationCount: 0,
          totalExtraDiscount: Number(extraDiscount.toFixed(2)),
          totalEligibleGross: 0,
          totalExcessDiscount: 0,
          maxEffectivePairDiscount: 0,
          maxAllowedPairDiscount: 0,
          violatedGroups: [],
        }
      : await evaluateVoucherDiscountPolicyTx({
          trx,
          lines: normalizedLines.lines,
          extraDiscount,
        });

  let paymentReceivedAmount = toNonNegativeNumber(
    payload?.payment_received_amount,
    2,
  );
  if (paymentReceivedAmount === null)
    throw new HttpError(400, "Payment received amount is invalid");
  let linkedOrderReceivableSummary = null;
  if (paymentType === "CASH") {
    const cashSettlementAmount = Number(Math.abs(finalAmount || 0).toFixed(2));
    if (cashSettlementAmount > 0 && Number(paymentReceivedAmount) <= 0) {
      throw new HttpError(400, "Cash sale requires settlement amount");
    }
    if (!approxEq(paymentReceivedAmount, cashSettlementAmount)) {
      throw new HttpError(
        400,
        "Cash sale settlement amount must match voucher total",
      );
    }
  }
  if (paymentType === "CREDIT") {
    let maxAllowedReceivedAmount = Number(finalAmount || 0);
    if (saleMode === "FROM_SO" && normalizedLines.linkedOrder?.id) {
      linkedOrderReceivableSummary = await fetchSalesOrderReceivableSummaryTx({
        trx,
        req,
        linkedSalesOrderId: normalizedLines.linkedOrder.id,
        excludeSalesVoucherId,
      });
      if (Number(linkedOrderReceivableSummary.totalOrderAmount || 0) > 0) {
        maxAllowedReceivedAmount = Number(
          Math.max(
            0,
            Number(linkedOrderReceivableSummary.totalOrderAmount || 0) -
              Number(
                linkedOrderReceivableSummary.previousPaymentsReceived || 0,
              ),
          ).toFixed(2),
        );
      }
    }

    if (paymentReceivedAmount > maxAllowedReceivedAmount + 0.0001) {
      throw new HttpError(
        400,
        saleMode === "FROM_SO"
          ? "Current payment exceeds remaining receivable for this sales order"
          : "Advanced received amount cannot exceed final amount",
      );
    }

    const remainingAfterCurrent = Number(
      Math.max(
        0,
        Number(maxAllowedReceivedAmount || 0) -
          Number(paymentReceivedAmount || 0),
      ).toFixed(2),
    );
    if (remainingAfterCurrent > 0 && !paymentDueDate) {
      throw new HttpError(400, "Payment due date is required for credit sale");
    }
    if (paymentDueDate && paymentDueDate <= voucherDate) {
      throw new HttpError(400, "Payment due date must be after voucher date");
    }
    if (remainingAfterCurrent <= 0) {
      paymentDueDate = null;
    }
  }
  const receiveIntoAccountId =
    paymentReceivedAmount > 0
      ? await validateReceiveAccountTx({
          trx,
          req,
          receiveIntoAccountId: payload?.receive_into_account_id,
        })
      : null;

  if (
    saleMode === "FROM_SO" &&
    paymentReceivedAmount > 0 &&
    Number(normalizedLines.linkedOrder?.receiveIntoAccountId || 0) > 0 &&
    Number(linkedOrderReceivableSummary?.previousPaymentsReceived || 0) > 0 &&
    Number(receiveIntoAccountId || 0) !==
      Number(normalizedLines.linkedOrder.receiveIntoAccountId || 0)
  ) {
    throw new HttpError(
      400,
      "Receive account must match linked sales order payment account",
    );
  }

  const customerPhoneNumber = normalizeText(
    payload?.customer_phone_number || customer?.phone1,
    30,
  );
  if (!customerPhoneNumber)
    throw new HttpError(400, "Phone number is required");
  if (!isValidPhoneNumber(customerPhoneNumber)) {
    throw new HttpError(400, "Phone number format is invalid");
  }
  if (!customer && !normalizeText(payload?.customer_name, 160))
    throw new HttpError(400, "Customer name is required for walk-in sale");

  return {
    voucherDate,
    bookNo,
    referenceNo: normalizeText(payload?.reference_no, 120),
    remarks: normalizeText(payload?.description || payload?.remarks, 1000),
    customerPartyId: customer?.id || null,
    customerName: customer?.name || normalizeText(payload?.customer_name, 160),
    customerPhoneNumber,
    salesmanEmployeeId: salesman.id,
    receiveIntoAccountId,
    paymentReceivedAmount: Number(paymentReceivedAmount.toFixed(2)),
    deliveryMethod: normalizeDeliveryMethod(payload?.delivery_method),
    saleMode,
    paymentType,
    linkedSalesOrderId,
    paymentDueDate,
    extraDiscount: Number(extraDiscount.toFixed(2)),
    discountPolicyExceeded: discountPolicy.hasViolation,
    discountPolicy,
    lines: normalizedLines.lines,
    totals: {
      totalSalesAmount: normalizedLines.totals.totalSalesAmount,
      totalReturnsAmount: normalizedLines.totals.totalReturnsAmount,
      extraDiscount: Number(extraDiscount.toFixed(2)),
      finalAmount: Number(finalAmount.toFixed(2)),
    },
  };
};

const insertVoucherLinesTx = async ({ trx, voucherId, lines }) => {
  const rows = (lines || []).map((line) => ({
    voucher_header_id: voucherId,
    line_no: Number(line.line_no),
    line_kind: "SKU",
    item_id: null,
    sku_id: Number(line.sku_id),
    account_id: null,
    party_id: null,
    labour_id: null,
    employee_id: null,
    uom_id: toPositiveInt(line.uom_id),
    qty: Number(line.qty || 0),
    rate: Number(line.rate || 0),
    amount: Number(line.amount || 0),
    reference_no: line.reference_no || null,
    meta: line.meta || {},
  }));
  if (!rows.length) return [];
  return trx("erp.voucher_line").insert(rows).returning(["id", "line_no"]);
};

const upsertSalesHeaderExtensionsTx = async ({
  trx,
  voucherTypeCode,
  voucherId,
  validated,
}) => {
  if (voucherTypeCode === SALES_VOUCHER_TYPES.salesOrder) {
    await trx("erp.sales_order_header")
      .insert({
        voucher_id: voucherId,
        customer_party_id: validated.customerPartyId,
        salesman_employee_id: validated.salesmanEmployeeId,
        payment_received_amount: validated.paymentReceivedAmount,
        receive_into_account_id: validated.receiveIntoAccountId,
      })
      .onConflict("voucher_id")
      .merge({
        customer_party_id: validated.customerPartyId,
        salesman_employee_id: validated.salesmanEmployeeId,
        payment_received_amount: validated.paymentReceivedAmount,
        receive_into_account_id: validated.receiveIntoAccountId,
      });
    return;
  }

  await trx("erp.sales_header")
    .insert({
      voucher_id: voucherId,
      sale_mode: validated.saleMode,
      payment_type: validated.paymentType,
      customer_party_id: validated.customerPartyId,
      customer_name: validated.customerPartyId ? null : validated.customerName,
      customer_phone_number: validated.customerPhoneNumber,
      salesman_employee_id: validated.salesmanEmployeeId,
      linked_sales_order_id: validated.linkedSalesOrderId,
      payment_due_date: validated.paymentDueDate,
      receive_into_account_id: validated.receiveIntoAccountId,
      payment_received_amount: validated.paymentReceivedAmount,
      delivery_method: validated.deliveryMethod,
      extra_discount: validated.extraDiscount,
    })
    .onConflict("voucher_id")
    .merge({
      sale_mode: validated.saleMode,
      payment_type: validated.paymentType,
      customer_party_id: validated.customerPartyId,
      customer_name: validated.customerPartyId ? null : validated.customerName,
      customer_phone_number: validated.customerPhoneNumber,
      salesman_employee_id: validated.salesmanEmployeeId,
      linked_sales_order_id: validated.linkedSalesOrderId,
      payment_due_date: validated.paymentDueDate,
      receive_into_account_id: validated.receiveIntoAccountId,
      payment_received_amount: validated.paymentReceivedAmount,
      delivery_method: validated.deliveryMethod,
      extra_discount: validated.extraDiscount,
    });
};

const syncSalesLineExtensionsTx = async ({
  trx,
  insertedLines = [],
  validatedLines = [],
}) => {
  const lineIdByNo = new Map(
    (insertedLines || []).map((line) => [
      Number(line.line_no),
      Number(line.id),
    ]),
  );
  const rows = (validatedLines || [])
    .map((line) => {
      if (!line.sales_line) return null;
      const voucherLineId = lineIdByNo.get(Number(line.line_no));
      if (!voucherLineId) return null;
      return { voucher_line_id: voucherLineId, ...line.sales_line };
    })
    .filter(Boolean);
  if (!rows.length) return;
  await trx("erp.sales_line").insert(rows);
};

const createApprovalRequest = async ({
  trx,
  req,
  voucherId,
  voucherTypeCode,
  summary,
  oldValue = null,
  newValue = null,
}) => {
  const approvalInsertPayload = {
    branch_id: req.branchId,
    request_type: "VOUCHER",
    entity_type: "VOUCHER",
    entity_id: String(voucherId),
    summary,
    old_value: oldValue,
    new_value: newValue,
    requested_by: req.user.id,
  };
  if (await hasApprovalRequestVoucherTypeCodeColumnTx(trx)) {
    approvalInsertPayload.voucher_type_code = voucherTypeCode;
  }

  let row;
  try {
    [row] = await trx("erp.approval_request")
      .insert(approvalInsertPayload)
      .returning(["id"]);
  } catch (err) {
    const isMissingVoucherTypeCol =
      String(err?.code || "").trim() === "42703" &&
      String(err?.message || "")
        .toLowerCase()
        .includes("voucher_type_code");
    if (!isMissingVoucherTypeCol) throw err;
    approvalRequestHasVoucherTypeCodeColumn = false;
    delete approvalInsertPayload.voucher_type_code;
    [row] = await trx("erp.approval_request")
      .insert(approvalInsertPayload)
      .returning(["id"]);
  }

  await insertActivityLog(trx, {
    branch_id: req.branchId,
    user_id: req.user.id,
    entity_type: "VOUCHER",
    entity_id: String(voucherId),
    voucher_type_code: voucherTypeCode,
    action: "SUBMIT",
    ip_address: req.ip,
    context: {
      approval_request_id: row?.id || null,
      summary,
      source: "sales-voucher-service",
      new_value: newValue,
    },
  });

  return row?.id || null;
};

const toApprovalPayload = ({
  action,
  voucherTypeCode,
  voucherId,
  voucherNo,
  validated,
  permissionReroute = false,
}) => ({
  action,
  voucher_id: voucherId,
  voucher_no: voucherNo,
  voucher_type_code: voucherTypeCode,
  voucher_date: validated.voucherDate,
  reference_no: validated.bookNo,
  description: validated.remarks,
  customer_party_id: validated.customerPartyId || null,
  customer_name: validated.customerName || null,
  customer_phone_number: validated.customerPhoneNumber || null,
  salesman_employee_id: validated.salesmanEmployeeId || null,
  sale_mode: validated.saleMode || null,
  payment_type: validated.paymentType || null,
  linked_sales_order_id: validated.linkedSalesOrderId || null,
  payment_due_date: validated.paymentDueDate || null,
  receive_into_account_id: validated.receiveIntoAccountId || null,
  advance_receive: Boolean(validated.advanceReceive),
  payment_received_amount: validated.paymentReceivedAmount || 0,
  delivery_method: validated.deliveryMethod || null,
  extra_discount: validated.extraDiscount || 0,
  totals: validated.totals || null,
  discount_policy: validated.discountPolicy || null,
  lines: validated.lines || [],
  permission_reroute: permissionReroute === true,
});

const saveSalesVoucherTx = async ({
  trx,
  req,
  voucherTypeCode,
  scopeKey,
  payload,
  mode,
  voucherId = null,
}) => {
  const canCreate = canDo(req, "VOUCHER", scopeKey, "create");
  const canEdit = canDo(req, "VOUCHER", scopeKey, "edit");
  const canApprove = canApproveVoucherAction(req, scopeKey);
  const allowRateDiscountOverride = canApprove;
  const allowCashPaymentOverride = canApprove;

  const isCreate = mode === "create";
  const action = isCreate ? "create" : "edit";
  const policyRequiresApproval = await requiresApprovalForAction(
    trx,
    voucherTypeCode,
    action,
  );
  let headerId = toPositiveInt(voucherId);

  const validated = await validateSalesPayloadTx({
    trx,
    req,
    voucherTypeCode,
    payload,
    currentVoucherId: isCreate ? null : headerId,
    excludeSalesVoucherId: isCreate ? null : headerId,
    allowRateDiscountOverride,
    allowCashPaymentOverride,
  });
  const queuedForApproval = isCreate
    ? !canCreate ||
      (policyRequiresApproval && !canApprove)
    : !canEdit ||
      (policyRequiresApproval && !canApprove);

  let voucherNo = null;
  let status = "APPROVED";

  if (isCreate) {
    voucherNo = await getNextVoucherNoTx(trx, req.branchId, voucherTypeCode);
    const [header] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: voucherTypeCode,
        voucher_no: voucherNo,
        branch_id: req.branchId,
        voucher_date: validated.voucherDate,
        book_no: validated.bookNo,
        status: queuedForApproval ? "PENDING" : "APPROVED",
        created_by: req.user.id,
        approved_by: queuedForApproval ? null : req.user.id,
        approved_at: queuedForApproval ? null : trx.fn.now(),
        remarks: validated.remarks,
      })
      .returning(["id", "voucher_no", "status"]);
    headerId = Number(header.id);
    voucherNo = Number(header.voucher_no);
    status = String(header.status || "APPROVED");
  } else {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_no", "status")
      .where({
        id: headerId,
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      })
      .first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (existing.status === "REJECTED")
      throw new HttpError(400, "Deleted voucher cannot be edited");
    voucherNo = Number(existing.voucher_no);
    status = queuedForApproval
      ? String(existing.status || "PENDING")
      : "APPROVED";
  }

  if (!queuedForApproval) {
    if (!isCreate) {
      await trx("erp.voucher_header").where({ id: headerId }).update({
        voucher_date: validated.voucherDate,
        book_no: validated.bookNo,
        remarks: validated.remarks,
        status: "APPROVED",
        approved_by: req.user.id,
        approved_at: trx.fn.now(),
      });
      await trx("erp.voucher_line")
        .where({ voucher_header_id: headerId })
        .del();
    }
    const insertedLines = await insertVoucherLinesTx({
      trx,
      voucherId: headerId,
      lines: validated.lines,
    });
    await upsertSalesHeaderExtensionsTx({
      trx,
      voucherTypeCode,
      voucherId: headerId,
      validated,
    });
    if (voucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher) {
      await syncSalesLineExtensionsTx({
        trx,
        insertedLines,
        validatedLines: validated.lines,
      });
    }
    await syncVoucherGlPostingTx({ trx, voucherId: headerId });
    return {
      id: headerId,
      voucherNo,
      status,
      totals: validated.totals,
      queuedForApproval,
      approvalRequestId: null,
    };
  }

  if (!isCreate) {
    return {
      id: headerId,
      voucherNo,
      status,
      totals: validated.totals,
      queuedForApproval: true,
      approvalRequestId: await createApprovalRequest({
        trx,
        req,
        voucherId: headerId,
        voucherTypeCode,
        summary: `UPDATE ${voucherTypeCode} #${voucherNo}`,
        newValue: toApprovalPayload({
          action: "update",
          voucherTypeCode,
          voucherId: headerId,
          voucherNo,
          validated,
          permissionReroute: !canEdit,
        }),
      }),
    };
  }

  const insertedLines = await insertVoucherLinesTx({
    trx,
    voucherId: headerId,
    lines: validated.lines,
  });
  await upsertSalesHeaderExtensionsTx({
    trx,
    voucherTypeCode,
    voucherId: headerId,
    validated,
  });
  if (voucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher) {
    await syncSalesLineExtensionsTx({
      trx,
      insertedLines,
      validatedLines: validated.lines,
    });
  }
  return {
    id: headerId,
    voucherNo,
    status: "PENDING",
    totals: validated.totals,
    queuedForApproval: true,
    approvalRequestId: await createApprovalRequest({
      trx,
      req,
      voucherId: headerId,
      voucherTypeCode,
      summary: `${voucherTypeCode} #${voucherNo}`,
      newValue: toApprovalPayload({
        action: "create",
        voucherTypeCode,
        voucherId: headerId,
        voucherNo,
        validated,
        permissionReroute: !canCreate,
      }),
    }),
  };
};

const createSalesVoucher = async ({
  req,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  const result = await knex.transaction((trx) =>
    saveSalesVoucherTx({
      trx,
      req,
      voucherTypeCode,
      scopeKey,
      payload,
      mode: "create",
    }),
  );
  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "CREATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
    },
  });
  return {
    ...result,
    permissionReroute: !canDo(req, "VOUCHER", scopeKey, "create"),
  };
};

const updateSalesVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  const result = await knex.transaction((trx) =>
    saveSalesVoucherTx({
      trx,
      req,
      voucherTypeCode,
      scopeKey,
      payload,
      mode: "update",
      voucherId,
    }),
  );
  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "UPDATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
    },
  });
  return {
    ...result,
    permissionReroute: !canDo(req, "VOUCHER", scopeKey, "edit"),
    updated: !result.queuedForApproval,
  };
};

const deleteSalesVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
}) => {
  const canDelete = canDo(req, "VOUCHER", scopeKey, "delete");
  const canApprove = canApproveVoucherAction(req, scopeKey);
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const result = await knex.transaction(async (trx) => {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_no", "status")
      .where({
        id: normalizedVoucherId,
        branch_id: req.branchId,
        voucher_type_code: voucherTypeCode,
      })
      .first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (existing.status === "REJECTED")
      throw new HttpError(400, "Voucher already deleted");

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "delete",
    );
    const queuedForApproval =
      !canDelete || (policyRequiresApproval && !canApprove);
    if (!queuedForApproval) {
      await trx("erp.voucher_header").where({ id: existing.id }).update({
        status: "REJECTED",
        approved_by: req.user.id,
        approved_at: trx.fn.now(),
      });
      await syncVoucherGlPostingTx({ trx, voucherId: existing.id });
      return {
        id: existing.id,
        voucherNo: existing.voucher_no,
        status: "REJECTED",
        queuedForApproval: false,
        approvalRequestId: null,
      };
    }
    const approvalRequestId = await createApprovalRequest({
      trx,
      req,
      voucherId: existing.id,
      voucherTypeCode,
      summary: `DELETE ${voucherTypeCode} #${existing.voucher_no}`,
      newValue: {
        action: "delete",
        voucher_id: existing.id,
        voucher_no: existing.voucher_no,
        voucher_type_code: voucherTypeCode,
      },
    });
    return {
      id: existing.id,
      voucherNo: existing.voucher_no,
      status: existing.status,
      queuedForApproval: true,
      approvalRequestId,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "DELETE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
    },
  });
  return {
    ...result,
    permissionReroute: !canDelete,
    deleted: !result.queuedForApproval,
  };
};

const loadSalesVoucherOptions = async (req, context = {}) => {
  const selectedVoucher =
    context && typeof context === "object"
      ? context.selectedVoucher || null
      : null;
  const voucherTypeCode = String(context?.voucherTypeCode || "")
    .trim()
    .toUpperCase();
  let customerQuery = knex("erp.parties as p")
    .select("p.id", "p.code", "p.name", "p.phone1")
    .where({ "p.is_active": true })
    .whereRaw("upper(coalesce(p.party_type::text, '')) in ('CUSTOMER','BOTH')");
  customerQuery = customerQuery.where(function wherePartyScope() {
    this.where("p.branch_id", req.branchId).orWhereExists(
      function wherePartyBranchMap() {
        this.select(1)
          .from("erp.party_branch as pb")
          .whereRaw("pb.party_id = p.id")
          .andWhere("pb.branch_id", req.branchId);
      },
    );
  });

  const salesmenQuery = knex("erp.employees as e")
    .select("e.id", "e.code", "e.name")
    .whereRaw("lower(coalesce(e.status, '')) = 'active'")
    .whereExists(function commissionRulesExists() {
      this.select(1)
        .from("erp.employee_commission_rules as ecr")
        .whereRaw("ecr.employee_id = e.id")
        .whereRaw("lower(coalesce(ecr.status, '')) = 'active'");
    })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.employee_branch as eb")
        .whereRaw("eb.employee_id = e.id")
        .andWhere("eb.branch_id", req.branchId);
    });

  const receiveAccountsQuery = knex("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .select("a.id", "a.code", "a.name")
    .where({ "a.is_active": true })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .andWhere("ab.branch_id", req.branchId);
    })
    .whereRaw("lower(coalesce(apc.code, '')) = 'cash'");

  const [
    customers,
    salesmen,
    receiveAccounts,
    skus,
    returnReasons,
    openSalesOrderLinesRaw,
  ] = await Promise.all([
    customerQuery.orderBy("p.name", "asc"),
    salesmenQuery.orderBy("e.name", "asc"),
    receiveAccountsQuery.orderBy("a.name", "asc"),
    knex("erp.skus as s")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", "i.id", "v.item_id")
      .select(
        "s.id",
        "s.sku_code",
        "i.name as item_name",
        "i.group_id",
        "v.sale_rate",
        knex.raw(
          `(select max(sdp.max_pair_discount)
              from erp.sales_discount_policy as sdp
             where sdp.product_group_id = i.group_id
               and sdp.is_active = true) as max_pair_discount`,
        ),
      )
      .where({ "s.is_active": true, "i.is_active": true })
      .whereRaw("upper(coalesce(i.item_type::text, 'FG')) = 'FG'")
      .orderBy("i.name", "asc")
      .orderBy("s.sku_code", "asc"),
    knex("erp.return_reasons")
      .select("id", "code", "description")
      .where({ is_active: true })
      .orderBy("description", "asc"),
    loadOpenSalesOrderLinesTx({ trx: knex, req }),
  ]);

  let linkedOrderScopedLines = [];
  if (
    voucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher &&
    Number(selectedVoucher?.id || 0) > 0 &&
    Number(selectedVoucher?.linked_sales_order_id || 0) > 0
  ) {
    linkedOrderScopedLines = await loadOpenSalesOrderLinesTx({
      trx: knex,
      req,
      linkedSalesOrderId: Number(selectedVoucher.linked_sales_order_id),
      excludeSalesVoucherId: Number(selectedVoucher.id),
    });
  }

  const openLinesById = new Map();
  (openSalesOrderLinesRaw || []).forEach((row) => {
    const lineId = Number(row?.sales_order_line_id || 0);
    if (lineId > 0) openLinesById.set(lineId, row);
  });
  (linkedOrderScopedLines || []).forEach((row) => {
    const lineId = Number(row?.sales_order_line_id || 0);
    if (lineId > 0) openLinesById.set(lineId, row);
  });

  const openSalesOrderLines = [...openLinesById.values()];

  const orderMap = new Map();
  openSalesOrderLines.forEach((row) => {
    if (!orderMap.has(Number(row.sales_order_id))) {
      orderMap.set(Number(row.sales_order_id), {
        id: Number(row.sales_order_id),
        voucher_no: Number(row.sales_order_voucher_no),
        book_no: String(row.sales_order_book_no || "").trim(),
        voucher_date: toDateOnly(row.sales_order_voucher_date),
        customer_party_id: Number(row.customer_party_id),
        salesman_employee_id: Number(row.salesman_employee_id),
        payment_received_amount: Number(
          row.sales_order_payment_received_amount || 0,
        ),
        receive_into_account_id:
          Number(row.sales_order_receive_into_account_id || 0) || null,
      });
    }
  });

  const selectedLinkedOrderId = Number(
    selectedVoucher?.linked_sales_order_id || 0,
  );
  const allOrderIdsForSummary = [...orderMap.keys()];
  if (
    selectedLinkedOrderId > 0 &&
    !allOrderIdsForSummary.includes(selectedLinkedOrderId)
  ) {
    allOrderIdsForSummary.push(selectedLinkedOrderId);
  }
  const excludeSalesVoucherId =
    voucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher
      ? Number(selectedVoucher?.id || 0) || null
      : null;
  const receivableSummaryMap = await loadSalesOrderReceivableSummaryMapTx({
    trx: knex,
    req,
    salesOrderIds: allOrderIdsForSummary,
    excludeSalesVoucherId,
  });

  orderMap.forEach((order, orderId) => {
    const summary = receivableSummaryMap.get(Number(orderId));
    if (!summary) return;
    order.sales_order_advance_amount = Number(
      summary.salesOrderAdvanceAmount || 0,
    );
    order.linked_vouchers_received_amount = Number(
      summary.linkedVouchersReceivedAmount || 0,
    );
    order.total_order_amount = Number(summary.totalOrderAmount || 0);
    order.previous_payments_received = Number(
      summary.previousPaymentsReceived || 0,
    );
    order.payment_received_amount = Number(
      summary.previousPaymentsReceived || 0,
    );
  });

  if (selectedLinkedOrderId > 0 && !orderMap.has(selectedLinkedOrderId)) {
    const selectedSummary = receivableSummaryMap.get(selectedLinkedOrderId);
    orderMap.set(selectedLinkedOrderId, {
      id: selectedLinkedOrderId,
      voucher_no: Number(selectedVoucher?.linked_sales_order_voucher_no || 0),
      book_no: String(selectedVoucher?.linked_sales_order_book_no || "").trim(),
      voucher_date: toDateOnly(
        selectedVoucher?.linked_sales_order_voucher_date,
      ),
      customer_party_id:
        Number(selectedVoucher?.customer_party_id || 0) || null,
      salesman_employee_id:
        Number(selectedVoucher?.salesman_employee_id || 0) || null,
      receive_into_account_id:
        Number(
          selectedVoucher?.linked_sales_order_receive_into_account_id || 0,
        ) || null,
      sales_order_advance_amount: Number(
        selectedSummary?.salesOrderAdvanceAmount ||
          selectedVoucher?.linked_sales_order_advance_amount ||
          selectedVoucher?.linked_sales_order_payment_received_amount ||
          0,
      ),
      linked_vouchers_received_amount: Number(
        selectedSummary?.linkedVouchersReceivedAmount || 0,
      ),
      total_order_amount: Number(
        selectedSummary?.totalOrderAmount ||
          selectedVoucher?.linked_sales_order_total_amount ||
          0,
      ),
      previous_payments_received: Number(
        selectedSummary?.previousPaymentsReceived ||
          selectedVoucher?.linked_sales_order_previous_payments_received ||
          selectedVoucher?.linked_sales_order_payment_received_amount ||
          0,
      ),
      payment_received_amount: Number(
        selectedSummary?.previousPaymentsReceived ||
          selectedVoucher?.linked_sales_order_previous_payments_received ||
          selectedVoucher?.linked_sales_order_payment_received_amount ||
          0,
      ),
    });
  }

  const openSalesOrders = [...orderMap.values()].sort(
    (a, b) => Number(b.voucher_no) - Number(a.voucher_no),
  );

  return {
    customers,
    salesmen,
    receiveAccounts,
    skus,
    returnReasons,
    openSalesOrders,
    openSalesOrderLines,
  };
};

const loadRecentSalesVouchers = async ({ req, voucherTypeCode }) => {
  const rows = await knex("erp.voucher_header")
    .select(
      "id",
      "voucher_no",
      "voucher_date",
      "status",
      "book_no",
      "remarks",
      "created_at",
    )
    .where({ voucher_type_code: voucherTypeCode, branch_id: req.branchId })
    .whereNot({ status: "REJECTED" })
    .orderBy("id", "desc")
    .limit(20);
  return rows.map((row) => ({
    ...row,
    voucher_date: toDateOnly(row.voucher_date),
  }));
};

const getSalesVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
  const base = () =>
    knex("erp.voucher_header").where({
      voucher_type_code: voucherTypeCode,
      branch_id: req.branchId,
    });
  const [latestAny, latestActive] = await Promise.all([
    base().max({ value: "voucher_no" }).first(),
    base()
      .whereNot({ status: "REJECTED" })
      .max({ value: "voucher_no" })
      .first(),
  ]);
  return {
    latestVoucherNo: Number(latestAny?.value || 0),
    latestActiveVoucherNo: Number(latestActive?.value || 0),
  };
};

const getSalesVoucherNeighbours = async ({
  req,
  voucherTypeCode,
  cursorNo,
}) => {
  const normalized = parseVoucherNo(cursorNo);
  if (!normalized) return { prevVoucherNo: null, nextVoucherNo: null };
  const base = () =>
    knex("erp.voucher_header").where({
      voucher_type_code: voucherTypeCode,
      branch_id: req.branchId,
    });
  const [prevRow, nextRow] = await Promise.all([
    base()
      .where("voucher_no", "<", normalized)
      .max({ value: "voucher_no" })
      .first(),
    base()
      .where("voucher_no", ">", normalized)
      .min({ value: "voucher_no" })
      .first(),
  ]);
  return {
    prevVoucherNo: Number(prevRow?.value || 0) || null,
    nextVoucherNo: Number(nextRow?.value || 0) || null,
  };
};

const loadSalesVoucherDetails = async ({ req, voucherTypeCode, voucherNo }) => {
  const targetNo = parseVoucherNo(voucherNo);
  if (!targetNo) return null;
  const header = await knex("erp.voucher_header")
    .select("id", "voucher_no", "voucher_date", "status", "book_no", "remarks")
    .where({
      branch_id: req.branchId,
      voucher_type_code: voucherTypeCode,
      voucher_no: targetNo,
    })
    .first();
  if (!header) return null;

  const lines = await knex("erp.voucher_line as vl")
    .join("erp.skus as s", "s.id", "vl.sku_id")
    .leftJoin("erp.variants as v", "v.id", "s.variant_id")
    .leftJoin("erp.items as i", "i.id", "v.item_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.sku_id",
      "s.sku_code",
      "i.name as item_name",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
    )
    .where({ "vl.voucher_header_id": header.id, "vl.line_kind": "SKU" })
    .orderBy("vl.line_no", "asc");

  const details = {
    id: Number(header.id),
    voucher_no: Number(header.voucher_no),
    voucher_date: toDateOnly(header.voucher_date),
    status: String(header.status || "").toUpperCase(),
    book_no: header.book_no || "",
    reference_no: header.book_no || "",
    description: header.remarks || "",
    lines: lines.map((line) => {
      const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
      return {
        id: Number(line.id),
        line_no: Number(line.line_no),
        sku_id: Number(line.sku_id),
        sku_code: String(line.sku_code || ""),
        item_name: String(line.item_name || ""),
        qty: Number(line.qty || 0),
        rate: Number(line.rate || 0),
        amount: Number(line.amount || 0),
        row_status: normalizeRowStatus(meta.row_status),
        sale_qty: Number(meta.sale_qty || 0),
        return_qty: Number(meta.return_qty || 0),
        return_reason_id: toPositiveInt(meta.return_reason_id),
        pair_rate: Number(meta.pair_rate || line.rate || 0),
        pair_discount: Number(meta.pair_discount || 0),
        total_discount: Number(meta.total_discount || 0),
        total_amount: Number(
          meta.total_amount || Math.abs(Number(line.amount || 0)),
        ),
        total_pairs: Number(meta.total_pairs || line.qty || 0),
        sales_order_line_id: toPositiveInt(meta.sales_order_line_id),
      };
    }),
  };

  if (voucherTypeCode === SALES_VOUCHER_TYPES.salesOrder) {
    const ext = await knex("erp.sales_order_header")
      .where({ voucher_id: header.id })
      .first();
    const party = ext?.customer_party_id
      ? await knex("erp.parties")
          .select("name", "phone1")
          .where({ id: ext.customer_party_id })
          .first()
      : null;
    details.customer_party_id = Number(ext?.customer_party_id || 0) || null;
    details.customer_name = String(party?.name || "").trim();
    details.customer_phone_number = String(party?.phone1 || "").trim();
    details.salesman_employee_id =
      Number(ext?.salesman_employee_id || 0) || null;
    details.payment_received_amount = Number(ext?.payment_received_amount || 0);
    details.advance_receive =
      Number(ext?.payment_received_amount || 0) > 0 ? "yes" : "no";
    details.receive_into_account_id =
      Number(ext?.receive_into_account_id || 0) || null;
    details.delivery_method = "CUSTOMER_PICKUP";
    details.sale_mode = "DIRECT";
    details.payment_type = "CASH";
  } else {
    const ext = await knex("erp.sales_header")
      .where({ voucher_id: header.id })
      .first();
    details.customer_party_id = Number(ext?.customer_party_id || 0) || null;
    details.customer_name = ext?.customer_name || "";
    details.customer_phone_number = ext?.customer_phone_number || "";
    details.salesman_employee_id =
      Number(ext?.salesman_employee_id || 0) || null;
    details.sale_mode = normalizeSaleMode(ext?.sale_mode);
    details.payment_type = normalizePaymentType(ext?.payment_type);
    let linkedSalesOrderId = Number(ext?.linked_sales_order_id || 0) || null;
    if (
      !linkedSalesOrderId &&
      normalizeSaleMode(ext?.sale_mode) === "FROM_SO"
    ) {
      const inferredLinkedOrder = await knex("erp.voucher_line as svl")
        .joinRaw(
          "join erp.voucher_line as sol on sol.id = cast(svl.meta->>'sales_order_line_id' as bigint)",
        )
        .join(
          "erp.voucher_header as so_vh",
          "so_vh.id",
          "sol.voucher_header_id",
        )
        .select("so_vh.id as sales_order_id")
        .where({ "svl.voucher_header_id": header.id, "svl.line_kind": "SKU" })
        .whereRaw("coalesce(svl.meta->>'movement_kind', '') = 'SALE'")
        .whereRaw("coalesce(svl.meta->>'sales_order_line_id', '') ~ '^[0-9]+$'")
        .where({
          "so_vh.branch_id": req.branchId,
          "so_vh.voucher_type_code": SALES_VOUCHER_TYPES.salesOrder,
        })
        .orderBy("svl.line_no", "asc")
        .first();
      linkedSalesOrderId =
        Number(inferredLinkedOrder?.sales_order_id || 0) || null;
    }

    details.linked_sales_order_id = linkedSalesOrderId;
    details.payment_due_date = toDateOnly(ext?.payment_due_date);
    details.receive_into_account_id =
      Number(ext?.receive_into_account_id || 0) || null;
    details.payment_received_amount = Number(ext?.payment_received_amount || 0);
    details.delivery_method = normalizeDeliveryMethod(ext?.delivery_method);
    details.extra_discount = Number(ext?.extra_discount || 0);

    if (linkedSalesOrderId) {
      const linkedOrder = await knex("erp.voucher_header as vh")
        .join("erp.sales_order_header as soh", "soh.voucher_id", "vh.id")
        .select(
          "vh.id",
          "vh.voucher_no",
          "vh.book_no",
          "vh.voucher_date",
          "soh.payment_received_amount",
          "soh.customer_party_id",
          "soh.salesman_employee_id",
          "soh.receive_into_account_id",
        )
        .where({
          "vh.id": linkedSalesOrderId,
          "vh.branch_id": req.branchId,
          "vh.voucher_type_code": SALES_VOUCHER_TYPES.salesOrder,
        })
        .first();

      const receivableSummary = await fetchSalesOrderReceivableSummaryTx({
        trx: knex,
        req,
        linkedSalesOrderId,
        excludeSalesVoucherId: Number(header.id),
      });

      if (linkedOrder) {
        details.linked_sales_order_voucher_no = Number(
          linkedOrder.voucher_no || 0,
        );
        details.linked_sales_order_book_no = String(
          linkedOrder.book_no || "",
        ).trim();
        details.linked_sales_order_voucher_date = toDateOnly(
          linkedOrder.voucher_date,
        );
        details.linked_sales_order_payment_received_amount = Number(
          linkedOrder.payment_received_amount || 0,
        );
        details.linked_sales_order_advance_amount = Number(
          receivableSummary.salesOrderAdvanceAmount || 0,
        );
        details.linked_sales_order_previous_payments_received = Number(
          receivableSummary.previousPaymentsReceived || 0,
        );
        details.linked_sales_order_total_amount = Number(
          receivableSummary.totalOrderAmount || 0,
        );
        details.linked_sales_order_receive_into_account_id =
          Number(linkedOrder.receive_into_account_id || 0) || null;
        if (!details.customer_party_id) {
          details.customer_party_id =
            Number(linkedOrder.customer_party_id || 0) || null;
        }
        if (!details.salesman_employee_id) {
          details.salesman_employee_id =
            Number(linkedOrder.salesman_employee_id || 0) || null;
        }
      }
    }
  }

  return details;
};

const loadSalesGatePassDetails = async ({
  req,
  voucherTypeCode,
  voucherNo,
}) => {
  const details = await loadSalesVoucherDetails({
    req,
    voucherTypeCode,
    voucherNo,
  });
  if (!details) return null;
  const lines = (details.lines || []).filter(
    (line) => Number(line.sale_qty || 0) > 0,
  );
  return {
    voucher_no: details.voucher_no,
    voucher_date: details.voucher_date,
    customer_name: details.customer_name || "",
    customer_phone_number: details.customer_phone_number || "",
    delivery_method: details.delivery_method || "CUSTOMER_PICKUP",
    lines,
  };
};

const applySalesVoucherUpdatePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  payload,
  req,
}) => {
  const validated = await validateSalesPayloadTx({
    trx,
    req,
    voucherTypeCode,
    payload,
    excludeSalesVoucherId: voucherId,
    allowRateDiscountOverride: true,
    allowCashPaymentOverride: true,
  });
  await trx("erp.voucher_header").where({ id: voucherId }).update({
    voucher_date: validated.voucherDate,
    book_no: validated.bookNo,
    remarks: validated.remarks,
  });
  await trx("erp.voucher_line").where({ voucher_header_id: voucherId }).del();
  const insertedLines = await insertVoucherLinesTx({
    trx,
    voucherId,
    lines: validated.lines,
  });
  await upsertSalesHeaderExtensionsTx({
    trx,
    voucherTypeCode,
    voucherId,
    validated,
  });
  if (voucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher) {
    await syncSalesLineExtensionsTx({
      trx,
      insertedLines,
      validatedLines: validated.lines,
    });
  }
};

module.exports = {
  SALES_VOUCHER_TYPES,
  parseVoucherNo,
  createSalesVoucher,
  updateSalesVoucher,
  deleteSalesVoucher,
  loadSalesVoucherOptions,
  loadRecentSalesVouchers,
  getSalesVoucherSeriesStats,
  getSalesVoucherNeighbours,
  loadSalesVoucherDetails,
  loadSalesGatePassDetails,
  applySalesVoucherUpdatePayloadTx,
};
