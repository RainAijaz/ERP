const express = require("express");

const router = express.Router();

const renderPage = (req, res, view, title) =>
  res.render("base/layouts/main", {
    title,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view,
    t: res.locals.t,
  });

router.get("/", (req, res) => {
  renderPage(req, res, "../../master_data/accounts/index", res.locals.t("accounts"));
});

router.get("/new", (req, res) => {
  renderPage(req, res, "../../master_data/accounts/form", `New ${res.locals.t("accounts")}`);
});

module.exports = router;
