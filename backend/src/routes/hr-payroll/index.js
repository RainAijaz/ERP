const express = require("express");
const employeesRoutes = require("./employees");
const laboursRoutes = require("./labours");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");

const router = express.Router();

router.get(
  "/commission",
  requirePermission("SCREEN", "hr_payroll.commissions", "view"),
  (req, res) => res.redirect("/hr-payroll/employees/commissions"),
);
router.get(
  "/allowances",
  requirePermission("SCREEN", "hr_payroll.allowances", "view"),
  (req, res) => res.redirect("/hr-payroll/employees/allowances"),
);
router.get(
  "/labour-rates",
  requirePermission("SCREEN", "hr_payroll.labour_rates", "view"),
  (req, res) => res.redirect("/hr-payroll/labours/rates"),
);

router.use("/employees", employeesRoutes);
router.use("/labours", laboursRoutes);

module.exports = router;
