const express = require("express");
const authRoutes = require("./administration/auth");
const approvalRoutes = require("./administration/approvals");
const administrationRoutes = require("./administration");
const voucherEngineRoutes = require("./vouchers/voucher-engine");
const masterDataRoutes = require("./master_data");
const hrPayrollRoutes = require("./hr-payroll");
const { requirePermission } = require("../middleware/access/role-permissions");
const { translateUrduWithFallback } = require("../utils/translate");
const { registerApprovalStream, ackApprovalDecisions } = require("../utils/approval-events");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/administration", administrationRoutes);
router.use("/administration/approvals", approvalRoutes); // keep for direct/legacy links
router.use("/master-data", masterDataRoutes);
router.use("/hr-payroll", hrPayrollRoutes);
router.use("/vouchers", voucherEngineRoutes);

router.get("/events/approvals", (req, res) => {
  if (!req.user) {
    return res.status(401).end();
  }
  registerApprovalStream(req, res);
});

router.post("/events/approvals/ack", (req, res) => {
  if (!req.user) {
    return res.status(401).end();
  }
  ackApprovalDecisions(req.user.id);
  res.json({ ok: true });
});

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

router.get("/test-permission", requirePermission("MODULE", "administration", "navigate"), (req, res) => {
  res.json({ ok: true, permission: "MODULE:administration:navigate" });
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

  const startedAt = Date.now();
  const requestId = `tr-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const textPreview = text.length > 64 ? `${text.slice(0, 64)}...` : text;
  const routeLogger = {
    error: (message, details = {}) => {
      console.error(message, {
        request_id: requestId,
        mode,
        user_id: req.user?.id || null,
        text_length: text.length,
        text_preview: textPreview,
        ...details,
      });
    },
  };

  try {
    const translatePromise = translateUrduWithFallback({ text, mode, logger: routeLogger });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Translation request timed out")), 12000);
    });
    const { translated, provider, azure_error: azureError } = await Promise.race([translatePromise, timeoutPromise]);
    console.log("[translate-route] success", {
      request_id: requestId,
      mode,
      provider,
      duration_ms: Date.now() - startedAt,
      text_length: text.length,
    });
    return res.json({ translated, provider, azure_error: azureError });
  } catch (err) {
    console.error("[translate-route] translation failed", {
      request_id: requestId,
      mode,
      user_id: req.user?.id || null,
      duration_ms: Date.now() - startedAt,
      text_length: text.length,
      text_preview: textPreview,
      error: err?.message || err,
      stack: err?.stack || null,
    });
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
