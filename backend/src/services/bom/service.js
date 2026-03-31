const { insertBomChangeLog } = require("../../utils/bom-change-log");

const debugEnabled = process.env.DEBUG_BOM === "1";
const debugBom = (...args) => {
  if (debugEnabled) console.log("[DEBUG][BOM]", ...args);
};

const BOM_LEVELS = new Set(["FINISHED", "SEMI_FINISHED"]);
const LABOUR_RATE_TYPES = new Set(["PER_DOZEN", "PER_PAIR"]);
const BOM_SCOPE = new Set(["ALL", "SPECIFIC"]);
const LABOUR_RATE_RULE_PRECEDENCE = {
  SKU: 1,
  SUBGROUP: 2,
  GROUP: 3,
  FLAT: 4,
};
let bomLifecycleColumnSupportPromise = null;

const toArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [value];
};

const toNumberOrNull = (value) => {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const toPositiveNumber = (value) => {
  const num = toNumberOrNull(value);
  if (num === null || num <= 0) return null;
  return num;
};

const toPositiveInt = (value) => {
  const num = toNumberOrNull(value);
  if (num === null || !Number.isInteger(num) || num <= 0) return null;
  return num;
};

const parseJsonArray = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return toArray(raw);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
};

const normalizeScope = (value) => {
  const text = String(value || "ALL").trim().toUpperCase();
  return BOM_SCOPE.has(text) ? text : "ALL";
};

const toSortedObject = (value) => {
  if (Array.isArray(value)) return value.map((entry) => toSortedObject(entry));
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = toSortedObject(value[key]);
        return acc;
      }, {});
  }
  return value;
};

const makeValidationError = (message, details = []) => {
  const err = new Error(message);
  err.code = "BOM_VALIDATION";
  err.details = details;
  return err;
};

const tableExists = async (db, tableName) => {
  try {
    const row = await db.raw("SELECT to_regclass(?) AS reg", [tableName]);
    const value = row?.rows?.[0]?.reg || row?.[0]?.reg || null;
    return Boolean(value);
  } catch (err) {
    return false;
  }
};

const ensureActiveStageMappingsByDepartment = async (db, deptIds, options = {}) => {
  const normalizedDeptIds = [...new Set(toArray(deptIds).map((id) => toPositiveInt(id)).filter(Boolean))];
  const stageIdByDeptId = new Map();
  if (!normalizedDeptIds.length) return stageIdByDeptId;

  const actorUserId = toPositiveInt(options?.actorUserId) || null;
  const stageRows = await db("erp.production_stages")
    .select("id", "dept_id", "is_active")
    .whereIn("dept_id", normalizedDeptIds)
    .orderBy("id", "desc");

  const inactiveStageIdByDeptId = new Map();
  const stageDeptIdByStageId = new Map();
  (stageRows || []).forEach((row) => {
    const deptId = toPositiveInt(row?.dept_id);
    const stageId = toPositiveInt(row?.id);
    if (!deptId || !stageId) return;
    stageDeptIdByStageId.set(stageId, deptId);
    if (row?.is_active === true) {
      if (!stageIdByDeptId.has(deptId)) stageIdByDeptId.set(deptId, stageId);
      return;
    }
    if (!inactiveStageIdByDeptId.has(deptId)) inactiveStageIdByDeptId.set(deptId, stageId);
  });

  const missingAfterActive = normalizedDeptIds.filter((deptId) => !stageIdByDeptId.has(deptId));
  const stageIdsToReactivate = missingAfterActive
    .map((deptId) => inactiveStageIdByDeptId.get(deptId))
    .filter(Boolean);

  if (stageIdsToReactivate.length) {
    const updatePayload = {
      is_active: true,
      updated_at: db.fn.now(),
    };
    if (actorUserId) updatePayload.updated_by = actorUserId;
    await db("erp.production_stages")
      .whereIn("id", stageIdsToReactivate)
      .update(updatePayload);
    stageIdsToReactivate.forEach((stageId) => {
      const deptId = stageDeptIdByStageId.get(stageId);
      if (!deptId || stageIdByDeptId.has(deptId)) return;
      stageIdByDeptId.set(deptId, stageId);
    });
  }

  const remainingMissingDeptIds = normalizedDeptIds.filter((deptId) => !stageIdByDeptId.has(deptId));
  if (!remainingMissingDeptIds.length) return stageIdByDeptId;

  const departmentRows = await db("erp.departments")
    .select("id", "name")
    .whereIn("id", remainingMissingDeptIds)
    .andWhere("is_active", true);
  const departmentNameById = new Map(
    (departmentRows || []).map((row) => [toPositiveInt(row?.id), String(row?.name || "").trim()]),
  );

  for (const deptId of remainingMissingDeptIds) {
    const deptName = departmentNameById.get(deptId);
    if (!deptName) continue;
    const baseCode = `DEPT-${deptId}`;
    const baseName = String(deptName).trim();
    try {
      const inserted = await db("erp.production_stages")
        .insert({
          code: baseCode,
          name: baseName,
          dept_id: deptId,
          is_active: true,
          created_by: actorUserId || null,
          updated_by: actorUserId || null,
        })
        .returning(["id", "dept_id"]);
      const row = inserted?.[0] || inserted;
      const stageId = toPositiveInt(row?.id || row);
      if (stageId) {
        stageIdByDeptId.set(deptId, stageId);
        continue;
      }
    } catch (err) {
      if (String(err?.code || "") !== "23505") {
        console.error("Error in BOMService:", err);
        throw err;
      }

      const existingRow = await db("erp.production_stages")
        .select("id", "is_active")
        .where({ dept_id: deptId })
        .orderBy("id", "desc")
        .first();
      const existingId = toPositiveInt(existingRow?.id);
      if (existingId) {
        if (existingRow?.is_active !== true) {
          const reactivatePayload = {
            is_active: true,
            updated_at: db.fn.now(),
          };
          if (actorUserId) reactivatePayload.updated_by = actorUserId;
          await db("erp.production_stages").where({ id: existingId }).update(reactivatePayload);
        }
        stageIdByDeptId.set(deptId, existingId);
        continue;
      }

      const fallbackName = `${baseName} [D${deptId}]`;
      const fallbackCode = `${baseCode}-AUTO`;
      try {
        const insertedFallback = await db("erp.production_stages")
          .insert({
            code: fallbackCode,
            name: fallbackName,
            dept_id: deptId,
            is_active: true,
            created_by: actorUserId || null,
            updated_by: actorUserId || null,
          })
          .returning(["id", "dept_id"]);
        const row = insertedFallback?.[0] || insertedFallback;
        const stageId = toPositiveInt(row?.id || row);
        if (stageId) stageIdByDeptId.set(deptId, stageId);
      } catch (fallbackErr) {
        if (String(fallbackErr?.code || "") === "23505") {
          const raceRow = await db("erp.production_stages")
            .select("id", "is_active")
            .where({ dept_id: deptId })
            .orderBy("id", "desc")
            .first();
          const raceId = toPositiveInt(raceRow?.id);
          if (raceId) {
            if (raceRow?.is_active !== true) {
              const racePayload = {
                is_active: true,
                updated_at: db.fn.now(),
              };
              if (actorUserId) racePayload.updated_by = actorUserId;
              await db("erp.production_stages").where({ id: raceId }).update(racePayload);
            }
            stageIdByDeptId.set(deptId, raceId);
            continue;
          }
        }
        console.error("Error in BOMService:", fallbackErr);
        throw fallbackErr;
      }
    }
  }

  return stageIdByDeptId;
};

const hasBomLifecycleColumn = async (db) => {
  if (bomLifecycleColumnSupportPromise) return bomLifecycleColumnSupportPromise;
  bomLifecycleColumnSupportPromise = (async () => {
    try {
      return db.schema.withSchema("erp").hasColumn("bom_header", "is_active");
    } catch (err) {
      bomLifecycleColumnSupportPromise = null;
      return false;
    }
  })();
  return bomLifecycleColumnSupportPromise;
};

const parseBomFormPayload = (body = {}) => {
  const rmRaw = parseJsonArray(body.rm_lines_json);
  const skuRaw = parseJsonArray(body.sku_rules_json);
  const sfgRaw = parseJsonArray(body.sfg_lines_json);
  const labourRaw = parseJsonArray(body.labour_lines_json);
  const stageRaw = parseJsonArray(body.stage_routes_json);

  return {
    header: {
      item_id: toNumberOrNull(body.item_id),
      level: String(body.level || "").toUpperCase(),
      output_qty: toNumberOrNull(body.output_qty),
      output_uom_id: toNumberOrNull(body.output_uom_id),
    },
    rm_lines: rmRaw
      .map((row) => ({
        rm_item_id: toNumberOrNull(row.rm_item_id),
        color_id: toNumberOrNull(row.color_id),
        size_id: toNumberOrNull(row.size_id),
        dept_id: toNumberOrNull(row.dept_id),
        qty: toNumberOrNull(row.qty),
        uom_id: toNumberOrNull(row.uom_id),
        normal_loss_pct: toNumberOrNull(row.normal_loss_pct),
      }))
      .filter((row) => row.rm_item_id || row.dept_id),
    sku_rules: skuRaw
      .map((row) => ({
        sku_id: toNumberOrNull(row.sku_id),
        target_rm_item_id: toNumberOrNull(row.target_rm_item_id),
        dept_id: toNumberOrNull(row.dept_id),
        rm_color_id: toNumberOrNull(row.rm_color_id),
        rm_size_id: toNumberOrNull(row.rm_size_id),
        replacement_rm_item_id: toNumberOrNull(row.replacement_rm_item_id),
        required_qty: toNumberOrNull(row.required_qty),
        uom_id: toNumberOrNull(row.uom_id),
      }))
      .filter((row) => row.sku_id || row.target_rm_item_id || row.dept_id || row.required_qty !== null),
    sfg_lines: sfgRaw
      .map((row) => ({
        fg_size_id: toNumberOrNull(row.fg_size_id),
        sfg_sku_id: toNumberOrNull(row.sfg_sku_id),
        required_qty: toNumberOrNull(row.required_qty),
        uom_id: toNumberOrNull(row.uom_id),
        consumed_in_stage_id: toPositiveInt(row.consumed_in_stage_id),
      }))
      .filter((row) => row.sfg_sku_id || row.required_qty),
    labour_lines: labourRaw
      .map((row) => ({
        size_scope: normalizeScope(row.size_scope),
        size_id: toNumberOrNull(row.size_id),
        dept_id: toNumberOrNull(row.dept_id),
        labour_id: toNumberOrNull(row.labour_id),
        rate_type: String(row.rate_type || "PER_PAIR").toUpperCase(),
        rate_value: toNumberOrNull(row.rate_value),
      }))
      // Keep selected labour rows so validator can surface missing-global-rate errors.
      .filter((row) => row.dept_id || row.labour_id),
    stage_routes: stageRaw
      .map((row, index) => ({
        dept_id: toPositiveInt(row.dept_id),
        stage_id: toPositiveInt(row.stage_id),
        sequence_no: toPositiveInt(row.sequence_no) || index + 1,
        is_required: row.is_required !== false,
        enforce_sequence: row.enforce_sequence !== false,
      }))
      .filter((row) => row.stage_id || row.dept_id),
    variant_rules: [],
    sku_overrides: [],
  };
};

const validateRequiredRates = async (db, rmLines, t) => {
  const lineKeys = rmLines.map((line) => ({ itemId: line.rm_item_id }));
  if (!lineKeys.length) return;
  const itemIds = [...new Set(lineKeys.map((entry) => entry.itemId).filter(Boolean))];
  if (!itemIds.length) return;

  const [rateRows, itemRows] = await Promise.all([
    db("erp.rm_purchase_rates").select("rm_item_id", "color_id", "size_id").whereIn("rm_item_id", itemIds).andWhere({ is_active: true }),
    db("erp.items").select("id", "name").whereIn("id", itemIds),
  ]);

  const rateSet = new Set(rateRows.map((row) => `${row.rm_item_id}`));
  const itemMap = new Map(itemRows.map((row) => [toNumberOrNull(row.id), row.name]));

  const missing = lineKeys.filter((entry) => !rateSet.has(`${entry.itemId}`));
  if (!missing.length) return;

  const names = missing.map((entry) => itemMap.get(entry.itemId) || String(entry.itemId));
  throw makeValidationError(t("bom_error_missing_material_rates") || "Missing required material rates.", [
    {
      field: "rm_lines_json",
      message: `${t("bom_error_missing_material_rates_detail") || "Missing active purchase rates for"}: ${[...new Set(names)].join(", ")}`,
    },
  ]);
};

const validateAndNormalizeInput = async (db, input, t, options = {}) => {
  const enforceSkuRuleCompleteness = Boolean(options?.enforceSkuRuleCompleteness);
  const details = [];
  const header = input?.header || {};
  const formatRowMessage = (index, message) =>
    `${t("bom_error_row_prefix") || "Row"} ${index + 1}: ${message}`;

  const itemId = toNumberOrNull(header.item_id);
  const level = String(header.level || "").toUpperCase();
  const outputQty = toPositiveNumber(header.output_qty);
  let outputUomId = toNumberOrNull(header.output_uom_id);

  if (!itemId) details.push({ field: "item_id", message: t("bom_error_item_required") || "Please select an item." });
  if (!BOM_LEVELS.has(level)) details.push({ field: "level", message: t("bom_error_level_required") || "Please select a valid BOM level." });
  if (!outputQty) details.push({ field: "output_qty", message: t("bom_error_output_qty_required") || "Output quantity must be greater than zero." });

  const item = itemId ? await db("erp.items").select("id", "name", "item_type", "base_uom_id").where({ id: itemId }).first() : null;
  if (!item) {
    details.push({ field: "item_id", message: t("bom_error_item_not_found") || "Selected item does not exist." });
  } else {
    if (level === "FINISHED" && item.item_type !== "FG") {
      details.push({ field: "level", message: t("bom_error_level_item_mismatch") || "Level must match item type." });
    }
    if (level === "SEMI_FINISHED" && item.item_type !== "SFG") {
      details.push({ field: "level", message: t("bom_error_level_item_mismatch") || "Level must match item type." });
    }
    if (!item.base_uom_id) {
      details.push({
        field: "item_id",
        message:
          t("bom_error_item_base_uom_missing")
          || "Selected article has no base unit. Please set Base Unit in product master first.",
      });
    }
    if (!outputUomId) outputUomId = item.base_uom_id || null;
  }

  if (!outputUomId) details.push({ field: "output_uom_id", message: t("bom_error_output_uom_required") || "Output UOM is required." });

  if (item?.base_uom_id && outputUomId && Number(outputUomId) !== Number(item.base_uom_id)) {
    const hasUomConversionsTable = await tableExists(db, "erp.uom_conversions");
    if (!hasUomConversionsTable) {
      details.push({
        field: "output_uom_id",
        message:
          t("bom_error_output_uom_conversion_missing")
          || "Output Unit must have an active conversion to the article Base Unit in UOM Conversions.",
      });
    } else {
      const [uomRows, conversionRows] = await Promise.all([
        db("erp.uom")
          .select("id", "name")
          .whereIn("id", [Number(outputUomId), Number(item.base_uom_id)]),
        db("erp.uom_conversions")
          .select("from_uom_id", "to_uom_id")
          .where({
            from_uom_id: Number(outputUomId),
            to_uom_id: Number(item.base_uom_id),
            is_active: true,
          })
          .limit(1),
      ]);
      const uomNameById = new Map((uomRows || []).map((row) => [Number(row.id), String(row.name || row.id)]));
      const outputUomLabel = uomNameById.get(Number(outputUomId)) || `UOM ${outputUomId}`;
      const baseUomLabel = uomNameById.get(Number(item.base_uom_id)) || `UOM ${item.base_uom_id}`;
      if (!Array.isArray(conversionRows) || conversionRows.length === 0) {
        details.push({
          field: "output_uom_id",
          message: `${
            t("bom_error_output_uom_conversion_missing")
            || "Output Unit must have an active conversion to the article Base Unit in UOM Conversions."
          } (${outputUomLabel} -> ${baseUomLabel}).`,
        });
      }
    }
  }

  const rmLines = toArray(input?.rm_lines)
    .map((line) => ({
      rm_item_id: toNumberOrNull(line.rm_item_id),
      color_id: toNumberOrNull(line.color_id),
      size_id: toNumberOrNull(line.size_id),
      dept_id: toNumberOrNull(line.dept_id),
      qty: toPositiveNumber(line.qty),
      uom_id: toNumberOrNull(line.uom_id),
      normal_loss_pct: toNumberOrNull(line.normal_loss_pct) ?? 0,
    }))
    .filter((line) => line.rm_item_id || line.color_id || line.size_id || line.dept_id);

  const rmItemIds = [...new Set(rmLines.map((line) => line.rm_item_id).filter(Boolean))];
  const rmItems = rmItemIds.length
    ? await db("erp.items").select("id", "name", "item_type", "base_uom_id").whereIn("id", rmItemIds)
    : [];
  const rmItemMap = new Map(rmItems.map((row) => [toNumberOrNull(row.id), row]));
  rmLines.forEach((line, idx) => {
    const rowLabel = `${t("bom_error_row_prefix") || "Row"} ${idx + 1}`;
    if (!line.rm_item_id || !line.dept_id) {
      details.push({
        field: "rm_lines_json",
        message: `${rowLabel}: ${t("bom_error_rm_line_invalid") || "Complete this raw material row: select material and department."}`,
      });
      return;
    }
    const rmItem = rmItemMap.get(line.rm_item_id);
    if (!rmItem || rmItem.item_type !== "RM") {
      details.push({
        field: "rm_lines_json",
        message: `${rowLabel}: ${t("bom_error_rm_item_invalid") || "Selected material must be a Raw Material item."}`,
      });
      return;
    }
    line.uom_id = rmItem.base_uom_id || null;
    if (!line.uom_id) {
      details.push({
        field: "rm_lines_json",
        message: `${rowLabel}: ${t("bom_error_rm_uom_required") || "Material unit is missing. Please set base unit for this material."}`,
      });
    }
    if (line.normal_loss_pct < 0 || line.normal_loss_pct > 100) {
      details.push({
        field: "rm_lines_json",
        message: `${rowLabel}: ${t("bom_error_loss_pct_invalid") || "Normal loss % must be between 0 and 100."}`,
      });
    }
  });
  const rmComboFirstIndex = new Map();
  rmLines.forEach((line, idx) => {
    if (!line.rm_item_id || !line.dept_id) return;
    const comboKey = `${line.rm_item_id}:${line.dept_id}`;
    if (rmComboFirstIndex.has(comboKey)) {
      details.push({
        field: "rm_lines_json",
        message: formatRowMessage(
          idx,
          t("bom_error_rm_department_duplicate")
          || "This material is already added for the selected consumption department. Use a different material or department.",
        ),
      });
      return;
    }
    rmComboFirstIndex.set(comboKey, idx);
  });

  let sfgLines = toArray(input?.sfg_lines)
    .map((line) => ({
      fg_size_id: toNumberOrNull(line.fg_size_id),
      sfg_sku_id: toNumberOrNull(line.sfg_sku_id),
      required_qty: toPositiveNumber(line.required_qty),
      uom_id: toNumberOrNull(line.uom_id),
      consumed_in_stage_id: toPositiveInt(line.consumed_in_stage_id),
      ref_approved_bom_id: null,
    }))
    .filter((line) => line.sfg_sku_id || line.required_qty);
  if (sfgLines.length) {
    const sfgUniqueByCombo = new Map();
    sfgLines.forEach((line) => {
      const key = `${toNumberOrNull(line.fg_size_id) || 0}:${toNumberOrNull(line.sfg_sku_id) || 0}`;
      const score = Number(line.required_qty ? 1 : 0) + Number(line.uom_id ? 1 : 0);
      const existing = sfgUniqueByCombo.get(key);
      if (!existing || score >= existing.score) {
        sfgUniqueByCombo.set(key, { score, line });
      }
    });
    sfgLines = [...sfgUniqueByCombo.values()].map((entry) => entry.line);
  }

  if (level === "SEMI_FINISHED" && sfgLines.length) {
    details.push({ field: "sfg_lines_json", message: t("bom_error_sfg_not_allowed_for_sfg_level") || "Semi-finished BOM cannot include SFG section lines." });
  }

  const skuIds = [...new Set(sfgLines.map((line) => line.sfg_sku_id).filter(Boolean))];
  const skuRows = skuIds.length
    ? await db("erp.skus as s")
        .select("s.id", "v.item_id", "i.item_type", "i.base_uom_id")
        .leftJoin("erp.variants as v", "s.variant_id", "v.id")
        .leftJoin("erp.items as i", "v.item_id", "i.id")
        .whereIn("s.id", skuIds)
    : [];
  const skuMap = new Map(skuRows.map((row) => [toNumberOrNull(row.id), row]));
  const incompleteSfgRowIndexes = [];
  const sfgItemIds = [...new Set(
    sfgLines
      .map((line) => toNumberOrNull(skuMap.get(line.sfg_sku_id)?.item_id))
      .filter(Boolean),
  )];
  const approvedBomByItemId = new Map();
  if (sfgItemIds.length) {
    const approvedRows = await db("erp.bom_header")
      .select("id", "item_id", "version_no")
      .whereIn("item_id", sfgItemIds)
      .andWhere("status", "APPROVED")
      .orderBy("item_id", "asc")
      .orderBy("version_no", "desc")
      .orderBy("id", "desc");
    approvedRows.forEach((row) => {
      const itemId = toNumberOrNull(row?.item_id);
      if (!itemId || approvedBomByItemId.has(itemId)) return;
      approvedBomByItemId.set(itemId, toNumberOrNull(row?.id) || null);
    });
  }
  for (let idx = 0; idx < sfgLines.length; idx += 1) {
    const line = sfgLines[idx];
    if (!line.fg_size_id || !line.sfg_sku_id || !line.required_qty || !line.consumed_in_stage_id) {
      incompleteSfgRowIndexes.push(idx + 1);
      continue;
    }
    const sku = skuMap.get(line.sfg_sku_id);
    if (!sku || sku.item_type !== "SFG") {
      details.push({
        field: "sfg_lines_json",
        message: formatRowMessage(idx, t("bom_error_sfg_item_invalid") || "Selected SKU must belong to a semi-finished item."),
      });
      continue;
    }
    line.uom_id = sku.base_uom_id || null;
    if (!line.uom_id) {
      details.push({
        field: "sfg_lines_json",
        message: formatRowMessage(idx, t("bom_error_sfg_uom_required") || "Semi-finished SKU is missing a base unit."),
      });
    }
    const approvedBomId = approvedBomByItemId.get(toNumberOrNull(sku.item_id)) || null;
    line.ref_approved_bom_id = approvedBomId || null;
  }
  if (incompleteSfgRowIndexes.length) {
    const message = t("bom_error_sfg_section_incomplete")
      || "Complete all mandatory fields in Semi-Finished section (Article SKU, Step/Upper SKU, Step Quantity, and Consumed In Stage).";
    details.push({
      field: "sfg_lines_json",
      message,
    });
  }

  const labourLines = toArray(input?.labour_lines)
    .map((line) => ({
      size_scope: normalizeScope(line.size_scope),
      size_id: toNumberOrNull(line.size_id),
      dept_id: toNumberOrNull(line.dept_id),
      labour_id: toNumberOrNull(line.labour_id),
      rate_type: String(line.rate_type || "PER_PAIR").toUpperCase(),
      rate_value: toNumberOrNull(line.rate_value),
    }))
    .filter((line) => line.dept_id || line.labour_id || line.rate_value);

  const labourIds = [...new Set(labourLines.map((line) => toNumberOrNull(line.labour_id)).filter(Boolean))];
  const [hasLabourDeptTable, hasSizeItemTypesTable] = await Promise.all([
    tableExists(db, "erp.labour_department"),
    tableExists(db, "erp.size_item_types"),
  ]);
  const labourRows = labourIds.length ? await db("erp.labours").select("id", "dept_id").whereIn("id", labourIds) : [];
  const labourMapRows = hasLabourDeptTable && labourIds.length ? await db("erp.labour_department").select("labour_id", "dept_id").whereIn("labour_id", labourIds) : [];
  const labourAllowedDeptMap = new Map();
  labourRows.forEach((row) => {
    labourAllowedDeptMap.set(toNumberOrNull(row.id), new Set());
  });
  labourMapRows.forEach((row) => {
    const labourId = toNumberOrNull(row.labour_id);
    const deptId = toNumberOrNull(row.dept_id);
    if (!labourId || !deptId) return;
    if (!labourAllowedDeptMap.has(labourId)) labourAllowedDeptMap.set(labourId, new Set());
    labourAllowedDeptMap.get(labourId).add(deptId);
  });
  labourRows.forEach((row) => {
    const labourId = toNumberOrNull(row.id);
    const fallbackDeptId = toNumberOrNull(row.dept_id);
    if (!labourId || !fallbackDeptId) return;
    if (!labourAllowedDeptMap.has(labourId)) labourAllowedDeptMap.set(labourId, new Set());
    labourAllowedDeptMap.get(labourId).add(fallbackDeptId);
  });

  const departmentIds = [...new Set([...rmLines, ...labourLines].map((line) => toNumberOrNull(line.dept_id)).filter(Boolean))];
  const departmentRows = departmentIds.length
    ? await db("erp.departments").select("id", "is_active", "is_production").whereIn("id", departmentIds)
    : [];
  const hasAnyActiveProductionDepartment = await db("erp.departments")
    .first("id")
    .where({ is_active: true, is_production: true });
  const enforceProductionDepartment = Boolean(hasAnyActiveProductionDepartment?.id);
  const departmentMap = new Map(departmentRows.map((row) => [toNumberOrNull(row.id), row]));

  rmLines.forEach((line, idx) => {
    const rowLabel = `${t("bom_error_row_prefix") || "Row"} ${idx + 1}`;
    if (!line.dept_id) return;
    const dept = departmentMap.get(line.dept_id);
    if (!dept || !dept.is_active || (enforceProductionDepartment && !dept.is_production)) {
      details.push({
        field: "rm_lines_json",
        message: `${rowLabel}: ${t("bom_error_department_must_be_production") || "Selected department must be an active Production department."}`,
      });
    }
  });

  labourLines.forEach((line, idx) => {
    if (!line.dept_id || !line.labour_id) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(idx, t("bom_error_labour_line_invalid") || "Complete this labour row: select labour, department, rate type, and valid rate."),
      });
      return;
    }
    if (line.rate_value === null) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(
          idx,
          t("bom_error_labour_rate_global_missing")
          || "No active global labour rate found for this Labour + Department + Rate Type. Define it in Labour Rates first.",
        ),
      });
      return;
    }
    if (line.rate_value < 0) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(idx, t("bom_error_labour_line_invalid") || "Complete this labour row: select labour, department, rate type, and valid rate."),
      });
      return;
    }
    if (!LABOUR_RATE_TYPES.has(line.rate_type)) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(idx, t("bom_error_labour_rate_type_invalid") || "Select a valid labour rate type."),
      });
      return;
    }
    const dept = departmentMap.get(line.dept_id);
    if (!dept || !dept.is_active || (enforceProductionDepartment && !dept.is_production)) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(idx, t("bom_error_department_must_be_production") || "Selected department must be an active Production department."),
      });
    }
    const allowedDeptSet = labourAllowedDeptMap.get(line.labour_id);
    if (!allowedDeptSet || !allowedDeptSet.has(line.dept_id)) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(idx, t("bom_error_labour_department_invalid") || "Selected department is not allowed for this labour."),
      });
    }
    if (line.size_scope === "SPECIFIC" && !line.size_id) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(idx, t("bom_error_size_required_for_specific_scope") || "Size is required for specific scope."),
      });
    }
    if (line.size_scope === "ALL") line.size_id = null;
  });
  const labourComboFirstIndex = new Map();
  labourLines.forEach((line, idx) => {
    if (!line.labour_id || !line.dept_id) return;
    const sizeKey = line.size_scope === "SPECIFIC" ? String(line.size_id || "") : "ALL";
    const rateTypeKey = String(line.rate_type || "PER_PAIR").toUpperCase();
    const comboKey = `${line.labour_id}:${line.dept_id}:${sizeKey}:${rateTypeKey}`;
    if (labourComboFirstIndex.has(comboKey)) {
      details.push({
        field: "labour_lines_json",
        message: formatRowMessage(
          idx,
          t("bom_error_labour_department_duplicate")
          || "This labour is already added for the selected department. Choose a different labour or department.",
        ),
      });
      return;
    }
    labourComboFirstIndex.set(comboKey, idx);
  });

  const skuRules = toArray(input?.sku_rules)
    .map((line) => ({
      sku_id: toNumberOrNull(line?.sku_id),
      target_rm_item_id: toNumberOrNull(line?.target_rm_item_id),
      dept_id: toNumberOrNull(line?.dept_id),
      required_qty: toNumberOrNull(line?.required_qty),
      uom_id: toNumberOrNull(line?.uom_id),
    }))
    .filter((line) => line.sku_id || line.target_rm_item_id || line.dept_id || line.required_qty !== null);

  const headerSkuRows = itemId
    ? await db("erp.skus as s")
        .select("s.id", "s.sku_code")
        .leftJoin("erp.variants as v", "s.variant_id", "v.id")
        .where("v.item_id", itemId)
        .andWhere("s.is_active", true)
    : [];
  const headerSkuSet = new Set((headerSkuRows || []).map((row) => toNumberOrNull(row?.id)).filter(Boolean));
  const headerSkuCodeById = new Map((headerSkuRows || []).map((row) => [toNumberOrNull(row?.id), String(row?.sku_code || row?.id || "").trim()]));
  const rmComboSet = new Set(rmLines.map((line) => `${line.rm_item_id}:${line.dept_id}`));
  const aggregatedQtyByRmCombo = new Map();
  const providedSkuRmCombos = new Set();

  if (rmLines.length && enforceSkuRuleCompleteness) {
    if (!headerSkuSet.size) {
      details.push({
        field: "sku_rules_json",
        message: "No active SKU found for selected article. Define SKUs first.",
      });
    }
    if (!skuRules.length) {
      details.push({
        field: "sku_rules_json",
        message: "Enter required quantity in SKU Rules for all SKU/material rows.",
      });
    }
  }

  skuRules.forEach((line, idx) => {
    const rowLabel = `${t("bom_error_row_prefix") || "Row"} ${idx + 1}`;
    const hasCompleteRule =
      Boolean(line.sku_id)
      && Boolean(line.target_rm_item_id)
      && Boolean(line.dept_id)
      && line.required_qty !== null;
    if (!hasCompleteRule) {
      if (enforceSkuRuleCompleteness) {
        details.push({
          field: "sku_rules_json",
          message: `${rowLabel}: Enter SKU, material, department, and required quantity.`,
        });
      }
      return;
    }
    if (line.required_qty < 0) {
      details.push({
        field: "sku_rules_json",
        message: `${rowLabel}: Required quantity cannot be negative.`,
      });
      return;
    }
    if (!headerSkuSet.has(line.sku_id)) {
      details.push({
        field: "sku_rules_json",
        message: `${rowLabel}: Selected SKU does not belong to this article.`,
      });
      return;
    }
    const rmComboKey = `${line.target_rm_item_id}:${line.dept_id}`;
    if (!rmComboSet.has(rmComboKey)) {
      details.push({
        field: "sku_rules_json",
        message: `${rowLabel}: SKU rule must match an existing material line (material + department).`,
      });
      return;
    }
    const skuRmKey = `${line.sku_id}:${rmComboKey}`;
    if (providedSkuRmCombos.has(skuRmKey)) {
      details.push({
        field: "sku_rules_json",
        message: `${rowLabel}: Duplicate SKU rule row is not allowed.`,
      });
      return;
    }
    providedSkuRmCombos.add(skuRmKey);
    aggregatedQtyByRmCombo.set(
      rmComboKey,
      Number(aggregatedQtyByRmCombo.get(rmComboKey) || 0) + Number(line.required_qty || 0),
    );
  });

  if (headerSkuSet.size && rmComboSet.size && enforceSkuRuleCompleteness) {
    const missingSkuRulePairs = [];
    [...headerSkuSet].forEach((skuId) => {
      [...rmComboSet].forEach((rmComboKey) => {
        const skuRmKey = `${skuId}:${rmComboKey}`;
        if (!providedSkuRmCombos.has(skuRmKey)) {
          missingSkuRulePairs.push({ skuId, rmComboKey });
        }
      });
    });
    if (missingSkuRulePairs.length) {
      const sample = missingSkuRulePairs
        .slice(0, 8)
        .map((row) => {
          const [rmItemId, deptId] = String(row.rmComboKey).split(":");
          const skuLabel = headerSkuCodeById.get(row.skuId) || `SKU ${row.skuId}`;
          const rmName = String(rmItemMap.get(toNumberOrNull(rmItemId))?.name || rmItemId || "").trim();
          return `${skuLabel} / ${rmName} / Dept ${deptId}`;
        })
        .filter(Boolean)
        .join(", ");
      const more = missingSkuRulePairs.length > 8 ? ` (+${missingSkuRulePairs.length - 8})` : "";
      details.push({
        field: "sku_rules_json",
        message: `Complete SKU Rules quantity for all SKU/material rows.${sample ? ` Missing: ${sample}${more}.` : ""}`,
      });
    }
  }

  rmLines.forEach((line, idx) => {
    const comboKey = `${line.rm_item_id}:${line.dept_id}`;
    const aggregatedQty = Number(aggregatedQtyByRmCombo.get(comboKey) || 0);
    if (Number.isFinite(aggregatedQty) && aggregatedQty >= 0) {
      line.qty = Number(aggregatedQty.toFixed(3));
      return;
    }
    if (enforceSkuRuleCompleteness) {
      details.push({
        field: "sku_rules_json",
        message: `${t("bom_error_row_prefix") || "Row"} ${idx + 1}: Material line has no SKU-rule quantity total.`,
      });
      return;
    }
    line.qty = 0;
  });

  const stageRoutes = toArray(input?.stage_routes)
    .map((line, idx) => ({
      dept_id: toPositiveInt(line?.dept_id),
      stage_id: toPositiveInt(line?.stage_id),
      sequence_no: toPositiveInt(line?.sequence_no) || idx + 1,
      is_required: line?.is_required !== false,
      enforce_sequence: line?.enforce_sequence !== false,
    }))
    .filter((line) => line.stage_id || line.dept_id);

  const hasProductionStageTable = await tableExists(db, "erp.production_stages");
  const hasBomStageRoutingTable = await tableExists(db, "erp.bom_stage_routing");
  if (stageRoutes.length && (!hasProductionStageTable || !hasBomStageRoutingTable)) {
    details.push({
      field: "stage_routes_json",
      message: t("generic_error") || "Production stage routing is not available in this environment.",
    });
  }
  if (stageRoutes.length && hasProductionStageTable) {
    const stageRouteDeptIds = [...new Set(
      stageRoutes
        .map((line) => line.dept_id)
        .filter(Boolean),
    )];
    const stageIdByDeptId = await ensureActiveStageMappingsByDepartment(db, stageRouteDeptIds, {
      actorUserId: options?.actorUserId,
    });
    stageRoutes.forEach((line) => {
      if (line.dept_id) {
        line.stage_id = stageIdByDeptId.get(line.dept_id) || null;
      }
    });
    const stageIds = [...new Set(stageRoutes.map((line) => line.stage_id).filter(Boolean))];
    const stageRows = stageIds.length
      ? await db("erp.production_stages")
          .select("id", "dept_id", "is_active")
          .whereIn("id", stageIds)
      : [];
    const activeStageMap = new Map((stageRows || []).map((row) => [toPositiveInt(row.id), Boolean(row.is_active)]));
    const stageDeptIdByStageId = new Map(
      (stageRows || [])
        .map((row) => [toPositiveInt(row.id), toPositiveInt(row.dept_id)]),
    );
    stageRoutes.forEach((line) => {
      if (!line.dept_id && line.stage_id && stageDeptIdByStageId.has(line.stage_id)) {
        line.dept_id = stageDeptIdByStageId.get(line.stage_id);
      }
    });
    const usedStageIds = new Set();
    const usedSequenceNos = new Set();
    stageRoutes.forEach((line, idx) => {
      if (!line.stage_id) {
        details.push({
          field: "stage_routes_json",
          message: `${t("bom_error_row_prefix") || "Row"} ${idx + 1}: ${(t("bom_error_stage_missing_mapping") || "Selected production department has no active stage mapping.")}`,
        });
        return;
      }
      if (!activeStageMap.has(line.stage_id) || !activeStageMap.get(line.stage_id)) {
        details.push({
          field: "stage_routes_json",
          message: `${t("bom_error_row_prefix") || "Row"} ${idx + 1}: ${(t("bom_error_stage_inactive_or_missing") || "Selected production stage is missing or inactive.")} (${line.stage_id})`,
        });
      }
      if (usedStageIds.has(line.stage_id)) {
        details.push({
          field: "stage_routes_json",
          message: `${t("bom_error_row_prefix") || "Row"} ${idx + 1}: ${(t("bom_error_stage_duplicate_in_flow") || "This production department/stage is already added in flow.")}`,
        });
      }
      usedStageIds.add(line.stage_id);
      if (usedSequenceNos.has(line.sequence_no)) {
        details.push({
          field: "stage_routes_json",
          message: `${t("bom_error_row_prefix") || "Row"} ${idx + 1}: ${(t("bom_error_stage_sequence_duplicate") || "Duplicate sequence is not allowed in production flow.")}`,
        });
      }
      usedSequenceNos.add(line.sequence_no);
    });
  }

  if (sfgLines.length) {
    const mappedStageIds = new Set(stageRoutes.map((line) => toPositiveInt(line.stage_id)).filter(Boolean));
    if (hasBomStageRoutingTable && level === "FINISHED" && !mappedStageIds.size) {
      details.push({
        field: "stage_routes_json",
        message: t("bom_error_stage_required_for_sfg") || "Add Production Stages first before mapping Semi-Finished consumption stages.",
      });
    }
    sfgLines.forEach((line, idx) => {
      if (!line.consumed_in_stage_id) {
        details.push({
          field: "sfg_lines_json",
          message: `${t("bom_error_row_prefix") || "Row"} ${idx + 1}: ${(t("bom_error_sfg_consumed_stage_required") || "Select consumed-in stage for this Semi-Finished row.")}`,
        });
        return;
      }
      if (mappedStageIds.size && !mappedStageIds.has(Number(line.consumed_in_stage_id))) {
        details.push({
          field: "sfg_lines_json",
          message: `${t("bom_error_row_prefix") || "Row"} ${idx + 1}: ${(t("bom_error_sfg_consumed_stage_not_mapped") || "Selected consumed-in stage is not mapped in Production Stages section.")}`,
        });
      }
    });
  }

  const variantRules = [];
  const skuOverrides = [];

  if (details.length) throw makeValidationError(t("bom_error_fix_fields") || "Please review and correct the BOM details.", details);

  await validateRequiredRates(db, rmLines, t);

  return {
    header: {
      item_id: itemId,
      level,
      output_qty: outputQty,
      output_uom_id: outputUomId,
    },
    rm_lines: rmLines,
    sku_rules: skuRules,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    stage_routes: stageRoutes
      .slice()
      .sort((a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0)),
    variant_rules: variantRules,
    sku_overrides: skuOverrides,
  };
};

const ensureDraftUniqueness = async (db, { itemId, level, excludeId, createdBy, t }) => {
  let query = db("erp.bom_header").select("id", "bom_no").where({ item_id: itemId, level, status: "DRAFT" });
  const normalizedCreatedBy = toPositiveInt(createdBy);
  if (normalizedCreatedBy) query = query.andWhere("created_by", normalizedCreatedBy);
  if (excludeId) query = query.andWhereNot({ id: excludeId });
  const existing = await query.first();
  if (existing) {
    throw makeValidationError(t("bom_error_draft_exists") || "A draft already exists for this item and level.", [
      { field: "item_id", message: t("bom_error_draft_exists") || "A draft already exists for this item and level." },
    ]);
  }
};

const ensureNoExistingBomForItem = async (db, { itemId, level, excludeId, t }) => {
  let query = db("erp.bom_header")
    .select("id")
    .where({ item_id: itemId, status: "APPROVED" });
  const normalizedLevel = String(level || "").trim().toUpperCase();
  if (BOM_LEVELS.has(normalizedLevel)) query = query.andWhere("level", normalizedLevel);
  if (excludeId) query = query.andWhereNot({ id: excludeId });
  const existing = await query.first();
  if (existing) {
    const message = t("bom_error_existing_bom")
      || "A BOM already exists for this article. Use BOM Register/Revise instead of Add BOM.";
    throw makeValidationError(message, [{ field: "item_id", message }]);
  }
};

const nextBomNo = async (trx) => {
  await trx.raw("LOCK TABLE erp.bom_header IN SHARE ROW EXCLUSIVE MODE");
  const row = await trx("erp.bom_header").max("id as max").first();
  const next = Number(row?.max || 0) + 1;
  return `BOM-${String(next).padStart(6, "0")}`;
};

const normalizeHeaderSnapshot = (header = {}) => ({
  item_id: toNumberOrNull(header.item_id),
  level: String(header.level || "").toUpperCase(),
  output_qty: Number(toNumberOrNull(header.output_qty) || 0),
  output_uom_id: toNumberOrNull(header.output_uom_id),
});

const buildApprovalSnapshot = (snapshot = {}) => {
  const header = normalizeHeaderSnapshot(snapshot.header || {});
  const rmLines = toArray(snapshot.rm_lines)
    .map((line) => ({
      rm_item_id: toNumberOrNull(line.rm_item_id),
      color_id: toNumberOrNull(line.color_id),
      size_id: toNumberOrNull(line.size_id),
      dept_id: toNumberOrNull(line.dept_id),
      qty: toNumberOrNull(line.qty),
      uom_id: toNumberOrNull(line.uom_id),
      normal_loss_pct: toNumberOrNull(line.normal_loss_pct) ?? 0,
    }))
    .sort((a, b) =>
      `${a.rm_item_id || 0}:${a.dept_id || 0}:${a.color_id || 0}:${a.size_id || 0}`.localeCompare(
        `${b.rm_item_id || 0}:${b.dept_id || 0}:${b.color_id || 0}:${b.size_id || 0}`,
      ),
    );
  const sfgLines = toArray(snapshot.sfg_lines)
    .map((line) => ({
      fg_size_id: toNumberOrNull(line.fg_size_id),
      sfg_sku_id: toNumberOrNull(line.sfg_sku_id),
      required_qty: toNumberOrNull(line.required_qty),
      uom_id: toNumberOrNull(line.uom_id),
      consumed_in_stage_id: toPositiveInt(line.consumed_in_stage_id),
      ref_approved_bom_id: toNumberOrNull(line.ref_approved_bom_id),
    }))
    .sort((a, b) => `${a.fg_size_id || 0}:${a.sfg_sku_id || 0}`.localeCompare(`${b.fg_size_id || 0}:${b.sfg_sku_id || 0}`));
  const labourLines = toArray(snapshot.labour_lines)
    .map((line) => ({
      size_scope: normalizeScope(line.size_scope),
      size_id: toNumberOrNull(line.size_id),
      dept_id: toNumberOrNull(line.dept_id),
      labour_id: toNumberOrNull(line.labour_id),
      rate_type: String(line.rate_type || "PER_PAIR").toUpperCase(),
      rate_value: toNumberOrNull(line.rate_value),
    }))
    .sort((a, b) =>
      `${a.dept_id || 0}:${a.labour_id || 0}:${a.size_scope || "ALL"}:${a.size_id || 0}:${a.rate_type || "PER_PAIR"}`.localeCompare(
        `${b.dept_id || 0}:${b.labour_id || 0}:${b.size_scope || "ALL"}:${b.size_id || 0}:${b.rate_type || "PER_PAIR"}`,
      ),
    );
  const stageRoutes = toArray(snapshot.stage_routes)
    .map((line) => ({
      stage_id: toPositiveInt(line.stage_id),
      sequence_no: toPositiveInt(line.sequence_no),
      is_required: line.is_required !== false,
      enforce_sequence: line.enforce_sequence !== false,
    }))
    .filter((line) => line.stage_id && line.sequence_no)
    .sort((a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0));
  const skuOverrides = toArray(snapshot.sku_overrides)
    .map((line) => ({
      sku_id: toNumberOrNull(line.sku_id),
      target_rm_item_id: toNumberOrNull(line.target_rm_item_id),
      dept_id: toNumberOrNull(line.dept_id),
      is_excluded: line.is_excluded === true,
      override_qty: toNumberOrNull(line.override_qty),
      override_uom_id: toNumberOrNull(line.override_uom_id),
      replacement_rm_item_id: toNumberOrNull(line.replacement_rm_item_id),
      rm_color_id: toNumberOrNull(line.rm_color_id),
      rm_size_id: toNumberOrNull(line.rm_size_id),
      notes: line.notes == null ? null : String(line.notes),
    }))
    .filter((line) => line.sku_id && line.target_rm_item_id && line.dept_id)
    .sort((a, b) =>
      `${a.sku_id || 0}:${a.target_rm_item_id || 0}:${a.dept_id || 0}`.localeCompare(
        `${b.sku_id || 0}:${b.target_rm_item_id || 0}:${b.dept_id || 0}`,
      ),
    );
  return {
    header,
    rm_lines: rmLines,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    stage_routes: stageRoutes,
    variant_rules: [],
    sku_overrides: skuOverrides,
  };
};

const snapshotSignature = (snapshot = {}) => JSON.stringify(toSortedObject(buildApprovalSnapshot(snapshot)));

const replaceBomLines = async (trx, bomId, lines) => {
  const hasBomStageRoutingTable = await tableExists(trx, "erp.bom_stage_routing");
  const hasBomSkuOverrideTable = await tableExists(trx, "erp.bom_sku_override_line");
  await trx("erp.bom_rm_line").where({ bom_id: bomId }).del();
  await trx("erp.bom_sfg_line").where({ bom_id: bomId }).del();
  await trx("erp.bom_labour_line").where({ bom_id: bomId }).del();
  if (hasBomStageRoutingTable) {
    await trx("erp.bom_stage_routing").where({ bom_id: bomId }).del();
  }
  if (hasBomSkuOverrideTable) {
    await trx("erp.bom_sku_override_line").where({ bom_id: bomId }).del();
  }

  if (lines.rm_lines?.length) {
    await trx("erp.bom_rm_line").insert(
      lines.rm_lines.map((line) => ({
        bom_id: bomId,
        rm_item_id: line.rm_item_id,
        color_id: line.color_id || null,
        size_id: line.size_id || null,
        dept_id: line.dept_id,
        qty: line.qty,
        uom_id: line.uom_id,
        normal_loss_pct: line.normal_loss_pct ?? 0,
      })),
    );
  }

  if (lines.sfg_lines?.length) {
    await trx("erp.bom_sfg_line").insert(
      lines.sfg_lines.map((line) => ({
        bom_id: bomId,
        fg_size_id: line.fg_size_id,
        sfg_sku_id: line.sfg_sku_id,
        required_qty: line.required_qty,
        uom_id: line.uom_id,
        consumed_in_stage_id: line.consumed_in_stage_id || null,
        ref_approved_bom_id: line.ref_approved_bom_id || null,
      })),
    );
  }

  if (lines.labour_lines?.length) {
    await trx("erp.bom_labour_line").insert(
      lines.labour_lines.map((line) => ({
        bom_id: bomId,
        size_scope: line.size_scope,
        size_id: line.size_scope === "SPECIFIC" ? line.size_id : null,
        dept_id: line.dept_id,
        labour_id: line.labour_id,
        rate_type: line.rate_type,
        rate_value: line.rate_value,
      })),
    );
  }

  if (hasBomStageRoutingTable && lines.stage_routes?.length) {
    await trx("erp.bom_stage_routing").insert(
      lines.stage_routes.map((line, index) => ({
        bom_id: bomId,
        stage_id: toPositiveInt(line.stage_id),
        sequence_no: toPositiveInt(line.sequence_no) || index + 1,
        is_required: line.is_required !== false,
        enforce_sequence: line.enforce_sequence !== false,
      })),
    );
  }

  if (hasBomSkuOverrideTable) {
    const explicitOverrides = toArray(lines.sku_overrides)
      .map((line) => ({
        sku_id: toNumberOrNull(line.sku_id),
        target_rm_item_id: toNumberOrNull(line.target_rm_item_id),
        dept_id: toNumberOrNull(line.dept_id),
        is_excluded: line.is_excluded === true,
        override_qty: toNumberOrNull(line.override_qty),
        override_uom_id: toNumberOrNull(line.override_uom_id),
        replacement_rm_item_id: toNumberOrNull(line.replacement_rm_item_id),
        rm_color_id: toNumberOrNull(line.rm_color_id),
        rm_size_id: toNumberOrNull(line.rm_size_id),
        notes: line.notes == null ? null : String(line.notes),
      }))
      .filter((line) => line.sku_id && line.target_rm_item_id && line.dept_id);

    if (explicitOverrides.length) {
      await trx("erp.bom_sku_override_line").insert(
        explicitOverrides.map((line) => ({
          bom_id: bomId,
          sku_id: line.sku_id,
          target_rm_item_id: line.target_rm_item_id,
          dept_id: line.dept_id,
          is_excluded: line.is_excluded,
          override_qty: line.override_qty,
          override_uom_id: line.override_uom_id || null,
          replacement_rm_item_id: line.replacement_rm_item_id || null,
          rm_color_id: line.rm_color_id || null,
          rm_size_id: line.rm_size_id || null,
          notes: line.notes || null,
        })),
      );
    } else if (lines.sku_rules?.length) {
      await trx("erp.bom_sku_override_line").insert(
        lines.sku_rules.map((line) => ({
          bom_id: bomId,
          sku_id: line.sku_id,
          target_rm_item_id: line.target_rm_item_id,
          dept_id: line.dept_id || null,
          is_excluded: false,
          override_qty: toNumberOrNull(line.required_qty),
          override_uom_id: line.uom_id || null,
          replacement_rm_item_id: line.replacement_rm_item_id || null,
          rm_color_id: line.rm_color_id || null,
          rm_size_id: line.rm_size_id || null,
          notes: null,
        })),
      );
    }
  }
};

const getBomSnapshot = async (db, bomId) => {
  const lifecycleSupported = await hasBomLifecycleColumn(db);
  const hasBomStageRoutingTable = await tableExists(db, "erp.bom_stage_routing");
  const hasBomSkuOverrideTable = await tableExists(db, "erp.bom_sku_override_line");
  const headerFields = ["id", "bom_no", "item_id", "level", "output_qty", "output_uom_id", "status", "version_no", "created_by", "approved_by"];
  if (lifecycleSupported) headerFields.push("is_active");
  const header = await db("erp.bom_header").select(headerFields).where({ id: bomId }).first();
  if (header && !lifecycleSupported) header.is_active = true;
  if (!header) return null;
  const [rmLines, sfgLines, labourLines, stageRoutes, skuOverrides] = await Promise.all([
    db("erp.bom_rm_line").select("rm_item_id", "color_id", "size_id", "dept_id", "qty", "uom_id", "normal_loss_pct").where({ bom_id: bomId }).orderBy("id", "asc"),
    db("erp.bom_sfg_line").select("fg_size_id", "sfg_sku_id", "required_qty", "uom_id", "consumed_in_stage_id", "ref_approved_bom_id").where({ bom_id: bomId }).orderBy("id", "asc"),
    db("erp.bom_labour_line").select("size_scope", "size_id", "dept_id", "labour_id", "rate_type", "rate_value").where({ bom_id: bomId }).orderBy("id", "asc"),
    hasBomStageRoutingTable
      ? db("erp.bom_stage_routing")
          .select("stage_id", "sequence_no", "is_required", "enforce_sequence")
          .where({ bom_id: bomId })
          .orderBy("sequence_no", "asc")
      : Promise.resolve([]),
    hasBomSkuOverrideTable
      ? db("erp.bom_sku_override_line")
          .select("sku_id", "target_rm_item_id", "dept_id", "is_excluded", "override_qty", "override_uom_id", "replacement_rm_item_id", "rm_color_id", "rm_size_id", "notes")
          .where({ bom_id: bomId })
          .orderBy("id", "asc")
      : Promise.resolve([]),
  ]);
  return {
    header,
    rm_lines: rmLines,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    stage_routes: stageRoutes,
    variant_rules: [],
    sku_overrides: skuOverrides,
  };
};

const hasPendingApprovalForBomTx = async (db, bomId, options = {}) => {
  const actions = Array.isArray(options.actions) ? options.actions.filter(Boolean) : [];
  let query = db("erp.approval_request")
    .select("id")
    .where({
      entity_type: "BOM",
      entity_id: String(bomId),
      status: "PENDING",
    });
  if (actions.length) {
    query = query.whereIn(db.raw("COALESCE(new_value ->> '_action', '')"), actions);
  }
  const row = await query.first();
  return Boolean(row);
};

const hasPendingApprovalForBomTargetTx = async (db, { bomId = null, itemId = null, actions = [] } = {}) => {
  const normalizedBomId = toPositiveInt(bomId);
  const normalizedItemId = toPositiveInt(itemId);
  const normalizedActions = Array.isArray(actions) ? actions.filter(Boolean) : [];
  if (!normalizedBomId && !normalizedItemId) return false;

  let query = db("erp.approval_request as ar")
    .select("ar.id")
    .where({
      "ar.entity_type": "BOM",
      "ar.status": "PENDING",
    });

  if (normalizedActions.length) {
    query = query.whereIn(db.raw("COALESCE(ar.new_value ->> '_action', '')"), normalizedActions);
  }

  if (normalizedBomId) {
    query = query.andWhere("ar.entity_id", String(normalizedBomId));
  }

  if (normalizedItemId) {
    query = query
      .joinRaw("JOIN erp.bom_header bh ON ar.entity_id ~ '^[0-9]+$' AND bh.id = ar.entity_id::bigint")
      .andWhere("bh.item_id", normalizedItemId);
  }

  const row = await query.first();
  return Boolean(row);
};

const setBomPendingTx = async (trx, { bomId, t }) => {
  const id = Number(bomId);
  const row = await trx("erp.bom_header").select("id", "status").where({ id }).first();
  if (!row) throw makeValidationError(t("error_not_found") || "Record not found.");
  if (row.status === "PENDING") return { id, status: "PENDING" };
  if (row.status !== "DRAFT") {
    throw makeValidationError(t("bom_error_approve_requires_draft") || "Only draft BOM can be approved.");
  }
  await trx("erp.bom_header")
    .where({ id })
    .update({
      status: "PENDING",
      approved_by: null,
      approved_at: null,
    });
  return { id, status: "PENDING" };
};

const setBomPending = async (knex, params) => knex.transaction((trx) => setBomPendingTx(trx, params));

const toggleBomLifecycleTx = async (trx, { bomId, isActive, t }) => {
  const lifecycleSupported = await hasBomLifecycleColumn(trx);
  if (!lifecycleSupported) {
    throw makeValidationError(
      t("bom_error_lifecycle_not_available") || "BOM lifecycle is not available in this environment.",
    );
  }
  const id = Number(bomId);
  const nextActive = Boolean(isActive);
  const row = await trx("erp.bom_header as bh")
    .select("bh.id", "bh.is_active", "bh.item_id", "bh.level", "bh.status", "i.is_active as item_is_active")
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .where("bh.id", id)
    .first();
  if (!row) throw makeValidationError(t("error_not_found") || "Record not found.");
  if (String(row.status || "").toUpperCase() !== "APPROVED") {
    throw makeValidationError(
      t("bom_error_lifecycle_requires_approved") || "Only approved BOM can be activated or deactivated.",
    );
  }
  if (nextActive && !row.item_is_active) {
    throw makeValidationError(
      t("bom_error_item_inactive_cannot_activate") || "Cannot activate BOM while the article is inactive.",
    );
  }
  if (nextActive) {
    await trx("erp.bom_header")
      .where({
        item_id: row.item_id,
        level: row.level,
        status: "APPROVED",
      })
      .andWhereNot({ id })
      .update({ is_active: false });
  }
  await trx("erp.bom_header")
    .where({ id })
    .update({ is_active: nextActive });
  return { id, is_active: nextActive };
};

const toggleBomLifecycle = async (knex, params) => knex.transaction((trx) => toggleBomLifecycleTx(trx, params));

const deleteDraftBomTx = async (trx, { bomId, userId, isAdmin = false, t }) => {
  const id = toPositiveInt(bomId);
  if (!id) throw makeValidationError(t("error_not_found") || "Record not found.");
  const actorId = toPositiveInt(userId);
  const row = await trx("erp.bom_header")
    .select("id", "status", "created_by")
    .where({ id })
    .first();
  if (!row) throw makeValidationError(t("error_not_found") || "Record not found.");
  if (String(row.status || "").toUpperCase() !== "DRAFT") {
    throw makeValidationError(t("bom_error_only_draft_editable") || "Only draft BOM can be edited.");
  }
  if (!isAdmin && actorId && Number(row.created_by || 0) !== actorId) {
    throw makeValidationError(t("error_not_found") || "Record not found.");
  }
  const pendingDecisionExists = await hasPendingApprovalForBomTx(trx, id, {
    actions: ["approve_draft", "delete_draft"],
  });
  if (pendingDecisionExists) {
    throw makeValidationError(t("bom_error_already_pending") || "A pending approval already exists for this BOM.", [
      { field: "item_id", message: t("bom_error_already_pending") || "A pending approval already exists for this BOM." },
    ]);
  }
  await trx("erp.approval_request")
    .where({
      entity_type: "BOM",
      entity_id: String(id),
      status: "PENDING",
    })
    .del();
  await trx("erp.bom_header").where({ id }).del();
  return { id, deleted: true };
};

const deleteDraftBom = async (knex, params) => knex.transaction((trx) => deleteDraftBomTx(trx, params));

const validateDraftReadyForApproval = async (db, { bomId, t, locale = "en", intent = "send" } = {}) => {
  const resolveText = (key, fallback) => {
    if (typeof t !== "function") return fallback;
    const translated = String(t(key) || "").trim();
    if (!translated || translated === key) return fallback;
    return translated;
  };
  const id = Number(bomId);
  if (!id) {
    throw makeValidationError((t && t("error_not_found")) || "BOM not found.");
  }
  const form = await getBomForForm(db, id);
  if (!form || !form.header) {
    throw makeValidationError((t && t("error_not_found")) || "BOM not found.");
  }
  if (String(form.header.status || "").toUpperCase() !== "DRAFT") {
    throw makeValidationError((t && t("bom_error_approve_requires_draft")) || "Only draft BOM can be approved.");
  }

  const details = [];
  const isApproveIntent = String(intent || "send").toLowerCase() === "approve";
  const itemId = toNumberOrNull(form.header.item_id);
  if (!itemId) {
    throw makeValidationError((t && t("bom_error_item_required")) || "Please select an item.");
  }

  const [itemRow, options] = await Promise.all([
    db("erp.items").select("id", "item_type", "uses_sfg").where({ id: itemId }).first(),
    loadFormOptions(db, locale, { includeItemId: itemId }),
  ]);
  const hasBomSkuOverrideTable = await tableExists(db, "erp.bom_sku_override_line");

  const skuRows = Array.isArray(options?.itemSkuMap?.[String(itemId)])
    ? options.itemSkuMap[String(itemId)].filter((sku) => toNumberOrNull(sku?.size_id))
    : [];
  const rmLines = toArray(form.rm_lines)
    .map((line) => ({
      rm_item_id: toNumberOrNull(line?.rm_item_id),
      dept_id: toNumberOrNull(line?.dept_id),
      qty: toNumberOrNull(line?.qty),
    }))
    .filter((line) => line.rm_item_id && line.dept_id);
  if (hasBomSkuOverrideTable && rmLines.length && skuRows.length) {
    const skuRuleRows = await db("erp.bom_sku_override_line")
      .select("sku_id", "target_rm_item_id", "dept_id", "override_qty")
      .where({ bom_id: id, is_excluded: false });
    const providedPairSet = new Set();
    (skuRuleRows || []).forEach((line) => {
      const skuId = toNumberOrNull(line?.sku_id);
      const rmItemId = toNumberOrNull(line?.target_rm_item_id);
      const deptId = toNumberOrNull(line?.dept_id);
      const qty = toNumberOrNull(line?.override_qty);
      if (!skuId || !rmItemId || !deptId || qty === null || qty < 0) return;
      providedPairSet.add(`${skuId}:${rmItemId}:${deptId}`);
    });
    const missingPairs = [];
    skuRows.forEach((sku) => {
      const skuId = toNumberOrNull(sku?.id);
      if (!skuId) return;
      rmLines.forEach((rmLine) => {
        const rmItemId = toNumberOrNull(rmLine?.rm_item_id);
        const deptId = toNumberOrNull(rmLine?.dept_id);
        if (!rmItemId || !deptId) return;
        const pairKey = `${skuId}:${rmItemId}:${deptId}`;
        if (!providedPairSet.has(pairKey)) {
          missingPairs.push({ skuId, rmItemId, deptId });
        }
      });
    });
    if (missingPairs.length) {
      const skuCodeById = new Map(
        (options?.itemSkuMap?.[String(itemId)] || []).map((row) => [toNumberOrNull(row?.id), String(row?.sku_code || row?.id || "").trim()]),
      );
      const rmNameById = new Map((options?.rmItems || []).map((row) => [toNumberOrNull(row?.id), String(row?.name || row?.id || "").trim()]));
      const sample = missingPairs
        .slice(0, 12)
        .map((pair) => `${skuCodeById.get(pair.skuId) || `SKU ${pair.skuId}`} / ${rmNameById.get(pair.rmItemId) || `RM ${pair.rmItemId}`} / Dept ${pair.deptId}`)
        .join(", ");
      const suffix = missingPairs.length > 12 ? ` (+${missingPairs.length - 12})` : "";
      details.push({
        field: "sku_rules_json",
        message: `Issue in Raw Materials / SKU Rules section: ${
          isApproveIntent
            ? resolveText("bom_error_approval_missing_sku_rules_approve", "Complete all SKU Rules rows (quantity and required color variant) before approval.")
            : resolveText("bom_error_approval_missing_sku_rules", "Complete all SKU Rules rows (quantity and required color variant) before sending for approval.")
        }${sample ? ` Missing: ${sample}${suffix}.` : ""}`,
      });
    }
  } else {
    const incompleteRmRows = rmLines.filter((line) => !Number.isFinite(Number(line.qty)) || Number(line.qty) < 0);
    if (incompleteRmRows.length) {
      details.push({
        field: "sku_rules_json",
        message: `Issue in Raw Materials / SKU Rules section: ${
          isApproveIntent
            ? resolveText("bom_error_approval_missing_sku_rules_approve", "Complete all SKU Rules rows (quantity and required color variant) before approval.")
            : resolveText("bom_error_approval_missing_sku_rules", "Complete all SKU Rules rows (quantity and required color variant) before sending for approval.")
        }`,
      });
    }
  }
  const labourDeptIds = toArray(form.labour_lines)
    .map((line) => toNumberOrNull(line?.dept_id))
    .filter(Boolean);
  const departmentsUsedInBom = [...new Set([
    ...rmLines.map((line) => toNumberOrNull(line?.dept_id)).filter(Boolean),
    ...labourDeptIds,
  ])];
  const [hasProductionStageTable, hasBomStageRoutingTable] = await Promise.all([
    tableExists(db, "erp.production_stages"),
    tableExists(db, "erp.bom_stage_routing"),
  ]);
  if (departmentsUsedInBom.length && hasProductionStageTable && hasBomStageRoutingTable) {
    const stageRouteIds = [...new Set(
      toArray(form.stage_routes)
        .map((line) => toPositiveInt(line?.stage_id))
        .filter(Boolean),
    )];
    const stageRows = stageRouteIds.length
      ? await db("erp.production_stages")
          .select("id", "dept_id", "is_active")
          .whereIn("id", stageRouteIds)
      : [];
    const stageDeptSet = new Set(
      (stageRows || [])
        .filter((row) => row?.is_active === true)
        .map((row) => toNumberOrNull(row?.dept_id))
        .filter(Boolean),
    );
    const missingDeptIds = departmentsUsedInBom.filter((deptId) => !stageDeptSet.has(deptId));
    if (missingDeptIds.length) {
      const deptRows = await db("erp.departments")
        .select("id", "name")
        .whereIn("id", missingDeptIds);
      const deptNameById = new Map(
        (deptRows || []).map((row) => [toNumberOrNull(row?.id), String(row?.name || row?.id || "").trim()]),
      );
      const sample = missingDeptIds
        .slice(0, 12)
        .map((deptId) => deptNameById.get(deptId) || `Dept ${deptId}`)
        .join(", ");
      const suffix = missingDeptIds.length > 12 ? ` (+${missingDeptIds.length - 12})` : "";
      details.push({
        field: "stage_routes_json",
        message:
          `Issue in Production Stages section: ${
            isApproveIntent
              ? resolveText("bom_error_stage_department_scope_approve", "Every department used in Raw Materials and Labour must be added in Production Stages before approval.")
              : resolveText("bom_error_stage_department_scope", "Every department used in Raw Materials and Labour must be added in Production Stages before sending for approval.")
          }`
          + (sample ? ` Missing departments: ${sample}${suffix}.` : ""),
      });
    }
  }

  const getSkuLabel = (sku) => {
    const parts = [];
    if (sku?.size_name) parts.push(sku.size_name);
    if (sku?.color_name) parts.push(sku.color_name);
    if (sku?.packing_name) parts.push(sku.packing_name);
    if (sku?.grade_name) parts.push(sku.grade_name);
    return parts.length ? `(${parts.join(" ")})` : `SKU ${sku?.id || ""}`.trim();
  };

  if (String(form.header.level || "").toUpperCase() === "FINISHED" && String(itemRow?.item_type || "").toUpperCase() === "FG" && Boolean(itemRow?.uses_sfg)) {
    const sfgRowsForApproval = toArray(form.sfg_lines)
      .map((line, idx) => ({
        rowIndex: idx + 1,
        fg_size_id: toNumberOrNull(line?.fg_size_id),
        sfg_sku_id: toNumberOrNull(line?.sfg_sku_id),
        required_qty: toPositiveNumber(line?.required_qty),
        consumed_in_stage_id: toPositiveInt(line?.consumed_in_stage_id),
      }))
      .filter((line) => line.fg_size_id && line.sfg_sku_id && line.required_qty && line.consumed_in_stage_id);
    const validSfgBySize = new Set(
      sfgRowsForApproval.map((line) => String(line.fg_size_id)),
    );
    const missingSfgSkus = skuRows.filter((sku) => !validSfgBySize.has(String(sku.size_id)));
    if (missingSfgSkus.length) {
      const sample = missingSfgSkus.slice(0, 12).map((sku) => getSkuLabel(sku)).join(", ");
      const suffix = missingSfgSkus.length > 12 ? ` (+${missingSfgSkus.length - 12})` : "";
      details.push({
        field: "sfg_lines_json",
        message:
          `Issue in Semi-Finished section: ${
            isApproveIntent
              ? resolveText("bom_error_approval_missing_sfg_rows_approve", "Complete all Semi-Finished rows for every Article SKU before approval.")
              : resolveText("bom_error_approval_missing_sfg_rows", "Complete all Semi-Finished rows for every Article SKU before sending for approval.")
          }`
          + (sample ? ` ${sample}${suffix}` : ""),
      });
    }

    const selectedSfgSkuIds = [...new Set(sfgRowsForApproval.map((line) => line.sfg_sku_id).filter(Boolean))];
    if (selectedSfgSkuIds.length) {
      const selectedSfgSkuRows = await db("erp.skus as s")
        .select("s.id", "s.sku_code", "v.item_id")
        .leftJoin("erp.variants as v", "s.variant_id", "v.id")
        .whereIn("s.id", selectedSfgSkuIds);
      const skuRowById = new Map(selectedSfgSkuRows.map((row) => [toNumberOrNull(row.id), row]));
      const itemApprovedBomMap = new Map();
      const sfgItemIds = [...new Set(
        selectedSfgSkuRows
          .map((row) => toNumberOrNull(row?.item_id))
          .filter(Boolean),
      )];
      if (sfgItemIds.length) {
        const approvedRows = await db("erp.bom_header")
          .select("id", "item_id", "version_no")
          .whereIn("item_id", sfgItemIds)
          .andWhere("status", "APPROVED")
          .orderBy("item_id", "asc")
          .orderBy("version_no", "desc")
          .orderBy("id", "desc");
        approvedRows.forEach((row) => {
          const itemId = toNumberOrNull(row?.item_id);
          if (!itemId || itemApprovedBomMap.has(itemId)) return;
          itemApprovedBomMap.set(itemId, toNumberOrNull(row?.id) || null);
        });
      }
      sfgRowsForApproval.forEach((line) => {
        const skuRow = skuRowById.get(line.sfg_sku_id);
        const itemId = toNumberOrNull(skuRow?.item_id);
        const hasApprovedBom = Boolean(itemId && itemApprovedBomMap.get(itemId));
        if (hasApprovedBom) return;
        const skuLabel = String(skuRow?.sku_code || line.sfg_sku_id || "").trim();
        details.push({
          field: "sfg_lines_json",
          message: `Issue in Semi-Finished section: Row ${line.rowIndex}: ${resolveText("bom_error_sfg_requires_approved_bom", "Selected SFG item has no approved BOM.")}${skuLabel ? ` SKU: ${skuLabel}.` : ""}`,
        });
      });
    }
  }

  // Advanced RM rules are disabled; approval readiness checks only material/SFG/labour sections.

  if (details.length) {
    throw makeValidationError(
      isApproveIntent
        ? resolveText("bom_error_approve_blocked", "BOM cannot be approved yet. Resolve the issues below.")
        : resolveText("bom_error_approval_blocked", "BOM cannot be sent for approval yet. Resolve the issues below."),
      details,
    );
  }
  return true;
};

const saveBomDraftTx = async (trx, { input, bomId, userId, requestId, t }) => {
  const normalized = await validateAndNormalizeInput(trx, input, t, {
    enforceSkuRuleCompleteness: false,
    actorUserId: userId || null,
  });
  const lifecycleSupported = await hasBomLifecycleColumn(trx);
  const actorId = userId || null;
  const existingId = bomId ? Number(bomId) : null;
  const before = existingId ? await getBomSnapshot(trx, existingId) : null;

  await ensureDraftUniqueness(trx, {
    itemId: normalized.header.item_id,
    level: normalized.header.level,
    excludeId: existingId,
    createdBy: actorId,
    t,
  });

  let targetId = existingId;
  let versionNo = 1;
  let bomNo = null;

  if (!existingId) {
    await ensureNoExistingBomForItem(trx, {
      itemId: normalized.header.item_id,
      level: normalized.header.level,
      excludeId: null,
      t,
    });

    const maxVersionRow = await trx("erp.bom_header")
      .where({
        item_id: normalized.header.item_id,
        level: normalized.header.level,
      })
      .max("version_no as max")
      .first();
    versionNo = Number(maxVersionRow?.max || 0) + 1;
    bomNo = await nextBomNo(trx);
    const insertPayload = {
      bom_no: bomNo,
      item_id: normalized.header.item_id,
      level: normalized.header.level,
      output_qty: normalized.header.output_qty,
      output_uom_id: normalized.header.output_uom_id,
      status: "DRAFT",
      version_no: versionNo,
      created_by: actorId,
    };
    if (lifecycleSupported) insertPayload.is_active = true;
    const inserted = await trx("erp.bom_header")
      .insert(insertPayload)
      .returning(["id", "version_no", "bom_no"]);
    const row = inserted?.[0] || inserted;
    targetId = row?.id || row;
    versionNo = Number(row?.version_no || versionNo);
    bomNo = row?.bom_no || bomNo;
  } else {
    const current = await trx("erp.bom_header").select("id", "version_no", "bom_no", "status").where({ id: existingId }).first();
    if (!current) {
      throw makeValidationError(t("error_not_found") || "Record not found.");
    }
    const pendingDecisionExists = await hasPendingApprovalForBomTx(trx, existingId, {
      actions: ["approve_draft"],
    });
    if (pendingDecisionExists) {
      throw makeValidationError(t("bom_error_already_pending") || "A pending approval already exists for this BOM.", [
        { field: "item_id", message: t("bom_error_already_pending") || "A pending approval already exists for this BOM." },
      ]);
    }
    if (current.status !== "DRAFT") {
      throw makeValidationError(t("bom_error_only_draft_editable") || "Only draft BOM can be edited.");
    }
    versionNo = Number(current.version_no || 1);
    bomNo = current.bom_no;
    await trx("erp.bom_header")
      .where({ id: existingId })
      .update({
        item_id: normalized.header.item_id,
        level: normalized.header.level,
        output_qty: normalized.header.output_qty,
        output_uom_id: normalized.header.output_uom_id,
      });
  }

  await replaceBomLines(trx, targetId, normalized);
  const after = await getBomSnapshot(trx, targetId);
  await insertBomChangeLog(trx, {
    bomId: targetId,
    versionNo,
    requestId,
    changedBy: actorId,
    before,
    after,
  });

  debugBom("saveBomDraftTx success", { targetId, versionNo, bomNo });
  return { id: targetId, versionNo, bomNo, status: "DRAFT" };
};

const saveBomDraft = async (knex, params) => {
  try {
    return await knex.transaction((trx) => saveBomDraftTx(trx, params));
  } catch (err) {
    const isUniqueViolation = err?.code === "23505";
    const constraint = String(err?.constraint || "");
    const messageText = String(err?.message || "");
    const hasConstraint = (key) => constraint.includes(key) || messageText.includes(key);
    if (isUniqueViolation) {
      if (hasConstraint("ux_bom_header_single_draft")) {
        throw makeValidationError((params?.t && params.t("bom_error_draft_exists")) || "A draft already exists for this item and level.", [
          { field: "item_id", message: (params?.t && params.t("bom_error_draft_exists")) || "A draft already exists for this item and level." },
        ]);
      }
      if (hasConstraint("bom_stage_routing_bom_id_stage_id_key")) {
        throw makeValidationError((params?.t && params.t("bom_error_fix_fields")) || "Please fix the following validation issues before saving BOM.", [
          {
            field: "stage_routes_json",
            message: `Issue in Production Stages section: ${(params?.t && params.t("bom_error_stage_duplicate_in_flow")) || "This production department/stage is already added in flow."}`,
          },
        ]);
      }
      if (hasConstraint("bom_stage_routing_bom_id_sequence_no_key")) {
        throw makeValidationError((params?.t && params.t("bom_error_fix_fields")) || "Please fix the following validation issues before saving BOM.", [
          {
            field: "stage_routes_json",
            message: `Issue in Production Stages section: ${(params?.t && params.t("bom_error_stage_sequence_duplicate")) || "Duplicate sequence is not allowed in production flow."}`,
          },
        ]);
      }
      if (
        hasConstraint("production_stages_name_key")
        || hasConstraint("production_stages_code_key")
        || hasConstraint("uq_production_stages_active_dept")
      ) {
        throw makeValidationError((params?.t && params.t("bom_error_fix_fields")) || "Please fix the following validation issues before saving BOM.", [
          {
            field: "stage_routes_json",
            message: `Issue in Production Stages section: ${(params?.t && params.t("bom_error_stage_mapping_sync_conflict")) || "Production stage mapping sync failed due duplicate stage master data. Please retry save."}`,
          },
        ]);
      }
      if (hasConstraint("bom_rm_line_bom_id_rm_item_id_dept_id_color_id_size_id_key")) {
        throw makeValidationError((params?.t && params.t("bom_error_rm_department_duplicate")) || "This material is already added for the selected consumption department. Use a different material or department.", [
          { field: "rm_lines_json", message: (params?.t && params.t("bom_error_rm_department_duplicate")) || "This material is already added for the selected consumption department. Use a different material or department." },
        ]);
      }
      if (hasConstraint("bom_sfg_line_bom_id_fg_size_id_sfg_sku_id_key")) {
        throw makeValidationError((params?.t && params.t("bom_error_fix_fields")) || "Please fix the following validation issues before saving BOM.", [
          {
            field: "sfg_lines_json",
            message: `Issue in Semi-Finished section: ${(params?.t && params.t("bom_error_sfg_duplicate_line")) || "Duplicate Semi-Finished line is not allowed."}`,
          },
        ]);
      }
      if (hasConstraint("bom_labour_line_bom_id_dept_id_labour_id_size_scope_size_id_rate_type_key")) {
        throw makeValidationError((params?.t && params.t("bom_error_labour_department_duplicate")) || "This labour is already added for the selected department. Choose a different labour or department.", [
          { field: "labour_lines_json", message: (params?.t && params.t("bom_error_labour_department_duplicate")) || "This labour is already added for the selected department. Choose a different labour or department." },
        ]);
      }
    }
    throw err;
  }
};

const approveBomDirectTx = async (trx, { bomId, userId, requestId, t }) => {
  const lifecycleSupported = await hasBomLifecycleColumn(trx);
  const id = Number(bomId);
  const row = await trx("erp.bom_header").select("id", "status", "version_no", "item_id", "level").where({ id }).first();
  if (!row) throw makeValidationError(t("error_not_found") || "Record not found.");
  if (row.status === "APPROVED") return { id, status: "APPROVED", versionNo: row.version_no };
  if (!["DRAFT", "PENDING"].includes(row.status)) {
    throw makeValidationError(t("bom_error_approve_requires_draft") || "Only draft BOM can be approved.");
  }

  const before = await getBomSnapshot(trx, id);
  if (lifecycleSupported) {
    await trx("erp.bom_header")
      .where({
        item_id: row.item_id,
        level: row.level,
        status: "APPROVED",
      })
      .andWhereNot({ id })
      .update({ is_active: false });
  }
  await trx("erp.bom_header")
    .where({ id })
    .update({
      status: "APPROVED",
      approved_by: userId || null,
      approved_at: trx.fn.now(),
      ...(lifecycleSupported ? { is_active: true } : {}),
    });
  const after = await getBomSnapshot(trx, id);
  await insertBomChangeLog(trx, {
    bomId: id,
    versionNo: row.version_no,
    requestId,
    changedBy: userId || null,
    before,
    after,
  });
  return { id, status: "APPROVED", versionNo: row.version_no };
};

const approveBomDirect = async (knex, params) => knex.transaction((trx) => approveBomDirectTx(trx, params));

const createNewVersionFromApprovedTx = async (trx, { sourceBomId, userId, t }) => {
  const lifecycleSupported = await hasBomLifecycleColumn(trx);
  const sourceId = Number(sourceBomId);
  const sourceFields = ["id", "item_id", "level", "output_qty", "output_uom_id", "status"];
  if (lifecycleSupported) sourceFields.push("is_active");
  const source = await trx("erp.bom_header").select(sourceFields).where({ id: sourceId }).first();
  if (!source) throw makeValidationError(t("error_not_found") || "Record not found.");
  if (source.status !== "APPROVED") {
    throw makeValidationError(t("bom_error_new_version_requires_approved") || "New version can only be created from an approved BOM.");
  }

  await trx.raw("SELECT id FROM erp.bom_header WHERE item_id = ? AND level = ? FOR UPDATE", [source.item_id, source.level]);
  await ensureDraftUniqueness(trx, {
    itemId: source.item_id,
    level: source.level,
    excludeId: null,
    createdBy: userId || null,
    t,
  });

  const maxVersionRow = await trx("erp.bom_header")
    .where({ item_id: source.item_id, level: source.level })
    .max("version_no as max")
    .first();
  const versionNo = Number(maxVersionRow?.max || 0) + 1;
  const bomNo = await nextBomNo(trx);
  const insertPayload = {
    bom_no: bomNo,
    item_id: source.item_id,
    level: source.level,
    output_qty: source.output_qty,
    output_uom_id: source.output_uom_id,
    status: "DRAFT",
    version_no: versionNo,
    created_by: userId || null,
  };
  if (lifecycleSupported) insertPayload.is_active = source.is_active !== false;
  const inserted = await trx("erp.bom_header")
    .insert(insertPayload)
    .returning("id");
  const newBomId = inserted?.[0]?.id || inserted?.[0];

  const hasBomStageRoutingTable = await tableExists(trx, "erp.bom_stage_routing");
  const hasBomSkuOverrideTable = await tableExists(trx, "erp.bom_sku_override_line");
  const [rmLines, sfgLines, labourLines, stageRoutes, skuOverrides] = await Promise.all([
    trx("erp.bom_rm_line").select("rm_item_id", "color_id", "size_id", "dept_id", "qty", "uom_id", "normal_loss_pct").where({ bom_id: sourceId }),
    trx("erp.bom_sfg_line").select("fg_size_id", "sfg_sku_id", "required_qty", "uom_id", "consumed_in_stage_id", "ref_approved_bom_id").where({ bom_id: sourceId }),
    trx("erp.bom_labour_line").select("size_scope", "size_id", "dept_id", "labour_id", "rate_type", "rate_value").where({ bom_id: sourceId }),
    hasBomStageRoutingTable
      ? trx("erp.bom_stage_routing")
          .select("stage_id", "sequence_no", "is_required", "enforce_sequence")
          .where({ bom_id: sourceId })
          .orderBy("sequence_no", "asc")
      : Promise.resolve([]),
    hasBomSkuOverrideTable
      ? trx("erp.bom_sku_override_line")
          .select("sku_id", "target_rm_item_id", "dept_id", "is_excluded", "override_qty", "override_uom_id", "replacement_rm_item_id", "rm_color_id", "rm_size_id", "notes")
          .where({ bom_id: sourceId })
          .orderBy("id", "asc")
      : Promise.resolve([]),
  ]);

  await replaceBomLines(trx, newBomId, {
    rm_lines: rmLines,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    stage_routes: stageRoutes,
    variant_rules: [],
    sku_overrides: skuOverrides,
  });

  const after = await getBomSnapshot(trx, newBomId);
  await insertBomChangeLog(trx, {
    bomId: newBomId,
    versionNo,
    requestId: null,
    changedBy: userId || null,
    before: null,
    after,
  });

  return { id: newBomId, versionNo, bomNo };
};

const createNewVersionFromApproved = async (knex, params) => knex.transaction((trx) => createNewVersionFromApprovedTx(trx, params));

const hasPendingApprovalForBom = async (knex, bomId, options = {}) => hasPendingApprovalForBomTx(knex, bomId, options);
const hasPendingApprovalForBomTarget = async (knex, params = {}) => hasPendingApprovalForBomTargetTx(knex, params);
const findDraftBomByItemLevel = async (knex, { itemId, level, excludeBomId = null, createdBy = null } = {}) => {
  const normalizedItemId = toNumberOrNull(itemId);
  const normalizedLevel = String(level || "").trim().toUpperCase();
  const normalizedCreatedBy = toPositiveInt(createdBy);
  if (!normalizedItemId || !BOM_LEVELS.has(normalizedLevel)) return null;
  let query = knex("erp.bom_header")
    .select("id")
    .where({
      item_id: normalizedItemId,
      level: normalizedLevel,
      status: "DRAFT",
    })
    .orderBy("id", "desc");
  if (normalizedCreatedBy) query = query.andWhere("created_by", normalizedCreatedBy);
  if (toNumberOrNull(excludeBomId)) {
    query = query.whereNot("id", toNumberOrNull(excludeBomId));
  }
  const row = await query.first();
  return toNumberOrNull(row?.id);
};

const loadFormOptions = async (knex, locale = "en", options = {}) => {
  const useUr = locale === "ur";
  const excludeExistingBomItems = Boolean(options?.excludeExistingBomItems);
  const includeItemId = toNumberOrNull(options?.includeItemId);
  const requesterUserId = toPositiveInt(options?.requesterUserId);
  const [hasLabourDeptTable, hasSizeItemTypesTable, hasUomConversionsTable, hasLabourRateRulesTable, hasProductionStagesTable] = await Promise.all([
    tableExists(knex, "erp.labour_department"),
    tableExists(knex, "erp.size_item_types"),
    tableExists(knex, "erp.uom_conversions"),
    tableExists(knex, "erp.labour_rate_rules"),
    tableExists(knex, "erp.production_stages"),
  ]);
  const [
    hasLabourRateRuleStatusColumn,
    hasLabourRateRuleAppliesToAllLaboursColumn,
    hasLabourRateRuleArticleTypeColumn,
  ] = hasLabourRateRulesTable
    ? await Promise.all([
        knex.schema.withSchema("erp").hasColumn("labour_rate_rules", "status"),
        knex.schema.withSchema("erp").hasColumn("labour_rate_rules", "applies_to_all_labours"),
        knex.schema.withSchema("erp").hasColumn("labour_rate_rules", "article_type"),
      ])
    : [false, false, false];
  const [itemsRaw, rmItems, uoms, departments, sizes, colors, packings, labours, labourDeptRows, rmRateVariants, sfgSkus, itemSkus, fgSfgVariantDims, sizeItemTypeRows, fgSfgUsageRows, labourRateRuleRows, productionStageRows, existingBomItemRows] = await Promise.all([
    knex("erp.items")
      .select("id", "code", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name", "item_type", "base_uom_id", "uses_sfg", "sfg_part_type", "subgroup_id", "group_id")
      .whereIn("item_type", ["FG", "SFG"])
      .andWhere({ is_active: true })
      .orderBy("name", "asc"),
    knex("erp.items")
      .select("id", "code", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name", "base_uom_id")
      .where({ item_type: "RM", is_active: true })
      .orderBy("name", "asc"),
    knex("erp.uom").select("id", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name").where({ is_active: true }).orderBy("name", "asc"),
    knex("erp.departments")
      .select("id", "is_production", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name")
      .where({ is_active: true })
      .orderBy("name", "asc"),
    knex("erp.sizes").select("id", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name").where({ is_active: true }).orderBy("name", "asc"),
    knex("erp.colors").select("id", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name").where({ is_active: true }).orderBy("name", "asc"),
    knex("erp.packing_types").select("id", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name").where({ is_active: true }).orderBy("name", "asc"),
    knex("erp.labours")
      .select("id", "code", "dept_id", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name")
      .whereRaw("lower(trim(status)) = 'active'")
      .orderBy("name", "asc"),
    hasLabourDeptTable
      ? knex("erp.labour_department as ld")
          .select("ld.labour_id", "ld.dept_id")
          .join("erp.departments as d", "d.id", "ld.dept_id")
          .where({ "d.is_active": true, "d.is_production": true })
      : Promise.resolve([]),
    knex("erp.rm_purchase_rates as r")
      .select(
        "r.rm_item_id",
        "r.color_id",
        "r.size_id",
        useUr ? knex.raw("COALESCE(c.name_ur, c.name) as color_name") : "c.name as color_name",
        useUr ? knex.raw("COALESCE(s.name_ur, s.name) as size_name") : "s.name as size_name",
      )
      .leftJoin("erp.colors as c", "c.id", "r.color_id")
      .leftJoin("erp.sizes as s", "s.id", "r.size_id")
      .where("r.is_active", true),
    knex("erp.skus as s")
      .select(
        "s.id",
        "s.sku_code",
        useUr ? knex.raw("COALESCE(i.name_ur, i.name) as item_name") : "i.name as item_name",
        "i.id as item_id",
        "i.base_uom_id as base_uom_id",
        "v.size_id as size_id",
        knex.raw("EXISTS (SELECT 1 FROM erp.bom_header bh WHERE bh.item_id = i.id AND bh.status = 'APPROVED') as has_approved_bom"),
      )
      .leftJoin("erp.variants as v", "s.variant_id", "v.id")
      .leftJoin("erp.items as i", "v.item_id", "i.id")
      .where("i.item_type", "SFG")
      .andWhere("i.is_active", true)
      .andWhere("s.is_active", true)
      .orderBy("has_approved_bom", "desc")
      .orderBy("s.sku_code", "asc"),
    knex("erp.skus as s")
      .select(
        "s.id",
        "s.sku_code",
        "v.item_id",
        "i.item_type as item_type",
        "i.subgroup_id as subgroup_id",
        "i.group_id as group_id",
        "v.size_id",
        "v.grade_id",
        "v.color_id",
        "v.packing_type_id",
        useUr ? knex.raw("COALESCE(sz.name_ur, sz.name) as size_name") : "sz.name as size_name",
        useUr ? knex.raw("COALESCE(gr.name_ur, gr.name) as grade_name") : "gr.name as grade_name",
        useUr ? knex.raw("COALESCE(c.name_ur, c.name) as color_name") : "c.name as color_name",
        useUr ? knex.raw("COALESCE(pt.name_ur, pt.name) as packing_name") : "pt.name as packing_name",
      )
      .leftJoin("erp.variants as v", "s.variant_id", "v.id")
      .leftJoin("erp.items as i", "v.item_id", "i.id")
      .leftJoin("erp.sizes as sz", "sz.id", "v.size_id")
      .leftJoin("erp.grades as gr", "gr.id", "v.grade_id")
      .leftJoin("erp.colors as c", "c.id", "v.color_id")
      .leftJoin("erp.packing_types as pt", "pt.id", "v.packing_type_id")
      .whereIn("i.item_type", ["FG", "SFG"])
      .andWhere("i.is_active", true)
      .andWhere("s.is_active", true)
      .orderBy("s.sku_code", "asc"),
    knex("erp.variants as v")
      .select("v.item_id", "v.size_id", "v.color_id")
      .leftJoin("erp.items as i", "v.item_id", "i.id")
      .whereIn("i.item_type", ["FG", "SFG"])
      .andWhere("v.is_active", true),
    hasSizeItemTypesTable
      ? knex("erp.size_item_types")
          .select("size_id")
          .whereIn("item_type", ["FG", "SFG"])
      : Promise.resolve([]),
    knex("erp.item_usage")
      .select("fg_item_id", "sfg_item_id"),
    hasLabourRateRulesTable
      ? (() => {
          let query = knex("erp.labour_rate_rules as r")
            .select(
              "r.id",
              "r.labour_id",
              "r.dept_id",
              "r.apply_on",
              "r.sku_id",
              "r.subgroup_id",
              "r.group_id",
              "r.rate_type",
              "r.rate_value",
              hasLabourRateRuleArticleTypeColumn ? "r.article_type" : knex.raw("NULL::text as article_type"),
            )
            .leftJoin("erp.labours as l", "l.id", "r.labour_id")
            .leftJoin("erp.departments as d", "d.id", "r.dept_id")
            .whereNotNull("r.labour_id")
            .whereRaw("lower(trim(COALESCE(l.status, ''))) = 'active'")
            .andWhere("d.is_active", true)
            .andWhere("d.is_production", true);
          if (hasLabourRateRuleStatusColumn) {
            query = query.whereRaw("lower(trim(COALESCE(r.status, ''))) = 'active'");
          }
          if (hasLabourRateRuleAppliesToAllLaboursColumn) {
            query = query.andWhere("r.applies_to_all_labours", false);
          }
          return query;
        })()
      : Promise.resolve([]),
    hasProductionStagesTable
      ? knex("erp.production_stages as ps")
          .leftJoin("erp.departments as d", "d.id", "ps.dept_id")
          .select(
            "ps.id",
            "ps.code",
            "ps.dept_id",
            useUr ? knex.raw("COALESCE(ps.name_ur, ps.name) as name") : "ps.name as name",
            useUr ? knex.raw("COALESCE(d.name_ur, d.name) as dept_name") : "d.name as dept_name",
          )
          .where("ps.is_active", true)
          .andWhere("d.is_active", true)
          .andWhere("d.is_production", true)
          .orderBy("ps.name", "asc")
      : Promise.resolve([]),
    excludeExistingBomItems
      ? knex("erp.bom_header")
          .distinct("item_id")
          .whereNotNull("item_id")
          .where((builder) => {
            builder.whereIn("status", ["APPROVED", "PENDING"]);
            if (requesterUserId) {
              builder.orWhere((draftBuilder) => {
                draftBuilder.where("status", "DRAFT").andWhere("created_by", requesterUserId);
              });
            }
          })
      : Promise.resolve([]),
  ]);

  const existingBomItemIds = new Set(
    (existingBomItemRows || []).map((row) => Number(row?.item_id)).filter(Boolean),
  );
  const items = (itemsRaw || []).filter((item) => {
    const itemId = Number(item?.id);
    if (!itemId) return false;
    if (!excludeExistingBomItems) return true;
    if (includeItemId && itemId === includeItemId) return true;
    return !existingBomItemIds.has(itemId);
  });

  const strictProductionDeptSet = new Set(
    (departments || [])
      .filter((row) => row?.is_production === true)
      .map((row) => Number(row.id))
      .filter(Boolean),
  );
  const fallbackActiveDeptSet = new Set((departments || []).map((row) => Number(row.id)).filter(Boolean));
  const productionDeptSet = strictProductionDeptSet.size ? strictProductionDeptSet : fallbackActiveDeptSet;
  const labourDeptMap = {};
  (labours || []).forEach((labour) => {
    labourDeptMap[String(labour.id)] = [];
  });
  (labourDeptRows || []).forEach((row) => {
    const labourId = Number(row.labour_id);
    const deptId = Number(row.dept_id);
    if (!labourId || !deptId || !productionDeptSet.has(deptId)) return;
    const key = String(labourId);
    if (!Array.isArray(labourDeptMap[key])) labourDeptMap[key] = [];
    if (!labourDeptMap[key].includes(String(deptId))) labourDeptMap[key].push(String(deptId));
  });
  (labours || []).forEach((labour) => {
    const labourId = Number(labour.id);
    const fallbackDeptId = Number(labour.dept_id);
    if (!labourId || !fallbackDeptId || !productionDeptSet.has(fallbackDeptId)) return;
    const key = String(labourId);
    if (!Array.isArray(labourDeptMap[key])) labourDeptMap[key] = [];
    if (!labourDeptMap[key].includes(String(fallbackDeptId))) labourDeptMap[key].push(String(fallbackDeptId));
  });

  const rmItemColorMap = {};
  const rmItemSizeMap = {};
  (rmRateVariants || []).forEach((row) => {
    const itemId = Number(row.rm_item_id);
    if (!itemId) return;
    const key = String(itemId);
    if (!Array.isArray(rmItemColorMap[key])) rmItemColorMap[key] = [];
    if (!Array.isArray(rmItemSizeMap[key])) rmItemSizeMap[key] = [];
    const colorId = Number(row.color_id);
    const sizeId = Number(row.size_id);
    if (colorId && !rmItemColorMap[key].some((entry) => Number(entry.id) === colorId)) {
      rmItemColorMap[key].push({ id: colorId, name: row.color_name || String(colorId) });
    }
    if (sizeId && !rmItemSizeMap[key].some((entry) => Number(entry.id) === sizeId)) {
      rmItemSizeMap[key].push({ id: sizeId, name: row.size_name || String(sizeId) });
    }
  });
  Object.values(rmItemColorMap).forEach((entries) => entries.sort((a, b) => String(a.name).localeCompare(String(b.name))));
  Object.values(rmItemSizeMap).forEach((entries) => entries.sort((a, b) => String(a.name).localeCompare(String(b.name))));

  const fgSfgSizeIds = new Set();
  const fgSfgColorIds = new Set();
  const sizeNameById = new Map((sizes || []).map((row) => [Number(row.id), row.name]));
  const itemSizeSetMap = new Map();
  (sizeItemTypeRows || []).forEach((row) => {
    const sizeId = Number(row?.size_id);
    if (!sizeId) return;
    fgSfgSizeIds.add(sizeId);
  });
  (fgSfgVariantDims || []).forEach((row) => {
    const itemId = Number(row?.item_id);
    const sizeId = Number(row?.size_id);
    const colorId = Number(row?.color_id);
    if (sizeId) fgSfgSizeIds.add(sizeId);
    if (colorId) fgSfgColorIds.add(colorId);
    if (!itemId || !sizeId) return;
    if (!itemSizeSetMap.has(itemId)) itemSizeSetMap.set(itemId, new Set());
    itemSizeSetMap.get(itemId).add(sizeId);
  });
  const itemSizeMap = {};
  itemSizeSetMap.forEach((sizeSet, itemId) => {
    const rows = [...sizeSet]
      .map((sizeId) => ({ id: sizeId, name: sizeNameById.get(sizeId) || String(sizeId) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    itemSizeMap[String(itemId)] = rows;
  });

  const ruleSizes = (sizes || []).filter((row) => fgSfgSizeIds.has(Number(row.id)));
  const ruleColors = (colors || []).filter((row) => fgSfgColorIds.has(Number(row.id)));
  const fgToSfgMap = {};
  (fgSfgUsageRows || []).forEach((row) => {
    const fgId = Number(row?.fg_item_id);
    const sfgId = Number(row?.sfg_item_id);
    if (!fgId || !sfgId) return;
    const key = String(fgId);
    if (!Array.isArray(fgToSfgMap[key])) fgToSfgMap[key] = [];
    if (!fgToSfgMap[key].includes(String(sfgId))) fgToSfgMap[key].push(String(sfgId));
  });
  // Legacy safety: if explicit FG->SFG usage mapping is missing, infer from generated code pattern.
  const sfgItemIdByCode = new Map(
    (itemsRaw || [])
      .filter((item) => String(item?.item_type || "").toUpperCase() === "SFG")
      .map((item) => [String(item?.code || "").trim().toLowerCase(), Number(item?.id)])
      .filter((entry) => entry[0] && entry[1]),
  );
  (itemsRaw || [])
    .filter((item) => String(item?.item_type || "").toUpperCase() === "FG" && Boolean(item?.uses_sfg))
    .forEach((item) => {
      const fgId = Number(item?.id);
      if (!fgId) return;
      const fgKey = String(fgId);
      if (Array.isArray(fgToSfgMap[fgKey]) && fgToSfgMap[fgKey].length) return;
      const fgCode = String(item?.code || "").trim();
      if (!fgCode) return;
      const partType = String(item?.sfg_part_type || "").trim().toUpperCase();
      const suffixes = partType === "STEP"
        ? ["step"]
        : partType === "UPPER"
          ? ["upper"]
          : ["step", "upper"];
      const inferred = suffixes
        .map((suffix) => sfgItemIdByCode.get(`${fgCode}_${suffix}`.toLowerCase()))
        .filter(Boolean)
        .map((id) => String(id));
      if (!inferred.length) return;
      fgToSfgMap[fgKey] = [...new Set(inferred)];
    });
  const itemSkuMap = {};
  (itemSkus || []).forEach((sku) => {
    const itemId = toNumberOrNull(sku?.item_id);
    if (!itemId) return;
    const key = String(itemId);
    if (!Array.isArray(itemSkuMap[key])) itemSkuMap[key] = [];
    itemSkuMap[key].push({
      id: toNumberOrNull(sku.id),
      sku_code: sku.sku_code,
      size_id: toNumberOrNull(sku.size_id),
      grade_id: toNumberOrNull(sku.grade_id),
      color_id: toNumberOrNull(sku.color_id),
      packing_type_id: toNumberOrNull(sku.packing_type_id),
      size_name: sku.size_name || null,
      grade_name: sku.grade_name || null,
      color_name: sku.color_name || null,
      packing_name: sku.packing_name || null,
    });
  });

  const itemLabourDefaultsMap = {};
  const labourRulesBySkuId = new Map();
  const labourRulesBySubgroupId = new Map();
  const labourRulesByGroupId = new Map();
  const flatLabourRules = [];
  const itemSkuRowsByItemId = new Map();
  const normalizeLabourRuleArticleType = (value) => {
    const normalized = String(value || "").trim().toUpperCase();
    if (!normalized) return "";
    if (normalized === "FINISHED") return "FG";
    if (normalized === "SEMI_FINISHED") return "SFG";
    return normalized;
  };
  const articleTypeMatches = (ruleArticleType, itemType) => {
    const normalizedRuleType = normalizeLabourRuleArticleType(ruleArticleType);
    const normalizedItemType = String(itemType || "").trim().toUpperCase();
    if (!normalizedRuleType || normalizedRuleType === "BOTH") return true;
    return normalizedRuleType === normalizedItemType;
  };
  (labourRateRuleRows || []).forEach((rule) => {
    const applyOn = String(rule?.apply_on || "SKU").trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(LABOUR_RATE_RULE_PRECEDENCE, applyOn)) return;
    if (!LABOUR_RATE_TYPES.has(String(rule?.rate_type || "").trim().toUpperCase())) return;
    const labourId = toNumberOrNull(rule?.labour_id);
    const deptId = toNumberOrNull(rule?.dept_id);
    if (!labourId || !deptId) return;
    if (applyOn === "SKU") {
      const skuId = toNumberOrNull(rule?.sku_id);
      if (!skuId) return;
      if (!labourRulesBySkuId.has(skuId)) labourRulesBySkuId.set(skuId, []);
      labourRulesBySkuId.get(skuId).push(rule);
      return;
    }
    if (applyOn === "SUBGROUP") {
      const subgroupId = toNumberOrNull(rule?.subgroup_id);
      if (!subgroupId) return;
      if (!labourRulesBySubgroupId.has(subgroupId)) labourRulesBySubgroupId.set(subgroupId, []);
      labourRulesBySubgroupId.get(subgroupId).push(rule);
      return;
    }
    if (applyOn === "GROUP") {
      const groupId = toNumberOrNull(rule?.group_id);
      if (!groupId) return;
      if (!labourRulesByGroupId.has(groupId)) labourRulesByGroupId.set(groupId, []);
      labourRulesByGroupId.get(groupId).push(rule);
      return;
    }
    flatLabourRules.push(rule);
  });
  (itemSkus || []).forEach((sku) => {
    const itemId = toNumberOrNull(sku?.item_id);
    const skuId = toNumberOrNull(sku?.id);
    if (!itemId || !skuId) return;
    if (!itemSkuRowsByItemId.has(itemId)) itemSkuRowsByItemId.set(itemId, []);
    itemSkuRowsByItemId.get(itemId).push({
      sku_id: skuId,
      sku_code: String(sku?.sku_code || ""),
      size_id: toNumberOrNull(sku?.size_id),
    });
  });
  (items || []).forEach((item) => {
    const itemId = toNumberOrNull(item?.id);
    if (!itemId) return;
    const itemType = String(item?.item_type || "").trim().toUpperCase();
    const subgroupId = toNumberOrNull(item?.subgroup_id);
    const groupId = toNumberOrNull(item?.group_id);
    const skuRows = (itemSkuRowsByItemId.get(itemId) || [])
      .slice()
      .sort((a, b) => String(a.sku_code || "").localeCompare(String(b.sku_code || "")));
    if (!skuRows.length) return;

    const comboSelectionMap = new Map();
    const comboRatesBySize = new Map();

    skuRows.forEach((skuRow) => {
      const candidates = [
        ...(labourRulesBySkuId.get(toNumberOrNull(skuRow?.sku_id)) || []),
        ...(subgroupId ? (labourRulesBySubgroupId.get(subgroupId) || []) : []),
        ...(groupId ? (labourRulesByGroupId.get(groupId) || []) : []),
        ...flatLabourRules,
      ];
      if (!candidates.length) return;

      const bestRuleByCombo = new Map();
      candidates.forEach((rule) => {
        if (!articleTypeMatches(rule?.article_type, itemType)) return;
        const labourId = toNumberOrNull(rule?.labour_id);
        const deptId = toNumberOrNull(rule?.dept_id);
        const rateType = String(rule?.rate_type || "").trim().toUpperCase();
        const rateValue = toNumberOrNull(rule?.rate_value);
        const applyOn = String(rule?.apply_on || "SKU").trim().toUpperCase();
        if (!labourId || !deptId || !LABOUR_RATE_TYPES.has(rateType) || rateValue === null || rateValue < 0) return;
        const precedence = LABOUR_RATE_RULE_PRECEDENCE[applyOn] || 99;
        const comboKey = `${labourId}:${deptId}:${rateType}`;
        const current = bestRuleByCombo.get(comboKey);
        const ruleId = toNumberOrNull(rule?.id) || 0;
        const isReadOnlyFromGlobalRates = true;
        if (!current || precedence < current.precedence || (precedence === current.precedence && ruleId > current.ruleId)) {
          bestRuleByCombo.set(comboKey, {
            labour_id: String(labourId),
            dept_id: String(deptId),
            rate_type: rateType,
            rate_value: String(rateValue),
            is_locked: isReadOnlyFromGlobalRates,
            precedence,
            ruleId,
          });
        }
      });

      const sizeKey = String(toNumberOrNull(skuRow?.size_id) || "ALL");
      bestRuleByCombo.forEach((resolved) => {
        const comboKey = `${resolved.labour_id}:${resolved.dept_id}:${resolved.rate_type}`;
        if (!comboSelectionMap.has(comboKey)) {
          comboSelectionMap.set(comboKey, {
            labour_id: resolved.labour_id,
            dept_id: resolved.dept_id,
            rate_type: resolved.rate_type,
          });
        }
        if (!comboRatesBySize.has(comboKey)) comboRatesBySize.set(comboKey, new Map());
        const sizeRateMap = comboRatesBySize.get(comboKey);
        if (!sizeRateMap.has(sizeKey)) sizeRateMap.set(sizeKey, []);
        sizeRateMap.get(sizeKey).push({
          rate_value: String(resolved.rate_value || ""),
          is_locked: Boolean(resolved.is_locked),
        });
      });
    });

    if (!comboSelectionMap.size) return;

    const labourSelection = [...comboSelectionMap.values()].sort((a, b) => {
      const labourDiff = Number(a.labour_id || 0) - Number(b.labour_id || 0);
      if (labourDiff !== 0) return labourDiff;
      const deptDiff = Number(a.dept_id || 0) - Number(b.dept_id || 0);
      if (deptDiff !== 0) return deptDiff;
      return String(a.rate_type || "").localeCompare(String(b.rate_type || ""));
    });
    const labourRateMap = {};
    const labourRateLockedMap = {};
    comboRatesBySize.forEach((sizeRateMap, comboKey) => {
      const resolvedBySize = [];
      sizeRateMap.forEach((rateEntries, sizeKey) => {
        const normalizedEntries = Array.isArray(rateEntries)
          ? rateEntries.map((entry) => ({
              rate: String(entry?.rate_value || "").trim(),
              isLocked: Boolean(entry?.is_locked),
            })).filter((entry) => entry.rate)
          : [];
        const rates = [...new Set(normalizedEntries.map((entry) => entry.rate))];
        if (rates.length !== 1) return;
        const resolvedRate = String(rates[0]);
        labourRateMap[`${comboKey}:${sizeKey}`] = resolvedRate;
        const allLockedForSize = normalizedEntries.length > 0 && normalizedEntries.every((entry) => entry.isLocked);
        if (allLockedForSize) labourRateLockedMap[`${comboKey}:${sizeKey}`] = true;
        resolvedBySize.push({
          rate: resolvedRate,
          isLocked: allLockedForSize,
        });
      });
      const uniqueResolvedRates = [...new Set(resolvedBySize.map((entry) => entry.rate).filter(Boolean))];
      if (uniqueResolvedRates.length === 1) {
        labourRateMap[`${comboKey}:ALL`] = uniqueResolvedRates[0];
        const allLockedForAll = resolvedBySize.length > 0 && resolvedBySize.every((entry) => entry.isLocked);
        if (allLockedForAll) labourRateLockedMap[`${comboKey}:ALL`] = true;
      }
    });
    itemLabourDefaultsMap[String(itemId)] = {
      labour_selection: labourSelection,
      labour_rate_map: labourRateMap,
      labour_rate_locked_map: labourRateLockedMap,
    };
  });

  const itemOutputUomMap = {};
  const uomNameById = new Map((uoms || []).map((row) => [toNumberOrNull(row.id), row?.name || row?.id]));
  const baseUomIds = [...new Set((items || []).map((item) => toNumberOrNull(item?.base_uom_id)).filter(Boolean))];
  const conversionRows = hasUomConversionsTable && baseUomIds.length
    ? await knex("erp.uom_conversions")
        .select("from_uom_id", "to_uom_id", "factor")
        .where({ is_active: true })
        .whereIn("to_uom_id", baseUomIds)
    : [];
  const conversionFromSetByBase = new Map();
  const uomConversionMap = {};
  (conversionRows || []).forEach((row) => {
    const fromId = toNumberOrNull(row?.from_uom_id);
    const toId = toNumberOrNull(row?.to_uom_id);
    const factor = Number(row?.factor);
    if (!fromId || !toId) return;
    if (!conversionFromSetByBase.has(toId)) conversionFromSetByBase.set(toId, new Set());
    conversionFromSetByBase.get(toId).add(fromId);
    if (Number.isFinite(factor) && factor > 0) {
      const fromKey = String(fromId);
      const toKey = String(toId);
      if (!uomConversionMap[fromKey]) uomConversionMap[fromKey] = {};
      uomConversionMap[fromKey][toKey] = factor;
    }
  });
  (items || []).forEach((item) => {
    const itemId = toNumberOrNull(item?.id);
    const baseUomId = toNumberOrNull(item?.base_uom_id);
    if (!itemId || !baseUomId) return;
    const allowed = new Set([baseUomId]);
    const convertibleFrom = conversionFromSetByBase.get(baseUomId);
    if (convertibleFrom) {
      convertibleFrom.forEach((id) => allowed.add(id));
    }
    const sortedAllowedRows = [...allowed]
      .map((uomId) => ({ id: uomId, name: uomNameById.get(uomId) || String(uomId) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    itemOutputUomMap[String(itemId)] = sortedAllowedRows;
  });

  const productionStages = (productionStageRows || []).map((row) => ({
    id: Number(row?.id),
    code: String(row?.code || "").trim(),
    name: String(row?.name || row?.code || row?.id || "").trim(),
    dept_id: Number(row?.dept_id || 0) || null,
    dept_name: String(row?.dept_name || "").trim(),
  })).filter((row) => Number(row.id) > 0);

  return {
    items,
    rmItems,
    uoms,
    departments: (departments || []).map((row) => ({
      id: row.id,
      name: row.name,
      is_production: row?.is_production === true,
    })),
    sizes,
    colors,
    ruleSizes,
    ruleColors,
    packings,
    labours: (labours || []).map((labour) => ({ id: labour.id, code: labour.code, name: labour.name })),
    labourDeptMap,
    rmItemColorMap,
    rmItemSizeMap,
    itemSizeMap,
    itemSkuMap,
    itemSkus,
    productionStages,
    itemOutputUomMap,
    uomConversionMap,
    itemLabourDefaultsMap,
    fgToSfgMap,
    sfgSkus,
    levelOptions: [
      { value: "FINISHED", label: "finished" },
      { value: "SEMI_FINISHED", label: "semi_finished" },
    ],
    labourRateTypeOptions: [
      { value: "PER_PAIR", label: "rate_type_per_pair" },
      { value: "PER_DOZEN", label: "rate_type_per_dozen" },
    ],
    ruleActionOptions: [
      { value: "ADJUST_QTY", label: "bom_rule_adjust_qty" },
    ],
    scopeOptions: [
      { value: "ALL", label: "all" },
      { value: "SPECIFIC", label: "bom_specific" },
    ],
  };
};

const listBoms = async (knex, filters = {}, options = {}) => {
  const normalizeRowsFilter = (value) => {
    const text = String(value || "25").trim().toLowerCase();
    if (text === "all") return "all";
    const parsed = Number.parseInt(text, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return 25;
    return [10, 25, 50].includes(parsed) ? parsed : 25;
  };

  const lifecycleSupported = await hasBomLifecycleColumn(knex);
  const workflow = String(filters.workflow || filters.stage || "").toUpperCase();
  const level = String(filters.bom_type || filters.bomType || filters.level || "").toUpperCase();
  const lifecycle = String(filters.lifecycle || "").trim().toLowerCase();
  const q = String(filters.q || "").trim();
  const rows = normalizeRowsFilter(filters.rows);
  const viewerUserId = toPositiveInt(options.viewerUserId);

  const query = knex("erp.bom_header as bh")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.level",
      "bh.status",
      lifecycleSupported
        ? knex.raw("CASE WHEN bh.status = 'APPROVED' THEN bh.is_active ELSE NULL END as bom_is_active")
        : knex.raw("CASE WHEN bh.status = 'APPROVED' THEN COALESCE(i.is_active, true) ELSE NULL END as bom_is_active"),
      "bh.version_no",
      "bh.output_qty",
      "bh.created_at",
      "bh.approved_at",
      "i.code as item_code",
      "i.name as item_name",
      "i.is_active as item_is_active",
      "u.username as created_by_name",
      "au.username as approved_by_name",
      knex.raw(
        `(SELECT COUNT(1) FROM erp.approval_request ar
          WHERE ar.entity_type = 'BOM'
            AND ar.entity_id = bh.id::text
            AND ar.status = 'PENDING'
            AND COALESCE(ar.new_value ->> '_action', '') = 'approve_draft') AS pending_approval_count`,
      ),
    )
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .leftJoin("erp.users as u", "bh.created_by", "u.id")
    .leftJoin("erp.users as au", "bh.approved_by", "au.id")
    .orderBy("bh.id", "desc");

  if (workflow && ["DRAFT", "PENDING", "APPROVED", "REJECTED"].includes(workflow)) query.where("bh.status", workflow);
  if (level && BOM_LEVELS.has(level)) query.where("bh.level", level);
  if (lifecycle === "active") {
    query.where("bh.status", "APPROVED").andWhere(lifecycleSupported ? "bh.is_active" : "i.is_active", true);
  }
  if (lifecycle === "inactive") {
    query.where("bh.status", "APPROVED").andWhere(lifecycleSupported ? "bh.is_active" : "i.is_active", false);
  }
  if (q) {
    query.where((builder) => {
      builder.whereILike("bh.bom_no", `%${q}%`).orWhereILike("i.name", `%${q}%`).orWhereILike("i.code", `%${q}%`);
    });
  }
  if (viewerUserId) {
    query.andWhere((builder) => {
      builder.whereNot("bh.status", "DRAFT").orWhere("bh.created_by", viewerUserId);
    });
  } else {
    query.whereNot("bh.status", "DRAFT");
  }
  if (rows !== "all") query.limit(rows);

  return query;
};

const getBomForForm = async (knex, id) => {
  const bomId = Number(id);
  const lifecycleSupported = await hasBomLifecycleColumn(knex);
  const hasBomStageRoutingTable = await tableExists(knex, "erp.bom_stage_routing");
  const hasBomSkuOverrideTable = await tableExists(knex, "erp.bom_sku_override_line");
  const headerFields = [
    "bh.id",
    "bh.bom_no",
    "bh.item_id",
    "bh.level",
    "bh.output_qty",
    "bh.output_uom_id",
    "bh.status",
    "bh.version_no",
    "bh.created_at",
    "bh.approved_at",
    "bh.created_by",
    "bh.approved_by",
    "i.name as item_name",
    "i.code as item_code",
  ];
  if (lifecycleSupported) headerFields.splice(7, 0, "bh.is_active");
  const header = await knex("erp.bom_header as bh")
    .select(headerFields)
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .where("bh.id", bomId)
    .first();
  if (!header) return null;
  if (!lifecycleSupported) header.is_active = true;

  const [rmLines, sfgLines, labourLines, stageRoutes, skuOverrides] = await Promise.all([
    knex("erp.bom_rm_line")
      .select("id", "rm_item_id", "color_id", "size_id", "dept_id", "qty", "uom_id", "normal_loss_pct")
      .where({ bom_id: bomId })
      .orderBy("id", "asc"),
    knex("erp.bom_sfg_line")
      .select("id", "fg_size_id", "sfg_sku_id", "required_qty", "uom_id", "consumed_in_stage_id", "ref_approved_bom_id")
      .where({ bom_id: bomId })
      .orderBy("id", "asc"),
    knex("erp.bom_labour_line")
      .select("id", "size_scope", "size_id", "dept_id", "labour_id", "rate_type", "rate_value")
      .where({ bom_id: bomId })
      .orderBy("id", "asc"),
    hasBomStageRoutingTable
      ? knex("erp.bom_stage_routing")
          .select("id", "stage_id", "sequence_no", "is_required", "enforce_sequence")
          .where({ bom_id: bomId })
          .orderBy("sequence_no", "asc")
      : Promise.resolve([]),
    hasBomSkuOverrideTable
      ? knex("erp.bom_sku_override_line")
          .select("id", "sku_id", "target_rm_item_id", "dept_id", "is_excluded", "override_qty", "override_uom_id", "replacement_rm_item_id", "rm_color_id", "rm_size_id", "notes")
          .where({ bom_id: bomId })
          .orderBy("id", "asc")
      : Promise.resolve([]),
  ]);

  return {
    header,
    rm_lines: rmLines,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    stage_routes: stageRoutes,
    variant_rules: [],
    sku_overrides: skuOverrides,
  };
};

const listVersions = async (knex, filters = {}) => {
  const itemId = toNumberOrNull(filters.item_id);
  const level = String(filters.level || "").toUpperCase();
  let query = knex("erp.bom_header as bh")
    .select("bh.id", "bh.bom_no", "bh.item_id", "bh.level", "bh.status", "bh.version_no", "bh.created_at", "bh.approved_at", "i.code as item_code", "i.name as item_name")
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .orderBy("bh.item_id", "asc")
    .orderBy("bh.version_no", "desc");
  if (itemId) query = query.where("bh.item_id", itemId);
  if (BOM_LEVELS.has(level)) query = query.where("bh.level", level);
  return query;
};

const buildApprovalPayload = ({ action, input, bomId }) => ({
  schema_version: 1,
  _action: action,
  bom_id: bomId || null,
  input: {
    header: {
      item_id: input.header.item_id,
      level: input.header.level,
      output_qty: input.header.output_qty,
      output_uom_id: input.header.output_uom_id,
    },
    rm_lines: input.rm_lines,
    sfg_lines: input.sfg_lines,
    labour_lines: input.labour_lines,
    stage_routes: input.stage_routes || [],
    variant_rules: [],
    sku_overrides: [],
  },
});

const buildApproveDraftPayload = ({ bomId, snapshot }) => ({
  schema_version: 1,
  _action: "approve_draft",
  bom_id: bomId || null,
  snapshot: buildApprovalSnapshot(snapshot || {}),
});

const buildDeleteDraftPayload = ({ bomId }) => ({
  schema_version: 1,
  _action: "delete_draft",
  bom_id: bomId || null,
});

const parseApprovalPayload = (request) => {
  const raw = request?.new_value;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    return null;
  }
};

const resetPendingBomAfterRejectTx = async (trx, request) => {
  if (request?.entity_type !== "BOM") return false;
  const payload = parseApprovalPayload(request);
  const action = String(payload?._action || "").toLowerCase();
  if (action !== "approve_draft") return false;
  const bomId = Number(payload?.bom_id || request.entity_id);
  if (!bomId) return false;
  const row = await trx("erp.bom_header").select("id", "status").where({ id: bomId }).first();
  if (!row || row.status !== "PENDING") return false;
  await trx("erp.bom_header")
    .where({ id: bomId })
    .update({
      status: "DRAFT",
      approved_by: null,
      approved_at: null,
    });
  return true;
};

const applyApprovedBomChange = async (trx, request, approverUserId) => {
  const payload = parseApprovalPayload(request);
  if (!payload || typeof payload !== "object") return false;
  const action = String(payload._action || "").toLowerCase();
  debugBom("applyApprovedBomChange", { requestId: request?.id, action, entityId: request?.entity_id });

  if (action === "create" || action === "update") {
    const existingId = action === "update" && request.entity_id && request.entity_id !== "NEW" ? Number(request.entity_id) : null;
    const actorId = request.requested_by || approverUserId || null;
    const result = await saveBomDraftTx(trx, {
      input: payload.input || {},
      bomId: existingId,
      userId: actorId,
      requestId: request?.id || null,
      t: (key) => key,
    });
    return { applied: true, entityId: String(result.id) };
  }

  if (action === "approve_draft") {
    const bomId = Number(payload.bom_id || request.entity_id);
    if (!bomId) return false;
    await validateDraftReadyForApproval(trx, {
      bomId,
      t: () => "",
      locale: "en",
    });
    if (payload.snapshot && typeof payload.snapshot === "object") {
      const current = await getBomSnapshot(trx, bomId);
      if (!current) return false;
      const currentSignature = snapshotSignature(current);
      const payloadSignature = snapshotSignature(payload.snapshot);
      if (currentSignature !== payloadSignature) {
        const err = makeValidationError("BOM snapshot mismatch while approving. Please reopen and resubmit approval.");
        err.code = "BOM_SNAPSHOT_MISMATCH";
        throw err;
      }
    }
    await approveBomDirectTx(trx, {
      bomId,
      userId: approverUserId || null,
      requestId: request?.id || null,
      t: (key) => key,
    });
    return { applied: true, entityId: String(bomId) };
  }

  if (action === "delete_draft") {
    const bomId = Number(payload.bom_id || request.entity_id);
    if (!bomId) return false;
    const actorId = request.requested_by || approverUserId || null;
    await deleteDraftBomTx(trx, {
      bomId,
      userId: actorId,
      isAdmin: true,
      t: (key) => key,
    });
    return { applied: true, entityId: String(bomId) };
  }

  if (action === "create_version_from") {
    const sourceId = Number(payload.source_bom_id || request.entity_id);
    if (!sourceId) return false;
    const actorId = request.requested_by || approverUserId || null;
    const result = await createNewVersionFromApprovedTx(trx, {
      sourceBomId: sourceId,
      userId: actorId,
      t: (key) => key,
    });
    return { applied: true, entityId: String(result.id) };
  }

  if (action === "toggle_lifecycle") {
    const bomId = Number(payload.bom_id || request.entity_id);
    if (!bomId) return false;
    const result = await toggleBomLifecycleTx(trx, {
      bomId,
      isActive: payload.is_active,
      t: (key) => key,
    });
    return { applied: true, entityId: String(result.id) };
  }

  return false;
};

module.exports = {
  parseBomFormPayload,
  loadFormOptions,
  listBoms,
  getBomForForm,
  listVersions,
  saveBomDraft,
  saveBomDraftTx,
  validateDraftReadyForApproval,
  approveBomDirect,
  approveBomDirectTx,
  createNewVersionFromApproved,
  createNewVersionFromApprovedTx,
  findDraftBomByItemLevel,
  hasPendingApprovalForBom,
  hasPendingApprovalForBomTx,
  hasPendingApprovalForBomTarget,
  hasPendingApprovalForBomTargetTx,
  setBomPending,
  setBomPendingTx,
  resetPendingBomAfterRejectTx,
  buildApprovalSnapshot,
  buildApprovalPayload,
  buildApproveDraftPayload,
  buildDeleteDraftPayload,
  applyApprovedBomChange,
  toggleBomLifecycle,
  toggleBomLifecycleTx,
  deleteDraftBom,
  deleteDraftBomTx,
};
