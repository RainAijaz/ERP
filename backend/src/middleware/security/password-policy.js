const { HttpError } = require("../errors/http-error");

const MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH || 8);
const MAX_AGE_DAYS = Number(process.env.PASSWORD_MAX_AGE_DAYS || 0);

const validatePasswordPolicy = (password) => {
  const errors = [];
  if (!password || password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`);
  }
  return errors;
};

const enforcePasswordPolicy = (req, res, next) => {
  const { password } = req.body || {};
  const errors = validatePasswordPolicy(password);
  if (errors.length) {
    return next(new HttpError(400, "Password policy violation", { errors }));
  }
  next();
};

const isPasswordExpired = (passwordChangedAt) => {
  if (!MAX_AGE_DAYS || !passwordChangedAt) return false;
  const changed = new Date(passwordChangedAt).getTime();
  if (!changed) return false;
  const ageDays = (Date.now() - changed) / (1000 * 60 * 60 * 24);
  return ageDays > MAX_AGE_DAYS;
};

module.exports = {
  enforcePasswordPolicy,
  validatePasswordPolicy,
  isPasswordExpired,
};

