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
  normalizeDateOnly,
};

// Shared date validation, preserving the payroll date normalizer's existing
// null (not supplied) versus undefined (invalid) contract.
function normalizeDateOnly(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return undefined;
    return raw;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

