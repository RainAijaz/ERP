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
const COMMISSION_TYPES = new Set([
  "SALESMAN_SALE",
  "BRANCH_SALE",
  "TRANSFER",
  "PARTY",
  "PRODUCTION_FG",
  "PRODUCTION_SFG",
]);

// Which item type the bulk rate grid should list. Everything is sold as finished
// goods, so FG is the default; only semi-finished production commission is set
// against SFG SKUs.
const TARGET_ITEM_TYPE_BY_COMMISSION_TYPE = { PRODUCTION_SFG: "SFG" };
const resolveTargetItemType = (commissionType) =>
  TARGET_ITEM_TYPE_BY_COMMISSION_TYPE[
    String(commissionType || "").trim().toUpperCase()
  ] || "FG";

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

const todayYmd = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
};

// Accepts "" / null (open-ended) and both Date and YYYY-MM-DD. Returns undefined
// for a value that was supplied but is not a date, so callers can tell "not set"
// apart from "set to rubbish" — the same contract normalizeAllowanceDate uses.
const normalizeRuleDate = (value) => {
  if (value === null || value === undefined || String(value).trim() === "")
    return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return raw;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
};

const addDaysYmd = (ymd, days) => {
  const parsed = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};

const toBranchKey = (branchId) =>
  Number(branchId) > 0 ? Number(branchId) : null;

// Closes whatever rate currently covers this key and inserts the new one, so a
// rate change never destroys the rate it replaced.
//
//   before   Rs 5.00  from 2026-01-01  to (open)
//   save     Rs 7.00  from 2026-08-01
//   after    Rs 5.00  from 2026-01-01  to 2026-07-31
//            Rs 7.00  from 2026-08-01  to (open)
//
// A July voucher therefore still recalculates at 5.00. This is the ONLY sanctioned
// write path for a commission rule — the screen, the bulk grid and the approval
// applier all funnel through it, because a caller that INSERTs directly would
// leave two rows both claiming to be in force on the same day.
const supersedeCommissionRule = async ({
  trx,
  employeeId,
  commissionType,
  applyOn,
  branchId = null,
  skuId = null,
  subgroupId = null,
  groupId = null,
  effectiveFrom,
  effectiveTo = null,
  values = {},
}) => {
  const from = normalizeRuleDate(effectiveFrom) || todayYmd();
  const to = normalizeRuleDate(effectiveTo) || null;
  const branch = toBranchKey(branchId);

  const scopeQuery = () =>
    trx("erp.employee_commission_rules")
      .where({
        employee_id: employeeId,
        commission_type: commissionType,
        apply_on: applyOn,
      })
      .whereRaw("COALESCE(branch_id, 0) = ?", [branch || 0])
      .whereRaw("COALESCE(sku_id, 0) = ?", [Number(skuId) || 0])
      .whereRaw("COALESCE(subgroup_id, 0) = ?", [Number(subgroupId) || 0])
      .whereRaw("COALESCE(group_id, 0) = ?", [Number(groupId) || 0]);

  // Rows that start on or after the new row never had a chance to apply — the
  // new rate supersedes them outright rather than leaving an unreachable island.
  await scopeQuery().where("effective_from", ">=", from).del();

  // The rate currently covering `from` is closed the day before it.
  await scopeQuery()
    .where("effective_from", "<", from)
    .andWhere((builder) =>
      builder.whereNull("effective_to").orWhere("effective_to", ">=", from),
    )
    .update({ effective_to: addDaysYmd(from, -1) });

  const [inserted] = await trx("erp.employee_commission_rules")
    .insert({
      ...values,
      employee_id: employeeId,
      commission_type: commissionType,
      apply_on: applyOn,
      branch_id: branch,
      sku_id: skuId || null,
      subgroup_id: subgroupId || null,
      group_id: groupId || null,
      effective_from: from,
      effective_to: to,
    })
    .returning("id");

  return Number(typeof inserted === "object" ? inserted.id : inserted);
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

  const commissionTypeRaw = String(payload.commission_type || "SALESMAN_SALE").trim().toUpperCase();
  const commissionType = COMMISSION_TYPES.has(commissionTypeRaw) ? commissionTypeRaw : "SALESMAN_SALE";

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

  // Blank branch = every branch this employee is mapped to.
  const branchId = toPositiveIntOrNull(payload.branch_id);
  const effectiveFrom = normalizeRuleDate(payload.effective_from);
  const effectiveTo = normalizeRuleDate(payload.effective_to);
  if (effectiveFrom === undefined || effectiveTo === undefined)
    throw new Error(t("error_invalid_date"));
  if (!effectiveFrom) throw new Error(t("error_effective_from_required"));
  if (effectiveTo && effectiveTo < effectiveFrom)
    throw new Error(t("error_invalid_date_range"));

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
    commissionType,
    branchId,
    effectiveFrom,
    effectiveTo,
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

// Writes the group/subgroup-level "scope" rate that SKU rows fall back to.
//
// Every row goes through supersedeCommissionRule, so an existing rate is closed
// at the new effective_from rather than overwritten in place. That is why this
// no longer hunts for an existing id to UPDATE: within one (employee, type,
// branch, selector) key there is exactly one row in force at a time, and the
// helper is what guarantees it.
const upsertBulkScopeRules = async ({
  trx,
  employeeId,
  applyOn,
  commissionType = "SALESMAN_SALE",
  branchId = null,
  effectiveFrom,
  effectiveTo = null,
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

  const selectorIds = [
    ...new Set(
      (applyOn === APPLY_ON.SUBGROUP ? subgroupIds : groupIds)
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!selectorIds.length) return { created: 0, updated: 0 };

  let created = 0;
  const selectorToRuleId = new Map();
  for (const selectorId of selectorIds) {
    const newId = await supersedeCommissionRule({
      trx,
      employeeId,
      commissionType,
      applyOn,
      branchId,
      subgroupId: applyOn === APPLY_ON.SUBGROUP ? selectorId : null,
      groupId: applyOn === APPLY_ON.GROUP ? selectorId : null,
      effectiveFrom,
      effectiveTo,
      values: {
        commission_basis: commissionBasis,
        value: scopeRate,
        rate_type: rateType,
        value_type: valueType,
        reverse_on_returns: reverseOnReturns,
        status,
      },
    });
    selectorToRuleId.set(selectorId, newId);
    created += 1;
  }

  return { created, updated: 0, selectorToRuleId };
};

const fetchTargetSkus = async ({
  db = knex,
  applyOn,
  subgroupIds = [],
  groupIds = [],
  commissionType = "SALESMAN_SALE",
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
    .where("i.item_type", resolveTargetItemType(commissionType))
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

// commission_type is part of the filter: without it an employee holding rules of
// more than one type (say SALESMAN_SALE and PRODUCTION_FG on the same basis) would
// see whichever row happened to match first offered as the "previous rate".
const fetchExistingRules = async ({
  db = knex,
  employeeId,
  commissionBasis = COMMISSION_BASIS_FIXED_PER_UNIT,
  commissionType = "SALESMAN_SALE",
  branchId = null,
  onDate = null,
}) => {
  const employee = Number(employeeId || 0);
  if (!Number.isInteger(employee) || employee <= 0) return [];

  const basis = String(commissionBasis || "")
    .trim()
    .toUpperCase();
  if (!basis) return [];

  const effectiveDate = normalizeRuleDate(onDate) || todayYmd();
  const branch = toBranchKey(branchId);

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
      "branch_id",
    )
    .where({
      employee_id: employee,
      commission_basis: basis,
      commission_type: String(commissionType || "SALESMAN_SALE")
        .trim()
        .toUpperCase(),
      status: "active",
    })
    // "Previous rate" must mean the rate in force at the branch and on the date
    // the new rule starts — not whatever row happens to exist. Without this the
    // grid would offer a rate from a different branch as the thing being changed.
    .whereRaw("effective_from <= ?::date", [effectiveDate])
    .whereRaw("COALESCE(effective_to, ?::date) >= ?::date", [
      effectiveDate,
      effectiveDate,
    ])
    .modify((builder) => {
      if (branch) {
        builder.whereRaw("(branch_id IS NULL OR branch_id = ?)", [branch]);
      } else {
        builder.whereNull("branch_id");
      }
    });
};

const indexExistingRules = (existingRules) => {
  const bySkuId = new Map();
  const bySubgroupId = new Map();
  const byGroupId = new Map();
  let allRule = null;
  // Each map keeps the FIRST rule it sees for a key, so branch-pinned rules must
  // be visited first — otherwise a branch-wide rate would shadow the pinned one
  // and the grid would show the wrong "previous rate".
  const ordered = [...existingRules].sort(
    (a, b) => (b.branch_id ? 1 : 0) - (a.branch_id ? 1 : 0),
  );
  for (const rule of ordered) {
    const scope = String(rule.apply_on || "").toUpperCase();
    if (scope === APPLY_ON.SKU) {
      const key = Number(rule.sku_id);
      if (!bySkuId.has(key)) bySkuId.set(key, rule);
    } else if (scope === APPLY_ON.SUBGROUP) {
      const key = Number(rule.subgroup_id);
      if (!bySubgroupId.has(key)) bySubgroupId.set(key, rule);
    } else if (scope === APPLY_ON.GROUP) {
      const key = Number(rule.group_id);
      if (!byGroupId.has(key)) byGroupId.set(key, rule);
    } else if (scope === APPLY_ON.ALL && !allRule) {
      allRule = rule;
    }
  }
  return { bySkuId, bySubgroupId, byGroupId, allRule };
};

const resolvePreviousForSkuIndexed = ({ index, sku }) => {
  const matched =
    index.bySkuId.get(Number(sku.sku_id)) ||
    index.bySubgroupId.get(Number(sku.subgroup_id || 0)) ||
    index.byGroupId.get(Number(sku.group_id || 0)) ||
    index.allRule;
  if (!matched) {
    return { previousRate: null, previousRateType: null, previousSource: null, previousRuleId: null };
  }
  return {
    previousRate: matched.value == null ? null : Number(matched.value),
    previousRateType: String(matched.rate_type || "PER_PAIR").trim().toUpperCase(),
    previousSource: String(matched.apply_on || "").toUpperCase(),
    previousRuleId: Number(matched.id),
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
  commissionType = "SALESMAN_SALE",
  branchId = null,
  effectiveFrom = null,
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
  const [targetSkus, existingRules] = await Promise.all([
    fetchTargetSkus({
      db,
      applyOn,
      subgroupIds: normalizedSubgroupIds,
      groupIds: normalizedGroupIds,
      commissionType,
    }),
    fetchExistingRules({
      db,
      employeeId,
      commissionBasis,
      commissionType,
      branchId,
      onDate: effectiveFrom,
    }),
  ]);
  if (!targetSkus.length) return [];

  const index = indexExistingRules(existingRules);
  const defaultRate = toMoney(baseRate);

  return targetSkus.map((sku) => {
    const previous = resolvePreviousForSkuIndexed({ index, sku });
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
  commissionType = "SALESMAN_SALE",
  branchId = null,
  effectiveFrom,
  effectiveTo = null,
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
    commissionType,
    branchId,
    effectiveFrom,
    effectiveTo,
    subgroupIds,
    groupIds,
    commissionBasis,
    rateType,
    valueType,
    scopeRate,
    reverseOnReturns,
    status,
  });

  let created = 0;

  for (const row of rows) {
    const selectorId = applyOn === APPLY_ON.SUBGROUP
      ? Number(row.subgroupId || 0) || null
      : Number(row.groupId || 0) || null;
    const sourceRuleId = (selectorId && scopeResult.selectorToRuleId?.get(selectorId)) || null;

    // supersedeCommissionRule closes the rate this one replaces instead of
    // overwriting it, so historical rows survive and stay recalculable.
    await supersedeCommissionRule({
      trx,
      employeeId,
      commissionType,
      applyOn: APPLY_ON.SKU,
      branchId,
      skuId: row.skuId,
      effectiveFrom,
      effectiveTo,
      values: {
        commission_basis: commissionBasis,
        value: row.rate,
        rate_type: rateType,
        value_type: valueType,
        reverse_on_returns: reverseOnReturns,
        status,
        source_rule_id: sourceRuleId,
      },
    });
    created += 1;
  }

  return {
    created: created + Number(scopeResult.created || 0),
    updated: Number(scopeResult.updated || 0),
  };
};

module.exports = {
  APPLY_ON,
  ALLOWED_SCOPE_FOR_BULK,
  deriveValueTypeFromBasis,
  normalizeBulkInput,
  buildBulkPreviewRows,
  applyBulkSkuRateUpsert,
  supersedeCommissionRule,
  normalizeRuleDate,
  todayYmd,
  hasTwoDecimalsOrLess,
  toMoney,
};
