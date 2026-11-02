"use strict";

const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { toIdListWithAll } = require("../../utils/report-branch-scope");
const { localizedNameSelect } = require("../../utils/localized-name");

const normalizeReportArticleFilters = (input = {}) => {
  const parse = (value) => {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    const tokens = values.flatMap(entry => String(entry).split(",")).map(entry => entry.trim()).filter(Boolean);
    if (tokens.some(token => !["ALL", "__ALL__"].includes(token.toUpperCase()) && (!/^[1-9]\d*$/.test(token) || !Number.isSafeInteger(Number(token))))) {
      throw new HttpError(400, "error_invalid_id");
    }
    return toIdListWithAll(value);
  };
  return { articleIds: parse(input.article_ids ?? input.articleIds), skuIds: parse(input.sku_ids ?? input.skuIds) };
};

const loadReportArticleOptions = async ({ db = knex, locale = "en", itemTypes = ["FG", "SFG", "RM"] } = {}) => {
  try {
    const [articles, skus] = await Promise.all([
      db("erp.items as i").select("i.id", "i.item_type", "i.group_id", "i.subgroup_id", localizedNameSelect("i", "name", locale))
        .whereIn("i.item_type", itemTypes).where("i.is_active", true).orderBy("i.name"),
      db("erp.skus as s").join("erp.variants as v", "v.id", "s.variant_id").join("erp.items as i", "i.id", "v.item_id")
        .select("s.id", "s.sku_code", "i.id as article_id", "i.item_type", "i.group_id", "i.subgroup_id", localizedNameSelect("i", "name", locale))
        .whereIn("i.item_type", itemTypes.filter(type => type !== "RM"))
        .where({ "s.is_active": true, "v.is_active": true, "i.is_active": true }).orderBy("s.sku_code"),
    ]);
    return { articles, skus: skus.map(row => ({ ...row, name: `${row.sku_code} - ${row.name}` })) };
  } catch (err) {
    console.error("Error in ReportArticleFilterService:", err);
    throw err;
  }
};

const applyReportArticleFilters = (query, filters, { articleColumn = "i.id", skuColumn = "s.id" } = {}) => {
  if (filters.articleIds?.length) query.whereIn(articleColumn, filters.articleIds);
  if (filters.skuIds?.length) {
    if (skuColumn) query.whereIn(skuColumn, filters.skuIds);
    else query.whereRaw("false");
  }
  return query;
};

module.exports = { normalizeReportArticleFilters, loadReportArticleOptions, applyReportArticleFilters };
