const knex = require("../../db/knex");

const APPLY_ON = {
  SKU: "SKU",
  SUBGROUP: "SUBGROUP",
  GROUP: "GROUP",
  ALL: "ALL",
};

const PRECEDENCE = [
  APPLY_ON.SKU,
  APPLY_ON.SUBGROUP,
  APPLY_ON.GROUP,
  APPLY_ON.ALL,
];
const ALLOWED_SCOPE_FOR_BULK = new Set([APPLY_ON.SUBGROUP, APPLY_ON.GROUP]);
const COMMISSION_BASIS_FIXED_PER_UNIT = "FIXED_PER_UNIT";
const COMMISSION_RATE_TYPES = new Set(["PER_DOZEN", "PER_PAIR"]);

const deriveValueTypeFromBasis = (commissionBasis) => {
  if (
    commissionBasis === "NET_SALES_PERCENT" ||
    commissionBasis === "GROSS_MARGIN_PERCENT"
  )
    return "PERCENT";
  if (
    commissionBasis === "FIXED_PER_UNIT" ||
    commissionBasis === "FIXED_PER_INVOICE"
  )
    return "FIXED";
  return null;
};

const toPositiveIntOrNull = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const toPositiveIntArray = (value) => {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value == null
        ? []
        : [value];
  return [
    ...new Set(
      source.map((entry) => toPositiveIntOrNull(entry)).filter(Boolean),
    ),
  ];
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
  if (!employeeId) throw new Error(t("error_required_fields"));

  const applyOn = String(payload.apply_on || "")
    .trim()
    .toUpperCase();
  if (!ALLOWED_SCOPE_FOR_BULK.has(applyOn)) {
    throw new Error(t("error_group_subgroup_only_for_bulk_commission"));
  }

  const commissionBasis = COMMISSION_BASIS_FIXED_PER_UNIT;
  const rateType = String(payload.rate_type || "PER_PAIR")
    .trim()
    .toUpperCase();
  if (!COMMISSION_RATE_TYPES.has(rateType)) {
    throw new Error(t("error_invalid_rate_type"));
  }

  const subgroupIds =
    applyOn === APPLY_ON.SUBGROUP
      ? toPositiveIntArray(payload.subgroup_ids).length
        ? toPositiveIntArray(payload.subgroup_ids)
        : toPositiveIntArray(payload.subgroup_id)
      : [];
  const groupIds =
    applyOn === APPLY_ON.GROUP
      ? toPositiveIntArray(payload.group_ids).length
        ? toPositiveIntArray(payload.group_ids)
        : toPositiveIntArray(payload.group_id)
      : [];
  if (applyOn === APPLY_ON.SUBGROUP && !subgroupIds.length) {
    throw new Error(t("error_select_subgroup"));
  }
  if (applyOn === APPLY_ON.GROUP && !groupIds.length) {
    throw new Error(t("error_select_group"));
  }

  const reverseOnReturns =
    payload.reverse_on_returns === true ||
    payload.reverse_on_returns === "true" ||
    payload.reverse_on_returns === "on";
  const statusRaw = String(payload.status || "active")
    .trim()
    .toLowerCase();
  if (statusRaw !== "active" && statusRaw !== "inactive") {
    throw new Error(t("error_invalid_status"));
  }

  const valueType = deriveValueTypeFromBasis(commissionBasis);
  if (!valueType) throw new Error(t("error_invalid_value_type"));

  const rowsSource = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = rowsSource.map((row) => {
    const skuId = toPositiveIntOrNull(row.sku_id);
    const rateRaw = row.new_rate;
    const money = toMoney(rateRaw);
    if (!skuId) throw new Error(t("error_invalid_bulk_commission_payload"));
    if (
      money === null ||
      Number(money) < 0 ||
      !hasTwoDecimalsOrLess(rateRaw) ||
      Number(money) > 99999999.99
    ) {
      throw new Error(t("error_invalid_rate_value"));
    }
    return {
      skuId,
      rate: money,
    };
  });

  if (!rows.length) {
    throw new Error(t("error_no_target_skus_found"));
  }

  const scopeRateRaw =
    payload.scope_rate !== undefined && payload.scope_rate !== null
      ? payload.scope_rate
      : rows[0]?.rate;
  const scopeRate = toMoney(scopeRateRaw);
  if (scopeRate === null || scopeRate < 0 || scopeRate > 99999999.99) {
    throw new Error(t("error_invalid_rate_value"));
  }

  return {
    employeeId,
    applyOn,
    subgroupId: subgroupIds[0] || null,
    subgroupIds,
    groupId: groupIds[0] || null,
    groupIds,
    commissionBasis,
    rateType,
    valueType,
    scopeRate,
    reverseOnReturns,
    status: statusRaw,
    rows,
  };
};

const upsertBulkScopeRules = async ({
  trx,
  employeeId,
  applyOn,
  subgroupIds = [],
  groupIds = [],
  commissionBasis = COMMISSION_BASIS_FIXED_PER_UNIT,
  rateType = "PER_PAIR",
  valueType,
  scopeRate,
  reverseOnReturns,
  status,
}) => {
  if (!ALLOWED_SCOPE_FOR_BULK.has(applyOn)) return { created: 0, updated: 0 };
  if (scopeRate === null || scopeRate === undefined)
    return { created: 0, updated: 0 };

  const selectorColumn =
    applyOn === APPLY_ON.SUBGROUP ? "subgroup_id" : "group_id";
  const selectorIds = [
    ...new Set(
      (applyOn === APPLY_ON.SUBGROUP ? subgroupIds : groupIds)
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!selectorIds.length) return { created: 0, updated: 0 };

  const existing = await trx("erp.employee_commission_rules")
    .select("id", selectorColumn)
    .where({
      employee_id: employeeId,
      apply_on: applyOn,
      commission_basis: commissionBasis,
      value_type: valueType,
    })
    .whereRaw("COALESCE(sku_id, 0) = 0")
    .whereIn(selectorColumn, selectorIds)
    .orderBy("id", "desc");

  const existingBySelector = new Map();
  const duplicateIdsToDelete = [];
  existing.forEach((row) => {
    const key = Number(row[selectorColumn]);
    if (!existingBySelector.has(key)) {
      existingBySelector.set(key, Number(row.id));
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
  for (const selectorId of selectorIds) {
    const existingId = existingBySelector.get(selectorId);
    const payload = {
      value: scopeRate,
      rate_type: rateType,
      value_type: valueType,
      reverse_on_returns: reverseOnReturns,
      status,
      apply_on: applyOn,
      sku_id: null,
      subgroup_id: applyOn === APPLY_ON.SUBGROUP ? selectorId : null,
      group_id: applyOn === APPLY_ON.GROUP ? selectorId : null,
    };

    if (existingId) {
      await trx("erp.employee_commission_rules")
        .where({ id: existingId })
        .update(payload);
      updated += 1;
      continue;
    }

    await trx("erp.employee_commission_rules").insert({
      employee_id: employeeId,
      commission_basis: commissionBasis,
      ...payload,
    });
    created += 1;
  }

  return { created, updated };
};

const fetchTargetSkus = async ({
  db = knex,
  applyOn,
  subgroupIds = [],
  groupIds = [],
}) => {
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

  const normalizedSubgroupIds = [
    ...new Set(
      (Array.isArray(subgroupIds) ? subgroupIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  const normalizedGroupIds = [
    ...new Set(
      (Array.isArray(groupIds) ? groupIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  if (applyOn === APPLY_ON.SUBGROUP && normalizedSubgroupIds.length) {
    query = query.whereIn("i.subgroup_id", normalizedSubgroupIds);
  }
  if (applyOn === APPLY_ON.GROUP && normalizedGroupIds.length) {
    query = query.whereIn("i.group_id", normalizedGroupIds);
  }

  return query;
};

const fetchExistingRules = async ({
  db = knex,
  employeeId,
  commissionBasis = COMMISSION_BASIS_FIXED_PER_UNIT,
}) => {
  const employee = Number(employeeId || 0);
  if (!Number.isInteger(employee) || employee <= 0) return [];

  const basis = String(commissionBasis || "")
    .trim()
    .toUpperCase();
  if (!basis) return [];

  return db("erp.employee_commission_rules as ecr")
    .select(
      "id",
      "apply_on",
      "sku_id",
      "subgroup_id",
      "group_id",
      "value",
      db.raw(
        `COALESCE(NULLIF(to_jsonb(ecr)->>'rate_type', ''), 'PER_PAIR') as rate_type`,
      ),
      "status",
      "reverse_on_returns",
    )
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
      if (scope === APPLY_ON.SKU)
        return Number(rule.sku_id) === Number(sku.sku_id);
      if (scope === APPLY_ON.SUBGROUP)
        return Number(rule.subgroup_id) === Number(sku.subgroup_id || 0);
      if (scope === APPLY_ON.GROUP)
        return Number(rule.group_id) === Number(sku.group_id || 0);
      return true;
    });
    if (matched) {
      return {
        previousRate: matched.value == null ? null : Number(matched.value),
        previousRateType: String(matched.rate_type || "PER_PAIR")
          .trim()
          .toUpperCase(),
        previousSource: scope,
        previousRuleId: Number(matched.id),
      };
    }
  }
  return {
    previousRate: null,
    previousRateType: null,
    previousSource: null,
    previousRuleId: null,
  };
};

const buildBulkPreviewRows = async ({
  db = knex,
  employeeId,
  applyOn,
  subgroupId = null,
  subgroupIds = null,
  groupId = null,
  groupIds = null,
  commissionBasis = COMMISSION_BASIS_FIXED_PER_UNIT,
  baseRate,
}) => {
  const normalizedSubgroupIds = Array.isArray(subgroupIds)
    ? subgroupIds
    : subgroupId
      ? [subgroupId]
      : [];
  const normalizedGroupIds = Array.isArray(groupIds)
    ? groupIds
    : groupId
      ? [groupId]
      : [];
  const targetSkus = await fetchTargetSkus({
    db,
    applyOn,
    subgroupIds: normalizedSubgroupIds,
    groupIds: normalizedGroupIds,
  });
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
      subgroup_id: Number(sku.subgroup_id || 0) || null,
      group_id: Number(sku.group_id || 0) || null,
      previous_rate: previous.previousRate,
      previous_rate_type: previous.previousRateType,
      previous_source: previous.previousSource,
      previous_rule_id: previous.previousRuleId,
      new_rate: defaultRate,
    };
  });
};

const applyBulkSkuRateUpsert = async ({
  trx,
  employeeId,
  applyOn = APPLY_ON.SKU,
  subgroupIds = [],
  groupIds = [],
  commissionBasis = COMMISSION_BASIS_FIXED_PER_UNIT,
  rateType = "PER_PAIR",
  valueType,
  scopeRate = null,
  reverseOnReturns,
  status,
  rows,
}) => {
  const scopeResult = await upsertBulkScopeRules({
    trx,
    employeeId,
    applyOn,
    subgroupIds,
    groupIds,
    commissionBasis,
    rateType,
    valueType,
    scopeRate,
    reverseOnReturns,
    status,
  });

  const skuIds = rows.map((row) => row.skuId);
  const existing = await trx("erp.employee_commission_rules")
    .select("id", "sku_id")
    .where({
      employee_id: employeeId,
      apply_on: APPLY_ON.SKU,
      commission_basis: commissionBasis,
      value_type: valueType,
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
          rate_type: rateType,
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
      rate_type: rateType,
      reverse_on_returns: reverseOnReturns,
      value_type: valueType,
      status,
    });
    created += 1;
  }

  return {
    created: created + Number(scopeResult.created || 0),
    updated: updated + Number(scopeResult.updated || 0),
  };
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
