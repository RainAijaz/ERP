const express = require("express");

const router = express.Router();

router.get("/", (req, res) =>
  res.redirect("/vouchers/stock-transfer-out?new=1"),
);

module.exports = router;
