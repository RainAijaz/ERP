const knex = require('../../db/knex');
const { registerApprovalPreviewProvider } = require('../approval-preview-registry');
const { normalizeEligibility } = require('../../services/hr-payroll/commission-eligibility-service');
const { localizedNameSelect } = require('../localized-name');

registerApprovalPreviewProvider(async ({ req,res,request,side }) => {
  const values = side === 'old' ? request?.old_value : request?.new_value;
  if (!values || typeof values !== 'object') return null;
  const payroll = values.mode === 'PAYROLL_FINALIZE';
  if (!payroll && !Object.prototype.hasOwnProperty.call(values,'eligibility')) return null;
  const summary = [];
  let exceptionRows = [];
  const employeeIds = values.employee_ids || [values.employee_id || values.input?.employee_id].filter(Boolean);
  if (employeeIds.length) {
    const employees = await knex('erp.employees as e').whereIn('e.id',employeeIds).select(localizedNameSelect('e','name',req.locale));
    summary.push({label:res.locals.t('employees'),value:employees.map(row=>row.name).join(', ')});
  }
  if (payroll) {
    const snapshot = values.snapshot || {};
    for (const key of ['period_from','period_to','unpaid_days','absence_deduction','opening_balance','total_credit','total_debit','total_payable']) {
      summary.push({ label:res.locals.t('salary_'+key),value:snapshot[key] ?? values.input?.[key] ?? '' });
    }
  } else {
    const conditions = normalizeEligibility(values.eligibility,values.commission_type);
    summary.push({label:res.locals.t('commission_type'),value:res.locals.t('commission_type_'+String(values.commission_type || '').toLowerCase())});
    summary.push({label:res.locals.t('rate_value'),value:values.scope_rate ?? values.value ?? ''});
    summary.push({label:res.locals.t('rate_type'),value:res.locals.t('rate_type_'+String(values.rate_type || '').toLowerCase())});
    summary.push({label:res.locals.t('apply_on'),value:res.locals.t('apply_on_'+String(values.apply_on || '').toLowerCase())});
    if (conditions.sales_quantity_scope) summary.push({label:res.locals.t('commission_sales_quantities'),value:res.locals.t(conditions.sales_quantity_scope==='ALL'?'commission_packed_and_loose':'commission_packed_only')});
    summary.push({label:res.locals.t('reverse_on_returns'),value:res.locals.t(values.reverse_on_returns?'yes':'no')});
    for (const key of ['effective_from','effective_to']) summary.push({label:res.locals.t(key),value:values[key] || ''});
    const lookups = {
      excluded_grade_ids:['erp.grades','commission_excluded_grades'],excluded_group_ids:['erp.product_groups','commission_excluded_groups'],
      excluded_subgroup_ids:['erp.product_subgroups','commission_excluded_subgroups'],excluded_sku_ids:['erp.skus','commission_excluded_articles'],
      branch_ids:['erp.branches','commission_eligible_branches'],source_labour_ids:['erp.labours','commission_source_workers'],
      department_ids:['erp.departments','commission_production_departments'],stage_ids:['erp.production_stages','commission_production_stages']
    };
    const selectors = {group_ids:['erp.product_groups','product_groups'],subgroup_ids:['erp.product_subgroups','product_subgroups'],sku_ids:['erp.skus','skus']};
    for (const [key,[table,label]] of Object.entries({...lookups,...selectors})) {
      const ids = conditions[key] || values[key] || (values[key.replace('_ids','_id')] ? [values[key.replace('_ids','_id')]] : []);
      if (!Array.isArray(ids) || !ids.length) continue;
      const nameColumn = table==='erp.skus' ? 'sku_code' : 'name';
      const rows = await knex(`${table} as o`).whereIn('o.id',ids).select(nameColumn==='sku_code'?'o.sku_code':localizedNameSelect('o','name',req.locale)).orderBy(nameColumn);
      summary.push({label:res.locals.t(label),value:rows.map(row=>row[nameColumn]).join(', ')});
    }
    summary.push({label:res.locals.t('commission_replace_sku_rates'),value:res.locals.t(values.replace_existing_sku_rates?'yes':'no')});
    const changedRows=Array.isArray(values.rows)?values.rows:[];
    if(changedRows.length) {
      const skuIds=[...new Set(changedRows.map(row=>Number(row.sku_id)).filter(id=>Number.isSafeInteger(id)&&id>0))];
      const articles=await knex('erp.skus').whereIn('id',skuIds).select('id','sku_code');
      const byId=new Map(articles.map(row=>[Number(row.id),row.sku_code]));
      exceptionRows=changedRows.map(row=>({article:byId.get(Number(row.sku_id)) || String(row.sku_id || ''),rate:row.new_rate ?? row.rate ?? row.value ?? '',
        unit:res.locals.t('rate_type_'+String(row.rate_type || values.rate_type || '').toLowerCase())}));
    }
  }
  return { previewAction:'edit',previewLabel:res.locals.t(payroll?'salary_finalize':'employee_commission_rules'),
    previewType:'payroll-configuration',previewTitle:res.locals.t(payroll?'salary_payroll_runs':'employee_commission_rules'),
    locale:req.locale,previewValues:{summary,exceptionRows},formPartial:'../../administration/approvals/payroll-configuration-preview.ejs' };
});
module.exports = {};
