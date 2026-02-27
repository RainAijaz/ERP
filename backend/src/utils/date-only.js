"use strict";

const YMD_PREFIX_REGEX = /^(\d{4}-\d{2}-\d{2})/;

const toLocalDateOnly = (value) => {
  if (!value) return "";
  const text = String(value).trim();
  const match = text.match(YMD_PREFIX_REGEX);
  if (match) return match[1];

  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";

  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const toLocalDateOnlyOrRaw = (value) => {
  const normalized = toLocalDateOnly(value);
  if (normalized) return normalized;
  const raw = String(value || "").trim();
  return raw;
};

module.exports = {
  toLocalDateOnly,
  toLocalDateOnlyOrRaw,
};

