const { HttpError } = require("../errors/http-error");
const { revokeSession, SESSION_COOKIE_NAME } = require("./auth");
const { setCookie } = require("../utils/cookies");

// Ends idle sessions based on timeout policy.
module.exports = async (req, res, next) => {
  if (!req.authSession) {
    return next();
  }

  const timeoutMinutes = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES || 30);
  if (!timeoutMinutes) {
    return next();
  }

  const lastSeen = new Date(req.authSession.lastSeenAt).getTime();
  if (!lastSeen) {
    return next();
  }

  const idleMs = Date.now() - lastSeen;
  if (idleMs <= timeoutMinutes * 60 * 1000) {
    return next();
  }

  try {
    await revokeSession(req.authSession.tokenHash);
  } catch (err) {
    return next(err);
  }

  setCookie(res, SESSION_COOKIE_NAME, "", {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 0,
  });

  next(new HttpError(401, "Session expired"));
};

