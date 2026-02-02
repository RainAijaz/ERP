const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");

const router = express.Router();
const ITEM_TYPE = "SFG";

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

const loadOptions = async () => {
  const [groups, uoms, finished, subgroups, colors, sizes] = await Promise.all([
    knex("erp.product_groups as g").select("g.id", "g.name", "g.name_ur").join("erp.product_group_item_types as gt", "gt.group_id", "g.id").where("gt.item_type", ITEM_TYPE).andWhere("g.is_active", true).orderBy("g.name"),
    knex("erp.uom").select("id", "code", "name", "name_ur").where("is_active", true).orderBy("code"),
    knex("erp.items as i").select("i.id", "i.name", "i.name_ur", "i.subgroup_id", "sg.name as subgroup_name", "sg.name_ur as subgroup_name_ur").leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id").where({ "i.item_type": "FG", "i.is_active": true }).orderBy("i.name"),
    knex("erp.product_subgroups as s").select("s.id", "s.name", "s.name_ur").join("erp.product_subgroup_item_types as st", "st.subgroup_id", "s.id").where("st.item_type", ITEM_TYPE).andWhere("s.is_active", true).orderBy("s.name"),
    knex("erp.colors").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
    knex("erp.sizes as s").select("s.id", "s.name", "s.name_ur").join("erp.size_item_types as sit", "sit.size_id", "s.id").where("sit.item_type", ITEM_TYPE).andWhere("s.is_active", true).orderBy("s.name"),
  ]);
  return { groups, uoms, finished, subgroups, colors, sizes };
};

const loadUsers = async () => knex("erp.users").select("id", "username").orderBy("username");

const loadRows = async (filters = {}) => {
  let query = knex("erp.items as i")
    .select(
      "i.*",
      "g.name as group_name",
      "g.name_ur as group_name_ur",
      "sg_item.name as subgroup_name",
      "sg_item.name_ur as subgroup_name_ur",
      "u.code as uom_code",
      "u.name as uom_name",
      "u.name_ur as uom_name_ur",
      "cu.username as created_by_name",
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(sg_usage.name, ''), ', ' ORDER BY COALESCE(sg_usage.name, '')), '') as subgroup_names`),
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(sg_usage.name_ur, sg_usage.name), ', ' ORDER BY COALESCE(sg_usage.name_ur, sg_usage.name)), '') as subgroup_names_ur`),
      knex.raw(`COALESCE(string_agg(DISTINCT sg_usage.id::text, ', ' ORDER BY sg_usage.id::text), '') as subgroup_ids`),
      knex.raw(`COALESCE(string_agg(fg.name, ', ' ORDER BY fg.name), '') as usage_articles`),
      knex.raw(`COALESCE(string_agg(COALESCE(fg.name_ur, fg.name), ', ' ORDER BY fg.name), '') as usage_articles_ur`),
      knex.raw(`COALESCE(string_agg(fg.id::text, ', ' ORDER BY fg.name), '') as usage_article_ids`),
    )
    .leftJoin("erp.product_groups as g", "i.group_id", "g.id")
    .leftJoin("erp.uom as u", "i.base_uom_id", "u.id")
    .leftJoin("erp.product_subgroups as sg_item", "sg_item.id", "i.subgroup_id")
    .leftJoin("erp.item_usage as iu", "iu.sfg_item_id", "i.id")
    .leftJoin("erp.items as fg", "fg.id", "iu.fg_item_id")
    .leftJoin("erp.product_subgroups as sg_usage", "sg_usage.id", "fg.subgroup_id")
    .leftJoin("erp.users as cu", "i.created_by", "cu.id")
    .where("i.item_type", ITEM_TYPE);

  if (filters.subgroup_id) {
    const subgroupId = Number(filters.subgroup_id);
    if (Number.isFinite(subgroupId)) {
      query = query.where(function () {
        this.where("i.subgroup_id", subgroupId).orWhere("sg_usage.id", subgroupId);
      });
    }
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
    query = query.whereRaw("COALESCE(i.min_stock_level, 0) > 0");
  }

  query = query.groupBy("i.id", "g.name", "g.name_ur", "sg_item.name", "sg_item.name_ur", "u.code", "u.name", "u.name_ur", "cu.username").orderBy("i.id", "desc");

  return query;
};

const resolveSubgroupId = async (trx, usageIds) => {
  if (!usageIds.length) return null;
  const rows = await trx("erp.items").select("subgroup_id").whereIn("id", usageIds).whereNotNull("subgroup_id");
  const unique = Array.from(new Set(rows.map((row) => row.subgroup_id).filter(Boolean)));
  return unique.length === 1 ? unique[0] : null;
};

const renderIndex = (req, res, payload) => {
  const basePath = `${req.baseUrl}`;
  return res.render("base/layouts/main", {
    title: res.locals.t("semi_finished"),
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/products/semi-finished/index",
    t: res.locals.t,
    basePath,
    ...payload,
  });
};

router.get("/", requirePermission("SCREEN", "master_data.products.semi_finished", "navigate"), async (req, res, next) => {
  try {
    const filters = {
      subgroup_id: req.query.subgroup_id || "",
      created_by: req.query.created_by || "",
      created_at_start: req.query.created_at_start || "",
      created_at_end: req.query.created_at_end || "",
      low_stock_only: req.query.low_stock_only || "",
    };
    const [rows, options, users] = await Promise.all([loadRows(filters), loadOptions(), loadUsers()]);
    renderIndex(req, res, { rows, ...options, users, filters, error: null, modalOpen: false, modalMode: "create" });
  } catch (err) {
    next(err);
  }
});

const normalizeUsageIds = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object") return Object.values(value);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [value];
};

router.post("/", requirePermission("SCREEN", "master_data.products.semi_finished", "navigate"), async (req, res) => {
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;
  try {
    const name = (values.name || "").trim();
    const code = toCode(name);
    const group_id = values.group_id ? Number(values.group_id) : null;
    // FIX: Read user's subgroup selection
    const user_subgroup_id = values.subgroup_id ? Number(values.subgroup_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    // FIX: Read min stock
    const min_stock_level = values.min_stock_level ? Number(values.min_stock_level) : 0;

    const usageIds = normalizeUsageIds(values.fg_ids)
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    const uniqueUsageIds = Array.from(new Set(usageIds));

    // FIX: Add name_ur and subgroup_id validation
    if (!code || !name || !values.name_ur || !group_id || !base_uom_id || !user_subgroup_id) {
      const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "create",
        values,
      });
    }

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.semi_finished",
      action: "create",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.semi_finished"],
      entityId: "NEW",
      summary: `${res.locals.t("create")} ${res.locals.t("semi_finished")}`,
      oldValue: null,
      newValue: {
        _action: "create",
        item_type: ITEM_TYPE,
        code,
        name,
        name_ur: values.name_ur || null,
        group_id,
        subgroup_id: user_subgroup_id,
        base_uom_id,
        min_stock_level,
        usage_ids: uniqueUsageIds,
      },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
    }

    await knex.transaction(async (trx) => {
      // FIX: Use user's subgroup choice. Only use resolve if you want to override (removed overwrite here).
      const [item] = await trx("erp.items")
        .insert({
          item_type: ITEM_TYPE,
          code,
          name,
          name_ur: values.name_ur || null,
          group_id,
          subgroup_id: user_subgroup_id, // FIX: Use the variable
          base_uom_id,
          min_stock_level, // FIX: Use the variable
          created_by: req.user ? req.user.id : null,
          created_at: trx.fn.now(),
        })
        .returning("id");
      const itemId = item.id || item;
      if (uniqueUsageIds.length) {
        await trx("erp.item_usage").insert(
          uniqueUsageIds.map((fgId) => ({
            fg_item_id: fgId,
            sfg_item_id: itemId,
          })),
        );
      }
    });

    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      ...options,
      users,
      error: res.locals.t("error_unable_save"),
      modalOpen: true,
      modalMode: "create",
      values,
    });
  }
});
router.post("/:id", requirePermission("SCREEN", "master_data.products.semi_finished", "navigate"), async (req, res, next) => {
  const id = Number(req.params.id);
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const name = (values.name || "").trim();
    const code = toCode(name);
    const group_id = values.group_id ? Number(values.group_id) : null;
    const user_subgroup_id = values.subgroup_id ? Number(values.subgroup_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    const min_stock_level = values.min_stock_level ? Number(values.min_stock_level) : 0;

    const usageIds = normalizeUsageIds(values.fg_ids)
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    const uniqueUsageIds = Array.from(new Set(usageIds));

    // FIX: Add name_ur and subgroup_id to validation
    if (!code || !name || !values.name_ur || !group_id || !base_uom_id || !user_subgroup_id) {
      const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "edit",
        values: { ...values, id },
      });
    }

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.semi_finished",
      action: "edit",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.semi_finished"],
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t("semi_finished")}`,
      oldValue: null,
      newValue: {
        _action: "update",
        item_type: ITEM_TYPE,
        code,
        name,
        name_ur: values.name_ur || null,
        group_id,
        subgroup_id: user_subgroup_id,
        base_uom_id,
        min_stock_level,
        usage_ids: uniqueUsageIds,
      },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
    }

    await knex.transaction(async (trx) => {
      await trx("erp.items")
        .where({ id })
        .update({
          code,
          name,
          name_ur: values.name_ur || null,
          group_id,
          subgroup_id: user_subgroup_id, // FIX: Use user input
          base_uom_id,
          min_stock_level, // FIX: Save min stock
          updated_by: req.user ? req.user.id : null,
          updated_at: trx.fn.now(),
        });
      await trx("erp.item_usage").where({ sfg_item_id: id }).del();
      if (uniqueUsageIds.length) {
        await trx("erp.item_usage").insert(
          uniqueUsageIds.map((fgId) => ({
            fg_item_id: fgId,
            sfg_item_id: id,
          })),
        );
      }
    });

    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      ...options,
      users,
      error: res.locals.t("error_unable_save"),
      modalOpen: true,
      modalMode: "edit",
      values: { ...values, id },
    });
  }
});
router.post("/:id/toggle", requirePermission("SCREEN", "master_data.products.semi_finished", "delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));
  const basePath = `${req.baseUrl}`;
  try {
    const current = await knex("erp.items").select("is_active").where({ id }).first();
    if (!current) return next(new HttpError(404, res.locals.t("error_not_found")));

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.semi_finished",
      action: "edit",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.semi_finished"],
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t("semi_finished")}`,
      oldValue: current,
      newValue: { _action: "toggle", is_active: !current.is_active, item_type: ITEM_TYPE },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
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
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      ...options,
      users,
      error: res.locals.t("error_update_status"),
      modalOpen: false,
      modalMode: "create",
    });
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "master_data.products.semi_finished", "hard_delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));
  const basePath = `${req.baseUrl}`;
  try {
    const existing = await knex("erp.items").select("id", "name", "is_active").where({ id }).first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));

    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.products.semi_finished",
      action: "delete",
      entityType: SCREEN_ENTITY_TYPES["master_data.products.semi_finished"],
      entityId: id,
      summary: `${res.locals.t("delete")} ${res.locals.t("semi_finished")}`,
      oldValue: existing,
      newValue: { _action: "delete", item_type: ITEM_TYPE },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
    }

    await knex("erp.items").where({ id }).del();
    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      ...options,
      users,
      error: res.locals.t("error_delete"),
      modalOpen: false,
      modalMode: "create",
    });
  }
});

module.exports = router;
