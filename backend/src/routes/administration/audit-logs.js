const express = require("express");
const knex = require("../../db/knex");
const { requirePermission } = require("../../middleware/access/role-permissions");

const router = express.Router();

const parseIds = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => Number(entry)).filter((id) => !Number.isNaN(id));
  if (typeof value === "object")
    return Object.values(value)
      .map(Number)
      .filter((id) => !Number.isNaN(id));
  return String(value)
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((id) => !Number.isNaN(id));
};

const parseList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === "object") return Object.values(value).map(String).filter(Boolean);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const renderPage = (req, res, payload = {}) =>
  res.render("base/layouts/main", {
    title: res.locals.t("audit_logs") || "Audit Logs",
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../administration/audit-logs/index",
    t: res.locals.t,
    ...payload,
  });

router.get("/", requirePermission("SCREEN", "administration.audit_logs", "view"), async (req, res, next) => {
  try {
    const userMode = req.query.user_mode === "exclude" ? "exclude" : "include";
    const userIds = parseIds(req.query.user_ids);
    const today = new Date().toISOString().slice(0, 10);
    const startDate = req.query.start_date ? String(req.query.start_date) : today;
    const endDate = req.query.end_date ? String(req.query.end_date) : today;
    const entityTypeFilters = parseList(req.query.entity_type);
    const entityMode = req.query.entity_mode === "exclude" ? "exclude" : "include";
    const branchIds = parseIds(req.query.branch_id);
    const branchMode = req.query.branch_mode === "exclude" ? "exclude" : "include";
    const actionTypeFilters = parseList(req.query.action);
    const actionMode = req.query.action_mode === "exclude" ? "exclude" : "include";

    const users = await knex("erp.users").select("id", "username").orderBy("username");
    const entityTypes = await knex("erp.entity_type_registry").select("code", "name").where({ is_active: true }).orderBy("name", "asc");
    const actionTypes = await knex("erp.audit_action_registry").select("code", "name").where({ is_active: true }).orderBy("name", "asc");

    const query = knex("erp.activity_log as al").select("al.id", "al.created_at", "al.entity_type", "al.entity_id", "al.action", "u.username as user_name", "b.name as branch_name", "b.code as branch_code").leftJoin("erp.users as u", "al.user_id", "u.id").leftJoin("erp.branches as b", "al.branch_id", "b.id").orderBy("al.created_at", "desc");

    if (req.applyBranchScope) {
      req.applyBranchScope(query, "al.branch_id");
    }

    if (userIds.length) {
      if (userMode === "exclude") {
        query.whereNotIn("al.user_id", userIds);
      } else {
        query.whereIn("al.user_id", userIds);
      }
    }

    if (branchIds.length) {
      if (branchMode === "exclude") {
        query.whereNotIn("al.branch_id", branchIds);
      } else {
        query.whereIn("al.branch_id", branchIds);
      }
    }

    if (entityTypeFilters.length) {
      if (entityMode === "exclude") {
        query.whereNotIn("al.entity_type", entityTypeFilters);
      } else {
        query.whereIn("al.entity_type", entityTypeFilters);
      }
    }

    if (actionTypeFilters.length) {
      if (actionMode === "exclude") {
        query.whereNotIn("al.action", actionTypeFilters);
      } else {
        query.whereIn("al.action", actionTypeFilters);
      }
    }

    query.whereBetween("al.created_at", [startDate, `${endDate} 23:59:59`]);

    const rows = await query;

    renderPage(req, res, {
      rows,
      users,
      branches: req.branchOptions || [],
      entityTypes,
      actionTypes,
      filters: {
        user_mode: userMode,
        user_ids: userIds,
        start_date: startDate,
        end_date: endDate,
        branch_id: branchIds,
        branch_mode: branchMode,
        entity_type: entityTypeFilters,
        entity_mode: entityMode,
        action: actionTypeFilters,
        action_mode: actionMode,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
