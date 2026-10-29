"use strict";

const knex = require("../../db/knex");
const { toIdListWithAll } = require("../../utils/report-branch-scope");
const { localizedNameSelect, localizedNameSql } = require("../../utils/localized-name");

// Supplier Type is the supplier's maintained Party Group, not the obsolete
// vendor_capabilities array. Keep its IDs separate from raw-material groups.
const resolveSupplierGroupFilter = async ({ req, input = {} }) => {
  try {
    const locale = req?.locale || "en";
    const supplierGroups = await knex("erp.party_groups as pg")
      .select("pg.id", localizedNameSelect("pg", "name", locale))
      .where("pg.is_active", true)
      .whereIn("pg.party_type", ["SUPPLIER", "BOTH"])
      .orderByRaw(`${localizedNameSql("pg", locale)} asc`);

    const source = input.supplier_group_ids;
    const raw = Array.isArray(source) ? source : [source];
    const invalidShape = raw.some((value) => value != null &&
      typeof value !== "string" && typeof value !== "number");
    const tokens = invalidShape ? [] : raw
      .flatMap((value) => String(value ?? "").split(","))
      .map((value) => value.trim()).filter(Boolean);
    const hasAll = tokens.some((value) => ["ALL", "__ALL__"].includes(value.toUpperCase()));
    const invalidId = !hasAll && tokens.some((value) =>
      !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)));
    const selectedIds = invalidShape || invalidId ? [] : toIdListWithAll(tokens);
    const availableIds = new Set(supplierGroups.map((group) => Number(group.id)));
    const invalidSupplierGroupFilter = invalidShape || invalidId ||
      selectedIds.some((id) => !availableIds.has(id));

    return {
      supplierGroups,
      filters: {
        supplierGroupIds: selectedIds.filter((id) => availableIds.has(id)),
        invalidSupplierGroupFilter,
      },
    };
  } catch (err) {
    console.error("Error in SupplierReportFilterService:", err);
    throw err;
  }
};

const applySupplierGroupFilter = (query, filters) => {
  if (filters.invalidSupplierGroupFilter) return query.whereRaw("FALSE");
  if (!filters.supplierGroupIds?.length) return query;
  return query.whereIn("p.group_id", filters.supplierGroupIds)
    .whereIn("p.party_type", ["SUPPLIER", "BOTH"]);
};

module.exports = { resolveSupplierGroupFilter, applySupplierGroupFilter };
