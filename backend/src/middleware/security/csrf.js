const crypto = require("crypto");
const { HttpError } = require("../errors/http-error");
const { parseCookies, setCookie } = require("../utils/cookies");

// CSRF protection for form submissions using tokens.
module.exports = (req, res, next) => {
  const cookies = parseCookies(req);
  let token = cookies.csrf_token;

  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    setCookie(res, "csrf_token", token, {
      path: "/",
      sameSite: "Lax",
    });
  }

  res.locals.csrfToken = token;

  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  if (req.path.startsWith("/auth/login")) {
    return next();
  }

  const provided =
    req.get("x-csrf-token") ||
    req.body?._csrf ||
    req.query?._csrf ||
    "";

  if (!provided || provided !== token) {
    console.error("[csrf] token mismatch", {
      request_id: req.id || null,
      method: req.method,
      path: req.originalUrl || req.path,
      user_id: req.user?.id || null,
      has_cookie_token: Boolean(token),
      has_provided_token: Boolean(provided),
      provided_len: provided ? String(provided).length : 0,
      cookie_len: token ? String(token).length : 0,
    });
    return next(new HttpError(403, "Invalid CSRF token"));
  }

  next();
};

