const express = require("express");
const knex = require("../../../db/knex");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { setCookie } = require("../../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../../middleware/core/ui-notice");
const { submitRule, loadRulePageTx } =
  require("../../../services/sales/packaging-repack-service");

const router = express.Router();
const SCOPE = "master_data.products.skus";

const notice = (res, message, error = false) => setCookie(
  res, UI_NOTICE_COOKIE, JSON.stringify({ message, autoClose: !error,
    sticky: error, type: error ? "error" : "success" }),
  { path: "/", maxAge: 30, sameSite: "Lax" },
);

router.get("/", requirePermission("SCREEN", SCOPE, "navigate"), async (req, res, next) => {
  try {
    const page = await loadRulePageTx(knex, req.query.rule);
    return res.render("base/layouts/main", {
      title: res.locals.t("repack_rules"),
      user: req.user, branchId: req.branchId, branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken, t: res.locals.t,
      view: "../../master_data/products/skus/repack-rules",
      basePath: req.baseUrl, page, selected: page.selected,
    });
  } catch (err) {
    console.error("Error in PackagingRepackRuleLoadService:", err);
    next(err);
  }
});

router.post("/", async (req, res) => {
  try {
    const outcome = await submitRule({ req, input: req.body });
    notice(res, res.locals.t(outcome.queued ? "change_submitted_admin_approval" : "saved_successfully"));
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in PackagingRepackRuleSaveService:", err);
    const key = String(err.code || "").startsWith("repack_")
      ? err.code
      : err.code === "23505" ? "repack_ambiguous_rule" : "generic_error";
    notice(res, res.locals.t(key), true);
    return res.redirect(req.baseUrl);
  }
});

module.exports = router;
