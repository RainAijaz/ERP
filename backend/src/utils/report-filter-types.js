"use strict";

const REPORT_ORDER_TYPES = Object.freeze({
  party: "party",
  invoice: "invoice",
  product: "product",
});

const REPORT_TYPES = Object.freeze({
  details: "details",
  summary: "summary",
});

const normalizeKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const resolveReportOrderType = (value, fallback = REPORT_ORDER_TYPES.party) => {
  const key = normalizeKey(value);
  if (key === REPORT_ORDER_TYPES.party) return REPORT_ORDER_TYPES.party;
  if (key === REPORT_ORDER_TYPES.invoice) return REPORT_ORDER_TYPES.invoice;
  if (key === REPORT_ORDER_TYPES.product) return REPORT_ORDER_TYPES.product;
  return fallback;
};

const resolveReportType = (value, fallback = REPORT_TYPES.details) => {
  const key = normalizeKey(value);
  if (key === REPORT_TYPES.summary) return REPORT_TYPES.summary;
  if (key === REPORT_TYPES.details) return REPORT_TYPES.details;
  return fallback;
};

const toRawList = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [value];
};

const toIdList = (value) => {
  const raw = toRawList(value);
  return [
    ...new Set(
      raw
        .flatMap((entry) => String(entry == null ? "" : entry).split(","))
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    ),
  ];
};

const toBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const key = normalizeKey(value);
  if (!key) return fallback;
  return key === "1" || key === "true" || key === "yes" || key === "on";
};

module.exports = {
  REPORT_ORDER_TYPES,
  REPORT_TYPES,
  resolveReportOrderType,
  resolveReportType,
  toIdList,
  toBoolean,
};
