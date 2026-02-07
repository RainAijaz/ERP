const express = require("express");
const knex = require("../../db/knex");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { normalizeFields } = require("../../middleware/utils/validation");
const { HttpError } = require("../../middleware/errors/http-error");
const { queueAuditLog } = require("../../utils/audit-log");

const router = express.Router();

router.get("/", requirePermission("SCREEN", "administration.branches", "navigate"), async (req, res, next) => {
  try {
    const canNavigate = res.locals.can("SCREEN", "administration.branches", "navigate");
    const branches = canNavigate ? await knex("erp.branches").orderBy("id", "asc") : [];
    if (req.accepts("html")) {
      res.render("base/layouts/main", {
        view: "../../administration/branches/index",
        title: res.locals.t("branches"),
        branches,
        // Defaults to prevent reference error
        modalOpen: false,
        modalMode: null,
        modalValues: null,
      });
    } else {
      res.json(branches);
    }
  } catch (err) {
    next(err);
  }
});

router.get("/new", requirePermission("SCREEN", "administration.branches", "create"), (req, res) => {
  if (req.xhr) {
    res.render("administration/branches/form", { layout: false, branch: null, title: res.locals.t("add_branch"), csrfToken: res.locals.csrfToken });
  } else {
    res.redirect("/administration/branches");
  }
});

router.post("/", requirePermission("SCREEN", "administration.branches", "create"), normalizeFields(["code", "name", "name_ur", "city"]), async (req, res, next) => {
  try {
    console.log(`[${req.id}] [branches:create] xhr=${req.xhr} body=`, req.body);
    const { code, name, name_ur, city } = req.body;

    if (!code || !name) throw new HttpError(400, res.locals.t("field_required") || "Code and Name required");

    const existing = await knex("erp.branches").whereRaw("LOWER(code) = ?", [code.toLowerCase()]).first();
    if (existing) throw new HttpError(400, res.locals.t("error_branch_code_exists"));

    const [row] = await knex("erp.branches")
      .insert({
        code: code.toUpperCase(),
        name,
        name_ur: name_ur || null,
        city,
        is_active: true,
      })
      .returning("id");
    const branchId = row?.id || row;
    if (branchId) {
      queueAuditLog(req, { entityType: "BRANCH", entityId: branchId, action: "CREATE" });
    }

    if (req.xhr) return res.json({ success: true, redirect: "/administration/branches" });
    res.redirect("/administration/branches");
  } catch (err) {
    console.error(`[${req.id}] [branches:create]`, err);
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.get("/:id/edit", requirePermission("SCREEN", "administration.branches", "edit"), async (req, res, next) => {
  try {
    const branch = await knex("erp.branches").where({ id: req.params.id }).first();
    if (!branch) throw new HttpError(404, res.locals.t("branch_not_found"));

    if (req.xhr) {
      res.render("administration/branches/form", { layout: false, branch, title: res.locals.t("edit_branch"), csrfToken: res.locals.csrfToken });
    } else {
      res.redirect("/administration/branches");
    }
  } catch (err) {
    next(err);
  }
});

router.post("/:id", requirePermission("SCREEN", "administration.branches", "edit"), normalizeFields(["code", "name", "name_ur", "city"]), async (req, res, next) => {
  try {
    console.log(`[${req.id}] [branches:update] xhr=${req.xhr} id=${req.params.id} body=`, req.body);
    const id = req.params.id;
    const { name, name_ur, city } = req.body;

    const current = await knex("erp.branches").where({ id }).first();
    if (!current) throw new HttpError(404, res.locals.t("branch_not_found"));

    if (!name) throw new HttpError(400, res.locals.t("field_required"));

    await knex("erp.branches")
      .where({ id })
      .update({
        code: current.code,
        name,
        name_ur: name_ur || null,
        city,
      });
    queueAuditLog(req, { entityType: "BRANCH", entityId: id, action: "UPDATE" });

    if (req.xhr) return res.json({ success: true, redirect: "/administration/branches" });
    res.redirect("/administration/branches");
  } catch (err) {
    console.error(`[${req.id}] [branches:update] id=${req.params.id}`, err);
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", "administration.branches", "delete"), async (req, res, next) => {
  try {
    const branch = await knex("erp.branches").where({ id: req.params.id }).first();
    if (!branch) throw new HttpError(404, res.locals.t("branch_not_found"));
    const nextValue = !branch.is_active;
    await knex("erp.branches").where({ id: req.params.id }).update({ is_active: nextValue });
    queueAuditLog(req, { entityType: "BRANCH", entityId: req.params.id, action: "DELETE" });
    if (req.xhr) return res.json({ success: true, is_active: nextValue });
    res.redirect("/administration/branches");
  } catch (err) {
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "administration.branches", "hard_delete"), async (req, res, next) => {
  const trx = await knex.transaction();
  try {
    const branch = await trx("erp.branches").where({ id: req.params.id }).first();
    if (!branch) throw new HttpError(404, res.locals.t("branch_not_found"));
    await trx("erp.user_branch").where({ branch_id: req.params.id }).del();
    await trx("erp.branches").where({ id: req.params.id }).del();
    queueAuditLog(req, { entityType: "BRANCH", entityId: req.params.id, action: "DELETE" });
    await trx.commit();
    if (req.xhr) return res.json({ success: true });
    res.redirect("/administration/branches");
  } catch (err) {
    await trx.rollback();
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
