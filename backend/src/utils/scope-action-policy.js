const ACTION_KEYS = [
  "can_navigate",
  "can_view",
  "can_create",
  "can_edit",
  "can_delete",
  "can_hard_delete",
  "can_print",
  "can_approve",
];

const toUpperScopeType = (scopeType) =>
  String(scopeType || "")
    .trim()
    .toUpperCase();

const toActionKey = (action) => {
  const normalized = String(action || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("can_")) return normalized;
  return `can_${normalized}`;
};

const SCREEN_ACTIONS = new Set(ACTION_KEYS);
const MODULE_ACTIONS = new Set(ACTION_KEYS);
const VOUCHER_ACTIONS = new Set([
  "can_navigate",
  "can_view",
  "can_create",
  "can_edit",
  "can_hard_delete",
  "can_print",
  "can_approve",
]);
const REPORT_ACTIONS = new Set(["can_navigate", "can_view", "can_print"]);

const SCOPE_ACTION_MAP = {
  SCREEN: SCREEN_ACTIONS,
  MODULE: MODULE_ACTIONS,
  VOUCHER: VOUCHER_ACTIONS,
  REPORT: REPORT_ACTIONS,
};

const getApplicableActionSet = (scopeType) =>
  SCOPE_ACTION_MAP[toUpperScopeType(scopeType)] || SCREEN_ACTIONS;

const getApplicableActionKeys = (scopeType) =>
  ACTION_KEYS.filter((action) => getApplicableActionSet(scopeType).has(action));

const isActionApplicable = (scopeType, action) => {
  const actionKey = toActionKey(action);
  if (!actionKey) return false;
  return getApplicableActionSet(scopeType).has(actionKey);
};

const isPermissionMatrixScope = (scopeType) => {
  const key = toUpperScopeType(scopeType);
  return key === "SCREEN" || key === "VOUCHER" || key === "REPORT";
};

module.exports = {
  ACTION_KEYS,
  getApplicableActionSet,
  getApplicableActionKeys,
  isActionApplicable,
  isPermissionMatrixScope,
  toActionKey,
};
