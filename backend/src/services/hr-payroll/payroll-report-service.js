'use strict';

const knex = require('../../db/knex');
const { workerConfig } = require('./guaranteed-pay-service');
const { assertEmployeeScope, configuredPayrollPeriod } = require('./payroll-period-service');
const { normalizeRuleDate, todayYmd, addDaysYmd } = require('./commission-rules-service');
const { toLocalDateOnly } = require('../../utils/date-only');
const { canAccessScope } = require('../../middleware/access/role-permissions');
const { HttpError } = require('../../middleware/errors/http-error');

const assertPayrollReportAccess = async ({ db = knex, req, kind, entityId }) => {
  workerConfig(kind);
  const id = Number(entityId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'salary_invalid_period');
  if (!canAccessScope(req, 'REPORT', `${kind}_ledger`, 'load')) throw new HttpError(403, 'permission_denied');
  return assertEmployeeScope(db, req, id, kind);
};

// Metadata is global per person, while review checks retain their branch scope.
// No payroll amounts/snapshots are exposed in a balances report.
const attachPayrollReports = async ({ db = knex, req, kind, filters, reportData, balances = false }) => {
  try {
    if (!filters.reportLoaded) return;
    const cfg = workerConfig(kind);
    const entities = balances ? reportData.rows : reportData.entity ? [{ entity_id: reportData.entity.id }] : [];
    const ids = entities.map(row => Number(row.entity_id));
    if (!ids.length) return;
    const end = balances ? filters.asOn : filters.to;
    const closed = await db(cfg.runTable).whereIn(cfg.idColumn, ids).where('period_to', '<=', end)
      .select(cfg.idColumn).max({ finalized_through: 'period_to' }).groupBy(cfg.idColumn);
    const dates = new Map(closed.map(row => [Number(row[cfg.idColumn]), toLocalDateOnly(row.finalized_through)]));
    for (const row of entities) {
      row.payroll = { finalizedThrough: dates.get(Number(row.entity_id)) || '' };
    }
    if (balances) return;
    reportData.payroll = entities[0].payroll;
    let canClose = canAccessScope(req, 'SCREEN', cfg.scopeKey, 'view');
    if (canClose && !req.user?.isAdmin) {
      const branches = await db(cfg.branchTable).where(cfg.idColumn, ids[0]).select('branch_id');
      const allowed = (req.branchScope || []).map(Number);
      canClose = Boolean(branches.length && branches.every(row => allowed.includes(Number(row.branch_id))));
    }
    reportData.payrollContext = { kind, entityId: ids[0], reportEnd: end, canClose,
      reloadUrl: reportData.salaryReviewContext?.reloadUrl };
  } catch (err) { console.error('Error in PayrollReportService:', err); throw err; }
};

const payrollWorkspace = async ({ req, kind, entityId, input = {}, db = knex }) => {
  try {
    await assertPayrollReportAccess({ db, req, kind, entityId });
    const cfg = workerConfig(kind);
    const cursor = input.before_id == null ? null : Number(input.before_id);
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor <= 0)) throw new HttpError(400, 'salary_invalid_period');
    const query = db(cfg.runTable).where(cfg.idColumn, Number(entityId));
    if (cursor) query.where('id', '<', cursor);
    const runs = await query.select('id', 'period_from', 'period_to', 'total_payable').orderBy('id', 'desc').limit(26);
    const page = runs.slice(0, 25).map(row => ({ ...row, period_from: toLocalDateOnly(row.period_from), period_to: toLocalDateOnly(row.period_to) }));
    let period = null, periodError = null;
    if (!cursor) {
      const onDate = input.on_date || addDaysYmd(todayYmd(), -1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate) || normalizeRuleDate(onDate) !== onDate || onDate < '1900-01-01') throw new HttpError(400, 'salary_invalid_period');
      // Missing historical pay configuration must not hide saved payroll history.
      try {
        let candidate = onDate >= todayYmd() ? addDaysYmd(todayYmd(), -1) : onDate;
        period = await configuredPayrollPeriod({ db, kind, employeeId: Number(entityId), onDate: candidate });
        if (period.to >= todayYmd()) {
          candidate = addDaysYmd(period.from, -1);
          period = await configuredPayrollPeriod({ db, kind, employeeId: Number(entityId), onDate: candidate });
        }
        period = { from: period.from, to: period.to, frequency: period.frequency,
          absenceEnabled: Boolean(period.profile?.absence_deductions_enabled) };
      } catch (err) {
        if (!['salary_effective_required', 'salary_week_end_required'].includes(err.message)) throw err;
        periodError = err.message;
      }
    }
    return { runs: page, nextCursor: runs.length > 25 ? Number(page.at(-1).id) : null, period, periodError };
  } catch (err) { console.error('Error in PayrollReportService:', err); throw err; }
};

const legacyPayrollDestination = req => {
  for (const kind of ['employee', 'labour']) {
    if (canAccessScope(req, 'REPORT', `${kind}_balances`, 'load')) return `/reports/hr-payroll/${kind}-balances`;
    if (canAccessScope(req, 'REPORT', `${kind}_ledger`, 'load')) return `/reports/hr-payroll/${kind}-ledger`;
  }
  return '/';
};

module.exports = { attachPayrollReports, assertPayrollReportAccess, payrollWorkspace, legacyPayrollDestination };
