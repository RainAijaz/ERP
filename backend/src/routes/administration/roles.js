const express = require("express");
const knex = require("../../db/knex");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { normalizeFields } = require("../../middleware/utils/validation");
const { HttpError } = require("../../middleware/errors/http-error");

const router = express.Router();

router.get("/", requirePermission("SCREEN", "administration.roles", "navigate"), async (req, res, next) => {
  try {
    const canNavigate = res.locals.can("SCREEN", "administration.roles", "navigate");
    const roles = canNavigate ? await knex("erp.role_templates").orderBy("id", "asc") : [];
    if (req.accepts("html")) {
      res.render("base/layouts/main", {
        view: "../../administration/roles/index",
        title: res.locals.t("roles"),
        roles,
        modalOpen: false,
        modalMode: null,
        modalValues: null,
      });
    } else {
      res.json(roles);
    }
  } catch (err) {
    next(err);
  }
});

router.get("/new", requirePermission("SCREEN", "administration.roles", "create"), (req, res) => {
  if (req.xhr) {
    res.render("administration/roles/form", { layout: false, role: null, title: res.locals.t("add_role"), csrfToken: res.locals.csrfToken });
  } else {
    res.redirect("/administration/roles");
  }
});

router.post("/", requirePermission("SCREEN", "administration.roles", "create"), normalizeFields(["name", "description"]), async (req, res, next) => {
  try {
    console.log(`[${req.id}] [roles:create] xhr=${req.xhr} body=`, req.body);
    const { name, description } = req.body;
    if (!name) throw new HttpError(400, "Name is required");

    const existing = await knex("erp.role_templates").whereRaw("LOWER(name) = ?", [name.toLowerCase()]).first();
    if (existing) throw new HttpError(400, "Role exists");

    await knex("erp.role_templates").insert({ name, description });

    if (req.xhr) return res.json({ success: true, redirect: "/administration/roles" });
    res.redirect("/administration/roles");
  } catch (err) {
    console.error(`[${req.id}] [roles:create]`, err);
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.get("/:id/edit", requirePermission("SCREEN", "administration.roles", "edit"), async (req, res, next) => {
  try {
    const role = await knex("erp.role_templates").where({ id: req.params.id }).first();
    if (!role) throw new HttpError(404, "Role not found");
    if (req.xhr) {
      res.render("administration/roles/form", { layout: false, role, title: res.locals.t("edit_role"), csrfToken: res.locals.csrfToken });
    } else {
      res.redirect("/administration/roles");
    }
  } catch (err) {
    next(err);
  }
});

router.post("/:id", requirePermission("SCREEN", "administration.roles", "edit"), normalizeFields(["name", "description"]), async (req, res, next) => {
  try {
    console.log(`[${req.id}] [roles:update] xhr=${req.xhr} id=${req.params.id} body=`, req.body);
    const { name, description } = req.body;
    const id = req.params.id;

    if (!name) throw new HttpError(400, "Name is required");

    const existing = await knex("erp.role_templates").whereRaw("LOWER(name) = ?", [name.toLowerCase()]).andWhereNot({ id }).first();
    if (existing) throw new HttpError(400, "Role exists");

    await knex("erp.role_templates").where({ id }).update({ name, description });

    if (req.xhr) return res.json({ success: true, redirect: "/administration/roles" });
    res.redirect("/administration/roles");
  } catch (err) {
    console.error(`[${req.id}] [roles:update] id=${req.params.id}`, err);
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", "administration.roles", "delete"), async (req, res, next) => {
  try {
    const role = await knex("erp.role_templates").where({ id: req.params.id }).first();
    if (!role) throw new HttpError(404, "Role not found");
    const nextValue = !role.is_active;
    await knex("erp.role_templates").where({ id: req.params.id }).update({ is_active: nextValue });
    if (req.xhr) return res.json({ success: true, is_active: nextValue });
    res.redirect("/administration/roles");
  } catch (err) {
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "administration.roles", "hard_delete"), async (req, res, next) => {
  const trx = await knex.transaction();
  try {
    const role = await trx("erp.role_templates").where({ id: req.params.id }).first();
    if (!role) throw new HttpError(404, "Role not found");
    const userCountRow = await trx("erp.users").where({ primary_role_id: req.params.id }).count({ count: "*" }).first();
    const userCount = Number(userCountRow?.count || 0);
    if (userCount > 0) throw new HttpError(400, "Role is assigned to users");
    await trx("erp.role_templates").where({ id: req.params.id }).del();
    await trx.commit();
    if (req.xhr) return res.json({ success: true });
    res.redirect("/administration/roles");
  } catch (err) {
    await trx.rollback();
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
