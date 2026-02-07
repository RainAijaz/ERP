const express = require("express");
const employeesRoutes = require("./employees");
const laboursRoutes = require("./labours");

const router = express.Router();

router.get("/commission", (req, res) => res.redirect("/hr-payroll/employees/commissions"));
router.get("/allowances", (req, res) => res.redirect("/hr-payroll/employees/allowances"));
router.get("/labour-rates", (req, res) => res.redirect("/hr-payroll/labours/rates"));

router.use("/employees", employeesRoutes);
router.use("/labours", laboursRoutes);

module.exports = router;
