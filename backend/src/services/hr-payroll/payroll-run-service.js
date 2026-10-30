const crypto = require('node:crypto');
const knex = require('../../db/knex');
const { normalizeRuleDate,todayYmd } = require('./commission-rules-service');
const { absenceDeduction, salaryPeriod,sameSalaryCadence } = require('./salary-accrual-service');
const { toLocalDateOnly } = require('../../utils/date-only');

const normalizePayrollInput = input => {
  const employeeId = Number(input.employee_id);
  const from = normalizeRuleDate(input.period_from);
  const to = normalizeRuleDate(input.period_to);
  const unpaidDays = Number(input.unpaid_days || 0);
  if (!Number.isSafeInteger(employeeId) || employeeId<=0 || !from || !to || from>to ||
      (new Date(to)-new Date(from))/86400000>365 || !Number.isFinite(unpaidDays) || unpaidDays<0) throw new Error('salary_invalid_period');
  return { employeeId,from,to,unpaidDays };
};

const assertEmployeeScope = async (db, req, employeeId) => {
  const employee = await db('erp.employees').where('id',employeeId).first();
  if (!employee) throw new Error('error_required_fields');
  const branches = await db('erp.employee_branch').where('employee_id',employeeId).select('branch_id');
  const allowed = (req.branchScope || []).map(Number);
  if (!req.user?.isAdmin && (!branches.length || branches.some(row => !allowed.includes(Number(row.branch_id))))) throw new Error('error_branch_out_of_scope');
  if (!req.user?.isAdmin) {
    const { getUserEntityBlockedSet } = require('../administration/entity-ledger-access-service');
    const blocked=await getUserEntityBlockedSet({userId:Number(req.user?.id),entityType:'EMPLOYEE'});
    if (blocked.has(Number(employeeId))) throw new Error('error_branch_out_of_scope');
  }
  return employee;
};

const previewPayroll = async ({ db = knex, req, input }) => {
  const normalized = normalizePayrollInput(input);
  const employee = await assertEmployeeScope(db,req,normalized.employeeId);
  const closed=await db('erp.employee_payroll_runs').where('employee_id',normalized.employeeId)
    .where('period_from','<=',normalized.to).where('period_to','>=',normalized.from).first('id');
  if(closed)throw new Error('salary_period_finalized');
  const profile = await db('erp.employee_salary_history').where('employee_id',normalized.employeeId)
    .where('effective_from','<=',normalized.to).where(q => q.whereNull('effective_to').orWhere('effective_to','>=',normalized.to))
    .orderBy('effective_from','desc').first();
  if (!profile) throw new Error('salary_effective_required');
  if (['MONTHLY','WEEKLY'].includes(profile.payroll_type)) {
    const period = salaryPeriod(normalized.to,profile.payroll_type,profile.week_ending_day);
    const previous=await db('erp.employee_salary_history').where('employee_id',normalized.employeeId).where('effective_from','<',profile.effective_from).orderBy('effective_from','desc').first();
    const next=await db('erp.employee_salary_history').where('employee_id',normalized.employeeId).where('effective_from','>',profile.effective_from).orderBy('effective_from').first();
    if(previous && !sameSalaryCadence(previous,profile) && toLocalDateOnly(profile.effective_from)>period.from)period.from=toLocalDateOnly(profile.effective_from);
    if(next && !sameSalaryCadence(profile,next) && toLocalDateOnly(profile.effective_to)<period.to)period.to=toLocalDateOnly(profile.effective_to);
    if (period.from !== normalized.from || period.to !== normalized.to) throw new Error('salary_invalid_period');
  }
  if (normalized.unpaidDays > (new Date(normalized.to)-new Date(normalized.from))/86400000+1) throw new Error('salary_invalid_unpaid_days');
  const absence = absenceDeduction({ profile,unpaidDays:normalized.unpaidDays });
  // Reuse the employee ledger so advances, salesman commission, branch/production
  // commissions, allowances and staff purchases cannot diverge from payroll.
  const { getEmployeeLedgerReportPageData } = require('./hr-payroll-report-service');
  const { reportData } = await getEmployeeLedgerReportPageData({ req,input:{ entity_id:normalized.employeeId,
    from_date:normalized.from,to_date:normalized.to,ledger_view:'detail',load_report:'1',branch_id:'ALL' } });
  if (!reportData.entity) throw new Error('error_branch_out_of_scope');
  const rows = reportData.rows.map(row => ({ id:row.id,voucher_id:row.voucher_id || null,
    entry_date:typeof row.entry_date === 'string' ? row.entry_date.slice(0,10) : normalizeRuleDate(row.entry_date),
    voucher_type:row.voucher_type, debit:Number(row.debit || 0),credit:Number(row.credit || 0),balance:Number(row.balance || 0) }));
  const snapshot = { employee_id:normalized.employeeId,period_from:normalized.from,period_to:normalized.to,
    unpaid_days:normalized.unpaidDays, absence_deduction:absence,
    absence_basis:{salary_history_id:Number(profile.id),salary:Number(profile.basic_salary),divisor:profile.absence_day_divisor==null?null:Number(profile.absence_day_divisor)},
    opening_balance:Number(reportData.openingBalance || 0),
    total_credit:Number(reportData.totals.credit || 0),total_debit:Number(reportData.totals.debit || 0),
    closing_balance:Number(reportData.totals.closingBalance || 0),
    total_payable:Math.round((Number(reportData.totals.closingBalance || 0)-absence)*100)/100,rows };
  const hash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { normalized,employee,snapshot,hash };
};

const finalizePayroll = async ({ trx, req, input, expectedHash }) => {
  const normalized = normalizePayrollInput(input);
  if (normalized.to>todayYmd()) throw new Error('salary_period_not_ended');
  await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended('erp-payroll:' || ?::text,0))",[normalized.employeeId]);
  const overlap = await trx('erp.employee_payroll_runs').where('employee_id',normalized.employeeId)
    .where('period_from','<=',normalized.to).where('period_to','>=',normalized.from).first();
  if (overlap) throw new Error('salary_period_finalized');
  const preview = await previewPayroll({ db:trx,req,input });
  if (!expectedHash || preview.hash !== expectedHash) throw new Error('salary_preview_changed');
  const [run] = await trx('erp.employee_payroll_runs').insert({ employee_id:normalized.employeeId,
    period_from:normalized.from,period_to:normalized.to,snapshot:preview.snapshot,total_payable:preview.snapshot.total_payable,
    created_by:req.user?.id || null }).returning('*');
  return run;
};

const payrollPageData = async ({ db = knex,req }) => {
  let employees = db('erp.employees as e').select('e.id','e.name').orderBy('e.name');
  if (!req.user?.isAdmin) employees.whereExists(function () {
    this.select(1).from('erp.employee_branch as eb').whereRaw('eb.employee_id=e.id').whereIn('eb.branch_id',(req.branchScope || []).map(Number));
  }).whereNotExists(function () {
    this.select(1).from('erp.employee_branch as eb').whereRaw('eb.employee_id=e.id').whereNotIn('eb.branch_id',(req.branchScope || []).map(Number));
  });
  let runs = db('erp.employee_payroll_runs as p').join('erp.employees as e','e.id','p.employee_id')
    .select('p.id','p.employee_id','p.period_from','p.period_to','p.total_payable','e.name as employee_name').orderBy('p.id','desc').limit(100);
  if (!req.user?.isAdmin) {
    const { getUserEntityBlockedSet } = require('../administration/entity-ledger-access-service');
    const blocked=await getUserEntityBlockedSet({userId:Number(req.user?.id),entityType:'EMPLOYEE'});
    if (blocked.size) { employees.whereNotIn('e.id',[...blocked]); runs.whereNotIn('p.employee_id',[...blocked]); }
  }
  if (!req.user?.isAdmin) runs.whereIn('p.employee_id',employees.clone().clearSelect().select('e.id'));
  const [employeeRows,runRows] = await Promise.all([employees,runs]);
  return { employees:employeeRows,runs:runRows };
};

const loadPayrollSnapshot = async ({db=knex,req,id}) => {
  const run=await db('erp.employee_payroll_runs').where('id',Number(id)).first();
  if (!run) throw new Error('error_not_found');
  await assertEmployeeScope(db,req,run.employee_id);
  return run.snapshot;
};
module.exports = { normalizePayrollInput, assertEmployeeScope, previewPayroll, finalizePayroll, payrollPageData,loadPayrollSnapshot };
