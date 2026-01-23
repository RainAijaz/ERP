const express = require("express");
const authRoutes = require("./administration/auth");
const approvalRoutes = require("./administration/approvals");
const voucherEngineRoutes = require("./vouchers/voucher-engine");
const masterDataRoutes = require("./master_data");
const { requirePermission } = require("../middleware/access/role-permissions");
const { translateToUrdu, transliterateToUrdu } = require("../utils/translate");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/administration/approvals", approvalRoutes);
router.use("/master-data", masterDataRoutes);
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

router.post("/translate", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const mode = typeof req.body.mode === "string" ? req.body.mode.trim() : "translate";
  if (!text) {
    return res.json({ translated: "" });
  }

  try {
    let translated = "";
    let provider = "deepl";
    let azureError = null;
    if (mode === "transliterate") {
      try {
        translated = await transliterateToUrdu(text);
        provider = "azure";
      } catch (err) {
        azureError = err.message;
        translated = await translateToUrdu(text);
        provider = "deepl";
      }
    } else {
      translated = await translateToUrdu(text);
      provider = "deepl";
    }
    return res.json({ translated, provider, azure_error: azureError });
  } catch (err) {
    return res.status(502).json({ error: "Translation unavailable", detail: err.message });
  }
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
