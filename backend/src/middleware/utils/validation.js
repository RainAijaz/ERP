const { HttpError } = require("../errors/http-error");

// Validates and normalizes request payloads; rejects malformed input early.
const requireFields = (fields) => (req, res, next) => {
  const missing = fields.filter(
    (field) =>
      req.body == null ||
      req.body[field] == null ||
      String(req.body[field]).trim() === ""
  );

  if (missing.length) {
    return next(
      new HttpError(400, "Missing required fields", { missing })
    );
  }

  next();
};

const normalizeFields = (fields) => (req, res, next) => {
  if (req.body) {
    fields.forEach((field) => {
      if (req.body[field] != null) {
        req.body[field] = String(req.body[field]).trim();
      }
    });
  }
  next();
};

module.exports = {
  requireFields,
  normalizeFields,
};

