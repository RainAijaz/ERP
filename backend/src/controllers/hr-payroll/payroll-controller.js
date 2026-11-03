'use strict';

const knex = require('../../db/knex');
const { previewPayroll, submitPayroll, loadPayrollSnapshot, normalizePayrollInput } = require('../../services/hr-payroll/payroll-period-service');
const { payrollWorkspace, legacyPayrollDestination, assertPayrollReportAccess } = require('../../services/hr-payroll/payroll-report-service');
const { publicErrorMessage } = require('../../middleware/errors/friendly-error');

const failure = (req, res, err) => {
  console.error('Error in PayrollController:', err);
  if (typeof req.flash === 'function') req.flash('error', res.locals.t('generic_error'));
  return res.status(err.status || 400).json({ message: publicErrorMessage(err, res.locals.t) });
};

exports.redirect = (req, res) => res.redirect(legacyPayrollDestination(req));
exports.workspace = async (req, res) => {
  try {
    const result = await knex.transaction(db => payrollWorkspace({ db, req, kind: req.params.kind, entityId: req.params.entityId, input: req.query }),
      { isolationLevel: 'repeatable read', readOnly: true });
    res.json({ ...result, periodError: result.periodError ? res.locals.t(result.periodError) : null });
  } catch (err) { return failure(req, res, err); }
};
exports.preview = async (req, res) => {
  try {
    const result = await knex.transaction(async db => {
      const worker = normalizePayrollInput(req.body);
      await assertPayrollReportAccess({ db, req, kind: worker.kind, entityId: worker.employeeId });
      return previewPayroll({ db, req, input: req.body });
    }, { isolationLevel: 'repeatable read', readOnly: true });
    res.json({ snapshot: result.snapshot, hash: result.hash });
  } catch (err) { return failure(req, res, err); }
};
exports.finalize = async (req, res) => {
  try {
    const worker = normalizePayrollInput(req.body);
    await assertPayrollReportAccess({ req, kind: worker.kind, entityId: worker.employeeId });
    const result = await submitPayroll({ req, input: req.body, t: res.locals.t });
    if (typeof req.flash === 'function') req.flash('success', result.message);
    res.status(result.queued ? 202 : 200).json(result);
  } catch (err) { return failure(req, res, err); }
};
exports.snapshot = async (req, res) => {
  try {
    const kind = req.params.kind || 'employee';
    const snapshot = await loadPayrollSnapshot({ req, id: req.params.id, kind });
    await assertPayrollReportAccess({ req, kind, entityId: snapshot[`${kind}_id`] });
    res.json({ snapshot });
  } catch (err) { return failure(req, res, err); }
};
