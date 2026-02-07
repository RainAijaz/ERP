const express = require("express");
const { requirePermission } = require("../../middleware/access/role-permissions");

const router = express.Router();

const renderScreen = (req, res, screen) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t(screen.titleKey)} - ${res.locals.t("hr_payroll")}`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    isAdmin: req.user?.isAdmin || false,
    csrfToken: res.locals.csrfToken,
    view: "../../hr_payroll/screen",
    t: res.locals.t,
    screen,
  });

router.get("/", requirePermission("SCREEN", "hr_payroll.labours", "view"), (req, res) => {
  return renderScreen(req, res, {
    titleKey: "labours",
    subtitle: "Labour master screen (Code, Name, CNIC, Category, Department, Phone, Branches, Status).",
    routePath: "/hr-payroll/labours",
    requirementRef: "requirements.txt:342",
  });
});

router.get("/rates", requirePermission("SCREEN", "hr_payroll.labour_rates", "view"), (req, res) => {
  return renderScreen(req, res, {
    titleKey: "labour_rates",
    subtitle:
      "Labour rates setup with Apply On (Product/Sub-Group/Group/Flat), selector and rate type (Per Dozen/Per Pair).",
    routePath: "/hr-payroll/labours/rates",
    requirementRef: "requirements.txt:352",
  });
});

module.exports = router;
