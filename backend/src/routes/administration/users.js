const express = require("express");
const knex = require("../../db/knex");
const { hashPassword } = require("../../middleware/core/auth");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { normalizeFields } = require("../../middleware/utils/validation");
const { HttpError } = require("../../middleware/errors/http-error");
const { queueAuditLog } = require("../../utils/audit-log");

const router = express.Router();

router.get("/", requirePermission("SCREEN", "administration.users", "navigate"), async (req, res, next) => {
  try {
    const canNavigate = res.locals.can("SCREEN", "administration.users", "navigate");
    const users = canNavigate ? await knex("erp.users as u").leftJoin("erp.role_templates as rt", "u.primary_role_id", "rt.id").leftJoin("erp.user_branch as ub", "u.id", "ub.user_id").leftJoin("erp.branches as b", "ub.branch_id", "b.id").groupBy("u.id", "rt.name").select("u.*", "rt.name as role_name").select(knex.raw("COALESCE(string_agg(DISTINCT b.name, ', '), '') as branch_names")).orderBy("u.id") : [];

    if (req.accepts("html")) {
      res.render("base/layouts/main", {
        view: "../../administration/users/index",
        title: res.locals.t("users"),
        users,
        modalOpen: false,
        modalMode: null,
        modalValues: null,
      });
    } else {
      res.json(users);
    }
  } catch (err) {
    next(err);
  }
});

router.get(["/form", "/form/:id"], requirePermission("SCREEN", "administration.users", "edit"), async (req, res, next) => {
  if (!req.xhr) return res.redirect("/administration/users");

  try {
    const userId = req.params.id;
    let user = null;
    let userBranches = [];

    if (userId) {
      user = await knex("erp.users").where({ id: userId }).first();
      if (!user) throw new HttpError(404, "User not found");
      const branches = await knex("erp.user_branch").where({ user_id: userId });
      userBranches = branches.map((b) => Number(b.branch_id));
    }

    const roles = await knex("erp.role_templates").select("id", "name");
    const allBranches = await knex("erp.branches").where({ is_active: true }).orderBy("name");

    res.render("administration/users/form", {
      layout: false,
      user,
      userBranches,
      roles,
      allBranches,
      title: userId ? res.locals.t("edit_user") : res.locals.t("add_user"),
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send("Error loading form");
  }
});

router.post("/save", requirePermission("SCREEN", "administration.users", "edit"), normalizeFields(["name", "name_ur", "username", "email"]), async (req, res, next) => {
  const trx = await knex.transaction();
  try {
    console.log(`[${req.id}] [users:save] xhr=${req.xhr} body=`, req.body);
    const { id, name, name_ur, username, password, email, primary_role_id, branch_ids, status } = req.body;

    if (!name) throw new HttpError(400, "Name required");
    if (!username) throw new HttpError(400, "Username required");
    if (!primary_role_id) throw new HttpError(400, "Role required");
    if (!id && !password) throw new HttpError(400, "Password required for new users");

    // Check Unique Username
    const existing = await trx("erp.users")
      .whereRaw("LOWER(username) = ?", [username.toLowerCase()])
      .andWhereNot({ id: id || -1 })
      .first();
    if (existing) throw new HttpError(400, "Username taken");

    const userData = {
      name,
      name_ur: name_ur || null,
      username,
      email: email || null,
      primary_role_id,
      status: status === undefined ? undefined : status === "on" || status === "Active" ? "Active" : "Inactive",
    };

    if (id && userData.status === undefined) {
      const existingUser = await trx("erp.users").select("status").where({ id }).first();
      userData.status = existingUser?.status || "Active";
    }
    if (!id && userData.status === undefined) {
      userData.status = "Active";
    }

    if (password && password.trim().length > 0) {
      userData.password_hash = hashPassword(password);
    }

    let targetId = id;
    if (id) {
      await trx("erp.users").where({ id }).update(userData);
    } else {
      const [newUser] = await trx("erp.users").insert(userData).returning("id");
      targetId = newUser.id || newUser;
    }

    await trx("erp.user_branch").where({ user_id: targetId }).del();

    let branches = [];
    if (branch_ids) {
      if (Array.isArray(branch_ids)) {
        branches = branch_ids;
      } else if (typeof branch_ids === "object") {
        branches = Object.values(branch_ids);
      } else {
        branches = [branch_ids];
      }
    }
    branches = branches.filter((bid) => bid !== undefined && bid !== null && String(bid).trim() !== "");

    const roleRow = await trx("erp.role_templates").select("name").where({ id: primary_role_id }).first();
    const isAdminRole =
      roleRow &&
      String(roleRow.name || "")
        .trim()
        .toLowerCase() === "admin";
    if (isAdminRole) {
      const allBranchIds = await trx("erp.branches").select("id");
      branches = allBranchIds.map((b) => b.id);
    }

    if (branches.length > 0) {
      await trx("erp.user_branch").insert(branches.map((bid) => ({ user_id: targetId, branch_id: bid })));
    }

    queueAuditLog(req, {
      entityType: "USER",
      entityId: targetId,
      action: id ? "UPDATE" : "CREATE",
    });
    await trx.commit();
    if (req.xhr) return res.json({ success: true, redirect: "/administration/users" });
    res.redirect("/administration/users");
  } catch (err) {
    await trx.rollback();
    console.error(`[${req.id}] [users:save]`, err);
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", "administration.users", "delete"), async (req, res, next) => {
  try {
    const user = await knex("erp.users").select("status").where({ id: req.params.id }).first();
    if (!user) throw new HttpError(404, "User not found");
    const nextStatus = String(user.status || "").toLowerCase() === "active" ? "Inactive" : "Active";
    await knex("erp.users").where({ id: req.params.id }).update({ status: nextStatus });
    queueAuditLog(req, { entityType: "USER", entityId: req.params.id, action: "DELETE" });
    if (req.xhr) return res.json({ success: true, status: nextStatus });
    res.redirect("/administration/users");
  } catch (err) {
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "administration.users", "hard_delete"), async (req, res, next) => {
  const trx = await knex.transaction();
  try {
    const user = await trx("erp.users").select("id").where({ id: req.params.id }).first();
    if (!user) throw new HttpError(404, "User not found");
    await trx("erp.user_branch").where({ user_id: req.params.id }).del();
    await trx("erp.user_sessions").where({ user_id: req.params.id }).del();
    await trx("erp.user_permissions_override").where({ user_id: req.params.id }).del();
    await trx("erp.users").where({ id: req.params.id }).del();
    queueAuditLog(req, { entityType: "USER", entityId: req.params.id, action: "DELETE" });
    await trx.commit();
    if (req.xhr) return res.json({ success: true });
    res.redirect("/administration/users");
  } catch (err) {
    await trx.rollback();
    if (req.xhr) return res.status(err.status || 500).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
