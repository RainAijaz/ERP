const hasLogTable = async (db) => {
  const row = await db.raw("SELECT to_regclass('erp.bom_change_log') AS reg");
  const value = row?.rows?.[0]?.reg || row?.[0]?.reg || null;
  return Boolean(value);
};

const valueChanged = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

const keysBySection = {
  rm_lines: (row) => `${row.rm_item_id || 0}:${row.dept_id || 0}:${row.color_id || 0}:${row.size_id || 0}`,
  sfg_lines: (row) => `${row.fg_size_id || 0}:${row.sfg_sku_id || 0}`,
  labour_lines: (row) => `${row.dept_id || 0}:${row.labour_id || 0}:${row.size_scope || "ALL"}:${row.size_id || 0}:${row.rate_type || "PER_PAIR"}`,
  variant_rules: (row) =>
    `${row.size_scope || "ALL"}:${row.size_id || 0}:${row.packing_scope || "ALL"}:${row.packing_type_id || 0}:${row.color_scope || "ALL"}:${row.color_id || 0}:${row.action_type || ""}:${row.material_scope || "ALL"}:${row.target_rm_item_id || 0}`,
};

const buildChangeRows = ({ bomId, versionNo, requestId, changedBy, section, beforeRows, afterRows }) => {
  const keyFn = keysBySection[section];
  if (!keyFn) return [];

  const beforeMap = new Map((beforeRows || []).map((row) => [keyFn(row), row]));
  const afterMap = new Map((afterRows || []).map((row) => [keyFn(row), row]));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const rows = [];

  keys.forEach((entityKey) => {
    const before = beforeMap.get(entityKey) || null;
    const after = afterMap.get(entityKey) || null;
    if (before && !after) {
      rows.push({
        bom_id: bomId,
        version_no: versionNo,
        request_id: requestId || null,
        section,
        entity_key: entityKey,
        change_type: "REMOVED",
        old_value: before,
        new_value: null,
        changed_by: changedBy || null,
      });
      return;
    }
    if (!before && after) {
      rows.push({
        bom_id: bomId,
        version_no: versionNo,
        request_id: requestId || null,
        section,
        entity_key: entityKey,
        change_type: "ADDED",
        old_value: null,
        new_value: after,
        changed_by: changedBy || null,
      });
      return;
    }
    if (before && after && valueChanged(before, after)) {
      rows.push({
        bom_id: bomId,
        version_no: versionNo,
        request_id: requestId || null,
        section,
        entity_key: entityKey,
        change_type: "UPDATED",
        old_value: before,
        new_value: after,
        changed_by: changedBy || null,
      });
    }
  });

  return rows;
};

const insertBomChangeLog = async (db, { bomId, versionNo, requestId, changedBy, before, after }) => {
  if (!db || !bomId || !versionNo) return;
  if (!(await hasLogTable(db))) return;

  const rows = [];

  if (before && after) {
    const headerBefore = before.header || null;
    const headerAfter = after.header || null;
    if (valueChanged(headerBefore, headerAfter)) {
      rows.push({
        bom_id: bomId,
        version_no: versionNo,
        request_id: requestId || null,
        section: "header",
        entity_key: "header",
        change_type: headerBefore ? "UPDATED" : "ADDED",
        old_value: headerBefore,
        new_value: headerAfter,
        changed_by: changedBy || null,
      });
    }
  }

  rows.push(
    ...buildChangeRows({
      bomId,
      versionNo,
      requestId,
      changedBy,
      section: "rm_lines",
      beforeRows: before?.rm_lines || [],
      afterRows: after?.rm_lines || [],
    }),
    ...buildChangeRows({
      bomId,
      versionNo,
      requestId,
      changedBy,
      section: "sfg_lines",
      beforeRows: before?.sfg_lines || [],
      afterRows: after?.sfg_lines || [],
    }),
    ...buildChangeRows({
      bomId,
      versionNo,
      requestId,
      changedBy,
      section: "labour_lines",
      beforeRows: before?.labour_lines || [],
      afterRows: after?.labour_lines || [],
    }),
    ...buildChangeRows({
      bomId,
      versionNo,
      requestId,
      changedBy,
      section: "variant_rules",
      beforeRows: before?.variant_rules || [],
      afterRows: after?.variant_rules || [],
    }),
  );

  if (!rows.length) return;
  await db("erp.bom_change_log").insert(rows);
};

module.exports = {
  insertBomChangeLog,
};
