const path = require("path");
const express = require("express");
const compression = require("compression");
require("dotenv").config();

const uiRoutes = require("./routes/ui-routes");

const requestId = require("./middleware/core/request-id");
const locale = require("./middleware/core/locale");
const branchContext = require("./middleware/core/branch-context");
const auth = require("./middleware/core/auth");
const sessionTimeout = require("./middleware/core/session-timeout");
const rolePermissions = require("./middleware/access/role-permissions");
const branchScope = require("./middleware/access/branch-scope");
const auditFreeze = require("./middleware/approvals/audit-freeze");
const makerChecker = require("./middleware/approvals/maker-checker");
const approvalRequired = require("./middleware/approvals/approval-required");
const rateChangeApproval = require("./middleware/approvals/rate-change-approval");
const stockAdjustmentApproval = require("./middleware/approvals/stock-adjustment-approval");
const activityLog = require("./middleware/audit/activity-log");
const csrf = require("./middleware/security/csrf");
const uiNotice = require("./middleware/core/ui-notice");
const uiFlash = require("./middleware/core/ui-flash");
const notFound = require("./middleware/errors/not-found");
const errorHandler = require("./middleware/errors/error-handler");
const knex = require("./db/knex");
const { navConfig, syncNavScopes } = require("./utils/nav-config");
const { initWhatsApp } = require("./utils/whatsapp");

const app = express();

const jsonBodyLimit = process.env.HTTP_JSON_LIMIT || "1mb";
const formBodyLimit = process.env.HTTP_FORM_LIMIT || "1mb";
const staticCacheMaxAge = process.env.STATIC_MAX_AGE || "1h";
const staticVendorCacheMaxAge = process.env.STATIC_VENDOR_MAX_AGE || "30d";

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY || 1);

app.use(express.json({ limit: jsonBodyLimit }));
app.use(express.urlencoded({ extended: false, limit: formBodyLimit }));

if (String(process.env.HTTP_COMPRESSION || "1") === "1") {
  app.use(compression());
}

app.use(
  "/vendor",
  express.static(path.join(__dirname, "..", "public", "vendor"), {
    maxAge: staticVendorCacheMaxAge,
    immutable: true,
  }),
);

// Serve QR with no-cache so browsers always fetch the latest image (QR codes expire in ~20s)
app.get("/whatsapp-qr.png", (req, res) => {
  const qrFile = path.join(__dirname, "..", "public", "whatsapp-qr.png");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.sendFile(qrFile, (err) => {
    if (err && !res.headersSent) res.status(404).send("QR not generated yet");
  });
});

// Auto-refreshing QR scanner page — open this URL in a browser to link WhatsApp
app.get("/whatsapp-qr", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WhatsApp QR</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 40px; background: #f0f0f0; }
    img { border: 4px solid #25d366; border-radius: 8px; max-width: 320px; }
    p { color: #555; margin-top: 12px; }
    #status { font-weight: bold; color: #25d366; }
  </style>
</head>
<body>
  <h2>Scan to connect WhatsApp</h2>
  <img id="qr" src="/whatsapp-qr.png?t=${Date.now()}" alt="QR Code">
  <p>QR refreshes every 15 seconds. Scan immediately after it updates.</p>
  <p id="status">Waiting for QR...</p>
  <script>
    let count = 15;
    const img = document.getElementById('qr');
    const status = document.getElementById('status');
    setInterval(() => {
      count--;
      status.textContent = 'Refreshing in ' + count + 's...';
      if (count <= 0) {
        count = 15;
        img.src = '/whatsapp-qr.png?t=' + Date.now();
        status.textContent = 'QR updated — scan now!';
      }
    }, 1000);
  </script>
</body>
</html>`);
});

app.use(
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: staticCacheMaxAge,
  }),
);

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

app.use(requestId);
app.use(locale);
app.use(branchContext);
app.use((req, res, next) => {
  res.locals.navConfig = navConfig;
  next();
});

app.use(auth);
app.use(sessionTimeout);
app.use(rolePermissions);
app.use(branchScope);

app.use(auditFreeze);
app.use(makerChecker);
app.use(approvalRequired);
app.use(rateChangeApproval);
app.use(stockAdjustmentApproval);
app.use(activityLog);

app.use(csrf);
app.use(uiNotice);
app.use(uiFlash);

app.use("/", uiRoutes);

app.use(notFound);
app.use(errorHandler);

const port = process.env.PORT || 3000;
const server = app.listen(port, () =>
  console.log(`Server running on port ${port}`),
);

server.keepAliveTimeout = Number(
  process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || 65000,
);
server.headersTimeout = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 66000);
server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 120000);

syncNavScopes(knex).catch((err) => {
  console.error("Failed to sync nav permission scopes:", err.message || err);
});

if (process.env.WHATSAPP_RATE_NOTIFY_CHAT_ID) {
  initWhatsApp();
}
