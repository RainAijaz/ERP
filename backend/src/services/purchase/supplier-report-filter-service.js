"use strict";

const SUPPLIER_TYPES = Object.freeze([
  { value: "MATERIAL", labelKey: "material_vendor" },
  { value: "REPAIR", labelKey: "repair_vendor" },
  { value: "SERVICE", labelKey: "service_vendor" },
]);
const validTypes = new Set(SUPPLIER_TYPES.map((type) => type.value));

const parseSupplierTypes = (value) => {
  const raw = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [value];
  const tokens = [...new Set(raw.flatMap((entry) => String(entry ?? "").split(","))
    .map((entry) => entry.trim().toUpperCase()).filter(Boolean))];
  if (tokens.includes("ALL") || tokens.includes("__ALL__")) return [];
  // Invalid selections must never broaden the report to every supplier.
  return tokens.some((token) => !validTypes.has(token)) ? ["__INVALID__"] : tokens;
};

const applySupplierTypeFilter = (query, types = [], alias = "p") => {
  if (!types.length) return query;
  if (types.some((type) => !validTypes.has(type))) return query.whereRaw("FALSE");
  // A supplier can have several capabilities. Match any selected capability
  // without joining/duplicating its transactions or changing report totals.
  return query.whereRaw("?? && ?::text[]", [`${alias}.vendor_capabilities`, types]);
};

module.exports = { SUPPLIER_TYPES, parseSupplierTypes, applySupplierTypeFilter };
