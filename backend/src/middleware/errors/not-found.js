const { HttpError } = require("./http-error");

// Catch-all 404 handler for unknown routes.
module.exports = (req, res, next) => {
  next(new HttpError(404, "Route not found", { path: req.originalUrl }));
};

