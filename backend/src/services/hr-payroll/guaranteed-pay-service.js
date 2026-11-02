'use strict';

const { normalizeRuleDate } = require('./commission-rules-service');
const { toLocalDateOnly } = require('../../utils/date-only');
const { salaryPeriod, loadSalaryAccruals } = require('./salary-accrual-service');
const { toMoney, hasTwoDecimalsOrLess } = require('../../utils/hr-payroll-validation');

const EXISTING = 'EXISTING';
const GUARANTEE = 'MONTHLY_GUARANTEE';
const PAY_FIELDS = ['pay_arrangement', 'basic_salary', 'salary_effective_from'];
const workerConfig = kind => {
  if (!['employee', 'labour'].includes(kind)) throw new Error('guarantee_invalid_worker');
  return { kind, type: kind.toUpperCase(), table: `erp.${kind === 'employee' ? 'employees' : 'labours'}`,
    idColumn: `${kind}_id`, branchTable: `erp.${kind}_branch`,
    runTable: `erp.${kind}_payroll_runs`, scopeKey: `hr_payroll.${kind === 'employee' ? 'employees' : 'labours'}` };
};

const normalizePayConfiguration = (values, kind) => ({
  ...values,
  pay_arrangement: values.pay_arrangement == null || values.pay_arrangement === '' ? EXISTING : values.pay_arrangement,
  ...(kind === 'labour' ? { basic_salary: values.basic_salary == null || values.basic_salary === '' ? '0' : values.basic_salary,
    salary_effective_from: normalizeRuleDate(values.salary_effective_from) } : {}),
});

const payConfigurationError = (values, kind) => {
  if (![EXISTING, GUARANTEE].includes(values.pay_arrangement)) return { field: 'pay_arrangement', key: 'guarantee_invalid_arrangement' };
  if ((kind === 'labour' || values.pay_arrangement === GUARANTEE) && !['number','string'].includes(typeof values.basic_salary))
    return { field: 'basic_salary', key: 'error_invalid_salary_precision' };
  if (values.pay_arrangement === GUARANTEE) {
    if (kind === 'employee' && values.payroll_type !== 'MONTHLY') return { field: 'payroll_type', key: 'guarantee_monthly_only' };
    const from = normalizeRuleDate(values.salary_effective_from);
    if (!from || !from.endsWith('-01')) return { field: 'salary_effective_from', key: 'guarantee_month_boundary' };
    if (!(toMoney(values.basic_salary) > 0)) return { field: 'basic_salary', key: 'guarantee_salary_required' };
  }
  if ((kind === 'labour' || values.pay_arrangement === GUARANTEE) && (!Number.isFinite(Number(values.basic_salary)) || Number(values.basic_salary) < 0 ||
      !hasTwoDecimalsOrLess(values.basic_salary) || Number(values.basic_salary) > 99999999.99))
    return { field: 'basic_salary', key: 'error_invalid_salary_precision' };
  return null;
};

const assertPayConfiguration = (values, kind) => {
  const normalized = normalizePayConfiguration(values, kind);
  const error = payConfigurationError(normalized, kind);
  if (error) throw Object.assign(new Error(error.key), { field: error.field });
  if (kind === 'labour') normalized.basic_salary = toMoney(normalized.basic_salary);
  return normalized;
};

const payArrangementField = kind => ({ name: 'pay_arrangement', label: 'guarantee_pay_arrangement', type: 'select', required: true,
  hint: 'guarantee_example', options: [{ value: EXISTING, label: `guarantee_existing_${kind}` }, { value: GUARANTEE, label: 'guarantee_option' }] });

const calculateGuarantee = (salary, earnings) => {
  if (!Number.isFinite(Number(salary)) || Number(salary) < 0 || !Number.isFinite(Number(earnings))) throw new Error('error_invalid_salary');
  const base = toMoney(Number(salary)); const earned = toMoney(Number(earnings));
  return { salary: base, earnings: earned, adjustment: toMoney(Math.min(base, earned)),
    extra_earnings: toMoney(Math.max(0, earned - base)), period_earnings: toMoney(Math.max(base, earned)) };
};

// This service is the only monthly comparison used by payroll and all HR reports.
// It returns complete-month rows; callers apply their display window afterwards.
const loadGuaranteedPayRows = async ({ db, req, kind, entityIds, to, branchIds = [] }) => {
  try {
    if (!entityIds.length) return new Map();
    const cfg = workerConfig(kind);
    const history = await db('erp.worker_guarantee_history').whereIn(cfg.idColumn, entityIds)
      .where('effective_from', '<=', to).orderBy('effective_from');
    const active = history.filter(row => row.pay_arrangement === GUARANTEE);
    if (!active.length) return new Map();
    const ids = [...new Set(active.map(row => Number(row[cfg.idColumn])))];
    const mappings = await db(cfg.branchTable).whereIn(cfg.idColumn, ids).select(cfg.idColumn, 'branch_id');
    const allowed = new Set((req?.branchScope || []).map(Number));
    const selectedBranches = new Set(branchIds.map(Number));
    const branchesByWorker = new Map();
    for (const row of mappings) {
      const id = Number(row[cfg.idColumn]); const branches = branchesByWorker.get(id) || [];
      branches.push(Number(row.branch_id)); branchesByWorker.set(id, branches);
    }
    for (const id of ids) {
      const branches = branchesByWorker.get(id) || [];
      if (!req?.user?.isAdmin && (!branches.length || branches.some(branch => !allowed.has(branch)))) throw new Error('guarantee_full_branch_scope');
      if (branchIds.length && branches.some(branch => !selectedBranches.has(branch))) throw new Error('guarantee_all_branches');
    }
    const from = toLocalDateOnly(active[0].effective_from);
    const { loadGuaranteeEarningsByMonth } = require('./hr-payroll-report-service');
    const earnings = await loadGuaranteeEarningsByMonth({ db, kind, entityIds: ids, from, to });
    const salaries = kind === 'employee' ? await loadSalaryAccruals({ db, employeeIds: ids, from, to }) : new Map();
    const salaryByPeriod = new Map();
    for (const [id, rows] of salaries) for (const row of rows) {
      const key = `${id}|${row.period_from}|${row.period_to}`;
      salaryByPeriod.set(key, (salaryByPeriod.get(key) || 0) + Number(row.salary_credit || 0));
    }
    const result = new Map();
    for (const profile of active) {
      const id = Number(profile[cfg.idColumn]);
      const limit = [to, toLocalDateOnly(profile.effective_to) || to].sort()[0];
      let start = toLocalDateOnly(profile.effective_from); let guard = 0;
      while (start <= limit) {
        if (++guard > 2400) throw new Error('salary_range_too_large');
        const period = salaryPeriod(start, 'MONTHLY');
        if (period.to <= limit) {
          const salary = kind === 'employee' ? salaryByPeriod.get(`${id}|${period.from}|${period.to}`) || 0 : Number(profile.basic_salary);
          if (salary > 0) {
            const amounts = calculateGuarantee(salary, earnings.get(`${id}|${period.from.slice(0, 7)}`) || 0);
            const rows = result.get(id) || [];
            const common = { entry_date: period.to, period_from: period.from, period_to: period.to, qty: 0, voucher_id: null,
              voucher_no: null, branch_name: '', bill_number: '', guarantee: amounts, guarantee_history_id: Number(profile.id) };
            if (kind === 'labour') rows.push({ ...common, id: -920000000 - Number(profile.id) * 2400 - guard,
              voucher_type: 'PAYROLL_ACCRUAL', description: 'guarantee_monthly_salary', credit: salary, debit: 0, salary_credit: salary });
            rows.push({ ...common, id: -930000000 - Number(profile.id) * 2400 - guard, voucher_type: 'PAYROLL_GUARANTEE',
              description: 'guarantee_adjustment', credit: amounts.adjustment < 0 ? -amounts.adjustment : 0,
              debit: amounts.adjustment > 0 ? amounts.adjustment : 0, guarantee_adjustment: amounts.adjustment });
            result.set(id, rows);
          }
        }
        const next = new Date(`${period.to}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); start = next.toISOString().slice(0, 10);
      }
    }
    return result;
  } catch (err) {
    console.error('Error in GuaranteedPayService:', err);
    throw err;
  }
};

const validateLabourApprovalConfiguration = async (db, request) => {
  const values = request.new_value || {};
  if (values.mode || !Object.keys(values).some(key => !key.startsWith('_') && key !== 'status')) return;
  const existing = request.entity_id === 'NEW' ? null : await db('erp.labours').where('id', request.entity_id).first();
  await validatePayChange({ db, kind: 'labour', values: { ...existing, ...values }, existing });
};

const validatePayChange = async ({ db, kind, values, existing }) => {
  const normalized = assertPayConfiguration(values, kind);
  const fields = [...PAY_FIELDS, ...(kind === 'employee' ? ['payroll_type'] : [])];
  const changed = !existing || fields.some(key => {
    if (key === 'salary_effective_from') return toLocalDateOnly(normalized[key]) !== toLocalDateOnly(existing[key]);
    if (key === 'basic_salary') return Number(normalized[key]) !== Number(existing[key]);
    return String(normalized[key] ?? '') !== String(existing[key] ?? (key === 'pay_arrangement' ? EXISTING : ''));
  });
  if (!changed) return normalized;
  if (normalized.pay_arrangement !== GUARANTEE && existing?.pay_arrangement !== GUARANTEE) {
    if (!existing || !await db('erp.worker_guarantee_history').where(workerConfig(kind).idColumn, existing.id).first('id')) return normalized;
  }
  const from = normalizeRuleDate(normalized.salary_effective_from);
  if (!from || !from.endsWith('-01')) throw Object.assign(new Error('guarantee_month_boundary'), { field: 'salary_effective_from' });
  if (existing) {
    const cfg = workerConfig(kind);
    if (await db(cfg.runTable).where(cfg.idColumn, existing.id).where('period_to', '>=', from).first('id')) throw new Error('salary_period_finalized');
    if (await db('erp.worker_guarantee_history').where(cfg.idColumn, existing.id).where('effective_from', '>', from).first('id')) throw new Error('guarantee_future_terms');
  }
  return normalized;
};

const preserveOmittedPayFields = (values, body, existing, kind) => {
  for (const key of kind === 'employee' ? ['pay_arrangement'] : PAY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, key) && existing) values[key] = existing[key];
  }
  return values;
};

module.exports = { EXISTING, GUARANTEE, PAY_FIELDS, workerConfig, normalizePayConfiguration, payConfigurationError,
  assertPayConfiguration, payArrangementField, calculateGuarantee, loadGuaranteedPayRows, validateLabourApprovalConfiguration,
  validatePayChange, preserveOmittedPayFields };
