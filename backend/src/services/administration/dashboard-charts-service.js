// Admin Home Dashboard — Section 3 analytics charts.
//
// Returns six datasets, each permission-gated (null when the user lacks the
// scope) and each wrapped so a failing query degrades to an empty dataset
// instead of breaking the endpoint. Time-based charts honour the [from, to]
// range; snapshot charts (inventory status, receivables vs payables) ignore it.

const SALES_VOUCHER_CODE = "SALES_VOUCHER";

const toNumber = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};

const getCan = (canFn, scopeType, scopeKey, action = "view") => {
  if (typeof canFn !== "function") return false;
  try {
    return Boolean(canFn(scopeType, scopeKey, action));
  } catch (_e) {
    return false;
  }
};

const toPositiveNumber = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Admin Home analytics are always consolidated across ALL branches (admin-only),
// so branch scoping is intentionally a no-op — the active-branch selector must
// not change these charts.
const applyBranchScope = (_req, qb) => qb;

const safe = async (label, fallback, factory) => {
  try {
    return await factory();
  } catch (err) {
    console.error("DashboardCharts error:", { label, error: err?.message || err });
    return fallback;
  }
};

// Build an ordered list of bucket keys between two ISO dates.
const buildBucketKeys = (fromKey, toKey, granularity) => {
  const keys = [];
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  if (granularity === "day") {
    const cur = new Date(fy, fm - 1, fd);
    const end = new Date(ty, tm - 1, td);
    while (cur <= end) {
      const y = cur.getFullYear();
      const m = String(cur.getMonth() + 1).padStart(2, "0");
      const d = String(cur.getDate()).padStart(2, "0");
      keys.push(`${y}-${m}-${d}`);
      cur.setDate(cur.getDate() + 1);
    }
  } else {
    const cur = new Date(fy, fm - 1, 1);
    const end = new Date(ty, tm - 1, 1);
    while (cur <= end) {
      const y = cur.getFullYear();
      const m = String(cur.getMonth() + 1).padStart(2, "0");
      keys.push(`${y}-${m}`);
      cur.setMonth(cur.getMonth() + 1);
    }
  }
  return keys;
};

// day granularity for spans up to ~2 months, otherwise month.
const resolveGranularity = (fromKey, toKey) => {
  const from = new Date(fromKey);
  const to = new Date(toKey);
  const spanDays = Math.round((to - from) / 86400000);
  return spanDays <= 62 ? "day" : "month";
};

const loadDashboardCharts = async ({ knex, req, can, from, to }) => {
  const fromKey = from;
  const toKey = to;
  const granularity = resolveGranularity(fromKey, toKey);
  const pgFmt = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  const bucketKeys = buildBucketKeys(fromKey, toKey, granularity);

  const canSales = getCan(can, "REPORT", "sales_report");
  const canPurchase = getCan(can, "REPORT", "purchase_report");
  const canFinancial =
    getCan(can, "REPORT", "profit_and_loss") || getCan(can, "REPORT", "expense_trends");
  const canProduction = getCan(can, "REPORT", "production_report");
  const canInventory =
    getCan(can, "REPORT", "stock_quantity") || getCan(can, "REPORT", "stock_ledger");
  const canCustomerBalances =
    getCan(can, "REPORT", "customer_balances") || canSales;
  const canSupplierBalances = getCan(can, "REPORT", "supplier_balances");

  const approvedVoucherScope = (qb) => {
    qb.leftJoin("erp.gl_batch as gb", "gb.id", "ge.batch_id")
      .leftJoin("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
      .where(function approvedOrManual() {
        this.whereNull("vh.id").orWhere("vh.status", "APPROVED");
      });
  };

  const mapBuckets = (rows, valueField = "v") => {
    const byKey = new Map();
    for (const r of rows) byKey.set(String(r.k), toNumber(r[valueField]));
    return bucketKeys.map((k) => toNumber(byKey.get(k) || 0));
  };

  // ---- 1) Monthly Sales Trend (sales voucher net amount) ------------------
  const salesTrend = () =>
    safe("salesTrend", { labels: bucketKeys, values: [] }, async () => {
      const rows = await knex("erp.sales_line as sl")
        .join("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
        .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
        .where("vh.voucher_type_code", SALES_VOUCHER_CODE)
        .where("vh.status", "APPROVED")
        .whereBetween("vh.voucher_date", [fromKey, toKey])
        .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
        .groupByRaw(`to_char(vh.voucher_date, '${pgFmt}')`)
        .select(knex.raw(`to_char(vh.voucher_date, '${pgFmt}') as k`))
        .select(knex.raw("COALESCE(SUM(sl.total_amount),0) as v"));
      return { labels: bucketKeys, values: mapBuckets(rows) };
    });

  // ---- 1b) Sales vs Purchase (money in vs money out over time) ------------
  // Sales = approved SALES_VOUCHER line net amount; Purchase = approved PI line
  // amount. Each series is gated independently and returns [] when the viewer
  // lacks the scope, so the renderer draws whichever series it has.
  const salesVsPurchase = () =>
    safe("salesVsPurchase", { labels: bucketKeys, sales: [], purchase: [] }, async () => {
      const salesRowsP = canSales
        ? knex("erp.sales_line as sl")
            .join("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
            .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
            .where("vh.voucher_type_code", SALES_VOUCHER_CODE)
            .where("vh.status", "APPROVED")
            .whereBetween("vh.voucher_date", [fromKey, toKey])
            .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
            .groupByRaw(`to_char(vh.voucher_date, '${pgFmt}')`)
            .select(knex.raw(`to_char(vh.voucher_date, '${pgFmt}') as k`))
            .select(knex.raw("COALESCE(SUM(sl.total_amount),0) as v"))
        : Promise.resolve([]);
      const purchaseRowsP = canPurchase
        ? knex("erp.voucher_line as vl")
            .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
            .where("vh.voucher_type_code", "PI")
            .where("vh.status", "APPROVED")
            .whereBetween("vh.voucher_date", [fromKey, toKey])
            .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
            .groupByRaw(`to_char(vh.voucher_date, '${pgFmt}')`)
            .select(knex.raw(`to_char(vh.voucher_date, '${pgFmt}') as k`))
            .select(knex.raw("COALESCE(SUM(vl.amount),0) as v"))
        : Promise.resolve([]);
      const [salesRows, purchaseRows] = await Promise.all([salesRowsP, purchaseRowsP]);
      return {
        labels: bucketKeys,
        sales: canSales ? mapBuckets(salesRows) : [],
        purchase: canPurchase ? mapBuckets(purchaseRows) : [],
      };
    });

  // ---- 2) Revenue vs Expenses (GL) ---------------------------------------
  const revenueVsExpenses = () =>
    safe("revenueVsExpenses", { labels: bucketKeys, revenue: [], expense: [] }, async () => {
      const rows = await knex("erp.gl_entry as ge")
        .join("erp.accounts as a", "a.id", "ge.account_id")
        .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
        .modify(approvedVoucherScope)
        .whereIn("ag.account_type", ["REVENUE", "EXPENSE"])
        .whereBetween("ge.entry_date", [fromKey, toKey])
        .modify((qb) => applyBranchScope(req, qb, "ge.branch_id"))
        .groupByRaw(`to_char(ge.entry_date, '${pgFmt}')`)
        .select(knex.raw(`to_char(ge.entry_date, '${pgFmt}') as k`))
        .select(knex.raw("COALESCE(SUM(CASE WHEN ag.account_type='REVENUE' THEN COALESCE(ge.cr,0)-COALESCE(ge.dr,0) ELSE 0 END),0) as rev"))
        .select(knex.raw("COALESCE(SUM(CASE WHEN ag.account_type='EXPENSE' THEN COALESCE(ge.dr,0)-COALESCE(ge.cr,0) ELSE 0 END),0) as exp"));
      return {
        labels: bucketKeys,
        revenue: mapBuckets(rows, "rev"),
        expense: mapBuckets(rows, "exp"),
      };
    });

  // ---- 3) Production by Stage (horizontal bar) ----------------------------
  const productionByStage = () =>
    safe("productionByStage", { labels: [], labels_ur: [], values: [] }, async () => {
      const rows = await knex("erp.production_stages as ps")
        .leftJoin("erp.production_line as pl", "pl.stage_id", "ps.id")
        .leftJoin("erp.voucher_line as vl", "vl.id", "pl.voucher_line_id")
        .leftJoin("erp.voucher_header as vh", function joinApprovedInRange() {
          this.on("vh.id", "vl.voucher_header_id")
            .andOn("vh.status", knex.raw("?", ["APPROVED"]))
            .andOn("vh.voucher_date", ">=", knex.raw("?", [fromKey]))
            .andOn("vh.voucher_date", "<=", knex.raw("?", [toKey]));
        })
        .where("ps.is_active", true)
        .groupBy("ps.id", "ps.name", "ps.name_ur")
        .select("ps.name", "ps.name_ur")
        .select(knex.raw("COALESCE(SUM(pl.total_pairs),0) as v"))
        .orderBy("v", "desc");
      return {
        labels: rows.map((r) => r.name),
        labels_ur: rows.map((r) => r.name_ur || r.name),
        values: rows.map((r) => toNumber(r.v)),
      };
    });

  // ---- 4) Inventory Status (donut, snapshot) ------------------------------
  const inventoryStatus = () =>
    safe("inventoryStatus", { available: 0, reserved: 0, lowStock: 0, outOfStock: 0 }, async () => {
      const skuAgg = await knex("erp.stock_balance_sku as sb")
        .where("sb.stock_state", "ON_HAND")
        .modify((qb) => applyBranchScope(req, qb, "sb.branch_id"))
        .select(
          knex.raw("COUNT(*) FILTER (WHERE sb.qty_pairs > 0) as available"),
          knex.raw("COUNT(*) FILTER (WHERE sb.qty_pairs <= 0) as out_of_stock"),
        )
        .first();

      const lowRows = await knex("erp.items as i")
        .leftJoin("erp.stock_balance_rm as sb", "sb.item_id", "i.id")
        .where("i.min_stock_level", ">=", 0)
        .groupBy("i.id", "i.min_stock_level")
        .havingRaw("COALESCE(SUM(sb.qty),0) < i.min_stock_level")
        .select("i.id");

      return {
        available: toNumber(skuAgg?.available),
        reserved: 0, // no reservation state in stock_state enum
        lowStock: lowRows.length,
        outOfStock: toNumber(skuAgg?.out_of_stock),
      };
    });

  // ---- 5) Top 10 Selling Products ----------------------------------------
  const topProducts = () =>
    safe("topProducts", { labels: [], values: [] }, async () => {
      const rows = await knex("erp.sales_line as sl")
        .join("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
        .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
        .join("erp.skus as s", "s.id", "vl.sku_id")
        .where("vh.voucher_type_code", SALES_VOUCHER_CODE)
        .where("vh.status", "APPROVED")
        .whereBetween("vh.voucher_date", [fromKey, toKey])
        .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
        .groupBy("s.sku_code")
        .select("s.sku_code")
        .select(knex.raw("COALESCE(SUM(sl.total_amount),0) as v"))
        .orderBy("v", "desc")
        .limit(10);
      return {
        labels: rows.map((r) => r.sku_code),
        values: rows.map((r) => toNumber(r.v)),
      };
    });

  // ---- 6) Receivables vs Payables (bar, snapshot) -------------------------
  const partyBalanceTotal = async (partyTypes, direction) => {
    const debitExpr = "COALESCE(ge.dr,0) - COALESCE(ge.cr,0)";
    const partySub = knex("erp.gl_entry as ge")
      .join("erp.parties as p", "p.id", "ge.party_id")
      .whereNotNull("ge.party_id")
      .whereRaw(
        `upper(coalesce(p.party_type::text,'')) in (${partyTypes.map(() => "?").join(",")})`,
        partyTypes,
      )
      .where("ge.entry_date", "<=", toKey)
      .modify((qb) => applyBranchScope(req, qb, "ge.branch_id"))
      .groupBy("ge.party_id")
      .select("ge.party_id")
      .select(knex.raw(`SUM(${debitExpr}) as bal`));
    const row = await knex
      .from(partySub.as("pb"))
      .select(
        knex.raw(
          direction === "PAYABLE"
            ? "COALESCE(SUM(CASE WHEN pb.bal < 0 THEN -pb.bal ELSE 0 END),0) as value"
            : "COALESCE(SUM(CASE WHEN pb.bal > 0 THEN pb.bal ELSE 0 END),0) as value",
        ),
      )
      .first();
    return toNumber(row?.value);
  };

  const receivablesVsPayables = () =>
    safe("receivablesVsPayables", { receivable: null, payable: null }, async () => ({
      receivable: canCustomerBalances ? await partyBalanceTotal(["CUSTOMER", "BOTH"], "RECEIVABLE") : null,
      payable: canSupplierBalances ? await partyBalanceTotal(["SUPPLIER", "BOTH"], "PAYABLE") : null,
    }));

  const [
    salesTrendData,
    salesVsPurchaseData,
    revenueVsExpensesData,
    productionByStageData,
    inventoryStatusData,
    topProductsData,
    receivablesVsPayablesData,
  ] = await Promise.all([
    canSales ? salesTrend() : Promise.resolve(null),
    canSales || canPurchase ? salesVsPurchase() : Promise.resolve(null),
    canFinancial ? revenueVsExpenses() : Promise.resolve(null),
    canProduction ? productionByStage() : Promise.resolve(null),
    canInventory ? inventoryStatus() : Promise.resolve(null),
    canSales ? topProducts() : Promise.resolve(null),
    canCustomerBalances || canSupplierBalances ? receivablesVsPayables() : Promise.resolve(null),
  ]);

  return {
    range: { from: fromKey, to: toKey, granularity },
    charts: {
      salesTrend: salesTrendData,
      salesVsPurchase: salesVsPurchaseData,
      revenueVsExpenses: revenueVsExpensesData,
      productionByStage: productionByStageData,
      inventoryStatus: inventoryStatusData,
      topProducts: topProductsData,
      receivablesVsPayables: receivablesVsPayablesData,
    },
    generatedAt: new Date().toISOString(),
  };
};

// Resolve a preset period (or explicit from/to) into an ISO [from, to] range.
const resolveRange = ({ period, from, to }) => {
  const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim());
  const iso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (period === "custom" && isIso(from) && isIso(to)) {
    return from <= to ? { from, to, period } : { from: to, to: from, period };
  }
  switch (period) {
    case "today":
      return { from: iso(today), to: iso(today), period: "today" };
    case "week": {
      const start = new Date(today);
      start.setDate(today.getDate() - 6);
      return { from: iso(start), to: iso(today), period: "week" };
    }
    case "year": {
      const start = new Date(today.getFullYear(), 0, 1);
      return { from: iso(start), to: iso(today), period: "year" };
    }
    case "month":
    default: {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: iso(start), to: iso(today), period: "month" };
    }
  }
};

module.exports = {
  loadDashboardCharts,
  resolveRange,
};
