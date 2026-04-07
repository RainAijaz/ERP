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

const applyBranchScope = (req, qb, column = "branch_id") => {
  if (!qb || typeof qb.whereIn !== "function") return qb;
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

const buildQuickActions = (canFn) => {
  const actions = [
    {
      key: "quick_master_data",
      href: "/master-data/basic-info/units",
      icon: "M3 7h18M3 12h18M3 17h18",
      allowed:
        getCan(canFn, "MODULE", "master_data", "navigate") ||
        getCan(canFn, "SCREEN", "master_data.basic_info.units", "navigate"),
    },
    {
      key: "quick_approvals",
      href: "/administration/approvals",
      icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
      allowed: getCan(canFn, "SCREEN", "administration.approvals", "view"),
    },
    {
      key: "quick_vouchers",
      href: "/vouchers/cash",
      icon: "M4 7h16M4 12h16M4 17h10",
      allowed: getCan(canFn, "MODULE", "financial", "navigate"),
    },
    {
      key: "quick_reports",
      href: "/reports/financial/accounts",
      icon: "M6 20V10m6 10V4m6 16v-6",
      allowed: getCan(canFn, "MODULE", "financial", "navigate"),
    },
    {
      key: "quick_users",
      href: "/administration/users",
      icon: "M16 11c1.7 0 3-1.3 3-3s-1.3-3-3-3-3 1.3-3 3 1.3 3 3 3zM8 13c1.7 0 3-1.3 3-3S9.7 7 8 7s-3 1.3-3 3 1.3 3 3 3zM2 20c0-2.8 2.2-5 5-5M22 20c0-2.8-2.2-5-5-5",
      allowed: getCan(canFn, "SCREEN", "administration.users", "navigate"),
    },
    {
      key: "quick_stock",
      href: "/reports/inventory/stock-ledger",
      icon: "M4 6h16v12H4zM8 10h8",
      allowed: getCan(canFn, "MODULE", "inventory", "navigate"),
    },
  ];

  return actions.filter((action) => action.allowed);
};

const loadDashboardData = async ({ knex, req, can }) => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const canViewApprovals = getCan(can, "SCREEN", "administration.approvals", "view");

  const [
    pendingApprovals,
    vouchersToday,
    vouchersThisMonth,
    inventoryMovementsToday,
    activeSkus,
    activeUsers,
    totalUsers,
    recentApprovals,
    recentVouchers,
    recentActivity,
  ] = await Promise.all([
    safeCount("pendingApprovals", () => {
      const qb = knex("erp.approval_request").where({ status: "PENDING" }).count("* as count").first();
      return applyBranchScope(req, qb, "branch_id");
    }),
    safeCount("vouchersToday", () => {
      const qb = knex("erp.voucher_header")
        .whereBetween("voucher_date", [startOfDay, endOfDay])
        .count("* as count")
        .first();
      return applyBranchScope(req, qb, "branch_id");
    }),
    safeCount("vouchersThisMonth", () => {
      const qb = knex("erp.voucher_header")
        .where("voucher_date", ">=", startOfMonth)
        .count("* as count")
        .first();
      return applyBranchScope(req, qb, "branch_id");
    }),
    safeCount("inventoryMovementsToday", () => {
      const qb = knex("erp.stock_ledger")
        .whereBetween("txn_date", [startOfDay, endOfDay])
        .count("* as count")
        .first();
      return applyBranchScope(req, qb, "branch_id");
    }),
    safeCount("activeSkus", () =>
      knex("erp.skus")
        .where({ is_active: true })
        .count("* as count")
        .first(),
    ),
    safeCount("activeUsers", () =>
      knex("erp.users")
        .where({ status: "Active" })
        .count("* as count")
        .first(),
    ),
    safeCount("totalUsers", () => knex("erp.users").count("* as count").first()),
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
          return applyBranchScope(req, qb, "ar.branch_id");
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
      return applyBranchScope(req, qb, "vh.branch_id");
    }),
    safeRows("recentActivity", () => {
      const qb = knex("erp.activity_log as al")
        .leftJoin("erp.users as u", "u.id", "al.user_id")
        .select("al.action", "al.entity_type", "al.created_at", "u.username")
        .orderBy("al.created_at", "desc")
        .limit(8);
      return applyBranchScope(req, qb, "al.branch_id");
    }),
  ]);

  return {
    summary: {
      pendingApprovals,
      vouchersToday,
      vouchersThisMonth,
      inventoryMovementsToday,
      activeSkus,
      activeUsers,
      totalUsers,
      branchCount: Array.isArray(req.branchScope) ? req.branchScope.length : 0,
    },
    quickActions: buildQuickActions(can),
    recentApprovals,
    recentVouchers,
    recentActivity,
    generatedAt: now.toISOString(),
  };
};

module.exports = {
  loadDashboardData,
};
