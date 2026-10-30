const { toLocalDateOnly } = require('../../utils/date-only');
const DAY = 86400000;
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const date = value => new Date(`${toLocalDateOnly(value)}T00:00:00Z`);
const ymd = value => value.toISOString().slice(0,10);
const plus = (value, days) => new Date(value.getTime() + days * DAY);
const sameSalaryCadence = (a,b) => Boolean(a && b && a.payroll_type===b.payroll_type && (a.payroll_type!=='WEEKLY' || Number(a.week_ending_day)===Number(b.week_ending_day)));

const salaryPeriod = (onDate, frequency, weekEndingDay) => {
  const on = date(onDate);
  if (!Number.isFinite(on.getTime())) throw new Error('error_invalid_date');
  if (frequency === 'WEEKLY') {
    if (!Number.isInteger(Number(weekEndingDay)) || weekEndingDay == null || Number(weekEndingDay)<0 || Number(weekEndingDay)>6) throw new Error('salary_week_end_required');
    const end = plus(on,(Number(weekEndingDay)-on.getUTCDay()+7)%7);
    return { from:ymd(plus(end,-6)), to:ymd(end), days:7 };
  }
  if (frequency === 'MONTHLY') {
    const start = new Date(Date.UTC(on.getUTCFullYear(),on.getUTCMonth(),1));
    const end = new Date(Date.UTC(on.getUTCFullYear(),on.getUTCMonth()+1,0));
    return { from:ymd(start),to:ymd(end),days:end.getUTCDate() };
  }
  return { from:ymd(on),to:ymd(on),days:1 };
};

// Generate earnings from effective-dated salary segments, not the employee's
// latest amount. A rate change inside a period is weighted by covered days.
const calculateSalaryAccruals = ({ employee, history, from, to }) => {
  const employedFrom = toLocalDateOnly(employee.employment_start_date || employee.created_at);
  const employedTo = toLocalDateOnly(employee.employment_end_date) || to;
  const end = employedTo < to ? employedTo : to;
  if (!employedFrom || !end || end < employedFrom) return [];
  const periods = new Map();
  const ordered = [...history].sort((a,b) => toLocalDateOnly(a.effective_from).localeCompare(toLocalDateOnly(b.effective_from)));
  let cadenceGroup=0;
  for (const [index,profile] of ordered.entries()) {
    const previous=ordered[index-1];const next=ordered[index+1];
    if(previous && !sameSalaryCadence(previous,profile))++cadenceGroup;
    if (!['MONTHLY','WEEKLY','DAILY'].includes(profile.payroll_type)) continue;
    if(!Number.isFinite(Number(profile.basic_salary)) || Number(profile.basic_salary)<0)throw new Error('error_invalid_salary');
    let start = [employedFrom,toLocalDateOnly(profile.effective_from)].sort().at(-1);
    const limit = [end,toLocalDateOnly(profile.effective_to) || end].sort()[0];
    let guard = 0;
    while (start <= limit) {
      if (++guard > 40000) throw new Error('salary_range_too_large');
      const period = salaryPeriod(start,profile.payroll_type,profile.week_ending_day);
      const key = `${cadenceGroup}|${profile.payroll_type}|${period.from}|${period.to}`;
      const rawFrom=period.from;const rawTo=period.to;
      if(previous && !sameSalaryCadence(previous,profile) && toLocalDateOnly(profile.effective_from)>period.from) period.from=toLocalDateOnly(profile.effective_from);
      if(next && !sameSalaryCadence(profile,next) && toLocalDateOnly(profile.effective_to) && toLocalDateOnly(profile.effective_to)<period.to) period.to=toLocalDateOnly(profile.effective_to);
      const sliceEnd = period.to < limit ? period.to : limit;
      const days = Math.round((date(sliceEnd)-date(start))/DAY)+1;
      if (profile.payroll_type !== 'DAILY' || date(start).getUTCDay() !== 0) {
        const aggregate = periods.get(key) || { ...period,weighted:0,covered:0,profiles:[],policy:profile.salary_proration,frequency:profile.payroll_type };
        aggregate.to=period.to;
        aggregate.transition=aggregate.transition || period.from!==rawFrom || period.to!==rawTo;
        aggregate.weighted += Number(profile.basic_salary) * days;
        aggregate.covered += days;
        aggregate.policy = profile.salary_proration;
        aggregate.profiles.push(Number(profile.id));
        periods.set(key,aggregate);
      }
      start = ymd(plus(date(period.to),1));
    }
  }
  const rows = [];
  for (const period of periods.values()) {
    const accrualDate = period.to > employedTo && period.policy === 'CALENDAR_DAYS' ? employedTo : period.to;
    if (accrualDate < from || accrualDate > to || accrualDate > employedTo) continue;
    const denominator = period.transition || period.policy === 'CALENDAR_DAYS' ? period.days : period.covered;
    const amount = money(period.weighted / denominator);
    if (!amount) continue;
    rows.push({ entry_date:accrualDate, period_from:period.from, period_to:period.to, credit:amount, debit:0,
      salary_credit:amount, qty:0, voucher_id:null, voucher_no:null, bill_number:'', branch_name:'',
      voucher_type:'PAYROLL_ACCRUAL', description:'salary_accrual_history', salary_history_ids:period.profiles });
  }
  return rows.sort((a,b) => a.entry_date.localeCompare(b.entry_date));
};

const loadSalaryAccruals = async ({ db, employeeIds, from, to }) => {
  if (!employeeIds.length) return new Map();
  const [employees,history,allowances] = await Promise.all([
    db('erp.employees').whereIn('id',employeeIds).select('id','employment_start_date','employment_end_date','created_at'),
    db('erp.employee_salary_history').whereIn('employee_id',employeeIds).where('effective_from','<=',to).orderBy('effective_from'),
    db('erp.employee_allowance_rules').whereIn('employee_id',employeeIds).where('status','active')
  ]);
  const byEmployee = new Map();
  for (const row of history) {
    const list = byEmployee.get(Number(row.employee_id)) || [];
    list.push(row); byEmployee.set(Number(row.employee_id),list);
  }
  return new Map(employees.map(employee => {
    const profiles=byEmployee.get(Number(employee.id)) || [];
    const rows=calculateSalaryAccruals({employee,history:profiles,from,to});
    for (const allowance of allowances.filter(row=>Number(row.employee_id)===Number(employee.id))) {
      const applicable=profiles.filter(profile=>['MONTHLY','WEEKLY','DAILY'].includes(profile.payroll_type)).map(profile=>({
        ...profile,
        effective_from:[toLocalDateOnly(profile.effective_from),toLocalDateOnly(allowance.effective_from) || toLocalDateOnly(employee.employment_start_date || employee.created_at)].sort().at(-1),
        effective_to:[toLocalDateOnly(profile.effective_to) || to,toLocalDateOnly(allowance.effective_to) || to].sort()[0],
        payroll_type:allowance.frequency,
        basic_salary:allowance.amount_type==='PERCENT_BASIC' ? Number(profile.basic_salary)*Number(allowance.amount)/100 : Number(allowance.amount),
      })).filter(profile=>profile.effective_from<=profile.effective_to);
      const allowanceRows=calculateSalaryAccruals({employee,history:applicable,from,to}).map(row=>({...row,salary_credit:0,allowance_credit:row.credit,description:'allowances',allowance_rule_id:Number(allowance.id)}));
      rows.push(...allowanceRows);
    }
    return [Number(employee.id),rows.sort((a,b)=>a.entry_date.localeCompare(b.entry_date))];
  }));
};

const absenceDeduction = ({ profile, unpaidDays }) => {
  const days = Number(unpaidDays || 0);
  if (!Number.isFinite(days) || days<0 || days>366) throw new Error('salary_invalid_unpaid_days');
  if (!days) return 0;
  if(!Number.isFinite(Number(profile.basic_salary)) || Number(profile.basic_salary)<0)throw new Error('error_invalid_salary');
  if (!profile.absence_deductions_enabled || !(Number(profile.absence_day_divisor)>0)) throw new Error('salary_absence_disabled');
  if(days>Number(profile.absence_day_divisor))throw new Error('salary_invalid_unpaid_days');
  return money(Number(profile.basic_salary) / Number(profile.absence_day_divisor) * days);
};

module.exports = { salaryPeriod, sameSalaryCadence, calculateSalaryAccruals, loadSalaryAccruals, absenceDeduction };
