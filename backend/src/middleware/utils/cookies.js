const parseCookies = (req) => {
  const header = req.headers.cookie || "";
  return header.split(";").reduce((acc, part) => {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) return acc;
    const key = decodeURIComponent(rawKey);
    const value = decodeURIComponent(rawValue.join("=") || "");
    acc[key] = value;
    return acc;
  }, {});
};

const setCookie = (res, name, value, options = {}) => {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  const header = res.getHeader("Set-Cookie");
  if (!header) {
    res.setHeader("Set-Cookie", parts.join("; "));
    return;
  }

  const existing = Array.isArray(header) ? header : [header];
  res.setHeader("Set-Cookie", [...existing, parts.join("; ")]);
};

module.exports = {
  parseCookies,
  setCookie,
};
