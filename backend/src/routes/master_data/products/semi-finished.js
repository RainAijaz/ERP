const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");

const router = express.Router();
const ITEM_TYPE = "SFG";

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

const loadOptions = async () => {
  const [groups, uoms, finished] = await Promise.all([
    knex("erp.product_groups as g").select("g.id", "g.name", "g.name_ur").join("erp.product_group_item_types as gt", "gt.group_id", "g.id").where("gt.item_type", ITEM_TYPE).andWhere("g.is_active", true).orderBy("g.name"),
    knex("erp.uom").select("id", "code", "name", "name_ur").where("is_active", true).orderBy("code"),
    knex("erp.items as i").select("i.id", "i.name", "i.name_ur", "i.subgroup_id", "sg.name as subgroup_name", "sg.name_ur as subgroup_name_ur").leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id").where({ "i.item_type": "FG", "i.is_active": true }).orderBy("i.name"),
  ]);
  return { groups, uoms, finished };
};

const loadUsers = async () => knex("erp.users").select("id", "username").orderBy("username");

const loadRows = async () =>
  knex("erp.items as i")
    .select(
      "i.*",
      "g.name as group_name",
      "g.name_ur as group_name_ur",
      "u.code as uom_code",
      "u.name as uom_name",
      "u.name_ur as uom_name_ur",
      "cu.username as created_by_name",
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(sg.name, ''), ', ' ORDER BY COALESCE(sg.name, '')), '') as subgroup_names`),
      knex.raw(`COALESCE(string_agg(DISTINCT COALESCE(sg.name_ur, sg.name), ', ' ORDER BY COALESCE(sg.name_ur, sg.name)), '') as subgroup_names_ur`),
      knex.raw(`COALESCE(string_agg(DISTINCT sg.id::text, ', ' ORDER BY sg.id::text), '') as subgroup_ids`),
      knex.raw(`COALESCE(string_agg(fg.name, ', ' ORDER BY fg.name), '') as usage_articles`),
      knex.raw(`COALESCE(string_agg(COALESCE(fg.name_ur, fg.name), ', ' ORDER BY fg.name), '') as usage_articles_ur`),
      knex.raw(`COALESCE(string_agg(fg.id::text, ', ' ORDER BY fg.name), '') as usage_article_ids`),
    )
    .leftJoin("erp.product_groups as g", "i.group_id", "g.id")
    .leftJoin("erp.uom as u", "i.base_uom_id", "u.id")
    .leftJoin("erp.item_usage as iu", "iu.sfg_item_id", "i.id")
    .leftJoin("erp.items as fg", "fg.id", "iu.fg_item_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "fg.subgroup_id")
    .leftJoin("erp.users as cu", "i.created_by", "cu.id")
    .where("i.item_type", ITEM_TYPE)
    .groupBy("i.id", "g.name", "g.name_ur", "u.code", "u.name", "u.name_ur", "cu.username")
    .orderBy("i.id", "desc");

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

router.get("/", async (req, res, next) => {
  try {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    renderIndex(req, res, { rows, ...options, users, error: null, modalOpen: false, modalMode: "create" });
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

router.post("/", async (req, res) => {
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;
  try {
    const name = (values.name || "").trim();
    const code = toCode(name);
    const group_id = values.group_id ? Number(values.group_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    const usageIds = normalizeUsageIds(values.fg_ids)
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    const uniqueUsageIds = Array.from(new Set(usageIds));
    if (!code || !name || !group_id || !base_uom_id) {
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

    await knex.transaction(async (trx) => {
      const subgroup_id = await resolveSubgroupId(trx, uniqueUsageIds);
      const [item] = await trx("erp.items")
        .insert({
          item_type: ITEM_TYPE,
          code,
          name,
          name_ur: values.name_ur || null,
          group_id,
          subgroup_id,
          base_uom_id,
          min_stock_level: 0,
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

router.post("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;
  if (!id) return next(new HttpError(404, "Semi-finished item not found"));

  try {
    const name = (values.name || "").trim();
    const code = toCode(name);
    const group_id = values.group_id ? Number(values.group_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    const usageIds = normalizeUsageIds(values.fg_ids)
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    const uniqueUsageIds = Array.from(new Set(usageIds));
    if (!code || !name || !group_id || !base_uom_id) {
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

    await knex.transaction(async (trx) => {
      const subgroup_id = await resolveSubgroupId(trx, uniqueUsageIds);
      await trx("erp.items")
        .where({ id })
        .update({
          code,
          name,
          name_ur: values.name_ur || null,
          group_id,
          subgroup_id,
          base_uom_id,
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

router.post("/:id/toggle", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, "Semi-finished item not found"));
  const basePath = `${req.baseUrl}`;
  try {
    const current = await knex("erp.items").select("is_active").where({ id }).first();
    if (!current) return next(new HttpError(404, "Semi-finished item not found"));
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

router.post("/:id/delete", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, "Semi-finished item not found"));
  const basePath = `${req.baseUrl}`;
  try {
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
