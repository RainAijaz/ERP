const { parseCookies, setCookie } = require("../utils/cookies");

const UI_NOTICE_COOKIE = "ui_notice";

const readUiNotice = (req, res) => {
  const cookies = parseCookies(req);
  if (!cookies[UI_NOTICE_COOKIE]) return null;
  let payload = null;
  try {
    payload = JSON.parse(cookies[UI_NOTICE_COOKIE]);
  } catch (err) {
    payload = null;
  }
  setCookie(res, UI_NOTICE_COOKIE, "", { path: "/", maxAge: 0, sameSite: "Lax" });
  return payload;
};

module.exports = (req, res, next) => {
  res.locals.uiNotice = readUiNotice(req, res);
  next();
};

module.exports.UI_NOTICE_COOKIE = UI_NOTICE_COOKIE;
