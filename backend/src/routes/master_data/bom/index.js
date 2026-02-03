const express = require("express");
const { requirePermission } = require("../../../middleware/access/role-permissions");

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

router.get("/", requirePermission("SCREEN", "master_data.bom", "view"), (req, res) => {
  renderPage(req, res, "../../master_data/bom/index", res.locals.t("bom_list"));
});

router.get("/new", requirePermission("SCREEN", "master_data.bom", "create"), (req, res) => {
  renderPage(req, res, "../../master_data/bom/form", `New ${res.locals.t("bom")}`);
});

router.get("/approval", requirePermission("SCREEN", "master_data.bom.approval", "view"), (req, res) => {
  renderPage(req, res, "../../master_data/bom/approval", res.locals.t("bom_approval"));
});

router.get("/versions", requirePermission("SCREEN", "master_data.bom.versions", "view"), (req, res) => {
  renderPage(req, res, "../../master_data/bom/versions", res.locals.t("bom_versions"));
});

module.exports = router;
