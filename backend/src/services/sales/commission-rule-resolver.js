const PRECEDENCE = ["SKU", "SUBGROUP", "GROUP", "ALL"];

// Older bulk saves copied a scope rate onto every SKU. A copy is inheritance,
// unless its amount or settings were deliberately changed for that SKU.
const isInheritedSkuCopy = (rule, source) =>
  typeof rule?.inherited_sku_copy === "boolean" ? rule.inherited_sku_copy :
  String(rule?.apply_on || "") === "SKU" &&
  Number(rule?.source_rule_id || 0) > 0 &&
  Number(source?.id || 0) === Number(rule.source_rule_id) &&
  ["GROUP", "SUBGROUP"].includes(String(source.apply_on || "")) &&
  Number(rule.value) === Number(source.value) &&
  String(rule.rate_type || "PER_PAIR") === String(source.rate_type || "PER_PAIR") &&
  String(rule.commission_basis || "") === String(source.commission_basis || "") &&
  Boolean(rule.reverse_on_returns) === Boolean(source.reverse_on_returns);

const attachInheritance = async (db, rows) => {
  const ids = [...new Set(rows.map((row) => Number(row.source_rule_id || 0)).filter(Boolean))];
  if (!ids.length) return rows.map((row) => ({
    ...row, inherited_sku_copy: row.inherited_sku_copy === true,
  }));
  const sources = await db("erp.employee_commission_rules")
    .select("id", "apply_on", "value", "rate_type", "commission_basis", "reverse_on_returns", "status")
    .whereIn("id", ids);
  const byId = new Map(sources.map((row) => [Number(row.id), row]));
  return rows.map((row) => ({
    ...row,
    inherited_sku_copy: isInheritedSkuCopy(row, byId.get(Number(row.source_rule_id))),
  }));
};

const pickRuleByPrecedence = (rules, basis, context) => {
  for (const branchScope of ["BRANCH", "ANY"]) {
    for (const scope of PRECEDENCE) {
      const matched = rules.find((rule) => {
        if (String(rule.commission_basis) !== basis) return false;
        if (String(rule.apply_on) !== scope) return false;
        if (rule.inherited_sku_copy) return false;
        const branchId = Number(rule.branch_id || 0);
        if (branchScope === "BRANCH") {
          if (!branchId || branchId !== Number(context.branchId || 0)) return false;
        } else if (branchId) return false;
        if (scope === "SKU") return Number(rule.sku_id) === Number(context.skuId);
        if (scope === "SUBGROUP") return Number(rule.subgroup_id) === Number(context.subgroupId);
        if (scope === "GROUP") return Number(rule.group_id) === Number(context.groupId);
        return true;
      });
      if (matched) return { rule: matched, precedence: scope };
    }
  }
  return null;
};

module.exports = { attachInheritance, isInheritedSkuCopy, pickRuleByPrecedence };
