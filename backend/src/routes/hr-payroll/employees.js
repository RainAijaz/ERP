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

router.get("/", requirePermission("SCREEN", "hr_payroll.employees", "view"), (req, res) => {
  return renderScreen(req, res, {
    titleKey: "employees",
    subtitle:
      "Employee master screen (Code, Name, CNIC, Phone, Department, Designation/Role, Payroll Type, Basic Salary, Branches, Status).",
    routePath: "/hr-payroll/employees",
    requirementRef: "requirements.txt:300",
  });
});

router.get("/commissions", requirePermission("SCREEN", "hr_payroll.commissions", "view"), (req, res) => {
  return renderScreen(req, res, {
    titleKey: "sales_commission",
    subtitle:
      "Sales commission rules by employee with priority logic: Product > Sub-Group > Group > Flat, latest voucher overrides older.",
    routePath: "/hr-payroll/employees/commissions",
    requirementRef: "requirements.txt:312",
  });
});

router.get("/allowances", requirePermission("SCREEN", "hr_payroll.allowances", "view"), (req, res) => {
  return renderScreen(req, res, {
    titleKey: "allowances",
    subtitle: "Allowance setup by employee (type, amount type, amount, frequency, taxable flag).",
    routePath: "/hr-payroll/employees/allowances",
    requirementRef: "requirements.txt:334",
  });
});

module.exports = router;
