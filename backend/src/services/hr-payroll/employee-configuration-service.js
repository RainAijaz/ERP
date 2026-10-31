const { normalizeRuleDate } = require('./commission-rules-service');

// Shared by direct saves and approval replay. Never guess a weekly boundary.
const SALARY_FIELDS = ['salary_effective_from', 'week_ending_day',
  'absence_deductions_enabled', 'absence_day_divisor', 'salary_proration'];
const optionalNumber = value => value == null || (typeof value === 'string' && value.trim() === '') ? null :
  (typeof value === 'string' || typeof value === 'number') ? Number(value) : NaN;

const normalizeEmployeeConfiguration = values => ({
  ...values,
  salary_effective_from: normalizeRuleDate(values.salary_effective_from),
  week_ending_day: values.payroll_type === 'WEEKLY' ? optionalNumber(values.week_ending_day) : null,
  absence_deductions_enabled: [true, 'true', 'on', 1, '1'].includes(values.absence_deductions_enabled),
  absence_day_divisor: optionalNumber(values.absence_day_divisor),
  salary_proration: values.salary_proration || 'NONE',
  employment_start_date: normalizeRuleDate(values.employment_start_date),
  employment_end_date: normalizeRuleDate(values.employment_end_date),
});

const employeeConfigurationError = values => {
  if (!['MONTHLY', 'WEEKLY', 'DAILY', 'PIECE_RATE', 'MULTIPLE'].includes(values.payroll_type))
    return { field: 'payroll_type', key: 'error_invalid_payroll_type' };
  if (!values.salary_effective_from) return { field: 'salary_effective_from', key: 'salary_effective_required' };
  if (values.payroll_type === 'WEEKLY' && (!Number.isInteger(values.week_ending_day) || values.week_ending_day < 0 || values.week_ending_day > 6))
    return { field: 'week_ending_day', key: 'salary_week_end_required' };
  if (!['NONE', 'CALENDAR_DAYS'].includes(values.salary_proration))
    return { field: 'salary_proration', key: 'error_required_fields' };
  if ((values.absence_day_divisor != null && (!Number.isFinite(values.absence_day_divisor) || values.absence_day_divisor <= 0 || values.absence_day_divisor > 366)) ||
      (values.absence_deductions_enabled && !(values.absence_day_divisor > 0)))
    return { field: 'absence_day_divisor', key: 'salary_invalid_divisor' };
  if (values.employment_start_date === undefined || values.employment_end_date === undefined)
    return { field: 'employment_start_date', key: 'error_invalid_date' };
  if (!values.employment_start_date) return { field: 'employment_start_date', key: 'error_required_fields' };
  if (values.employment_end_date && values.employment_end_date < values.employment_start_date)
    return { field: 'employment_end_date', key: 'error_invalid_date_range' };
  return null;
};

const assertEmployeeConfiguration = values => {
  const error = employeeConfigurationError(values);
  if (error) throw Object.assign(new Error(error.key), { field: error.field });
  return values;
};

const validateEmployeeApprovalConfiguration = async (db, request) => {
  const current = request.new_value || {};
  if (current.mode || !Object.keys(current).some(key => !key.startsWith('_') && key !== 'status')) return;
  const existing = request.entity_id === 'NEW' ? null : await db('erp.employees').where({ id: request.entity_id }).first();
  assertEmployeeConfiguration(normalizeEmployeeConfiguration({ ...existing, ...current }));
};

module.exports = { SALARY_FIELDS, normalizeEmployeeConfiguration, employeeConfigurationError, assertEmployeeConfiguration, validateEmployeeApprovalConfiguration };
