const crypto = require("crypto");

// Assigns a unique request ID for tracing and log correlation.
module.exports = (req, res, next) => {
  const incoming = req.get("x-request-id");
  req.id = incoming || crypto.randomUUID();
  res.set("x-request-id", req.id);
  next();
};

