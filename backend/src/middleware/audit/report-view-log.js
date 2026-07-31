// Records WHO opened or ran WHICH report, for every user (admin and non-admin).
//
// Reports are read-only, so nothing in the write path ever produced an
// activity_log row for them: the audit screen could show that a rate was
// changed but not that someone pulled the whole customer ledger. This
// middleware closes that gap centrally instead of touching ~50 report routes.
//
// A report screen is recognised three ways, in priority order:
//   1. `markReportView(req, scopeKey)` -- an explicit declaration by a route
//      that resolves its report at runtime. Financial serves 15 report keys
//      off one `/:reportKey` route and enforces permissions in the handler,
//      so neither automatic signal below can see six of them.
//   2. `req.requiredPermission` with scopeType REPORT -- set by
//      requirePermission("REPORT", ...) on most report routes.
//   3. An exact path match against a REPORT entry in nav-config -- covers the
//      remaining routes that check permissions inside the handler
//      (returnables vendor performance).
//
// The match must be EXACT for (3): sub-paths of a report route are not report
// views. `/reports/financial/voucher_register/bank-line-status`, for instance,
// is a write endpoint that happens to live under the voucher-register report.
//
// GET = the screen was opened, POST = it was run with filters. Both are logged
// because "who loaded this report with which filters" is the interesting
// question; the filters are kept in context_json.

const knex = require("../../db/knex");
const { insertActivityLog } = require("../../utils/audit-log");
const { sanitizeForAudit } = require("../../utils/activity-log-context");
const {
  normalizePath,
  resolveScopeMetaByKey,
  resolveScopeMetaByPath,
} = require("../../utils/activity-scope-resolver");

const REPORT_ENTITY_TYPE = "REPORT";
const VIEW_ACTION = "VIEW";

// Collapses accidental duplicates (double-click, a browser re-issuing the
// request) without hiding a genuine re-run: the same user re-running the same
// report with the same filters after the window still gets its own row.
const DEDUPE_WINDOW_MS = (() => {
  const configured = String(
    process.env.ACTIVITY_REPORT_VIEW_DEDUPE_MS ?? "",
  ).trim();
  // An empty/unset value means "use the default"; only an explicit 0 disables.
  if (!configured) return 10000;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10000;
})();

const DISABLED = process.env.ACTIVITY_REPORT_VIEW_LOG_DISABLED === "1";

// Request plumbing, not report filters.
const FILTER_NOISE_KEYS = new Set([
  "_csrf",
  "csrf_token",
  "page",
  "page_size",
  "pagesize",
  "sort",
  "_",
]);

const recentViews = new Map();
const RECENT_VIEWS_PRUNE_AT = 500;
const RECENT_VIEWS_HARD_CAP = 5000;

const pruneRecentViews = (now) => {
  if (recentViews.size < RECENT_VIEWS_PRUNE_AT) return;
  recentViews.forEach((seenAt, key) => {
    if (now - seenAt > DEDUPE_WINDOW_MS) recentViews.delete(key);
  });
  // Nothing expired and the map is still enormous: a long dedupe window plus
  // heavy traffic. Drop the whole thing rather than grow without bound -- the
  // only cost is that a few duplicate views slip through.
  if (recentViews.size >= RECENT_VIEWS_HARD_CAP) recentViews.clear();
};

const isDuplicateView = (key, now) => {
  if (!DEDUPE_WINDOW_MS) return false;
  const seenAt = recentViews.get(key);
  if (seenAt && now - seenAt <= DEDUPE_WINDOW_MS) return true;
  pruneRecentViews(now);
  recentViews.set(key, now);
  return false;
};

const parseRequiredPermission = (required) => {
  if (!required) return null;
  if (typeof required === "string") {
    const [scopeType, scopeKey] = String(required).split(":");
    if (!scopeType || !scopeKey) return null;
    return { scopeType: scopeType.trim().toUpperCase(), scopeKey: scopeKey.trim() };
  }
  if (typeof required !== "object") return null;
  const scopeType = String(required.scopeType || "").trim().toUpperCase();
  const scopeKey = String(required.scopeKey || "").trim();
  if (!scopeType || !scopeKey) return null;
  return { scopeType, scopeKey };
};

/**
 * Declare that this request rendered a report, for routes the automatic
 * signals cannot see. Call it only once the permission check has PASSED --
 * a 403 is not a view.
 */
const markReportView = (req, scopeKey) => {
  const key = String(scopeKey || "").trim();
  if (!req || !key) return;
  req.reportViewScopeKey = key;
};

// A report route may guard on one scope key while the nav entry the user
// actually clicked carries another (e.g. the inventory index guards on
// stock_quantity then redirects). Redirects are filtered out by the caller, so
// what is left is the scope the rendered page belongs to.
const resolveReportScope = (req) => {
  const declared = String(req.reportViewScopeKey || "").trim();
  if (declared) {
    const meta = resolveScopeMetaByKey({
      scopeType: "REPORT",
      scopeKey: declared,
    });
    return {
      scopeKey: declared,
      labelKey: meta?.labelKey || null,
      route: meta?.route || null,
    };
  }

  const required = parseRequiredPermission(req.requiredPermission);
  if (required?.scopeType === "REPORT") {
    const meta = resolveScopeMetaByKey({
      scopeType: "REPORT",
      scopeKey: required.scopeKey,
    });
    return {
      scopeKey: required.scopeKey,
      labelKey: meta?.labelKey || null,
      route: meta?.route || null,
    };
  }

  const path = normalizePath(req.originalUrl || req.path);
  const meta = resolveScopeMetaByPath(path);
  if (!meta || meta.scopeType !== "REPORT") return null;
  if (meta.route !== path) return null; // sub-paths are not the report itself
  return { scopeKey: meta.scopeKey, labelKey: meta.labelKey, route: meta.route };
};

const collectFilters = (req) => {
  const source = req.method === "GET" ? req.query : req.body;
  if (!source || typeof source !== "object") return {};
  const filters = {};
  Object.entries(source).forEach(([key, value]) => {
    if (FILTER_NOISE_KEYS.has(String(key).toLowerCase())) return;
    if (value === null || typeof value === "undefined" || value === "") return;
    filters[key] = value;
  });
  return sanitizeForAudit(filters) || {};
};

// Logged once: a missing registry row (migration not run yet) would otherwise
// print a stack trace on every single report load.
let registryWarningLogged = false;

const logReportView = async (req, res) => {
  const scope = resolveReportScope(req);
  if (!scope?.scopeKey) return;

  const filters = collectFilters(req);
  const now = Date.now();
  const dedupeKey = [
    req.user.id,
    req.method,
    scope.scopeKey,
    JSON.stringify(filters),
  ].join("|");
  if (isDuplicateView(dedupeKey, now)) return;

  try {
    await insertActivityLog(knex, {
      branch_id: req.branchId || null,
      user_id: req.user.id,
      entity_type: REPORT_ENTITY_TYPE,
      entity_id: scope.scopeKey,
      action: VIEW_ACTION,
      ip_address: req.ip,
      context: {
        source: "report-view",
        scope_type: "REPORT",
        scope_key: scope.scopeKey,
        // The label key, not a translated string: the reader's own locale is
        // applied when the row is presented.
        report_label_key: scope.labelKey || null,
        // GET = opened from the menu, POST = re-run from the filter panel.
        access_mode: req.method === "GET" ? "open" : "load",
        method: req.method,
        path: req.originalUrl || req.path,
        status_code: res.statusCode,
        filters,
      },
    });
  } catch (err) {
    const code = String(err?.code || "");
    if (code === "23503" && !registryWarningLogged) {
      registryWarningLogged = true;
      console.error(
        "Report view logging is inactive: run `npm run migrate` to seed the REPORT/VIEW registry codes.",
      );
      return;
    }
    if (code !== "23503") {
      console.error("Report view log error", err);
    }
  }
};

const reportViewLog = (req, res, next) => {
  if (DISABLED) return next();
  if (req.method !== "GET" && req.method !== "POST") return next();

  res.on("finish", () => {
    // Only settled, successful renders count as a view. Redirects (the legacy
    // /reports/... landing routes) would otherwise double-log alongside the
    // page they redirect to, and errors are not views at all.
    if (!req.user) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    logReportView(req, res).catch((err) =>
      console.error("Report view log error", err),
    );
  });

  next();
};

module.exports = reportViewLog;
module.exports.markReportView = markReportView;
// Exported for tests: which requests count as a report view is the whole
// contract of this middleware, and it is worth asserting directly.
module.exports.resolveReportScope = resolveReportScope;
module.exports.collectFilters = collectFilters;
