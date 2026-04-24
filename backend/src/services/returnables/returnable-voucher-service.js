const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog, queueAuditLog } = require("../../utils/audit-log");
const {
  resolveVoucherApprovalRequiredTx,
} = require("../../utils/voucher-approval-policy");

const RETURNABLE_VOUCHER_TYPES = {
  dispatch: "RDV",
  receipt: "RRV",
};

let approvalRequestHasVoucherTypeCodeColumn;
let returnablePlaceholderItemId;
let partiesHasNameUrColumn;
let assetsHasNameColumn;
let assetsHasNameUrColumn;
let assetTypeRegistryHasNameUrColumn;

const toPositiveInt = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeText = (value, max = 1000) => {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
};

const toDateOnly = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const dt = new Date(text);
  if (Number.isNaN(dt.getTime())) return null;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const toQty = (value) => {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Number(parsed.toFixed(3));
};

const normalizeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();
const DEFAULT_RETURNABLE_REASONS = [
  { code: "REPAIR", name: "Repair", description: "Sent for repair" },
  { code: "CALIBRATION", name: "Calibration", description: "Calibration" },
  { code: "SHARPENING", name: "Sharpening", description: "Sharpening" },
  {
    code: "REFURBISH",
    name: "Refurbishment / Overhaul",
    description: "Refurbishment / Overhaul",
  },
  {
    code: "COATING_TREATMENT",
    name: "Coating / Surface Treatment",
    description: "Coating / Surface Treatment",
  },
  { code: "MODIFICATION", name: "Modification", description: "Modification" },
  { code: "OTHERS", name: "Others", description: "Others" },
];
const DEFAULT_RETURNABLE_CONDITIONS = [
  { code: "NEW", name: "Unused", description: "Unused" },
  { code: "GOOD_WORKING", name: "Fully Working", description: "Fully Working" },
  {
    code: "WORKING_MINOR_WEAR",
    name: "Working, Minor Wear",
    description: "Working, Minor Wear",
  },
  { code: "DAMAGED", name: "Damaged", description: "Damaged condition" },
  {
    code: "NON_FUNCTIONAL",
    name: "Non-Functional",
    description: "Non-Functional",
  },
  { code: "INCOMPLETE", name: "Missing Parts", description: "Missing Parts" },
  { code: "RUSTED_CORRODED", name: "Rusted", description: "Rusted" },
];
const RETURNABLE_REASON_DISPLAY_ORDER = [
  "REPAIR",
  "CALIBRATION",
  "SHARPENING",
  "REFURBISH",
  "COATING_TREATMENT",
  "MODIFICATION",
  "OTHERS",
];
const RETURNABLE_CONDITION_DISPLAY_ORDER = [
  "NEW",
  "GOOD_WORKING",
  "WORKING_MINOR_WEAR",
  "DAMAGED",
  "NON_FUNCTIONAL",
  "INCOMPLETE",
  "RUSTED_CORRODED",
];

const canDo = (req, scopeType, scopeKey, action) => {
  const check = req?.res?.locals?.can;
  if (typeof check !== "function") return false;
  return check(scopeType, scopeKey, action);
};

const canApproveVoucherAction = (req, scopeKey) =>
  req?.user?.isAdmin === true || canDo(req, "VOUCHER", scopeKey, "approve");

const parseVoucherNo = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const ensureReturnableRegistryDefaultsTx = async (trx) => {
  try {
    await trx("erp.rgp_reason_registry")
      .insert(
        DEFAULT_RETURNABLE_REASONS.map((row) => ({ ...row, is_active: true })),
      )
      .onConflict("code")
      .merge(["name", "description", "is_active"]);
    await trx("erp.rgp_condition_registry")
      .insert(
        DEFAULT_RETURNABLE_CONDITIONS.map((row) => ({
          ...row,
          is_active: true,
        })),
      )
      .onConflict("code")
      .merge(["name", "description", "is_active"]);
  } catch (err) {
    console.error("Error in ReturnableRegistryDefaultsService:", err);
  }
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
    approvalRequestHasVoucherTypeCodeColumn = false;
    return false;
  }
};

const hasPartiesNameUrColumnTx = async (trx) => {
  if (typeof partiesHasNameUrColumn === "boolean") {
    return partiesHasNameUrColumn;
  }
  try {
    partiesHasNameUrColumn = await trx.schema
      .withSchema("erp")
      .hasColumn("parties", "name_ur");
    return partiesHasNameUrColumn;
  } catch (err) {
    partiesHasNameUrColumn = false;
    return false;
  }
};

const hasAssetsNameColumnTx = async (trx) => {
  if (typeof assetsHasNameColumn === "boolean") {
    return assetsHasNameColumn;
  }
  try {
    assetsHasNameColumn = await trx.schema
      .withSchema("erp")
      .hasColumn("assets", "name");
    return assetsHasNameColumn;
  } catch (err) {
    assetsHasNameColumn = false;
    return false;
  }
};

const hasAssetsNameUrColumnTx = async (trx) => {
  if (typeof assetsHasNameUrColumn === "boolean") {
    return assetsHasNameUrColumn;
  }
  try {
    assetsHasNameUrColumn = await trx.schema
      .withSchema("erp")
      .hasColumn("assets", "name_ur");
    return assetsHasNameUrColumn;
  } catch (err) {
    assetsHasNameUrColumn = false;
    return false;
  }
};

const hasAssetTypeRegistryNameUrColumnTx = async (trx) => {
  if (typeof assetTypeRegistryHasNameUrColumn === "boolean") {
    return assetTypeRegistryHasNameUrColumn;
  }
  try {
    assetTypeRegistryHasNameUrColumn = await trx.schema
      .withSchema("erp")
      .hasColumn("asset_type_registry", "name_ur");
    return assetTypeRegistryHasNameUrColumn;
  } catch (err) {
    assetTypeRegistryHasNameUrColumn = false;
    return false;
  }
};

const requiresApprovalForAction = async (trx, voucherTypeCode, action) => {
  return resolveVoucherApprovalRequiredTx({
    trx,
    voucherTypeCode,
    action,
  });
};

const getNextVoucherNoTx = async (trx, branchId, voucherTypeCode) => {
  const latest = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .max({ value: "voucher_no" })
    .first();
  return Number(latest?.value || 0) + 1;
};

const createApprovalRequestTx = async ({
  trx,
  req,
  entityId,
  voucherTypeCode,
  summary,
  oldValue = null,
  newValue = null,
}) => {
  const payload = {
    branch_id: req.branchId,
    request_type: "VOUCHER",
    entity_type: "VOUCHER",
    entity_id: String(entityId),
    summary,
    old_value: oldValue,
    new_value: newValue,
    requested_by: req.user.id,
  };
  if (await hasApprovalRequestVoucherTypeCodeColumnTx(trx)) {
    payload.voucher_type_code = voucherTypeCode;
  }

  let row;
  try {
    [row] = await trx("erp.approval_request").insert(payload).returning(["id"]);
  } catch (err) {
    const missingOptionalColumn =
      String(err?.code || "").trim() === "42703" &&
      String(err?.message || "")
        .toLowerCase()
        .includes("voucher_type_code");
    if (!missingOptionalColumn) throw err;
    approvalRequestHasVoucherTypeCodeColumn = false;
    delete payload.voucher_type_code;
    [row] = await trx("erp.approval_request").insert(payload).returning(["id"]);
  }

  await insertActivityLog(trx, {
    branch_id: req.branchId,
    user_id: req.user.id,
    entity_type: "VOUCHER",
    entity_id: String(entityId),
    voucher_type_code: voucherTypeCode,
    action: "SUBMIT",
    ip_address: req.ip,
    context: {
      approval_request_id: row?.id || null,
      summary,
      source: "returnable-voucher-service",
      new_value: newValue,
    },
  });

  return row?.id || null;
};

const ensureAssetIdsExistTx = async (trx, assetIds = [], branchId = null) => {
  const uniqueAssetIds = [
    ...new Set(assetIds.map((id) => toPositiveInt(id)).filter(Boolean)),
  ];
  if (!uniqueAssetIds.length) return new Map();

  const rows = await trx("erp.assets")
    .select(
      "id",
      "asset_code",
      "description",
      "asset_type_code",
      "home_branch_id",
    )
    .whereIn("id", uniqueAssetIds)
    .where({ is_active: true })
    .andWhere((builder) => {
      builder.whereNull("home_branch_id");
      if (branchId) builder.orWhere("home_branch_id", branchId);
    });
  const map = new Map(rows.map((row) => [Number(row.id), row]));
  if (map.size !== uniqueAssetIds.length) {
    throw new HttpError(400, "One or more selected assets are invalid");
  }
  return map;
};

const getSystemReturnableItemIdTx = async (trx, userId = null) => {
  if (
    Number.isInteger(returnablePlaceholderItemId) &&
    returnablePlaceholderItemId > 0
  ) {
    return returnablePlaceholderItemId;
  }

  const existing = await trx("erp.items")
    .select("id")
    .where({ code: "RETURNABLE_ASSET_ITEM" })
    .first();
  if (existing?.id) {
    returnablePlaceholderItemId = Number(existing.id);
    return returnablePlaceholderItemId;
  }

  const resolvePlaceholderItemDefaultsTx = async () => {
    const rmSeed = await trx("erp.items")
      .select("group_id", "subgroup_id", "product_type_id", "base_uom_id")
      .where({ item_type: "RM" })
      .whereNotNull("group_id")
      .whereNotNull("base_uom_id")
      .orderByRaw("CASE WHEN is_active THEN 0 ELSE 1 END")
      .orderBy("id", "asc")
      .first();

    let groupId = toPositiveInt(rmSeed?.group_id);
    let subgroupId = toPositiveInt(rmSeed?.subgroup_id);
    const productTypeId = toPositiveInt(rmSeed?.product_type_id);
    let baseUomId = toPositiveInt(rmSeed?.base_uom_id);

    if (!groupId) {
      const groupRow = await trx("erp.product_groups")
        .select("id")
        .where({ is_active: true })
        .orderBy("id", "asc")
        .first();
      groupId = toPositiveInt(groupRow?.id);
      subgroupId = null;
    }

    if (groupId && !subgroupId) {
      const subgroupRow = await trx("erp.product_subgroups")
        .select("id")
        .where({ group_id: groupId, is_active: true })
        .orderBy("id", "asc")
        .first();
      subgroupId = toPositiveInt(subgroupRow?.id);
    }

    if (!baseUomId) {
      const uomRow = await trx("erp.uom")
        .select("id")
        .where({ is_active: true })
        .orderBy("id", "asc")
        .first();
      baseUomId = toPositiveInt(uomRow?.id);
    }

    if (!groupId || !baseUomId) {
      throw new HttpError(
        500,
        "Returnable voucher setup is incomplete. Configure Product Group and UOM, then try again.",
      );
    }

    return {
      groupId,
      subgroupId,
      productTypeId,
      baseUomId,
    };
  };

  const defaults = await resolvePlaceholderItemDefaultsTx();

  let created = null;
  try {
    [created] = await trx("erp.items")
      .insert({
        item_type: "RM",
        code: "RETURNABLE_ASSET_ITEM",
        name: "Returnable Asset (System)",
        name_ur: null,
        group_id: defaults.groupId,
        subgroup_id: defaults.subgroupId,
        product_type_id: defaults.productTypeId,
        base_uom_id: defaults.baseUomId,
        min_stock_level: 0,
        is_active: false,
        created_by: userId,
        created_at: trx.fn.now(),
      })
      .returning(["id"]);
  } catch (err) {
    if (String(err?.code || "") === "23502") {
      throw new HttpError(
        500,
        "Returnable voucher setup is incomplete. Configure Product Group and UOM, then try again.",
      );
    }
    if (String(err?.code || "") !== "23505") {
      throw err;
    }
  }

  if (created?.id) {
    returnablePlaceholderItemId = Number(created.id);
    return returnablePlaceholderItemId;
  }

  const afterInsert = await trx("erp.items")
    .select("id")
    .where({ code: "RETURNABLE_ASSET_ITEM" })
    .first();
  if (!afterInsert?.id) {
    throw new HttpError(500, "Unable to create returnable placeholder item");
  }
  returnablePlaceholderItemId = Number(afterInsert.id);
  return returnablePlaceholderItemId;
};

const ensurePartyExistsForBranchTx = async (trx, req, partyId) => {
  const normalizedPartyId = toPositiveInt(partyId);
  if (!normalizedPartyId) throw new HttpError(400, "Vendor is required");

  const query = trx("erp.parties as p")
    .leftJoin("erp.party_branch as pb", "pb.party_id", "p.id")
    .select("p.id", "p.name")
    .where("p.id", normalizedPartyId)
    .where("p.is_active", true)
    .whereRaw("upper(coalesce(p.party_type::text, '')) = 'SUPPLIER'")
    .where(function whereBranch() {
      this.where("pb.branch_id", req.branchId).orWhereNull("pb.branch_id");
    });

  const party = await query.first();
  if (!party)
    throw new HttpError(400, "Selected vendor is invalid for current branch");
  return party;
};

const ensureRegistryCodeExistsTx = async (trx, tableName, code, label) => {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) throw new HttpError(400, `${label} is required`);
  const row = await trx(tableName)
    .select("code")
    .where({ code: normalizedCode, is_active: true })
    .first();
  if (!row) throw new HttpError(400, `${label} is invalid`);
  return normalizedCode;
};

const buildCodeOrderCaseSql = (codes = []) =>
  `CASE upper(coalesce(code::text, '')) ${codes
    .map((code, index) => `WHEN '${code}' THEN ${index + 1}`)
    .join(" ")} ELSE 999 END`;

const getActiveReceiptCountForDispatchTx = async (
  trx,
  dispatchVoucherId,
  excludeReceiptVoucherId = null,
) => {
  let query = trx("erp.rgp_inward as ri")
    .join("erp.voucher_header as vh", "vh.id", "ri.voucher_id")
    .count({ value: "*" })
    .where("ri.rgp_out_voucher_id", dispatchVoucherId)
    .whereNot("vh.status", "REJECTED");
  if (excludeReceiptVoucherId) {
    query = query.whereNot("ri.voucher_id", excludeReceiptVoucherId);
  }
  const row = await query.first();
  return Number(row?.value || 0);
};

const syncOutwardStatusTx = async (trx, outwardVoucherId) => {
  const normalizedOutwardId = toPositiveInt(outwardVoucherId);
  if (!normalizedOutwardId) return;

  const totals = await trx("erp.voucher_line as vl")
    .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "vl.id")
    .where("vl.voucher_header_id", normalizedOutwardId)
    .sum({ sent_qty: "rol.qty" })
    .first();

  const returned = await trx("erp.rgp_inward_line as ril")
    .join("erp.rgp_inward as ri", "ri.voucher_id", "ril.rgp_in_voucher_id")
    .join("erp.voucher_header as vh", "vh.id", "ri.voucher_id")
    .where("ri.rgp_out_voucher_id", normalizedOutwardId)
    .whereNot("vh.status", "REJECTED")
    .sum({ returned_qty: "ril.returned_qty" })
    .first();

  const sentQty = Number(totals?.sent_qty || 0);
  const returnedQty = Number(returned?.returned_qty || 0);
  let nextStatus = "PENDING";
  if (returnedQty > 0 && returnedQty < sentQty)
    nextStatus = "PARTIALLY_RETURNED";
  if (sentQty > 0 && returnedQty >= sentQty) nextStatus = "CLOSED";

  await trx("erp.rgp_outward")
    .where({ voucher_id: normalizedOutwardId })
    .update({ status: nextStatus });
};

const buildDispatchPayloadForApproval = (validated) => ({
  action: "create",
  voucher_type_code: RETURNABLE_VOUCHER_TYPES.dispatch,
  voucher_date: validated.voucherDate,
  vendor_party_id: validated.vendorPartyId,
  reason_code: validated.reasonCode,
  expected_return_date: validated.expectedReturnDate,
  remarks: validated.remarks,
  lines: validated.lines,
});

const buildReceiptPayloadForApproval = (validated) => ({
  action: "create",
  voucher_type_code: RETURNABLE_VOUCHER_TYPES.receipt,
  voucher_date: validated.returnDate,
  rgp_out_voucher_id: validated.outwardVoucherId,
  remarks: validated.remarks,
  lines: validated.lines,
});

const validateDispatchPayloadTx = async ({
  trx,
  req,
  payload,
  existingVoucherId = null,
}) => {
  await ensureReturnableRegistryDefaultsTx(trx);
  const voucherDate = toDateOnly(payload?.voucher_date);
  if (!voucherDate) throw new HttpError(400, "Date is required");

  const vendor = await ensurePartyExistsForBranchTx(
    trx,
    req,
    payload?.vendor_party_id,
  );
  const reasonCode = await ensureRegistryCodeExistsTx(
    trx,
    "erp.rgp_reason_registry",
    payload?.reason_code,
    "Reason",
  );
  const remarks = normalizeText(payload?.remarks, 1000);
  if (reasonCode === "OTHERS" && !remarks) {
    throw new HttpError(400, "Remarks are required when reason is Others");
  }

  const expectedReturnDate = toDateOnly(payload?.expected_return_date);
  if (!expectedReturnDate) {
    throw new HttpError(400, "Expected return date is required");
  }
  if (expectedReturnDate && expectedReturnDate < voucherDate) {
    throw new HttpError(
      400,
      "Expected return date cannot be before dispatch date",
    );
  }

  const rawLines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (!rawLines.length) throw new HttpError(400, "Voucher lines are required");

  const assetMap = await ensureAssetIdsExistTx(
    trx,
    rawLines.map((line) => line?.asset_id),
    req.branchId,
  );

  const lines = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] || {};
    const assetId = toPositiveInt(line.asset_id);
    const asset = assetMap.get(Number(assetId));
    if (!asset)
      throw new HttpError(400, `Line ${index + 1}: asset is required`);
    const itemTypeCode = await ensureRegistryCodeExistsTx(
      trx,
      "erp.asset_type_registry",
      asset.asset_type_code,
      `Line ${index + 1}: item type`,
    );
    const conditionOutCode = await ensureRegistryCodeExistsTx(
      trx,
      "erp.rgp_condition_registry",
      line.condition_out_code,
      `Line ${index + 1}: condition`,
    );
    const qty = toQty(line.qty);
    if (!qty)
      throw new HttpError(
        400,
        `Line ${index + 1}: quantity must be greater than zero`,
      );
    lines.push({
      line_no: index + 1,
      asset_id: asset.id,
      asset_name: asset.description,
      item_type_code: itemTypeCode,
      item_description:
        normalizeText(line.item_description, 500) || asset.description,
      serial_no:
        normalizeText(line.serial_no, 120) ||
        normalizeText(asset.asset_code, 120),
      qty,
      condition_out_code: conditionOutCode,
      remarks: normalizeText(line.remarks, 500),
    });
  }

  if (existingVoucherId) {
    const linkedReceipts = await getActiveReceiptCountForDispatchTx(
      trx,
      existingVoucherId,
    );
    if (linkedReceipts > 0) {
      throw new HttpError(
        400,
        "Dispatch voucher cannot be edited after return receipts exist",
      );
    }
  }

  return {
    voucherDate,
    vendorPartyId: vendor.id,
    vendorName: vendor.name,
    reasonCode,
    expectedReturnDate,
    remarks,
    lines,
  };
};

const loadOutwardLineBalanceMapTx = async (
  trx,
  outwardVoucherId,
  excludeReceiptVoucherId = null,
) => {
  let query = trx("erp.rgp_inward_line as ril")
    .join("erp.rgp_inward as ri", "ri.voucher_id", "ril.rgp_in_voucher_id")
    .join("erp.voucher_header as vh", "vh.id", "ri.voucher_id")
    .select("ril.rgp_out_voucher_line_id")
    .sum({ returned_qty: "ril.returned_qty" })
    .where("ri.rgp_out_voucher_id", outwardVoucherId)
    .whereNot("vh.status", "REJECTED")
    .groupBy("ril.rgp_out_voucher_line_id");

  if (excludeReceiptVoucherId) {
    query = query.whereNot("ri.voucher_id", excludeReceiptVoucherId);
  }

  const rows = await query;
  return new Map(
    rows.map((row) => [
      Number(row.rgp_out_voucher_line_id),
      Number(row.returned_qty || 0),
    ]),
  );
};

const validateReceiptPayloadTx = async ({
  trx,
  req,
  payload,
  existingVoucherId = null,
}) => {
  await ensureReturnableRegistryDefaultsTx(trx);
  const returnDate = toDateOnly(payload?.voucher_date || payload?.return_date);
  if (!returnDate) throw new HttpError(400, "Return date is required");

  const requestedVendorPartyId = toPositiveInt(payload?.vendor_party_id);
  const outwardVoucherId = toPositiveInt(payload?.rgp_out_voucher_id);
  if (!outwardVoucherId)
    throw new HttpError(400, "Outward reference is required");

  const outwardHeader = await trx("erp.rgp_outward as ro")
    .join("erp.voucher_header as vh", "vh.id", "ro.voucher_id")
    .join("erp.parties as p", "p.id", "ro.vendor_party_id")
    .select(
      "ro.voucher_id",
      "ro.vendor_party_id",
      "ro.expected_return_date",
      "ro.status as outward_status",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status as voucher_status",
      "p.name as vendor_name",
    )
    .where("ro.voucher_id", outwardVoucherId)
    .andWhere("vh.branch_id", req.branchId)
    .first();

  if (!outwardHeader)
    throw new HttpError(400, "Selected outward reference is invalid");
  if (String(outwardHeader.voucher_status || "").toUpperCase() === "REJECTED") {
    throw new HttpError(400, "Selected outward voucher is deleted");
  }
  if (
    requestedVendorPartyId &&
    Number(outwardHeader.vendor_party_id) !== Number(requestedVendorPartyId)
  ) {
    throw new HttpError(
      400,
      "Selected outward reference does not belong to selected vendor",
    );
  }

  const outwardLines = await trx("erp.voucher_line as vl")
    .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "vl.id")
    .leftJoin("erp.assets as a", "a.id", "rol.asset_id")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.item_id",
      "rol.asset_id",
      "a.description as asset_name",
      "a.asset_code",
      "rol.item_type_code",
      "rol.item_description",
      "rol.qty",
      "rol.condition_out_code",
      "rol.serial_no",
    )
    .where("vl.voucher_header_id", outwardVoucherId)
    .orderBy("vl.line_no", "asc");

  const outwardLineMap = new Map(
    outwardLines.map((row) => [Number(row.id), row]),
  );
  if (!outwardLineMap.size)
    throw new HttpError(400, "Selected outward voucher has no lines");

  const rawLines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (!rawLines.length) throw new HttpError(400, "Voucher lines are required");

  const existingReturnedMap = await loadOutwardLineBalanceMapTx(
    trx,
    outwardVoucherId,
    existingVoucherId,
  );
  const seenOutwardLineIds = new Set();
  const lines = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] || {};
    const outwardLineId = toPositiveInt(line.rgp_out_voucher_line_id);
    const outwardLine = outwardLineMap.get(Number(outwardLineId));
    if (!outwardLine)
      throw new HttpError(
        400,
        `Line ${index + 1}: outward line reference is invalid`,
      );
    if (seenOutwardLineIds.has(outwardLineId)) {
      throw new HttpError(
        400,
        `Line ${index + 1}: duplicate outward line is not allowed`,
      );
    }
    seenOutwardLineIds.add(outwardLineId);

    const conditionInCode = await ensureRegistryCodeExistsTx(
      trx,
      "erp.rgp_condition_registry",
      line.condition_in_code,
      `Line ${index + 1}: condition`,
    );
    const returnedQty = toQty(line.returned_qty);
    if (!returnedQty)
      throw new HttpError(
        400,
        `Line ${index + 1}: returned quantity must be greater than zero`,
      );

    const alreadyReturned = Number(existingReturnedMap.get(outwardLineId) || 0);
    const sentQty = Number(outwardLine.qty || 0);
    const openQty = Number((sentQty - alreadyReturned).toFixed(3));
    if (returnedQty > openQty) {
      throw new HttpError(
        400,
        `Line ${index + 1}: returned quantity exceeds pending balance`,
      );
    }

    lines.push({
      line_no: index + 1,
      item_id: Number(outwardLine.item_id),
      asset_id: Number(outwardLine.asset_id || 0) || null,
      asset_name: outwardLine.asset_name || "",
      rgp_out_voucher_line_id: outwardLineId,
      item_description:
        normalizeText(line.item_description, 500) ||
        outwardLine.item_description ||
        outwardLine.asset_name,
      returned_qty: returnedQty,
      condition_in_code: conditionInCode,
      condition_out_code: outwardLine.condition_out_code,
      sent_qty: sentQty,
      open_qty: openQty,
      short_excess_qty: Number(
        (sentQty - alreadyReturned - returnedQty).toFixed(3),
      ),
      remarks: normalizeText(line.remarks, 500),
    });
  }

  return {
    returnDate,
    outwardVoucherId,
    outwardVoucherNo: Number(outwardHeader.voucher_no),
    outwardVoucherDate: outwardHeader.voucher_date,
    vendorPartyId: Number(outwardHeader.vendor_party_id),
    vendorName: outwardHeader.vendor_name,
    expectedReturnDate: outwardHeader.expected_return_date,
    remarks: normalizeText(payload?.remarks, 1000),
    lines,
  };
};

const insertDispatchVoucherTx = async ({
  trx,
  branchId,
  actorUserId,
  approverId = null,
  validated,
}) => {
  const placeholderItemId = await getSystemReturnableItemIdTx(trx, actorUserId);
  const voucherNo = await getNextVoucherNoTx(
    trx,
    branchId,
    RETURNABLE_VOUCHER_TYPES.dispatch,
  );
  const approved = Boolean(approverId);

  const [header] = await trx("erp.voucher_header")
    .insert({
      voucher_type_code: RETURNABLE_VOUCHER_TYPES.dispatch,
      voucher_no: voucherNo,
      branch_id: branchId,
      voucher_date: validated.voucherDate,
      book_no: null,
      status: approved ? "APPROVED" : "PENDING",
      created_by: actorUserId,
      approved_by: approved ? approverId : null,
      approved_at: approved ? trx.fn.now() : null,
      remarks: validated.remarks,
    })
    .returning(["id", "voucher_no", "status"]);

  const voucherLineRows = validated.lines.map((line) => ({
    voucher_header_id: header.id,
    line_no: line.line_no,
    line_kind: "ITEM",
    item_id: placeholderItemId,
    sku_id: null,
    account_id: null,
    party_id: null,
    labour_id: null,
    employee_id: null,
    uom_id: null,
    qty: line.qty,
    rate: 0,
    amount: 0,
    reference_no: null,
    meta: {
      asset_id: line.asset_id,
      asset_name: line.asset_name,
      item_description: line.item_description,
      serial_no: line.serial_no,
      condition_out_code: line.condition_out_code,
      returnable: true,
    },
  }));

  const insertedVoucherLines = await trx("erp.voucher_line")
    .insert(voucherLineRows)
    .returning(["id", "line_no"]);
  const lineIdMap = new Map(
    insertedVoucherLines.map((row) => [Number(row.line_no), Number(row.id)]),
  );

  await trx("erp.rgp_outward").insert({
    voucher_id: header.id,
    vendor_party_id: validated.vendorPartyId,
    reason_code: validated.reasonCode,
    expected_return_date: validated.expectedReturnDate,
    status: "PENDING",
  });

  await trx("erp.rgp_outward_line").insert(
    validated.lines.map((line) => ({
      voucher_line_id: lineIdMap.get(Number(line.line_no)),
      asset_id: line.asset_id,
      item_type_code: line.item_type_code,
      item_description: line.item_description,
      serial_no: line.serial_no,
      qty: line.qty,
      condition_out_code: line.condition_out_code,
      remarks: line.remarks,
    })),
  );

  return {
    id: header.id,
    voucherNo: Number(header.voucher_no),
    status: header.status,
  };
};

const insertReceiptVoucherTx = async ({
  trx,
  branchId,
  actorUserId,
  approverId = null,
  validated,
}) => {
  const voucherNo = await getNextVoucherNoTx(
    trx,
    branchId,
    RETURNABLE_VOUCHER_TYPES.receipt,
  );
  const approved = Boolean(approverId);

  const [header] = await trx("erp.voucher_header")
    .insert({
      voucher_type_code: RETURNABLE_VOUCHER_TYPES.receipt,
      voucher_no: voucherNo,
      branch_id: branchId,
      voucher_date: validated.returnDate,
      book_no: null,
      status: approved ? "APPROVED" : "PENDING",
      created_by: actorUserId,
      approved_by: approved ? approverId : null,
      approved_at: approved ? trx.fn.now() : null,
      remarks: validated.remarks,
    })
    .returning(["id", "voucher_no", "status"]);

  await trx("erp.voucher_line").insert(
    validated.lines.map((line) => ({
      voucher_header_id: header.id,
      line_no: line.line_no,
      line_kind: "ITEM",
      item_id: line.item_id,
      sku_id: null,
      account_id: null,
      party_id: null,
      labour_id: null,
      employee_id: null,
      uom_id: null,
      qty: line.returned_qty,
      rate: 0,
      amount: 0,
      reference_no: null,
      meta: {
        asset_id: line.asset_id,
        asset_name: line.asset_name,
        item_description: line.item_description,
        rgp_out_voucher_line_id: line.rgp_out_voucher_line_id,
        condition_in_code: line.condition_in_code,
        short_excess_qty: line.short_excess_qty,
        returnable: true,
      },
    })),
  );

  await trx("erp.rgp_inward").insert({
    voucher_id: header.id,
    rgp_out_voucher_id: validated.outwardVoucherId,
    return_date: validated.returnDate,
  });

  await trx("erp.rgp_inward_line").insert(
    validated.lines.map((line) => ({
      rgp_in_voucher_id: header.id,
      rgp_out_voucher_line_id: line.rgp_out_voucher_line_id,
      returned_qty: line.returned_qty,
      condition_in_code: line.condition_in_code,
      remarks: line.remarks,
    })),
  );

  await syncOutwardStatusTx(trx, validated.outwardVoucherId);

  return {
    id: header.id,
    voucherNo: Number(header.voucher_no),
    status: header.status,
    outwardVoucherId: validated.outwardVoucherId,
  };
};

const loadReturnableVoucherOptions = async (req) => {
  await ensureReturnableRegistryDefaultsTx(knex);
  const isUrdu = String(req?.locale || "en").toLowerCase() === "ur";
  const [hasPartiesNameUr, hasAssetsName, hasAssetsNameUr, hasAssetTypeNameUr] =
    await Promise.all([
      hasPartiesNameUrColumnTx(knex),
      hasAssetsNameColumnTx(knex),
      hasAssetsNameUrColumnTx(knex),
      hasAssetTypeRegistryNameUrColumnTx(knex),
    ]);

  const vendorNameSelect =
    isUrdu && hasPartiesNameUr
      ? knex.raw("COALESCE(p.name_ur, p.name) as name")
      : "p.name as name";
  const itemTypeNameSelect =
    isUrdu && hasAssetTypeNameUr
      ? knex.raw("COALESCE(name_ur, name) as name")
      : "name";
  const assetNameSelect =
    isUrdu && hasAssetsNameUr
      ? knex.raw("COALESCE(name_ur, name, description) as name")
      : hasAssetsName
        ? knex.raw("COALESCE(name, description) as name")
        : knex.raw("description as name");
  const outwardVendorNameSelect =
    isUrdu && hasPartiesNameUr
      ? knex.raw("COALESCE(p.name_ur, p.name) as vendor_name")
      : "p.name as vendor_name";
  const outwardAssetNameSelect =
    isUrdu && hasAssetsNameUr
      ? knex.raw("COALESCE(a.name_ur, a.name, a.description) as asset_name")
      : hasAssetsName
        ? knex.raw("COALESCE(a.name, a.description) as asset_name")
        : "a.description as asset_name";

  const vendorsQuery = knex("erp.parties as p")
    .leftJoin("erp.party_branch as pb", "pb.party_id", "p.id")
    .select("p.id", vendorNameSelect)
    .where("p.is_active", true)
    .whereRaw("upper(coalesce(p.party_type::text, '')) = 'SUPPLIER'")
    .where(function whereBranch() {
      this.where("pb.branch_id", req.branchId).orWhereNull("pb.branch_id");
    })
    .groupBy("p.id", "p.name")
    .orderBy("p.name", "asc");

  if (isUrdu && hasPartiesNameUr) {
    vendorsQuery.groupBy("p.name_ur");
  }

  const [
    vendors,
    reasons,
    conditions,
    itemTypes,
    assets,
    openOutwards,
    openOutwardLines,
  ] = await Promise.all([
    vendorsQuery,
    knex("erp.rgp_reason_registry")
      .select("code", "name")
      .where({ is_active: true })
      .orderByRaw(buildCodeOrderCaseSql(RETURNABLE_REASON_DISPLAY_ORDER))
      .orderBy("name", "asc"),
    knex("erp.rgp_condition_registry")
      .select("code", "name")
      .where({ is_active: true })
      .orderByRaw(buildCodeOrderCaseSql(RETURNABLE_CONDITION_DISPLAY_ORDER))
      .orderBy("name", "asc"),
    knex("erp.asset_type_registry")
      .select("code", itemTypeNameSelect)
      .where({ is_active: true })
      .orderBy("name", "asc"),
    knex("erp.assets")
      .select(
        "id",
        "asset_code",
        assetNameSelect,
        "description",
        "asset_type_code",
      )
      .where({ is_active: true })
      .andWhere((builder) => {
        builder.whereNull("home_branch_id");
        if (req.branchId) builder.orWhere("home_branch_id", req.branchId);
      })
      .orderBy("description", "asc"),
    knex("erp.rgp_outward as ro")
      .join("erp.voucher_header as vh", "vh.id", "ro.voucher_id")
      .join("erp.parties as p", "p.id", "ro.vendor_party_id")
      .select(
        "ro.voucher_id",
        "ro.vendor_party_id",
        "ro.status",
        "ro.expected_return_date",
        "vh.voucher_no",
        "vh.voucher_date",
        outwardVendorNameSelect,
      )
      .where("vh.branch_id", req.branchId)
      .whereNot("vh.status", "REJECTED")
      .whereNot("ro.status", "CLOSED")
      .orderBy("vh.voucher_no", "desc"),
    knex("erp.rgp_outward as ro")
      .join("erp.voucher_header as vh", "vh.id", "ro.voucher_id")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "vl.id")
      .leftJoin("erp.assets as a", "a.id", "rol.asset_id")
      .leftJoin(
        knex("erp.rgp_inward_line as ril")
          .join(
            "erp.rgp_inward as ri",
            "ri.voucher_id",
            "ril.rgp_in_voucher_id",
          )
          .join("erp.voucher_header as rvh", "rvh.id", "ri.voucher_id")
          .select("ril.rgp_out_voucher_line_id")
          .sum({ returned_qty: "ril.returned_qty" })
          .whereNot("rvh.status", "REJECTED")
          .groupBy("ril.rgp_out_voucher_line_id")
          .as("ret"),
        "ret.rgp_out_voucher_line_id",
        "vl.id",
      )
      .select(
        "vh.id as outward_voucher_id",
        "vh.voucher_no as outward_voucher_no",
        "vh.voucher_date as voucher_date",
        "vl.id as outward_voucher_line_id",
        "vl.line_no",
        "rol.asset_id",
        outwardAssetNameSelect,
        "a.asset_code as asset_code",
        "rol.item_type_code",
        "rol.item_description",
        "rol.qty as sent_qty",
        "rol.condition_out_code",
        "rol.serial_no",
        knex.raw("COALESCE(ret.returned_qty, 0) as returned_qty"),
        knex.raw(
          "GREATEST(rol.qty - COALESCE(ret.returned_qty, 0), 0) as pending_qty",
        ),
      )
      .where("vh.branch_id", req.branchId)
      .whereNot("vh.status", "REJECTED")
      .whereNot("ro.status", "CLOSED")
      .orderBy("vh.voucher_no", "desc")
      .orderBy("vl.line_no", "asc"),
  ]);

  return {
    vendors,
    reasons,
    conditions,
    itemTypes,
    assets,
    openOutwards,
    openOutwardLines,
  };
};

const loadRecentReturnableVouchers = async ({ req, voucherTypeCode }) =>
  knex("erp.voucher_header as vh")
    .leftJoin("erp.rgp_outward as ro", function joinOutward() {
      this.on("ro.voucher_id", "vh.id");
    })
    .leftJoin("erp.rgp_inward as ri", function joinInward() {
      this.on("ri.voucher_id", "vh.id");
    })
    .leftJoin("erp.parties as p", function joinVendor() {
      this.on("p.id", "ro.vendor_party_id");
    })
    .leftJoin("erp.voucher_header as ovh", function joinOutwardRef() {
      this.on("ovh.id", "ri.rgp_out_voucher_id");
    })
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status",
      "vh.remarks",
      "ro.status as outward_status",
      "p.name as vendor_name",
      "ovh.voucher_no as outward_reference_voucher_no",
    )
    .where({
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": voucherTypeCode,
    })
    .orderBy("vh.voucher_no", "desc")
    .limit(12);

const getReturnableVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
  const [latest, latestActive] = await Promise.all([
    knex("erp.voucher_header")
      .where({ branch_id: req.branchId, voucher_type_code: voucherTypeCode })
      .max({ value: "voucher_no" })
      .first(),
    knex("erp.voucher_header")
      .where({ branch_id: req.branchId, voucher_type_code: voucherTypeCode })
      .whereNot({ status: "REJECTED" })
      .max({ value: "voucher_no" })
      .first(),
  ]);
  return {
    latestVoucherNo: Number(latest?.value || 0),
    latestActiveVoucherNo: Number(latestActive?.value || 0),
  };
};

const getReturnableVoucherNeighbours = async ({
  req,
  voucherTypeCode,
  cursorNo,
}) => {
  const normalizedCursorNo = parseVoucherNo(cursorNo);
  if (!normalizedCursorNo) {
    return { prevVoucherNo: null, nextVoucherNo: null };
  }

  const [prevRow, nextRow] = await Promise.all([
    knex("erp.voucher_header")
      .select("voucher_no")
      .where({ branch_id: req.branchId, voucher_type_code: voucherTypeCode })
      .andWhere("voucher_no", "<", normalizedCursorNo)
      .orderBy("voucher_no", "desc")
      .first(),
    knex("erp.voucher_header")
      .select("voucher_no")
      .where({ branch_id: req.branchId, voucher_type_code: voucherTypeCode })
      .andWhere("voucher_no", ">", normalizedCursorNo)
      .orderBy("voucher_no", "asc")
      .first(),
  ]);

  return {
    prevVoucherNo: Number(prevRow?.voucher_no || 0) || null,
    nextVoucherNo: Number(nextRow?.voucher_no || 0) || null,
  };
};

const loadDispatchDetailsTx = async ({ trx, req, voucherNo }) => {
  const header = await trx("erp.voucher_header as vh")
    .join("erp.rgp_outward as ro", "ro.voucher_id", "vh.id")
    .join("erp.parties as p", "p.id", "ro.vendor_party_id")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status",
      "vh.remarks",
      "ro.vendor_party_id",
      "ro.reason_code",
      "ro.expected_return_date",
      "ro.status as outward_status",
      "p.name as vendor_name",
    )
    .where({
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": RETURNABLE_VOUCHER_TYPES.dispatch,
      "vh.voucher_no": voucherNo,
    })
    .first();

  if (!header) return null;

  const lines = await trx("erp.voucher_line as vl")
    .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "vl.id")
    .leftJoin("erp.assets as a", "a.id", "rol.asset_id")
    .select(
      "vl.id as voucher_line_id",
      "vl.line_no",
      "rol.asset_id",
      "a.asset_code",
      "a.description as asset_name",
      "rol.item_type_code",
      "rol.item_description",
      "rol.serial_no",
      "rol.qty",
      "rol.condition_out_code",
      "rol.remarks",
    )
    .where("vl.voucher_header_id", header.id)
    .orderBy("vl.line_no", "asc");

  const returnedRows = await trx("erp.rgp_inward_line as ril")
    .join("erp.rgp_inward as ri", "ri.voucher_id", "ril.rgp_in_voucher_id")
    .join("erp.voucher_header as vh", "vh.id", "ri.voucher_id")
    .select("ril.rgp_out_voucher_line_id")
    .sum({ returned_qty: "ril.returned_qty" })
    .where("ri.rgp_out_voucher_id", header.id)
    .whereNot("vh.status", "REJECTED")
    .groupBy("ril.rgp_out_voucher_line_id");
  const returnedMap = new Map(
    returnedRows.map((row) => [
      Number(row.rgp_out_voucher_line_id),
      Number(row.returned_qty || 0),
    ]),
  );

  return {
    ...header,
    lines: lines.map((line) => {
      const returnedQty = Number(
        returnedMap.get(Number(line.voucher_line_id)) || 0,
      );
      const pendingQty = Number(
        (Number(line.qty || 0) - returnedQty).toFixed(3),
      );
      return {
        ...line,
        returned_qty: returnedQty,
        pending_qty: pendingQty,
      };
    }),
  };
};

const loadReceiptDetailsTx = async ({ trx, req, voucherNo }) => {
  const header = await trx("erp.voucher_header as vh")
    .join("erp.rgp_inward as ri", "ri.voucher_id", "vh.id")
    .join("erp.voucher_header as ovh", "ovh.id", "ri.rgp_out_voucher_id")
    .join("erp.rgp_outward as ro", "ro.voucher_id", "ovh.id")
    .join("erp.parties as p", "p.id", "ro.vendor_party_id")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status",
      "vh.remarks",
      "ri.rgp_out_voucher_id",
      "ri.return_date",
      "ovh.voucher_no as outward_reference_voucher_no",
      "ro.vendor_party_id",
      "p.name as vendor_name",
    )
    .where({
      "vh.branch_id": req.branchId,
      "vh.voucher_type_code": RETURNABLE_VOUCHER_TYPES.receipt,
      "vh.voucher_no": voucherNo,
    })
    .first();

  if (!header) return null;

  const lines = await trx("erp.rgp_inward_line as ril")
    .join("erp.voucher_line as ovl", "ovl.id", "ril.rgp_out_voucher_line_id")
    .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "ovl.id")
    .leftJoin("erp.assets as a", "a.id", "rol.asset_id")
    .select(
      "ril.id",
      "ril.rgp_out_voucher_line_id",
      "rol.asset_id",
      "a.asset_code",
      "a.description as asset_name",
      "ovl.line_no as outward_line_no",
      "rol.item_type_code",
      "rol.item_description",
      "rol.qty as sent_qty",
      "ril.returned_qty",
      "ril.condition_in_code",
      "ril.remarks",
    )
    .where("ril.rgp_in_voucher_id", header.id)
    .orderBy("ovl.line_no", "asc");

  return {
    ...header,
    lines,
  };
};

const loadReturnableVoucherDetails = async ({
  req,
  voucherTypeCode,
  voucherNo,
}) => {
  const normalizedVoucherNo = parseVoucherNo(voucherNo);
  if (!normalizedVoucherNo) return null;
  return knex.transaction(async (trx) => {
    if (voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch) {
      return loadDispatchDetailsTx({
        trx,
        req,
        voucherNo: normalizedVoucherNo,
      });
    }
    return loadReceiptDetailsTx({ trx, req, voucherNo: normalizedVoucherNo });
  });
};

const createReturnableVoucher = async ({
  req,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const canCreate = canDo(req, "VOUCHER", scopeKey, "create");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const validated =
      voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch
        ? await validateDispatchPayloadTx({ trx, req, payload })
        : await validateReceiptPayloadTx({ trx, req, payload });

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "create",
    );
    const queuedForApproval =
      !canCreate || (policyRequiresApproval && !canApprove);

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        entityId: "NEW",
        voucherTypeCode,
        summary: `ADD ${voucherTypeCode}`,
        newValue: {
          ...(voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch
            ? buildDispatchPayloadForApproval(validated)
            : buildReceiptPayloadForApproval(validated)),
          permission_reroute: !canCreate,
        },
      });

      return {
        id: null,
        voucherNo: null,
        status: "PENDING",
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canCreate,
      };
    }

    const created =
      voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch
        ? await insertDispatchVoucherTx({
            trx,
            branchId: req.branchId,
            actorUserId: req.user.id,
            approverId: req.user.id,
            validated,
          })
        : await insertReceiptVoucherTx({
            trx,
            branchId: req.branchId,
            actorUserId: req.user.id,
            approverId: req.user.id,
            validated,
          });

    return {
      ...created,
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id || "NEW",
    action: "CREATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      queued_for_approval: result.queuedForApproval === true,
    },
  });

  return result;
};

const updateReturnableVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
  payload,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const canEdit = canDo(req, "VOUCHER", scopeKey, "edit");
  const canApprove = canApproveVoucherAction(req, scopeKey);

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
    if (String(existing.status || "").toUpperCase() === "REJECTED") {
      throw new HttpError(400, "Deleted voucher cannot be edited");
    }

    const validated =
      voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch
        ? await validateDispatchPayloadTx({
            trx,
            req,
            payload,
            existingVoucherId: existing.id,
          })
        : await validateReceiptPayloadTx({
            trx,
            req,
            payload,
            existingVoucherId: existing.id,
          });

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "edit",
    );
    const queuedForApproval =
      !canEdit || (policyRequiresApproval && !canApprove);

    const newValue = {
      ...(voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch
        ? buildDispatchPayloadForApproval(validated)
        : buildReceiptPayloadForApproval(validated)),
      action: "update",
      voucher_id: existing.id,
      voucher_type_code: voucherTypeCode,
      permission_reroute: !canEdit,
    };

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        entityId: existing.id,
        voucherTypeCode,
        summary: `EDIT ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: { status: existing.status },
        newValue,
      });

      return {
        id: existing.id,
        voucherNo: Number(existing.voucher_no),
        status: existing.status,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canEdit,
        updated: false,
      };
    }

    await applyReturnableVoucherUpdatePayloadTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode,
      payload: newValue,
      approverId: req.user.id,
      req,
    });

    return {
      id: existing.id,
      voucherNo: Number(existing.voucher_no),
      status: "APPROVED",
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      updated: true,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "UPDATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      updated: result.updated === true,
    },
  });

  return result;
};

const deleteReturnableVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  scopeKey,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new HttpError(400, "Invalid voucher id");

  const canDelete = canDo(req, "VOUCHER", scopeKey, "hard_delete");
  const canApprove = canApproveVoucherAction(req, scopeKey);

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
    if (String(existing.status || "").toUpperCase() === "REJECTED") {
      throw new HttpError(400, "Voucher already deleted");
    }

    if (voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch) {
      const linkedReceipts = await getActiveReceiptCountForDispatchTx(
        trx,
        existing.id,
      );
      if (linkedReceipts > 0) {
        throw new HttpError(
          400,
          "Dispatch voucher cannot be deleted after return receipts exist",
        );
      }
    }

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "delete",
    );
    const queuedForApproval =
      !canDelete || (policyRequiresApproval && !canApprove);

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        entityId: existing.id,
        voucherTypeCode,
        summary: `DELETE ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: { status: existing.status },
        newValue: {
          action: "delete",
          voucher_id: existing.id,
          voucher_type_code: voucherTypeCode,
          permission_reroute: !canDelete,
        },
      });

      return {
        id: existing.id,
        voucherNo: Number(existing.voucher_no),
        status: existing.status,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canDelete,
        deleted: false,
      };
    }

    await applyReturnableVoucherDeletePayloadTx({
      trx,
      voucherId: existing.id,
      voucherTypeCode,
      approverId: req.user.id,
    });

    return {
      id: existing.id,
      voucherNo: Number(existing.voucher_no),
      status: "REJECTED",
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      deleted: true,
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
      deleted: result.deleted === true,
    },
  });

  return result;
};

const applyReturnableVoucherCreatePayloadTx = async ({
  trx,
  payload,
  approverId,
  req,
}) => {
  const voucherTypeCode = normalizeCode(payload?.voucher_type_code);
  if (
    voucherTypeCode !== RETURNABLE_VOUCHER_TYPES.dispatch &&
    voucherTypeCode !== RETURNABLE_VOUCHER_TYPES.receipt
  ) {
    throw new Error("Unsupported returnable voucher type");
  }

  const validated =
    voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch
      ? await validateDispatchPayloadTx({ trx, req, payload })
      : await validateReceiptPayloadTx({ trx, req, payload });

  return voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch
    ? insertDispatchVoucherTx({
        trx,
        branchId: Number(req.branchId),
        actorUserId: Number(req.user?.id || approverId),
        approverId,
        validated,
      })
    : insertReceiptVoucherTx({
        trx,
        branchId: Number(req.branchId),
        actorUserId: Number(req.user?.id || approverId),
        approverId,
        validated,
      });
};

const applyReturnableVoucherUpdatePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  payload,
  approverId,
  req,
}) => {
  const normalizedVoucherId = toPositiveInt(voucherId || payload?.voucher_id);
  if (!normalizedVoucherId) throw new Error("Invalid voucher id");

  const existing = await trx("erp.voucher_header")
    .select("id", "voucher_type_code", "status")
    .where({ id: normalizedVoucherId, branch_id: req.branchId })
    .first();
  if (!existing) throw new Error("Voucher not found during approval apply");
  if (String(existing.status || "").toUpperCase() === "REJECTED") {
    throw new Error("Deleted voucher cannot be updated");
  }

  const resolvedType = normalizeCode(
    voucherTypeCode || payload?.voucher_type_code || existing.voucher_type_code,
  );
  if (
    resolvedType !== RETURNABLE_VOUCHER_TYPES.dispatch &&
    resolvedType !== RETURNABLE_VOUCHER_TYPES.receipt
  ) {
    throw new Error("Unsupported returnable voucher type");
  }

  const validated =
    resolvedType === RETURNABLE_VOUCHER_TYPES.dispatch
      ? await validateDispatchPayloadTx({
          trx,
          req,
          payload,
          existingVoucherId: normalizedVoucherId,
        })
      : await validateReceiptPayloadTx({
          trx,
          req,
          payload,
          existingVoucherId: normalizedVoucherId,
        });

  if (resolvedType === RETURNABLE_VOUCHER_TYPES.dispatch) {
    const placeholderItemId = await getSystemReturnableItemIdTx(
      trx,
      approverId || req?.user?.id || null,
    );
    await trx("erp.rgp_outward_line")
      .whereIn(
        "voucher_line_id",
        trx("erp.voucher_line")
          .select("id")
          .where({ voucher_header_id: normalizedVoucherId }),
      )
      .del();
    await trx("erp.voucher_line")
      .where({ voucher_header_id: normalizedVoucherId })
      .del();

    await trx("erp.voucher_header").where({ id: normalizedVoucherId }).update({
      voucher_date: validated.voucherDate,
      status: "APPROVED",
      approved_by: approverId,
      approved_at: trx.fn.now(),
      remarks: validated.remarks,
    });

    const insertedLines = await trx("erp.voucher_line")
      .insert(
        validated.lines.map((line) => ({
          voucher_header_id: normalizedVoucherId,
          line_no: line.line_no,
          line_kind: "ITEM",
          item_id: placeholderItemId,
          sku_id: null,
          account_id: null,
          party_id: null,
          labour_id: null,
          employee_id: null,
          uom_id: null,
          qty: line.qty,
          rate: 0,
          amount: 0,
          reference_no: null,
          meta: {
            asset_id: line.asset_id,
            asset_name: line.asset_name,
            item_description: line.item_description,
            serial_no: line.serial_no,
            condition_out_code: line.condition_out_code,
            returnable: true,
          },
        })),
      )
      .returning(["id", "line_no"]);
    const lineIdMap = new Map(
      insertedLines.map((row) => [Number(row.line_no), Number(row.id)]),
    );

    await trx("erp.rgp_outward")
      .where({ voucher_id: normalizedVoucherId })
      .update({
        vendor_party_id: validated.vendorPartyId,
        reason_code: validated.reasonCode,
        expected_return_date: validated.expectedReturnDate,
      });

    await trx("erp.rgp_outward_line").insert(
      validated.lines.map((line) => ({
        voucher_line_id: lineIdMap.get(Number(line.line_no)),
        asset_id: line.asset_id,
        item_type_code: line.item_type_code,
        item_description: line.item_description,
        serial_no: line.serial_no,
        qty: line.qty,
        condition_out_code: line.condition_out_code,
        remarks: line.remarks,
      })),
    );
    await syncOutwardStatusTx(trx, normalizedVoucherId);
    return;
  }

  const receiptRow = await trx("erp.rgp_inward")
    .select("rgp_out_voucher_id")
    .where({ voucher_id: normalizedVoucherId })
    .first();

  await trx("erp.rgp_inward_line")
    .where({ rgp_in_voucher_id: normalizedVoucherId })
    .del();
  await trx("erp.voucher_line")
    .where({ voucher_header_id: normalizedVoucherId })
    .del();

  await trx("erp.voucher_header").where({ id: normalizedVoucherId }).update({
    voucher_date: validated.returnDate,
    status: "APPROVED",
    approved_by: approverId,
    approved_at: trx.fn.now(),
    remarks: validated.remarks,
  });

  await trx("erp.voucher_line").insert(
    validated.lines.map((line) => ({
      voucher_header_id: normalizedVoucherId,
      line_no: line.line_no,
      line_kind: "ITEM",
      item_id: line.item_id,
      sku_id: null,
      account_id: null,
      party_id: null,
      labour_id: null,
      employee_id: null,
      uom_id: null,
      qty: line.returned_qty,
      rate: 0,
      amount: 0,
      reference_no: null,
      meta: {
        asset_id: line.asset_id,
        asset_name: line.asset_name,
        item_description: line.item_description,
        rgp_out_voucher_line_id: line.rgp_out_voucher_line_id,
        condition_in_code: line.condition_in_code,
        short_excess_qty: line.short_excess_qty,
        returnable: true,
      },
    })),
  );

  await trx("erp.rgp_inward")
    .where({ voucher_id: normalizedVoucherId })
    .update({
      rgp_out_voucher_id: validated.outwardVoucherId,
      return_date: validated.returnDate,
    });

  await trx("erp.rgp_inward_line").insert(
    validated.lines.map((line) => ({
      rgp_in_voucher_id: normalizedVoucherId,
      rgp_out_voucher_line_id: line.rgp_out_voucher_line_id,
      returned_qty: line.returned_qty,
      condition_in_code: line.condition_in_code,
      remarks: line.remarks,
    })),
  );

  if (
    receiptRow?.rgp_out_voucher_id &&
    Number(receiptRow.rgp_out_voucher_id) !== Number(validated.outwardVoucherId)
  ) {
    await syncOutwardStatusTx(trx, Number(receiptRow.rgp_out_voucher_id));
  }
  await syncOutwardStatusTx(trx, validated.outwardVoucherId);
};

const applyReturnableVoucherDeletePayloadTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  approverId,
}) => {
  const normalizedVoucherId = toPositiveInt(voucherId);
  if (!normalizedVoucherId) throw new Error("Invalid voucher id");

  const header = await trx("erp.voucher_header")
    .select("id", "voucher_type_code", "status")
    .where({ id: normalizedVoucherId })
    .first();
  if (!header) throw new Error("Voucher not found during delete apply");
  if (String(header.status || "").toUpperCase() === "REJECTED") return;

  const resolvedType = normalizeCode(
    voucherTypeCode || header.voucher_type_code,
  );

  if (resolvedType === RETURNABLE_VOUCHER_TYPES.dispatch) {
    const linkedReceipts = await getActiveReceiptCountForDispatchTx(
      trx,
      normalizedVoucherId,
    );
    if (linkedReceipts > 0) {
      throw new Error(
        "Dispatch voucher cannot be deleted after return receipts exist",
      );
    }
  }

  let outwardVoucherIdToSync = null;
  if (resolvedType === RETURNABLE_VOUCHER_TYPES.receipt) {
    const inward = await trx("erp.rgp_inward")
      .select("rgp_out_voucher_id")
      .where({ voucher_id: normalizedVoucherId })
      .first();
    outwardVoucherIdToSync = Number(inward?.rgp_out_voucher_id || 0) || null;
  }

  await trx("erp.voucher_header").where({ id: normalizedVoucherId }).update({
    status: "REJECTED",
    approved_by: approverId,
    approved_at: trx.fn.now(),
  });

  if (outwardVoucherIdToSync) {
    await syncOutwardStatusTx(trx, outwardVoucherIdToSync);
  }
};

module.exports = {
  RETURNABLE_VOUCHER_TYPES,
  parseVoucherNo,
  loadReturnableVoucherOptions,
  loadRecentReturnableVouchers,
  getReturnableVoucherSeriesStats,
  getReturnableVoucherNeighbours,
  loadReturnableVoucherDetails,
  createReturnableVoucher,
  updateReturnableVoucher,
  deleteReturnableVoucher,
  applyReturnableVoucherCreatePayloadTx,
  applyReturnableVoucherUpdatePayloadTx,
  applyReturnableVoucherDeletePayloadTx,
};
