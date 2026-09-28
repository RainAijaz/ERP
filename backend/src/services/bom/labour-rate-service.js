const RATE_TYPES = new Set(["PER_PAIR", "PER_DOZEN"]);

const positiveId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// The BOM editor offers one department rate per SKU. Existing worker rates are
// shown only when they agree; choosing an arbitrary worker would conceal a
// different rate and could overwrite it during a bulk edit.
const loadArticleDepartmentRates = async (db, itemId) => {
  const id = positiveId(itemId);
  if (!id) return [];
  const [item, skus, hasArticleType] = await Promise.all([
    db("erp.items").select("id", "item_type", "subgroup_id", "group_id").where({ id }).first(),
    db("erp.skus as s")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .select("s.id")
      .where("v.item_id", id)
      .where("s.is_active", true),
    db.schema.withSchema("erp").hasColumn("labour_rate_rules", "article_type"),
  ]);
  if (!item || !skus.length) return [];
  const skuIds = skus.map((sku) => Number(sku.id));
  const rows = await db("erp.labour_rate_rules as r")
    .join("erp.departments as d", "d.id", "r.dept_id")
    .leftJoin("erp.labours as l", "l.id", "r.labour_id")
    .select(
      "r.id", "r.labour_id", "r.dept_id", "r.sku_id", "r.apply_on",
      "r.subgroup_id", "r.group_id", "r.rate_type", "r.rate_value",
      hasArticleType ? "r.article_type" : db.raw("NULL::text as article_type"),
    )
    .where((query) => {
      query.whereIn("r.sku_id", skuIds).orWhere((fallback) => {
        fallback.whereNull("r.sku_id").andWhere((scope) => {
          if (positiveId(item.subgroup_id)) {
            scope.orWhere((subgroup) => subgroup.where("r.apply_on", "SUBGROUP")
              .where("r.subgroup_id", item.subgroup_id));
          }
          if (positiveId(item.group_id)) {
            scope.orWhere((group) => group.where("r.apply_on", "GROUP")
              .where("r.group_id", item.group_id));
          }
          scope.orWhere("r.apply_on", "FLAT");
        });
      });
    })
    .where("d.is_active", true)
    .where("d.is_production", true)
    .whereRaw("lower(trim(coalesce(r.status, ''))) = 'active'")
    .where((worker) => worker.whereNull("r.labour_id").orWhere((assigned) => {
      assigned.whereRaw("lower(trim(coalesce(l.status, ''))) = 'active'")
        .andWhere((department) => department.whereRaw("l.dept_id = r.dept_id")
          .orWhereExists(function assignedDepartment() {
            this.select(1).from("erp.labour_department as ld")
              .whereRaw("ld.labour_id = l.id")
              .whereRaw("ld.dept_id = r.dept_id");
          }));
    }))
    .orderBy("r.id", "desc");

  const byDepartmentSkuWorker = new Map();
  for (const row of rows) {
    const deptId = positiveId(row.dept_id);
    const workerId = positiveId(row.labour_id) || "ALL";
    if (!deptId) continue;
    const pinnedSkuId = positiveId(row.sku_id);
    const articleType = String(row.article_type || "").trim().toUpperCase();
    if (pinnedSkuId === null && articleType && articleType !== "BOTH"
      && articleType !== String(item.item_type || "").toUpperCase()) continue;
    const scope = pinnedSkuId ? 0 :
      row.apply_on === "SUBGROUP" ? 1 :
        row.apply_on === "GROUP" ? 2 : 3;
    for (const skuId of pinnedSkuId ? [pinnedSkuId] : skuIds) {
      const key = `${deptId}:${skuId}:${workerId}`;
      const current = byDepartmentSkuWorker.get(key);
      if (!current || scope < current.scope ||
        (scope === current.scope && Number(row.id) > Number(current.row.id))) {
        byDepartmentSkuWorker.set(key, { scope, row });
      }
    }
  }

  const byDepartmentSku = new Map();
  for (const [key, { row }] of byDepartmentSkuWorker) {
    const parts = key.split(":");
    const bucketKey = `${parts[0]}:${parts[1]}`;
    if (!byDepartmentSku.has(bucketKey)) byDepartmentSku.set(bucketKey, []);
    byDepartmentSku.get(bucketKey).push(row);
  }

  const result = [];
  for (const [key, group] of byDepartmentSku) {
    const values = new Set(group.map((row) => {
      const type = String(row.rate_type || "").toUpperCase();
      const value = Number(row.rate_value);
      return RATE_TYPES.has(type) && Number.isFinite(value) && value >= 0
        ? `${type}:${value}`
        : "INVALID";
    }));
    const sample = group[0];
    const mixed = values.size !== 1 || values.has("INVALID");
    const [deptId, skuId] = key.split(":").map(Number);
    result.push({
      dept_id: deptId,
      sku_id: skuId,
      rate_type: mixed ? null : String(sample.rate_type).toUpperCase(),
      rate_value: mixed ? null : Number(sample.rate_value),
      mixed,
    });
  }
  return result;
};

module.exports = { loadArticleDepartmentRates };
