const express = require("express");
const knex = require("../../db/knex");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  presentActivityRows,
} = require("../../services/administration/activity-log-presenter");
const {
  buildActivityAccessScope,
  applyActivityAccessScope,
  filterEntityTypeRowsByAccess,
} = require("../../services/administration/activity-access-service");

const router = express.Router();

const parseContextJson = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_err) {
    return null;
  }
};

const getScopeKeyFromContext = (context) => {
  const scopeKey =
    context?.scope_key ||
    context?.scopeKey ||
    context?.new_value?._scope_key ||
    context?.new_value?.scope_key ||
    context?.old_value?._scope_key ||
    context?.old_value?.scope_key ||
    context?.request_body?._scope_key ||
    context?.request_body?.scope_key ||
    "";
  return String(scopeKey || "").trim();
};

const hasEntityName = (context) => {
  if (!context) return false;
  const candidates = [
    context.entity_name,
    context.entity_label,
    context.name,
    context.item_name,
    context.sku_name,
    context.sku_code,
    context.article_name,
    context.new_value?.name,
    context.new_value?.item_name,
    context.new_value?.sku_name,
    context.new_value?.sku_code,
    context.new_value?.article_name,
    context.old_value?.name,
    context.old_value?.item_name,
    context.old_value?.sku_name,
    context.old_value?.sku_code,
    context.old_value?.article_name,
    context.request_body?.name,
    context.request_body?.item_name,
    context.request_body?.sku_name,
    context.request_body?.sku_code,
    context.request_body?.article_name,
  ];
  return candidates.some((value) => String(value || "").trim());
};

const ACTIVITY_LOG_REPORT_TIME_ZONE =
  String(
    process.env.ERP_REPORT_TIME_ZONE || process.env.TZ || "Asia/Karachi",
  ).trim() || "Asia/Karachi";

const getTodayInReportTimeZone = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ACTIVITY_LOG_REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  if (!year || !month || !day) return new Date().toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
};

const parseIds = (value) => {
  if (!value) return [];
  if (Array.isArray(value))
    return value
      .map((entry) => Number(entry))
      .filter((id) => !Number.isNaN(id));
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
  if (Array.isArray(value))
    return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === "object")
    return Object.values(value).map(String).filter(Boolean);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const renderPage = (req, res, payload = {}) =>
  res.render("base/layouts/main", {
    title: res.locals.t("audit_logs"),
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../administration/audit-logs/index",
    t: res.locals.t,
    ...payload,
  });

router.get(
  "/",
  requirePermission("SCREEN", "administration.audit_logs", "view"),
  async (req, res, next) => {
    try {
      const canViewDetails = Boolean(req.user?.isAdmin);
      const userMode =
        req.query.user_mode === "exclude" ? "exclude" : "include";
      const userIds = parseIds(req.query.user_ids);
      const today = getTodayInReportTimeZone();
      const startDate = req.query.start_date
        ? String(req.query.start_date)
        : today;
      const endDate = req.query.end_date ? String(req.query.end_date) : today;
      const entityTypeFilters = parseList(req.query.entity_type);
      const entityMode =
        req.query.entity_mode === "exclude" ? "exclude" : "include";
      const branchIds = parseIds(req.query.branch_id);
      const branchMode =
        req.query.branch_mode === "exclude" ? "exclude" : "include";
      const actionTypeFilters = parseList(req.query.action);
      const actionMode =
        req.query.action_mode === "exclude" ? "exclude" : "include";
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSizeRaw = Number(req.query.page_size) || 100;
      const pageSize = Math.min(500, Math.max(25, pageSizeRaw));
      const offset = (page - 1) * pageSize;
      const activityAccessScope = buildActivityAccessScope({
        can: res.locals.can,
        user: req.user,
      });

      const [users, entityTypes, actionTypes] = await Promise.all([
        knex("erp.users").select("id", "username").orderBy("username"),
        knex("erp.entity_type_registry")
          .select("code", "name")
          .where({ is_active: true })
          .orderBy("name", "asc"),
        knex("erp.audit_action_registry")
          .select("code", "name")
          .where({ is_active: true })
          .orderBy("name", "asc"),
      ]);

      const baseQuery = knex("erp.activity_log as al")
        .select(
          "al.id",
          "al.created_at",
          "al.entity_type",
          "al.entity_id",
          "al.voucher_type_code",
          "al.action",
          canViewDetails
            ? "al.context_json"
            : knex.raw("NULL::jsonb as context_json"),
          "u.username as user_name",
          "b.name as branch_name",
          "b.code as branch_code",
        )
        .leftJoin("erp.users as u", "al.user_id", "u.id")
        .leftJoin("erp.branches as b", "al.branch_id", "b.id")
        .orderBy("al.created_at", "desc");

      applyActivityAccessScope({
        qb: baseQuery,
        access: activityAccessScope,
        userId: req.user?.id,
        tableAlias: "al",
      });

      if (req.applyBranchScope) {
        req.applyBranchScope(baseQuery, "al.branch_id");
      }

      if (userIds.length) {
        if (userMode === "exclude") {
          baseQuery.whereNotIn("al.user_id", userIds);
        } else {
          baseQuery.whereIn("al.user_id", userIds);
        }
      }

      if (branchIds.length) {
        if (branchMode === "exclude") {
          baseQuery.whereNotIn("al.branch_id", branchIds);
        } else {
          baseQuery.whereIn("al.branch_id", branchIds);
        }
      }

      if (entityTypeFilters.length) {
        if (entityMode === "exclude") {
          baseQuery.whereNotIn("al.entity_type", entityTypeFilters);
        } else {
          baseQuery.whereIn("al.entity_type", entityTypeFilters);
        }
      }

      if (actionTypeFilters.length) {
        if (actionMode === "exclude") {
          baseQuery.whereNotIn("al.action", actionTypeFilters);
        } else {
          baseQuery.whereIn("al.action", actionTypeFilters);
        }
      }

      baseQuery.whereRaw(
        `(al.created_at AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date`,
        [ACTIVITY_LOG_REPORT_TIME_ZONE, startDate, endDate],
      );

      const [rows, totalRow] = await Promise.all([
        baseQuery.clone().limit(pageSize).offset(offset),
        knex
          .from(baseQuery.clone().clearSelect().clearOrder().as("q"))
          .count("* as total")
          .first(),
      ]);

      const parsedRows = rows.map((row) => {
        const context = parseContextJson(row.context_json) || {};
        return { row, context };
      });
      const employeeIds = new Set();
      const labourIds = new Set();
      const labourRateRuleIds = new Set();
      parsedRows.forEach(({ row, context }) => {
        if (!context || hasEntityName(context)) return;
        const entityId = Number(row?.entity_id || 0);
        if (!Number.isInteger(entityId) || entityId <= 0) return;
        const entityType = String(row?.entity_type || "").toUpperCase();
        const scopeKey = getScopeKeyFromContext(context).toLowerCase();
        if (entityType === "EMPLOYEE") {
          employeeIds.add(entityId);
          return;
        }
        if (entityType !== "LABOUR") return;
        if (scopeKey === "hr_payroll.labour_rates") {
          labourRateRuleIds.add(entityId);
          return;
        }
        labourIds.add(entityId);
      });

      const [employeeRows, labourRateRows] = await Promise.all([
        employeeIds.size
          ? knex("erp.employees").select("id", "name").whereIn("id", [...employeeIds])
          : Promise.resolve([]),
        labourRateRuleIds.size
          ? knex("erp.labour_rate_rules as lrr")
              .select("lrr.id", "lrr.labour_id", "l.name as labour_name")
              .leftJoin("erp.labours as l", "l.id", "lrr.labour_id")
              .whereIn("lrr.id", [...labourRateRuleIds])
          : Promise.resolve([]),
      ]);

      const labourRateById = new Map(
        labourRateRows.map((row) => [Number(row.id), String(row.labour_name || "").trim()]),
      );
      const fallbackLabourIds = new Set(labourIds);
      parsedRows.forEach(({ row, context }) => {
        if (!context || hasEntityName(context)) return;
        const entityType = String(row?.entity_type || "").toUpperCase();
        if (entityType !== "LABOUR") return;
        const scopeKey = getScopeKeyFromContext(context).toLowerCase();
        if (scopeKey !== "hr_payroll.labour_rates") return;
        const entityId = Number(row?.entity_id || 0);
        if (!Number.isInteger(entityId) || entityId <= 0) return;
        if (labourRateById.has(entityId)) return;
        fallbackLabourIds.add(entityId);
      });

      const labourRows = fallbackLabourIds.size
        ? await knex("erp.labours").select("id", "name").whereIn("id", [...fallbackLabourIds])
        : [];
      const employeeNameById = new Map(
        employeeRows.map((row) => [Number(row.id), String(row.name || "").trim()]),
      );
      const labourNameById = new Map(
        labourRows.map((row) => [Number(row.id), String(row.name || "").trim()]),
      );

      parsedRows.forEach(({ row, context }) => {
        if (!context || hasEntityName(context)) {
          row.context_json = context;
          return;
        }
        const entityId = Number(row?.entity_id || 0);
        if (!Number.isInteger(entityId) || entityId <= 0) {
          row.context_json = context;
          return;
        }
        const entityType = String(row?.entity_type || "").toUpperCase();
        if (entityType === "EMPLOYEE") {
          const name = employeeNameById.get(entityId);
          if (name) context.entity_name = name;
          row.context_json = context;
          return;
        }
        if (entityType === "LABOUR") {
          const scopeKey = getScopeKeyFromContext(context).toLowerCase();
          if (scopeKey === "hr_payroll.labour_rates") {
            const name = labourRateById.get(entityId) || labourNameById.get(entityId);
            if (name) context.entity_name = name;
          } else {
            const name = labourNameById.get(entityId);
            if (name) context.entity_name = name;
          }
        }
        row.context_json = context;
      });
      const total = Number(totalRow?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const hasNext = page < totalPages;
      const hasPrev = page > 1;

      const buildPageUrl = (targetPage) => {
        const params = new URLSearchParams();
        Object.entries(req.query || {}).forEach(([key, value]) => {
          if (key === "page") return;
          if (Array.isArray(value)) {
            value
              .filter((entry) => entry !== "")
              .forEach((entry) => params.append(key, String(entry)));
            return;
          }
          if (value == null || value === "") return;
          params.append(key, String(value));
        });
        params.set("page", String(targetPage));
        params.set("page_size", String(pageSize));
        return `?${params.toString()}`;
      };

      const presentedRows = presentActivityRows({
        rows,
        t: res.locals.t,
      });

      const visibleEntityTypes = filterEntityTypeRowsByAccess({
        rows: entityTypes,
        access: activityAccessScope,
      });

      renderPage(req, res, {
        rows: presentedRows,
        users,
        branches: req.branchOptions || [],
        entityTypes: visibleEntityTypes,
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
          page_size: pageSize,
        },
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
          hasNext,
          hasPrev,
          nextUrl: hasNext ? buildPageUrl(page + 1) : null,
          prevUrl: hasPrev ? buildPageUrl(page - 1) : null,
        },
        canViewDetails,
      });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
