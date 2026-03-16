const { insertBomChangeLog } = require("../../utils/bom-change-log");

const debugEnabled = process.env.DEBUG_BOM === "1";
const debugBom = (...args) => {
  if (debugEnabled) console.log("[DEBUG][BOM]", ...args);
};

const BOM_LEVELS = new Set(["FINISHED", "SEMI_FINISHED"]);
const LABOUR_RATE_TYPES = new Set(["PER_DOZEN", "PER_PAIR"]);
const BOM_SCOPE = new Set(["ALL", "SPECIFIC"]);
const RULE_ACTION_TYPES = new Set(["ADD_RM", "REMOVE_RM", "REPLACE_RM", "ADJUST_QTY", "CHANGE_LOSS"]);
let bomLifecycleColumnSupportPromise = null;
let bomSkuOverrideTableSupportPromise = null;
let bomSkuOverrideDeptColumnSupportPromise = null;

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

const parseJsonObject = (raw) => {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
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

const hasBomSkuOverrideTable = async (db) => {
  if (bomSkuOverrideTableSupportPromise) return bomSkuOverrideTableSupportPromise;
  bomSkuOverrideTableSupportPromise = (async () => {
    try {
      return tableExists(db, "erp.bom_sku_override_line");
    } catch (err) {
      bomSkuOverrideTableSupportPromise = null;
      return false;
    }
  })();
  return bomSkuOverrideTableSupportPromise;
};

const hasBomSkuOverrideDeptColumn = async (db) => {
  if (bomSkuOverrideDeptColumnSupportPromise) return bomSkuOverrideDeptColumnSupportPromise;
  bomSkuOverrideDeptColumnSupportPromise = (async () => {
    try {
      return db.schema.withSchema("erp").hasColumn("bom_sku_override_line", "dept_id");
    } catch (err) {
      bomSkuOverrideDeptColumnSupportPromise = null;
      return false;
    }
  })();
  return bomSkuOverrideDeptColumnSupportPromise;
};

const parseBomFormPayload = (body = {}) => {
  const rmRaw = parseJsonArray(body.rm_lines_json);
  const sfgRaw = parseJsonArray(body.sfg_lines_json);
  const labourRaw = parseJsonArray(body.labour_lines_json);
  const ruleRaw = parseJsonArray(body.variant_rules_json);
  const skuOverrideRaw = parseJsonArray(body.sku_overrides_json);

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
      .filter((row) => row.rm_item_id || row.dept_id || row.qty),
    sfg_lines: sfgRaw
      .map((row) => ({
        fg_size_id: toNumberOrNull(row.fg_size_id),
        sfg_sku_id: toNumberOrNull(row.sfg_sku_id),
        required_qty: toNumberOrNull(row.required_qty),
        uom_id: toNumberOrNull(row.uom_id),
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
      .filter((row) => row.dept_id || row.labour_id || row.rate_value),
    variant_rules: ruleRaw
      .map((row) => ({
        size_scope: normalizeScope(row.size_scope),
        size_id: toNumberOrNull(row.size_id),
        packing_scope: normalizeScope(row.packing_scope),
        packing_type_id: toNumberOrNull(row.packing_type_id),
        color_scope: normalizeScope(row.color_scope),
        color_id: toNumberOrNull(row.color_id),
        action_type: String(row.action_type || "").toUpperCase(),
        material_scope: normalizeScope(row.material_scope),
        target_rm_item_id: toNumberOrNull(row.target_rm_item_id),
        new_value: parseJsonObject(row.new_value),
      }))
      .filter((row) => row.action_type),
    sku_overrides: skuOverrideRaw
      .map((row) => ({
        sku_id: toNumberOrNull(row.sku_id),
        target_rm_item_id: toNumberOrNull(row.target_rm_item_id),
        dept_id: toNumberOrNull(row.dept_id),
        is_excluded: Boolean(row.is_excluded),
        override_qty: toNumberOrNull(row.override_qty),
        override_uom_id: toNumberOrNull(row.override_uom_id),
        replacement_rm_item_id: toNumberOrNull(row.replacement_rm_item_id),
        rm_color_id: toNumberOrNull(row.rm_color_id),
        notes: String(row.notes || "").trim() || null,
      }))
      .filter((row) => row.sku_id || row.target_rm_item_id || row.dept_id || row.is_excluded || row.override_qty || row.replacement_rm_item_id || row.rm_color_id),
  };
};

const fetchLatestApprovedBomId = async (db, itemId) => {
  if (!itemId) return null;
  const row = await db("erp.bom_header").select("id").where({ item_id: itemId, status: "APPROVED" }).orderBy("version_no", "desc").first();
  return row?.id || null;
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

const validateAndNormalizeInput = async (db, input, t) => {
  const details = [];
  const header = input?.header || {};
  const formatRowMessage = (index, message) =>
    `${t("bom_error_row_prefix") || "Row"} ${index + 1}: ${message}`;
  const formatRuleMessage = (index, message) =>
    `${t("bom_error_rule_prefix") || "Rule"} ${index + 1}: ${message}`;

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
    if (!outputUomId) outputUomId = item.base_uom_id || null;
  }

  if (!outputUomId) details.push({ field: "output_uom_id", message: t("bom_error_output_uom_required") || "Output UOM is required." });

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
    ? await db("erp.items").select("id", "item_type", "base_uom_id").whereIn("id", rmItemIds)
    : [];
  const rmItemMap = new Map(rmItems.map((row) => [toNumberOrNull(row.id), row]));
  rmLines.forEach((line, idx) => {
    const rowLabel = `${t("bom_error_row_prefix") || "Row"} ${idx + 1}`;
    if (!line.rm_item_id || !line.dept_id || !line.qty) {
      details.push({
        field: "rm_lines_json",
        message: `${rowLabel}: ${t("bom_error_rm_line_invalid") || "Complete this raw material row: select material, department, and quantity."}`,
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

  const sfgLines = toArray(input?.sfg_lines)
    .map((line) => ({
      fg_size_id: toNumberOrNull(line.fg_size_id),
      sfg_sku_id: toNumberOrNull(line.sfg_sku_id),
      required_qty: toPositiveNumber(line.required_qty),
      uom_id: toNumberOrNull(line.uom_id),
      ref_approved_bom_id: null,
    }))
    .filter((line) => line.sfg_sku_id || line.required_qty);

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
  for (let idx = 0; idx < sfgLines.length; idx += 1) {
    const line = sfgLines[idx];
    if (!line.fg_size_id || !line.sfg_sku_id || !line.required_qty) {
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
    const approvedBomId = await fetchLatestApprovedBomId(db, sku.item_id);
    if (!approvedBomId) {
      details.push({
        field: "sfg_lines_json",
        message: formatRowMessage(idx, t("bom_error_sfg_requires_approved_bom") || "Selected SFG item has no approved BOM."),
      });
      continue;
    }
    line.ref_approved_bom_id = approvedBomId;
  }
  if (incompleteSfgRowIndexes.length) {
    const message = t("bom_error_sfg_section_incomplete")
      || "Complete all mandatory fields in Semi-Finished section (Article SKU, Step/Upper SKU, and Step Quantity).";
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
  const departmentMap = new Map(departmentRows.map((row) => [toNumberOrNull(row.id), row]));

  rmLines.forEach((line, idx) => {
    const rowLabel = `${t("bom_error_row_prefix") || "Row"} ${idx + 1}`;
    if (!line.dept_id) return;
    const dept = departmentMap.get(line.dept_id);
    if (!dept || !dept.is_active || !dept.is_production) {
      details.push({
        field: "rm_lines_json",
        message: `${rowLabel}: ${t("bom_error_department_must_be_production") || "Selected department must be an active Production department."}`,
      });
    }
  });

  labourLines.forEach((line, idx) => {
    if (!line.dept_id || !line.labour_id || line.rate_value === null || line.rate_value < 0) {
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
    if (!dept || !dept.is_active || !dept.is_production) {
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
    const comboKey = `${line.labour_id}:${line.dept_id}:${sizeKey}`;
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

  const variantRules = toArray(input?.variant_rules)
    .map((line) => ({
      size_scope: normalizeScope(line.size_scope),
      size_id: toNumberOrNull(line.size_id),
      packing_scope: normalizeScope(line.packing_scope),
      packing_type_id: toNumberOrNull(line.packing_type_id),
      color_scope: normalizeScope(line.color_scope),
      color_id: toNumberOrNull(line.color_id),
      action_type: String(line.action_type || "").toUpperCase(),
      material_scope: normalizeScope(line.material_scope),
      target_rm_item_id: toNumberOrNull(line.target_rm_item_id),
      new_value: parseJsonObject(line.new_value),
      __raw_new_value: line.new_value,
    }))
    .filter((line) => line.action_type);
  const skuOverrides = toArray(input?.sku_overrides)
    .map((line) => ({
      sku_id: toNumberOrNull(line.sku_id),
      target_rm_item_id: toNumberOrNull(line.target_rm_item_id),
      dept_id: toNumberOrNull(line.dept_id),
      is_excluded: Boolean(line.is_excluded),
      override_qty: toPositiveNumber(line.override_qty),
      override_uom_id: toNumberOrNull(line.override_uom_id),
      replacement_rm_item_id: toNumberOrNull(line.replacement_rm_item_id),
      rm_color_id: toNumberOrNull(line.rm_color_id),
      notes: String(line.notes || "").trim() || null,
    }))
    .filter((line) => line.sku_id || line.target_rm_item_id || line.dept_id || line.is_excluded || line.override_qty || line.replacement_rm_item_id || line.rm_color_id);

  const ruleReplacementRmIds = [...new Set(variantRules.map((rule) => toNumberOrNull(rule?.new_value?.replacement_rm_item_id)).filter(Boolean))];
  const ruleTargetRmIds = [...new Set(variantRules.map((rule) => toNumberOrNull(rule?.target_rm_item_id)).filter(Boolean))];
  const overrideTargetRmIds = [...new Set(skuOverrides.map((line) => line.target_rm_item_id).filter(Boolean))];
  const overrideReplacementRmIds = [...new Set(skuOverrides.map((line) => line.replacement_rm_item_id).filter(Boolean))];
  const allRuleRmIds = [...new Set([...rmItemIds, ...ruleTargetRmIds, ...ruleReplacementRmIds, ...overrideTargetRmIds, ...overrideReplacementRmIds])];
  const allRuleRmRows = allRuleRmIds.length
    ? await db("erp.items").select("id", "item_type", "base_uom_id", "name", "code").whereIn("id", allRuleRmIds)
    : [];
  const allRuleRmMap = new Map(allRuleRmRows.map((row) => [toNumberOrNull(row.id), row]));
  const [bomItemVariantColorRows, rmColorRateRows] = await Promise.all([
    itemId
      ? db("erp.variants").select("color_id").where({ item_id: itemId, is_active: true })
      : Promise.resolve([]),
    rmItemIds.length
      ? db("erp.rm_purchase_rates")
          .select("rm_item_id", "color_id")
          .whereIn("rm_item_id", rmItemIds)
          .andWhere({ is_active: true })
      : Promise.resolve([]),
  ]);
  const itemSkuColorIds = new Set((bomItemVariantColorRows || []).map((row) => toNumberOrNull(row?.color_id)).filter(Boolean));
  const hasItemSkuColorVariants = itemSkuColorIds.size > 0;
  const rmColorSetByItem = new Map();
  (rmColorRateRows || []).forEach((row) => {
    const rmItemId = toNumberOrNull(row?.rm_item_id);
    const colorId = toNumberOrNull(row?.color_id);
    if (!rmItemId || !colorId) return;
    if (!rmColorSetByItem.has(rmItemId)) rmColorSetByItem.set(rmItemId, new Set());
    rmColorSetByItem.get(rmItemId).add(colorId);
  });
  const multiColorRmIds = new Set(
    Array.from(rmColorSetByItem.entries())
      .filter(([, colorSet]) => colorSet.size > 1)
      .map(([rmItemId]) => rmItemId),
  );
  const getRmDisplayName = (rmItemId) => {
    const row = allRuleRmMap.get(toNumberOrNull(rmItemId));
    return row?.name || row?.code || String(rmItemId || "");
  };

  const hasRuleSizeOrColorScope = variantRules.some((rule) => (rule.size_scope === "SPECIFIC" && rule.size_id) || (rule.color_scope === "SPECIFIC" && rule.color_id));
  let allowedRuleSizeIds = new Set();
  let allowedRuleColorIds = new Set();
  if (hasRuleSizeOrColorScope) {
    const [fgSfgVariantDims, sizeItemTypeRows] = await Promise.all([
      db("erp.variants as v")
        .select("v.size_id", "v.color_id")
        .leftJoin("erp.items as i", "v.item_id", "i.id")
        .whereIn("i.item_type", ["FG", "SFG"])
        .andWhere("v.is_active", true),
      hasSizeItemTypesTable
        ? db("erp.size_item_types")
            .select("size_id")
            .whereIn("item_type", ["FG", "SFG"])
        : Promise.resolve([]),
    ]);
    allowedRuleSizeIds = new Set((sizeItemTypeRows || []).map((row) => toNumberOrNull(row?.size_id)).filter(Boolean));
    (fgSfgVariantDims || []).forEach((row) => {
      const sizeId = toNumberOrNull(row?.size_id);
      const colorId = toNumberOrNull(row?.color_id);
      if (sizeId) allowedRuleSizeIds.add(sizeId);
      if (colorId) allowedRuleColorIds.add(colorId);
    });
  }
  const hasRuleRmColor = variantRules.some((rule) => toNumberOrNull(rule?.new_value?.rm_color_id));
  const hasOverrideRmColor = skuOverrides.some((line) => toNumberOrNull(line?.rm_color_id));
  const activeColorSet = new Set();
  if (hasRuleRmColor || hasOverrideRmColor) {
    const colorRows = await db("erp.colors").select("id").where({ is_active: true });
    (colorRows || []).forEach((row) => {
      const colorId = toNumberOrNull(row?.id);
      if (colorId) activeColorSet.add(colorId);
    });
  }

  variantRules.forEach((rule, idx) => {
    if (!RULE_ACTION_TYPES.has(rule.action_type)) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_variant_action_invalid") || "Invalid variant rule action."),
      });
      return;
    }
    if (!["ADJUST_QTY", "REPLACE_RM"].includes(rule.action_type)) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_variant_action_invalid") || "Invalid variant rule action."),
      });
      return;
    }
    if (rule.size_scope === "SPECIFIC" && !rule.size_id) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_size_required_for_specific_scope") || "Size is required for specific scope."),
      });
    }
    if (rule.packing_scope === "SPECIFIC" && !rule.packing_type_id) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_packing_required_for_specific_scope") || "Packing type is required for specific scope."),
      });
    }
    if (rule.color_scope === "SPECIFIC" && !rule.color_id) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_color_required_for_specific_scope") || "Color is required for specific scope."),
      });
    }
    if (rule.size_scope === "SPECIFIC" && rule.size_id && !allowedRuleSizeIds.has(rule.size_id)) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_variant_invalid_size") || "Selected size is invalid for this BOM item."),
      });
    }
    if (rule.color_scope === "SPECIFIC" && rule.color_id && !allowedRuleColorIds.has(rule.color_id)) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_variant_invalid_color") || "Selected color is invalid for this BOM item."),
      });
    }
    if (!hasItemSkuColorVariants && rule.color_scope === "SPECIFIC") {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(
          idx,
          t("bom_error_color_scope_not_allowed_no_sku_colors")
            || "This article has no SKU color variants. Use 'All SKUs' for color scope.",
        ),
      });
    }
    if (rule.material_scope === "SPECIFIC" && !rule.target_rm_item_id) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_material_required_for_specific_scope") || "Target material is required for specific scope."),
      });
    }
    if (rule.size_scope === "ALL") rule.size_id = null;
    if (rule.packing_scope === "ALL") rule.packing_type_id = null;
    if (rule.color_scope === "ALL") rule.color_id = null;
    if (rule.material_scope === "ALL") rule.target_rm_item_id = null;
    if (rule.material_scope === "SPECIFIC" && rule.target_rm_item_id) {
      const targetRm = allRuleRmMap.get(rule.target_rm_item_id);
      if (!targetRm || targetRm.item_type !== "RM") {
        details.push({ field: "variant_rules_json", message: `${t("bom_error_rm_item_invalid") || "Raw material line must reference an RM item"} #${idx + 1}` });
      }
    }

    const rawRuleValue = typeof rule.__raw_new_value === "string" ? rule.__raw_new_value.trim() : "";
    if (rawRuleValue && rawRuleValue !== "{}" && Object.keys(rule.new_value || {}).length === 0) {
      details.push({
        field: "variant_rules_json",
        message: formatRuleMessage(idx, t("bom_error_variant_value_invalid_json") || "Rule value must be a valid JSON object."),
      });
    }
    if (rule.action_type === "ADJUST_QTY") {
      if (rule.size_scope !== "SPECIFIC") {
        details.push({
          field: "variant_rules_json",
          message: formatRuleMessage(idx, t("bom_error_size_required_for_specific_scope") || "Size is required for specific scope."),
        });
      }
      const qty = toPositiveNumber(rule.new_value?.qty);
      const uomId = toNumberOrNull(rule.new_value?.uom_id);
      if (!qty) {
        details.push({
          field: "variant_rules_json",
          message: formatRuleMessage(idx, t("bom_error_variant_invalid_qty") || "Adjusted quantity must be greater than zero."),
        });
      } else {
        rule.new_value.qty = qty;
      }
      if (!uomId) {
        details.push({
          field: "variant_rules_json",
          message: formatRuleMessage(idx, t("bom_error_variant_invalid_uom") || "Select a unit for adjusted quantity."),
        });
      } else {
        rule.new_value.uom_id = uomId;
      }
    } else if (rule.action_type === "REPLACE_RM") {
      const replacementRmId = toNumberOrNull(rule.new_value?.replacement_rm_item_id);
      const rmColorId = toNumberOrNull(rule.new_value?.rm_color_id);
      if (!replacementRmId && !rmColorId) {
        details.push({
          field: "variant_rules_json",
          message: formatRuleMessage(idx, t("bom_error_variant_replace_requires_target") || "Provide replacement material or raw material color."),
        });
      }
      if (replacementRmId) {
        const replacementRm = allRuleRmMap.get(replacementRmId);
        if (!replacementRm || replacementRm.item_type !== "RM") {
          details.push({
            field: "variant_rules_json",
            message: formatRuleMessage(idx, t("bom_error_rm_item_invalid") || "Raw material line must reference an RM item."),
          });
        } else {
          rule.new_value.replacement_rm_item_id = replacementRmId;
          rule.new_value.uom_id = toNumberOrNull(replacementRm.base_uom_id);
        }
      }
      if (rmColorId) {
        if (!activeColorSet.has(rmColorId)) {
          details.push({
            field: "variant_rules_json",
            message: formatRuleMessage(idx, t("bom_error_variant_invalid_color") || "Selected color is invalid for this BOM item."),
          });
        } else {
          rule.new_value.rm_color_id = rmColorId;
        }
      }
    }
    delete rule.__raw_new_value;
  });

  if (!hasItemSkuColorVariants && multiColorRmIds.size > 0) {
    const mappedRmIds = new Set(
      variantRules
        .filter((rule) =>
          String(rule?.action_type || "").toUpperCase() === "REPLACE_RM"
          && toNumberOrNull(rule?.target_rm_item_id)
          && toNumberOrNull(rule?.new_value?.rm_color_id),
        )
        .map((rule) => toNumberOrNull(rule.target_rm_item_id))
        .filter(Boolean),
    );
    const missingRmIds = Array.from(multiColorRmIds).filter((rmItemId) => !mappedRmIds.has(rmItemId));
    if (missingRmIds.length) {
      details.push({
        field: "variant_rules_json",
        message:
          t("bom_error_color_rules_required_no_sku_colors")
          || "This article has no SKU color variants. Add Color Rules for each raw material that has multiple color rates.",
      });
      missingRmIds.forEach((rmItemId) => {
        details.push({
          field: "variant_rules_json",
          message: `${t("bom_error_color_rule_missing_for_material_prefix") || "Color rule missing for material"}: ${getRmDisplayName(rmItemId)}.`,
        });
      });
    }
  }

  const hasSkuOverrideTable = await hasBomSkuOverrideTable(db);
  const hasSkuOverrideDeptColumn = hasSkuOverrideTable
    ? await hasBomSkuOverrideDeptColumn(db)
    : false;
  if (skuOverrides.length && (!hasSkuOverrideTable || !hasSkuOverrideDeptColumn)) {
    details.push({
      field: "sku_overrides_json",
      message:
        t("bom_error_sku_override_table_missing")
        || "SKU override storage is not available. Please run latest migration.",
    });
  }
  if (skuOverrides.length && hasSkuOverrideTable && hasSkuOverrideDeptColumn) {
    const rmDeptByItemMap = new Map();
    rmLines.forEach((line) => {
      const rmItemId = toNumberOrNull(line.rm_item_id);
      const deptId = toNumberOrNull(line.dept_id);
      if (!rmItemId || !deptId) return;
      if (!rmDeptByItemMap.has(rmItemId)) rmDeptByItemMap.set(rmItemId, new Set());
      rmDeptByItemMap.get(rmItemId).add(deptId);
    });
    const baseRmDeptSet = new Set(
      rmLines
        .map((line) => {
          const rmItemId = toNumberOrNull(line.rm_item_id);
          const deptId = toNumberOrNull(line.dept_id);
          if (!rmItemId || !deptId) return "";
          return `${rmItemId}:${deptId}`;
        })
        .filter(Boolean),
    );
    const overrideUniqueSet = new Set();
    const overrideSkuIds = [...new Set(skuOverrides.map((line) => line.sku_id).filter(Boolean))];
    const skuRows = overrideSkuIds.length
      ? await db("erp.skus as s")
          .select("s.id", "v.item_id")
          .leftJoin("erp.variants as v", "s.variant_id", "v.id")
          .whereIn("s.id", overrideSkuIds)
      : [];
    const skuItemMap = new Map(skuRows.map((row) => [toNumberOrNull(row.id), toNumberOrNull(row.item_id)]));
    skuOverrides.forEach((line, idx) => {
      if (!line.dept_id && line.target_rm_item_id) {
        const candidateDeptSet = rmDeptByItemMap.get(line.target_rm_item_id) || new Set();
        if (candidateDeptSet.size === 1) {
          line.dept_id = [...candidateDeptSet][0];
        }
      }
      if (!line.sku_id || !line.target_rm_item_id || !line.dept_id) {
        details.push({
          field: "sku_overrides_json",
          message: formatRowMessage(
            idx,
            t("bom_error_sku_override_required")
            || "Select SKU, target raw material, and consumption department.",
          ),
        });
        return;
      }
      if (!baseRmDeptSet.has(`${line.target_rm_item_id}:${line.dept_id}`)) {
        details.push({
          field: "sku_overrides_json",
          message: formatRowMessage(
            idx,
            t("bom_error_sku_override_target_missing")
            || "Target raw material + department must match a BOM material line.",
          ),
        });
      }
      const uniqueKey = `${line.sku_id}:${line.target_rm_item_id}:${line.dept_id}`;
      if (overrideUniqueSet.has(uniqueKey)) {
        details.push({
          field: "sku_overrides_json",
          message: formatRowMessage(
            idx,
            t("bom_error_sku_override_duplicate")
            || "Duplicate SKU override for the same material and department.",
          ),
        });
      } else {
        overrideUniqueSet.add(uniqueKey);
      }
      const skuItemId = skuItemMap.get(line.sku_id);
      if (!skuItemId || Number(skuItemId) !== Number(itemId)) {
        details.push({
          field: "sku_overrides_json",
          message: formatRowMessage(idx, t("bom_error_sku_override_item_mismatch") || "Selected SKU does not belong to this BOM article."),
        });
      }
      const targetRm = allRuleRmMap.get(line.target_rm_item_id);
      if (!targetRm || targetRm.item_type !== "RM") {
        details.push({
          field: "sku_overrides_json",
          message: formatRowMessage(idx, t("bom_error_rm_item_invalid") || "Raw material line must reference an RM item."),
        });
      }
      if (line.replacement_rm_item_id) {
        const replacementRm = allRuleRmMap.get(line.replacement_rm_item_id);
        if (!replacementRm || replacementRm.item_type !== "RM") {
          details.push({
            field: "sku_overrides_json",
            message: formatRowMessage(idx, t("bom_error_rm_item_invalid") || "Raw material line must reference an RM item."),
          });
        } else {
          line.override_uom_id = toNumberOrNull(replacementRm.base_uom_id);
        }
      } else if (targetRm?.base_uom_id) {
        line.override_uom_id = toNumberOrNull(targetRm.base_uom_id);
      }
      if (!line.is_excluded && !line.override_qty && !line.replacement_rm_item_id && !line.rm_color_id) {
        details.push({
          field: "sku_overrides_json",
          message: formatRowMessage(idx, t("bom_error_sku_override_no_change") || "Add at least one change: exclude, quantity, replacement material, or color."),
        });
      }
      if (line.rm_color_id && !activeColorSet.has(line.rm_color_id)) {
        details.push({
          field: "sku_overrides_json",
          message: formatRowMessage(idx, t("bom_error_variant_invalid_color") || "Selected color is invalid for this BOM item."),
        });
      }
      if (line.is_excluded) {
        line.override_qty = null;
      }
    });
  }

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
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    variant_rules: variantRules,
    sku_overrides: skuOverrides,
  };
};

const ensureDraftUniqueness = async (db, { itemId, level, excludeId, t }) => {
  let query = db("erp.bom_header").select("id", "bom_no").where({ item_id: itemId, level, status: "DRAFT" });
  if (excludeId) query = query.andWhereNot({ id: excludeId });
  const existing = await query.first();
  if (existing) {
    throw makeValidationError(t("bom_error_draft_exists") || "A draft already exists for this item and level.", [
      { field: "item_id", message: t("bom_error_draft_exists") || "A draft already exists for this item and level." },
    ]);
  }
};

const ensureNoExistingBomForItem = async (db, { itemId, excludeId, t }) => {
  let query = db("erp.bom_header").select("id").where({ item_id: itemId });
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
  const variantRules = toArray(snapshot.variant_rules)
    .map((line) => ({
      size_scope: normalizeScope(line.size_scope),
      size_id: toNumberOrNull(line.size_id),
      packing_scope: normalizeScope(line.packing_scope),
      packing_type_id: toNumberOrNull(line.packing_type_id),
      color_scope: normalizeScope(line.color_scope),
      color_id: toNumberOrNull(line.color_id),
      action_type: String(line.action_type || "").toUpperCase(),
      material_scope: normalizeScope(line.material_scope),
      target_rm_item_id: toNumberOrNull(line.target_rm_item_id),
      new_value: toSortedObject(parseJsonObject(line.new_value)),
    }))
    .sort((a, b) =>
      `${a.size_scope || "ALL"}:${a.size_id || 0}:${a.packing_scope || "ALL"}:${a.packing_type_id || 0}:${a.color_scope || "ALL"}:${a.color_id || 0}:${a.action_type || ""}:${a.material_scope || "ALL"}:${a.target_rm_item_id || 0}`.localeCompare(
        `${b.size_scope || "ALL"}:${b.size_id || 0}:${b.packing_scope || "ALL"}:${b.packing_type_id || 0}:${b.color_scope || "ALL"}:${b.color_id || 0}:${b.action_type || ""}:${b.material_scope || "ALL"}:${b.target_rm_item_id || 0}`,
      ),
    );
  const skuOverrides = toArray(snapshot.sku_overrides)
    .map((line) => ({
      sku_id: toNumberOrNull(line.sku_id),
      target_rm_item_id: toNumberOrNull(line.target_rm_item_id),
      dept_id: toNumberOrNull(line.dept_id),
      is_excluded: Boolean(line.is_excluded),
      override_qty: toPositiveNumber(line.override_qty),
      override_uom_id: toNumberOrNull(line.override_uom_id),
      replacement_rm_item_id: toNumberOrNull(line.replacement_rm_item_id),
      rm_color_id: toNumberOrNull(line.rm_color_id),
      notes: String(line.notes || "").trim() || null,
    }))
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
    variant_rules: variantRules,
    sku_overrides: skuOverrides,
  };
};

const snapshotSignature = (snapshot = {}) => JSON.stringify(toSortedObject(buildApprovalSnapshot(snapshot)));

const replaceBomLines = async (trx, bomId, lines) => {
  await trx("erp.bom_rm_line").where({ bom_id: bomId }).del();
  await trx("erp.bom_sfg_line").where({ bom_id: bomId }).del();
  await trx("erp.bom_labour_line").where({ bom_id: bomId }).del();
  await trx("erp.bom_variant_rule").where({ bom_id: bomId }).del();
  const hasSkuOverrideTable = await hasBomSkuOverrideTable(trx);
  const hasSkuOverrideDeptColumn = hasSkuOverrideTable
    ? await hasBomSkuOverrideDeptColumn(trx)
    : false;
  if (hasSkuOverrideTable) {
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

  if (lines.variant_rules?.length) {
    await trx("erp.bom_variant_rule").insert(
      lines.variant_rules.map((line) => ({
        bom_id: bomId,
        size_scope: line.size_scope,
        size_id: line.size_scope === "SPECIFIC" ? line.size_id : null,
        packing_scope: line.packing_scope,
        packing_type_id: line.packing_scope === "SPECIFIC" ? line.packing_type_id : null,
        color_scope: line.color_scope,
        color_id: line.color_scope === "SPECIFIC" ? line.color_id : null,
        action_type: line.action_type,
        material_scope: line.material_scope,
        target_rm_item_id: line.material_scope === "SPECIFIC" ? line.target_rm_item_id : null,
        new_value: line.new_value || {},
      })),
    );
  }
  if (hasSkuOverrideTable && lines.sku_overrides?.length) {
    await trx("erp.bom_sku_override_line").insert(
      lines.sku_overrides.map((line) => ({
        bom_id: bomId,
        sku_id: line.sku_id,
        target_rm_item_id: line.target_rm_item_id,
        ...(hasSkuOverrideDeptColumn ? { dept_id: line.dept_id || null } : {}),
        is_excluded: Boolean(line.is_excluded),
        override_qty: line.override_qty || null,
        override_uom_id: line.override_uom_id || null,
        replacement_rm_item_id: line.replacement_rm_item_id || null,
        rm_color_id: line.rm_color_id || null,
        notes: line.notes || null,
      })),
    );
  }
};

const getBomSnapshot = async (db, bomId) => {
  const lifecycleSupported = await hasBomLifecycleColumn(db);
  const headerFields = ["id", "bom_no", "item_id", "level", "output_qty", "output_uom_id", "status", "version_no", "created_by", "approved_by"];
  if (lifecycleSupported) headerFields.push("is_active");
  const header = await db("erp.bom_header").select(headerFields).where({ id: bomId }).first();
  if (header && !lifecycleSupported) header.is_active = true;
  if (!header) return null;
  const hasSkuOverrideTable = await hasBomSkuOverrideTable(db);
  const hasSkuOverrideDeptColumn = hasSkuOverrideTable
    ? await hasBomSkuOverrideDeptColumn(db)
    : false;
  const [rmLines, sfgLines, labourLines, variantRules, skuOverrides] = await Promise.all([
    db("erp.bom_rm_line").select("rm_item_id", "color_id", "size_id", "dept_id", "qty", "uom_id", "normal_loss_pct").where({ bom_id: bomId }).orderBy("id", "asc"),
    db("erp.bom_sfg_line").select("fg_size_id", "sfg_sku_id", "required_qty", "uom_id", "ref_approved_bom_id").where({ bom_id: bomId }).orderBy("id", "asc"),
    db("erp.bom_labour_line").select("size_scope", "size_id", "dept_id", "labour_id", "rate_type", "rate_value").where({ bom_id: bomId }).orderBy("id", "asc"),
    db("erp.bom_variant_rule").select("size_scope", "size_id", "packing_scope", "packing_type_id", "color_scope", "color_id", "action_type", "material_scope", "target_rm_item_id", "new_value").where({ bom_id: bomId }).orderBy("id", "asc"),
    hasSkuOverrideTable
      ? db("erp.bom_sku_override_line")
          .select(
            "sku_id",
            "target_rm_item_id",
            ...(hasSkuOverrideDeptColumn ? ["dept_id"] : []),
            "is_excluded",
            "override_qty",
            "override_uom_id",
            "replacement_rm_item_id",
            "rm_color_id",
            "notes",
          )
          .where({ bom_id: bomId })
          .orderBy("id", "asc")
      : Promise.resolve([]),
  ]);
  return {
    header,
    rm_lines: rmLines,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    variant_rules: variantRules,
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
    .select("bh.id", "bh.is_active", "bh.item_id", "i.is_active as item_is_active")
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .where("bh.id", id)
    .first();
  if (!row) throw makeValidationError(t("error_not_found") || "Record not found.");
  if (nextActive && !row.item_is_active) {
    throw makeValidationError(
      t("bom_error_item_inactive_cannot_activate") || "Cannot activate BOM while the article is inactive.",
    );
  }
  await trx("erp.bom_header")
    .where({ id })
    .update({ is_active: nextActive });
  return { id, is_active: nextActive };
};

const toggleBomLifecycle = async (knex, params) => knex.transaction((trx) => toggleBomLifecycleTx(trx, params));

const validateDraftReadyForApproval = async (db, { bomId, t, locale = "en" } = {}) => {
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
  const itemId = toNumberOrNull(form.header.item_id);
  if (!itemId) {
    throw makeValidationError((t && t("bom_error_item_required")) || "Please select an item.");
  }

  const [itemRow, options] = await Promise.all([
    db("erp.items").select("id", "item_type", "uses_sfg").where({ id: itemId }).first(),
    loadFormOptions(db, locale, { includeItemId: itemId }),
  ]);

  const skuRows = Array.isArray(options?.itemSkuMap?.[String(itemId)])
    ? options.itemSkuMap[String(itemId)].filter((sku) => toNumberOrNull(sku?.size_id))
    : [];
  const rmLines = toArray(form.rm_lines)
    .map((line) => ({
      rm_item_id: toNumberOrNull(line?.rm_item_id),
      dept_id: toNumberOrNull(line?.dept_id),
    }))
    .filter((line) => line.rm_item_id && line.dept_id);
  const skuOverrideRows = toArray(form.sku_overrides)
    .map((row) => ({
      sku_id: toNumberOrNull(row?.sku_id),
      target_rm_item_id: toNumberOrNull(row?.target_rm_item_id),
      dept_id: toNumberOrNull(row?.dept_id),
      override_qty: toPositiveNumber(row?.override_qty),
      rm_color_id: toNumberOrNull(row?.rm_color_id),
    }))
    .filter((row) => row.sku_id && row.target_rm_item_id && row.dept_id);
  const skuOverrideMap = new Map(
    skuOverrideRows.map((row) => [`${row.sku_id}:${row.target_rm_item_id}:${row.dept_id}`, row]),
  );

  const getSkuLabel = (sku) => {
    const parts = [];
    if (sku?.size_name) parts.push(sku.size_name);
    if (sku?.color_name) parts.push(sku.color_name);
    if (sku?.packing_name) parts.push(sku.packing_name);
    if (sku?.grade_name) parts.push(sku.grade_name);
    return parts.length ? `(${parts.join(" ")})` : `SKU ${sku?.id || ""}`.trim();
  };

  if (String(form.header.level || "").toUpperCase() === "FINISHED" && String(itemRow?.item_type || "").toUpperCase() === "FG" && Boolean(itemRow?.uses_sfg)) {
    const validSfgBySize = new Set(
      toArray(form.sfg_lines)
        .map((line) => ({
          fg_size_id: toNumberOrNull(line?.fg_size_id),
          sfg_sku_id: toNumberOrNull(line?.sfg_sku_id),
          required_qty: toPositiveNumber(line?.required_qty),
        }))
        .filter((line) => line.fg_size_id && line.sfg_sku_id && line.required_qty)
        .map((line) => String(line.fg_size_id)),
    );
    const missingSfgSkus = skuRows.filter((sku) => !validSfgBySize.has(String(sku.size_id)));
    if (missingSfgSkus.length) {
      const sample = missingSfgSkus.slice(0, 12).map((sku) => getSkuLabel(sku)).join(", ");
      const suffix = missingSfgSkus.length > 12 ? ` (+${missingSfgSkus.length - 12})` : "";
      details.push({
        field: "sfg_lines_json",
        message:
          "Complete all Semi-Finished rows for every Article SKU before sending for approval."
          + (sample ? ` ${sample}${suffix}` : ""),
      });
    }
  }

  if (skuRows.length && rmLines.length) {
    const rmNameById = new Map((options?.rmItems || []).map((row) => [toNumberOrNull(row.id), row?.name || row?.code || row?.id]));
    const deptNameById = new Map((options?.departments || []).map((row) => [toNumberOrNull(row.id), row?.name || row?.id]));
    const rmItemColorMap = options?.rmItemColorMap || {};
    const missing = [];

    skuRows.forEach((sku) => {
      rmLines.forEach((rmLine) => {
        const key = `${toNumberOrNull(sku.id)}:${rmLine.rm_item_id}:${rmLine.dept_id}`;
        const override = skuOverrideMap.get(key);
        const requiresColor = Array.isArray(rmItemColorMap[String(rmLine.rm_item_id)]) && rmItemColorMap[String(rmLine.rm_item_id)].length > 1;
        const hasQty = Boolean(override?.override_qty);
        const hasColor = !requiresColor || Boolean(override?.rm_color_id);
        if (hasQty && hasColor) return;
        missing.push({
          sku,
          rmName: rmNameById.get(rmLine.rm_item_id) || `RM ${rmLine.rm_item_id}`,
          deptName: deptNameById.get(rmLine.dept_id) || `Dept ${rmLine.dept_id}`,
          missingQty: !hasQty,
          missingColor: !hasColor,
        });
      });
    });

    if (missing.length) {
      const sample = missing.slice(0, 12).map((row) => {
        const needs = [row.missingQty ? "qty" : "", row.missingColor ? "color" : ""].filter(Boolean).join("+");
        return `${getSkuLabel(row.sku)} - ${row.rmName} - ${row.deptName}${needs ? ` (${needs})` : ""}`;
      }).join("; ");
      const suffix = missing.length > 12 ? ` (+${missing.length - 12})` : "";
      details.push({
        field: "sku_overrides_json",
        message:
          "Complete all SKU Rules rows (quantity and required color variant) before sending for approval."
          + (sample ? ` ${sample}${suffix}` : ""),
      });
    }
  }

  if (details.length) {
    throw makeValidationError("Please complete all mandatory BOM rows before sending for approval.", details);
  }
  return true;
};

const saveBomDraftTx = async (trx, { input, bomId, userId, requestId, t }) => {
  const normalized = await validateAndNormalizeInput(trx, input, t);
  const lifecycleSupported = await hasBomLifecycleColumn(trx);
  const actorId = userId || null;
  const existingId = bomId ? Number(bomId) : null;
  const before = existingId ? await getBomSnapshot(trx, existingId) : null;

  await ensureDraftUniqueness(trx, {
    itemId: normalized.header.item_id,
    level: normalized.header.level,
    excludeId: existingId,
    t,
  });

  let targetId = existingId;
  let versionNo = 1;
  let bomNo = null;

  if (!existingId) {
    await ensureNoExistingBomForItem(trx, {
      itemId: normalized.header.item_id,
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
    const pendingDecisionExists = await hasPendingApprovalForBomTx(trx, existingId);
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
    const isSingleDraftConstraint =
      err?.code === "23505" && (String(err?.constraint || "").includes("ux_bom_header_single_draft") || String(err?.message || "").includes("ux_bom_header_single_draft"));
    if (isSingleDraftConstraint) {
      throw makeValidationError((params?.t && params.t("bom_error_draft_exists")) || "A draft already exists for this item and level.", [
        { field: "item_id", message: (params?.t && params.t("bom_error_draft_exists")) || "A draft already exists for this item and level." },
      ]);
    }
    throw err;
  }
};

const saveAndApproveFromInput = async (knex, { input, bomId, userId, requestId, t, locale = "en" }) =>
  knex.transaction(async (trx) => {
    const saved = await saveBomDraftTx(trx, {
      input,
      bomId: bomId || null,
      userId: userId || null,
      requestId: requestId || null,
      t,
    });
    await validateDraftReadyForApproval(trx, {
      bomId: saved.id,
      t,
      locale,
    });
    await approveBomDirectTx(trx, {
      bomId: saved.id,
      userId: userId || null,
      requestId: requestId || null,
      t,
    });
    return saved;
  });

const approveBomDirectTx = async (trx, { bomId, userId, requestId, t }) => {
  const id = Number(bomId);
  const row = await trx("erp.bom_header").select("id", "status", "version_no").where({ id }).first();
  if (!row) throw makeValidationError(t("error_not_found") || "Record not found.");
  if (row.status === "APPROVED") return { id, status: "APPROVED", versionNo: row.version_no };
  if (!["DRAFT", "PENDING"].includes(row.status)) {
    throw makeValidationError(t("bom_error_approve_requires_draft") || "Only draft BOM can be approved.");
  }

  const before = await getBomSnapshot(trx, id);
  await trx("erp.bom_header")
    .where({ id })
    .update({
      status: "APPROVED",
      approved_by: userId || null,
      approved_at: trx.fn.now(),
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

  const hasSkuOverrideTable = await hasBomSkuOverrideTable(trx);
  const hasSkuOverrideDeptColumn = hasSkuOverrideTable
    ? await hasBomSkuOverrideDeptColumn(trx)
    : false;
  const [rmLines, sfgLines, labourLines, variantRules, skuOverrides] = await Promise.all([
    trx("erp.bom_rm_line").select("rm_item_id", "color_id", "size_id", "dept_id", "qty", "uom_id", "normal_loss_pct").where({ bom_id: sourceId }),
    trx("erp.bom_sfg_line").select("fg_size_id", "sfg_sku_id", "required_qty", "uom_id", "ref_approved_bom_id").where({ bom_id: sourceId }),
    trx("erp.bom_labour_line").select("size_scope", "size_id", "dept_id", "labour_id", "rate_type", "rate_value").where({ bom_id: sourceId }),
    trx("erp.bom_variant_rule").select("size_scope", "size_id", "packing_scope", "packing_type_id", "color_scope", "color_id", "action_type", "material_scope", "target_rm_item_id", "new_value").where({ bom_id: sourceId }),
    hasSkuOverrideTable
      ? trx("erp.bom_sku_override_line")
          .select(
            "sku_id",
            "target_rm_item_id",
            ...(hasSkuOverrideDeptColumn ? ["dept_id"] : []),
            "is_excluded",
            "override_qty",
            "override_uom_id",
            "replacement_rm_item_id",
            "rm_color_id",
            "notes",
          )
          .where({ bom_id: sourceId })
      : Promise.resolve([]),
  ]);

  await replaceBomLines(trx, newBomId, {
    rm_lines: rmLines,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    variant_rules: variantRules,
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

const loadFormOptions = async (knex, locale = "en", options = {}) => {
  const useUr = locale === "ur";
  const excludeExistingBomItems = Boolean(options?.excludeExistingBomItems);
  const includeItemId = toNumberOrNull(options?.includeItemId);
  const [hasLabourDeptTable, hasSizeItemTypesTable] = await Promise.all([
    tableExists(knex, "erp.labour_department"),
    tableExists(knex, "erp.size_item_types"),
  ]);
  const [itemsRaw, rmItems, uoms, departments, sizes, colors, packings, labours, labourDeptRows, rmRateVariants, sfgSkus, itemSkus, fgSfgVariantDims, sizeItemTypeRows, fgSfgUsageRows, existingBomItemRows] = await Promise.all([
    knex("erp.items")
      .select("id", "code", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name", "item_type", "base_uom_id", "uses_sfg", "sfg_part_type")
      .whereIn("item_type", ["FG", "SFG"])
      .andWhere({ is_active: true })
      .orderBy("name", "asc"),
    knex("erp.items")
      .select("id", "code", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name", "base_uom_id")
      .where({ item_type: "RM", is_active: true })
      .orderBy("name", "asc"),
    knex("erp.uom").select("id", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name").where({ is_active: true }).orderBy("name", "asc"),
    knex("erp.departments")
      .select("id", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name")
      .where({ is_active: true, is_production: true })
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
    excludeExistingBomItems
      ? knex("erp.bom_header")
          .distinct("item_id")
          .whereNotNull("item_id")
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

  const productionDeptSet = new Set((departments || []).map((row) => Number(row.id)).filter(Boolean));
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

  return {
    items,
    rmItems,
    uoms,
    departments,
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

const listBoms = async (knex, filters = {}) => {
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

  const query = knex("erp.bom_header as bh")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.level",
      "bh.status",
      lifecycleSupported
        ? "bh.is_active as bom_is_active"
        : knex.raw("COALESCE(i.is_active, true) as bom_is_active"),
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
            AND ar.status = 'PENDING') AS pending_approval_count`,
      ),
    )
    .leftJoin("erp.items as i", "bh.item_id", "i.id")
    .leftJoin("erp.users as u", "bh.created_by", "u.id")
    .leftJoin("erp.users as au", "bh.approved_by", "au.id")
    .orderBy("bh.id", "desc");

  if (workflow && ["DRAFT", "PENDING", "APPROVED", "REJECTED"].includes(workflow)) query.where("bh.status", workflow);
  if (level && BOM_LEVELS.has(level)) query.where("bh.level", level);
  if (lifecycle === "active") query.where(lifecycleSupported ? "bh.is_active" : "i.is_active", true);
  if (lifecycle === "inactive") query.where(lifecycleSupported ? "bh.is_active" : "i.is_active", false);
  if (q) {
    query.where((builder) => {
      builder.whereILike("bh.bom_no", `%${q}%`).orWhereILike("i.name", `%${q}%`).orWhereILike("i.code", `%${q}%`);
    });
  }
  if (rows !== "all") query.limit(rows);

  return query;
};

const getBomForForm = async (knex, id) => {
  const bomId = Number(id);
  const lifecycleSupported = await hasBomLifecycleColumn(knex);
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

  const hasSkuOverrideTable = await hasBomSkuOverrideTable(knex);
  const hasSkuOverrideDeptColumn = hasSkuOverrideTable
    ? await hasBomSkuOverrideDeptColumn(knex)
    : false;
  const [rmLines, sfgLines, labourLines, variantRules, skuOverrides] = await Promise.all([
    knex("erp.bom_rm_line")
      .select("id", "rm_item_id", "color_id", "size_id", "dept_id", "qty", "uom_id", "normal_loss_pct")
      .where({ bom_id: bomId })
      .orderBy("id", "asc"),
    knex("erp.bom_sfg_line")
      .select("id", "fg_size_id", "sfg_sku_id", "required_qty", "uom_id", "ref_approved_bom_id")
      .where({ bom_id: bomId })
      .orderBy("id", "asc"),
    knex("erp.bom_labour_line")
      .select("id", "size_scope", "size_id", "dept_id", "labour_id", "rate_type", "rate_value")
      .where({ bom_id: bomId })
      .orderBy("id", "asc"),
    knex("erp.bom_variant_rule")
      .select("id", "size_scope", "size_id", "packing_scope", "packing_type_id", "color_scope", "color_id", "action_type", "material_scope", "target_rm_item_id", "new_value")
      .where({ bom_id: bomId })
      .orderBy("id", "asc"),
    hasSkuOverrideTable
      ? knex("erp.bom_sku_override_line")
          .select(
            "id",
            "sku_id",
            "target_rm_item_id",
            ...(hasSkuOverrideDeptColumn ? ["dept_id"] : []),
            "is_excluded",
            "override_qty",
            "override_uom_id",
            "replacement_rm_item_id",
            "rm_color_id",
            "notes",
          )
          .where({ bom_id: bomId })
          .orderBy("id", "asc")
      : Promise.resolve([]),
  ]);

  return {
    header,
    rm_lines: rmLines,
    sfg_lines: sfgLines,
    labour_lines: labourLines,
    variant_rules: variantRules,
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
    variant_rules: input.variant_rules,
    sku_overrides: input.sku_overrides || [],
  },
});

const buildApproveDraftPayload = ({ bomId, snapshot }) => ({
  schema_version: 1,
  _action: "approve_draft",
  bom_id: bomId || null,
  snapshot: buildApprovalSnapshot(snapshot || {}),
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
  saveAndApproveFromInput,
  validateDraftReadyForApproval,
  approveBomDirect,
  approveBomDirectTx,
  createNewVersionFromApproved,
  createNewVersionFromApprovedTx,
  hasPendingApprovalForBom,
  hasPendingApprovalForBomTx,
  setBomPending,
  setBomPendingTx,
  resetPendingBomAfterRejectTx,
  buildApprovalSnapshot,
  buildApprovalPayload,
  buildApproveDraftPayload,
  applyApprovedBomChange,
  toggleBomLifecycle,
  toggleBomLifecycleTx,
};
