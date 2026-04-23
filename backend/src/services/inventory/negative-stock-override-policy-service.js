const INVENTORY_NEGATIVE_STOCK_OVERRIDE_TABLE =
  "erp.inventory_negative_stock_override";

const INVENTORY_NEGATIVE_STOCK_OVERRIDE_SUBJECT_TYPES = Object.freeze({
  role: "ROLE",
  user: "USER",
});

let inventoryNegativeStockOverrideTableSupport;

const toPositiveInt = (value) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
};

const normalizeVoucherTypeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeSubjectType = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const hasInventoryNegativeStockOverrideTableTx = async (trx) => {
  if (typeof inventoryNegativeStockOverrideTableSupport === "boolean") {
    return inventoryNegativeStockOverrideTableSupport;
  }
  try {
    inventoryNegativeStockOverrideTableSupport = await trx.schema
      .withSchema("erp")
      .hasTable("inventory_negative_stock_override");
    return inventoryNegativeStockOverrideTableSupport;
  } catch (err) {
    console.error("Error in NegativeStockOverridePolicyService:", err);
    inventoryNegativeStockOverrideTableSupport = false;
    return false;
  }
};

const canBypassNegativeStockApprovalTx = async ({
  trx,
  voucherTypeCode,
  userId,
  roleId,
}) => {
  const normalizedVoucherTypeCode = normalizeVoucherTypeCode(voucherTypeCode);
  if (!normalizedVoucherTypeCode) return false;

  const normalizedUserId = toPositiveInt(userId);
  const normalizedRoleId = toPositiveInt(roleId);
  if (!normalizedUserId && !normalizedRoleId) return false;

  const hasTable = await hasInventoryNegativeStockOverrideTableTx(trx);
  if (!hasTable) return false;

  const row = await trx(INVENTORY_NEGATIVE_STOCK_OVERRIDE_TABLE)
    .select("id")
    .where({
      voucher_type_code: normalizedVoucherTypeCode,
      is_enabled: true,
    })
    .andWhere((builder) => {
      if (normalizedUserId) {
        builder.orWhere({
          subject_type: INVENTORY_NEGATIVE_STOCK_OVERRIDE_SUBJECT_TYPES.user,
          subject_id: normalizedUserId,
        });
      }
      if (normalizedRoleId) {
        builder.orWhere({
          subject_type: INVENTORY_NEGATIVE_STOCK_OVERRIDE_SUBJECT_TYPES.role,
          subject_id: normalizedRoleId,
        });
      }
    })
    .first();

  return Boolean(row?.id);
};

module.exports = {
  INVENTORY_NEGATIVE_STOCK_OVERRIDE_TABLE,
  INVENTORY_NEGATIVE_STOCK_OVERRIDE_SUBJECT_TYPES,
  normalizeVoucherTypeCode,
  normalizeSubjectType,
  canBypassNegativeStockApprovalTx,
};
