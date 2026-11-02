'use strict';

const crypto = require('node:crypto');
const knex = require('../../db/knex');
const { normalizeRuleDate, todayYmd } = require('./commission-rules-service');
const { absenceDeduction, salaryPeriod, sameSalaryCadence } = require('./salary-accrual-service');
const { toLocalDateOnly } = require('../../utils/date-only');
const { workerConfig } = require('./guaranteed-pay-service');
const { canAccessScope } = require('../../middleware/access/role-permissions');
const { localizedNameSelect } = require('../../utils/localized-name');

const normalizePayrollInput = input => {
  const key = input.worker_key == null ? null : String(input.worker_key).split(':');
  const kind = key ? key[0] : (input.worker_kind || 'employee');
  const cfg = workerConfig(kind);
  const employeeId = Number(key ? key[1] : (input.worker_id ?? input[cfg.idColumn]));
  const from = normalizeRuleDate(input.period_from); const to = normalizeRuleDate(input.period_to);
  const unpaidDays = Number(input.unpaid_days || 0);
  if ((key && key.length !== 2) || !Number.isSafeInteger(employeeId) || employeeId <= 0 || !from || !to || from > to ||
      (new Date(to) - new Date(from)) / 86400000 > 365 || !Number.isFinite(unpaidDays) || unpaidDays < 0) throw new Error('salary_invalid_period');
  if (kind === 'labour' && unpaidDays !== 0) throw new Error('guarantee_labour_absence');
  return { employeeId, kind, from, to, unpaidDays };
};

const assertPayrollPeriodEnded = normalized => {
  if (normalized.to >= todayYmd()) throw new Error('salary_period_not_ended');
};

const assertEmployeeScope = async (db, req, employeeId, kind = 'employee') => {
  const cfg = workerConfig(kind);
  if (!canAccessScope(req, 'SCREEN', cfg.scopeKey, 'view')) throw new Error('error_branch_out_of_scope');
  const employee = await db(cfg.table).where('id', employeeId).first();
  if (!employee) throw new Error('error_required_fields');
  const branches = await db(cfg.branchTable).where(cfg.idColumn, employeeId).select('branch_id');
  const allowed = (req.branchScope || []).map(Number);
  if (!req.user?.isAdmin && (!branches.length || branches.some(row => !allowed.includes(Number(row.branch_id))))) throw new Error('error_branch_out_of_scope');
  if (!req.user?.isAdmin) {
    const { getUserEntityBlockedSet } = require('../administration/entity-ledger-access-service');
    const blocked = await getUserEntityBlockedSet({ userId: Number(req.user?.id), entityType: cfg.type });
    if (blocked.has(Number(employeeId))) throw new Error('error_branch_out_of_scope');
  }
  return employee;
};

const previewPayroll = async ({ db = knex, req, input }) => {
  try {
    const normalized = normalizePayrollInput(input); const cfg = workerConfig(normalized.kind);
    const employee = await assertEmployeeScope(db, req, normalized.employeeId, normalized.kind);
    if (await db(cfg.runTable).where(cfg.idColumn, normalized.employeeId)
      .where('period_from', '<=', normalized.to).where('period_to', '>=', normalized.from).first('id')) throw new Error('salary_period_finalized');
    let profile;
    if (normalized.kind === 'employee') {
      profile = await db('erp.employee_salary_history').where('employee_id', normalized.employeeId)
        .where('effective_from', '<=', normalized.to).where(q => q.whereNull('effective_to').orWhere('effective_to', '>=', normalized.to))
        .orderBy('effective_from', 'desc').first();
      if (!profile) throw new Error('salary_effective_required');
      if (['MONTHLY', 'WEEKLY'].includes(profile.payroll_type)) {
        const period = salaryPeriod(normalized.to, profile.payroll_type, profile.week_ending_day);
        const previous = await db('erp.employee_salary_history').where('employee_id', normalized.employeeId).where('effective_from', '<', profile.effective_from).orderBy('effective_from', 'desc').first();
        const next = await db('erp.employee_salary_history').where('employee_id', normalized.employeeId).where('effective_from', '>', profile.effective_from).orderBy('effective_from').first();
        if (previous && !sameSalaryCadence(previous, profile) && toLocalDateOnly(profile.effective_from) > period.from) period.from = toLocalDateOnly(profile.effective_from);
        if (next && !sameSalaryCadence(profile, next) && toLocalDateOnly(profile.effective_to) < period.to) period.to = toLocalDateOnly(profile.effective_to);
        if (period.from !== normalized.from || period.to !== normalized.to) throw new Error('salary_invalid_period');
      }
    } else {
      const period = salaryPeriod(normalized.to, 'MONTHLY');
      if (period.from !== normalized.from || period.to !== normalized.to) throw new Error('salary_invalid_period');
    }
    if (normalized.unpaidDays > (new Date(normalized.to) - new Date(normalized.from)) / 86400000 + 1) throw new Error('salary_invalid_unpaid_days');
    const absence = profile ? absenceDeduction({ profile, unpaidDays: normalized.unpaidDays }) : 0;
    const { getPayrollLedgerData } = require('./hr-payroll-report-service');
    const reportData = await getPayrollLedgerData({ db, req, kind: normalized.kind, entity: employee, from: normalized.from, to: normalized.to });
    if (!reportData.entity) throw new Error('error_branch_out_of_scope');
    const rows = reportData.rows.map(row => ({ id: row.id, voucher_id: row.voucher_id || null,
      entry_date: toLocalDateOnly(row.entry_date), voucher_type: row.voucher_type,
      debit: Number(row.debit || 0), credit: Number(row.credit || 0), balance: Number(row.balance || 0) }));
    const periods = reportData.guaranteePeriods || [];
    const sum = key => Math.round(periods.reduce((total, period) => total + Number(period[key] || 0), 0) * 100) / 100;
    const snapshot = { worker_kind: normalized.kind, [cfg.idColumn]: normalized.employeeId,
      period_from: normalized.from, period_to: normalized.to, unpaid_days: normalized.unpaidDays, absence_deduction: absence,
      absence_basis: profile ? { salary_history_id: Number(profile.id), salary: Number(profile.basic_salary),
        divisor: profile.absence_day_divisor == null ? null : Number(profile.absence_day_divisor) } : null,
      guarantee_periods: periods, guaranteed_salary: sum('salary'), eligible_earnings: sum('earnings'), salary_adjustment: sum('adjustment'),
      extra_earnings: sum('extra_earnings'), period_earnings: sum('period_earnings'),
      opening_balance: Number(reportData.openingBalance || 0), total_credit: Number(reportData.totals.credit || 0),
      total_debit: Number(reportData.totals.debit || 0), closing_balance: Number(reportData.totals.closingBalance || 0),
      total_payable: Math.round((Number(reportData.totals.closingBalance || 0) - absence) * 100) / 100, rows };
    return { normalized, employee, snapshot, hash: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  } catch (err) { console.error('Error in PayrollRunService:', err); throw err; }
};

const finalizePayroll = async ({ trx, req, input, expectedHash }) => {
  try {
    const normalized = normalizePayrollInput(input); const cfg = workerConfig(normalized.kind);
    assertPayrollPeriodEnded(normalized);
    const prefix = normalized.kind === 'employee' ? 'erp-payroll:' : 'erp-labour-payroll:';
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(? || ?::text,0))', [prefix, normalized.employeeId]);
    if (await trx(cfg.runTable).where(cfg.idColumn, normalized.employeeId)
      .where('period_from', '<=', normalized.to).where('period_to', '>=', normalized.from).first()) throw new Error('salary_period_finalized');
    const preview = await previewPayroll({ db: trx, req, input });
    if (!expectedHash || preview.hash !== expectedHash) throw new Error('salary_preview_changed');
    const [run] = await trx(cfg.runTable).insert({ [cfg.idColumn]: normalized.employeeId,
      period_from: normalized.from, period_to: normalized.to, snapshot: preview.snapshot, total_payable: preview.snapshot.total_payable,
      created_by: req.user?.id || null }).returning('*');
    return run;
  } catch (err) { console.error('Error in PayrollRunService:', err); throw err; }
};

const payrollPageData = async ({ db = knex, req }) => {
  try {
    const workers = []; const runs = [];
    for (const kind of ['employee', 'labour']) {
      const cfg = workerConfig(kind);
      if (!canAccessScope(req, 'SCREEN', cfg.scopeKey, 'view')) continue;
      let entities = db(`${cfg.table} as e`).select('e.id', localizedNameSelect('e','name',req.locale)).orderBy('e.name');
      if (!req.user?.isAdmin) {
        const allowed = (req.branchScope || []).map(Number);
        entities.whereExists(function () { this.select(1).from(`${cfg.branchTable} as eb`).whereRaw(`eb.${cfg.idColumn}=e.id`).whereIn('eb.branch_id', allowed); })
          .whereNotExists(function () { this.select(1).from(`${cfg.branchTable} as eb`).whereRaw(`eb.${cfg.idColumn}=e.id`).whereNotIn('eb.branch_id', allowed); });
        const { getUserEntityBlockedSet } = require('../administration/entity-ledger-access-service');
        const blocked = await getUserEntityBlockedSet({ userId: Number(req.user?.id), entityType: cfg.type });
        if (blocked.size) entities.whereNotIn('e.id', [...blocked]);
      }
      const list = await entities;
      workers.push(...list.map(row => ({ ...row, kind, key: `${kind}:${row.id}` })));
      const saved = await db(`${cfg.runTable} as p`).join(`${cfg.table} as e`, 'e.id', `p.${cfg.idColumn}`)
        .whereIn(`p.${cfg.idColumn}`, list.map(row => row.id)).select('p.*', localizedNameSelect('e','employee_name',req.locale)).orderBy('p.id', 'desc').limit(100);
      runs.push(...saved.map(row => ({ ...row, kind })));
    }
    return { workers, employees: workers.filter(row => row.kind === 'employee'), runs: runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100) };
  } catch (err) { console.error('Error in PayrollRunService:', err); throw err; }
};

const loadPayrollSnapshot = async ({ db = knex, req, id, kind = 'employee' }) => {
  try {
    const cfg = workerConfig(kind);
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error('error_not_found');
    const run = await db(cfg.runTable).where('id', Number(id)).first();
    if (!run) throw new Error('error_not_found');
    await assertEmployeeScope(db, req, run[cfg.idColumn], kind);
    return run.snapshot;
  } catch (err) { console.error('Error in PayrollRunService:', err); throw err; }
};

module.exports = { normalizePayrollInput, assertPayrollPeriodEnded, assertEmployeeScope, previewPayroll, finalizePayroll, payrollPageData, loadPayrollSnapshot };
