const express = require("express");
const authRoutes = require("./administration/auth");
const approvalRoutes = require("./administration/approvals");
const voucherEngineRoutes = require("./vouchers/voucher-engine");
const { requirePermission } = require("../middleware/access/role-permissions");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/administration/approvals", approvalRoutes);
router.use("/vouchers", voucherEngineRoutes);

router.get("/whoami", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.json({
    id: req.user.id,
    username: req.user.username,
    role: req.user.primaryRoleName,
    branchIds: req.user.branchIds,
    branchId: req.branchId,
  });
});

router.get("/test-permission", requirePermission("MODULE", "administration", "view"), (req, res) => {
  res.json({ ok: true, permission: "MODULE:administration:view" });
});

router.get("/", (req, res) => {
  if (req.accepts("html")) {
    return res.render("base/layouts/main", {
      title: "Dashboard",
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      csrfToken: res.locals.csrfToken,
      view: "../../dashboard/index",
      t: res.locals.t,
    });
  }
  res.json({ status: "ok" });
});

module.exports = router;
