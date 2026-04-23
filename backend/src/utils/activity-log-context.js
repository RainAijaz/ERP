const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 40;
const MAX_STRING_LENGTH = 400;
const OMIT_KEYS = new Set([
  "_csrf",
  "password",
  "password_hash",
  "token",
  "secret",
  "secret_enc",
]);

const trimString = (value) => {
  const text = String(value ?? "");
  if (text.length <= MAX_STRING_LENGTH) return text;
  return `${text.slice(0, MAX_STRING_LENGTH)}...`;
};

const sanitizeForAudit = (value, depth = 0) => {
  if (value == null) return value;
  if (typeof value === "string") return trimString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[max-depth]";

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeForAudit(entry, depth + 1));
  }

  if (typeof value === "object") {
    const output = {};
    Object.keys(value).forEach((key) => {
      if (OMIT_KEYS.has(key.toLowerCase())) return;
      output[key] = sanitizeForAudit(value[key], depth + 1);
    });
    return output;
  }

  return trimString(value);
};

const parseRequiredPermission = (requiredPermission) => {
  if (!requiredPermission) return null;
  if (typeof requiredPermission === "string") {
    const [scopeType, scopeKey] = String(requiredPermission).split(":");
    if (!scopeType || !scopeKey) return null;
    return {
      scopeType: String(scopeType).trim().toUpperCase(),
      scopeKey: String(scopeKey).trim(),
    };
  }
  if (typeof requiredPermission !== "object") return null;
  const scopeType = String(requiredPermission.scopeType || "")
    .trim()
    .toUpperCase();
  const scopeKey = String(requiredPermission.scopeKey || "").trim();
  if (!scopeType || !scopeKey) return null;
  return { scopeType, scopeKey };
};

const buildAuditContext = (req, context) => {
  const required = parseRequiredPermission(req?.requiredPermission);
  const base = {
    source: "http",
    method: req.method,
    path: req.originalUrl || req.path,
    status_code: req.res?.statusCode || null,
    query: sanitizeForAudit(req.query || {}),
  };

  if (required?.scopeType && required?.scopeKey) {
    base.scope_type = required.scopeType;
    base.scope_key = required.scopeKey;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    base.request_body = sanitizeForAudit(req.body || {});
  }

  if (!context || typeof context !== "object") {
    return base;
  }

  return {
    ...base,
    ...sanitizeForAudit(context),
  };
};

module.exports = {
  sanitizeForAudit,
  buildAuditContext,
};
