const { HttpError } = require("./http-error");
const { friendlyErrorMessage } = require("./friendly-error");
const { setCookie } = require("../utils/cookies");
const { UI_ERROR_COOKIE } = require("../core/ui-flash");

// Final error handler: logs details and returns safe, consistent responses.
module.exports = (err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  const message = friendlyErrorMessage(err, res.locals?.t);
  const path = req.originalUrl || req.path || "";
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
  if (path.includes("/hr-payroll/employees/commissions/bulk-preview")) {
    console.error("[commissions:bulk-preview:error-handler]", {
      request_id: req.id || null,
      status,
      method: req.method,
      path,
      user_id: req.user?.id || null,
      username: req.user?.username || null,
      branch_id: req.branchId || null,
      accepts_html: Boolean(req.accepts("html")),
      message,
      raw_error: err?.message || String(err),
      details: err?.details || null,
    });
  }
  if ((req.originalUrl || req.path || "").includes("/translate") && status >= 400) {
    console.error("[translate-route] request failed before/at handler", {
      request_id: req.id || null,
      status,
      method: req.method,
      path: req.originalUrl || req.path,
      user_id: req.user?.id || null,
      message,
      raw_error: err?.message || String(err),
    });
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

