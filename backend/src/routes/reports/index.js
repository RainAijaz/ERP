const express = require("express");
const financialRoutes = require("./financial");

const router = express.Router();

router.use("/financial", financialRoutes);

module.exports = router;
