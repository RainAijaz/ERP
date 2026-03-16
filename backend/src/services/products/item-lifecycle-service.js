const hasBomLifecycleColumnTx = async (trx) => {
  try {
    return trx.schema.withSchema("erp").hasColumn("bom_header", "is_active");
  } catch (err) {
    return false;
  }
};

const getCascadeItemIdsForToggleTx = async (trx, { itemId, itemType }) => {
  const rootId = Number(itemId || 0);
  if (!Number.isInteger(rootId) || rootId <= 0) return [];
  if (String(itemType || "").toUpperCase() !== "FG") return [rootId];
  const linked = await trx("erp.item_usage")
    .select("sfg_item_id")
    .where({ fg_item_id: rootId });
  const linkedIds = linked
    .map((row) => Number(row?.sfg_item_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set([rootId, ...linkedIds])];
};

const deactivateLinkedVariantsAndSkusTx = async (trx, itemIds, userId) => {
  if (!Array.isArray(itemIds) || !itemIds.length) return { variantCount: 0, skuCount: 0 };
  const variantRows = await trx("erp.variants")
    .select("id")
    .whereIn("item_id", itemIds);
  const variantIds = variantRows
    .map((row) => Number(row?.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!variantIds.length) return { variantCount: 0, skuCount: 0 };

  const variantCount = await trx("erp.variants")
    .whereIn("id", variantIds)
    .update({
      is_active: false,
      updated_by: userId || null,
      updated_at: trx.fn.now(),
    });
  const skuCount = await trx("erp.skus")
    .whereIn("variant_id", variantIds)
    .update({ is_active: false });

  return { variantCount, skuCount };
};

const deactivateLinkedBomsTx = async (trx, itemIds) => {
  if (!Array.isArray(itemIds) || !itemIds.length) return 0;
  const hasLifecycleColumn = await hasBomLifecycleColumnTx(trx);
  if (!hasLifecycleColumn) return 0;
  return trx("erp.bom_header")
    .whereIn("item_id", itemIds)
    .andWhere("is_active", true)
    .update({ is_active: false });
};

const applyItemLifecycleToggleTx = async (
  trx,
  {
    itemId,
    itemType,
    isActive,
    userId = null,
  },
) => {
  const targetIsActive = Boolean(isActive);
  const itemIds = await getCascadeItemIdsForToggleTx(trx, { itemId, itemType });
  if (!itemIds.length) {
    return {
      itemIds: [],
      itemCount: 0,
      variantCount: 0,
      skuCount: 0,
      bomCount: 0,
      isActive: targetIsActive,
    };
  }

  const itemCount = await trx("erp.items")
    .whereIn("id", itemIds)
    .update({
      is_active: targetIsActive,
      updated_by: userId || null,
      updated_at: trx.fn.now(),
    });

  let variantCount = 0;
  let skuCount = 0;
  let bomCount = 0;
  if (!targetIsActive) {
    const childCounts = await deactivateLinkedVariantsAndSkusTx(trx, itemIds, userId);
    variantCount = childCounts.variantCount;
    skuCount = childCounts.skuCount;
    bomCount = await deactivateLinkedBomsTx(trx, itemIds);
  }

  return {
    itemIds,
    itemCount,
    variantCount,
    skuCount,
    bomCount,
    isActive: targetIsActive,
  };
};

module.exports = {
  applyItemLifecycleToggleTx,
};
