'use strict';
const { createHash } = require('node:crypto');
const { canonicalJson } = require('../../utils/canonical-json');

const recalcReviewHash = async ({db,input,plan}) => {
  try {
    const voucherIds=[...new Set(plan.rows.map(row=>Number(row.voucher_id)))].sort((a,b)=>a-b);
    const employeeIds=[...new Set(plan.rows.map(row=>Number(row.employee_id)))].sort((a,b)=>a-b);
    const state={filters:{from:input.fromDate,to:input.toDate,employee:input.employeeId,types:input.commissionTypes,clear:input.clearOrphans},
      rows:plan.rows.map(({employee_name,...row})=>row)};
    for(const [key,table,column] of [['headers','erp.voucher_header','id'],['lines','erp.voucher_line','voucher_header_id'],['sales','erp.sales_header','voucher_id'],['stock','erp.stock_ledger','voucher_header_id'],['dcv','erp.dcv_header','voucher_id']]) {
      state[key]=voucherIds.length?await db(table).whereIn(column,voucherIds):[];
      state[key].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
    }
    const lineIds=state.lines.map(row=>row.id);
    state.stages=lineIds.length?await db('erp.dcv_line').whereIn('voucher_line_id',lineIds).orderBy('voucher_line_id'):[];
    state.rules=employeeIds.length?await db('erp.employee_commission_rules').whereIn('employee_id',employeeIds).orderBy('id'):[];
    state.payroll=employeeIds.length?await db('erp.employee_payroll_runs').whereIn('employee_id',employeeIds).orderBy('id'):[];
    return createHash('sha256').update(canonicalJson(state)).digest('hex');
  } catch(err) {console.error('Error in CommissionReviewService:',err);throw err;}
};
module.exports={recalcReviewHash};
