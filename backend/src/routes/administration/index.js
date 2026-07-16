const express = require("express");
const router = express.Router();

const branchesRoutes = require("./branches");
const usersRoutes = require("./users");
const rolesRoutes = require("./roles");
const permissionsRoutes = require("./permissions");
const auditLogsRoutes = require("./audit-logs");
const whatsappNotificationsRoutes = require("./whatsapp-notifications");

// Mount sub-routes
router.use("/branches", branchesRoutes);
router.use("/users", usersRoutes);
router.use("/roles", rolesRoutes);
router.use("/permissions", permissionsRoutes);
router.use("/audit-logs", auditLogsRoutes);
router.use("/whatsapp-notifications", whatsappNotificationsRoutes);

module.exports = router;
