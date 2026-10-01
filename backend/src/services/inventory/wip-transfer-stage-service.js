const { HttpError } = require("../../middleware/errors/http-error");

const positiveId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const loadApprovedWipRoutesByItemTx = async ({ trx, itemIds }) => {
  try {
    const ids = [...new Set((itemIds || []).map(positiveId).filter(Boolean))];
    const routesByItem = new Map();
    if (!ids.length) return routesByItem;

    // The production voucher also uses the highest approved BOM version for an item.
    const headers = await trx("erp.bom_header")
      .select("id", "item_id", "version_no")
      .whereIn("item_id", ids)
      .where("status", "APPROVED")
      .orderBy("item_id", "asc")
      .orderBy("version_no", "desc");
    const bomByItem = new Map();
    for (const header of headers) {
      const itemId = positiveId(header.item_id);
      if (itemId && !bomByItem.has(itemId)) {
        bomByItem.set(itemId, positiveId(header.id));
      }
    }
    const bomIds = [...new Set([...bomByItem.values()].filter(Boolean))];
    if (!bomIds.length) return routesByItem;

    const rows = await trx("erp.bom_stage_routing as route")
      .join("erp.production_stages as stage", "stage.id", "route.stage_id")
      .select(
        "route.bom_id",
        "route.stage_id",
        "route.sequence_no",
        "route.is_required",
        "route.enforce_sequence",
        "stage.dept_id",
      )
      .whereIn("route.bom_id", bomIds)
      .where("stage.is_active", true)
      .orderBy("route.sequence_no", "asc");
    const itemByBom = new Map(
      [...bomByItem].map(([itemId, bomId]) => [bomId, itemId]),
    );
    for (const row of rows) {
      const itemId = itemByBom.get(positiveId(row.bom_id));
      if (!itemId) continue;
      if (!routesByItem.has(itemId)) routesByItem.set(itemId, []);
      routesByItem.get(itemId).push({
        stage_id: positiveId(row.stage_id),
        dept_id: positiveId(row.dept_id),
        sequence_no: Number(row.sequence_no),
        is_required: row.is_required !== false,
        enforce_sequence: row.enforce_sequence !== false,
      });
    }
    return routesByItem;
  } catch (err) {
    console.error("Error in WipTransferStageService:", err);
    throw err;
  }
};

const sourceStagesForNextStage = (routes, nextStageId) => {
  const ordered = [...(routes || [])].sort(
    (left, right) => left.sequence_no - right.sequence_no,
  );
  const nextIndex = ordered.findIndex(
    (route) => route.stage_id === positiveId(nextStageId),
  );
  if (nextIndex < 1) return [];
  const next = ordered[nextIndex];
  const predecessors = ordered.slice(0, nextIndex);
  if (next.is_required === false || next.enforce_sequence === false) {
    return predecessors.reverse();
  }
  const gateIndex = predecessors.findLastIndex(
    (route) => route.is_required !== false && route.enforce_sequence !== false,
  );
  return predecessors.slice(Math.max(0, gateIndex)).reverse();
};

const loadCommonWipSourceStagesTx = async ({ trx, skuMap, nextStageId }) => {
  const routesByItem = await loadApprovedWipRoutesByItemTx({
    trx,
    itemIds: [...skuMap.values()].map((sku) => sku.item_id),
  });
  let common = null;
  for (const sku of skuMap.values()) {
    const candidates = sourceStagesForNextStage(
      routesByItem.get(positiveId(sku.item_id)) || [],
      nextStageId,
    );
    if (!candidates.length) return [];
    common = common === null
      ? candidates
      : common.filter((stage) => candidates.some((candidate) => candidate.stage_id === stage.stage_id));
  }
  return common || [];
};

const resolveWipTransferStageTx = async ({
  trx,
  skuMap,
  nextStageId,
  disputed,
  sourceStageId,
  disputeReason,
  t,
}) => {
  try {
    const label = (key, fallback) =>
      typeof t === "function" ? t(key) || fallback : fallback;
    const nextId = positiveId(nextStageId);
    if (!nextId) {
      throw new HttpError(
        400,
        label("wip_next_stage_required", "Next stage is required"),
      );
    }
    const reason = String(disputeReason || "").trim();
    if (disputed && !reason) {
      throw new HttpError(
        400,
        label("wip_dispute_reason_required", "Dispute reason is required"),
      );
    }
    if (reason.length > 500) {
      throw new HttpError(
        400,
        label("wip_dispute_reason_long", "Dispute reason is too long"),
      );
    }
    const chosenSourceId = disputed ? positiveId(sourceStageId) : null;
    if (disputed && !chosenSourceId) {
      throw new HttpError(
        400,
        label("wip_dispute_current_required", "Current stage is required for a dispute"),
      );
    }

    const routesByItem = await loadApprovedWipRoutesByItemTx({
      trx,
      itemIds: [...skuMap.values()].map((sku) => sku.item_id),
    });
    let resolvedSourceId = chosenSourceId;
    for (const sku of skuMap.values()) {
      const routes = routesByItem.get(positiveId(sku.item_id)) || [];
      const candidates = sourceStagesForNextStage(routes, nextId);
      if (!candidates.length) {
        throw new HttpError(
          400,
          `${label("wip_next_stage_unreachable", "Next stage is not reachable for SKU")} ${sku.sku_code || sku.id}`,
        );
      }
      const sourceIdForSku = disputed ? chosenSourceId : candidates[0].stage_id;
      if (!candidates.some((route) => route.stage_id === sourceIdForSku)) {
        throw new HttpError(
          400,
          `${label("wip_current_stage_invalid", "Current stage is not a valid predecessor for SKU")} ${sku.sku_code || sku.id}`,
        );
      }
      if (resolvedSourceId && resolvedSourceId !== sourceIdForSku) {
        throw new HttpError(
          400,
          label(
            "wip_mixed_current_stages",
            "Items with different current stages need separate transfer vouchers",
          ),
        );
      }
      resolvedSourceId = sourceIdForSku;
    }
    if (!resolvedSourceId) {
      throw new HttpError(
        400,
        label("wip_current_stage_unresolved", "Current stage could not be determined"),
      );
    }
    if (
      !disputed &&
      positiveId(sourceStageId) &&
      positiveId(sourceStageId) !== resolvedSourceId
    ) {
      throw new HttpError(
        409,
        label(
          "wip_route_changed",
          "Production route changed. Review the transfer stages and submit again.",
        ),
      );
    }
    return {
      sourceStageId: resolvedSourceId,
      nextStageId: nextId,
      stageDispute: disputed === true,
      stageDisputeReason: disputed ? reason : null,
    };
  } catch (err) {
    console.error("Error in WipTransferStageService:", err);
    throw err;
  }
};

module.exports = {
  loadApprovedWipRoutesByItemTx,
  sourceStagesForNextStage,
  loadCommonWipSourceStagesTx,
  resolveWipTransferStageTx,
};
