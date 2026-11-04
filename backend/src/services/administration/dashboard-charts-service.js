// Admin Home Dashboard — Section 3 analytics charts.
//
// Returns permission-gated datasets (null when the user lacks the scope).
// Query failures carry an explicit error marker rather than fake zero totals.
// Time-based charts honour the [from, to]
// range; snapshot charts (inventory status, receivables vs payables) ignore it.

const SALES_VOUCHER_CODE = "SALES_VOUCHER";
const { normalizeDateOnly } = require("../../utils/date-only");
const { HttpError } = require("../../middleware/errors/http-error");
const { createTaskQueue } = require("../../utils/task-queue");
const { resolveDashboardPeriod } = require("./dashboard-period-service");
const { buildLowStockMaterialsQuery } = require("./dashboard-inventory-service");
const runChartQuery = createTaskQueue(4);

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

// Admin Home analytics are always consolidated across ALL branches (admin-only),
// so branch scoping is intentionally a no-op — the active-branch selector must
// not change these charts.
const applyBranchScope = (_req, qb) => qb;

const safe = async (label, fallback, factory) => {
  try {
    return await runChartQuery(factory);
  } catch (err) {
    console.error("Error in DashboardChartsService:", { label, error: err?.message || err });
    return { ...fallback, error: true };
  }
};

// Build an ordered list of bucket keys between two ISO dates.
const buildBucketKeys = (fromKey, toKey, granularity) => {
  const keys = [];
  if (granularity === "day") {
    const cur = new Date(`${fromKey}T00:00:00Z`);
    const end = new Date(`${toKey}T00:00:00Z`);
    while (cur <= end) {
      keys.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  } else {
    const cur = new Date(`${fromKey.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(`${toKey.slice(0, 7)}-01T00:00:00Z`);
    while (cur <= end) {
      keys.push(cur.toISOString().slice(0, 7));
      cur.setUTCMonth(cur.getUTCMonth() + 1);
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
  const range = resolveRange({ period: "custom", from, to });
  const fromKey = range.from;
  const toKey = range.to;
  const snapshotKey = resolveDashboardPeriod().today;
  const granularity = resolveGranularity(fromKey, toKey);
  const pgFmt = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  const bucketKeys = buildBucketKeys(fromKey, toKey, granularity);

  const canSales = getCan(can, "REPORT", "sales_report");
  const canPurchase = getCan(can, "REPORT", "purchase_report");
  const canFinancial =
    getCan(can, "REPORT", "profit_and_loss") || getCan(can, "REPORT", "expense_trends");
  const canRevenue = getCan(can, "REPORT", "profit_and_loss");
  const canProduction = getCan(can, "REPORT", "production_report");
  const canInventory =
    getCan(can, "REPORT", "stock_quantity") || getCan(can, "REPORT", "stock_ledger");
  const canCustomerBalances = getCan(can, "REPORT", "customer_balances");
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

  // voucher_line.amount is signed on returns; sales_line.total_amount is always
  // positive. Use the same signed source the sales voucher actually stores.
  const salesLines = () => knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .where({ "vh.voucher_type_code": SALES_VOUCHER_CODE, "vh.status": "APPROVED", "vl.line_kind": "SKU" })
    .whereBetween("vh.voucher_date", [fromKey, toKey])
    .timeout(12000, { cancel: true });
  const salesBuckets = () => salesLines()
    .groupByRaw(`to_char(vh.voucher_date, '${pgFmt}')`)
    .select(knex.raw(`to_char(vh.voucher_date, '${pgFmt}') as k`))
    .select(knex.raw("COALESCE(SUM(vl.amount),0) as v"));

  // ---- 1) Monthly Sales Trend (sales voucher net amount) ------------------
  const salesTrend = () =>
    safe("salesTrend", { labels: bucketKeys, values: [] }, async () => {
      const rows = await salesBuckets();
      return { labels: bucketKeys, values: mapBuckets(rows), hasData: rows.length > 0 };
    });

  // ---- 1b) Sales vs Purchase (money in vs money out over time) ------------
  // Sales = approved SALES_VOUCHER line net amount; Purchase = approved PI line
  // amount. Each series is gated independently and returns [] when the viewer
  // lacks the scope, so the renderer draws whichever series it has.
  const salesVsPurchase = () =>
    safe("salesVsPurchase", { labels: bucketKeys, sales: [], purchase: [] }, async () => {
      const salesRowsP = canSales
        ? salesBuckets()
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
            .timeout(12000, { cancel: true })
        : Promise.resolve([]);
      const [salesRows, purchaseRows] = await Promise.all([salesRowsP, purchaseRowsP]);
      return {
        labels: bucketKeys,
        sales: canSales ? mapBuckets(salesRows) : [],
        purchase: canPurchase ? mapBuckets(purchaseRows) : [],
        hasData: salesRows.length > 0 || purchaseRows.length > 0,
      };
    });

  // ---- 2) Revenue vs Expenses (GL) ---------------------------------------
  const revenueVsExpenses = () =>
    safe("revenueVsExpenses", { labels: bucketKeys, revenue: [], expense: [] }, async () => {
      const rows = await knex("erp.gl_entry as ge")
        .join("erp.accounts as a", "a.id", "ge.account_id")
        .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
        .modify(approvedVoucherScope)
        .whereIn("ag.account_type", canRevenue ? ["REVENUE", "EXPENSE"] : ["EXPENSE"])
        .whereBetween("ge.entry_date", [fromKey, toKey])
        .modify((qb) => applyBranchScope(req, qb, "ge.branch_id"))
        .groupByRaw(`to_char(ge.entry_date, '${pgFmt}')`)
        .select(knex.raw(`to_char(ge.entry_date, '${pgFmt}') as k`))
        .select(knex.raw("COALESCE(SUM(CASE WHEN ag.account_type='REVENUE' THEN COALESCE(ge.cr,0)-COALESCE(ge.dr,0) ELSE 0 END),0) as rev"))
        .select(knex.raw("COALESCE(SUM(CASE WHEN ag.account_type='EXPENSE' THEN COALESCE(ge.dr,0)-COALESCE(ge.cr,0) ELSE 0 END),0) as exp"))
        .timeout(12000, { cancel: true });
      return {
        labels: bucketKeys,
        revenue: canRevenue ? mapBuckets(rows, "rev") : [],
        expense: mapBuckets(rows, "exp"),
        hasData: rows.length > 0,
      };
    });

  // ---- 3) Production by Stage (horizontal bar) ----------------------------
  const productionByStage = () =>
    safe("productionByStage", { labels: [], labels_ur: [], values: [] }, async () => {
      // Stage throughput comes from DCVs, as in the production control report.
      // FG completion vouchers are a separate operation and must not double it.
      const rows = await knex("erp.voucher_line as vl")
        .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
        .join("erp.dcv_header as dh", "dh.voucher_id", "vh.id")
        .leftJoin("erp.dcv_line as dl", "dl.voucher_line_id", "vl.id")
        .leftJoin("erp.production_stages as ps", "ps.id", knex.raw("COALESCE(dl.stage_id, dh.stage_id)"))
        .where({ "vh.voucher_type_code": "DCV", "vh.status": "APPROVED", "vl.line_kind": "SKU" })
        .whereBetween("vh.voucher_date", [fromKey, toKey])
        .groupBy("ps.id", "ps.name", "ps.name_ur")
        .select("ps.name", "ps.name_ur")
        .select(knex.raw("COALESCE(SUM(COALESCE(NULLIF(vl.meta->>'total_pairs','')::numeric, CASE WHEN UPPER(COALESCE(vl.meta->>'unit','')) = 'DZN' THEN vl.qty * 12 ELSE vl.qty END)),0) as v"))
        .orderBy("v", "desc")
        .orderBy("ps.id", "asc")
        .timeout(12000, { cancel: true });
      return {
        labels: rows.map((r) => r.name),
        labels_ur: rows.map((r) => r.name_ur || r.name),
        values: rows.map((r) => toNumber(r.v)),
      };
    });

  // ---- 4) Inventory Status (separate count bars, current snapshot) --------
  const inventoryStatus = () =>
    safe("inventoryStatus", { available: 0, lowStock: 0, outOfStock: 0 }, async () => {
      const stock = knex("erp.stock_balance_sku")
        .where("stock_state", "ON_HAND").groupBy("sku_id")
        .select("sku_id").sum("qty_pairs as qty");
      const skuAgg = await knex("erp.skus as s")
        .join("erp.variants as v", "v.id", "s.variant_id")
        .join("erp.items as i", "i.id", "v.item_id")
        .leftJoin(stock.as("sb"), "sb.sku_id", "s.id")
        .where({ "s.is_active": true, "i.is_active": true })
        .whereIn("i.item_type", ["FG", "SFG"])
        .select(
          knex.raw("COUNT(*) FILTER (WHERE COALESCE(sb.qty,0) > 0) as available"),
          knex.raw("COUNT(*) FILTER (WHERE COALESCE(sb.qty,0) <= 0) as out_of_stock"),
        )
        .first().timeout(12000, { cancel: true });

      const lowRows = await buildLowStockMaterialsQuery(knex);

      return {
        available: toNumber(skuAgg?.available),
        lowStock: lowRows.length,
        outOfStock: toNumber(skuAgg?.out_of_stock),
      };
    });

  // ---- 5) Top 10 Selling Products ----------------------------------------
  // Two independent top-10 lists: one ranked by money, one by volume. They are
  // separate queries because the ranking (and therefore which SKUs appear at
  // all) differs per measure — a cheap high-volume article can top "dozens"
  // while never entering the "amount" top 10.
  const topProducts = () =>
    safe(
      "topProducts",
      { labels: [], values: [], byDozens: { labels: [], values: [] } },
      async () => {
        const amountRows = await salesLines()
          .join("erp.skus as s", "s.id", "vl.sku_id")
          .groupBy("s.sku_code")
          .select("s.sku_code")
          .select(knex.raw("COALESCE(SUM(vl.amount),0) as v"))
          .orderBy("v", "desc")
          .orderBy("s.sku_code", "asc")
          .limit(10);

        // Volume uses the canonical pairs expression (voucher_line.meta.total_pairs,
        // falling back to vl.qty) and dozens = pairs / 12 — identical to the
        // "Dozens Sold" KPI in dashboard-metrics-service.js, so the two reconcile.
        // movement_kind filters out return lines.
        const dozenRows = await knex("erp.voucher_line as vl")
          .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
          .join("erp.skus as s", "s.id", "vl.sku_id")
          .where("vh.voucher_type_code", SALES_VOUCHER_CODE)
          .where("vh.status", "APPROVED")
          .where("vl.line_kind", "SKU")
          .whereRaw("COALESCE(vl.meta->>'movement_kind','SALE') = 'SALE'")
          .whereBetween("vh.voucher_date", [fromKey, toKey])
          .modify((qb) => applyBranchScope(req, qb, "vh.branch_id"))
          .groupBy("s.sku_code")
          .select("s.sku_code")
          .select(
            knex.raw(
              "COALESCE(SUM(COALESCE((vl.meta->>'total_pairs')::numeric, vl.qty)),0) / 12.0 as v",
            ),
          )
          .orderBy("v", "desc")
          .orderBy("s.sku_code", "asc")
          .limit(10).timeout(12000, { cancel: true });

        return {
          labels: amountRows.map((r) => r.sku_code),
          values: amountRows.map((r) => toNumber(r.v)),
          byDozens: {
            labels: dozenRows.map((r) => r.sku_code),
            values: dozenRows.map((r) => Math.round(toNumber(r.v) * 10) / 10),
          },
        };
      },
    );

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
      .modify(approvedVoucherScope)
      .where("ge.entry_date", "<=", snapshotKey)
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
      .first().timeout(12000, { cancel: true });
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
    range: { from: fromKey, to: toKey, granularity, snapshotDate: snapshotKey },
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
const resolveRange = ({ period = "last30", from, to, now = new Date() } = {}) => {
  const rolling = resolveDashboardPeriod({ now });
  const calendar = resolveDashboardPeriod({ mode: "calendar", now });
  if (period === "custom") {
    // Reject arrays, impossible dates and unbounded scans before building SQL
    // or allocating chart buckets. Never silently substitute a different range.
    if (typeof from !== "string" || typeof to !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
        !normalizeDateOnly(from) || !normalizeDateOnly(to)) {
      throw new HttpError(400, "Invalid date range.");
    }
    const low = from <= to ? from : to;
    const high = from <= to ? to : from;
    if ((Date.parse(high) - Date.parse(low)) / 86400000 > 3660) {
      throw new HttpError(400, "Invalid date range.");
    }
    return { from: low, to: high, period };
  }
  switch (period) {
    case "today":
      return { from: rolling.today, to: rolling.today, period };
    case "yesterday":
      return { from: rolling.yesterday, to: rolling.yesterday, period };
    case "last7": return { ...rolling.week, period };
    case "week": return { ...calendar.week, period };
    case "year": return { from: `${rolling.today.slice(0, 4)}-01-01`, to: rolling.today, period };
    case "month":
      return { ...calendar.month, period };
    case "last30": return { ...rolling.month, period };
    default: throw new HttpError(400, "Invalid date range.");
  }
};

module.exports = {
  loadDashboardCharts,
  resolveRange,
};
