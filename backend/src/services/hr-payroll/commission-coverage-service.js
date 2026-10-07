const { attachInheritance } = require("../sales/commission-rule-resolver");
const { indexExistingRules, findEffectiveRuleIndexed, todayYmd } = require("./commission-rules-service");

const isCurrent = (row, onDate) =>
  String(row.status || "").trim().toLowerCase() === "active" &&
  String(row.effective_from || "") <= onDate &&
  (!row.effective_to || String(row.effective_to) >= onDate);

const buildCommissionCoverageRows = async ({ db, rawRows, branchId = null, locale = "en", showPast = false }) => {
  if (!rawRows.length) return { rows: [], skuCount: 0 };
  const onDate = todayYmd();
  const withInheritance = await attachInheritance(db, rawRows);
  const current = withInheritance.filter((row) =>
    isCurrent(row, onDate) && (!row.branch_id || Number(row.branch_id) === Number(branchId || 0))
  );
  const activeKeys = [...new Set(current.map((row) => `${row.commission_type}|${row.commission_basis}`))];
  const projected = [];

  for (const key of activeKeys) {
    const [commissionType, basis] = key.split("|");
    const rules = current.filter((row) => row.commission_type === commissionType && row.commission_basis === basis)
      .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)) || Number(b.id) - Number(a.id));
    const index = indexExistingRules(rules);
    const groups = [...new Set(rules.filter((r) => r.apply_on === "GROUP").map((r) => Number(r.group_id)).filter(Boolean))];
    const subgroups = [...new Set(rules.filter((r) => r.apply_on === "SUBGROUP").map((r) => Number(r.subgroup_id)).filter(Boolean))];
    const skuIds = [...new Set(rules.filter((r) => r.apply_on === "SKU" && !r.inherited_sku_copy).map((r) => Number(r.sku_id)).filter(Boolean))];
    if (!rules.some((r) => r.apply_on === "ALL") && !groups.length && !subgroups.length && !skuIds.length) continue;
    let skuQuery = db("erp.skus as s")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", "i.id", "v.item_id")
      .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
      .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
      .select("s.id as sku_id", "s.sku_code", "i.group_id", "i.subgroup_id",
        locale === "ur" ? db.raw("COALESCE(pg.name_ur, pg.name) as group_name") : "pg.name as group_name",
        locale === "ur" ? db.raw("COALESCE(sg.name_ur, sg.name) as subgroup_name") : "sg.name as subgroup_name")
      .where("i.item_type", commissionType === "PRODUCTION_SFG" ? "SFG" : "FG");
    if (!rules.some((r) => r.apply_on === "ALL")) {
      skuQuery = skuQuery.where((q) => {
        if (groups.length) q.orWhereIn("i.group_id", groups);
        if (subgroups.length) q.orWhereIn("i.subgroup_id", subgroups);
        if (skuIds.length) q.orWhereIn("s.id", skuIds);
      });
    }
    const skus = await skuQuery.orderBy("s.sku_code", "asc");
    for (const sku of skus) {
      const rule = findEffectiveRuleIndexed({ index, sku, branchId });
      if (!rule) continue;
      projected.push({
        ...rule,
        id: rule.apply_on === "SKU" ? rule.id : null,
        sku_id: sku.sku_id,
        sku_code: sku.sku_code,
        sku_group_name: sku.group_name,
        sku_subgroup_name: sku.subgroup_name,
        rate_source: rule.apply_on,
        winning_rule_id: Number(rule.id),
        is_virtual: rule.apply_on !== "SKU",
        is_scope_rule: false,
        selector_display: rule.apply_on === "SUBGROUP" ? sku.subgroup_name :
          rule.apply_on === "GROUP" ? sku.group_name : rule.selector_display,
      });
    }
  }

  // Scope rules remain editable in the familiar expanded hierarchy. A generated
  // SKU copy is not a second effective article and is shown only with history.
  const winningRuleIds = new Set(projected.map((row) => row.winning_rule_id));
  const ruleRows = withInheritance.filter((row) => {
    if (row.inherited_sku_copy) return showPast;
    if (row.apply_on === "SKU") return !isCurrent(row, onDate);
    return true;
  }).map((row) => ({
    ...row,
    is_scope_rule: row.apply_on !== "SKU",
    is_virtual: false,
    rate_state: row.effective_to && String(row.effective_to) < onDate ? "past" :
      (isCurrent(row, onDate) && (!row.branch_id || Number(row.branch_id) === Number(branchId || 0)) &&
        (row.inherited_sku_copy || !winningRuleIds.has(Number(row.id)))) ? "shadowed" : null,
  }));
  return { rows: [...ruleRows, ...projected], skuCount: projected.length };
};

module.exports = { buildCommissionCoverageRows };
