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
  renderPage(req, res, "../../master_data/products/finished/index", res.locals.t("finished"));
});

router.get("/new", (req, res) => {
  renderPage(req, res, "../../master_data/products/finished/form", `New ${res.locals.t("finished")}`);
});

module.exports = router;
