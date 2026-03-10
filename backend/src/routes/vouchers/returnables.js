const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  const requestedType = String(req.query.type || "").trim().toUpperCase();
  if (requestedType === "RRV") {
    return res.redirect("/vouchers/returnable-receipt");
  }
  return res.redirect("/vouchers/returnable-dispatch");
});

module.exports = router;
