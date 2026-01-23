const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  return res.render("base/layouts/main", {
    title: `${res.locals.t("parties")} - Master Data`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/parties/index",
    t: res.locals.t,
  });
});

module.exports = router;
