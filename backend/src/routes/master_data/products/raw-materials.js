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
  renderPage(req, res, "../../master_data/products/raw-materials/index", res.locals.t("raw_materials"));
});

router.get("/new", (req, res) => {
  renderPage(req, res, "../../master_data/products/raw-materials/form", `New ${res.locals.t("raw_materials")}`);
});

module.exports = router;
