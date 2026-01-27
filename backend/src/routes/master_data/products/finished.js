const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");

const router = express.Router();
const ITEM_TYPE = "FG";

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

const loadOptions = async () => {
  const [groups, subgroups, uoms, types] = await Promise.all([
    knex("erp.product_groups as g").select("g.id", "g.name", "g.name_ur").join("erp.product_group_item_types as gt", "gt.group_id", "g.id").where("gt.item_type", ITEM_TYPE).andWhere("g.is_active", true).orderBy("g.name"),
    knex("erp.product_subgroups as s").select("s.id", "s.name", "s.name_ur").join("erp.product_subgroup_item_types as st", "st.subgroup_id", "s.id").where("st.item_type", ITEM_TYPE).andWhere("s.is_active", true).orderBy("s.name"),
    knex("erp.uom").select("id", "code", "name").where("is_active", true).orderBy("code"),
    knex("erp.product_types").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
  ]);
  return { groups, subgroups, uoms, types };
};

const loadUsers = async () =>
  knex("erp.users").select("id", "username").orderBy("username");

const loadRows = async () =>
  knex("erp.items as i")
    .select("i.*", "g.name as group_name", "g.name_ur as group_name_ur", "sg.name as subgroup_name", "sg.name_ur as subgroup_name_ur", "u.code as uom_code", "u.name as uom_name", "u.name_ur as uom_name_ur", "pt.name as type_name", "pt.name_ur as type_name_ur", "cu.username as created_by_name")
    .leftJoin("erp.product_groups as g", "i.group_id", "g.id")
    .leftJoin("erp.product_subgroups as sg", "i.subgroup_id", "sg.id")
    .leftJoin("erp.uom as u", "i.base_uom_id", "u.id")
    .leftJoin("erp.product_types as pt", "i.product_type_id", "pt.id")
    .leftJoin("erp.users as cu", "i.created_by", "cu.id")
    .where("i.item_type", ITEM_TYPE)
    .orderBy("i.id", "desc");

const renderIndex = (req, res, payload) => {
  const basePath = `${req.baseUrl}`;
  return res.render("base/layouts/main", {
    title: res.locals.t("finished"),
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/products/finished/index",
    t: res.locals.t,
    basePath,
    ...payload,
  });
};

const getLinkedSfgIds = async (trx, fgId) => {
  const rows = await trx("erp.item_usage").select("sfg_item_id").where({ fg_item_id: fgId });
  return rows.map((row) => row.sfg_item_id);
};

const ensureSfgForFinished = async (trx, finishedItem, sfgPartType, userId) => {
  const suffix = sfgPartType === "STEP" ? "STEP" : "UPPER";
  const sfgName = `${finishedItem.name} - ${suffix}`;
  const sfgCode = toCode(`${finishedItem.code}_${suffix}`);
  const linked = await getLinkedSfgIds(trx, finishedItem.id);
  const existingByCode = await trx("erp.items")
    .select("id")
    .where({ code: sfgCode, item_type: "SFG" })
    .first();
  if (linked.length) {
    let primaryId = linked[0];
    if (existingByCode && existingByCode.id !== primaryId) {
      await trx("erp.item_usage")
        .where({ fg_item_id: finishedItem.id, sfg_item_id: primaryId })
        .del();
      await trx("erp.item_usage")
        .insert({ fg_item_id: finishedItem.id, sfg_item_id: existingByCode.id })
        .onConflict(["fg_item_id", "sfg_item_id"])
        .ignore();
      primaryId = existingByCode.id;
    }
    await trx("erp.items")
      .where({ id: primaryId })
      .update({
        code: sfgCode,
        name: sfgName,
        name_ur: finishedItem.name_ur || null,
        group_id: finishedItem.group_id,
        subgroup_id: finishedItem.subgroup_id || null,
        product_type_id: finishedItem.product_type_id || null,
        base_uom_id: finishedItem.base_uom_id,
        updated_by: userId,
        updated_at: trx.fn.now(),
      });
    if (linked.length > 1) {
      const extras = linked.slice(1);
      await trx("erp.item_usage").where({ fg_item_id: finishedItem.id }).whereIn("sfg_item_id", extras).del();
      const usedElsewhere = await trx("erp.item_usage").whereIn("sfg_item_id", extras).select("sfg_item_id").groupBy("sfg_item_id");
      const usedSet = new Set(usedElsewhere.map((row) => row.sfg_item_id));
      const deletable = extras.filter((sfgId) => !usedSet.has(sfgId));
      if (deletable.length) {
        await trx("erp.items").whereIn("id", deletable).del();
      }
    }
    return;
  }

  if (existingByCode) {
    await trx("erp.items")
      .where({ id: existingByCode.id })
      .update({
        name: sfgName,
        name_ur: finishedItem.name_ur || null,
        group_id: finishedItem.group_id,
        subgroup_id: finishedItem.subgroup_id || null,
        product_type_id: finishedItem.product_type_id || null,
        base_uom_id: finishedItem.base_uom_id,
        updated_by: userId,
        updated_at: trx.fn.now(),
      });
    await trx("erp.item_usage")
      .insert({ fg_item_id: finishedItem.id, sfg_item_id: existingByCode.id })
      .onConflict(["fg_item_id", "sfg_item_id"])
      .ignore();
    return;
  }

  const [created] = await trx("erp.items")
    .insert({
      item_type: "SFG",
      code: sfgCode,
      name: sfgName,
      name_ur: finishedItem.name_ur || null,
      group_id: finishedItem.group_id,
      subgroup_id: finishedItem.subgroup_id || null,
      product_type_id: finishedItem.product_type_id || null,
      base_uom_id: finishedItem.base_uom_id,
      min_stock_level: 0,
      created_by: userId,
      created_at: trx.fn.now(),
    })
    .returning("id");
  const sfgItemId = created.id || created;

  await trx("erp.item_usage").insert({ fg_item_id: finishedItem.id, sfg_item_id: sfgItemId }).onConflict(["fg_item_id", "sfg_item_id"]).ignore();
};

router.get("/", async (req, res, next) => {
  try {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    renderIndex(req, res, { rows, ...options, users, error: null, modalOpen: false, modalMode: "create" });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res) => {
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;
  try {
    const name = (values.name || "").trim();
    const code = toCode(name);
    const group_id = values.group_id ? Number(values.group_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    const subgroup_id = values.subgroup_id ? Number(values.subgroup_id) : null;
    const product_type_id = values.product_type_id ? Number(values.product_type_id) : null;
    const uses_sfg = values.uses_sfg === "true" || values.uses_sfg === "on";
    const sfg_part_type = uses_sfg ? (values.sfg_part_type || "").toUpperCase() : null;

    if (!code || !name || !group_id || !base_uom_id || !product_type_id || (uses_sfg && !sfg_part_type)) {
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
      const [item] = await trx("erp.items")
        .insert({
          item_type: ITEM_TYPE,
          code,
          name,
          name_ur: values.name_ur || null,
          group_id,
          subgroup_id,
          product_type_id,
          base_uom_id,
          uses_sfg,
          sfg_part_type: sfg_part_type || null,
          min_stock_level: 0,
          created_by: req.user ? req.user.id : null,
          created_at: trx.fn.now(),
        })
        .returning("*");

      if (uses_sfg) {
        await ensureSfgForFinished(trx, item, sfg_part_type, req.user ? req.user.id : null);
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
  if (!id) return next(new HttpError(404, "Finished product not found"));

  try {
    console.log("[finished:update] raw body", values);
    const name = (values.name || "").trim();
    const code = toCode(name);
    const group_id = values.group_id ? Number(values.group_id) : null;
    const base_uom_id = values.base_uom_id ? Number(values.base_uom_id) : null;
    const subgroup_id = values.subgroup_id ? Number(values.subgroup_id) : null;
    const product_type_id = values.product_type_id ? Number(values.product_type_id) : null;
    const uses_sfg = values.uses_sfg === "true" || values.uses_sfg === "on";
    const sfg_part_type = uses_sfg ? (values.sfg_part_type || "").toUpperCase() : null;

    console.log("[finished:update] parsed", {
      id,
      name,
      code,
      group_id,
      subgroup_id,
      base_uom_id,
      product_type_id,
      uses_sfg,
      sfg_part_type,
    });

    if (!code || !name || !group_id || !base_uom_id || !product_type_id || (uses_sfg && !sfg_part_type)) {
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
      const [item] = await trx("erp.items")
        .where({ id })
        .update({
          code,
          name,
          name_ur: values.name_ur || null,
          group_id,
          subgroup_id,
          product_type_id,
          base_uom_id,
          uses_sfg,
          sfg_part_type: sfg_part_type || null,
          updated_by: req.user ? req.user.id : null,
          updated_at: trx.fn.now(),
        })
        .returning("*");

      if (!item) {
        throw new Error("Finished update failed: item not found or returning empty.");
      }

      if (uses_sfg) {
        await ensureSfgForFinished(trx, item, sfg_part_type, req.user ? req.user.id : null);
      } else {
        const linked = await getLinkedSfgIds(trx, id);
        await trx("erp.item_usage").where({ fg_item_id: id }).del();
        if (linked.length) {
          await trx("erp.items")
            .whereIn("id", linked)
            .update({
              is_active: false,
              updated_by: req.user ? req.user.id : null,
              updated_at: trx.fn.now(),
            });
        }
      }
    });

    return res.redirect(basePath);
  } catch (err) {
    console.error("[finished:update] error", err);
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
  if (!id) return next(new HttpError(404, "Finished product not found"));
  const basePath = `${req.baseUrl}`;
  try {
    const current = await knex("erp.items").select("is_active").where({ id }).first();
    if (!current) return next(new HttpError(404, "Finished product not found"));
    await knex.transaction(async (trx) => {
      await trx("erp.items")
        .where({ id })
        .update({
          is_active: !current.is_active,
          updated_by: req.user ? req.user.id : null,
          updated_at: trx.fn.now(),
        });
      const linked = await getLinkedSfgIds(trx, id);
      if (linked.length) {
        await trx("erp.items")
          .whereIn("id", linked)
          .update({
            is_active: !current.is_active,
            updated_by: req.user ? req.user.id : null,
            updated_at: trx.fn.now(),
          });
      }
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
  if (!id) return next(new HttpError(404, "Finished product not found"));
  const basePath = `${req.baseUrl}`;
  try {
    await knex.transaction(async (trx) => {
      const linked = await getLinkedSfgIds(trx, id);
      await trx("erp.item_usage").where({ fg_item_id: id }).del();
      if (linked.length) {
        const usedElsewhere = await trx("erp.item_usage").whereIn("sfg_item_id", linked).select("sfg_item_id").groupBy("sfg_item_id");
        const usedSet = new Set(usedElsewhere.map((row) => row.sfg_item_id));
        const deletable = linked.filter((sfgId) => !usedSet.has(sfgId));
        if (deletable.length) {
          await trx("erp.items").whereIn("id", deletable).del();
        }
      }
      await trx("erp.items").where({ id }).del();
    });
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
