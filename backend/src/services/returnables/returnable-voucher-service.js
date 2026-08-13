const {
  resolveNegativeStockRoutingTx,
} = require("../inventory/negative-stock-approval");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { queueAuditLog } = require("../../utils/audit-log");
const {
  logVoucherApprovalWriteTx,
} = require("../../utils/approval-activity-log");
const {
  resolveVoucherApprovalRequiredTx,
} = require("../../utils/voucher-approval-policy");
const {
  findPendingVoucherApprovalTx,
  resolvePendingVoucherApprovalsTx,
} = require("../../utils/voucher-approval-sync");
const {
  buildRmStockIdentity,
  moveRmStockTx,
} = require("../inventory/stock-transfer-voucher-service");

const RETURNABLE_VOUCHER_TYPES = {
  dispatch: "RDV",
  receipt: "RRV",
};

// Goods go out to whoever physically takes them, which is not always someone we
// trade with: a repair vendor (SUPPLIER) or a sister concern / neighbouring
// factory / employee (OTHER). Customers are excluded — handing stock to a
// customer is a sale or a delivery, not a returnable loan.
const RETURNABLE_PARTY_TYPES_SQL =
  "upper(coalesce(p.party_type::text, '')) in ('SUPPLIER','OTHER')";

let approvalRequestHasVoucherTypeCodeColumn;
let returnablePlaceholderItemId;
let partiesHasNameUrColumn;
let assetsHasNameColumn;
let assetsHasNameUrColumn;
let assetTypeRegistryHasNameUrColumn;
let stockBalanceRmHasDimensions;

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

// toQty nulls out anything at or below zero, which is right for a line quantity but
// wrong for reporting a balance: an empty or already-negative bucket is exactly what a
// shortfall has to be able to state.
const roundBalanceQty = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : 0;
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
  // De-dupe: a voucher must never accumulate more than one PENDING approval.
  // Refresh an existing pending row in place instead of stacking a duplicate.
  const existingPending = await findPendingVoucherApprovalTx(trx, entityId);
  // requested_by/_at are deliberately left alone: refreshing a request must not
  // transfer authorship to whoever edited it (and, via the maker != checker
  // CHECK, lock an approver out of deciding it).
  const updatePayload = {
    summary,
    old_value: oldValue,
    new_value: newValue,
  };

  if (await hasApprovalRequestVoucherTypeCodeColumnTx(trx)) {
    payload.voucher_type_code = voucherTypeCode;
    updatePayload.voucher_type_code = voucherTypeCode;
  }

  const writeApprovalRow = async () => {
    if (existingPending) {
      await trx("erp.approval_request")
        .where({ id: existingPending.id })
        .update(updatePayload);
      return { id: existingPending.id };
    }
    const [inserted] = await trx("erp.approval_request")
      .insert(payload)
      .returning(["id"]);
    return inserted;
  };

  let row;
  try {
    row = await writeApprovalRow();
  } catch (err) {
    const missingOptionalColumn =
      String(err?.code || "").trim() === "42703" &&
      String(err?.message || "")
        .toLowerCase()
        .includes("voucher_type_code");
    if (!missingOptionalColumn) throw err;
    approvalRequestHasVoucherTypeCodeColumn = false;
    delete payload.voucher_type_code;
    delete updatePayload.voucher_type_code;
    row = await writeApprovalRow();
  }

  await logVoucherApprovalWriteTx({
    trx,
    req,
    voucherId: entityId,
    voucherTypeCode,
    summary,
    newValue,
    approvalRequestId: row?.id || null,
    existingPending,
    source: "returnable-voucher-service",
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

// A dispatch line is either an ASSET (mould/tool, no stock effect) or a raw material
// lent out, which moves stock from ON_HAND to WITH_THIRD_PARTY.
const RETURNABLE_LINE_KINDS = { asset: "ASSET", rawMaterial: "RM" };

const normalizeLineKind = (value) => {
  const code = normalizeCode(value);
  if (code === RETURNABLE_LINE_KINDS.rawMaterial) {
    return RETURNABLE_LINE_KINDS.rawMaterial;
  }
  // Legacy payloads carry no kind at all and are always asset lines.
  return RETURNABLE_LINE_KINDS.asset;
};

const normalizeDimensionId = (value) => toPositiveInt(value);

// RM stock is bucketed by (item, color, size); a lent-out line must name the exact
// bucket it leaves so the return puts it back in the same place.
const buildRmBucketKey = ({ itemId, colorId, sizeId }) =>
  `${Number(itemId || 0)}:${Number(colorId || 0)}:${Number(sizeId || 0)}`;

const stockBalanceRmHasDimensionsTx = async (trx) => {
  if (typeof stockBalanceRmHasDimensions === "boolean") {
    return stockBalanceRmHasDimensions;
  }
  const row = await trx("information_schema.columns")
    .select("column_name")
    .where({
      table_schema: "erp",
      table_name: "stock_balance_rm",
      column_name: "color_id",
    })
    .first();
  stockBalanceRmHasDimensions = Boolean(row?.column_name);
  return stockBalanceRmHasDimensions;
};

// `includeEmpty` keeps buckets that have run down to zero or gone negative. The picker
// and the availability check both need them: a bucket at 0 is still a legitimate
// selection (it just routes the voucher through approval), and dropping it would hide
// the real WAC and base UOM the line has to post at.
const loadRmOnHandBucketsTx = async (
  trx,
  branchId,
  bucketKeys = null,
  { includeEmpty = false } = {},
) => {
  const supportsDimensions = await stockBalanceRmHasDimensionsTx(trx);
  const columns = [
    "sb.item_id",
    "sb.qty",
    "sb.wac",
    "i.code as item_code",
    "i.name as item_name",
    "i.base_uom_id",
    "u.code as uom_code",
  ];
  if (supportsDimensions) {
    columns.push(
      "sb.color_id",
      "sb.size_id",
      "c.name as color_name",
      "z.name as size_name",
    );
  }

  const rows = await trx("erp.stock_balance_rm as sb")
    .join("erp.items as i", "i.id", "sb.item_id")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .modify((query) => {
      if (!supportsDimensions) return;
      query
        .leftJoin("erp.colors as c", "c.id", "sb.color_id")
        .leftJoin("erp.sizes as z", "z.id", "sb.size_id");
    })
    .select(columns)
    .where("sb.branch_id", branchId)
    .where("sb.stock_state", "ON_HAND")
    .modify((query) => {
      if (includeEmpty) return;
      query.where("sb.qty", ">", 0);
    })
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'");

  const map = new Map();
  rows.forEach((row) => {
    const bucket = {
      itemId: Number(row.item_id),
      colorId: supportsDimensions ? normalizeDimensionId(row.color_id) : null,
      sizeId: supportsDimensions ? normalizeDimensionId(row.size_id) : null,
      qty: Number(row.qty || 0),
      wac: Number(row.wac || 0),
      itemCode: row.item_code || null,
      itemName: row.item_name,
      baseUomId: toPositiveInt(row.base_uom_id),
      uomCode: row.uom_code || null,
      colorName: row.color_name || null,
      sizeName: row.size_name || null,
    };
    map.set(buildRmBucketKey(bucket), bucket);
  });

  if (!bucketKeys) return map;
  return new Map(
    [...map.entries()].filter(([key]) => bucketKeys.includes(key)),
  );
};

// Every raw material is dispatchable, whether or not it currently holds stock, so the
// master is the second source the picker draws on. The asset placeholder is a system
// row that only exists to give asset lines an item_id -- it is never lendable itself.
const loadRmMasterItemsTx = async (trx, itemIds = null) => {
  const normalizedIds = Array.isArray(itemIds)
    ? [...new Set(itemIds.map((id) => toPositiveInt(id)).filter(Boolean))]
    : null;
  if (normalizedIds && !normalizedIds.length) return new Map();

  const rows = await trx("erp.items as i")
    .leftJoin("erp.uom as u", "u.id", "i.base_uom_id")
    .select("i.id", "i.code", "i.name", "i.base_uom_id", "u.code as uom_code")
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
    .whereNot("i.code", "RETURNABLE_ASSET_ITEM")
    .modify((query) => {
      // An id list means "resolve what the user actually picked", so an item that was
      // deactivated after selection still has to resolve rather than vanish.
      if (normalizedIds) {
        query.whereIn("i.id", normalizedIds);
        return;
      }
      query.where("i.is_active", true);
    });

  return new Map(
    rows.map((row) => [
      Number(row.id),
      {
        itemId: Number(row.id),
        itemCode: row.code || null,
        itemName: row.name,
        baseUomId: toPositiveInt(row.base_uom_id),
        uomCode: row.uom_code || null,
      },
    ]),
  );
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
  if (!normalizedPartyId) throw new HttpError(400, "Sent To party is required");

  const query = trx("erp.parties as p")
    .leftJoin("erp.party_branch as pb", "pb.party_id", "p.id")
    .select("p.id", "p.name")
    .where("p.id", normalizedPartyId)
    .where("p.is_active", true)
    .whereRaw(RETURNABLE_PARTY_TYPES_SQL)
    .where(function whereBranch() {
      this.where("pb.branch_id", req.branchId).orWhereNull("pb.branch_id");
    });

  const party = await query.first();
  if (!party)
    throw new HttpError(400, "Selected party is invalid for current branch");
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

const describeRmShortfall = (shortfall) => {
  const variant = [shortfall.color_name, shortfall.size_name]
    .filter(Boolean)
    .join("/");
  const label = variant
    ? `${shortfall.item_name} (${variant})`
    : shortfall.item_name;
  return `line ${shortfall.line_no} ${label} needs ${shortfall.short_qty} more than the ${shortfall.available_qty} on hand`;
};

// An approver reading the list sees one line per request, and a dispatch that would
// drive stock negative looks identical to a routine one until the shortfall is spelled
// out. This is that explanation.
const buildNegativeStockReason = (shortfalls = []) => {
  if (!shortfalls.length) return "";
  return `approval required: dispatching more raw material than is in stock, which will drive stock negative - ${shortfalls
    .map(describeRmShortfall)
    .join("; ")}`;
};

const buildDispatchPayloadForApproval = (validated) => {
  const shortfalls = validated.rmShortfalls || [];
  return {
    action: "create",
    voucher_type_code: RETURNABLE_VOUCHER_TYPES.dispatch,
    voucher_date: validated.voucherDate,
    vendor_party_id: validated.vendorPartyId,
    reason_code: validated.reasonCode,
    expected_return_date: validated.expectedReturnDate,
    remarks: validated.remarks,
    lines: validated.lines,
    // The approvals list rebuilds a voucher request's summary from the payload and
    // discards the stored text, so the reason has to travel as approval_reason to
    // survive onto the screen. The stored summary keeps it too, for anything reading
    // approval_request directly.
    ...(shortfalls.length
      ? { approval_reason: buildNegativeStockReason(shortfalls) }
      : {}),
    // Carried so the approver can also see the shortfall itself in the preview.
    negative_stock_lines: shortfalls,
  };
};

const buildDispatchApprovalSummary = (baseSummary, validated) => {
  const reason = buildNegativeStockReason(validated?.rmShortfalls || []);
  return reason ? `${baseSummary} - ${reason}` : baseSummary;
};

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
    rawLines
      .filter((line) => normalizeLineKind(line?.entry_kind) === "ASSET")
      .map((line) => line?.asset_id),
    req.branchId,
  );

  const hasRmLines = rawLines.some(
    (line) =>
      normalizeLineKind(line?.entry_kind) ===
      RETURNABLE_LINE_KINDS.rawMaterial,
  );
  const rmBuckets = hasRmLines
    ? await loadRmOnHandBucketsTx(trx, req.branchId, null, {
        includeEmpty: true,
      })
    : new Map();
  // Lines may name a raw material this branch has never held, which has no bucket row
  // at all. The master supplies the name and base UOM those lines still need.
  const rmMasterItems = hasRmLines
    ? await loadRmMasterItemsTx(
        trx,
        rawLines
          .filter(
            (line) =>
              normalizeLineKind(line?.entry_kind) ===
              RETURNABLE_LINE_KINDS.rawMaterial,
          )
          .map((line) => line?.item_id),
      )
    : new Map();

  // When editing, this voucher's own dispatch has already moved its material out of
  // ON_HAND. Credit that back before checking availability, otherwise re-saving an
  // unchanged voucher fails on stock the voucher itself is holding.
  if (hasRmLines && existingVoucherId) {
    const alreadyDispatched = await loadPostedRmLinesTx(trx, existingVoucherId);
    alreadyDispatched.forEach((posted) => {
      const key = buildRmBucketKey({
        itemId: posted.item_id,
        colorId: posted.color_id,
        sizeId: posted.size_id,
      });
      const bucket = rmBuckets.get(key);
      if (bucket) {
        bucket.qty = Number((bucket.qty + posted.qty).toFixed(3));
        return;
      }
      rmBuckets.set(key, {
        itemId: posted.item_id,
        colorId: posted.color_id,
        sizeId: posted.size_id,
        qty: posted.qty,
        wac: posted.unit_cost,
        itemCode: null,
        itemName: posted.item_name,
        baseUomId: posted.base_uom_id,
        uomCode: null,
        colorName: null,
        sizeName: null,
      });
    });
  }

  // A single dispatch may lend out more than one line from the same RM bucket; the
  // availability check has to see the running total, not each line in isolation.
  const rmQtyClaimed = new Map();
  // Lending out more than the branch holds is allowed but never silent: each shortfall
  // is recorded here so the save forces the voucher through approval and the approver
  // sees exactly which line drives stock negative and by how much.
  const rmShortfalls = [];

  const lines = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] || {};
    const entryKind = normalizeLineKind(line.entry_kind);
    const qty = toQty(line.qty);
    if (!qty)
      throw new HttpError(
        400,
        `Line ${index + 1}: quantity must be greater than zero`,
      );

    if (entryKind === RETURNABLE_LINE_KINDS.rawMaterial) {
      const bucketKey = buildRmBucketKey({
        itemId: toPositiveInt(line.item_id),
        colorId: normalizeDimensionId(line.color_id),
        sizeId: normalizeDimensionId(line.size_id),
      });
      const bucket = rmBuckets.get(bucketKey);
      const masterItem = rmMasterItems.get(toPositiveInt(line.item_id));
      if (!bucket && !masterItem) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected raw material is invalid`,
        );
      }

      const availableQty = bucket ? Number(bucket.qty || 0) : 0;
      const previouslyClaimed = Number(rmQtyClaimed.get(bucketKey) || 0);
      const claimed = previouslyClaimed + qty;
      rmQtyClaimed.set(bucketKey, claimed);
      // Only the part of THIS line that runs past what is on hand counts as short;
      // earlier lines on the same bucket have already eaten into the balance.
      const shortQty = roundBalanceQty(
        Math.max(claimed - availableQty, 0) -
          Math.max(previouslyClaimed - availableQty, 0),
      );
      const itemName = bucket?.itemName || masterItem?.itemName || "";
      if (shortQty > 0.0005) {
        rmShortfalls.push({
          line_no: index + 1,
          item_id: toPositiveInt(line.item_id),
          item_name: itemName,
          color_name: bucket?.colorName || null,
          size_name: bucket?.sizeName || null,
          requested_qty: qty,
          // What was still left when this line ran, not the bucket total: with two
          // lines on one bucket the second must not claim the stock the first
          // already took ("needs 3 more than the 0 on hand", not "than the 4").
          available_qty: roundBalanceQty(availableQty - previouslyClaimed),
          short_qty: shortQty,
        });
      }

      lines.push({
        line_no: index + 1,
        entry_kind: RETURNABLE_LINE_KINDS.rawMaterial,
        asset_id: null,
        asset_name: null,
        item_id: bucket?.itemId || masterItem.itemId,
        color_id: bucket ? bucket.colorId : normalizeDimensionId(line.color_id),
        size_id: bucket ? bucket.sizeId : normalizeDimensionId(line.size_id),
        uom_id: bucket?.baseUomId || masterItem?.baseUomId || null,
        item_type_code: null,
        item_description: normalizeText(line.item_description, 500) || itemName,
        serial_no: null,
        qty,
        // Lent-out material leaves at the bucket's current WAC and returns at the
        // same cost, so a loan never revalues stock. A bucket the branch has never
        // held has no WAC to leave at, so it moves at zero and returns at zero --
        // the qty goes negative but inventory value, and the trial balance, do not.
        unit_cost: bucket ? bucket.wac : 0,
        condition_out_code: null,
        remarks: normalizeText(line.remarks, 500),
      });
      continue;
    }

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
    lines.push({
      line_no: index + 1,
      entry_kind: RETURNABLE_LINE_KINDS.asset,
      asset_id: asset.id,
      asset_name: asset.description,
      item_id: null,
      color_id: null,
      size_id: null,
      uom_id: null,
      item_type_code: itemTypeCode,
      item_description:
        normalizeText(line.item_description, 500) || asset.description,
      serial_no:
        normalizeText(line.serial_no, 120) ||
        normalizeText(asset.asset_code, 120),
      qty,
      unit_cost: 0,
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
    rmShortfalls,
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
      "vl.uom_id",
      "vl.rate",
      "vl.meta",
      "rol.asset_id",
      "rol.item_id as rm_item_id",
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

    // Raw material has no "condition on return" — that only applies to assets.
    const isRawMaterial = Boolean(toPositiveInt(outwardLine.rm_item_id));
    const conditionInCode = isRawMaterial
      ? null
      : await ensureRegistryCodeExistsTx(
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
      entry_kind: isRawMaterial
        ? RETURNABLE_LINE_KINDS.rawMaterial
        : RETURNABLE_LINE_KINDS.asset,
      item_id: Number(outwardLine.item_id),
      uom_id: toPositiveInt(outwardLine.uom_id),
      // Returned material re-enters stock at the cost it left at, so a loan is
      // value-neutral even if the item's WAC moved while it was out.
      unit_cost: isRawMaterial ? Number(outwardLine.rate || 0) : 0,
      color_id: isRawMaterial
        ? normalizeDimensionId(outwardLine.meta?.color_id)
        : null,
      size_id: isRawMaterial
        ? normalizeDimensionId(outwardLine.meta?.size_id)
        : null,
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

const THIRD_PARTY_STOCK_STATE = "WITH_THIRD_PARTY";

// Lending raw material out is a stock-state reclass inside the same branch, not a
// disposal: the value stays in inventory so the trial balance never moves, but every
// stock report filters stock_state = 'ON_HAND' and therefore stops counting it as
// usable. Returning it reverses the same move at the cost it left at.
const moveReturnableRmLinesTx = async ({
  trx,
  branchId,
  lines,
  voucherId,
  voucherDate,
  toThirdParty,
}) => {
  const rmLines = (lines || []).filter(
    (line) =>
      normalizeLineKind(line.entry_kind) ===
        RETURNABLE_LINE_KINDS.rawMaterial && toPositiveInt(line.item_id),
  );
  if (!rmLines.length) return;

  for (const line of rmLines) {
    const bucket = {
      branchId,
      itemId: Number(line.item_id),
      colorId: normalizeDimensionId(line.color_id),
      sizeId: normalizeDimensionId(line.size_id),
    };
    await moveRmStockTx({
      trx,
      fromIdentity: buildRmStockIdentity({
        ...bucket,
        stockState: toThirdParty ? "ON_HAND" : THIRD_PARTY_STOCK_STATE,
      }),
      toIdentity: buildRmStockIdentity({
        ...bucket,
        stockState: toThirdParty ? THIRD_PARTY_STOCK_STATE : "ON_HAND",
      }),
      qty: line.qty,
      unitCostBase: line.unit_cost,
      voucherId,
      voucherLineId: line.voucher_line_id || null,
      voucherDate,
      // Dispatching more than is on hand is a deliberate, approved outcome here, so the
      // move must not be refused at posting time. The gate is upstream: any shortfall
      // forces the voucher through approvals before it ever reaches this point. The
      // return leg is left guarded -- material can only come back if it went out.
      allowNegativeSource: toThirdParty,
    });
  }
};

// Reads back the RM lines already posted by a dispatch/receipt so its stock effect can
// be reversed before the voucher is rewritten or removed.
const loadPostedRmLinesTx = async (trx, voucherId) => {
  const rows = await trx("erp.voucher_line as vl")
    .join("erp.rgp_outward_line as rol", "rol.voucher_line_id", "vl.id")
    .join("erp.items as i", "i.id", "rol.item_id")
    .select(
      "vl.id as voucher_line_id",
      "vl.rate",
      "vl.meta",
      "rol.item_id",
      "rol.qty",
      "i.name as item_name",
      "i.base_uom_id",
    )
    .where("vl.voucher_header_id", voucherId)
    .whereNotNull("rol.item_id");

  return rows.map((row) => ({
    entry_kind: RETURNABLE_LINE_KINDS.rawMaterial,
    voucher_line_id: Number(row.voucher_line_id),
    item_id: Number(row.item_id),
    color_id: normalizeDimensionId(row.meta?.color_id),
    size_id: normalizeDimensionId(row.meta?.size_id),
    qty: Number(row.qty || 0),
    unit_cost: Number(row.rate || 0),
    item_name: row.item_name,
    base_uom_id: toPositiveInt(row.base_uom_id),
  }));
};

// Shared by the direct-save and approval-apply paths so both write an identical row.
// Asset lines keep the inactive placeholder item they always used; RM lines point at
// the real item and carry the cost they left stock at, which is what the matching
// receipt reads back to return them at the same value.
const buildDispatchVoucherLineRow = ({
  voucherHeaderId,
  line,
  placeholderItemId,
}) => {
  const isRawMaterial =
    normalizeLineKind(line.entry_kind) === RETURNABLE_LINE_KINDS.rawMaterial;
  const unitCost = isRawMaterial ? Number(line.unit_cost || 0) : 0;

  return {
    voucher_header_id: voucherHeaderId,
    line_no: line.line_no,
    line_kind: "ITEM",
    item_id: isRawMaterial ? Number(line.item_id) : placeholderItemId,
    sku_id: null,
    account_id: null,
    party_id: null,
    labour_id: null,
    employee_id: null,
    uom_id: isRawMaterial ? line.uom_id || null : null,
    qty: line.qty,
    rate: unitCost,
    amount: Number((Number(line.qty || 0) * unitCost).toFixed(2)),
    reference_no: null,
    meta: {
      entry_kind: isRawMaterial
        ? RETURNABLE_LINE_KINDS.rawMaterial
        : RETURNABLE_LINE_KINDS.asset,
      asset_id: line.asset_id,
      asset_name: line.asset_name,
      item_description: line.item_description,
      serial_no: line.serial_no,
      condition_out_code: line.condition_out_code,
      returnable: true,
      ...(isRawMaterial
        ? {
            item_id: Number(line.item_id),
            color_id: line.color_id || null,
            size_id: line.size_id || null,
          }
        : {}),
    },
  };
};

// Receipt lines have no rgp_outward_line row of their own, so their RM identity is
// read back from the meta written at insert time.
const loadPostedReceiptRmLinesTx = async (trx, voucherId) => {
  const rows = await trx("erp.voucher_line")
    .select("id as voucher_line_id", "item_id", "qty", "rate", "meta")
    .where({ voucher_header_id: voucherId });

  return rows
    .filter(
      (row) =>
        normalizeLineKind(row.meta?.entry_kind) ===
        RETURNABLE_LINE_KINDS.rawMaterial,
    )
    .map((row) => ({
      entry_kind: RETURNABLE_LINE_KINDS.rawMaterial,
      voucher_line_id: Number(row.voucher_line_id),
      item_id: Number(row.item_id),
      color_id: normalizeDimensionId(row.meta?.color_id),
      size_id: normalizeDimensionId(row.meta?.size_id),
      qty: Number(row.qty || 0),
      unit_cost: Number(row.rate || 0),
    }));
};

// Undoes a voucher's stock effect before it is rewritten or removed. A dispatch is
// undone by bringing the material back on hand; a receipt by sending it back out.
const reverseReturnableRmPostingTx = async ({
  trx,
  voucherId,
  voucherTypeCode,
  branchId,
  voucherDate,
}) => {
  const isDispatch = voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch;
  const lines = isDispatch
    ? await loadPostedRmLinesTx(trx, voucherId)
    : await loadPostedReceiptRmLinesTx(trx, voucherId);
  if (!lines.length) return;

  await moveReturnableRmLinesTx({
    trx,
    branchId,
    lines,
    voucherId,
    voucherDate,
    toThirdParty: !isDispatch,
  });
};

const buildOutwardLineRow = (line, lineIdMap) => ({
  voucher_line_id: lineIdMap.get(Number(line.line_no)),
  asset_id: line.asset_id,
  item_id: line.item_id || null,
  item_type_code: line.item_type_code,
  item_description: line.item_description,
  serial_no: line.serial_no,
  qty: line.qty,
  condition_out_code: line.condition_out_code,
  remarks: line.remarks,
});

// The stock move needs the voucher_line id for its ledger rows, which only exists
// after the lines are inserted.
const attachVoucherLineIds = (lines, lineIdMap) =>
  lines.map((line) => ({
    ...line,
    voucher_line_id: lineIdMap.get(Number(line.line_no)) || null,
  }));

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

  const voucherLineRows = validated.lines.map((line) =>
    buildDispatchVoucherLineRow({
      voucherHeaderId: header.id,
      line,
      placeholderItemId,
    }),
  );

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
    validated.lines.map((line) => buildOutwardLineRow(line, lineIdMap)),
  );

  if (approved) {
    await moveReturnableRmLinesTx({
      trx,
      branchId,
      lines: attachVoucherLineIds(validated.lines, lineIdMap),
      voucherId: header.id,
      voucherDate: validated.voucherDate,
      toThirdParty: true,
    });
  }

  return {
    id: header.id,
    voucherNo: Number(header.voucher_no),
    status: header.status,
  };
};

const buildReceiptVoucherLineRow = (voucherHeaderId, line) => {
  const isRawMaterial =
    normalizeLineKind(line.entry_kind) === RETURNABLE_LINE_KINDS.rawMaterial;
  const unitCost = isRawMaterial ? Number(line.unit_cost || 0) : 0;

  return {
    voucher_header_id: voucherHeaderId,
    line_no: line.line_no,
    line_kind: "ITEM",
    item_id: line.item_id,
    sku_id: null,
    account_id: null,
    party_id: null,
    labour_id: null,
    employee_id: null,
    uom_id: isRawMaterial ? line.uom_id || null : null,
    qty: line.returned_qty,
    rate: unitCost,
    amount: Number((Number(line.returned_qty || 0) * unitCost).toFixed(2)),
    reference_no: null,
    meta: {
      entry_kind: isRawMaterial
        ? RETURNABLE_LINE_KINDS.rawMaterial
        : RETURNABLE_LINE_KINDS.asset,
      asset_id: line.asset_id,
      asset_name: line.asset_name,
      item_description: line.item_description,
      rgp_out_voucher_line_id: line.rgp_out_voucher_line_id,
      condition_in_code: line.condition_in_code,
      short_excess_qty: line.short_excess_qty,
      returnable: true,
      ...(isRawMaterial
        ? {
            item_id: Number(line.item_id),
            color_id: line.color_id || null,
            size_id: line.size_id || null,
          }
        : {}),
    },
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

  const insertedReceiptLines = await trx("erp.voucher_line")
    .insert(
      validated.lines.map((line) =>
        buildReceiptVoucherLineRow(header.id, line),
      ),
    )
    .returning(["id", "line_no"]);
  const receiptLineIdMap = new Map(
    insertedReceiptLines.map((row) => [Number(row.line_no), Number(row.id)]),
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

  if (approved) {
    await moveReturnableRmLinesTx({
      trx,
      branchId,
      lines: attachVoucherLineIds(
        validated.lines.map((line) => ({ ...line, qty: line.returned_qty })),
        receiptLineIdMap,
      ),
      voucherId: header.id,
      voucherDate: validated.returnDate,
      toThirdParty: false,
    });
  }

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
    .whereRaw(RETURNABLE_PARTY_TYPES_SQL)
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
      .leftJoin("erp.items as itm", "itm.id", "rol.item_id")
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
        "rol.item_id",
        "itm.name as rm_item_name",
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

  // The picker lists the whole raw-material master, not only what is in stock: every
  // (item, colour, size) bucket the branch holds, plus a plain entry for any active
  // raw material with no bucket at all. Picking something the branch is short of is
  // allowed -- it routes the voucher through approval instead of being hidden.
  const [rmBucketMap, rmMasterMap] = await Promise.all([
    loadRmOnHandBucketsTx(knex, req.branchId, null, { includeEmpty: true }),
    loadRmMasterItemsTx(knex),
  ]);
  const rmBucketRows = [...rmBucketMap.values()].map((bucket) => ({
    item_id: bucket.itemId,
    color_id: bucket.colorId,
    size_id: bucket.sizeId,
    item_code: bucket.itemCode,
    name: bucket.itemName,
    uom_code: bucket.uomCode,
    color_name: bucket.colorName,
    size_name: bucket.sizeName,
    available_qty: bucket.qty,
  }));
  // A dimensionless entry would duplicate an existing plain bucket, so only add the
  // master row for items that have no dimensionless bucket of their own.
  const itemsWithPlainBucket = new Set(
    rmBucketRows
      .filter((row) => !row.color_id && !row.size_id)
      .map((row) => Number(row.item_id)),
  );
  const rmMasterRows = [...rmMasterMap.values()]
    .filter((item) => !itemsWithPlainBucket.has(item.itemId))
    .map((item) => ({
      item_id: item.itemId,
      color_id: null,
      size_id: null,
      item_code: item.itemCode,
      name: item.itemName,
      uom_code: item.uomCode,
      color_name: null,
      size_name: null,
      available_qty: 0,
    }));
  const rmStockBuckets = [...rmBucketRows, ...rmMasterRows].sort(
    (a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")) ||
      String(a.color_name || "").localeCompare(String(b.color_name || "")) ||
      String(a.size_name || "").localeCompare(String(b.size_name || "")),
  );

  return {
    vendors,
    reasons,
    conditions,
    itemTypes,
    assets,
    rmStockBuckets,
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
    .leftJoin("erp.users as cu", "cu.id", "vh.created_by")
    .leftJoin("erp.users as au", "au.id", "vh.approved_by")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status",
      "vh.remarks",
      knex.raw(
        "COALESCE(NULLIF(cu.name, ''), cu.username, '') as created_by_name",
      ),
      knex.raw(
        "COALESCE(NULLIF(au.name, ''), au.username, '') as approved_by_name",
      ),
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
    .leftJoin("erp.items as itm", "itm.id", "rol.item_id")
    .leftJoin("erp.uom as u", "u.id", "vl.uom_id")
    .select(
      "vl.id as voucher_line_id",
      "vl.line_no",
      "vl.meta",
      "rol.asset_id",
      "a.asset_code",
      "a.description as asset_name",
      "rol.item_id",
      "itm.name as rm_item_name",
      "u.code as uom_code",
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
        // Colour/size live in meta (the same convention purchases use for RM lines);
        // surface them flat so the form can re-select the exact stock bucket.
        color_id: normalizeDimensionId(line.meta?.color_id),
        size_id: normalizeDimensionId(line.meta?.size_id),
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
    .leftJoin("erp.users as cu", "cu.id", "vh.created_by")
    .leftJoin("erp.users as au", "au.id", "vh.approved_by")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.status",
      "vh.remarks",
      knex.raw(
        "COALESCE(NULLIF(cu.name, ''), cu.username, '') as created_by_name",
      ),
      knex.raw(
        "COALESCE(NULLIF(au.name, ''), au.username, '') as approved_by_name",
      ),
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
    .leftJoin("erp.items as itm", "itm.id", "rol.item_id")
    .select(
      "ril.id",
      "ril.rgp_out_voucher_line_id",
      "rol.asset_id",
      "a.asset_code",
      "a.description as asset_name",
      "rol.item_id",
      "itm.name as rm_item_name",
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
    // Lending out more than is on hand now routes through the voucher's Neg. Stock
    // control like every other stock voucher, instead of forcing a checker regardless
    // of the setting. A user who can approve this voucher still posts directly.
    const negativeStockRouting = await resolveNegativeStockRoutingTx({
      trx,
      voucherTypeCode,
      canApproveVoucherAction: canApprove,
      detectRisk: () => validated.rmShortfalls || [],
    });
    const queuedForApproval =
      !canCreate ||
      negativeStockRouting.queueForApproval ||
      (policyRequiresApproval && !canApprove);

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequestTx({
        trx,
        req,
        entityId: "NEW",
        voucherTypeCode,
        summary: buildDispatchApprovalSummary(`ADD ${voucherTypeCode}`, validated),
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
        negativeStockApprovalReroute:
          negativeStockRouting.negativeStockApprovalReroute,
        approvalReason: negativeStockRouting.approvalReason,
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
    // Same rule as create: an edit that pushes a bucket negative follows the voucher's
    // Neg. Stock control.
    const negativeStockRouting = await resolveNegativeStockRoutingTx({
      trx,
      voucherTypeCode,
      canApproveVoucherAction: canApprove,
      detectRisk: () => validated.rmShortfalls || [],
    });
    const queuedForApproval =
      !canEdit ||
      negativeStockRouting.queueForApproval ||
      (policyRequiresApproval && !canApprove);

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
        summary: buildDispatchApprovalSummary(
          `EDIT ${voucherTypeCode} #${existing.voucher_no}`,
          validated,
        ),
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
        negativeStockApprovalReroute:
          negativeStockRouting.negativeStockApprovalReroute,
        approvalReason: negativeStockRouting.approvalReason,
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

    // Confirmed directly on the voucher screen: resolve any lingering PENDING
    // approval so it moves to the Approved tab instead of orphaning on Pending.
    await resolvePendingVoucherApprovalsTx({
      trx,
      voucherId: existing.id,
      decidedBy: req.user.id,
      status: "APPROVED",
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

    // Deleted directly: resolve any lingering PENDING approval to REJECTED so it
    // leaves the Pending Approvals page.
    await resolvePendingVoucherApprovalsTx({
      trx,
      voucherId: existing.id,
      decidedBy: req.user.id,
      status: "REJECTED",
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
    // Undo the stock this voucher had lent out before its lines are replaced; the
    // new lines post their own movement below.
    await reverseReturnableRmPostingTx({
      trx,
      voucherId: normalizedVoucherId,
      voucherTypeCode: RETURNABLE_VOUCHER_TYPES.dispatch,
      branchId: req.branchId,
      voucherDate: validated.voucherDate,
    });

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
        validated.lines.map((line) =>
          buildDispatchVoucherLineRow({
            voucherHeaderId: normalizedVoucherId,
            line,
            placeholderItemId,
          }),
        ),
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
      validated.lines.map((line) => buildOutwardLineRow(line, lineIdMap)),
    );
    await moveReturnableRmLinesTx({
      trx,
      branchId: req.branchId,
      lines: attachVoucherLineIds(validated.lines, lineIdMap),
      voucherId: normalizedVoucherId,
      voucherDate: validated.voucherDate,
      toThirdParty: true,
    });
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

  // Send back out whatever this receipt had returned, before its lines are replaced.
  await reverseReturnableRmPostingTx({
    trx,
    voucherId: normalizedVoucherId,
    voucherTypeCode: RETURNABLE_VOUCHER_TYPES.receipt,
    branchId: req.branchId,
    voucherDate: validated.returnDate,
  });

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

  const insertedReceiptLines = await trx("erp.voucher_line")
    .insert(
      validated.lines.map((line) =>
        buildReceiptVoucherLineRow(normalizedVoucherId, line),
      ),
    )
    .returning(["id", "line_no"]);
  const receiptLineIdMap = new Map(
    insertedReceiptLines.map((row) => [Number(row.line_no), Number(row.id)]),
  );

  await moveReturnableRmLinesTx({
    trx,
    branchId: req.branchId,
    lines: attachVoucherLineIds(
      validated.lines.map((line) => ({ ...line, qty: line.returned_qty })),
      receiptLineIdMap,
    ),
    voucherId: normalizedVoucherId,
    voucherDate: validated.returnDate,
    toThirdParty: false,
  });

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
    .select("id", "voucher_type_code", "status", "branch_id", "voucher_date")
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

  // Deleting is a soft reject, so the stock it moved has to be moved back.
  if (String(header.status || "").toUpperCase() === "APPROVED") {
    await reverseReturnableRmPostingTx({
      trx,
      voucherId: normalizedVoucherId,
      voucherTypeCode: resolvedType,
      branchId: Number(header.branch_id),
      voucherDate: toDateOnly(header.voucher_date),
    });
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
  RETURNABLE_PARTY_TYPES_SQL,
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
