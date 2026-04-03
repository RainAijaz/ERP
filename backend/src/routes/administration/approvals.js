const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const { applyMasterDataChange } = require("../../utils/approval-applier");
const { navConfig, getNavScopes } = require("../../utils/nav-config");
const {
  BASIC_INFO_ENTITY_TYPES,
  SCREEN_ENTITY_TYPES,
} = require("../../utils/approval-entity-map");
const {
  resolveApprovalPreview,
} = require("../../utils/approval-preview-registry");
const { notifyApprovalDecision } = require("../../utils/approval-events");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const { insertActivityLog } = require("../../utils/audit-log");
const {
  inferAction,
  parseEditedPayload,
  sanitizeEditedValues,
  getEditableKeys,
} = require("../../utils/approval-request-edit");
const {
  syncAutoBankSettlementForVoucherTx,
  markBankVoucherLinesRejectedTx,
} = require("../../services/financial/voucher-service");
const {
  syncVoucherGlPostingTx,
} = require("../../services/financial/gl-posting-service");
const {
  PURCHASE_VOUCHER_TYPES,
  applyPurchaseVoucherUpdatePayloadTx,
  applyPurchaseVoucherDeletePayloadTx,
  ensurePurchaseVoucherDerivedDataTx,
} = require("../../services/purchase/purchase-voucher-service");
const {
  SALES_VOUCHER_TYPES,
  applySalesVoucherUpdatePayloadTx,
  applySalesVoucherDeletePayloadTx,
  ensureSalesVoucherDerivedDataTx,
} = require("../../services/sales/sales-voucher-service");
const {
  RETURNABLE_VOUCHER_TYPES,
  applyReturnableVoucherCreatePayloadTx,
  applyReturnableVoucherUpdatePayloadTx,
  applyReturnableVoucherDeletePayloadTx,
} = require("../../services/returnables/returnable-voucher-service");
const {
  isProductionVoucherType,
  ensureProductionVoucherDerivedDataTx,
  applyProductionVoucherUpdatePayloadTx,
  applyProductionVoucherDeletePayloadTx,
} = require("../../services/production/production-voucher-service");
const {
  INVENTORY_VOUCHER_TYPES,
  isInventoryVoucherTypeCode,
  ensureInventoryVoucherDerivedDataTx,
  applyInventoryVoucherUpdatePayloadTx,
  applyInventoryVoucherDeletePayloadTx,
} = require("../../services/inventory/inventory-voucher-service");
const {
  STOCK_TRANSFER_VOUCHER_TYPES,
  ensureStockTransferVoucherDerivedDataTx,
  applyStockTransferVoucherUpdatePayloadTx,
  applyStockTransferVoucherDeletePayloadTx,
} = require("../../services/inventory/stock-transfer-voucher-service");
const basicInfoRoutes = require("../master_data/basic-info");
const uomConversionsRoutes = require("../master_data/basic-info/uom-conversions");
const accountsRoutes = require("../master_data/accounts");
const partiesRoutes = require("../master_data/parties");
const returnableAssetsRoutes = require("../master_data/returnable-assets");
const assetTypesRoutes = require("../master_data/asset-types");
const finishedRoutes = require("../master_data/products/finished");
const rawMaterialsRoutes = require("../master_data/products/raw-materials");
const semiFinishedRoutes = require("../master_data/products/semi-finished");
const skuRoutes = require("../master_data/products/skus");
const hrEmployeesRoutes = require("../hr-payroll/employees");
const hrLaboursRoutes = require("../hr-payroll/labours");
const hrCommissionsRoutes = require("../hr-payroll/commissions");
const hrAllowancesRoutes = require("../hr-payroll/allowances");
const {
  buildBulkPreviewRows: buildCommissionBulkPreviewRows,
} = require("../../services/hr-payroll/commission-rules-service");
const {
  ALL_LABOURS_VALUE,
  resolveLabourIds,
  buildBulkPreviewRows: buildLabourRateBulkPreviewRows,
} = require("../../services/hr-payroll/labour-rates-service");
const bomService = require("../../services/bom/service");

const router = express.Router();

// Helper for rendering
const renderPage = (req, res, view, title, payload = {}) =>
  res.render("base/layouts/main", {
    title,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view,
    t: res.locals.t,
    ...payload,
  });

const setUiNotice = (res, message, options = {}) => {
  if (!message) return;
  setCookie(res, UI_NOTICE_COOKIE, JSON.stringify({ message, ...options }), {
    path: "/",
    maxAge: 30,
    sameSite: "Lax",
  });
};

const ACTION_LABELS = {
  create: "create",
  update: "edit",
  delete: "delete",
};

const applyVoucherApprovalChangeTx = async ({
  trx,
  request,
  approverId,
  req,
}) => {
  const payload =
    request?.new_value && typeof request.new_value === "object"
      ? request.new_value
      : {};
  const action = String(payload.action || "").toLowerCase();
  const payloadVoucherTypeCode = String(payload.voucher_type_code || "")
    .trim()
    .toUpperCase();
  const isReturnableVoucherType =
    payloadVoucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch ||
    payloadVoucherTypeCode === RETURNABLE_VOUCHER_TYPES.receipt;
  const approvalReq = {
    ...req,
    branchId: Number(request.branch_id || req?.branchId || 0),
    user: { ...(req?.user || {}), id: approverId },
  };
  const requestEntityId = String(request.entity_id || "").trim();
  const voucherId = Number(request.entity_id || payload.voucher_id || 0);

  if (
    action === "create" &&
    requestEntityId === "NEW" &&
    isReturnableVoucherType
  ) {
    const created = await applyReturnableVoucherCreatePayloadTx({
      trx,
      payload,
      approverId,
      req: approvalReq,
    });
    return {
      appliedEntityId: created?.id ? String(created.id) : null,
    };
  }

  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    throw new Error("Invalid voucher id in approval payload");
  }

  if (isReturnableVoucherType && action === "delete") {
    await applyReturnableVoucherDeletePayloadTx({
      trx,
      voucherId,
      voucherTypeCode: payloadVoucherTypeCode,
      approverId,
    });
    return;
  }

  if (isReturnableVoucherType && action === "update") {
    await applyReturnableVoucherUpdatePayloadTx({
      trx,
      voucherId,
      voucherTypeCode: payloadVoucherTypeCode,
      payload,
      approverId,
      req: approvalReq,
    });
    return;
  }

  if (action === "delete") {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_type_code")
      .where({ id: voucherId })
      .first();
    if (!existing) {
      throw new Error("Voucher not found during delete approval apply");
    }
    const existingVoucherTypeCode = String(
      existing.voucher_type_code || "",
    ).toUpperCase();
    if (isProductionVoucherType(existingVoucherTypeCode)) {
      await applyProductionVoucherDeletePayloadTx({
        trx,
        voucherId,
        voucherTypeCode: existingVoucherTypeCode,
        approverId,
      });
      return;
    }
    if (
      existingVoucherTypeCode === PURCHASE_VOUCHER_TYPES.goodsReceiptNote ||
      existingVoucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase ||
      existingVoucherTypeCode === PURCHASE_VOUCHER_TYPES.purchaseReturn
    ) {
      await applyPurchaseVoucherDeletePayloadTx({
        trx,
        voucherId,
        voucherTypeCode: existingVoucherTypeCode,
        approverId,
      });
      return;
    }
    if (
      existingVoucherTypeCode === SALES_VOUCHER_TYPES.salesOrder ||
      existingVoucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher
    ) {
      await applySalesVoucherDeletePayloadTx({
        trx,
        voucherId,
        voucherTypeCode: existingVoucherTypeCode,
        approverId,
      });
      return;
    }
    // Inventory vouchers (opening stock + stock count) use dedicated stock rollback replay.
    if (isInventoryVoucherTypeCode(existingVoucherTypeCode)) {
      await applyInventoryVoucherDeletePayloadTx({
        trx,
        voucherId,
        voucherTypeCode: existingVoucherTypeCode,
        approverId,
      });
      return;
    }
    if (
      existingVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out ||
      existingVoucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.in
    ) {
      await applyStockTransferVoucherDeletePayloadTx({
        trx,
        voucherId,
        voucherTypeCode: existingVoucherTypeCode,
        approverId,
      });
      return;
    }

    if (existingVoucherTypeCode === "BANK_VOUCHER") {
      await markBankVoucherLinesRejectedTx({ trx, voucherId });
    }

    const updated = await trx("erp.voucher_header")
      .where({ id: voucherId })
      .whereNot({ status: "REJECTED" })
      .update({
        status: "REJECTED",
        approved_by: approverId,
        approved_at: trx.fn.now(),
      });
    if (!updated) {
      throw new Error("Voucher delete approval apply failed");
    }
    await syncAutoBankSettlementForVoucherTx({
      trx,
      voucherId,
      actorUserId: approverId,
    });
    await syncVoucherGlPostingTx({ trx, voucherId });
    return;
  }

  if (action !== "update") {
    const existing = await trx("erp.voucher_header")
      .select("id", "voucher_type_code")
      .where({ id: voucherId })
      .first();
    if (!existing) {
      throw new Error("Voucher not found during approval apply");
    }
    const voucherTypeCode = String(
      existing.voucher_type_code || payloadVoucherTypeCode || "",
    ).toUpperCase();

    const updated = await trx("erp.voucher_header")
      .where({ id: voucherId, status: "PENDING" })
      .update({
        status: "APPROVED",
        approved_by: approverId,
        approved_at: trx.fn.now(),
      });
    if (!updated) {
      throw new Error("Voucher approval apply failed");
    }
    if (isProductionVoucherType(voucherTypeCode)) {
      await ensureProductionVoucherDerivedDataTx({
        trx,
        voucherId,
        voucherTypeCode,
        actorUserId: approverId,
        // Preserve admin operational override when approval application replays derived production posting.
        allowNegativeRm: req?.user?.isAdmin === true,
      });
    }
    if (
      voucherTypeCode === PURCHASE_VOUCHER_TYPES.goodsReceiptNote ||
      voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase ||
      voucherTypeCode === PURCHASE_VOUCHER_TYPES.purchaseReturn
    ) {
      await ensurePurchaseVoucherDerivedDataTx({
        trx,
        voucherId,
        voucherTypeCode,
        req: approvalReq,
      });
    }
    if (
      voucherTypeCode === SALES_VOUCHER_TYPES.salesOrder ||
      voucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher
    ) {
      await ensureSalesVoucherDerivedDataTx({
        trx,
        voucherId,
        voucherTypeCode,
      });
    }
    if (isInventoryVoucherTypeCode(voucherTypeCode)) {
      // Inventory vouchers must replay derived stock sync on approve.
      await ensureInventoryVoucherDerivedDataTx({
        trx,
        voucherId,
        voucherTypeCode,
      });
    }
    if (
      voucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out ||
      voucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.in
    ) {
      await ensureStockTransferVoucherDerivedDataTx({
        trx,
        voucherId,
        voucherTypeCode,
      });
    }
    await syncAutoBankSettlementForVoucherTx({
      trx,
      voucherId,
      actorUserId: approverId,
    });
    await syncVoucherGlPostingTx({ trx, voucherId });
    return;
  }

  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const existing = await trx("erp.voucher_header")
    .select("id", "voucher_type_code")
    .where({ id: voucherId })
    .first();
  if (!existing) {
    throw new Error("Voucher not found during approval apply");
  }
  const voucherTypeCode = String(
    existing.voucher_type_code || "",
  ).toUpperCase();
  if (isProductionVoucherType(voucherTypeCode)) {
    await applyProductionVoucherUpdatePayloadTx({
      trx,
      voucherId,
      voucherTypeCode,
      payload,
      req: approvalReq,
      approverId,
    });
    await syncAutoBankSettlementForVoucherTx({
      trx,
      voucherId,
      actorUserId: approverId,
    });
    return;
  }

  const hasHeaderAccount = Object.prototype.hasOwnProperty.call(
    payload,
    "header_account_id",
  );
  const hasReferenceNo = Object.prototype.hasOwnProperty.call(
    payload,
    "reference_no",
  );
  const hasDescription = Object.prototype.hasOwnProperty.call(
    payload,
    "description",
  );
  const hasRemarks = Object.prototype.hasOwnProperty.call(payload, "remarks");
  const hasVoucherDate = Object.prototype.hasOwnProperty.call(
    payload,
    "voucher_date",
  );

  await trx("erp.voucher_header")
    .where({ id: voucherId })
    .update({
      voucher_date: hasVoucherDate
        ? payload.voucher_date || null
        : trx.raw("voucher_date"),
      header_account_id: hasHeaderAccount
        ? Number(payload.header_account_id || 0) > 0
          ? Number(payload.header_account_id)
          : null
        : trx.raw("header_account_id"),
      book_no: hasReferenceNo
        ? payload.reference_no || null
        : trx.raw("book_no"),
      remarks: hasDescription
        ? (payload.description ?? null)
        : hasRemarks
          ? (payload.remarks ?? null)
          : trx.raw("remarks"),
      status: "APPROVED",
      approved_by: approverId,
      approved_at: trx.fn.now(),
    });

  await trx("erp.voucher_line").where({ voucher_header_id: voucherId }).del();
  if (lines.length) {
    const lineRows = lines.map((line, index) => {
      const toNullableId = (value) => {
        const n = Number(value || 0);
        return Number.isInteger(n) && n > 0 ? n : null;
      };
      const colorId = toNullableId(line.color_id);
      const lineMeta =
        line.meta && typeof line.meta === "object" ? { ...line.meta } : {};
      if (colorId && !lineMeta.color_id) lineMeta.color_id = colorId;

      return {
        voucher_header_id: voucherId,
        line_no: Number(line.line_no || index + 1),
        line_kind: String(
          line.line_kind || (toNullableId(line.item_id) ? "ITEM" : "ACCOUNT"),
        ).toUpperCase(),
        item_id: toNullableId(line.item_id),
        sku_id: toNullableId(line.sku_id),
        account_id: toNullableId(line.account_id),
        party_id: toNullableId(line.party_id),
        labour_id: toNullableId(line.labour_id),
        employee_id: toNullableId(line.employee_id),
        uom_id: toNullableId(line.uom_id),
        qty: Number(line.qty || 0),
        rate: Number(line.rate || 0),
        amount: Number(line.amount || 0),
        reference_no: line.reference_no || null,
        meta: lineMeta,
      };
    });
    await trx("erp.voucher_line").insert(lineRows);
  }

  if (
    voucherTypeCode === PURCHASE_VOUCHER_TYPES.goodsReceiptNote ||
    voucherTypeCode === PURCHASE_VOUCHER_TYPES.generalPurchase ||
    voucherTypeCode === PURCHASE_VOUCHER_TYPES.purchaseReturn
  ) {
    await applyPurchaseVoucherUpdatePayloadTx({
      trx,
      voucherId,
      voucherTypeCode,
      payload,
      req: approvalReq,
    });
  }

  if (
    voucherTypeCode === SALES_VOUCHER_TYPES.salesOrder ||
    voucherTypeCode === SALES_VOUCHER_TYPES.salesVoucher
  ) {
    await applySalesVoucherUpdatePayloadTx({
      trx,
      voucherId,
      voucherTypeCode,
      payload,
      req: approvalReq,
    });
  }

  if (isInventoryVoucherTypeCode(voucherTypeCode)) {
    // Approved edit replay recalculates inventory balance/ledger from current lines.
    await applyInventoryVoucherUpdatePayloadTx({
      trx,
      voucherId,
      voucherTypeCode,
      payload,
    });
  }
  if (
    voucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.out ||
    voucherTypeCode === STOCK_TRANSFER_VOUCHER_TYPES.in
  ) {
    await applyStockTransferVoucherUpdatePayloadTx({
      trx,
      voucherId,
      voucherTypeCode,
      payload,
      req: approvalReq,
      approverId,
    });
  }

  await syncAutoBankSettlementForVoucherTx({
    trx,
    voucherId,
    actorUserId: approverId,
  });
  await syncVoucherGlPostingTx({ trx, voucherId });
};

const ENTITY_TO_BASIC_INFO = Object.entries(BASIC_INFO_ENTITY_TYPES).reduce(
  (acc, [key, value]) => {
    acc[value] = key;
    return acc;
  },
  {},
);

const ENTITY_TO_SCREEN = Object.entries(SCREEN_ENTITY_TYPES).reduce(
  (acc, [screen, entity]) => {
    acc[entity] = screen;
    return acc;
  },
  {},
);

const getPreviewValues = (request, side) => {
  if (side === "old") return request?.old_value || null;
  return request?.new_value || null;
};

const normalizeArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const compactJoin = (parts) =>
  parts
    .map((part) => (part == null ? "" : String(part).trim()))
    .filter(Boolean)
    .join(" ");

const buildSkuLabel = ({
  skuCode,
  itemName,
  sizeName,
  packingName,
  gradeName,
  colorName,
  suffix,
}) => {
  const detailed = compactJoin([
    itemName,
    sizeName,
    packingName,
    gradeName,
    colorName,
    suffix,
  ]);
  if (detailed) return detailed;
  return skuCode || "-";
};

const safeJson = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
};

const parseSummaryVoucherTypeCode = (summary) => {
  const text = String(summary || "").toUpperCase();
  if (!text) return "";
  const match = text.match(/([A-Z]+_VOUCHER)/);
  return match ? String(match[1]) : "";
};

const parseSummaryVoucherNo = (summary) => {
  const text = String(summary || "");
  const match = text.match(/#\s*(\d+)/);
  if (!match) return null;
  const voucherNo = Number(match[1]);
  return Number.isInteger(voucherNo) && voucherNo > 0 ? voucherNo : null;
};

const getLocalizedLabel = (t, key, fallback) => {
  if (typeof t !== "function") return fallback;
  const translated = String(t(key) || "").trim();
  if (!translated || translated === key) return fallback;
  return translated;
};

const mapVoucherActionLabel = (action, t) => {
  const normalized = String(action || "")
    .trim()
    .toLowerCase();
  if (normalized === "create") return getLocalizedLabel(t, "add", "ADD");
  if (normalized === "update") return getLocalizedLabel(t, "edit", "EDIT");
  if (normalized === "delete") return getLocalizedLabel(t, "delete", "DELETE");
  if (normalized === "update_bank_line_status") {
    const statusLabel = getLocalizedLabel(t, "status", "STATUS");
    const updateLabel = getLocalizedLabel(t, "edit", "UPDATE");
    return `${statusLabel} ${updateLabel}`.trim();
  }
  return "";
};

const normalizeVoucherApprovalSummary = (row, t) => {
  const requestType = String(row?.request_type || "").toUpperCase();
  const entityType = String(row?.entity_type || "").toUpperCase();
  if (requestType !== "VOUCHER" && entityType !== "VOUCHER")
    return String(row?.summary || "");

  const newValue = safeJson(row?.new_value) || {};
  const oldValue = safeJson(row?.old_value) || {};

  const payloadAction = String(newValue?.action || "")
    .trim()
    .toLowerCase();
  const rowAction = String(row?.action || "")
    .trim()
    .toLowerCase();
  const fallbackAction =
    oldValue && Object.keys(oldValue).length ? "update" : "create";
  const effectiveAction = payloadAction || rowAction || fallbackAction;

  const actionLabel =
    mapVoucherActionLabel(effectiveAction, t) ||
    getLocalizedLabel(t, "action", "ACTION");
  const voucherTypeCode = String(
    newValue?.voucher_type_code || row?.entity_id || "",
  )
    .toUpperCase()
    .includes("_VOUCHER")
    ? String(newValue?.voucher_type_code || row?.entity_id || "").toUpperCase()
    : parseSummaryVoucherTypeCode(row?.summary);

  const voucherTypeLabel = voucherTypeCode
    ? voucherTypeCode.replace(/_/g, " ")
    : "VOUCHER";
  const voucherNoFromPayload = Number(newValue?.voucher_no || 0);
  const voucherNo =
    Number.isInteger(voucherNoFromPayload) && voucherNoFromPayload > 0
      ? voucherNoFromPayload
      : parseSummaryVoucherNo(row?.summary);
  const lineNo = Number(newValue?.line_no || 0);

  if (effectiveAction === "update_bank_line_status") {
    const lineWord = getLocalizedLabel(t, "line", "LINE");
    const lineLabel =
      Number.isInteger(lineNo) && lineNo > 0 ? ` ${lineWord} ${lineNo}` : "";
    return `${actionLabel} ${voucherTypeLabel}${lineLabel}`.trim();
  }

  if (actionLabel === "ADD") {
    return `${actionLabel} ${voucherTypeLabel}`;
  }

  if (Number.isInteger(voucherNo) && voucherNo > 0) {
    return `${actionLabel} ${voucherTypeLabel} #${voucherNo}`;
  }

  return `${actionLabel} ${voucherTypeLabel}`;
};

const resolveApprovalRequestVoucherTypeCode = (request) => {
  const direct = String(request?.voucher_type_code || "")
    .trim()
    .toUpperCase();
  if (direct) return direct;

  const payload = safeJson(request?.new_value) || {};
  const fromPayload = String(
    payload?.voucher_type_code || payload?.voucherTypeCode || "",
  )
    .trim()
    .toUpperCase();
  if (fromPayload) return fromPayload;

  return parseSummaryVoucherTypeCode(request?.summary);
};

const resolveHrScopeKey = (request, values = {}) => {
  const scopeKey = String(
    values?._scope_key ||
      request?.new_value?._scope_key ||
      request?.old_value?._scope_key ||
      "",
  ).trim();
  if (scopeKey) return scopeKey;

  const mode = String(
    values?.mode || request?.new_value?.mode || "",
  ).toUpperCase();
  if (mode === "BULK_COMMISSION_SKU_UPSERT" || mode === "SKU_MULTI_UPSERT")
    return "hr_payroll.commissions";
  if (mode === "BULK_LABOUR_RATE_SKU_UPSERT") return "hr_payroll.labour_rates";

  const summary = String(request?.summary || "").toLowerCase();
  if (summary.includes("commission")) return "hr_payroll.commissions";
  if (summary.includes("allowance")) return "hr_payroll.allowances";
  if (summary.includes("labour rate")) return "hr_payroll.labour_rates";
  if (summary.includes("labour")) return "hr_payroll.labours";
  if (summary.includes("employee")) return "hr_payroll.employees";
  return "";
};

const normalizeRowsForLookup = (rowsValue) => {
  const rows = Array.isArray(rowsValue) ? rowsValue : [];
  return rows
    .map((row) => (row && typeof row === "object" ? row : {}))
    .map((row) => {
      const skuId = Number(row.sku_id || row.skuId || 0);
      const rate = row.new_rate ?? row.rate ?? row.value ?? null;
      if (!Number.isInteger(skuId) || skuId <= 0) return null;
      return { ...row, sku_id: skuId, new_rate: rate };
    })
    .filter(Boolean);
};

const hydrateSkuRows = async (rows) => {
  if (!rows.length) return rows;
  const skuIds = [
    ...new Set(
      rows
        .map((row) => Number(row.sku_id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!skuIds.length) return rows;
  const skuRows = await knex("erp.skus as s")
    .leftJoin("erp.variants as v", "s.variant_id", "v.id")
    .leftJoin("erp.items as i", "v.item_id", "i.id")
    .select(
      "s.id as sku_id",
      "s.variant_id",
      "s.sku_code",
      "i.name as item_name",
    )
    .where(function whereSkuOrVariant() {
      this.whereIn("s.id", skuIds).orWhereIn("s.variant_id", skuIds);
    });
  const skuMap = new Map(skuRows.map((row) => [Number(row.sku_id), row]));
  const variantMap = new Map(
    skuRows
      .map((row) => [Number(row.variant_id), row])
      .filter(([variantId]) => Number.isInteger(variantId) && variantId > 0),
  );
  return rows.map((row) => {
    const lookupId = Number(row.sku_id);
    const hydrated = skuMap.get(lookupId) || variantMap.get(lookupId);
    return {
      ...row,
      sku_code: hydrated?.sku_code || row.sku_code || "",
      item_name: hydrated?.item_name || row.item_name || "",
    };
  });
};

const enrichCommissionRowsFromScope = async (values, t) => {
  const employeeId = Number(values?.employee_id || 0);
  const applyOn = String(values?.apply_on || "")
    .trim()
    .toUpperCase();
  if (!Number.isInteger(employeeId) || employeeId <= 0) return [];
  if (applyOn !== "SUBGROUP" && applyOn !== "GROUP") return [];
  return buildCommissionBulkPreviewRows({
    db: knex,
    employeeId,
    applyOn,
    subgroupId: values?.subgroup_id ? Number(values.subgroup_id) : null,
    groupId: values?.group_id ? Number(values.group_id) : null,
    baseRate: null,
    t,
  });
};

const enrichLabourRateRowsFromScope = async (values, t) => {
  const deptId = Number(values?.dept_id || 0);
  const applyOn = String(values?.apply_on || "")
    .trim()
    .toUpperCase();
  const articleType = String(values?.article_type || "")
    .trim()
    .toUpperCase();
  const rateType = String(values?.rate_type || "")
    .trim()
    .toUpperCase();
  const labourRaw = String(values?.labour_id || "").trim();
  if (!Number.isInteger(deptId) || deptId <= 0) return [];
  if (!labourRaw) return [];
  if (!rateType) return [];
  if (!articleType) return [];
  const labourSelection =
    labourRaw.toUpperCase() === ALL_LABOURS_VALUE
      ? { all: true, labourId: null, raw: ALL_LABOURS_VALUE }
      : { all: false, labourId: Number(labourRaw || 0), raw: labourRaw };
  const labourIds = await resolveLabourIds({
    db: knex,
    deptId,
    labourSelection,
    t,
  });
  return buildLabourRateBulkPreviewRows({
    db: knex,
    labourIds,
    deptId,
    applyOn,
    skuId: values?.sku_id ? Number(values.sku_id) : null,
    subgroupId: values?.subgroup_id ? Number(values.subgroup_id) : null,
    groupId: values?.group_id ? Number(values.group_id) : null,
    articleType,
    rateType,
    baseRate: null,
    t,
  });
};

const buildPreviewPayload = async (req, res, request, side) => {
  const action = inferAction(request);
  const values = getPreviewValues(request, side) || {};
  const entityType = request.entity_type;
  const locale = req.locale;

  const basePayload = {
    previewAction: action,
    previewLabel: res.locals.t(ACTION_LABELS[action] || action) || action,
    previewValues: values,
    locale,
  };

  const basicInfoKey = ENTITY_TO_BASIC_INFO[entityType];
  if (basicInfoKey) {
    if (basicInfoKey === "uom-conversions") {
      const uoms = await uomConversionsRoutes.preview.fetchUoms();
      return {
        ...basePayload,
        previewType: "basic-info-uom",
        previewTitle: res.locals.t("uom_conversions") || "UOM Conversions",
        formPartial:
          "../../master_data/basic-info/uom-conversions/form-fields.ejs",
        uoms,
      };
    }

    const page = basicInfoRoutes.preview.getPageConfig(basicInfoKey);
    if (!page) return null;
    const hydrated = await basicInfoRoutes.preview.hydratePage(page, locale);
    return {
      ...basePayload,
      previewType: "basic-info",
      previewTitle: res.locals.t(page.titleKey) || page.titleKey,
      formPartial: "../../master_data/basic-info/form-fields.ejs",
      page: hydrated,
      isAdmin: req.user?.isAdmin || false,
    };
  }

  const screen = ENTITY_TO_SCREEN[entityType];
  if (screen === "master_data.accounts") {
    const hydrated = await accountsRoutes.preview.hydratePage(
      accountsRoutes.preview.page,
      locale,
    );
    return {
      ...basePayload,
      previewType: "accounts",
      previewTitle: res.locals.t("accounts") || "Accounts",
      formPartial: "../../master_data/accounts/form-fields.ejs",
      page: hydrated,
      isAdmin: req.user?.isAdmin || false,
    };
  }

  if (screen === "master_data.parties") {
    const hydrated = await partiesRoutes.preview.hydratePage(
      partiesRoutes.preview.page,
      locale,
    );
    return {
      ...basePayload,
      previewType: "parties",
      previewTitle: res.locals.t("parties") || "Parties",
      formPartial: "../../master_data/parties/form-fields.ejs",
      page: hydrated,
      isAdmin: req.user?.isAdmin || false,
    };
  }

  if (screen === "master_data.returnable_assets") {
    const hydrated = await returnableAssetsRoutes.preview.hydratePage(
      returnableAssetsRoutes.preview.page,
      locale,
      req,
    );
    return {
      previewValues: values,
      previewType: "parties",
      previewTitle: res.locals.t("asset_master") || "Asset Master",
      page: hydrated,
      formPartial: "../../master_data/returnable-assets/form-fields.ejs",
    };
  }

  if (screen === "master_data.asset_types") {
    const hydrated = await assetTypesRoutes.preview.hydratePage(
      assetTypesRoutes.preview.page,
      locale,
      req,
    );
    return {
      previewValues: values,
      previewType: "parties",
      previewTitle: res.locals.t("asset_types") || "Asset Types",
      page: hydrated,
      formPartial: "../../master_data/asset-types/form-fields.ejs",
    };
  }

  const hrScopeKey = resolveHrScopeKey(request, values);
  const hrPreviewMap = {
    "hr_payroll.employees": hrEmployeesRoutes.preview?.page,
    "hr_payroll.labours": hrLaboursRoutes.preview?.page,
    "hr_payroll.commissions": hrCommissionsRoutes.preview?.page,
    "hr_payroll.allowances": hrAllowancesRoutes.preview?.page,
    "hr_payroll.labour_rates": hrLaboursRoutes.preview?.labourRatesPage,
  };
  const hrPage = hrPreviewMap[hrScopeKey] || null;
  if (hrPage && typeof hrEmployeesRoutes.preview?.hydratePage === "function") {
    const hydrateHrPage = hrEmployeesRoutes.preview.hydratePage;
    const hydrated = await hydrateHrPage(hrPage, locale, req);
    const previewValues =
      values && typeof values === "object" ? { ...values } : {};
    if (previewValues && Array.isArray(previewValues.rows)) {
      const normalizedRows = normalizeRowsForLookup(previewValues.rows);
      let mergedRows = normalizedRows;
      try {
        if (hrScopeKey === "hr_payroll.commissions") {
          const scopedRows = await enrichCommissionRowsFromScope(
            previewValues,
            res.locals.t,
          );
          if (Array.isArray(scopedRows) && scopedRows.length) {
            const scopedBySku = new Map(
              scopedRows.map((row) => [Number(row.sku_id || 0), row]),
            );
            mergedRows = normalizedRows.map((row) => {
              const scoped = scopedBySku.get(Number(row.sku_id));
              return scoped
                ? {
                    ...scoped,
                    new_rate: row.new_rate ?? scoped.new_rate ?? null,
                  }
                : row;
            });
          }
        }
        if (hrScopeKey === "hr_payroll.labour_rates") {
          const scopedRows = await enrichLabourRateRowsFromScope(
            previewValues,
            res.locals.t,
          );
          if (Array.isArray(scopedRows) && scopedRows.length) {
            const scopedBySku = new Map(
              scopedRows.map((row) => [Number(row.sku_id || 0), row]),
            );
            mergedRows = normalizedRows.map((row) => {
              const scoped = scopedBySku.get(Number(row.sku_id));
              return scoped
                ? {
                    ...scoped,
                    new_rate: row.new_rate ?? scoped.new_rate ?? null,
                  }
                : row;
            });
          }
        }
      } catch (err) {
        console.error("Error in ApprovalPreviewRowsHydration:", err);
      }
      previewValues.rows = await hydrateSkuRows(mergedRows);
    }
    return {
      ...basePayload,
      previewValues,
      previewType: "hr-payroll",
      previewTitle: res.locals.t(hydrated.titleKey) || hydrated.titleKey,
      formPartial: "../../hr_payroll/form-fields.ejs",
      page: hydrated,
      isAdmin: req.user?.isAdmin || false,
    };
  }

  if (entityType === "ITEM") {
    const itemType = (
      values.item_type ||
      request?.old_value?.item_type ||
      request?.new_value?.item_type ||
      ""
    ).toUpperCase();
    if (itemType === rawMaterialsRoutes.preview.ITEM_TYPE) {
      const options = await rawMaterialsRoutes.preview.loadOptions();
      return {
        ...basePayload,
        previewType: "raw-materials",
        previewTitle: res.locals.t("raw_materials") || "Raw Materials",
        formPartial: "../../master_data/products/raw-materials/form-fields.ejs",
        ...options,
      };
    }
    if (itemType === semiFinishedRoutes.preview.ITEM_TYPE) {
      const options = await semiFinishedRoutes.preview.loadOptions();
      return {
        ...basePayload,
        previewType: "semi-finished",
        previewTitle: res.locals.t("semi_finished") || "Semi Finished",
        formPartial: "../../master_data/products/semi-finished/form-fields.ejs",
        ...options,
      };
    }
    if (itemType === finishedRoutes.preview.ITEM_TYPE) {
      const options = await finishedRoutes.preview.loadOptions();
      return {
        ...basePayload,
        previewType: "finished",
        previewTitle: res.locals.t("finished") || "Finished",
        formPartial: "../../master_data/products/finished/form-fields.ejs",
        ...options,
      };
    }
  }

  if (entityType === "SKU") {
    let itemType = "FG";
    let lookupValues = values;
    const entityId = request.entity_id;
    if (entityId && entityId !== "NEW") {
      const variant = await knex("erp.variants as v")
        .select(
          "v.item_id",
          "v.size_id",
          "v.grade_id",
          "v.color_id",
          "v.packing_type_id",
          "v.sale_rate",
          "i.item_type",
        )
        .leftJoin("erp.items as i", "v.item_id", "i.id")
        .where("v.id", Number(entityId))
        .first();
      if (variant) {
        itemType = variant.item_type === "SFG" ? "SFG" : "FG";
        lookupValues = {
          ...values,
          item_id: values.item_id || variant.item_id,
          size_id: values.size_id || variant.size_id,
          grade_id: values.grade_id || variant.grade_id,
          color_id: values.color_id || variant.color_id,
          packing_type_id: values.packing_type_id || variant.packing_type_id,
          sale_rate: values.sale_rate || variant.sale_rate,
        };
      }
    } else if (values.item_type) {
      itemType = values.item_type === "SFG" ? "SFG" : "FG";
    }

    const options = await skuRoutes.preview.loadOptions(itemType);
    const normalized = {
      ...lookupValues,
      size_ids: normalizeArray(lookupValues.size_ids || lookupValues.size_id),
      grade_ids: normalizeArray(
        lookupValues.grade_ids || lookupValues.grade_id,
      ),
      color_ids: normalizeArray(
        lookupValues.color_ids || lookupValues.color_id,
      ),
      packing_type_ids: normalizeArray(
        lookupValues.packing_type_ids || lookupValues.packing_type_id,
      ),
    };

    return {
      ...basePayload,
      previewValues: normalized,
      previewType: "skus",
      previewTitle: res.locals.t("skus") || "SKUs",
      formPartial: "../../administration/approvals/preview-sku-compact.ejs",
      ...options,
    };
  }

  return null;
};

// GET / - Dashboard
router.get(
  "/",
  requirePermission("SCREEN", "administration.approvals", "navigate"),
  async (req, res, next) => {
    try {
      const status = (req.query.status || "PENDING").toUpperCase();

      const rowsQuery = knex("erp.approval_request as ar")
        .select("ar.*", "u.username as requester_name", "v.id as variant_id")
        .leftJoin("erp.users as u", "ar.requested_by", "u.id")
        // Left join variant to get SKU context if entity_type is SKU
        .leftJoin("erp.variants as v", function () {
          this.on("ar.entity_id", "=", knex.raw("CAST(v.id AS TEXT)")).andOn(
            "ar.entity_type",
            "=",
            knex.raw("'SKU'"),
          );
        })
        .where("ar.status", status)
        .orderBy("ar.requested_at", "desc");

      if (!req.user?.isAdmin) {
        rowsQuery.andWhere("ar.requested_by", req.user.id);
      }

      const rows = await rowsQuery;

      for (const row of rows) {
        row.summary = normalizeVoucherApprovalSummary(row, res.locals.t);
      }

      const skuRows = rows.filter((row) => row.entity_type === "SKU");
      if (skuRows.length) {
        const newValueRows = skuRows
          .map((row) => ({ row, values: safeJson(row.new_value) }))
          .filter((entry) => entry.values);

        const itemIds = new Set();
        const sizeIds = new Set();
        const gradeIds = new Set();
        const colorIds = new Set();
        const packingIds = new Set();

        newValueRows.forEach(({ values }) => {
          if (values.item_id) itemIds.add(Number(values.item_id));
          if (values.size_id) sizeIds.add(Number(values.size_id));
          if (values.grade_id) gradeIds.add(Number(values.grade_id));
          if (values.color_id) colorIds.add(Number(values.color_id));
          if (values.packing_type_id)
            packingIds.add(Number(values.packing_type_id));
        });

        const variantIds = skuRows
          .map((row) => Number(row.entity_id))
          .filter((id) => Number.isFinite(id) && id > 0);

        const [items, sizes, grades, colors, packings, variants] =
          await Promise.all([
            itemIds.size
              ? knex("erp.items")
                  .select("id", "name", "code")
                  .whereIn("id", [...itemIds])
              : Promise.resolve([]),
            sizeIds.size
              ? knex("erp.sizes")
                  .select("id", "name")
                  .whereIn("id", [...sizeIds])
              : Promise.resolve([]),
            gradeIds.size
              ? knex("erp.grades")
                  .select("id", "name")
                  .whereIn("id", [...gradeIds])
              : Promise.resolve([]),
            colorIds.size
              ? knex("erp.colors")
                  .select("id", "name")
                  .whereIn("id", [...colorIds])
              : Promise.resolve([]),
            packingIds.size
              ? knex("erp.packing_types")
                  .select("id", "name")
                  .whereIn("id", [...packingIds])
              : Promise.resolve([]),
            variantIds.length
              ? knex("erp.variants as v")
                  .select(
                    "v.id",
                    "i.name as item_name",
                    "s.name as size_name",
                    "g.name as grade_name",
                    "c.name as color_name",
                    "p.name as packing_name",
                    "k.sku_code",
                  )
                  .leftJoin("erp.items as i", "v.item_id", "i.id")
                  .leftJoin("erp.sizes as s", "v.size_id", "s.id")
                  .leftJoin("erp.grades as g", "v.grade_id", "g.id")
                  .leftJoin("erp.colors as c", "v.color_id", "c.id")
                  .leftJoin(
                    "erp.packing_types as p",
                    "v.packing_type_id",
                    "p.id",
                  )
                  .leftJoin("erp.skus as k", "k.variant_id", "v.id")
                  .whereIn("v.id", variantIds)
              : Promise.resolve([]),
          ]);

        const itemMap = new Map(items.map((row) => [row.id, row.name]));
        const sizeMap = new Map(sizes.map((row) => [row.id, row.name]));
        const gradeMap = new Map(grades.map((row) => [row.id, row.name]));
        const colorMap = new Map(colors.map((row) => [row.id, row.name]));
        const packingMap = new Map(packings.map((row) => [row.id, row.name]));
        const variantMap = new Map(
          variants.map((row) => [
            row.id,
            buildSkuLabel({
              skuCode: row.sku_code,
              itemName: row.item_name,
              sizeName: row.size_name,
              packingName: row.packing_name,
              gradeName: row.grade_name,
              colorName: row.color_name,
            }),
          ]),
        );

        for (const row of skuRows) {
          const values = safeJson(row.new_value);
          const isNew = row.entity_id === "NEW";
          let label = null;
          if (values && values._summary) {
            label = String(values._summary);
          } else if (isNew && values) {
            label = buildSkuLabel({
              itemName: itemMap.get(Number(values.item_id)),
              sizeName: sizeMap.get(Number(values.size_id)),
              packingName: packingMap.get(Number(values.packing_type_id)),
              gradeName: gradeMap.get(Number(values.grade_id)),
              colorName: values.color_id
                ? colorMap.get(Number(values.color_id))
                : null,
            });
          } else if (!isNew) {
            label = variantMap.get(Number(row.entity_id)) || null;
            if (!label && Number.isFinite(Number(row.entity_id))) {
              const fallback = await knex("erp.variants as v")
                .select(
                  "v.id",
                  "i.name as item_name",
                  "s.name as size_name",
                  "g.name as grade_name",
                  "c.name as color_name",
                  "p.name as packing_name",
                  "k.sku_code",
                )
                .leftJoin("erp.items as i", "v.item_id", "i.id")
                .leftJoin("erp.sizes as s", "v.size_id", "s.id")
                .leftJoin("erp.grades as g", "v.grade_id", "g.id")
                .leftJoin("erp.colors as c", "v.color_id", "c.id")
                .leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id")
                .leftJoin("erp.skus as k", "k.variant_id", "v.id")
                .where("v.id", Number(row.entity_id))
                .first();
              if (fallback) {
                label = buildSkuLabel({
                  skuCode: fallback.sku_code,
                  itemName: fallback.item_name,
                  sizeName: fallback.size_name,
                  packingName: fallback.packing_name,
                  gradeName: fallback.grade_name,
                  colorName: fallback.color_name,
                });
              }
            }
          }

          if (label && row.summary) {
            if (row.summary.startsWith("New Variant:")) {
              row.summary = `New Variant: ${label}`;
            } else if (!row.summary.includes(label)) {
              row.summary = `${row.summary}: ${label}`;
            }
          }
        }
      }

      renderPage(
        req,
        res,
        "../../administration/approvals/index",
        res.locals.t("approvals"),
        {
          rows,
          currentStatus: status,
          basePath: req.baseUrl,
        },
      );
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/:id/preview",
  requirePermission("SCREEN", "administration.approvals", "navigate"),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return next(new HttpError(400, res.locals.t("error_invalid_id")));
    const side = req.query.side === "old" ? "old" : "new";

    try {
      const request = await knex("erp.approval_request").where({ id }).first();
      if (!request)
        return next(
          new HttpError(404, res.locals.t("approval_request_not_found")),
        );
      if (process.env.DEBUG_APPROVAL_PREVIEW === "1") {
        console.log("[APPROVAL PREVIEW DEBUG] request", {
          id: request.id,
          side,
          entityType: request.entity_type,
          entityId: request.entity_id,
          oldType: typeof request.old_value,
          newType: typeof request.new_value,
        });
      }

      // First try globally-registered preview providers.
      const payload =
        (await resolveApprovalPreview({ req, res, request, side })) ||
        (await buildPreviewPayload(req, res, request, side));
      if (process.env.DEBUG_APPROVAL_PREVIEW === "1") {
        console.log("[APPROVAL PREVIEW DEBUG] payload", {
          id: request.id,
          side,
          hasPayload: Boolean(payload),
          previewType: payload?.previewType || null,
          formPartial: payload?.formPartial || null,
          previewValuesType: typeof payload?.previewValues,
          previewValueKeys:
            payload?.previewValues && typeof payload.previewValues === "object"
              ? Object.keys(payload.previewValues)
              : null,
        });
      }
      if (!payload) {
        return res.status(204).send("");
      }

      return res.render("administration/approvals/preview", {
        t: res.locals.t,
        locale: req.locale,
        fieldErrors: {},
        formValues: {},
        ...payload,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/:id/edit",
  requirePermission("SCREEN", "administration.approvals", "approve"),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return next(new HttpError(400, res.locals.t("error_invalid_id")));
    if (!req.user?.isAdmin)
      return next(new HttpError(403, res.locals.t("permission_denied")));

    try {
      const submitted = parseEditedPayload(req.body?.edited_payload);
      if (
        !submitted ||
        typeof submitted !== "object" ||
        Array.isArray(submitted)
      ) {
        return res.status(400).json({
          ok: false,
          message: res.locals.t("approval_edit_invalid_payload"),
        });
      }

      let changedFields = [];
      let requestSnapshot = null;
      await knex.transaction(async (trx) => {
        const request = await trx("erp.approval_request").where({ id }).first();
        if (!request || request.status !== "PENDING") {
          throw new HttpError(404, res.locals.t("approval_request_not_found"));
        }
        requestSnapshot = request;

        const sanitized = sanitizeEditedValues(request, submitted);
        if (sanitized.error) {
          throw new HttpError(400, res.locals.t(sanitized.error));
        }
        if (!sanitized.changedFields.length) {
          throw new HttpError(400, res.locals.t("approval_no_changes"));
        }

        changedFields = sanitized.changedFields;
        await trx("erp.approval_request").where({ id }).update({
          new_value: sanitized.nextValue,
          decided_by: null,
          decided_at: null,
          decision_notes: null,
        });

        await insertActivityLog(trx, {
          branch_id: request.branch_id,
          user_id: req.user.id,
          entity_type: request.entity_type,
          entity_id: request.entity_id,
          action: "UPDATE",
          ip_address: req.ip,
          context: {
            source: "approval-request-edit",
            approval_request_id: request.id,
            request_status: request.status,
            request_action: inferAction(request),
            editable_keys: getEditableKeys(request),
            changed_fields: changedFields,
            old_value: request.new_value || null,
            new_value: sanitized.nextValue || null,
          },
        });
      });

      if (process.env.DEBUG_APPROVAL_PREVIEW === "1") {
        console.log("[APPROVAL EDIT DEBUG] approval request updated", {
          id,
          editorUserId: req.user.id,
          changedCount: changedFields.length,
          changedFields: changedFields.map((entry) => entry.field),
        });
      }

      if (requestSnapshot?.requested_by) {
        notifyApprovalDecision({
          userId: requestSnapshot.requested_by,
          payload: {
            status: "PENDING",
            requestId: requestSnapshot.id,
            summary: requestSnapshot.summary || "",
            link: "/administration/approvals?status=PENDING",
            message: (
              res.locals.t("approval_request_updated_detail") ||
              "Your pending approval request was updated: {summary}"
            ).replace("{summary}", requestSnapshot.summary || ""),
            sticky: true,
          },
        });
      }

      return res.json({
        ok: true,
        message: res.locals.t("approval_request_updated"),
        changed_fields: changedFields,
      });
    } catch (err) {
      console.error("[approvals:edit]", {
        id,
        userId: req.user?.id,
        error: err?.message || err,
      });
      if (err instanceof HttpError) {
        return res.status(err.status).json({ ok: false, message: err.message });
      }
      return next(err);
    }
  },
);

// GET /settings - Approval policy settings (voucher types + screens)
router.get(
  "/settings",
  requirePermission("SCREEN", "administration.approval_settings", "navigate"),
  async (req, res, next) => {
    try {
      const [voucherTypes, policyRows] = await Promise.all([
        knex("erp.voucher_type").select("code", "name").orderBy("name"),
        knex("erp.approval_policy").select(
          "entity_type",
          "entity_key",
          "action",
          "requires_approval",
        ),
      ]);

      const excludedScreens = new Set([
        "administration.audit_logs",
        "administration.approvals",
        "administration.approval_settings",
        "administration.permissions",
        "administration.branches",
      ]);

      const shouldIncludeScreen = (scopeKey, route) => {
        if (!scopeKey) return false;
        if (scopeKey.startsWith("administration.")) return false;
        if (excludedScreens.has(scopeKey)) return false;
        if (scopeKey.includes(".approval") || scopeKey.includes(".versions"))
          return false;
        if (route && route.startsWith("/reports")) return false;
        if (scopeKey.includes("report")) return false;
        if (!route) return false;
        // Data-entry screens eligible for approval policy live under master-data and hr-payroll.
        if (
          !route.startsWith("/master-data") &&
          !route.startsWith("/hr-payroll")
        )
          return false;
        return true;
      };

      const policyMap = policyRows.reduce((acc, row) => {
        if (!acc[row.entity_type]) acc[row.entity_type] = {};
        if (!acc[row.entity_type][row.entity_key])
          acc[row.entity_type][row.entity_key] = {};
        acc[row.entity_type][row.entity_key][row.action] =
          row.requires_approval;
        return acc;
      }, {});

      const voucherTypeMap = new Map(
        voucherTypes.map((vt) => [vt.code, vt.name]),
      );

      const buildScreenRows = (nodes, parentPath = "", depth = 0) => {
        let rows = [];
        nodes.forEach((node) => {
          const path = parentPath ? `${parentPath}.${node.key}` : node.key;
          const hasChildren =
            Array.isArray(node.children) && node.children.length > 0;
          const childRows = hasChildren
            ? buildScreenRows(node.children, path, depth + 1)
            : [];
          const isScreen =
            node.scopeType === "SCREEN" &&
            node.route &&
            shouldIncludeScreen(node.scopeKey, node.route);
          const isVoucher = node.scopeType === "VOUCHER";
          const includeGroup = childRows.length > 0;

          if (isScreen || isVoucher || includeGroup) {
            rows.push({
              key: node.key,
              path,
              parentPath: parentPath || null,
              depth,
              hasChildren: childRows.length > 0,
              scopeKey: isScreen || isVoucher ? node.scopeKey : null,
              scopeType: isVoucher ? "VOUCHER" : "SCREEN",
              labelKey: node.labelKey,
              description: node.labelKey,
              voucherName: isVoucher
                ? voucherTypeMap.get(node.scopeKey) || null
                : null,
            });
            rows = rows.concat(childRows);
          }
        });
        return rows;
      };

      let screenRows = buildScreenRows(navConfig);

      renderPage(
        req,
        res,
        "../../administration/approvals/settings",
        res.locals.t("approval_settings"),
        {
          screenRows,
          policyMap,
        },
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /settings - Save approval policy settings
router.post(
  "/settings",
  requirePermission("SCREEN", "administration.approval_settings", "edit"),
  async (req, res, next) => {
    const trx = await knex.transaction();
    try {
      const { ...fields } = req.body;

      await trx("erp.approval_policy")
        .whereIn("entity_type", ["VOUCHER_TYPE", "SCREEN"])
        .del();

      const insertRows = [];
      Object.keys(fields).forEach((key) => {
        if (!key.includes(":")) return;
        const [entityType, entityKey, action] = key.split(":");
        if (!entityType || !entityKey || !action) return;
        insertRows.push({
          entity_type: entityType,
          entity_key: entityKey,
          action,
          requires_approval: true,
          updated_by: req.user?.id || null,
        });
      });

      if (insertRows.length) {
        await trx("erp.approval_policy").insert(insertRows);
      }

      await trx.commit();
      res.redirect(`${req.baseUrl}/settings?success=1`);
    } catch (err) {
      await trx.rollback();
      next(err);
    }
  },
);

// POST /:id/approve
router.post(
  "/:id/approve",
  requirePermission("SCREEN", "administration.approvals", "approve"),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return next(new HttpError(400, res.locals.t("error_invalid_id")));
    if (!req.user?.isAdmin)
      return next(new HttpError(403, res.locals.t("permission_denied")));

    try {
      let requestSnapshot = null;
      let appliedEntityId = null;
      await knex.transaction(async (trx) => {
        const request = await trx("erp.approval_request").where({ id }).first();
        if (!request || request.status !== "PENDING") {
          throw new Error(res.locals.t("approval_request_not_found"));
        }
        requestSnapshot = request;

        if (request.request_type === "MASTER_DATA_CHANGE") {
          const applyResult = await applyMasterDataChange(
            trx,
            request,
            req.user.id,
          );
          const applied =
            typeof applyResult === "object"
              ? applyResult.applied !== false
              : Boolean(applyResult);
          appliedEntityId =
            typeof applyResult === "object" && applyResult.entityId
              ? String(applyResult.entityId)
              : null;
          console.log("[DEBUG][Approval] applyMasterDataChange result:", {
            requestId: request.id,
            entityType: request.entity_type,
            entityId: request.entity_id,
            summary: request.summary || null,
            newValueKeys:
              request.new_value && typeof request.new_value === "object"
                ? Object.keys(request.new_value)
                : [],
            applyResult,
          });
          if (!applied) {
            const err = new Error(res.locals.t("approval_apply_failed"));
            err.code = "APPROVAL_APPLY_FAILED";
            throw err;
          }
        } else if (
          request.request_type === "VOUCHER" &&
          request.entity_type === "VOUCHER"
        ) {
          const voucherApplyResult = await applyVoucherApprovalChangeTx({
            trx,
            request,
            approverId: req.user.id,
            req,
          });
          appliedEntityId =
            voucherApplyResult?.appliedEntityId || appliedEntityId;
        }
        await trx("erp.approval_request").where({ id }).update({
          status: "APPROVED",
          decided_by: req.user.id,
          decided_at: trx.fn.now(),
          decision_notes: null,
        });

        await insertActivityLog(trx, {
          branch_id: request.branch_id,
          user_id: req.user.id,
          entity_type: request.entity_type,
          entity_id:
            request.entity_id === "NEW" && appliedEntityId
              ? appliedEntityId
              : request.entity_id,
          voucher_type_code:
            resolveApprovalRequestVoucherTypeCode(request) || null,
          action: "APPROVE",
          ip_address: req.ip,
          context: {
            source: "approval-decision",
            approval_request_id: request.id,
            requested_entity_id: request.entity_id,
            applied_entity_id: appliedEntityId,
            decision: "APPROVED",
            request_type: request.request_type,
            summary: request.summary || null,
            old_value: request.old_value || null,
            new_value: request.new_value || null,
          },
        });
      });

      if (requestSnapshot?.requested_by) {
        notifyApprovalDecision({
          userId: requestSnapshot.requested_by,
          payload: {
            status: "APPROVED",
            requestId: requestSnapshot.id,
            summary: requestSnapshot.summary || "",
            link: "/administration/approvals?status=APPROVED",
            message: (
              res.locals.t("approval_approved_detail") ||
              "Your approval request was approved: {summary}"
            ).replace("{summary}", requestSnapshot.summary || ""),
            sticky: true,
          },
        });
      }
      setUiNotice(res, res.locals.t("approval_approved"), { autoClose: true });
      return res.redirect(`${req.baseUrl}?status=PENDING`);
    } catch (err) {
      console.error("[ERROR][Approval] Error in applyMasterDataChange:", err);
      let msg = res.locals.t("approval_apply_failed");
      if (err && err.code === "DUPLICATE_NAME") {
        msg = res.locals.t("error_duplicate_name");
      } else if (err && err.code === "BOM_SNAPSHOT_MISMATCH") {
        msg =
          res.locals.t("bom_error_snapshot_mismatch") ||
          "BOM snapshot mismatch while approving. Please reopen and resubmit approval.";
      } else if (err && err.message) {
        msg = err.message;
      }
      setUiNotice(res, msg, { autoClose: true });
      return res.redirect(`${req.baseUrl}?status=PENDING`);
    }
  },
);

// POST /:id/reject
router.post(
  "/:id/reject",
  requirePermission("SCREEN", "administration.approvals", "approve"),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!req.user?.isAdmin)
      return next(new HttpError(403, res.locals.t("permission_denied")));

    try {
      let requestSnapshot = null;
      await knex.transaction(async (trx) => {
        const request = await trx("erp.approval_request").where({ id }).first();
        if (!request || request.status !== "PENDING") {
          throw new Error(res.locals.t("approval_request_not_found"));
        }
        requestSnapshot = request;

        if (request.entity_type === "BOM") {
          await bomService.resetPendingBomAfterRejectTx(trx, request);
        }

        if (
          request.request_type === "VOUCHER" &&
          request.entity_type === "VOUCHER"
        ) {
          const payload =
            request?.new_value && typeof request.new_value === "object"
              ? request.new_value
              : {};
          const action = String(payload.action || "").toLowerCase();
          const voucherId = Number(request.entity_id || 0);
          if (!voucherId) {
            throw new Error(res.locals.t("error_invalid_id"));
          }
          if (!action) {
            await trx("erp.voucher_header")
              .where({ id: voucherId, status: "PENDING" })
              .update({
                status: "REJECTED",
                approved_by: req.user.id,
                approved_at: trx.fn.now(),
              });
          }
        }

        await trx("erp.approval_request").where({ id }).update({
          status: "REJECTED",
          decided_by: req.user.id,
          decided_at: trx.fn.now(),
        });

        await insertActivityLog(trx, {
          branch_id: request.branch_id,
          user_id: req.user.id,
          entity_type: request.entity_type,
          entity_id: request.entity_id,
          voucher_type_code:
            resolveApprovalRequestVoucherTypeCode(request) || null,
          action: "REJECT",
          ip_address: req.ip,
          context: {
            source: "approval-decision",
            approval_request_id: request.id,
            requested_entity_id: request.entity_id,
            decision: "REJECTED",
            request_type: request.request_type,
            summary: request.summary || null,
            old_value: request.old_value || null,
            new_value: request.new_value || null,
          },
        });
      });
      if (requestSnapshot?.requested_by) {
        notifyApprovalDecision({
          userId: requestSnapshot.requested_by,
          payload: {
            status: "REJECTED",
            requestId: requestSnapshot.id,
            summary: requestSnapshot.summary || "",
            link: "/administration/approvals?status=REJECTED",
            message: (
              res.locals.t("approval_rejected_detail") ||
              "Your approval request was rejected: {summary}"
            ).replace("{summary}", requestSnapshot.summary || ""),
            sticky: true,
          },
        });
      }
      setUiNotice(res, res.locals.t("approval_rejected"), { autoClose: true });
      res.redirect(`${req.baseUrl}?status=PENDING`);
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
