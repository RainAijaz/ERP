const express = require("express");
const router = express.Router();

const branchesRoutes = require("./branches");
const usersRoutes = require("./users");
const rolesRoutes = require("./roles");
const permissionsRoutes = require("./permissions");

// Mount sub-routes
router.use("/branches", branchesRoutes);
router.use("/users", usersRoutes);
router.use("/roles", rolesRoutes);
router.use("/permissions", permissionsRoutes);

module.exports = router;
