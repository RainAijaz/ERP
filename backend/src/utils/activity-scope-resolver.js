const { navConfig } = require("./nav-config");

const SUPPORTED_SCOPE_TYPES = new Set(["SCREEN", "REPORT", "VOUCHER"]);

const toText = (value) =>
  value == null ? "" : String(value).trim().toLowerCase();

const normalizePath = (value) => {
  const text = toText(value);
  if (!text) return "";

  let pathname = text;
  try {
    if (pathname.startsWith("http://") || pathname.startsWith("https://")) {
      pathname = new URL(pathname).pathname || "";
    }
  } catch (_err) {
    pathname = text;
  }

  const withoutQuery = pathname.split("?")[0].split("#")[0];
  const withLeadingSlash = withoutQuery.startsWith("/")
    ? withoutQuery
    : `/${withoutQuery}`;
  if (withLeadingSlash === "/") return withLeadingSlash;
  return withLeadingSlash.replace(/\/+$/, "");
};

const pathMatchesPrefix = (path, prefix) => {
  if (!path || !prefix) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
};

const collectScopeItems = (nodes, items = []) => {
  if (!Array.isArray(nodes)) return items;
  nodes.forEach((node) => {
    if (!node || typeof node !== "object") return;
    const scopeType = String(node.scopeType || "").toUpperCase();
    const scopeKey = String(node.scopeKey || "").trim();
    if (SUPPORTED_SCOPE_TYPES.has(scopeType) && scopeKey) {
      items.push({
        scopeType,
        scopeKey,
        labelKey: node.labelKey || null,
        route: normalizePath(node.route),
      });
    }
    if (Array.isArray(node.children) && node.children.length) {
      collectScopeItems(node.children, items);
    }
  });
  return items;
};

const SCOPE_ITEMS = collectScopeItems(navConfig);

const SCOPE_META_BY_KEY = new Map();
SCOPE_ITEMS.forEach((item) => {
  const key = `${item.scopeType}:${item.scopeKey.toUpperCase()}`;
  SCOPE_META_BY_KEY.set(key, item);
});

const ROUTE_SCOPES = SCOPE_ITEMS.filter((item) => item.route).sort(
  (a, b) => b.route.length - a.route.length,
);

const resolveScopeMetaByKey = ({ scopeType, scopeKey }) => {
  const normalizedScopeType = String(scopeType || "").toUpperCase();
  const normalizedScopeKey = String(scopeKey || "")
    .trim()
    .toUpperCase();
  if (!normalizedScopeType || !normalizedScopeKey) return null;
  return (
    SCOPE_META_BY_KEY.get(`${normalizedScopeType}:${normalizedScopeKey}`) ||
    null
  );
};

const resolveScopeMetaByPath = (path) => {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return null;
  return (
    ROUTE_SCOPES.find((item) =>
      pathMatchesPrefix(normalizedPath, item.route),
    ) || null
  );
};

module.exports = {
  SCOPE_ITEMS,
  normalizePath,
  pathMatchesPrefix,
  resolveScopeMetaByKey,
  resolveScopeMetaByPath,
};
