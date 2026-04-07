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
