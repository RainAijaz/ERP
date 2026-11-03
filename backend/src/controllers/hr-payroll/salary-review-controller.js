const { submitSalaryReview } = require('../../services/hr-payroll/salary-review-service');
const { publicErrorMessage } = require('../../middleware/errors/friendly-error');

exports.save = async (req, res) => {
  try {
    const result = await submitSalaryReview({ req, input: req.body, t: res.locals.t });
    if (typeof req.flash === 'function') req.flash('success', result.message);
    return res.status(result.queued ? 202 : 200).json(result);
  } catch (err) {
    console.error('Error in SalaryReviewController:', err);
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500 && typeof req.flash === 'function') req.flash('error', res.locals.t('generic_error'));
    return res.status(status).json({ message: publicErrorMessage(err, res.locals.t) });
  }
};
