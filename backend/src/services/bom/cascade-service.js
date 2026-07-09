const bomService = require("./service");
const bomCopyService = require("./copy-service");
const { keysBySection, buildChangeRows, insertBomChangeLog } = require("../../utils/bom-change-log");

const toNumberOrNull = (value) => {
  if (value === null || typeof value === "undefined" || value === "")
    return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const makeCascadeError = (message, code) => {
  const err = new Error(message);
  err.code = code || "BOM_CASCADE_INVALID";
  return err;
};

const rowsEqualIgnoring = (a, b, ignoreFields) => {
  const strip = (row) => {
    const clone = { ...row };
    (ignoreFields || []).forEach((field) => delete clone[field]);
    return clone;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

// Classifies the dependent's current rows against the source's rows at
// copy time, keyed by keyFn, ignoring the given fields for the
// copied-vs-edited equality check. Used instead of trusting
// buildCopyComparison's origin directly wherever a field is known to be
// intrinsic/recomputed per-BOM (bom_rm_line.qty) rather than carried
// verbatim from the copy, since such a field will almost always legitimately
// differ from the source without that meaning the user "edited" the row.
const computeLocalOrigin = ({ currentRows, sourceRows, keyFn, ignoreFields = [] }) => {
  const sourceByKey = new Map((sourceRows || []).map((row) => [keyFn(row), row]));
  const matchedKeys = new Set();
  const rows = (currentRows || []).map((row) => {
    const key = keyFn(row);
    const srcRow = sourceByKey.get(key);
    if (!srcRow) return { row, origin: "added" };
    matchedKeys.add(key);
    const origin = rowsEqualIgnoring(srcRow, row, ignoreFields) ? "copied" : "edited";
    return { row, origin };
  });
  const removedCount = [...sourceByKey.keys()].filter((key) => !matchedKeys.has(key)).length;
  return { rows, removedCount };
};

// Diffs two versions of the SAME article's BOM (article-agnostic keys, since
// rm_item_id/dept_id/stage_id/labour_id are shared master data and sku_id is
// meaningful because both sides belong to the same article). NOT valid for
// comparing across two different articles - see diffParentSfgByFgSize and
// the variant-identity remapping used for sku_overrides below.
const diffParentVersions = async (knex, { oldBomId, newBomId }) => {
  const [oldSnapshotRaw, newSnapshotRaw] = await Promise.all([
    bomService.getBomSnapshot(knex, oldBomId),
    bomService.getBomSnapshot(knex, newBomId),
  ]);
  const oldSnapshot = bomService.buildApprovalSnapshot(oldSnapshotRaw || {});
  const newSnapshot = bomService.buildApprovalSnapshot(newSnapshotRaw || {});

  const sections = {};
  ["rm_lines", "stage_routes", "sku_overrides"].forEach((section) => {
    sections[section] = buildChangeRows({
      bomId: null,
      versionNo: null,
      requestId: null,
      changedBy: null,
      section,
      beforeRows: oldSnapshot[section] || [],
      afterRows: newSnapshot[section] || [],
    });
  });

  return { oldBomId, newBomId, oldSnapshot, newSnapshot, sections };
};

// sfg_lines needs a dedicated diff: mapSfgLinesToTarget (copy-service.js)
// remaps sfg_sku_id to the TARGET article's own linked SFG SKU at copy time,
// so a dependent's byte-for-byte-unedited SFG line legitimately has a
// different sfg_sku_id than the parent's row it came from. keysBySection's
// `fg_size_id:sfg_sku_id` key is only valid when comparing a BOM against
// itself (same article, both sides), which is exactly what this function
// does (parent's old version vs parent's new version) - so sfg_sku_id CAN
// be compared directly here. The fg_size_id-only key is used later, in
// classifySfgSection, specifically for the cross-article comparison against
// the dependent.
const diffParentSfgByFgSize = async (knex, { oldBomId, newBomId }) => {
  const [oldSnapshotRaw, newSnapshotRaw] = await Promise.all([
    bomService.getBomSnapshot(knex, oldBomId),
    bomService.getBomSnapshot(knex, newBomId),
  ]);
  const oldSnapshot = bomService.buildApprovalSnapshot(oldSnapshotRaw || {});
  const newSnapshot = bomService.buildApprovalSnapshot(newSnapshotRaw || {});

  const keyFn = (row) => String(toNumberOrNull(row.fg_size_id) || 0);
  const beforeMap = new Map((oldSnapshot.sfg_lines || []).map((row) => [keyFn(row), row]));
  const afterMap = new Map((newSnapshot.sfg_lines || []).map((row) => [keyFn(row), row]));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const rows = [];
  keys.forEach((entityKey) => {
    const before = beforeMap.get(entityKey) || null;
    const after = afterMap.get(entityKey) || null;
    if (before && !after) {
      rows.push({ entity_key: entityKey, change_type: "REMOVED", old_value: before, new_value: null });
      return;
    }
    if (!before && after) {
      rows.push({ entity_key: entityKey, change_type: "ADDED", old_value: null, new_value: after });
      return;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      rows.push({ entity_key: entityKey, change_type: "UPDATED", old_value: before, new_value: after });
    }
  });
  return rows;
};

const buildVariantKeyMaps = (skuAttrRows) => {
  const skuIdToVariantKey = new Map();
  const variantKeyToSkuIds = new Map();
  (skuAttrRows || []).forEach((sku) => {
    const key = bomCopyService.skuVariantKey(sku);
    skuIdToVariantKey.set(sku.sku_id, key);
    if (!variantKeyToSkuIds.has(key)) variantKeyToSkuIds.set(key, []);
    variantKeyToSkuIds.get(key).push(sku.sku_id);
  });
  return { skuIdToVariantKey, variantKeyToSkuIds };
};

// Translates a parent-article sku_id into the corresponding dependent-article
// sku_id by variant identity (size/grade/packing; colour ignored) - mirrors
// mapSkuOverridesToTarget's per-row resolution and reuses the same skip
// vocabulary, since an ambiguous or absent match must never be guessed.
const resolveDependentSkuOverrideTarget = (
  parentSkuId,
  { sourceSkuIdToVariantKey, dependentVariantKeyToSkuIds },
) => {
  const variantKey = sourceSkuIdToVariantKey.get(parentSkuId);
  if (!variantKey) return { skipped: "no_matching_sku" };
  const candidates = dependentVariantKeyToSkuIds.get(variantKey) || [];
  if (!candidates.length) return { skipped: "no_matching_sku" };
  if (candidates.length > 1) return { skipped: "multiple_matching_skus" };
  return { skuId: candidates[0] };
};

// Direct-key sections: rm_lines and stage_routes. rm_item_id/dept_id/
// stage_id are shared master data, so the parent's delta keys are directly
// comparable to the dependent's current rows via the same keysBySection
// function buildCopyComparison already used to compute origin.
const classifyDirectSection = ({ section, parentDeltaRows, depComparisonSection, rmActiveById }) => {
  const rows = depComparisonSection?.rows || [];
  const eligible = rows.some((entry) => entry.origin === "copied") || (depComparisonSection?.removedCount || 0) > 0;
  const allCurrentRows = rows.map((entry) => entry.row);
  if (!eligible) return { eligible: false, safe: [], conflicts: [], skipped: [], allCurrentRows };

  const keyFn = keysBySection[section];
  const depEntryByKey = new Map(rows.map((entry) => [keyFn(entry.row), entry]));

  const safe = [];
  const conflicts = [];
  const skipped = [];

  (parentDeltaRows || []).forEach((delta) => {
    const key = delta.entity_key;
    const depEntry = depEntryByKey.get(key);

    if (delta.change_type === "ADDED") {
      if (depEntry) return; // dependent already independently has this key
      if (section === "rm_lines" && rmActiveById) {
        const rmItem = rmActiveById.get(toNumberOrNull(delta.new_value?.rm_item_id));
        if (rmItem && rmItem.is_active === false) {
          skipped.push({ key, reason: "rm_inactive" });
          return;
        }
      }
      safe.push({ key, action: "add", parentValue: delta.new_value });
      return;
    }

    // UPDATED / REMOVED
    if (!depEntry) return; // dependent doesn't have this row anymore (already removed) - nothing to cascade
    if (depEntry.origin === "copied") {
      safe.push({
        key,
        action: delta.change_type === "REMOVED" ? "remove" : "update",
        parentValue: delta.new_value,
        dependentValue: depEntry.row,
      });
    } else {
      conflicts.push({
        key,
        action: delta.change_type === "REMOVED" ? "remove" : "update",
        parentValue: delta.new_value,
        dependentValue: depEntry.row,
      });
    }
  });

  return { eligible: true, safe, conflicts, skipped, allCurrentRows };
};

const classifySkuOverridesSection = ({
  parentDeltaRows,
  depComparisonSection,
  sourceSkuIdToVariantKey,
  dependentVariantKeyToSkuIds,
  copiedRmComboSet,
}) => {
  const rows = depComparisonSection?.rows || [];
  const eligible = rows.some((entry) => entry.origin === "copied") || (depComparisonSection?.removedCount || 0) > 0;
  const allCurrentRows = rows.map((entry) => entry.row);
  if (!eligible) return { eligible: false, safe: [], conflicts: [], skipped: [], allCurrentRows };

  const depEntryByKey = new Map(
    rows.map((entry) => [
      `${entry.row.sku_id || 0}:${entry.row.target_rm_item_id || 0}:${entry.row.dept_id || 0}`,
      entry,
    ]),
  );

  const safe = [];
  const conflicts = [];
  const skipped = [];

  (parentDeltaRows || []).forEach((delta) => {
    const [parentSkuIdStr, rmIdStr, deptIdStr] = String(delta.entity_key).split(":");
    const parentSkuId = toNumberOrNull(parentSkuIdStr);
    const resolved = resolveDependentSkuOverrideTarget(parentSkuId, {
      sourceSkuIdToVariantKey,
      dependentVariantKeyToSkuIds,
    });
    if (resolved.skipped) {
      skipped.push({ key: delta.entity_key, reason: resolved.skipped });
      return;
    }
    const dependentKey = `${resolved.skuId}:${rmIdStr}:${deptIdStr}`;
    const depEntry = depEntryByKey.get(dependentKey);

    if (delta.change_type === "ADDED") {
      if (depEntry) return;
      if (copiedRmComboSet && !copiedRmComboSet.has(`${rmIdStr}:${deptIdStr}`)) {
        skipped.push({ key: delta.entity_key, reason: "missing_rm_line" });
        return;
      }
      safe.push({
        key: dependentKey,
        action: "add",
        parentValue: { ...delta.new_value, sku_id: resolved.skuId },
      });
      return;
    }

    if (!depEntry) return;
    if (depEntry.origin === "copied") {
      safe.push({
        key: dependentKey,
        action: delta.change_type === "REMOVED" ? "remove" : "update",
        parentValue: delta.new_value ? { ...delta.new_value, sku_id: resolved.skuId } : null,
        dependentValue: depEntry.row,
      });
    } else {
      conflicts.push({
        key: dependentKey,
        action: delta.change_type === "REMOVED" ? "remove" : "update",
        parentValue: delta.new_value ? { ...delta.new_value, sku_id: resolved.skuId } : null,
        dependentValue: depEntry.row,
      });
    }
  });

  return { eligible: true, safe, conflicts, skipped, allCurrentRows };
};

// sfg_lines compared cross-article: key on fg_size_id alone (see
// diffParentSfgByFgSize), and for a parent-added fg_size_id resolve the
// dependent's own linked SFG SKU via mapSfgLinesToTarget (single-row reuse
// of the same logic the original copy feature already uses).
const classifySfgSection = async (knex, {
  parentDeltaRows,
  sfgOriginRows,
  sfgRemovedCount,
  dependentItem,
  dependentSizeIdSet,
}) => {
  const eligible = sfgOriginRows.some((entry) => entry.origin === "copied") || sfgRemovedCount > 0;
  const allCurrentRows = sfgOriginRows.map((entry) => entry.row);
  if (!eligible) return { eligible: false, safe: [], conflicts: [], skipped: [], allCurrentRows };

  const depEntryByFgSize = new Map(
    sfgOriginRows.map((entry) => [String(toNumberOrNull(entry.row.fg_size_id) || 0), entry]),
  );

  const safe = [];
  const conflicts = [];
  const skipped = [];

  const addedDeltaRows = (parentDeltaRows || []).filter((delta) => delta.change_type === "ADDED");
  let mappedAdds = { mapped: [], skipped: [] };
  if (addedDeltaRows.length) {
    mappedAdds = await bomCopyService.mapSfgLinesToTarget(knex, {
      sfgLines: addedDeltaRows.map((delta) => delta.new_value),
      targetItem: dependentItem,
      targetSizeIdSet: dependentSizeIdSet,
    });
  }
  const mappedAddByFgSize = new Map(
    mappedAdds.mapped.map((row) => [String(toNumberOrNull(row.fg_size_id) || 0), row]),
  );

  (parentDeltaRows || []).forEach((delta) => {
    const key = delta.entity_key;
    const depEntry = depEntryByFgSize.get(key);

    if (delta.change_type === "ADDED") {
      if (depEntry) return;
      const mapped = mappedAddByFgSize.get(key);
      if (!mapped) {
        skipped.push({ key, reason: "no_matching_sfg_sku" });
        return;
      }
      safe.push({ key, action: "add", parentValue: mapped });
      return;
    }

    if (!depEntry) return;
    if (depEntry.origin === "copied") {
      safe.push({
        key,
        action: delta.change_type === "REMOVED" ? "remove" : "update",
        parentValue: delta.new_value,
        dependentValue: depEntry.row,
      });
    } else {
      conflicts.push({
        key,
        action: delta.change_type === "REMOVED" ? "remove" : "update",
        parentValue: delta.new_value,
        dependentValue: depEntry.row,
      });
    }
  });

  return { eligible: true, safe, conflicts, skipped, allCurrentRows };
};

// The central 3-way merge: for a dependent's latest APPROVED BOM, works out
// which of the parent's changes (between the version the dependent was
// copied from and parentNewBomId) are safe to auto-apply vs must be flagged
// as a conflict, per section. Never mutates anything - read-only planning.
const computeDependentMergePlan = async (knex, { dependentApprovedBomId, parentNewBomId, locale = "en" }) => {
  const depHeader = await knex("erp.bom_header")
    .select("id", "item_id", "level", "copied_from_bom_id")
    .where({ id: dependentApprovedBomId })
    .first();
  if (!depHeader) return { eligible: false, reason: "dependent_not_found" };

  const oldParentBomId = toNumberOrNull(depHeader.copied_from_bom_id);
  if (!oldParentBomId) return { eligible: false, reason: "not_a_copy" };

  const [parentDelta, sfgDeltaRows, depComparison] = await Promise.all([
    diffParentVersions(knex, { oldBomId: oldParentBomId, newBomId: parentNewBomId }),
    diffParentSfgByFgSize(knex, { oldBomId: oldParentBomId, newBomId: parentNewBomId }),
    bomCopyService.buildCopyComparison(knex, { bomId: dependentApprovedBomId, locale }),
  ]);
  if (!depComparison) return { eligible: false, reason: "no_comparison_available" };

  const depSnapshotRaw = await bomService.getBomSnapshot(knex, dependentApprovedBomId);
  const depSnapshot = bomService.buildApprovalSnapshot(depSnapshotRaw || {});

  // Dependent SFG origin, keyed on fg_size_id only (cross-article safe) and
  // ignoring sfg_sku_id as a value (the target's own linked SFG SKU differs
  // from the source's by design - see diffParentSfgByFgSize) - computed
  // locally rather than trusting depComparison.sections.sfg_lines.
  const sourceOldSnapshot = parentDelta.oldSnapshot;
  const sfgKeyFn = (row) => String(toNumberOrNull(row.fg_size_id) || 0);
  const { rows: sfgOriginRows, removedCount: sfgRemovedCount } = computeLocalOrigin({
    currentRows: depSnapshot.sfg_lines,
    sourceRows: sourceOldSnapshot.sfg_lines,
    keyFn: sfgKeyFn,
    ignoreFields: ["sfg_sku_id"],
  });

  // Dependent RM-line origin, ignoring qty (always intrinsic/recomputed per-
  // BOM from that BOM's own SKU-rule aggregation - service.js:1122-1137 -
  // so it legitimately differs from the source even when nothing structural
  // was edited). Computed locally rather than trusting
  // depComparison.sections.rm_lines, which does a full row-equality check.
  const rmLinesOrigin = computeLocalOrigin({
    currentRows: depSnapshot.rm_lines,
    sourceRows: sourceOldSnapshot.rm_lines,
    keyFn: keysBySection.rm_lines,
    ignoreFields: ["qty"],
  });

  // Variant-identity maps for sku_overrides remapping.
  const skuAttrMap = await bomCopyService.loadSkuVariantAttrs(knex, [
    sourceOldSnapshot.header.item_id,
    depSnapshot.header.item_id,
  ]);
  const { skuIdToVariantKey: sourceSkuIdToVariantKey } = buildVariantKeyMaps(
    skuAttrMap.get(toNumberOrNull(sourceOldSnapshot.header.item_id)) || [],
  );
  const { variantKeyToSkuIds: dependentVariantKeyToSkuIds } = buildVariantKeyMaps(
    skuAttrMap.get(toNumberOrNull(depSnapshot.header.item_id)) || [],
  );

  const dependentItemRow = await knex("erp.items")
    .select("id", "code", "sfg_part_type")
    .where({ id: depHeader.item_id })
    .first();
  const dependentSizeRows = await knex("erp.variants")
    .distinct("size_id")
    .where({ item_id: depHeader.item_id, is_active: true })
    .whereNotNull("size_id");
  const dependentSizeIdSet = new Set(
    dependentSizeRows.map((row) => toNumberOrNull(row.size_id)).filter(Boolean),
  );

  const dependentRmItemIds = [
    ...new Set((depSnapshot.rm_lines || []).map((line) => toNumberOrNull(line.rm_item_id)).filter(Boolean)),
  ];
  const rmItems = dependentRmItemIds.length
    ? await knex("erp.items").select("id", "name", "is_active").whereIn("id", dependentRmItemIds)
    : [];
  const rmActiveById = new Map(rmItems.map((row) => [toNumberOrNull(row.id), row]));
  const copiedRmComboSet = new Set(
    (depSnapshot.rm_lines || []).map(
      (line) => `${toNumberOrNull(line.rm_item_id) || 0}:${toNumberOrNull(line.dept_id) || 0}`,
    ),
  );

  const sections = {};
  sections.rm_lines = classifyDirectSection({
    section: "rm_lines",
    parentDeltaRows: parentDelta.sections.rm_lines,
    depComparisonSection: rmLinesOrigin,
    rmActiveById,
  });
  sections.stage_routes = classifyDirectSection({
    section: "stage_routes",
    parentDeltaRows: parentDelta.sections.stage_routes,
    depComparisonSection: depComparison.sections.stage_routes,
  });

  // A material line and its matching SKU override can arrive in the same
  // cascade (the parent added both together) - the "missing_rm_line" check
  // must account for RM combos being safely added in this operation, not
  // just the ones the dependent already has.
  const combinedRmComboSet = new Set(copiedRmComboSet);
  (sections.rm_lines.safe || []).forEach((entry) => {
    if (entry.action !== "add") return;
    combinedRmComboSet.add(
      `${toNumberOrNull(entry.parentValue.rm_item_id) || 0}:${toNumberOrNull(entry.parentValue.dept_id) || 0}`,
    );
  });

  sections.sku_overrides = classifySkuOverridesSection({
    parentDeltaRows: parentDelta.sections.sku_overrides,
    depComparisonSection: depComparison.sections.sku_overrides,
    sourceSkuIdToVariantKey,
    dependentVariantKeyToSkuIds,
    copiedRmComboSet: combinedRmComboSet,
  });
  sections.sfg_lines = await classifySfgSection(knex, {
    parentDeltaRows: sfgDeltaRows,
    sfgOriginRows,
    sfgRemovedCount,
    dependentItem: dependentItemRow,
    dependentSizeIdSet,
  });

  await hydratePlanLabels(knex, sections, locale);

  const hasAnyApplicableChange = Object.values(sections).some((section) => (section.safe || []).length > 0);
  const hasAnyConflict = Object.values(sections).some((section) => (section.conflicts || []).length > 0);

  return {
    eligible: true,
    dependent: { bom_id: dependentApprovedBomId, item_id: depHeader.item_id, level: depHeader.level },
    parent: { oldBomId: oldParentBomId, newBomId: parentNewBomId },
    sections,
    hasAnyApplicableChange,
    hasAnyConflict,
  };
};

// Attaches a human-readable `.label` to every safe/conflict/skipped entry's
// parentValue and dependentValue, reusing hydrateBomSnapshotForPreview's
// name-resolution rather than duplicating ID->name lookups here. Two passes
// over the exact same nested structure/order: the first collects rows to
// hydrate, the second walks the (deterministic, unchanged) structure again
// to assign labels back via a per-section cursor.
const hydratePlanLabels = async (knex, sections, locale) => {
  const rowsBySection = { rm_lines: [], sfg_lines: [], stage_routes: [], sku_overrides: [] };
  const walk = (visit) => {
    Object.keys(sections).forEach((sectionKey) => {
      const section = sections[sectionKey];
      if (!section?.eligible) return;
      ["safe", "conflicts", "skipped"].forEach((bucket) => {
        (section[bucket] || []).forEach((entry) => {
          ["parentValue", "dependentValue"].forEach((field) => {
            if (entry[field]) visit(sectionKey, entry, field);
          });
        });
      });
    });
  };

  walk((sectionKey, entry, field) => rowsBySection[sectionKey].push(entry[field]));
  const hydrated = await bomCopyService.hydrateBomSnapshotForPreview(knex, rowsBySection, locale);

  const cursors = { rm_lines: 0, sfg_lines: 0, stage_routes: 0, sku_overrides: 0 };
  walk((sectionKey, entry, field) => {
    const idx = cursors[sectionKey]++;
    entry[`${field}Label`] = hydrated[sectionKey]?.[idx]?._label || "";
  });
};

// Pure. Starts from the dependent's current rows and applies only the
// user-selected subset of "safe" actions; every other row (edited, added by
// the user, or simply not selected) passes through completely untouched.
const buildCascadeMergedLines = ({ plan, selectedKeysBySection }) => {
  const sectionKeyFns = {
    rm_lines: keysBySection.rm_lines,
    stage_routes: keysBySection.stage_routes,
    sku_overrides: (row) => `${row.sku_id || 0}:${row.target_rm_item_id || 0}:${row.dept_id || 0}`,
    sfg_lines: (row) => String(toNumberOrNull(row.fg_size_id) || 0),
  };

  const merged = {};
  ["rm_lines", "stage_routes", "sku_overrides", "sfg_lines"].forEach((section) => {
    const keyFn = sectionKeyFns[section];
    const selectedKeys = new Set((selectedKeysBySection?.[section] || []).map(String));
    const safeByKey = new Map((plan.sections[section]?.safe || []).map((entry) => [String(entry.key), entry]));

    let rows = (plan.sections[section]?.allCurrentRows || []).slice();
    const removedKeys = new Set();

    rows = rows.map((row) => {
      const key = String(keyFn(row));
      if (!selectedKeys.has(key)) return row;
      const action = safeByKey.get(key);
      if (!action) return row;
      if (action.action === "remove") {
        removedKeys.add(key);
        return row;
      }
      if (action.action === "update") {
        if (section === "rm_lines") {
          // Structural fields only - qty stays intrinsic to the dependent's
          // own SKU-rule aggregation, never carried from the parent.
          return {
            ...row,
            rm_item_id: action.parentValue.rm_item_id,
            dept_id: action.parentValue.dept_id,
            color_id: action.parentValue.color_id ?? null,
            size_id: action.parentValue.size_id ?? null,
            uom_id: action.parentValue.uom_id,
            normal_loss_pct: action.parentValue.normal_loss_pct ?? row.normal_loss_pct,
          };
        }
        return { ...row, ...action.parentValue, sku_id: row.sku_id };
      }
      return row;
    });

    rows = rows.filter((row) => !removedKeys.has(String(keyFn(row))));

    selectedKeys.forEach((key) => {
      const action = safeByKey.get(key);
      if (!action || action.action !== "add") return;
      if (section === "rm_lines") {
        rows.push({ ...action.parentValue, qty: 0 });
      } else {
        rows.push({ ...action.parentValue });
      }
    });

    merged[section] = rows;
  });

  // Drop any sku_overrides whose (target_rm_item_id, dept_id) combo no
  // longer exists in the merged rm_lines, so a cascaded RM-line removal
  // never leaves a dangling override behind.
  const finalRmComboSet = new Set(
    merged.rm_lines.map(
      (line) => `${toNumberOrNull(line.rm_item_id) || 0}:${toNumberOrNull(line.dept_id) || 0}`,
    ),
  );
  merged.sku_overrides = merged.sku_overrides.filter((row) =>
    finalRmComboSet.has(`${toNumberOrNull(row.target_rm_item_id) || 0}:${toNumberOrNull(row.dept_id) || 0}`),
  );

  return merged;
};

const createCascadeDraftTx = async (trx, {
  dependentApprovedBomId,
  parentNewBomId,
  selectedKeysBySection,
  userId,
  requestId,
  t,
  locale = "en",
}) => {
  const depHeader = await trx("erp.bom_header")
    .select("item_id", "level")
    .where({ id: dependentApprovedBomId })
    .first();
  if (!depHeader) throw makeCascadeError(t ? t("error_not_found") : "Not found", "BOM_CASCADE_NOT_FOUND");

  const existingDraftId = await bomService.findDraftBomByItemLevel(trx, {
    itemId: depHeader.item_id,
    level: depHeader.level,
  });
  if (existingDraftId) {
    throw makeCascadeError(
      t
        ? t("bom_cascade_error_draft_exists")
        : "A draft already exists for this article. Resolve it before applying cascaded updates.",
      "BOM_CASCADE_DRAFT_EXISTS",
    );
  }

  const plan = await computeDependentMergePlan(trx, { dependentApprovedBomId, parentNewBomId, locale });
  if (!plan.eligible) {
    throw makeCascadeError(
      t ? t("bom_cascade_error_not_eligible") : "This BOM is not eligible for a cascaded update.",
      "BOM_CASCADE_NOT_ELIGIBLE",
    );
  }

  // Defense against a stale UI: never let a conflict key through, even if
  // the request body claims it's selected.
  const safeSelectedKeysBySection = {};
  let appliedCount = 0;
  Object.keys(plan.sections).forEach((section) => {
    const safeKeys = new Set((plan.sections[section].safe || []).map((entry) => String(entry.key)));
    const requested = (selectedKeysBySection?.[section] || []).map(String);
    const filtered = requested.filter((key) => safeKeys.has(key));
    safeSelectedKeysBySection[section] = filtered;
    appliedCount += filtered.length;
  });

  const skippedConflictCount = Object.values(plan.sections).reduce(
    (sum, section) => sum + (section.conflicts || []).length,
    0,
  );

  const { id: newBomId, versionNo, bomNo } = await bomService.createNewVersionFromApprovedTx(trx, {
    sourceBomId: dependentApprovedBomId,
    userId,
    t,
  });

  const before = await bomService.getBomSnapshot(trx, newBomId);
  const merged = buildCascadeMergedLines({ plan, selectedKeysBySection: safeSelectedKeysBySection });
  await bomService.replaceBomLines(trx, newBomId, merged);
  await trx("erp.bom_header").where({ id: newBomId }).update({ copied_from_bom_id: parentNewBomId });

  const after = await bomService.getBomSnapshot(trx, newBomId);
  await insertBomChangeLog(trx, {
    bomId: newBomId,
    versionNo,
    requestId: requestId || null,
    changedBy: userId || null,
    before,
    after,
  });

  return { id: newBomId, versionNo, bomNo, appliedCount, skippedConflictCount };
};

const createCascadeDraft = async (knex, params) =>
  knex.transaction((trx) => createCascadeDraftTx(trx, params));

// Listing-screen summary: for each dependent article, resolves its latest
// APPROVED bom + whether a draft is already in progress, then reduces
// computeDependentMergePlan to counts.
const listCascadeCandidates = async (knex, { itemId, level, parentNewBomId, excludeBomId }) => {
  const dependents = await bomCopyService.listCopiedFromDependents(knex, { itemId, level, excludeBomId });
  const results = [];

  for (const dependent of dependents) {
    const dependentItemId = toNumberOrNull(dependent.item_id);
    const approvedRow = await knex("erp.bom_header")
      .select("id", "version_no")
      .where({ item_id: dependentItemId, level, status: "APPROVED" })
      .orderBy("version_no", "desc")
      .first();
    const hasActiveDraft = Boolean(
      await bomService.findDraftBomByItemLevel(knex, { itemId: dependentItemId, level }),
    );

    if (!approvedRow) {
      results.push({
        item_id: dependentItemId,
        item_name: dependent.item_name,
        item_code: dependent.item_code,
        dependentApprovedBomId: null,
        hasActiveDraft,
        safeCount: 0,
        conflictCount: 0,
        upToDate: false,
        eligible: false,
      });
      continue;
    }

    const plan = await computeDependentMergePlan(knex, {
      dependentApprovedBomId: approvedRow.id,
      parentNewBomId,
    });
    const safeCount = plan.eligible
      ? Object.values(plan.sections).reduce((sum, section) => sum + (section.safe || []).length, 0)
      : 0;
    const conflictCount = plan.eligible
      ? Object.values(plan.sections).reduce((sum, section) => sum + (section.conflicts || []).length, 0)
      : 0;

    results.push({
      item_id: dependentItemId,
      item_name: dependent.item_name,
      item_code: dependent.item_code,
      dependentApprovedBomId: approvedRow.id,
      hasActiveDraft,
      safeCount,
      conflictCount,
      upToDate: plan.eligible && safeCount === 0 && conflictCount === 0,
      eligible: plan.eligible,
    });
  }

  return results;
};

module.exports = {
  diffParentVersions,
  diffParentSfgByFgSize,
  resolveDependentSkuOverrideTarget,
  computeDependentMergePlan,
  buildCascadeMergedLines,
  createCascadeDraft,
  createCascadeDraftTx,
  listCascadeCandidates,
};
