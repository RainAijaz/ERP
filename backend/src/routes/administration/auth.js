const express = require("express");
const knex = require("../../db/knex");
const authMiddleware = require("../../middleware/core/auth");
const { requireFields, normalizeFields } = require("../../middleware/utils/validation");
const { HttpError } = require("../../middleware/errors/http-error");
const { parseCookies, setCookie } = require("../../middleware/utils/cookies");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.user) {
    return res.redirect("/");
  }
  if (req.accepts("html")) {
    return res.render("auth/login", { error: null });
  }
  res.json({ message: "Login required" });
});

router.post(
  "/login",
  normalizeFields(["username"]),
  requireFields(["username", "password"]),
  async (req, res, next) => {
    try {
      const { username, password } = req.body;
      const user = await knex("erp.users")
        .select("id", "username", "password_hash", "status")
        .whereRaw("LOWER(username) = ?", [username.toLowerCase()])
        .first();

      if (!user || !authMiddleware.verifyPassword(password, user.password_hash)) {
        if (req.accepts("html")) {
          return res.status(401).render("auth/login", {
            error: res.locals.t("incorrect_credentials"),
          });
        }
        throw new HttpError(401, "Invalid credentials");
      }

      if (user.status && user.status.toLowerCase() !== "active") {
        if (req.accepts("html")) {
          return res.status(403).render("auth/login", {
            error: res.locals.t("user_inactive"),
          });
        }
        throw new HttpError(403, "User inactive");
      }

      await knex("erp.users")
        .where({ id: user.id })
        .update({ last_login_at: knex.fn.now() });

      const { token } = await authMiddleware.createSession({
        userId: user.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      setCookie(res, authMiddleware.SESSION_COOKIE_NAME, token, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60,
      });

      if (req.accepts("html")) {
        return res.redirect("/");
      }

      res.json({ message: "Login successful" });
    } catch (err) {
      if (req.accepts("html")) {
        return res.status(500).render("auth/login", {
          error: res.locals.t("login_failed"),
        });
      }
      next(err);
    }
  }
);

router.post("/logout", (req, res, next) => {
  const cookies = parseCookies(req);
  const token = cookies[authMiddleware.SESSION_COOKIE_NAME];
  const tokenHash = token ? authMiddleware.hashToken(token) : null;

  Promise.resolve(authMiddleware.revokeSession(tokenHash))
    .then(() => {
      setCookie(res, authMiddleware.SESSION_COOKIE_NAME, "", {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 0,
      });

      if (req.accepts("html")) {
        return res.redirect("/auth/login");
      }
      res.status(204).end();
    })
    .catch(next);
});

module.exports = router;
