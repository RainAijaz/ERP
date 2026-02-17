const knex = require("../../db/knex");

const APPLY_ON = {
  SKU: "SKU",
  SUBGROUP: "SUBGROUP",
  GROUP: "GROUP",
  ALL: "ALL",
};

const PRECEDENCE = [APPLY_ON.SKU, APPLY_ON.SUBGROUP, APPLY_ON.GROUP, APPLY_ON.ALL];
const ALLOWED_SCOPE_FOR_BULK = new Set([APPLY_ON.SUBGROUP, APPLY_ON.GROUP]);
const ALLOWED_BASIS = new Set(["NET_SALES_PERCENT", "GROSS_MARGIN_PERCENT", "FIXED_PER_UNIT", "FIXED_PER_INVOICE"]);

const deriveValueTypeFromBasis = (commissionBasis) => {
  if (commissionBasis === "NET_SALES_PERCENT" || commissionBasis === "GROSS_MARGIN_PERCENT") return "PERCENT";
  if (commissionBasis === "FIXED_PER_UNIT" || commissionBasis === "FIXED_PER_INVOICE") return "FIXED";
  return null;
};

const toPositiveIntOrNull = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const toMoney = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return Number(numberValue.toFixed(2));
};

const hasTwoDecimalsOrLess = (value) => {
  if (value === null || value === undefined || value === "") return false;
  const raw = String(value);
  const dot = raw.indexOf(".");
  if (dot === -1) return true;
  return raw.slice(dot + 1).length <= 2;
};

const normalizeBulkInput = ({ payload, t }) => {
  const employeeId = toPositiveIntOrNull(payload.employee_id);
  if (!employeeId) throw new Error(t("error_required_fields") || "Required fields are missing.");

  const applyOn = String(payload.apply_on || "").trim().toUpperCase();
  if (!ALLOWED_SCOPE_FOR_BULK.has(applyOn)) {
    throw new Error(t("error_group_subgroup_only_for_bulk_commission") || "Only Product Group or Product Sub-Group can be used for bulk commission update.");
  }

  const commissionBasis = String(payload.commission_basis || "").trim().toUpperCase();
  if (!ALLOWED_BASIS.has(commissionBasis)) {
    throw new Error(t("error_invalid_commission_basis") || "Invalid commission basis selected.");
  }

  const subgroupId = applyOn === APPLY_ON.SUBGROUP ? toPositiveIntOrNull(payload.subgroup_id) : null;
  const groupId = applyOn === APPLY_ON.GROUP ? toPositiveIntOrNull(payload.group_id) : null;
  if (applyOn === APPLY_ON.SUBGROUP && !subgroupId) {
    throw new Error(t("error_select_subgroup") || "Please select a product sub-group.");
  }
  if (applyOn === APPLY_ON.GROUP && !groupId) {
    throw new Error(t("error_select_group") || "Please select a product group.");
  }

  const reverseOnReturns = payload.reverse_on_returns === true || payload.reverse_on_returns === "true" || payload.reverse_on_returns === "on";
  const statusRaw = String(payload.status || "active").trim().toLowerCase();
  if (statusRaw !== "active" && statusRaw !== "inactive") {
    throw new Error(t("error_invalid_status") || "Invalid status selected.");
  }

  const valueType = deriveValueTypeFromBasis(commissionBasis);
  if (!valueType) throw new Error(t("error_invalid_value_type") || "Invalid value type selected.");

  const rowsSource = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = rowsSource.map((row) => {
    const skuId = toPositiveIntOrNull(row.sku_id);
    const rateRaw = row.new_rate;
    const money = toMoney(rateRaw);
    if (!skuId) throw new Error(t("error_invalid_bulk_commission_payload") || "Invalid commission payload.");
    if (money === null || Number(money) < 0 || !hasTwoDecimalsOrLess(rateRaw) || Number(money) > 99999999.99) {
      throw new Error(t("error_invalid_rate_value") || "Invalid value. Enter a non-negative number with up to 2 decimals.");
    }
    return {
      skuId,
      rate: money,
    };
  });

  if (!rows.length) {
    throw new Error(t("error_no_target_skus_found") || "No target SKUs found for selected Product Group/Sub-Group.");
  }

  return {
    employeeId,
    applyOn,
    subgroupId,
    groupId,
    commissionBasis,
    valueType,
    reverseOnReturns,
    status: statusRaw,
    rows,
  };
};

const fetchTargetSkus = async ({ db = knex, applyOn, subgroupId, groupId }) => {
  let query = db("erp.skus as s")
    .join("erp.variants as v", "s.variant_id", "v.id")
    .join("erp.items as i", "v.item_id", "i.id")
    .select(
      "s.id as sku_id",
      "s.sku_code",
      "i.name as item_name",
      "i.subgroup_id",
      "i.group_id",
    )
    .whereRaw("i.item_type = 'FG'")
    .orderBy("s.sku_code", "asc");

  if (applyOn === APPLY_ON.SUBGROUP) query = query.andWhere("i.subgroup_id", subgroupId);
  if (applyOn === APPLY_ON.GROUP) query = query.andWhere("i.group_id", groupId);

  return query;
};

const fetchExistingRules = async ({ db = knex, employeeId, commissionBasis }) => {
  const employee = Number(employeeId || 0);
  if (!Number.isInteger(employee) || employee <= 0) return [];

  const basis = String(commissionBasis || "").trim().toUpperCase();
  if (!basis) return [];

  return db("erp.employee_commission_rules")
    .select("id", "apply_on", "sku_id", "subgroup_id", "group_id", "value", "status", "reverse_on_returns")
    .where({
      employee_id: employee,
      commission_basis: basis,
      status: "active",
    });
};

const resolvePreviousForSku = ({ existingRules, sku }) => {
  for (const scope of PRECEDENCE) {
    const matched = existingRules.find((rule) => {
      if (String(rule.apply_on || "").toUpperCase() !== scope) return false;
      if (scope === APPLY_ON.SKU) return Number(rule.sku_id) === Number(sku.sku_id);
      if (scope === APPLY_ON.SUBGROUP) return Number(rule.subgroup_id) === Number(sku.subgroup_id || 0);
      if (scope === APPLY_ON.GROUP) return Number(rule.group_id) === Number(sku.group_id || 0);
      return true;
    });
    if (matched) {
      return {
        previousRate: matched.value == null ? null : Number(matched.value),
        previousSource: scope,
        previousRuleId: Number(matched.id),
      };
    }
  }
  return {
    previousRate: null,
    previousSource: null,
    previousRuleId: null,
  };
};

const buildBulkPreviewRows = async ({
  db = knex,
  employeeId,
  applyOn,
  subgroupId = null,
  groupId = null,
  commissionBasis,
  baseRate,
}) => {
  const targetSkus = await fetchTargetSkus({ db, applyOn, subgroupId, groupId });
  if (!targetSkus.length) return [];

  const existingRules = await fetchExistingRules({
    db,
    employeeId,
    commissionBasis,
  });

  const defaultRate = toMoney(baseRate);

  return targetSkus.map((sku) => {
    const previous = resolvePreviousForSku({ existingRules, sku });
    return {
      sku_id: Number(sku.sku_id),
      sku_code: sku.sku_code,
      item_name: sku.item_name || "",
      previous_rate: previous.previousRate,
      previous_source: previous.previousSource,
      previous_rule_id: previous.previousRuleId,
      new_rate: defaultRate,
    };
  });
};

const applyBulkSkuRateUpsert = async ({
  trx,
  employeeId,
  commissionBasis,
  valueType,
  reverseOnReturns,
  status,
  rows,
}) => {
  const skuIds = rows.map((row) => row.skuId);
  const existing = await trx("erp.employee_commission_rules")
    .select("id", "sku_id")
    .where({
      employee_id: employeeId,
      apply_on: APPLY_ON.SKU,
    })
    .whereIn("sku_id", skuIds)
    .orderBy("id", "desc");

  const existingBySku = new Map();
  const duplicateIdsToDelete = [];
  existing.forEach((row) => {
    const key = Number(row.sku_id);
    if (!existingBySku.has(key)) {
      existingBySku.set(key, Number(row.id));
      return;
    }
    duplicateIdsToDelete.push(Number(row.id));
  });

  if (duplicateIdsToDelete.length) {
    await trx("erp.employee_commission_rules")
      .whereIn("id", duplicateIdsToDelete)
      .del();
  }

  let updated = 0;
  let created = 0;

  for (const row of rows) {
    const existingId = existingBySku.get(Number(row.skuId));
    if (existingId) {
      await trx("erp.employee_commission_rules")
        .where({ id: existingId })
        .update({
          value: row.rate,
          value_type: valueType,
          reverse_on_returns: reverseOnReturns,
          status,
          apply_on: APPLY_ON.SKU,
          subgroup_id: null,
          group_id: null,
        });
      updated += 1;
      continue;
    }

    await trx("erp.employee_commission_rules").insert({
      employee_id: employeeId,
      apply_on: APPLY_ON.SKU,
      sku_id: row.skuId,
      subgroup_id: null,
      group_id: null,
      commission_basis: commissionBasis,
      value: row.rate,
      reverse_on_returns: reverseOnReturns,
      value_type: valueType,
      status,
    });
    created += 1;
  }

  return { created, updated };
};

module.exports = {
  APPLY_ON,
  ALLOWED_SCOPE_FOR_BULK,
  deriveValueTypeFromBasis,
  normalizeBulkInput,
  buildBulkPreviewRows,
  applyBulkSkuRateUpsert,
  hasTwoDecimalsOrLess,
  toMoney,
};
