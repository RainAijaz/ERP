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
const reportViewLog = require("./middleware/audit/report-view-log");
const csrf = require("./middleware/security/csrf");
const uiNotice = require("./middleware/core/ui-notice");
const uiFlash = require("./middleware/core/ui-flash");
const notFound = require("./middleware/errors/not-found");
const errorHandler = require("./middleware/errors/error-handler");
const knex = require("./db/knex");
const { navConfig, syncNavScopes } = require("./utils/nav-config");
const {
  initWhatsApp,
  onWhatsAppReady,
  shutdownWhatsApp,
  getWhatsAppStatus,
} = require("./utils/whatsapp");
const {
  startWhatsAppRetryWorker,
  stopWhatsAppRetryWorker,
  retryQueuedWhatsAppNotifications,
} = require("./utils/payment-notification-retry");

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

// Liveness for the QR page below. Deliberately a narrow subset of
// getWhatsAppStatus(): this route is unauthenticated (same as the QR image it
// describes), so failure streaks and disconnect reasons stay on the admin screen.
app.get("/whatsapp-qr-status", (req, res) => {
  const status = getWhatsAppStatus();
  res.set("Cache-Control", "no-store");
  res.json({
    ready: status.ready,
    disabled: status.disabled,
    // Changes on every rotation; the page refetches the image when it moves.
    lastQrAt: status.lastQrAt ? status.lastQrAt.toISOString() : null,
  });
});

// QR scanner page — open this URL in a browser to link WhatsApp.
//
// WhatsApp rotates the pairing code roughly every 20s and whatsapp.js rewrites
// the PNG on each `qr` event. This page used to refetch on a blind 15s timer,
// which is unsynchronised with that rotation: the fetch landed at an arbitrary
// point in the code's life and drifted backwards through it every cycle, so the
// image on screen was routinely seconds from expiry and scans failed at random.
// Instead, poll lastQrAt and refetch the moment the server actually rotates —
// the displayed code is then never more than one poll interval old.
app.get("/whatsapp-qr", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp QR</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 40px; background: #f0f0f0; color: #333; }
    #qr { border: 4px solid #25d366; border-radius: 8px; max-width: 320px; width: 100%; }
    #qr.stale { opacity: 0.35; }
    #frame { min-height: 320px; display: flex; align-items: center; justify-content: center; }
    #status { font-weight: bold; margin-top: 12px; }
    .ok { color: #25d366; }
    .warn { color: #b45309; }
    .err { color: #b91c1c; }
    .hint { color: #555; font-size: 14px; }
    #done { display: none; font-size: 18px; font-weight: bold; color: #25d366; }
  </style>
</head>
<body>
  <h2>Scan to connect WhatsApp</h2>
  <div id="frame">
    <img id="qr" alt="WhatsApp QR code" style="display:none">
    <div id="done">✓ Connected — WhatsApp is linked.<br><span class="hint">You can close this page.</span></div>
  </div>
  <p id="status" class="hint">Checking status...</p>
  <p class="hint">The code refreshes on its own the moment WhatsApp issues a new one. Just scan whatever is on screen.</p>
  <script>
    (function () {
      var POLL_MS = 2000;
      var img = document.getElementById('qr');
      var done = document.getElementById('done');
      var status = document.getElementById('status');
      var shownQrAt = null;   // lastQrAt of the code currently displayed
      var shownAtLocal = 0;   // local clock when we displayed it, for the age readout
      var timer = null;

      var setStatus = function (text, cls) {
        status.textContent = text;
        status.className = cls || 'hint';
      };

      var show = function (lastQrAt) {
        shownQrAt = lastQrAt;
        shownAtLocal = Date.now();
        img.classList.remove('stale');
        // Cache-buster: the image path is fixed, only its contents change.
        img.src = '/whatsapp-qr.png?t=' + encodeURIComponent(lastQrAt);
        img.style.display = 'block';
        done.style.display = 'none';
      };

      var tick = function () {
        // Age is measured from when this browser displayed the code, so a clock
        // skew between server and phone cannot make a live code look expired.
        if (!shownQrAt || img.style.display === 'none') return;
        var age = Math.round((Date.now() - shownAtLocal) / 1000);
        if (age <= 20) {
          // Inside WhatsApp's ~20s rotation window: this code is good.
          img.classList.remove('stale');
          setStatus('Code is ' + age + 's old — scan now.', 'ok');
        } else if (age <= 35) {
          // Rotation is only roughly 20s, so a few seconds over is normal and must
          // not read as a fault. The code is probably spent though, so stop urging
          // a scan and grey it out rather than claiming anything is wrong.
          img.classList.add('stale');
          setStatus('Waiting for the next code...', 'hint');
        } else {
          // Well past any plausible rotation: the client has stopped emitting,
          // which is a failed session restore rather than an expired code. That is
          // fixed by restarting the client, never by scanning harder.
          img.classList.add('stale');
          setStatus('No new code for ' + age + 's — the WhatsApp client looks stuck. Restart the server; re-scanning will not help.', 'warn');
        }
      };

      var poll = function () {
        fetch('/whatsapp-qr-status', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (s) {
            if (s.ready) {
              img.style.display = 'none';
              done.style.display = 'block';
              setStatus('Linked successfully.', 'ok');
              if (timer) { clearInterval(timer); timer = null; }
              return;
            }
            if (s.disabled) {
              setStatus('WhatsApp client is disabled on this server (WHATSAPP_CLIENT_DISABLED=1).', 'err');
              return;
            }
            if (!s.lastQrAt) {
              img.style.display = 'none';
              setStatus('Waiting for WhatsApp to issue a code — this takes a few seconds after startup.', 'hint');
              return;
            }
            if (s.lastQrAt !== shownQrAt) show(s.lastQrAt);
            tick();
          })
          .catch(function () {
            setStatus('Cannot reach the server — retrying...', 'err');
          });
      };

      poll();
      timer = setInterval(poll, POLL_MS);
      setInterval(tick, 1000);
    })();
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
// Read-only report access, which no write-path audit hook can see.
app.use(reportViewLog);

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

// Initialize the WhatsApp client when either notification feature is active:
// the SKU rate-change group notifier, or the per-person payment notifier
// (enabled by default unless WHATSAPP_PAYMENT_NOTIFY_ENABLED=0).
if (
  process.env.WHATSAPP_RATE_NOTIFY_CHAT_ID ||
  process.env.WHATSAPP_PAYMENT_NOTIFY_ENABLED !== "0"
) {
  initWhatsApp();
}

// Payment notifications that could not be delivered (WhatsApp down, transport
// error) are queued in the DB. Sweep them periodically — which also picks up
// anything left queued by a previous run — and flush immediately on reconnect.
if (process.env.WHATSAPP_PAYMENT_NOTIFY_ENABLED !== "0") {
  startWhatsAppRetryWorker({ knex });
  // On (re)connect, drain the whole backlog immediately — ignore each row's
  // backoff so a long outage's queue isn't left waiting hours once WhatsApp is
  // back. The periodic worker (above) still handles the steady-state schedule.
  onWhatsAppReady(() =>
    retryQueuedWhatsAppNotifications({ knex, ignoreBackoff: true }).catch((err) =>
      console.error("[WhatsApp] retry-on-ready failed:", err?.message || err),
    ),
  );
}

// Graceful shutdown. Without this, `systemctl restart`/stop sends SIGTERM, but
// the WhatsApp Puppeteer/Chrome child keeps the event loop alive, so systemd's
// stop times out and SIGKILLs the process — orphaning Chrome, which locks the
// WhatsApp session profile so the NEXT start hangs and never reaches "ready"
// (every payment/rate message then queues forever). Tearing everything down
// here lets the process exit well within systemd's TimeoutStopSec.
let shuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — shutting down...`);

  // Hard cap: exit even if a teardown step hangs, so systemd never has to SIGKILL.
  const forceExit = setTimeout(() => {
    console.error("[shutdown] teardown timed out — forcing exit");
    process.exit(1);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000));
  forceExit.unref();

  try {
    stopWhatsAppRetryWorker();
    await new Promise((resolve) => server.close(resolve));
    await shutdownWhatsApp();
    await knex.destroy();
    clearTimeout(forceExit);
    console.log("[shutdown] clean exit");
    process.exit(0);
  } catch (err) {
    console.error("[shutdown] error during shutdown:", err?.message || err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
