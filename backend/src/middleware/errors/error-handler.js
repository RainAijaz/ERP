const { HttpError } = require("./http-error");

// Final error handler: logs details and returns safe, consistent responses.
module.exports = (err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  const payload = {
    error: err.message || "Unexpected error",
    requestId: req.id,
  };

  if (err instanceof HttpError && err.details) {
    payload.details = err.details;
  }

  if (status >= 500) {
    // Keep server-side visibility for unexpected failures.
    console.error(`[${req.id}]`, err);
  }

  if (req.accepts("html")) {
    res.status(status).send(payload.error);
    return;
  }

  res.status(status).json(payload);
};

