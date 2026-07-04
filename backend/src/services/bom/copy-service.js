const bomService = require("./service");
const { keysBySection } = require("../../utils/bom-change-log");

const BOM_LEVELS = new Set(["FINISHED", "SEMI_FINISHED"]);
const COPY_SECTIONS = new Set(["rm", "sku_overrides", "stage_routes", "sfg"]);

const toNumberOrNull = (value) => {
  if (value === null || typeof value === "undefined" || value === "")
    return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const makeCopyError = (message) => {
  const err = new Error(message);
  err.code = "BOM_COPY_INVALID";
  return err;
};

const resolveText = (t, key, fallback) => {
  if (typeof t !== "function") return fallback;
  const value = t(key);
  return value && value !== key ? value : fallback;
};

// Variant identity used to match SKUs across articles (null-safe).
const skuVariantKey = (sku) =>
  [
    toNumberOrNull(sku?.size_id) || 0,
    toNumberOrNull(sku?.grade_id) || 0,
    toNumberOrNull(sku?.color_id) || 0,
    toNumberOrNull(sku?.packing_type_id) || 0,
  ].join("|");

const skuVariantLabel = (sku) => {
  const parts = [sku?.size_name, sku?.color_name, sku?.packing_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : String(sku?.sku_code || "");
};

const hasBomLifecycleColumn = async (knex) => {
  try {
    return await knex.schema
      .withSchema("erp")
      .hasColumn("bom_header", "is_active");
  } catch (err) {
    return false;
  }
};

const listApprovedCopySources = async (knex, { level, excludeItemId }) => {
  const normalizedLevel = String(level || "").toUpperCase();
  if (!BOM_LEVELS.has(normalizedLevel)) return [];
  const lifecycleSupported = await hasBomLifecycleColumn(knex);
  let query = knex("erp.bom_header as bh")
    .distinctOn("bh.item_id")
    .select(
      "bh.id as bom_id",
      "bh.bom_no",
      "bh.version_no",
      "bh.item_id",
      "bh.approved_at",
      "i.name as item_name",
      "i.code as item_code",
    )
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .where("bh.status", "APPROVED")
    .andWhere("bh.level", normalizedLevel)
    .orderBy([
      { column: "bh.item_id", order: "asc" },
      { column: "bh.version_no", order: "desc" },
    ]);
  if (lifecycleSupported) query = query.andWhere("bh.is_active", true);
  const normalizedExclude = toNumberOrNull(excludeItemId);
  if (normalizedExclude)
    query = query.andWhereNot("bh.item_id", normalizedExclude);
  const rows = await query;
  return (rows || []).sort((a, b) =>
    String(a.item_name || "").localeCompare(String(b.item_name || "")),
  );
};

const loadSkuVariantAttrs = async (knex, itemIds, locale = "en") => {
  const map = new Map();
  const normalizedIds = [
    ...new Set((itemIds || []).map((id) => toNumberOrNull(id)).filter(Boolean)),
  ];
  if (!normalizedIds.length) return map;
  const useUr = locale === "ur";
  const rows = await knex("erp.skus as s")
    .select(
      "s.id",
      "s.sku_code",
      "v.item_id",
      "v.size_id",
      "v.grade_id",
      "v.color_id",
      "v.packing_type_id",
      useUr
        ? knex.raw("COALESCE(sz.name_ur, sz.name) as size_name")
        : "sz.name as size_name",
      useUr
        ? knex.raw("COALESCE(gr.name_ur, gr.name) as grade_name")
        : "gr.name as grade_name",
      useUr
        ? knex.raw("COALESCE(c.name_ur, c.name) as color_name")
        : "c.name as color_name",
      useUr
        ? knex.raw("COALESCE(pt.name_ur, pt.name) as packing_name")
        : "pt.name as packing_name",
    )
    .leftJoin("erp.variants as v", "s.variant_id", "v.id")
    .leftJoin("erp.sizes as sz", "sz.id", "v.size_id")
    .leftJoin("erp.grades as gr", "gr.id", "v.grade_id")
    .leftJoin("erp.colors as c", "c.id", "v.color_id")
    .leftJoin("erp.packing_types as pt", "pt.id", "v.packing_type_id")
    .whereIn("v.item_id", normalizedIds)
    .andWhere("s.is_active", true)
    .orderBy("s.sku_code", "asc");
  (rows || []).forEach((row) => {
    const itemId = toNumberOrNull(row.item_id);
    if (!itemId) return;
    if (!map.has(itemId)) map.set(itemId, []);
    map.get(itemId).push({
      sku_id: toNumberOrNull(row.id),
      sku_code: row.sku_code,
      size_id: toNumberOrNull(row.size_id),
      grade_id: toNumberOrNull(row.grade_id),
      color_id: toNumberOrNull(row.color_id),
      packing_type_id: toNumberOrNull(row.packing_type_id),
      size_name: row.size_name || null,
      grade_name: row.grade_name || null,
      color_name: row.color_name || null,
      packing_name: row.packing_name || null,
    });
  });
  return map;
};

// Pure mapping: source override lines -> target article SKUs by variant identity.
const mapSkuOverridesToTarget = ({
  overrides,
  sourceSkus,
  targetSkus,
  copiedRmComboSet,
}) => {
  const sourceById = new Map(
    (sourceSkus || []).map((sku) => [toNumberOrNull(sku.sku_id), sku]),
  );
  const targetsByVariantKey = new Map();
  (targetSkus || []).forEach((sku) => {
    const key = skuVariantKey(sku);
    if (!targetsByVariantKey.has(key)) targetsByVariantKey.set(key, []);
    targetsByVariantKey.get(key).push(sku);
  });

  const mapped = [];
  const skipped = [];
  const seenCombos = new Set();

  (overrides || []).forEach((line) => {
    const sourceSku = sourceById.get(toNumberOrNull(line.sku_id));
    const skuCode = sourceSku?.sku_code || `SKU ${line.sku_id}`;
    if (!sourceSku) {
      skipped.push({ sku_code: skuCode, line, reason: "no_matching_sku" });
      return;
    }
    const candidates = targetsByVariantKey.get(skuVariantKey(sourceSku)) || [];
    if (!candidates.length) {
      skipped.push({
        sku_code: skuCode,
        variant_label: skuVariantLabel(sourceSku),
        line,
        reason: "no_matching_sku",
      });
      return;
    }
    if (candidates.length > 1) {
      skipped.push({
        sku_code: skuCode,
        variant_label: skuVariantLabel(sourceSku),
        line,
        reason: "multiple_matching_skus",
      });
      return;
    }
    const target = candidates[0];
    const rmId = toNumberOrNull(line.target_rm_item_id);
    const deptId = toNumberOrNull(line.dept_id);
    if (
      copiedRmComboSet &&
      !copiedRmComboSet.has(`${rmId || 0}:${deptId || 0}`)
    ) {
      skipped.push({
        sku_code: skuCode,
        variant_label: skuVariantLabel(sourceSku),
        line,
        reason: "missing_rm_line",
      });
      return;
    }
    const comboKey = `${target.sku_id}:${rmId || 0}:${deptId || 0}`;
    if (seenCombos.has(comboKey)) {
      skipped.push({
        sku_code: skuCode,
        variant_label: skuVariantLabel(sourceSku),
        line,
        reason: "duplicate_after_mapping",
      });
      return;
    }
    seenCombos.add(comboKey);
    mapped.push({
      ...line,
      sku_id: target.sku_id,
      target_sku_code: target.sku_code,
    });
  });

  return { mapped, skipped };
};

const skipReasonLabel = (t, entry) => {
  const variant = entry.variant_label ? ` (${entry.variant_label})` : "";
  switch (entry.reason) {
    case "no_matching_sku":
      return `${entry.sku_code}${variant}: ${resolveText(t, "bom_copy_skip_no_matching_sku", "this article has no SKU with the same size/grade/color/packaging")}`;
    case "multiple_matching_skus":
      return `${entry.sku_code}${variant}: ${resolveText(t, "bom_copy_skip_multiple_matching_skus", "more than one SKU of this article matches — set values manually")}`;
    case "missing_rm_line":
      return `${entry.sku_code}${variant}: ${resolveText(t, "bom_copy_skip_missing_rm_line", "its raw-material line was not copied")}`;
    case "duplicate_after_mapping":
      return `${entry.sku_code}${variant}: ${resolveText(t, "bom_copy_skip_duplicate", "another source SKU already filled this value")}`;
    case "rm_inactive":
      return `${entry.label || ""}: ${resolveText(t, "bom_copy_skip_rm_inactive", "raw material is inactive")}`;
    case "fg_size_not_in_target":
      return `${entry.label || ""}: ${resolveText(t, "bom_copy_skip_fg_size", "this article does not come in that size")}`;
    case "no_sfg_link":
      return `${entry.label || ""}: ${resolveText(t, "bom_copy_skip_no_sfg_link", "this article has no linked semi-finished item")}`;
    case "no_matching_sfg_sku":
      return `${entry.label || ""}: ${resolveText(t, "bom_copy_skip_no_sfg_sku", "no semi-finished SKU with the same size was found for this article")}`;
    default:
      return `${entry.sku_code || entry.label || ""}`.trim() || "-";
  }
};

// Map source SFG consumption lines onto the target article's linked SFG items.
const mapSfgLinesToTarget = async (
  knex,
  { sfgLines, targetItem, targetSizeIdSet },
) => {
  const mapped = [];
  const skipped = [];
  if (!Array.isArray(sfgLines) || !sfgLines.length) return { mapped, skipped };

  const usageRows = await knex("erp.item_usage")
    .select("sfg_item_id")
    .where({ fg_item_id: targetItem.id });
  let targetSfgItemIds = (usageRows || [])
    .map((row) => toNumberOrNull(row.sfg_item_id))
    .filter(Boolean);
  if (!targetSfgItemIds.length) {
    // Legacy safety: infer linked SFG items from generated code pattern.
    const partType = String(targetItem.sfg_part_type || "")
      .trim()
      .toUpperCase();
    const suffixes =
      partType === "STEP"
        ? ["step"]
        : partType === "UPPER"
          ? ["upper"]
          : ["step", "upper"];
    const codes = suffixes.map((suffix) =>
      `${String(targetItem.code || "").trim()}_${suffix}`.toLowerCase(),
    );
    const inferredRows = await knex("erp.items")
      .select("id")
      .whereRaw("lower(trim(code)) = ANY(?)", [codes])
      .andWhere("item_type", "SFG")
      .andWhere("is_active", true);
    targetSfgItemIds = (inferredRows || [])
      .map((row) => toNumberOrNull(row.id))
      .filter(Boolean);
  }

  const sourceSkuIds = [
    ...new Set(
      sfgLines.map((line) => toNumberOrNull(line.sfg_sku_id)).filter(Boolean),
    ),
  ];
  const sourceSkuRows = sourceSkuIds.length
    ? await knex("erp.skus as s")
        .select(
          "s.id",
          "s.sku_code",
          "v.item_id",
          "v.size_id",
          "i.code as item_code",
        )
        .leftJoin("erp.variants as v", "s.variant_id", "v.id")
        .leftJoin("erp.items as i", "v.item_id", "i.id")
        .whereIn("s.id", sourceSkuIds)
    : [];
  const sourceSkuById = new Map(
    sourceSkuRows.map((row) => [toNumberOrNull(row.id), row]),
  );

  const targetSfgSkuRows = targetSfgItemIds.length
    ? await knex("erp.skus as s")
        .select(
          "s.id",
          "s.sku_code",
          "v.item_id",
          "v.size_id",
          "i.code as item_code",
        )
        .leftJoin("erp.variants as v", "s.variant_id", "v.id")
        .leftJoin("erp.items as i", "v.item_id", "i.id")
        .whereIn("v.item_id", targetSfgItemIds)
        .andWhere("s.is_active", true)
    : [];

  const suffixOf = (code) => {
    const normalized = String(code || "")
      .trim()
      .toLowerCase();
    const idx = normalized.lastIndexOf("_");
    return idx >= 0 ? normalized.slice(idx + 1) : "";
  };

  sfgLines.forEach((line) => {
    const sourceSku = sourceSkuById.get(toNumberOrNull(line.sfg_sku_id));
    const label = sourceSku?.sku_code || `SFG SKU ${line.sfg_sku_id}`;
    const fgSizeId = toNumberOrNull(line.fg_size_id);
    if (fgSizeId && targetSizeIdSet && !targetSizeIdSet.has(fgSizeId)) {
      skipped.push({ label, line, reason: "fg_size_not_in_target" });
      return;
    }
    if (!targetSfgItemIds.length) {
      skipped.push({ label, line, reason: "no_sfg_link" });
      return;
    }
    if (!sourceSku) {
      skipped.push({ label, line, reason: "no_matching_sfg_sku" });
      return;
    }
    const sourceSuffix = suffixOf(sourceSku.item_code);
    let candidates = targetSfgSkuRows.filter(
      (row) =>
        toNumberOrNull(row.size_id) === toNumberOrNull(sourceSku.size_id),
    );
    if (candidates.length > 1 && sourceSuffix) {
      const bySuffix = candidates.filter(
        (row) => suffixOf(row.item_code) === sourceSuffix,
      );
      if (bySuffix.length) candidates = bySuffix;
    }
    if (candidates.length !== 1) {
      skipped.push({ label, line, reason: "no_matching_sfg_sku" });
      return;
    }
    mapped.push({
      fg_size_id: line.fg_size_id,
      sfg_sku_id: candidates[0].id,
      required_qty: line.required_qty,
      uom_id: line.uom_id,
      consumed_in_stage_id: line.consumed_in_stage_id,
      // Recomputed server-side at save time.
      ref_approved_bom_id: null,
    });
  });

  return { mapped, skipped };
};

const buildCopyPayload = async (
  knex,
  { sourceBomId, targetItemId, targetLevel, sections, t, locale = "en" },
) => {
  const normalizedLevel = String(targetLevel || "").toUpperCase();
  const normalizedSections = new Set(
    String(sections || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => COPY_SECTIONS.has(entry)),
  );
  const sourceId = toNumberOrNull(sourceBomId);
  const targetId = toNumberOrNull(targetItemId);
  const invalidMessage = resolveText(
    t,
    "bom_copy_invalid_source",
    "This BOM cannot be copied from. Pick an approved BOM of another article at the same level.",
  );
  if (
    !sourceId ||
    !targetId ||
    !BOM_LEVELS.has(normalizedLevel) ||
    !normalizedSections.size
  )
    throw makeCopyError(invalidMessage);

  const source = await knex("erp.bom_header as bh")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.version_no",
      "bh.item_id",
      "bh.level",
      "bh.status",
      "i.name as item_name",
      "i.code as item_code",
    )
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .where("bh.id", sourceId)
    .first();
  if (
    !source ||
    source.status !== "APPROVED" ||
    String(source.level || "").toUpperCase() !== normalizedLevel ||
    toNumberOrNull(source.item_id) === targetId
  )
    throw makeCopyError(invalidMessage);

  const expectedItemType = normalizedLevel === "FINISHED" ? "FG" : "SFG";
  const targetItem = await knex("erp.items")
    .select("id", "name", "code", "item_type", "uses_sfg", "sfg_part_type")
    .where({ id: targetId })
    .first();
  if (
    !targetItem ||
    String(targetItem.item_type || "").toUpperCase() !== expectedItemType
  )
    throw makeCopyError(invalidMessage);

  const [rmLines, sfgLines, stageRoutes, skuOverrides] = await Promise.all([
    knex("erp.bom_rm_line")
      .select(
        "rm_item_id",
        "color_id",
        "size_id",
        "dept_id",
        "qty",
        "uom_id",
        "normal_loss_pct",
      )
      .where({ bom_id: sourceId })
      .orderBy("id", "asc"),
    knex("erp.bom_sfg_line")
      .select(
        "fg_size_id",
        "sfg_sku_id",
        "required_qty",
        "uom_id",
        "consumed_in_stage_id",
      )
      .where({ bom_id: sourceId })
      .orderBy("id", "asc"),
    knex("erp.bom_stage_routing as bsr")
      .leftJoin("erp.production_stages as ps", "ps.id", "bsr.stage_id")
      .select(
        "bsr.stage_id",
        "bsr.sequence_no",
        "bsr.is_required",
        "bsr.enforce_sequence",
        "ps.dept_id",
      )
      .where({ "bsr.bom_id": sourceId })
      .orderBy("bsr.sequence_no", "asc"),
    knex("erp.bom_sku_override_line")
      .select(
        "sku_id",
        "target_rm_item_id",
        "dept_id",
        "is_excluded",
        "override_qty",
        "override_uom_id",
        "replacement_rm_item_id",
        "rm_color_id",
        "rm_size_id",
        "notes",
      )
      .where({ bom_id: sourceId })
      .orderBy("id", "asc"),
  ]);

  const lines = { rm_lines: [], sku_overrides: [], sfg_lines: [], stage_routes: [] };
  const report = {};
  const makeSectionReport = (total, copiedRows, skippedEntries) => ({
    total,
    copied: copiedRows.length,
    skipped: skippedEntries.map((entry) => ({
      label: skipReasonLabel(t, entry),
      reason: entry.reason,
    })),
  });

  // Always computed from the source's own RM lines (not gated by whether the
  // "rm" section is being copied in this operation) so a "SKU rules only"
  // copy still validates overrides against real rm+dept combos rather than
  // silently letting every override through unchecked.
  const rmItemIds = [
    ...new Set(
      rmLines.map((line) => toNumberOrNull(line.rm_item_id)).filter(Boolean),
    ),
  ];
  const rmItems = rmItemIds.length
    ? await knex("erp.items")
        .select("id", "name", "is_active")
        .whereIn("id", rmItemIds)
    : [];
  const rmItemById = new Map(
    rmItems.map((row) => [toNumberOrNull(row.id), row]),
  );
  const activeRmLines = rmLines.filter((line) => {
    const item = rmItemById.get(toNumberOrNull(line.rm_item_id));
    return !(item && item.is_active === false);
  });
  const copiedRmComboSet = new Set(
    activeRmLines.map(
      (line) =>
        `${toNumberOrNull(line.rm_item_id) || 0}:${toNumberOrNull(line.dept_id) || 0}`,
    ),
  );

  if (normalizedSections.has("rm")) {
    const skippedRm = rmLines
      .filter((line) => {
        const item = rmItemById.get(toNumberOrNull(line.rm_item_id));
        return item && item.is_active === false;
      })
      .map((line) => ({
        label: rmItemById.get(toNumberOrNull(line.rm_item_id))?.name || `Item ${line.rm_item_id}`,
        reason: "rm_inactive",
      }));
    lines.rm_lines = activeRmLines;
    report.rm_lines = makeSectionReport(rmLines.length, lines.rm_lines, skippedRm);
  }

  if (normalizedSections.has("stage_routes")) {
    lines.stage_routes = stageRoutes.filter((row) =>
      toNumberOrNull(row.stage_id),
    );
    report.stage_routes = makeSectionReport(
      stageRoutes.length,
      lines.stage_routes,
      [],
    );
  }

  if (normalizedSections.has("sku_overrides")) {
    const skuAttrMap = await loadSkuVariantAttrs(
      knex,
      [source.item_id, targetId],
      locale,
    );
    const { mapped, skipped } = mapSkuOverridesToTarget({
      overrides: skuOverrides,
      sourceSkus: skuAttrMap.get(toNumberOrNull(source.item_id)) || [],
      targetSkus: skuAttrMap.get(targetId) || [],
      copiedRmComboSet,
    });
    lines.sku_overrides = mapped;
    report.sku_overrides = makeSectionReport(skuOverrides.length, mapped, skipped);
  }

  if (normalizedSections.has("sfg")) {
    const targetSizeRows = await knex("erp.variants")
      .distinct("size_id")
      .where({ item_id: targetId, is_active: true })
      .whereNotNull("size_id");
    const targetSizeIdSet = new Set(
      (targetSizeRows || [])
        .map((row) => toNumberOrNull(row.size_id))
        .filter(Boolean),
    );
    const { mapped, skipped } = await mapSfgLinesToTarget(knex, {
      sfgLines,
      targetItem,
      targetSizeIdSet,
    });
    lines.sfg_lines = mapped;
    report.sfg_lines = makeSectionReport(sfgLines.length, mapped, skipped);
  }

  return {
    source: {
      bom_id: toNumberOrNull(source.id),
      bom_no: source.bom_no,
      version_no: toNumberOrNull(source.version_no),
      item_id: toNumberOrNull(source.item_id),
      item_name: source.item_name,
      item_code: source.item_code,
    },
    lines,
    report,
  };
};

// Resolves human-readable names and attaches a `_label` string to every row
// of a normalized BOM snapshot so preview screens don't need raw ID lookups.
const hydrateBomSnapshotForPreview = async (knex, snapshot, locale = "en") => {
  const useUr = locale === "ur";
  const safe = snapshot && typeof snapshot === "object" ? snapshot : {};
  const rmLines = Array.isArray(safe.rm_lines) ? safe.rm_lines : [];
  const sfgLines = Array.isArray(safe.sfg_lines) ? safe.sfg_lines : [];
  const stageRoutes = Array.isArray(safe.stage_routes) ? safe.stage_routes : [];
  const skuOverrides = Array.isArray(safe.sku_overrides) ? safe.sku_overrides : [];

  const itemIds = new Set();
  const deptIds = new Set();
  const stageIds = new Set();
  const sizeIds = new Set();
  const colorIds = new Set();
  const skuIds = new Set();
  const collect = (set, value) => {
    const num = toNumberOrNull(value);
    if (num) set.add(num);
  };

  rmLines.forEach((r) => {
    collect(itemIds, r.rm_item_id);
    collect(deptIds, r.dept_id);
    collect(sizeIds, r.size_id);
    collect(colorIds, r.color_id);
  });
  skuOverrides.forEach((r) => {
    collect(itemIds, r.target_rm_item_id);
    collect(itemIds, r.replacement_rm_item_id);
    collect(deptIds, r.dept_id);
    collect(skuIds, r.sku_id);
    collect(colorIds, r.rm_color_id);
    collect(sizeIds, r.rm_size_id);
  });
  sfgLines.forEach((r) => {
    collect(skuIds, r.sfg_sku_id);
    collect(sizeIds, r.fg_size_id);
    collect(stageIds, r.consumed_in_stage_id);
  });
  stageRoutes.forEach((r) => {
    collect(stageIds, r.stage_id);
    collect(deptIds, r.dept_id);
  });

  const nameCol = (col) =>
    useUr ? knex.raw(`COALESCE(${col}_ur, ${col}) as name`) : `${col} as name`;
  const [items, depts, stages, sizes, colors, skus] = await Promise.all([
    itemIds.size ? knex("erp.items").select("id", "name").whereIn("id", [...itemIds]) : [],
    deptIds.size
      ? knex("erp.departments").select("id", nameCol("name")).whereIn("id", [...deptIds])
      : [],
    stageIds.size
      ? knex("erp.production_stages").select("id", nameCol("name")).whereIn("id", [...stageIds])
      : [],
    sizeIds.size
      ? knex("erp.sizes").select("id", nameCol("name")).whereIn("id", [...sizeIds])
      : [],
    colorIds.size
      ? knex("erp.colors").select("id", nameCol("name")).whereIn("id", [...colorIds])
      : [],
    skuIds.size ? knex("erp.skus").select("id", "sku_code").whereIn("id", [...skuIds]) : [],
  ]);
  const nameMap = (rows, key = "name") =>
    new Map(rows.map((r) => [toNumberOrNull(r.id), r[key]]));
  const itemName = nameMap(items);
  const deptName = nameMap(depts);
  const stageName = nameMap(stages);
  const sizeName = nameMap(sizes);
  const colorName = nameMap(colors);
  const skuCode = nameMap(skus, "sku_code");

  return {
    header: safe.header || {},
    rm_lines: rmLines.map((r) => ({
      ...r,
      _label: [
        itemName.get(toNumberOrNull(r.rm_item_id)) || `#${r.rm_item_id}`,
        colorName.get(toNumberOrNull(r.color_id)),
        sizeName.get(toNumberOrNull(r.size_id)),
        deptName.get(toNumberOrNull(r.dept_id)),
      ]
        .filter(Boolean)
        .join(" / "),
    })),
    sfg_lines: sfgLines.map((r) => ({
      ...r,
      _label: [
        sizeName.get(toNumberOrNull(r.fg_size_id)),
        skuCode.get(toNumberOrNull(r.sfg_sku_id)) || `#${r.sfg_sku_id}`,
        stageName.get(toNumberOrNull(r.consumed_in_stage_id)),
      ]
        .filter(Boolean)
        .join(" / "),
    })),
    stage_routes: stageRoutes.map((r) => ({
      ...r,
      _label: [
        stageName.get(toNumberOrNull(r.stage_id)) || `#${r.stage_id}`,
        deptName.get(toNumberOrNull(r.dept_id)),
      ]
        .filter(Boolean)
        .join(" / "),
    })),
    sku_overrides: skuOverrides.map((r) => ({
      ...r,
      _label: [
        skuCode.get(toNumberOrNull(r.sku_id)) || `#${r.sku_id}`,
        itemName.get(toNumberOrNull(r.target_rm_item_id)) || `#${r.target_rm_item_id}`,
        deptName.get(toNumberOrNull(r.dept_id)),
      ]
        .filter(Boolean)
        .join(" / "),
    })),
  };
};

const rowsEqualIgnoring = (a, b, ignoreKeys) => {
  const strip = (row) => {
    const clone = { ...row };
    (ignoreKeys || []).forEach((key) => delete clone[key]);
    return clone;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

// Compares a pending/draft BOM against the approved BOM it was copied from,
// classifying each current line as copied-as-is, edited-after-copy, or new.
const buildCopyComparison = async (knex, { bomId, locale = "en" }) => {
  const bomRow = await knex("erp.bom_header")
    .select("id", "copied_from_bom_id")
    .where({ id: bomId })
    .first();
  const sourceBomId = toNumberOrNull(bomRow?.copied_from_bom_id);
  if (!sourceBomId) return null;

  const [currentRaw, sourceRaw] = await Promise.all([
    bomService.getBomSnapshot(knex, bomId),
    bomService.getBomSnapshot(knex, sourceBomId),
  ]);
  if (!currentRaw || !sourceRaw) return null;

  const current = bomService.buildApprovalSnapshot(currentRaw);
  const source = bomService.buildApprovalSnapshot(sourceRaw);

  const sourceHeaderRow = await knex("erp.bom_header as bh")
    .select("bh.bom_no", "bh.version_no", "bh.item_id", "i.name as item_name")
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .where({ "bh.id": sourceBomId })
    .first();

  const sections = {};
  ["rm_lines", "sfg_lines", "stage_routes"].forEach((sectionKey) => {
    const keyFn = keysBySection[sectionKey];
    const sourceMap = new Map((source[sectionKey] || []).map((row) => [keyFn(row), row]));
    const currentRows = current[sectionKey] || [];
    const matchedSourceKeys = new Set();
    const rows = currentRows.map((row) => {
      const key = keyFn(row);
      const srcRow = sourceMap.get(key);
      let origin = "added";
      if (srcRow) {
        matchedSourceKeys.add(key);
        origin = rowsEqualIgnoring(srcRow, row, []) ? "copied" : "edited";
      }
      return { row, origin };
    });
    const removedCount = [...sourceMap.keys()].filter((key) => !matchedSourceKeys.has(key)).length;
    sections[sectionKey] = { rows, removedCount };
  });

  // sku_overrides: current SKUs belong to a different article than the
  // source, so match by variant identity (size/grade/color/packing) rather
  // than raw sku_id.
  const skuAttrMap = await loadSkuVariantAttrs(
    knex,
    [current.header.item_id, source.header.item_id],
    locale,
  );
  const currentSkuById = new Map(
    (skuAttrMap.get(toNumberOrNull(current.header.item_id)) || []).map((sku) => [
      sku.sku_id,
      sku,
    ]),
  );
  // Group by variant key first so that a source article with two SKUs
  // sharing the same size/grade/color/packing (a real, observed case) is not
  // silently collapsed to whichever one happens to sort last - ambiguous
  // keys are left unresolved rather than matched to the wrong SKU.
  const sourceSkusByVariantKeyGroup = new Map();
  (skuAttrMap.get(toNumberOrNull(source.header.item_id)) || []).forEach((sku) => {
    const key = skuVariantKey(sku);
    if (!sourceSkusByVariantKeyGroup.has(key)) sourceSkusByVariantKeyGroup.set(key, []);
    sourceSkusByVariantKeyGroup.get(key).push(sku);
  });
  const sourceSkuByVariantKey = new Map();
  sourceSkusByVariantKeyGroup.forEach((skus, key) => {
    if (skus.length === 1) sourceSkuByVariantKey.set(key, skus[0]);
  });
  const sourceOverrideByKey = new Map(
    (source.sku_overrides || []).map((row) => [
      `${row.sku_id || 0}:${row.target_rm_item_id || 0}:${row.dept_id || 0}`,
      row,
    ]),
  );
  const matchedSourceOverrideKeys = new Set();
  const skuOverrideRows = (current.sku_overrides || []).map((row) => {
    const currentSku = currentSkuById.get(toNumberOrNull(row.sku_id));
    const sourceSku = currentSku ? sourceSkuByVariantKey.get(skuVariantKey(currentSku)) : null;
    if (!sourceSku) return { row, origin: "added" };
    const sourceKey = `${sourceSku.sku_id}:${row.target_rm_item_id || 0}:${row.dept_id || 0}`;
    const srcRow = sourceOverrideByKey.get(sourceKey);
    if (!srcRow) return { row, origin: "added" };
    matchedSourceOverrideKeys.add(sourceKey);
    const origin = rowsEqualIgnoring(srcRow, row, ["sku_id"]) ? "copied" : "edited";
    return { row, origin };
  });
  const skuOverrideRemovedCount = [...sourceOverrideByKey.keys()].filter(
    (key) => !matchedSourceOverrideKeys.has(key),
  ).length;
  sections.sku_overrides = { rows: skuOverrideRows, removedCount: skuOverrideRemovedCount };

  const hydrated = await hydrateBomSnapshotForPreview(
    knex,
    {
      header: current.header,
      rm_lines: sections.rm_lines.rows.map((entry) => entry.row),
      sfg_lines: sections.sfg_lines.rows.map((entry) => entry.row),
      stage_routes: sections.stage_routes.rows.map((entry) => entry.row),
      sku_overrides: sections.sku_overrides.rows.map((entry) => entry.row),
    },
    locale,
  );
  ["rm_lines", "sfg_lines", "stage_routes", "sku_overrides"].forEach((sectionKey) => {
    sections[sectionKey].rows.forEach((entry, idx) => {
      entry.label = hydrated[sectionKey][idx]?._label || "";
    });
  });

  return {
    source: {
      bom_id: sourceBomId,
      bom_no: sourceHeaderRow?.bom_no,
      version_no: toNumberOrNull(sourceHeaderRow?.version_no),
      item_name: sourceHeaderRow?.item_name,
    },
    sections,
  };
};

// Articles whose latest BOM was copied from any version of (itemId, level).
const listCopiedFromDependents = async (
  knex,
  { itemId, level, excludeBomId },
) => {
  const normalizedItemId = toNumberOrNull(itemId);
  const normalizedLevel = String(level || "").toUpperCase();
  if (!normalizedItemId || !BOM_LEVELS.has(normalizedLevel)) return [];
  const hasColumn = await knex.schema
    .withSchema("erp")
    .hasColumn("bom_header", "copied_from_bom_id")
    .catch(() => false);
  if (!hasColumn) return [];

  const sourceIdsQuery = knex("erp.bom_header")
    .select("id")
    .where({ item_id: normalizedItemId, level: normalizedLevel });

  let query = knex("erp.bom_header as bh")
    .distinctOn("bh.item_id")
    .select(
      "bh.id as bom_id",
      "bh.bom_no",
      "bh.version_no",
      "bh.status",
      "bh.item_id",
      "i.name as item_name",
      "i.code as item_code",
    )
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .whereIn("bh.copied_from_bom_id", sourceIdsQuery)
    .andWhereNot("bh.item_id", normalizedItemId)
    .orderBy([
      { column: "bh.item_id", order: "asc" },
      { column: "bh.version_no", order: "desc" },
    ]);
  const normalizedExcludeBomId = toNumberOrNull(excludeBomId);
  if (normalizedExcludeBomId)
    query = query.andWhereNot("bh.id", normalizedExcludeBomId);
  return query;
};

// Plain-language reminder shown to the approver when other articles' BOMs
// were copied from the BOM just approved — never mutates those BOMs.
const formatDependentsNotice = (dependents, t) => {
  if (!Array.isArray(dependents) || !dependents.length) return "";
  const value = typeof t === "function" ? t("bom_copied_dependents_notice_prefix") : "";
  const prefix =
    value && value !== "bom_copied_dependents_notice_prefix"
      ? value
      : "These articles' BOMs were copied from this one — review whether they need a new version:";
  const names = dependents
    .map((d) => d.item_name || d.item_code || `#${d.item_id}`)
    .join(", ");
  return `${prefix} ${names}`;
};

// Builds the post-approval notice message, appending a plain-language
// dependents reminder when one applies. Never throws: the dependents lookup
// is informational only, so a failure here must not turn an approval that
// already committed into a reported failure - it just falls back to the
// plain success message.
const buildApprovedNoticeMessage = async (
  knex,
  { itemId, level, excludeBomId, baseMessage, t },
) => {
  try {
    const dependents = await listCopiedFromDependents(knex, {
      itemId,
      level,
      excludeBomId,
    });
    const notice = formatDependentsNotice(dependents, t);
    const hasDependents = Boolean(notice);
    return {
      message: notice ? `${baseMessage} ${notice}` : baseMessage,
      hasDependents,
      reviewUrl: hasDependents
        ? `/master-data/bom/cascade?parent_item_id=${itemId}&level=${level}&parent_bom_id=${excludeBomId}`
        : null,
    };
  } catch (err) {
    return { message: baseMessage, hasDependents: false, reviewUrl: null };
  }
};

module.exports = {
  listApprovedCopySources,
  loadSkuVariantAttrs,
  mapSkuOverridesToTarget,
  mapSfgLinesToTarget,
  buildCopyPayload,
  buildCopyComparison,
  hydrateBomSnapshotForPreview,
  listCopiedFromDependents,
  formatDependentsNotice,
  buildApprovedNoticeMessage,
  skuVariantKey,
};
