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
  // Voucher approval requests store the intended action in new_value.action (without underscore prefix).
  const payloadAction = String(request?.new_value?.action || "").trim().toLowerCase();
  if (payloadAction === "create" || payloadAction === "update" || payloadAction === "delete") {
    return payloadAction;
  }
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

const getRateRows = (request) => {
  const payload = safeJson(request?.new_value);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (Array.isArray(payload.variants)) {
    return { key: "variants", idKey: "id", rows: payload.variants };
  }
  if (Array.isArray(payload.rows)) {
    return { key: "rows", idKey: "sku_id", rows: payload.rows };
  }
  return null;
};

const sanitizeRateRowSelection = (request, submitted, current) => {
  const rateRows = getRateRows(request);
  if (!rateRows) return null;

  const submittedIds = submitted.selected_row_ids;
  if (!Object.prototype.hasOwnProperty.call(submitted, "selected_row_ids")) {
    return null;
  }
  if (!Array.isArray(submittedIds) || !submittedIds.length) {
    return { error: "approval_edit_empty_rate_selection" };
  }

  const selectedIds = submittedIds.map((id) => Number(id));
  if (selectedIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { error: "approval_edit_invalid_rate_selection" };
  }
  const uniqueIds = [...new Set(selectedIds)];
  const originalIds = new Set(
    rateRows.rows.map((row) => Number(row?.[rateRows.idKey])).filter((id) => id > 0),
  );
  if (uniqueIds.some((id) => !originalIds.has(id))) {
    return { error: "approval_edit_invalid_rate_selection" };
  }

  const nextRows = rateRows.rows.filter((row) =>
    uniqueIds.includes(Number(row?.[rateRows.idKey])),
  );
  if (!nextRows.length) return { error: "approval_edit_empty_rate_selection" };

  const changedFields = [];
  if (nextRows.length !== rateRows.rows.length) {
    changedFields.push({
      field: rateRows.key,
      old_value: rateRows.rows,
      new_value: nextRows,
    });
  }
  const nextValue = { ...current, [rateRows.key]: nextRows };
  delete nextValue.selected_row_ids;
  return { nextValue, changedFields, selectedIds: uniqueIds };
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

  const rateSelection = sanitizeRateRowSelection(request, submitted, current);
  if (rateSelection?.error) return rateSelection;
  if (rateSelection) {
    nextValue[rateSelection.key] = rateSelection.nextValue[rateSelection.key];
    changedFields.push(...rateSelection.changedFields);
  }

  editableKeys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(submitted, key)) return;
    const next = submitted[key];
    const prev = current[key];
    if (key === "variants" || key === "rows") return;
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
  getRateRows,
  sanitizeRateRowSelection,
  sanitizeEditedValues,
};
