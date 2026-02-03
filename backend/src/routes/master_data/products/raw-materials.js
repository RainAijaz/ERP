const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");

const router = express.Router();
const ITEM_TYPE = "RM";

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

const parseNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? null : numberValue;
};

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object") return Object.values(value);
  return [value];
};

const buildRateRows = ({ itemId, colorIds, sizeIds, rates, userId, now }) => {
  const maxLen = Math.max(colorIds.length, sizeIds.length, rates.length);
  const rows = [];
  const keys = new Set();
  for (let idx = 0; idx < maxLen; idx += 1) {
    const color_id = colorIds[idx] ? Number(colorIds[idx]) : null;
    const size_id = sizeIds[idx] ? Number(sizeIds[idx]) : null;
    const purchase_rate = parseNumber(rates[idx]);
    if (purchase_rate === null) continue;
    const key = `${color_id || 0}:${size_id || 0}`;
    if (keys.has(key)) continue;
    keys.add(key);
    rows.push({
      rm_item_id: itemId,
      color_id: Number.isNaN(color_id) ? null : color_id,
      size_id: Number.isNaN(size_id) ? null : size_id,
      purchase_rate,
      avg_purchase_rate: purchase_rate,
      created_by: userId,
      created_at: now(),
    });
  }
  return rows;
};

const loadOptions = async () => {
  const [subgroups, uoms, colors, sizes] = await Promise.all([
    knex("erp.product_subgroups as sg").select(knex.raw("DISTINCT ON (lower(sg.name)) sg.id, sg.name, sg.name_ur, sg.group_id")).join("erp.product_subgroup_item_types as sgt", "sgt.subgroup_id", "sg.id").where("sgt.item_type", ITEM_TYPE).andWhere("sg.is_active", true).whereNotNull("sg.group_id").orderByRaw("lower(sg.name), sg.id"),
    knex("erp.uom").select("id", "code", "name", "name_ur").where("is_active", true).orderBy("code"),
    knex("erp.colors").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
    knex("erp.sizes as s").select("s.id", "s.name", "s.name_ur").join("erp.size_item_types as sit", "sit.size_id", "s.id").where("sit.item_type", ITEM_TYPE).andWhere("s.is_active", true).orderBy("s.name"),
  ]);
  return { subgroups, uoms, colors, sizes };
};

// --- UPDATED: loadRows with Filter Logic ---
const loadRows = async (filters = {}) => {
  let query = knex("erp.items as i")
    .select(
      "i.*",
      "g.name as group_name",
      "g.name_ur as group_name_ur",
      "sg.name as subgroup_name",
      "sg.name_ur as subgroup_name_ur",
      "u.code as uom_code",
      "u.name as uom_name",
      "u.name_ur as uom_name_ur",
      "cu.username as created_by_name",
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(c.name, 'One Color'), ', ' ORDER BY COALESCE(c.name, 'One Color')), '') as color_names`),
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(c.name_ur, c.name, 'ایک رنگ'), ', ' ORDER BY COALESCE(c.name_ur, c.name, 'ایک رنگ')), '') as color_names_ur`),
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(rs.name, 'One Size'), ', ' ORDER BY COALESCE(rs.name, 'One Size')), '') as size_names`),
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(rs.name_ur, rs.name, 'ایک سائز'), ', ' ORDER BY COALESCE(rs.name_ur, rs.name, 'ایک سائز')), '') as size_names_ur`),
      knex.raw(`COALESCE(string_agg(to_char(r.purchase_rate, 'FM9999999990'), ', ' ORDER BY COALESCE(c.name, 'One Color'), COALESCE(rs.name, 'One Size')), '') as purchase_rates`),
      knex.raw(`COALESCE(string_agg(to_char(r.avg_purchase_rate, 'FM9999999990'), ', ' ORDER BY COALESCE(c.name, 'One Color'), COALESCE(rs.name, 'One Size')), '') as avg_purchase_rates`),
      knex.raw(`COALESCE(string_agg(COALESCE(c.id::text, '') || ':' || COALESCE(rs.id::text, '') || ':' || r.purchase_rate::text, ', ' ORDER BY COALESCE(c.name, 'One Color')), '') as color_rate_pairs`),
    )
    .leftJoin("erp.product_groups as g", "i.group_id", "g.id")
    .leftJoin("erp.product_subgroups as sg", "i.subgroup_id", "sg.id")
    .leftJoin("erp.uom as u", "i.base_uom_id", "u.id")
    .leftJoin("erp.rm_purchase_rates as r", "r.rm_item_id", "i.id")
    .leftJoin("erp.colors as c", "c.id", "r.color_id")
    .leftJoin("erp.sizes as rs", "rs.id", "r.size_id")
    .leftJoin("erp.users as cu", "i.created_by", "cu.id")
    .where("i.item_type", ITEM_TYPE);

  // --- FILTERS ---
  if (filters.subgroup_id) {
    // Force simple equality (Postgres handles string-to-int usually, but this is safer)
    query = query.where("i.subgroup_id", filters.subgroup_id);
  }
  if (filters.created_by) {
    query = query.where("cu.username", filters.created_by);
  }
  if (filters.created_at_start) {
    query = query.where("i.created_at", ">=", filters.created_at_start);
  }
  if (filters.created_at_end) {
    query = query.where("i.created_at", "<=", filters.created_at_end + " 23:59:59");
  }
  if (filters.low_stock_only === "true") {
    query = query.whereRaw("COALESCE(i.min_stock_level, 0) > 0"); // Placeholder logic for "Low Stock"
  }
  // ----------------

  query = query.groupBy("i.id", "g.name", "g.name_ur", "sg.name", "sg.name_ur", "u.code", "u.name", "u.name_ur", "cu.username").orderBy("i.id", "desc");

  return query;
};

// --- RESTORED: loadRateDetails (This was missing!) ---
const loadRateDetails = async () => {
  const rows = await knex("erp.rm_purchase_rates as r").select("r.rm_item_id", "r.purchase_rate", "r.avg_purchase_rate", "c.name as color_name", "c.name_ur as color_name_ur", "s.name as size_name", "s.name_ur as size_name_ur").leftJoin("erp.colors as c", "c.id", "r.color_id").leftJoin("erp.sizes as s", "s.id", "r.size_id").orderBy("r.rm_item_id", "asc").orderByRaw("COALESCE(c.name, '') asc");

  return rows.reduce((acc, row) => {
    if (!acc[row.rm_item_id]) acc[row.rm_item_id] = [];
    acc[row.rm_item_id].push(row);
    return acc;
  }, {});
};

const loadUsers = async () => knex("erp.users").select("id", "username").orderBy("username");

const renderIndex = (req, res, payload) => {
  const basePath = `${req.baseUrl}`;
  return res.render("base/layouts/main", {
    title: res.locals.t("raw_materials"),
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/products/raw-materials/index",
    t: res.locals.t,
    basePath,
    ...payload,
  });
};

router.get("/", requirePermission("SCREEN", "master_data.products.raw_materials", "view"), async (req, res, next) => {
  try {
    // --- UPDATED: Pass req.query to loadRows ---
    const canBrowse = res.locals.can("SCREEN", "master_data.products.raw_materials", "navigate");
    const [options, rateDetailsByItem, users] = await Promise.all([loadOptions(), loadRateDetails(), loadUsers()]);
    const rows = canBrowse ? await loadRows(req.query) : [];

    renderIndex(req, res, {
      rows,
      rateDetailsByItem,
      ...options,
      users,
      error: null,
      modalOpen: false,
      modalMode: "create",
      filters: req.query, // Pass filters back to UI
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("SCREEN", "master_data.products.raw_materials", "navigate"), async (req, res, next) => {
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;

  try {
    const name = (values.name || "").trim();
    const subgroup_id = values.subgroup_id ? Number(values.subgroup_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    const min_stock_level = parseNumber(values.min_stock_level);
    const colorIds = toArray(values.color_ids);
    const sizeIds = toArray(values.size_ids);
    const rates = toArray(values.purchase_rates);

    if (process.env.DEBUG_RM_RATES === "1") {
      console.log("[raw-materials:create] body", {
        color_ids: values.color_ids,
        purchase_rates: values.purchase_rates,
      });
    }

    if (!name || !subgroup_id || !base_uom_id) {
      const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        rateDetailsByItem,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "create",
        values,
      });
    }

    const subgroupMatch = await knex("erp.product_subgroups").select("id", "group_id").where({ id: subgroup_id }).first();
    if (!subgroupMatch || !subgroupMatch.group_id) {
      const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        rateDetailsByItem,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "create",
        values,
      });
    }

    const group = await knex("erp.product_groups").select("name").where({ id: subgroupMatch.group_id }).first();
    const code = toCode(`${group ? group.name : subgroupMatch.group_id}_${name}`);
    const rateRows = buildRateRows({
      itemId: null,
      colorIds,
      sizeIds,
      rates,
      userId: req.user ? req.user.id : null,
      now: () => knex.fn.now(),
    });
    const approvalRates = rateRows.map((row) => ({
      color_id: row.color_id,
      size_id: row.size_id,
      purchase_rate: row.purchase_rate,
      avg_purchase_rate: row.avg_purchase_rate,
    }));

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.raw_materials",
      action: "create",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.raw_materials"],
      entityId: "NEW",
      summary: `${res.locals.t("create")} ${res.locals.t("raw_materials")}`,
      oldValue: null,
      newValue: {
        _action: "create",
        item_type: ITEM_TYPE,
        code,
        name,
        name_ur: values.name_ur || null,
        group_id: subgroupMatch.group_id,
        subgroup_id,
        base_uom_id,
        min_stock_level: min_stock_level === null ? 0 : min_stock_level,
        rates: approvalRates,
      },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }

    await knex.transaction(async (trx) => {
      const [item] = await trx("erp.items")
        .insert({
          item_type: ITEM_TYPE,
          code,
          name,
          name_ur: values.name_ur || null,
          group_id: subgroupMatch.group_id,
          subgroup_id,
          base_uom_id,
          min_stock_level: min_stock_level === null ? 0 : min_stock_level,
          created_by: req.user ? req.user.id : null,
          created_at: trx.fn.now(),
        })
        .returning("id");
      const itemId = item.id || item;

      const rateRows = buildRateRows({
        itemId,
        colorIds,
        sizeIds,
        rates,
        userId: req.user ? req.user.id : null,
        now: () => trx.fn.now(),
      });
      if (process.env.DEBUG_RM_RATES === "1") {
        console.log("[raw-materials:create] rateRows", rateRows);
      }
      if (rateRows.length) {
        await trx("erp.rm_purchase_rates").insert(rateRows);
      }
    });

    return res.redirect(basePath);
  } catch (err) {
    console.error("[raw-materials:create] error", err);
    const fallbackMessage = res.locals.t("error_unable_save") || "Unable to save.";
    const errorMessage = err?.detail || err?.message || fallbackMessage;
    const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      rateDetailsByItem,
      ...options,
      users,
      error: errorMessage,
      modalOpen: true,
      modalMode: "create",
      values,
    });
  }
});

router.post("/:id", requirePermission("SCREEN", "master_data.products.raw_materials", "navigate"), async (req, res, next) => {
  const id = Number(req.params.id);
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const name = (values.name || "").trim();
    const subgroup_id = values.subgroup_id ? Number(values.subgroup_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    const min_stock_level = parseNumber(values.min_stock_level);
    const colorIds = toArray(values.color_ids);
    const sizeIds = toArray(values.size_ids);
    const rates = toArray(values.purchase_rates);

    if (process.env.DEBUG_RM_RATES === "1") {
      console.log("[raw-materials:update] body", {
        id,
        color_ids: values.color_ids,
        purchase_rates: values.purchase_rates,
      });
    }

    if (!name || !subgroup_id || !base_uom_id) {
      const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        rateDetailsByItem,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "edit",
        values: { ...values, id },
      });
    }

    const subgroupMatch = await knex("erp.product_subgroups").select("id", "group_id").where({ id: subgroup_id }).first();
    if (!subgroupMatch || !subgroupMatch.group_id) {
      const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        rateDetailsByItem,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "edit",
        values: { ...values, id },
      });
    }

    const group = await knex("erp.product_groups").select("name").where({ id: subgroupMatch.group_id }).first();
    const code = toCode(`${group ? group.name : subgroupMatch.group_id}_${name}`);
    const rateRows = buildRateRows({
      itemId: id,
      colorIds,
      sizeIds,
      rates,
      userId: req.user ? req.user.id : null,
      now: () => knex.fn.now(),
    });
    const approvalRates = rateRows.map((row) => ({
      color_id: row.color_id,
      size_id: row.size_id,
      purchase_rate: row.purchase_rate,
      avg_purchase_rate: row.avg_purchase_rate,
    }));

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.raw_materials",
      action: "edit",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.raw_materials"],
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t("raw_materials")}`,
      oldValue: null,
      newValue: {
        _action: "update",
        item_type: ITEM_TYPE,
        code,
        name,
        name_ur: values.name_ur || null,
        group_id: subgroupMatch.group_id,
        subgroup_id,
        base_uom_id,
        min_stock_level: min_stock_level === null ? 0 : min_stock_level,
        rates: approvalRates,
      },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }

    await knex.transaction(async (trx) => {
      await trx("erp.items")
        .where({ id })
        .update({
          code,
          name,
          name_ur: values.name_ur || null,
          group_id: subgroupMatch.group_id,
          subgroup_id,
          base_uom_id,
          min_stock_level: min_stock_level === null ? 0 : min_stock_level,
          updated_by: req.user ? req.user.id : null,
          updated_at: trx.fn.now(),
        });
      await trx("erp.rm_purchase_rates").where({ rm_item_id: id }).del();
      const rateRows = buildRateRows({
        itemId: id,
        colorIds,
        sizeIds,
        rates,
        userId: req.user ? req.user.id : null,
        now: () => trx.fn.now(),
      });
      if (process.env.DEBUG_RM_RATES === "1") {
        console.log("[raw-materials:update] rateRows", rateRows);
      }
      if (rateRows.length) {
        await trx("erp.rm_purchase_rates").insert(rateRows);
      }
    });

    return res.redirect(basePath);
  } catch (err) {
    console.error("[raw-materials:update] error", err);
    const fallbackMessage = res.locals.t("error_unable_save") || "Unable to save.";
    const errorMessage = err?.detail || err?.message || fallbackMessage;
    const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      rateDetailsByItem,
      ...options,
      users,
      error: errorMessage,
      modalOpen: true,
      modalMode: "edit",
      values: { ...values, id },
    });
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", "master_data.products.raw_materials", "delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));
  const basePath = `${req.baseUrl}`;

  try {
    const current = await knex("erp.items").select("is_active").where({ id }).first();
    if (!current) return next(new HttpError(404, res.locals.t("error_not_found")));

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.raw_materials",
      action: "delete",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.raw_materials"],
      entityId: id,
      summary: `${res.locals.t("deactivate")} ${res.locals.t("raw_materials")}`,
      oldValue: current,
      newValue: { _action: "toggle", is_active: !current.is_active, item_type: ITEM_TYPE },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }

    await knex("erp.items")
      .where({ id })
      .update({
        is_active: !current.is_active,
        updated_by: req.user ? req.user.id : null,
        updated_at: knex.fn.now(),
      });
    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      rateDetailsByItem,
      ...options,
      users,
      error: res.locals.t("error_update_status"),
      modalOpen: false,
      modalMode: "create",
    });
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "master_data.products.raw_materials", "hard_delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));
  const basePath = `${req.baseUrl}`;
  try {
    const existing = await knex("erp.items").select("id", "name", "is_active").where({ id }).first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.raw_materials",
      action: "delete",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.raw_materials"],
      entityId: id,
      summary: `${res.locals.t("delete")} ${res.locals.t("raw_materials")}`,
      oldValue: existing,
      newValue: { _action: "delete", item_type: ITEM_TYPE },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }

    await knex("erp.items").where({ id }).del();
    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, rateDetailsByItem, users] = await Promise.all([loadRows(), loadOptions(), loadRateDetails(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      rateDetailsByItem,
      ...options,
      users,
      error: res.locals.t("error_delete"),
      modalOpen: false,
      modalMode: "create",
    });
  }
});

module.exports = router;
