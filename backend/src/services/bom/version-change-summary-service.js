const bomService = require("./service");
const { keysBySection } = require("../../utils/bom-change-log");

const sectionFields = {
  rm_lines: ["qty", "uom_id", "normal_loss_pct"],
  sfg_lines: ["required_qty", "uom_id", "consumed_in_stage_id", "ref_approved_bom_id"],
  labour_lines: ["rate_value"],
  stage_routes: ["sequence_no", "is_required", "enforce_sequence"],
  sku_overrides: ["is_excluded", "override_qty", "override_uom_id", "replacement_rm_item_id", "rm_color_id", "rm_size_id", "notes"],
};

const sameValue = (left, right) => {
  if (left == null && right == null) return true;
  if (typeof left === "number" || typeof right === "number") {
    return left !== null && right !== null && Number(left) === Number(right);
  }
  return left === right;
};

const collectIds = (snapshots) => {
  const ids = { item: new Set(), uom: new Set(), dept: new Set(), size: new Set(), color: new Set(), stage: new Set(), sku: new Set(), labour: new Set(), bom: new Set() };
  const fields = {
    item: ["item_id", "rm_item_id", "target_rm_item_id", "replacement_rm_item_id"],
    uom: ["output_uom_id", "uom_id", "override_uom_id"],
    dept: ["dept_id"], size: ["size_id", "fg_size_id", "rm_size_id"],
    color: ["color_id", "rm_color_id"], stage: ["stage_id", "consumed_in_stage_id"],
    sku: ["sku_id", "sfg_sku_id"], labour: ["labour_id"], bom: ["ref_approved_bom_id"],
  };
  snapshots.forEach((snapshot) => {
    [snapshot.header, ...Object.keys(sectionFields).flatMap((section) => snapshot[section] || [])].forEach((row) => {
      if (!row) return;
      Object.entries(fields).forEach(([type, names]) => names.forEach((name) => {
        const id = Number(row[name]);
        if (Number.isSafeInteger(id) && id > 0) ids[type].add(id);
      }));
    });
  });
  return ids;
};

const loadNames = async (knex, snapshots, locale) => {
  const ids = collectIds(snapshots);
  const sources = {
    item: ["erp.items", "name"], uom: ["erp.uom", "name"],
    dept: ["erp.departments", "name"], size: ["erp.sizes", "name"],
    color: ["erp.colors", "name"], stage: ["erp.production_stages", "name"],
    sku: ["erp.skus", "sku_code"], labour: ["erp.labours", "name"],
    bom: ["erp.bom_header", "bom_no"],
  };
  const entries = await Promise.all(Object.entries(sources).map(async ([type, [table, column]]) => {
    const localizable = column === "name";
    const rows = ids[type].size
      ? await knex(table)
          .select("id", locale === "ur" && localizable
            ? knex.raw("COALESCE(NULLIF(name_ur, ''), name) as display_name")
            : `${column} as display_name`)
          .whereIn("id", [...ids[type]])
      : [];
    return [type, new Map(rows.map((row) => [Number(row.id), row.display_name]))];
  }));
  return Object.fromEntries(entries);
};

const formatValue = (field, value, names, t) => {
  if (value === null || value === undefined || value === "") return t("bom_summary_none");
  const type = {
    item_id: "item", rm_item_id: "item", target_rm_item_id: "item", replacement_rm_item_id: "item",
    output_uom_id: "uom", uom_id: "uom", override_uom_id: "uom", dept_id: "dept",
    size_id: "size", fg_size_id: "size", rm_size_id: "size", color_id: "color", rm_color_id: "color",
    stage_id: "stage", consumed_in_stage_id: "stage", sku_id: "sku", sfg_sku_id: "sku",
    labour_id: "labour", ref_approved_bom_id: "bom",
  }[field];
  if (type) return names[type].get(Number(value)) || `#${value}`;
  if (typeof value === "boolean") return t(value ? "yes" : "no");
  if (field === "rate_type") return t(value === "PER_DOZEN" ? "bom_summary_per_dozen" : "bom_summary_per_pair");
  return String(value);
};

const rowLabel = (section, row, names, t) => {
  const part = (field) => formatValue(field, row[field], names, t);
  if (section === "rm_lines") return `${part("rm_item_id")} / ${part("dept_id")}${row.color_id ? ` / ${part("color_id")}` : ""}${row.size_id ? ` / ${part("size_id")}` : ""}`;
  if (section === "sfg_lines") return `${part("sfg_sku_id")} / ${part("fg_size_id")}`;
  if (section === "labour_lines") return `${part("dept_id")} / ${part("labour_id")} / ${row.size_id ? part("size_id") : t("all")} / ${part("rate_type")}`;
  if (section === "stage_routes") return part("stage_id");
  return `${part("sku_id")} / ${part("target_rm_item_id")} / ${part("dept_id")}`;
};

const renderRow = (section, row, names, t) => sectionFields[section]
  .map((field) => `${t(`bom_summary_field_${field}`)}: ${formatValue(field, row[field], names, t)}`)
  .join("; ");

const compareSnapshots = (before, after, names, t) => {
  const changes = [];
  for (const field of ["item_id", "level", "output_qty", "output_uom_id"]) {
    if (!sameValue(before.header[field], after.header[field])) changes.push({
      text: `${t("bom_summary_changed")} ${t(`bom_summary_field_${field}`)}`,
      before: formatValue(field, before.header[field], names, t),
      after: formatValue(field, after.header[field], names, t),
    });
  }
  for (const section of Object.keys(sectionFields)) {
    const key = keysBySection[section];
    const oldRows = new Map((before[section] || []).map((row) => [key(row), row]));
    const newRows = new Map((after[section] || []).map((row) => [key(row), row]));
    for (const identity of new Set([...oldRows.keys(), ...newRows.keys()])) {
      const oldRow = oldRows.get(identity);
      const newRow = newRows.get(identity);
      const label = rowLabel(section, newRow || oldRow, names, t);
      const sectionLabel = t(`bom_summary_section_${section}`);
      if (!oldRow || !newRow) {
        changes.push({
          text: `${t(oldRow ? "bom_summary_removed" : "bom_summary_added")} ${sectionLabel}: ${label}`,
          before: oldRow ? renderRow(section, oldRow, names, t) : t("bom_summary_none"),
          after: newRow ? renderRow(section, newRow, names, t) : t("bom_summary_none"),
        });
        continue;
      }
      for (const field of sectionFields[section]) {
        if (sameValue(oldRow[field], newRow[field])) continue;
        changes.push({
          text: `${t("bom_summary_changed")} ${t(`bom_summary_field_${field}`)} — ${sectionLabel}: ${label}`,
          before: formatValue(field, oldRow[field], names, t),
          after: formatValue(field, newRow[field], names, t),
        });
      }
    }
  }
  return changes;
};

const buildVersionChangeSummary = async (knex, { bomId, snapshot, t, locale = "en" }) => {
  if (!bomId || !snapshot) return null;
  const after = bomService.buildApprovalSnapshot(snapshot);
  const header = await knex("erp.bom_header").select("id", "item_id", "level", "version_no", "bom_no")
    .where({ id: bomId }).first();
  if (!header || Number(header.version_no) <= 1) return null;
  const predecessor = await knex("erp.bom_header")
    .select("id", "version_no", "bom_no")
    .where({ item_id: header.item_id, level: header.level, status: "APPROVED" })
    .andWhere("version_no", "<", header.version_no)
    .orderBy("version_no", "desc").first();
  if (!predecessor) return null;
  const previousSnapshot = await bomService.getBomSnapshot(knex, predecessor.id);
  if (!previousSnapshot) return null;
  const before = bomService.buildApprovalSnapshot(previousSnapshot);
  const names = await loadNames(knex, [before, after], locale);
  return {
    previous: predecessor,
    current: header,
    changes: compareSnapshots(before, after, names, t),
  };
};

module.exports = { buildVersionChangeSummary, compareSnapshots };
