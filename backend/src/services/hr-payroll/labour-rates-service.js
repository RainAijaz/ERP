const knex = require("../../db/knex");

const APPLY_ON = {
  SKU: "SKU",
  SUBGROUP: "SUBGROUP",
  GROUP: "GROUP",
  FLAT: "FLAT",
};

const ARTICLE_TYPE = {
  FINISHED: "FG",
  SEMI_FINISHED: "SFG",
  BOTH: "BOTH",
};

const ALL_LABOURS_VALUE = "ALL";
const PRECEDENCE = [APPLY_ON.SKU, APPLY_ON.SUBGROUP, APPLY_ON.GROUP, APPLY_ON.FLAT];
const ALLOWED_RATE_TYPES = new Set(["PER_DOZEN", "PER_PAIR"]);
const ALLOWED_ARTICLE_TYPES = new Set([ARTICLE_TYPE.FINISHED, ARTICLE_TYPE.SEMI_FINISHED, ARTICLE_TYPE.BOTH]);

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

const normalizeLabourSelection = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return { all: false, labourId: null, raw: "" };
  if (raw.toUpperCase() === ALL_LABOURS_VALUE) {
    return { all: true, labourId: null, raw: ALL_LABOURS_VALUE };
  }
  const labourId = toPositiveIntOrNull(raw);
  return { all: false, labourId, raw };
};

const normalizeArticleType = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "FINISHED") return ARTICLE_TYPE.FINISHED;
  if (raw === "SEMI_FINISHED") return ARTICLE_TYPE.SEMI_FINISHED;
  if (raw === "BOTH") return ARTICLE_TYPE.BOTH;
  if (raw === ARTICLE_TYPE.FINISHED || raw === ARTICLE_TYPE.SEMI_FINISHED) return raw;
  return "";
};

const normalizeApplyOn = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === APPLY_ON.SUBGROUP) return APPLY_ON.SUBGROUP;
  if (raw === APPLY_ON.GROUP) return APPLY_ON.GROUP;
  return APPLY_ON.SKU;
};

const normalizeScopeInput = ({ payload, t }) => {
  const deptId = toPositiveIntOrNull(payload.dept_id);
  if (!deptId) throw new Error(t("error_select_department"));

  const labourSelection = normalizeLabourSelection(payload.labour_id);
  if (!labourSelection.all && !labourSelection.labourId) {
    throw new Error(t("error_select_labour"));
  }

  const articleType = normalizeArticleType(payload.article_type);
  if (!articleType) {
    throw new Error(t("error_select_article_type"));
  }
  if (!ALLOWED_ARTICLE_TYPES.has(articleType)) {
    throw new Error(t("error_invalid_article_type"));
  }

  const applyOn = normalizeApplyOn(payload.apply_on);
  const skuId = toPositiveIntOrNull(payload.sku_id);
  const subgroupId = toPositiveIntOrNull(payload.subgroup_id);
  const groupId = toPositiveIntOrNull(payload.group_id);

  if (applyOn === APPLY_ON.SKU && !skuId) throw new Error(t("error_select_sku"));
  if (applyOn === APPLY_ON.SUBGROUP && !subgroupId) throw new Error(t("error_select_subgroup"));
  if (applyOn === APPLY_ON.GROUP && !groupId) throw new Error(t("error_select_group"));

  const rateType = String(payload.rate_type || "").trim().toUpperCase();
  if (!rateType) throw new Error(t("error_select_rate_type"));
  if (!ALLOWED_RATE_TYPES.has(rateType)) {
    throw new Error(t("error_invalid_rate_type"));
  }

  const statusRaw = String(payload.status || "active").trim().toLowerCase();
  if (statusRaw !== "active" && statusRaw !== "inactive") {
    throw new Error(t("error_invalid_status"));
  }

  return {
    labourSelection,
    deptId,
    applyOn,
    skuId: applyOn === APPLY_ON.SKU ? skuId : null,
    subgroupId: applyOn === APPLY_ON.SUBGROUP ? subgroupId : null,
    groupId: applyOn === APPLY_ON.GROUP ? groupId : null,
    articleType,
    rateType,
    status: statusRaw,
  };
};

const normalizeBulkInput = ({ payload, t }) => {
  const scope = normalizeScopeInput({ payload, t });

  const rowsSource = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = rowsSource.map((row) => {
    const skuId = toPositiveIntOrNull(row.sku_id);
    const rateRaw = row.new_rate;
    const money = toMoney(rateRaw);
    if (!skuId) throw new Error(t("error_invalid_bulk_labour_rate_payload"));
    if (money === null || Number(money) < 0 || !hasTwoDecimalsOrLess(rateRaw) || Number(money) > 99999999.99) {
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

  return {
    ...scope,
    rows,
  };
};

const resolveLabourIds = async ({ db = knex, deptId, labourSelection, t }) => {
  const dept = Number(deptId || 0);
  if (!Number.isInteger(dept) || dept <= 0) throw new Error(t("error_select_department"));

  if (labourSelection?.all) {
    const labourRows = await db("erp.labours as l")
      .select("l.id")
      .whereRaw("lower(trim(l.status)) = 'active'")
      .andWhere(function whereDept() {
        this.where("l.dept_id", dept).orWhereExists(function labourDept() {
          this.select(1)
            .from("erp.labour_department as ld")
            .whereRaw("ld.labour_id = l.id")
            .andWhere("ld.dept_id", dept);
        });
      })
      .orderBy("l.id", "asc");

    const unique = [...new Set(labourRows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0))];
    if (!unique.length) throw new Error(t("error_select_labour"));
    return unique;
  }

  const labourId = Number(labourSelection?.labourId || 0);
  if (!Number.isInteger(labourId) || labourId <= 0) throw new Error(t("error_select_labour"));

  const labour = await db("erp.labours as l")
    .select("l.id")
    .where("l.id", labourId)
    .whereRaw("lower(trim(l.status)) = 'active'")
    .andWhere(function whereDept() {
      this.where("l.dept_id", dept).orWhereExists(function labourDept() {
        this.select(1)
          .from("erp.labour_department as ld")
          .whereRaw("ld.labour_id = l.id")
          .andWhere("ld.dept_id", dept);
      });
    })
    .first();

  if (!labour) throw new Error(t("error_select_labour"));
  return [labourId];
};

const resolveItemTypes = (articleType) => {
  if (articleType === ARTICLE_TYPE.FINISHED) return ["FG"];
  if (articleType === ARTICLE_TYPE.SEMI_FINISHED) return ["SFG"];
  return ["FG", "SFG"];
};

const fetchTargetSkus = async ({
  db = knex,
  articleType,
  applyOn = APPLY_ON.SKU,
  skuId = null,
  subgroupId = null,
  groupId = null,
}) => {
  let query = db("erp.skus as s")
    .join("erp.variants as v", "s.variant_id", "v.id")
    .join("erp.items as i", "v.item_id", "i.id")
    .select("s.id as sku_id", "s.sku_code", "i.name as item_name", "i.item_type", "i.subgroup_id", "i.group_id")
    .whereIn("i.item_type", resolveItemTypes(articleType));

  if (applyOn === APPLY_ON.SKU && skuId) {
    query = query.where("s.id", skuId);
  } else if (applyOn === APPLY_ON.SUBGROUP && subgroupId) {
    query = query.where("i.subgroup_id", subgroupId);
  } else if (applyOn === APPLY_ON.GROUP && groupId) {
    query = query.where("i.group_id", groupId);
  }

  return query.orderBy("s.sku_code", "asc");
};

const fetchExistingRules = async ({
  db = knex,
  labourIds,
  deptId,
}) => {
  const dept = Number(deptId || 0);
  if (!Number.isInteger(dept) || dept <= 0) return [];
  const labourList = Array.isArray(labourIds) ? labourIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : [];
  if (!labourList.length) return [];

  return db("erp.labour_rate_rules")
    .select("id", "labour_id", "apply_on", "sku_id", "subgroup_id", "group_id", "rate_value")
    .where({
      dept_id: dept,
      status: "active",
      applies_to_all_labours: false,
    })
    .whereIn("labour_id", labourList);
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
        previousRate: matched.rate_value == null ? null : Number(matched.rate_value),
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
  labourIds,
  deptId,
  applyOn,
  skuId,
  subgroupId,
  groupId,
  articleType,
  rateType,
  baseRate,
}) => {
  const targetSkus = await fetchTargetSkus({ db, articleType, applyOn, skuId, subgroupId, groupId });
  if (!targetSkus.length) return [];

  const uniqueLabourIds = Array.isArray(labourIds)
    ? [...new Set(labourIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];

  const defaultRate = toMoney(baseRate);
  if (uniqueLabourIds.length !== 1) {
    return targetSkus.map((sku) => ({
      sku_id: Number(sku.sku_id),
      sku_code: sku.sku_code,
      item_name: sku.item_name || "",
      item_type: sku.item_type || "",
      previous_rate: null,
      previous_source: null,
      previous_rule_id: null,
      new_rate: defaultRate,
    }));
  }

  const existingRules = await fetchExistingRules({ db, labourIds: uniqueLabourIds, deptId });

  return targetSkus.map((sku) => {
    const previous = resolvePreviousForSku({ existingRules, sku });
    return {
      sku_id: Number(sku.sku_id),
      sku_code: sku.sku_code,
      item_name: sku.item_name || "",
      item_type: sku.item_type || "",
      previous_rate: previous.previousRate,
      previous_source: previous.previousSource,
      previous_rule_id: previous.previousRuleId,
      new_rate: defaultRate,
    };
  });
};

const applyBulkSkuRateUpsert = async ({
  trx,
  labourIds,
  deptId,
  applyOn,
  subgroupId,
  groupId,
  rateType,
  status,
  rows,
}) => {
  const labourList = Array.isArray(labourIds)
    ? [...new Set(labourIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  const skuIds = Array.isArray(rows)
    ? [...new Set(rows.map((row) => Number(row.skuId)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];

  if (!labourList.length || !skuIds.length) {
    return { created: 0, updated: 0 };
  }

  await trx("erp.labour_rate_rules")
    .where({
      applies_to_all_labours: true,
      dept_id: deptId,
    })
    .whereNull("labour_id")
    .whereIn("sku_id", skuIds)
    .del();

  const existing = await trx("erp.labour_rate_rules")
    .select("id", "labour_id", "sku_id")
    .where({
      applies_to_all_labours: false,
      dept_id: deptId,
    })
    .whereIn("labour_id", labourList)
    .whereIn("sku_id", skuIds)
    .orderBy("id", "desc");

  const existingByLabourSku = new Map();
  const duplicateIdsToDelete = [];
  existing.forEach((row) => {
    const key = `${Number(row.labour_id)}:${Number(row.sku_id)}`;
    if (!existingByLabourSku.has(key)) {
      existingByLabourSku.set(key, Number(row.id));
      return;
    }
    duplicateIdsToDelete.push(Number(row.id));
  });

  if (duplicateIdsToDelete.length) {
    await trx("erp.labour_rate_rules")
      .whereIn("id", duplicateIdsToDelete)
      .del();
  }

  let updated = 0;
  let created = 0;

  for (const labourId of labourList) {
    for (const row of rows) {
      const key = `${Number(labourId)}:${Number(row.skuId)}`;
      const existingId = existingByLabourSku.get(key);
      if (existingId) {
        await trx("erp.labour_rate_rules")
          .where({ id: existingId })
          .update({
            applies_to_all_labours: false,
            labour_id: labourId,
            status,
            rate_type: rateType,
            rate_value: row.rate,
            apply_on: applyOn || APPLY_ON.SKU,
            subgroup_id: (applyOn || APPLY_ON.SKU) === APPLY_ON.SUBGROUP ? subgroupId || null : null,
            group_id: (applyOn || APPLY_ON.SKU) === APPLY_ON.GROUP ? groupId || null : null,
          });
        updated += 1;
        continue;
      }

      await trx("erp.labour_rate_rules").insert({
        applies_to_all_labours: false,
        labour_id: labourId,
        dept_id: deptId,
        apply_on: applyOn || APPLY_ON.SKU,
        sku_id: row.skuId,
        subgroup_id: (applyOn || APPLY_ON.SKU) === APPLY_ON.SUBGROUP ? subgroupId || null : null,
        group_id: (applyOn || APPLY_ON.SKU) === APPLY_ON.GROUP ? groupId || null : null,
        rate_type: rateType,
        rate_value: row.rate,
        status,
      });
      created += 1;
    }
  }

  return { created, updated };
};

module.exports = {
  ALL_LABOURS_VALUE,
  ARTICLE_TYPE,
  normalizeScopeInput,
  normalizeBulkInput,
  resolveLabourIds,
  buildBulkPreviewRows,
  applyBulkSkuRateUpsert,
};
