const path = require("path");
const express = require("express");
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
const notFound = require("./middleware/errors/not-found");
const errorHandler = require("./middleware/errors/error-handler");
const knex = require("./db/knex");
const { navConfig, syncNavScopes } = require("./utils/nav-config");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

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

app.use("/", uiRoutes);

app.use(notFound);
app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

syncNavScopes(knex).catch((err) => {
  console.error("Failed to sync nav permission scopes:", err.message || err);
});
