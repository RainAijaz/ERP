const {
  BASIC_INFO_ENTITY_TYPES,
  SCREEN_ENTITY_TYPES,
} = require("../../utils/approval-entity-map");
const {
  buildActivityAccessScope,
  applyActivityAccessScope,
} = require("./activity-access-service");

const toCount = (row) => {
  const value = Number(row?.count || 0);
  return Number.isFinite(value) ? value : 0;
};

const getCan = (canFn, scopeType, scopeKey, action) => {
  if (typeof canFn !== "function") return false;
  try {
    return Boolean(canFn(scopeType, scopeKey, action));
  } catch (_err) {
    return false;
  }
};

const toPositiveNumber = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const applyActiveBranchScope = (req, qb, column = "branch_id") => {
  if (!qb || typeof qb.where !== "function") return qb;
  const activeBranchId = toPositiveNumber(req?.branchId);
  if (activeBranchId > 0) {
    qb.where(column, activeBranchId);
    return qb;
  }
  if (req && typeof req.applyBranchScope === "function") {
    req.applyBranchScope(qb, column);
  }
  return qb;
};

const safeCount = async (label, factory) => {
  try {
    const row = await factory();
    return toCount(row);
  } catch (err) {
    console.error("Error in DashboardService count:", {
      label,
      error: err?.message || err,
    });
    return 0;
  }
};

const safeRows = async (label, factory) => {
  try {
    const rows = await factory();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error("Error in DashboardService rows:", {
      label,
      error: err?.message || err,
    });
    return [];
  }
};

const ACTIVE_SESSION_WINDOW_MINUTES = Math.max(
  1,
  Number(process.env.DASHBOARD_ACTIVE_SESSION_WINDOW_MINUTES || 15),
);

const MASTER_DATA_ENTITY_TYPES = Array.from(
  new Set([
    ...Object.values(BASIC_INFO_ENTITY_TYPES),
    ...Object.entries(SCREEN_ENTITY_TYPES)
      .filter(([scopeKey]) => String(scopeKey || "").startsWith("master_data."))
      .map(([, entityType]) => entityType),
  ]),
);

const loadDashboardData = async ({ knex, req, can }) => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const activeSessionCutoff = new Date(
    now.getTime() - ACTIVE_SESSION_WINDOW_MINUTES * 60 * 1000,
  );
  const activeBranchId = toPositiveNumber(req?.branchId);

  const canViewApprovals = getCan(
    can,
    "SCREEN",
    "administration.approvals",
    "view",
  );
  const canViewUsers = getCan(can, "SCREEN", "administration.users", "view");
  const activityAccessScope = buildActivityAccessScope({
    can,
    user: req?.user,
  });

  const [
    pendingApprovals,
    vouchersToday,
    masterDataChangesToday,
    totalLogsToday,
    activeUsers,
    totalUsers,
    recentApprovals,
    recentVouchers,
    recentActivity,
  ] = await Promise.all([
    safeCount("pendingApprovals", () => {
      const qb = knex("erp.approval_request")
        .where({ status: "PENDING" })
        .count("* as count")
        .first();
      return applyActiveBranchScope(req, qb, "branch_id");
    }),
    safeCount("vouchersToday", () => {
      const qb = knex("erp.voucher_header")
        .whereBetween("voucher_date", [startOfDay, endOfDay])
        .count("* as count")
        .first();
      return applyActiveBranchScope(req, qb, "branch_id");
    }),
    safeCount("masterDataChangesToday", () => {
      if (!MASTER_DATA_ENTITY_TYPES.length)
        return Promise.resolve({ count: 0 });
      const qb = knex("erp.activity_log as al")
        .whereBetween("al.created_at", [startOfDay, endOfDay])
        .whereIn("al.entity_type", MASTER_DATA_ENTITY_TYPES)
        .count("* as count")
        .first();
      applyActivityAccessScope({
        qb,
        access: activityAccessScope,
        userId: req?.user?.id,
        tableAlias: "al",
      });
      return qb;
    }),
    safeCount("totalLogsToday", () => {
      const qb = knex("erp.activity_log as al")
        .whereBetween("al.created_at", [startOfDay, endOfDay])
        .count("* as count")
        .first();
      applyActiveBranchScope(req, qb, "al.branch_id");
      applyActivityAccessScope({
        qb,
        access: activityAccessScope,
        userId: req?.user?.id,
        tableAlias: "al",
      });
      return qb;
    }),
    canViewUsers
      ? safeCount("activeUsers", () => {
          const qb = knex("erp.user_sessions as us")
            .where({ "us.is_revoked": false })
            .andWhere("us.expires_at", ">", now)
            .andWhere("us.last_seen_at", ">=", activeSessionCutoff)
            .countDistinct("us.user_id as count")
            .first();

          if (activeBranchId > 0) {
            qb.join("erp.user_branch as ub", "ub.user_id", "us.user_id").where(
              "ub.branch_id",
              activeBranchId,
            );
          }

          return qb;
        })
      : Promise.resolve({ count: 0 }),
    canViewUsers
      ? safeCount("totalUsers", () =>
          knex("erp.users")
            .where({ status: "Active" })
            .count("* as count")
            .first(),
        )
      : Promise.resolve({ count: 0 }),
    canViewApprovals
      ? safeRows("recentApprovals", () => {
          const qb = knex("erp.approval_request as ar")
            .leftJoin("erp.users as u", "u.id", "ar.requested_by")
            .select(
              "ar.id",
              "ar.entity_type",
              "ar.status",
              "ar.requested_at",
              "ar.branch_id",
              "u.username as requested_by_name",
            )
            .where({ "ar.status": "PENDING" })
            .orderBy("ar.requested_at", "desc")
            .limit(6);
          return applyActiveBranchScope(req, qb, "ar.branch_id");
        })
      : Promise.resolve([]),
    safeRows("recentVouchers", () => {
      const qb = knex("erp.voucher_header as vh")
        .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
        .select(
          "vh.id",
          "vh.voucher_no",
          "vh.voucher_type_code",
          "vh.voucher_date",
          "vh.status",
          "b.name as branch_name",
        )
        .orderBy("vh.id", "desc")
        .limit(6);
      return applyActiveBranchScope(req, qb, "vh.branch_id");
    }),
    safeRows("recentActivity", () => {
      const localizedUserNameColumn = String(req?.locale || "")
        .trim()
        .toLowerCase()
        .startsWith("ur")
        ? knex.raw("COALESCE(u.name_ur, u.name, u.username) as username")
        : knex.raw("COALESCE(u.name, u.username) as username");
      const qb = knex("erp.activity_log as al")
        .leftJoin("erp.users as u", "u.id", "al.user_id")
        .select(
          "al.action",
          "al.entity_type",
          "al.created_at",
          localizedUserNameColumn,
        )
        .orderBy("al.created_at", "desc")
        .limit(8);
      applyActiveBranchScope(req, qb, "al.branch_id");
      applyActivityAccessScope({
        qb,
        access: activityAccessScope,
        userId: req?.user?.id,
        tableAlias: "al",
      });
      return qb;
    }),
  ]);

  return {
    summary: {
      pendingApprovals,
      vouchersToday,
      masterDataChangesToday,
      totalLogsToday,
      activeUsers,
      totalUsers,
      activeSessionWindowMinutes: ACTIVE_SESSION_WINDOW_MINUTES,
    },
    recentApprovals,
    recentVouchers,
    recentActivity,
    generatedAt: now.toISOString(),
  };
};

module.exports = {
  loadDashboardData,
};
