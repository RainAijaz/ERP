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
  renderPage(req, res, "../../master_data/parties/index", res.locals.t("parties"));
});

router.get("/new", (req, res) => {
  renderPage(req, res, "../../master_data/parties/form", `New ${res.locals.t("parties")}`);
});

module.exports = router;
