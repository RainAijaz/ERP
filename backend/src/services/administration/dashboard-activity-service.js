// Admin Home Dashboard — Section 4 recent activity feed.
//
// Paginated, filterable feed over erp.activity_log, joined to users/branches and
// run through the shared activity-log presenter so labels, action styling and
// "View Record" links match the audit screen. Admin-only (enforced at the route).

const { presentActivityRows } = require("./activity-log-presenter");

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;

const toPositiveNumber = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());

// Admin Home feed is admin-only and consolidated across ALL branches, so branch
// scoping is intentionally a no-op (active-branch selector must not filter it).
const applyActiveBranchScope = (_req, qb) => qb;

const localizedUserName = (knex, req) =>
  String(req?.locale || "").trim().toLowerCase().startsWith("ur")
    ? knex.raw("COALESCE(u.name_ur, u.name, u.username) as user_name")
    : knex.raw("COALESCE(u.name, u.username) as user_name");

const applyFeedFilters = (qb, filters) => {
  const userId = toPositiveNumber(filters.user);
  if (userId > 0) qb.where("al.user_id", userId);

  const moduleType = String(filters.module || "").trim();
  if (moduleType) qb.where("al.entity_type", moduleType);

  const action = String(filters.action || "").trim().toUpperCase();
  if (action) qb.where("al.action", action);

  if (isIsoDate(filters.from)) qb.where("al.created_at", ">=", `${filters.from} 00:00:00`);
  if (isIsoDate(filters.to)) qb.where("al.created_at", "<=", `${filters.to} 23:59:59`);
  return qb;
};

const loadActivityFeed = async ({ knex, req, t, query = {} }) => {
  const page = Math.max(1, toPositiveNumber(query.page) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    toPositiveNumber(query.pageSize) || DEFAULT_PAGE_SIZE,
  );
  const offset = (page - 1) * pageSize;

  try {
    const rows = await knex("erp.activity_log as al")
      .leftJoin("erp.users as u", "u.id", "al.user_id")
      .leftJoin("erp.branches as b", "b.id", "al.branch_id")
      .select(
        "al.id",
        "al.branch_id",
        "al.user_id",
        "al.entity_type",
        "al.entity_id",
        "al.voucher_type_code",
        "al.action",
        "al.created_at",
        "al.context_json",
        localizedUserName(knex, req),
        "b.name as branch_name",
      )
      .modify((qb) => applyFeedFilters(qb, query))
      .modify((qb) => applyActiveBranchScope(req, qb, "al.branch_id"))
      .orderBy("al.created_at", "desc")
      .orderBy("al.id", "desc")
      .limit(pageSize + 1) // one extra row signals hasMore
      .offset(offset);

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = presentActivityRows({ rows: pageRows, t }).map((row) => ({
      id: row.id,
      user_name: row.user_name || t("system"),
      user_id: row.user_id || null,
      date: row.display_date,
      time: row.display_time,
      action: row.display_action,
      action_class: row.action_class,
      module: row.entity_label,
      reference: row.entity_id_label,
      summary: row.summary,
      href: row.entity_href || null,
    }));

    return { items, page, pageSize, hasMore };
  } catch (err) {
    console.error("DashboardActivity feed error:", err?.message || err);
    return { items: [], page, pageSize, hasMore: false };
  }
};

// Distinct filter options (users seen in the log, modules, actions).
const loadActivityFilterOptions = async ({ knex, req }) => {
  const nameCol = localizedUserName(knex, req);
  const [users, modules, actions] = await Promise.all([
    knex("erp.activity_log as al")
      .leftJoin("erp.users as u", "u.id", "al.user_id")
      .whereNotNull("al.user_id")
      .modify((qb) => applyActiveBranchScope(req, qb, "al.branch_id"))
      .distinct("al.user_id")
      .select(nameCol)
      .orderBy("user_name", "asc")
      .then((rows) =>
        rows
          .filter((r) => r.user_id)
          .map((r) => ({ id: r.user_id, name: r.user_name || `#${r.user_id}` })),
      )
      .catch(() => []),
    knex("erp.activity_log as al")
      .modify((qb) => applyActiveBranchScope(req, qb, "al.branch_id"))
      .distinct("al.entity_type")
      .orderBy("al.entity_type", "asc")
      .pluck("al.entity_type")
      .then((rows) => rows.filter(Boolean))
      .catch(() => []),
    knex("erp.activity_log as al")
      .modify((qb) => applyActiveBranchScope(req, qb, "al.branch_id"))
      .distinct("al.action")
      .orderBy("al.action", "asc")
      .pluck("al.action")
      .then((rows) => rows.filter(Boolean))
      .catch(() => []),
  ]);
  return { users, modules, actions };
};

module.exports = {
  loadActivityFeed,
  loadActivityFilterOptions,
};
