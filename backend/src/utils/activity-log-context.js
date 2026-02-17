const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 40;
const MAX_STRING_LENGTH = 400;
const OMIT_KEYS = new Set(["_csrf", "password", "password_hash", "token", "secret", "secret_enc"]);

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
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeForAudit(entry, depth + 1));
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

const buildAuditContext = (req, context) => {
  const base = {
    source: "http",
    method: req.method,
    path: req.originalUrl || req.path,
    status_code: req.res?.statusCode || null,
    query: sanitizeForAudit(req.query || {}),
  };

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
