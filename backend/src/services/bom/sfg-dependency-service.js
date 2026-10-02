const positiveId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const hasSfgDependencyCycle = ({ parentItemId, childItemIds, approvedEdges }) => {
  const parentId = positiveId(parentItemId);
  const children = [...new Set((childItemIds || []).map(positiveId).filter(Boolean))];
  if (!parentId || !children.length) return false;

  const edges = new Map();
  for (const row of approvedEdges || []) {
    const sourceId = positiveId(row.parent_item_id);
    const childId = positiveId(row.child_item_id);
    if (!sourceId || !childId || sourceId === parentId) continue;
    if (!edges.has(sourceId)) edges.set(sourceId, new Set());
    edges.get(sourceId).add(childId);
  }
  edges.set(parentId, new Set(children));

  const visited = new Set();
  const pending = [...children];
  while (pending.length) {
    const itemId = pending.pop();
    if (itemId === parentId) return true;
    if (visited.has(itemId)) continue;
    visited.add(itemId);
    for (const dependency of edges.get(itemId) || []) pending.push(dependency);
  }
  return false;
};

const assertNoSfgDependencyCycleTx = async ({
  trx,
  parentItemId,
  childItemIds,
  requireApprovedChildren = false,
  t,
}) => {
  try {
    const children = [...new Set((childItemIds || []).map(positiveId).filter(Boolean))];
    if (!children.length) return;
    const approvedHeaders = await trx("erp.bom_header")
      .select("id", "item_id")
      .where({ status: "APPROVED", level: "SEMI_FINISHED" })
      .orderBy("item_id", "asc")
      .orderBy("version_no", "desc")
      .orderBy("id", "desc");
    // Production uses the highest approved version for each item.
    const preferredBomIds = new Set();
    const seenItems = new Set();
    for (const row of approvedHeaders) {
      const itemId = positiveId(row.item_id);
      if (!itemId || seenItems.has(itemId)) continue;
      seenItems.add(itemId);
      preferredBomIds.add(positiveId(row.id));
    }
    if (requireApprovedChildren && children.some((itemId) => !seenItems.has(itemId))) {
      const key = "bom_error_sfg_requires_approved_bom";
      const translated = typeof t === "function" ? t(key) : null;
      const message = translated && translated !== key
        ? translated
        : "Selected SFG item has no approved BOM.";
      const error = new Error(message);
      error.code = "BOM_VALIDATION";
      error.details = [{ field: "sfg_lines_json", message }];
      throw error;
    }
    const approvedEdges = preferredBomIds.size
      ? await trx("erp.bom_sfg_line as line")
          .join("erp.bom_header as header", "header.id", "line.bom_id")
          .join("erp.skus as sku", "sku.id", "line.sfg_sku_id")
          .join("erp.variants as variant", "variant.id", "sku.variant_id")
          .select("header.item_id as parent_item_id", "variant.item_id as child_item_id")
          .whereIn("line.bom_id", [...preferredBomIds])
      : [];
    if (
      hasSfgDependencyCycle({ parentItemId, childItemIds: children, approvedEdges })
    ) {
      const key = "bom_error_sfg_dependency_cycle";
      const translated = typeof t === "function" ? t(key) : null;
      const message = translated && translated !== key
        ? translated
        : "A semi-finished item cannot consume itself, directly or through another semi-finished item.";
      const error = new Error(message);
      error.code = "BOM_VALIDATION";
      error.details = [{ field: "sfg_lines_json", message }];
      throw error;
    }
  } catch (err) {
    console.error("Error in SfgDependencyService:", err);
    throw err;
  }
};

module.exports = { hasSfgDependencyCycle, assertNoSfgDependencyCycleTx };
