const SYSTEM_KEYS = new Set(["created_at", "created_by", "updated_at", "updated_by"]);

const safeJson = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
};

const inferAction = (request) => {
  if (request?.new_value?._action) {
    if (request.new_value._action === "toggle") return "delete";
    return request.new_value._action === "update" ? "update" : request.new_value._action;
  }
  if (request?.new_value && request?.entity_id === "NEW") return "create";
  if (!request?.new_value && request?.old_value) return "delete";
  return "update";
};

const getEditableKeys = (request) => {
  const action = inferAction(request);
  if (action === "delete") return [];
  const current = safeJson(request?.new_value);
  if (!current || typeof current !== "object" || Array.isArray(current)) return [];
  return Object.keys(current).filter((key) => !key.startsWith("_") && !SYSTEM_KEYS.has(key));
};

const parseEditedPayload = (raw) => {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    return {};
  }
};

const sanitizeEditedValues = (request, submitted) => {
  const action = inferAction(request);
  if (action === "delete") {
    return { error: "approval_edit_delete_not_allowed" };
  }

  const current = safeJson(request?.new_value);
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return { error: "approval_edit_invalid_payload" };
  }

  const editableKeys = getEditableKeys(request);
  if (!editableKeys.length) {
    return { error: "approval_edit_no_fields" };
  }

  const nextValue = { ...current };
  const changedFields = [];

  editableKeys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(submitted, key)) return;
    const next = submitted[key];
    const prev = current[key];
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    nextValue[key] = next;
    changedFields.push({ field: key, old_value: prev ?? null, new_value: next ?? null });
  });

  return {
    action,
    nextValue,
    changedFields,
    editableKeys,
  };
};

module.exports = {
  safeJson,
  inferAction,
  getEditableKeys,
  parseEditedPayload,
  sanitizeEditedValues,
};
