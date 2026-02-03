const { HttpError } = require("./http-error");
const { friendlyErrorMessage } = require("./friendly-error");
const { setCookie } = require("../utils/cookies");
const { UI_ERROR_COOKIE } = require("../core/ui-flash");

// Final error handler: logs details and returns safe, consistent responses.
module.exports = (err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  const message = friendlyErrorMessage(err, res.locals?.t);
  const payload = {
    error: message,
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
    const referer = req.get("referer") || "";
    if (req.method !== "GET" && referer) {
      setCookie(res, UI_ERROR_COOKIE, JSON.stringify({ message }), {
        path: "/",
        maxAge: 30,
        sameSite: "Lax",
      });
      return res.redirect(referer);
    }
    res.status(status).send(payload.error);
    return;
  }

  res.status(status).json(payload);
};

