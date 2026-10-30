const crypto = require('node:crypto');

const PRODUCTION_TYPES = new Set(['PRODUCTION_FG', 'PRODUCTION_SFG', 'PRODUCTION_STAGE']);
const CONDITION_FIELDS = ['excluded_grade_ids', 'excluded_group_ids', 'excluded_subgroup_ids', 'excluded_sku_ids', 'branch_ids', 'source_labour_ids', 'department_ids', 'stage_ids'];

// Canonical conditions are also the rate-history identity. Array ordering must
// never change which rule a subsequent save supersedes.
const normalizeEligibility = (raw, commissionType = null) => {
  let input = raw || {};
  if (typeof input === 'string') {
    if (input.length > 16000) throw new Error('commission_invalid_conditions');
    try { input = JSON.parse(input || '{}'); } catch { throw new Error('commission_invalid_conditions'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('commission_invalid_conditions');
  const output = {};
  for (const key of CONDITION_FIELDS) {
    const values = input[key] == null ? [] : input[key];
    if (!Array.isArray(values) || values.length > 500) throw new Error('commission_invalid_conditions');
    if (values.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error('commission_invalid_conditions');
    const ids = [...new Set(values.map(Number))].sort((a, b) => a - b);
    if (ids.length) output[key] = ids;
  }
  if (input.sales_quantity_scope != null) {
    if (!['PACKED_ONLY','ALL'].includes(input.sales_quantity_scope)) throw new Error('commission_invalid_conditions');
    output.sales_quantity_scope=input.sales_quantity_scope;
  }
  if (commissionType && !['SALESMAN_SALE','BRANCH_SALE'].includes(commissionType)) delete output.sales_quantity_scope;
  if (commissionType && !PRODUCTION_TYPES.has(commissionType)) {
    delete output.source_labour_ids;
    delete output.department_ids;
    delete output.stage_ids;
  }
  // Worker/stage attribution belongs to department completion. Final stock does
  // not establish which worker performed an earlier stage.
  if (commissionType && commissionType !== 'PRODUCTION_STAGE' &&
      (output.source_labour_ids || output.department_ids || output.stage_ids)) {
    throw new Error('commission_stage_required');
  }
  return output;
};

const eligibilityKey = (raw, type = null) => {
  const normalized = normalizeEligibility(raw, type);
  // Exclusions are versioned settings of a rule, not a second earning scope.
  // Otherwise removing a grade exclusion would leave its older rule active.
  const source = {};
  for (const key of ['branch_ids','source_labour_ids','department_ids','stage_ids']) if (normalized[key]) source[key] = normalized[key];
  return Object.keys(source).length ? crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex') : '';
};

const matchesProduct = (rule, context) => {
  switch (rule.apply_on) {
    case 'SKU': return Number(rule.sku_id) === Number(context.skuId);
    case 'SUBGROUP': return Number(rule.subgroup_id) === Number(context.subgroupId);
    case 'GROUP': return Number(rule.group_id) === Number(context.groupId);
    case 'ALL': return true;
    default: return false;
  }
};

const matchesSource = (conditions, context) =>
  (!conditions.branch_ids || conditions.branch_ids.includes(Number(context.branchId))) &&
  (!conditions.source_labour_ids || conditions.source_labour_ids.includes(Number(context.labourId))) &&
  (!conditions.department_ids || conditions.department_ids.includes(Number(context.departmentId))) &&
  (!conditions.stage_ids || conditions.stage_ids.includes(Number(context.stageId)));

const excludesProduct = (conditions, context) =>
  Boolean(conditions.excluded_grade_ids?.includes(Number(context.gradeId)) ||
    conditions.excluded_group_ids?.includes(Number(context.groupId)) ||
    conditions.excluded_subgroup_ids?.includes(Number(context.subgroupId)) ||
    conditions.excluded_sku_ids?.includes(Number(context.skuId)));

const ruleEligible = (rule, context) => {
  const conditions = normalizeEligibility(rule.eligibility);
  const quantities = conditions.sales_quantity_scope || context.defaultSalesQuantityScope || 'PACKED_ONLY';
  return (context.isPacked !== false || quantities === 'ALL') && matchesSource(conditions, context) && !excludesProduct(conditions, context);
};

// A broad rule's exclusion also constrains its article-rate exceptions. An
// unrelated product scope cannot exclude commission from another product rule.
const excludedByApplicableRule = (rules, context) => rules.some((rule) =>
  (!rule.branch_id || Number(rule.branch_id) === Number(context.branchId)) &&
  matchesProduct(rule, context) && matchesSource(normalizeEligibility(rule.eligibility), context) &&
  excludesProduct(normalizeEligibility(rule.eligibility), context));

const validateEligibilityReferences = async ({ db, eligibility, commissionType, employeeIds = [], allowedBranchIds = null }) => {
  const conditions = normalizeEligibility(eligibility, commissionType);
  const tables = { excluded_grade_ids: 'erp.grades', excluded_group_ids: 'erp.product_groups',
    excluded_subgroup_ids: 'erp.product_subgroups', excluded_sku_ids: 'erp.skus', branch_ids: 'erp.branches',
    source_labour_ids: 'erp.labours', department_ids: 'erp.departments', stage_ids: 'erp.production_stages' };
  for (const [key, ids] of Object.entries(conditions)) {
    if (!CONDITION_FIELDS.includes(key)) continue;
    const rows = await db(tables[key]).whereIn('id', ids).select('id');
    if (rows.length !== ids.length) throw new Error('commission_invalid_conditions');
  }
  if (conditions.source_labour_ids && Array.isArray(allowedBranchIds)) {
    const mapped = await db('erp.labour_branch').whereIn('labour_id',conditions.source_labour_ids).whereIn('branch_id',allowedBranchIds).distinct('labour_id');
    if (mapped.length !== conditions.source_labour_ids.length) throw new Error('error_branch_out_of_scope');
  }
  if (conditions.branch_ids) {
    if (Array.isArray(allowedBranchIds) && conditions.branch_ids.some((id) => !allowedBranchIds.includes(id))) throw new Error('error_branch_out_of_scope');
    for (const employeeId of employeeIds) {
      const mapped = await db('erp.employee_branch').where('employee_id', employeeId).whereIn('branch_id', conditions.branch_ids).select('branch_id');
      if (mapped.length !== conditions.branch_ids.length) throw new Error('error_employee_not_at_branch');
    }
  }
  if (conditions.stage_ids && conditions.department_ids) {
    const stages = await db('erp.production_stages').whereIn('id', conditions.stage_ids).whereIn('dept_id', conditions.department_ids).select('id');
    if (stages.length !== conditions.stage_ids.length) throw new Error('commission_invalid_conditions');
  }
  return conditions;
};

module.exports = { PRODUCTION_TYPES, CONDITION_FIELDS, normalizeEligibility, eligibilityKey, matchesProduct, matchesSource, excludesProduct, ruleEligible, excludedByApplicableRule, validateEligibilityReferences };
