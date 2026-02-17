const normalizeValue = (value) => {
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        out[key] = normalizeValue(value[key]);
      });
    return out;
  }
  return value;
};

const areEqual = (left, right) => JSON.stringify(normalizeValue(left)) === JSON.stringify(normalizeValue(right));

const buildAuditChangeSet = ({ before = {}, after = {}, includeKeys = null, excludeKeys = [] } = {}) => {
  const exclude = new Set(excludeKeys);
  const keys = includeKeys && includeKeys.length ? includeKeys : Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
  const changedFields = [];
  const oldValues = {};
  const newValues = {};

  keys.forEach((key) => {
    if (exclude.has(key)) return;
    const oldValue = before ? before[key] : undefined;
    const newValue = after ? after[key] : undefined;
    if (areEqual(oldValue, newValue)) return;
    changedFields.push({ field: key, old_value: oldValue ?? null, new_value: newValue ?? null });
    oldValues[key] = oldValue ?? null;
    newValues[key] = newValue ?? null;
  });

  return {
    changed_fields: changedFields,
    changed_field_names: changedFields.map((entry) => entry.field),
    old_values: oldValues,
    new_values: newValues,
  };
};

module.exports = {
  buildAuditChangeSet,
};
