// Admin Home Dashboard — executive KPI + alert aggregates.
//
// Design notes:
//   - Every metric is wrapped in safeValue/safeCount/safeRows so a failing query
//     degrades to 0 / null / [] instead of breaking the homepage.
//   - Money figures are sourced from erp.gl_entry (the accounting source of
//     truth already trusted by the financial report service), restricted to
//     APPROVED vouchers (manual GL batches with no source voucher are included).
//   - Each metric is permission-gated with res.locals.can(...) using the real
//     runtime scope keys (REPORT/SCREEN). When the user lacks the scope the
//     metric is returned as null so the view can hide the card.
//   - Data sources that do not exist yet return null and are surfaced in the UI
//     as "Not tracked" rather than a misleading 0:
//       * productionProgressPct  — no plan target/completion tracking
//       * alerts.overduePayables — purchase invoices have no due-date column
//       * alerts.employeesAbsent — no attendance module
//       * alerts.productionBehindSchedule — no production schedule/due date

const toNumber = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getCan = (canFn, scopeType, scopeKey, action = "view") => {
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

// The Admin Home dashboard is admin-only and always shows company-wide totals
// consolidated across ALL branches, so branch scoping is intentionally a no-op
// here (the active-branch selector must not change these numbers).
const applyBranchScope = (_req, qb) => qb;

const safeValue = async (label, factory) => {
  try {
    const row = await factory();
    return toNumber(row?.value);
  } catch (err) {
    console.error("DashboardMetrics value error:", { label, error: err?.message || err });
    return 0;
  }
};

const safeCount = async (label, factory) => {
  try {
    const row = await factory();
    return toNumber(row?.count);
  } catch (err) {
    console.error("DashboardMetrics count error:", { label, error: err?.message || err });
    return 0;
  }
};

const safeRows = async (label, factory) => {
  try {
    const rows = await factory();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error("DashboardMetrics rows error:", { label, error: err?.message || err });
    return [];
  }
};

const toDateKey = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const loadDashboardMetrics = async ({ knex, req, can }) => {
  const now = new Date();
  const todayKey = toDateKey(now);
  const startOfMonthKey = toDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  // Week starts Monday.
  const weekOffset = (now.getDay() + 6) % 7;
  const startOfWeekKey = toDateKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - weekOffset),
  );

  // Permission gates (real runtime scope keys).
  const canSales = getCan(can, "REPORT", "sales_report");
  const canCash = getCan(can, "REPORT", "cash_book");
  const canCustomerBalances =
    getCan(can, "REPORT", "customer_balances") || getCan(can, "REPORT", "sales_report");
  const canSupplierBalances = getCan(can, "REPORT", "supplier_balances");
  const canInventory =
    getCan(can, "REPORT", "stock_quantity") || getCan(can, "REPORT", "stock_ledger");
  const canProduction = getCan(can, "REPORT", "production_report");
  const canPurchase = getCan(can, "REPORT", "purchase_report");
  const canApprovals = getCan(can, "SCREEN", "administration.approvals");

  // Restrict GL to approved vouchers (or manual batches with no source voucher).
  const approvedVoucherScope = (qb) => {
    qb.leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
      .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
      .where(function approvedOrManual() {
        this.whereNull("vh.id").orWhere("vh.status", "APPROVED");
      });
  };

  // --- Money KPI query builders -------------------------------------------

  const revenueBetween = (fromKey, toKey) =>
    knex("erp.gl_entry as ge")
      .join("erp.accounts as a", "a.id", "ge.account_id")
      .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
      .modify(approvedVoucherScope)
      .where("ag.account_type", "REVENUE")
      .whereBetween("ge.entry_date", [fromKey, toKey])
      .modify((qb) => applyBranchScope(req, qb, "ge.branch_id"))
      .select(
        knex.raw("COALESCE(SUM(COALESCE(ge.cr,0) - COALESCE(ge.dr,0)),0) as value"),
      )
      .first();

  // Net dozens sold (packed & loose) over a date range. Pairs live in
  // voucher_line.meta.total_pairs; movement_kind defaults to SALE. Dozens = pairs/12.
  const dozensSoldBetween = (fromKey, toKey) =>
    knex("erp.voucher_line as vl")
      .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
      .where("vh.voucher_type_code", "SALES_VOUCHER")
      .andWhere("vh.status", "APPROVED")
      .andWhere("vl.line_kind", "SKU")
      .whereRaw("COALESCE(vl.meta->>'movement_kind','SALE') = 'SALE'")
      .whereBetween("vh.voucher_date", [fromKey, toKey])
      .select(
        knex.raw(
          "COALESCE(SUM(COALESCE((vl.meta->>'total_pairs')::numeric, vl.qty)),0) / 12.0 as value",
        ),
      )
      .first();

  const cashBankBalance = () =>
    knex("erp.gl_entry as ge")
      .join("erp.accounts as a", "a.id", "ge.account_id")
      .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
      .modify(approvedVoucherScope)
      .whereRaw("lower(COALESCE(apc.code,'')) in ('cash','bank')")
      .where("ge.entry_date", "<=", todayKey)
      .modify((qb) => applyBranchScope(req, qb, "ge.branch_id"))
      .select(
        knex.raw("COALESCE(SUM(COALESCE(ge.dr,0) - COALESCE(ge.cr,0)),0) as value"),
      )
      .first();

  // Sum of per-party positive balances (receivable) / negative balances (payable).
  const partyBalanceTotal = (partyTypes, direction) => {
    // direction: 'RECEIVABLE' keeps parties owing us (dr-cr > 0);
    //            'PAYABLE'    keeps parties we owe   (cr-dr > 0).
    const debitExpr = "COALESCE(ge.dr,0) - COALESCE(ge.cr,0)";
    const partySub = knex("erp.gl_entry as ge")
      .join("erp.parties as p", "p.id", "ge.party_id")
      .whereNotNull("ge.party_id")
      .whereRaw(
        `upper(coalesce(p.party_type::text,'')) in (${partyTypes
          .map(() => "?")
          .join(",")})`,
        partyTypes,
      )
      .where("ge.entry_date", "<=", todayKey)
      .modify((qb) => applyBranchScope(req, qb, "ge.branch_id"))
      .groupBy("ge.party_id")
      .select("ge.party_id")
      .select(knex.raw(`SUM(${debitExpr}) as bal`));

    const outer = knex
      .from(partySub.as("pb"))
      .select(
        knex.raw(
          direction === "PAYABLE"
            ? "COALESCE(SUM(CASE WHEN pb.bal < 0 THEN -pb.bal ELSE 0 END),0) as value"
            : "COALESCE(SUM(CASE WHEN pb.bal > 0 THEN pb.bal ELSE 0 END),0) as value",
        ),
      )
      .first();
    return outer;
  };

  // --- Count KPI builders --------------------------------------------------

  const ordersPending = () =>
    knex("erp.sales_order_header as soh")
      .join("erp.voucher_header as vh", "vh.id", "soh.voucher_id")
      .where("vh.status", "APPROVED")
      .whereNotExists(function linkedInvoice() {
        this.select(1)
          .from("erp.sales_header as sh")
          .whereRaw("sh.linked_sales_order_id = soh.voucher_id");
      })
      .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
      .count("* as count")
      .first();

  const dispatchesToday = () =>
    knex("erp.stock_transfer_out_header as h")
      .join("erp.voucher_header as vh", "vh.id", "h.voucher_id")
      .where("vh.voucher_date", todayKey)
      .where("vh.status", "APPROVED")
      .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
      .count("* as count")
      .first();

  // --- Alert builders ------------------------------------------------------

  // Consolidated across all branches: an item is "below minimum" when its total
  // on-hand across every branch is under its configured minimum.
  const rawMaterialsBelowMin = () =>
    knex("erp.items as i")
      .leftJoin("erp.stock_balance_rm as sb", "sb.item_id", "i.id")
      .where("i.min_stock_level", ">=", 0)
      .groupBy("i.id", "i.min_stock_level")
      .havingRaw("COALESCE(SUM(sb.qty),0) < i.min_stock_level")
      .select("i.id");

  const overdueReceivables = () =>
    knex("erp.sales_header as sh")
      .join("erp.voucher_header as vh", "vh.id", "sh.voucher_id")
      .where("sh.payment_type", "CREDIT")
      .whereNotNull("sh.payment_due_date")
      .where("sh.payment_due_date", "<", todayKey)
      .where("vh.status", "APPROVED")
      .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
      .count("* as count")
      .first();

  // A PO is "awaiting receipt" until a Purchase Invoice links back to it.
  // (GRN header has no PO link column; PI.po_voucher_id is the linkage.)
  const poAwaitingReceipt = () =>
    knex("erp.purchase_order_header_ext as poh")
      .join("erp.voucher_header as vh", "vh.id", "poh.voucher_id")
      .where("vh.status", "APPROVED")
      .whereNotExists(function linkedInvoice() {
        this.select(1)
          .from("erp.purchase_invoice_header_ext as pi")
          .whereRaw("pi.po_voucher_id = poh.voucher_id");
      })
      .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
      .count("* as count")
      .first();

  // Total pending approvals visible to this user.
  const pendingApprovalsTotalQuery = () => {
    const qb = knex("erp.approval_request as ar")
      .where("ar.status", "PENDING")
      .count("* as count")
      .first();
    if (!req.user?.isAdmin) {
      qb.andWhere("ar.requested_by", req.user.id);
      applyBranchScope(req, qb, "ar.branch_id");
    }
    return qb;
  };

  // Pending VOUCHER approvals grouped by voucher type code. entity_id is either
  // a numeric voucher id (edit) or "NEW" (create — type lives in new_value).
  const pendingVoucherApprovalCounts = () => {
    const codeExpr =
      "COALESCE(vh.voucher_type_code, ar.new_value->>'voucher_type_code')";
    const qb = knex("erp.approval_request as ar")
      .leftJoin(
        "erp.voucher_header as vh",
        "vh.id",
        knex.raw("CASE WHEN ar.entity_id ~ '^[0-9]+$' THEN ar.entity_id::bigint ELSE NULL END"),
      )
      .where("ar.status", "PENDING")
      .andWhere("ar.entity_type", "VOUCHER")
      .select(knex.raw(`${codeExpr} as code`))
      .count("* as count")
      .groupBy(knex.raw(codeExpr));
    if (!req.user?.isAdmin) {
      qb.andWhere("ar.requested_by", req.user.id);
      applyBranchScope(req, qb, "ar.branch_id");
    }
    return qb;
  };

  // --- Execute in parallel -------------------------------------------------

  const [
    todaysSales,
    monthlyRevenue,
    cashBank,
    receivable,
    payable,
    ordersPendingCount,
    dispatchesTodayCount,
    rawMatBelowMinRows,
    overdueReceivablesCount,
    poAwaitingReceiptCount,
    approvalsTotalRow,
    voucherApprovalRows,
    dozensToday,
    dozensWeek,
    dozensMonth,
  ] = await Promise.all([
    canSales ? safeValue("todaysSales", () => revenueBetween(todayKey, todayKey)) : Promise.resolve(null),
    canSales ? safeValue("monthlyRevenue", () => revenueBetween(startOfMonthKey, todayKey)) : Promise.resolve(null),
    canCash ? safeValue("cashBank", cashBankBalance) : Promise.resolve(null),
    canCustomerBalances ? safeValue("receivable", () => partyBalanceTotal(["CUSTOMER", "BOTH"], "RECEIVABLE")) : Promise.resolve(null),
    canSupplierBalances ? safeValue("payable", () => partyBalanceTotal(["SUPPLIER", "BOTH"], "PAYABLE")) : Promise.resolve(null),
    canSales ? safeCount("ordersPending", ordersPending) : Promise.resolve(null),
    canInventory ? safeCount("dispatchesToday", dispatchesToday) : Promise.resolve(null),
    canInventory ? safeRows("rawMatBelowMin", rawMaterialsBelowMin) : Promise.resolve([]),
    canCustomerBalances ? safeCount("overdueReceivables", overdueReceivables) : Promise.resolve(null),
    canPurchase ? safeCount("poAwaitingReceipt", poAwaitingReceipt) : Promise.resolve(null),
    canApprovals ? safeCount("pendingApprovalsTotal", pendingApprovalsTotalQuery) : Promise.resolve(0),
    canApprovals ? safeRows("pendingVoucherApprovals", pendingVoucherApprovalCounts) : Promise.resolve([]),
    canSales ? safeValue("dozensToday", () => dozensSoldBetween(todayKey, todayKey)) : Promise.resolve(null),
    canSales ? safeValue("dozensWeek", () => dozensSoldBetween(startOfWeekKey, todayKey)) : Promise.resolve(null),
    canSales ? safeValue("dozensMonth", () => dozensSoldBetween(startOfMonthKey, todayKey)) : Promise.resolve(null),
  ]);

  const rawMaterialsBelowMinCount = rawMatBelowMinRows.length;

  // Bucket pending VOUCHER approvals into the six requested categories by
  // voucher type code. Non-voucher (master-data) approvals still count toward
  // the total but are not shown as one of the six voucher buckets.
  const CODE_BUCKET = {
    PI: "purchase", PO: "purchase", PR: "purchase", GRN: "purchase", GRN_IN: "purchase",
    SALES_VOUCHER: "sales", SALES_ORDER: "sales",
    JOURNAL_VOUCHER: "journal",
    CASH_VOUCHER: "payment", BANK_VOUCHER: "payment",
    STOCK_COUNT_ADJ: "inventory", STN_OUT: "inventory", OPENING_STOCK: "inventory", LOSS: "inventory", CONSUMP: "inventory",
  };
  const approvalBuckets = {
    purchase: 0,
    sales: 0,
    journal: 0,
    payment: 0,
    inventory: 0,
    leave: 0, // no leave module yet -> always 0
  };
  for (const row of voucherApprovalRows) {
    const bucket = CODE_BUCKET[String(row.code || "").toUpperCase()];
    if (bucket) approvalBuckets[bucket] += toNumber(row.count);
  }
  const pendingApprovalsTotal = toNumber(approvalsTotalRow);

  // Critical alerts = sum of actionable open items we can actually count.
  const criticalAlerts =
    toNumber(rawMaterialsBelowMinCount) +
    toNumber(overdueReceivablesCount) +
    toNumber(poAwaitingReceiptCount) +
    toNumber(pendingApprovalsTotal);

  return {
    kpis: {
      todaysSales,
      monthlyRevenue,
      cashBank,
      receivable,
      payable,
      ordersPending: ordersPendingCount,
      productionProgressPct: null, // no plan target/completion tracking
      dispatchesToday: dispatchesTodayCount,
      criticalAlerts,
      dozensToday: dozensToday === null ? null : Math.round(dozensToday * 10) / 10,
      dozensWeek: dozensWeek === null ? null : Math.round(dozensWeek * 10) / 10,
      dozensMonth: dozensMonth === null ? null : Math.round(dozensMonth * 10) / 10,
    },
    alerts: {
      overdueReceivables: overdueReceivablesCount,
      overduePayables: null, // purchase invoices have no due-date column
      rawMaterialsBelowMin: rawMaterialsBelowMinCount,
      employeesAbsent: null, // no attendance module
      productionBehindSchedule: null, // no production schedule/due date
      poAwaitingReceipt: poAwaitingReceiptCount,
      pendingApprovals: canApprovals
        ? { total: pendingApprovalsTotal, buckets: approvalBuckets }
        : null,
    },
    generatedAt: now.toISOString(),
  };
};

// Per-branch performance breakdown for the admin dashboard. Consolidated totals
// live in the KPI cards; this table shows how each branch contributes.
const loadBranchBreakdown = async ({ knex }) => {
  const now = new Date();
  const todayKey = toDateKey(now);
  const startOfMonthKey = toDateKey(new Date(now.getFullYear(), now.getMonth(), 1));

  const approvedVoucherScope = (qb) => {
    qb.leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
      .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
      .where(function approvedOrManual() {
        this.whereNull("vh.id").orWhere("vh.status", "APPROVED");
      });
  };

  try {
    const [branches, revenueRows, dozenRows, arRows, apRows] = await Promise.all([
      knex("erp.branches").select("id", "name", "name_ur").orderBy("name", "asc"),
      // Revenue: today + month-to-date, per branch.
      knex("erp.gl_entry as ge")
        .join("erp.accounts as a", "a.id", "ge.account_id")
        .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
        .modify(approvedVoucherScope)
        .where("ag.account_type", "REVENUE")
        .andWhere("ge.entry_date", ">=", startOfMonthKey)
        .andWhere("ge.entry_date", "<=", todayKey)
        .groupBy("ge.branch_id")
        .select("ge.branch_id")
        .select(
          knex.raw(
            "COALESCE(SUM(CASE WHEN ge.entry_date = ? THEN COALESCE(ge.cr,0)-COALESCE(ge.dr,0) ELSE 0 END),0) as today",
            [todayKey],
          ),
        )
        .select(
          knex.raw("COALESCE(SUM(COALESCE(ge.cr,0)-COALESCE(ge.dr,0)),0) as month"),
        ),
      // Dozens sold month-to-date, per branch.
      knex("erp.voucher_line as vl")
        .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
        .where("vh.voucher_type_code", "SALES_VOUCHER")
        .andWhere("vh.status", "APPROVED")
        .andWhere("vl.line_kind", "SKU")
        .whereRaw("COALESCE(vl.meta->>'movement_kind','SALE') = 'SALE'")
        .andWhere("vh.voucher_date", ">=", startOfMonthKey)
        .groupBy("vh.branch_id")
        .select("vh.branch_id")
        .select(
          knex.raw(
            "COALESCE(SUM(COALESCE((vl.meta->>'total_pairs')::numeric, vl.qty)),0) / 12.0 as dozens",
          ),
        ),
      // Receivable per branch: net each customer within the branch, keep only
      // those owing us (positive), so it aligns with the positive AR KPI.
      knex
        .from(
          knex("erp.gl_entry as ge")
            .join("erp.parties as p", "p.id", "ge.party_id")
            .whereRaw("upper(coalesce(p.party_type::text,'')) in ('CUSTOMER','BOTH')")
            .andWhere("ge.entry_date", "<=", todayKey)
            .groupBy("ge.branch_id", "ge.party_id")
            .select("ge.branch_id")
            .select(knex.raw("SUM(COALESCE(ge.dr,0)-COALESCE(ge.cr,0)) as bal"))
            .as("cb"),
        )
        .groupBy("cb.branch_id")
        .select("cb.branch_id")
        .select(knex.raw("COALESCE(SUM(CASE WHEN cb.bal > 0 THEN cb.bal ELSE 0 END),0) as bal")),
      // Payable per branch: net each supplier within the branch, keep positives.
      knex
        .from(
          knex("erp.gl_entry as ge")
            .join("erp.parties as p", "p.id", "ge.party_id")
            .whereRaw("upper(coalesce(p.party_type::text,'')) in ('SUPPLIER','BOTH')")
            .andWhere("ge.entry_date", "<=", todayKey)
            .groupBy("ge.branch_id", "ge.party_id")
            .select("ge.branch_id")
            .select(knex.raw("SUM(COALESCE(ge.cr,0)-COALESCE(ge.dr,0)) as bal"))
            .as("sb"),
        )
        .groupBy("sb.branch_id")
        .select("sb.branch_id")
        .select(knex.raw("COALESCE(SUM(CASE WHEN sb.bal > 0 THEN sb.bal ELSE 0 END),0) as bal")),
    ]);

    const byBranch = new Map();
    for (const b of branches) {
      byBranch.set(Number(b.id), {
        branch_id: Number(b.id),
        name: b.name,
        name_ur: b.name_ur || b.name,
        todaySales: 0,
        monthRevenue: 0,
        dozensMonth: 0,
        receivable: 0,
        payable: 0,
      });
    }
    const ensure = (id) => {
      const key = Number(id);
      if (!byBranch.has(key)) {
        byBranch.set(key, { branch_id: key, name: `#${key}`, name_ur: `#${key}`, todaySales: 0, monthRevenue: 0, dozensMonth: 0, receivable: 0, payable: 0 });
      }
      return byBranch.get(key);
    };
    for (const r of revenueRows) {
      const row = ensure(r.branch_id);
      row.todaySales = toNumber(r.today);
      row.monthRevenue = toNumber(r.month);
    }
    for (const r of dozenRows) ensure(r.branch_id).dozensMonth = Math.round(toNumber(r.dozens) * 10) / 10;
    for (const r of arRows) ensure(r.branch_id).receivable = toNumber(r.bal);
    for (const r of apRows) ensure(r.branch_id).payable = toNumber(r.bal);

    const rows = Array.from(byBranch.values());
    const totals = rows.reduce(
      (acc, r) => {
        acc.todaySales += r.todaySales;
        acc.monthRevenue += r.monthRevenue;
        acc.dozensMonth += r.dozensMonth;
        acc.receivable += r.receivable;
        acc.payable += r.payable;
        return acc;
      },
      { todaySales: 0, monthRevenue: 0, dozensMonth: 0, receivable: 0, payable: 0 },
    );
    totals.dozensMonth = Math.round(totals.dozensMonth * 10) / 10;
    return { rows, totals };
  } catch (err) {
    console.error("DashboardMetrics branch breakdown error:", err?.message || err);
    return { rows: [], totals: null };
  }
};

module.exports = {
  loadDashboardMetrics,
  loadBranchBreakdown,
};
