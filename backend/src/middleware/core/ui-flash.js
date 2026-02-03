const { parseCookies, setCookie } = require("../utils/cookies");

const UI_ERROR_COOKIE = "ui_error";

const readUiError = (req, res) => {
  const cookies = parseCookies(req);
  if (!cookies[UI_ERROR_COOKIE]) return null;
  let payload = null;
  try {
    payload = JSON.parse(cookies[UI_ERROR_COOKIE]);
  } catch (err) {
    payload = null;
  }
  setCookie(res, UI_ERROR_COOKIE, "", { path: "/", maxAge: 0, sameSite: "Lax" });
  return payload;
};

module.exports = (req, res, next) => {
  res.locals.uiError = readUiError(req, res);
  next();
};

module.exports.UI_ERROR_COOKIE = UI_ERROR_COOKIE;
