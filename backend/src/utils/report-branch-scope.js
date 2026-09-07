"use strict";

const {
  canAccessScope,
} = require("../middleware/access/role-permissions");

const ALL_MULTI_FILTER_VALUE = "__ALL__";

const toPositiveInt = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseList = (value) => {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : [value];
  return raw
    .flatMap((entry) => String(entry == null ? "" : entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const toIdListWithAll = (value) => {
  const tokens = parseList(value);
  const hasAll = tokens.some((entry) => {
    const normalized = String(entry || "").trim().toUpperCase();
    return (
      normalized === String(ALL_MULTI_FILTER_VALUE).toUpperCase() ||
      normalized === "ALL"
    );
  });
  if (hasAll) return [];
  return [
    ...new Set(
      tokens.map(toPositiveInt).filter((entry) => Number.isInteger(entry)),
    ),
  ];
};

const reportCanFilterAllBranches = (req, scopeKey) => {
  if (req?.user?.isAdmin) return true;
  if (!scopeKey) return false;
  return Boolean(canAccessScope(req, "REPORT", scopeKey, "filter_all_branches"));
};

const getReportAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];

  const fromBranchOptions = Array.isArray(req?.branchOptions)
    ? req.branchOptions
        .map((row) => toPositiveInt(row?.id))
        .filter(Boolean)
    : [];
  if (fromBranchOptions.length) return [...new Set(fromBranchOptions)];

  const fromBranchScope = Array.isArray(req?.branchScope)
    ? req.branchScope.map(toPositiveInt).filter(Boolean)
    : [];
  if (fromBranchScope.length) return [...new Set(fromBranchScope)];

  const fallback = toPositiveInt(req?.branchId);
  return fallback ? [fallback] : [];
};

const normalizeReportBranchIds = ({
  req,
  input = {},
  value,
  scopeKey,
  canAllBranches = reportCanFilterAllBranches(req, scopeKey),
}) => {
  const selected = toIdListWithAll(
    typeof value === "undefined" ? input?.branch_ids || input?.branchIds : value,
  );
  if (req?.user?.isAdmin || canAllBranches) return selected;

  const allowed = getReportAllowedBranchIds(req);
  if (!allowed.length) return [];
  if (!selected.length) return allowed;

  const allowedSet = new Set(allowed.map(Number));
  const filtered = selected.filter((id) => allowedSet.has(Number(id)));
  return filtered.length ? filtered : allowed;
};

module.exports = {
  ALL_MULTI_FILTER_VALUE,
  getReportAllowedBranchIds,
  normalizeReportBranchIds,
  reportCanFilterAllBranches,
  toIdListWithAll,
};
