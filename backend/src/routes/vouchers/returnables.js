const express = require("express");
const { HttpError } = require("../../middleware/errors/http-error");
const { canAccessScope } = require("../../middleware/access/role-permissions");

const router = express.Router();

const requireLegacyReturnablesViewPermission = (req, res, next) => {
  const requestedType = String(req.query.type || "")
    .trim()
    .toUpperCase();
  const scopeKey = requestedType === "RRV" ? "RRV" : "RDV";
  const allowed = canAccessScope(req, "VOUCHER", scopeKey, "view");
  if (allowed) return next();
  return next(
    new HttpError(
      403,
      (typeof res?.locals?.t === "function" &&
        (res.locals.t("permission_denied") || "").trim()) ||
        "Permission denied",
    ),
  );
};

router.get("/", requireLegacyReturnablesViewPermission, (req, res) => {
  const requestedType = String(req.query.type || "")
    .trim()
    .toUpperCase();
  if (requestedType === "RRV") {
    return res.redirect("/vouchers/returnable-receipt");
  }
  return res.redirect("/vouchers/returnable-dispatch");
});

module.exports = router;
