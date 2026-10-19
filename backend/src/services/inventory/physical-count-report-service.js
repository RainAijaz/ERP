"use strict";

const knex = require("../../db/knex");
const { toLocalDateOnly } = require("../../utils/date-only");
const { localizedNameSelect, localizedNameGroupBy } = require("../../utils/localized-name");
const { reportCanFilterAllBranches, getReportAllowedBranchIds, toIdListWithAll } = require("../../utils/report-branch-scope");
const { canAccessScope } = require("../../middleware/access/role-permissions");

const COUNT_REASONS = ["PHYSICALCOUNT", "PHYSICALCOUNTCORRECTION"];
const emptyCounts = () => ({ rows: [], branchCount: 0, recordedCount: 0, unavailable: false });

// Filter inputs here are the report's normalized filters, never raw query strings.
// An empty authorized branch list must not turn into an unrestricted query.
const getLatestPhysicalCounts = async ({ req, filters, options, scopeKey, db = knex }) => {
  const result = emptyCounts();
  try {
    const asOfDate = toLocalDateOnly(filters.asOfDate || filters.to);
    if (!asOfDate || !filters.reportLoaded || filters.validationErrors?.length || filters.mode === "IN_TRANSIT") return result;
    const allBranches = reportCanFilterAllBranches(req, scopeKey);
    const authorized = req?.user?.isAdmin || allBranches ? null : new Set(getReportAllowedBranchIds(req));
    const branchOptions = options.branches || options.sourceBranches || [];
    let requested = toIdListWithAll(filters.branchIds);
    if (Array.isArray(filters.sourceBranchIds)) {
      // Transfer reports cover both ends. ALL on either side includes all
      // authorized branches, rather than silently omitting that side.
      requested = filters.sourceBranchIds.length && filters.destinationBranchIds?.length
        ? [...new Set([...filters.sourceBranchIds, ...filters.destinationBranchIds])] : [];
    }
    const selected = new Set(requested);
    const branches = branchOptions.filter((b) => (!authorized || authorized.has(Number(b.id))) &&
      (!selected.size || selected.has(Number(b.id))));
    if (!branches.length) return result;

    const stockType = filters.stockType || filters.stockTypeFilter || filters.category;
    const types = ["FG", "SFG", "RM"].includes(stockType) ? [stockType] : ["FG", "SFG", "RM"];
    const groupIds = toIdListWithAll(filters.productGroupIds);
    const subgroupIds = toIdListWithAll(filters.productSubgroupIds);
    const stockItemIds = toIdListWithAll(filters.stockItemId ? [filters.stockItemId] : filters.stockItemIds);
    const articleIds = toIdListWithAll(filters.articleIds);
    const locale = String(req?.locale || "en").toLowerCase();
    const groups = [];

    for (const type of types) {
      const catalog = db("erp.items as i").leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
        .where("i.item_type", type).where("i.is_active", true)
        .select("i.group_id", localizedNameSelect("pg", "group_name", locale))
        .groupBy("i.group_id", ...localizedNameGroupBy("pg", locale));
      if (type !== "RM") {
        catalog.join("erp.variants as v", "v.item_id", "i.id").join("erp.skus as s", "s.variant_id", "v.id")
          .where("s.is_active", true).where("v.is_active", true);
      }
      if (groupIds.length) catalog.whereIn("i.group_id", groupIds);
      if (subgroupIds.length) catalog.whereIn("i.subgroup_id", subgroupIds);
      if (stockItemIds.length) catalog.whereIn(type === "RM" ? "i.id" : "s.id", stockItemIds);
      if (articleIds.length) catalog.whereIn("i.id", articleIds);
      catalog.select(db.raw(`COUNT(DISTINCT ${type === "RM" ? "i.id" : "s.id"})::int as article_count`));
      const rows = await catalog;
      for (const row of rows) groups.push({ ...row, stock_type: type });
    }
    if (!groups.length) return { ...result, branchCount: branches.length, asOfDate };

    // New count rows snapshot classification. Older rows fall back to current
    // classification and never claim historical full-group verification.
    const groupSql = "CASE WHEN jsonb_exists(vl.meta, 'count_group_id') THEN (vl.meta->>'count_group_id')::bigint ELSE i.group_id END";
    const subgroupSql = "CASE WHEN jsonb_exists(vl.meta, 'count_subgroup_id') THEN (vl.meta->>'count_subgroup_id')::bigint ELSE i.subgroup_id END";
    const statusSql = "CASE WHEN sch.item_type_scope = 'FG' THEN CASE WHEN upper(COALESCE(vl.meta->>'row_status', 'PACKED')) = 'LOOSE' THEN 'LOOSE' ELSE 'PACKED' END ELSE '' END";
    const counts = db("erp.voucher_header as vh")
      .join("erp.stock_count_header as sch", "sch.voucher_id", "vh.id")
      .join("erp.reason_codes as rc", "rc.id", "sch.reason_code_id")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .join("erp.stock_count_line as scl", "scl.voucher_line_id", "vl.id")
      .leftJoin("erp.skus as s", "s.id", "vl.sku_id")
      .leftJoin("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", function () { this.on("i.id", "=", db.raw("COALESCE(v.item_id, vl.item_id)")); })
      .where({ "vh.voucher_type_code": "STOCK_COUNT_ADJ", "vh.status": "APPROVED" })
      .whereIn("vh.branch_id", branches.map((b) => Number(b.id)))
      .whereIn("sch.item_type_scope", types)
      .whereRaw("regexp_replace(upper(rc.code), '[^A-Z0-9]', '', 'g') = ANY(?::text[])", [COUNT_REASONS])
      .where("vh.voucher_date", "<=", asOfDate)
      .select("vh.id as voucher_id", "vh.voucher_no", "vh.branch_id", "vh.approved_at", "sch.item_type_scope as stock_type")
      .select(db.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as count_date"), db.raw(`${groupSql} as group_id`))
      .select(db.raw("COUNT(DISTINCT COALESCE(vl.sku_id, vl.item_id))::int as counted_articles"))
      .groupBy("vh.id", "vh.voucher_no", "vh.branch_id", "vh.voucher_date", "vh.approved_at", "sch.item_type_scope")
      .groupByRaw(groupSql);
    if (groupIds.length) counts.whereRaw(`${groupSql} = ANY(?::bigint[])`, [groupIds]);
    if (subgroupIds.length) counts.whereRaw(`${subgroupSql} = ANY(?::bigint[])`, [subgroupIds]);
    if (stockItemIds.length) counts.whereIn(types.length === 1 && types[0] === "RM" ? "vl.item_id" : "vl.sku_id", stockItemIds);
    if (articleIds.length) counts.whereIn("i.id", articleIds);
    if (["PACKED", "LOOSE"].includes(filters.stockStatus)) {
      counts.whereRaw(`(sch.item_type_scope <> 'FG' OR (${statusSql}) = ?)`, [filters.stockStatus]);
    }
    // Status filters still apply, but the summary has one latest voucher per
    // branch/group/type. Mixed packed/loose lines count each article only once.
    const ranked = db.select("c.*", db.raw("ROW_NUMBER() OVER (PARTITION BY branch_id, group_id, stock_type ORDER BY count_date DESC, approved_at DESC NULLS LAST, voucher_id DESC) as count_rank"))
      .from(counts.as("c"));
    const latest = await db.select("latest.*").from(ranked.as("latest")).where("count_rank", 1);
    const byScope = new Map(latest.map((row) => [`${row.branch_id}:${row.group_id || 0}:${row.stock_type}`, row]));
    const voucherBranches = new Set(getReportAllowedBranchIds(req));
    const canOpenVoucher = canAccessScope(req, "VOUCHER", "STOCK_COUNT_ADJ", "navigate");
    for (const branch of branches) {
      for (const group of groups) {
        const count = byScope.get(`${branch.id}:${group.group_id || 0}:${group.stock_type}`);
        const mayLink = canOpenVoucher && (req.user?.isAdmin || voucherBranches.has(Number(branch.id)));
        result.rows.push({
          branchId: Number(branch.id), branchName: branch.name, groupId: Number(group.group_id) || null,
          groupName: group.group_name || "", stockType: group.stock_type,
          countDate: count?.count_date || null, voucherNo: count ? Number(count.voucher_no) : null,
          countedArticles: count ? Number(count.counted_articles) : 0,
          partial: Boolean(count && Number(count.counted_articles) < Number(group.article_count)),
          voucherUrl: count && mayLink ? `/vouchers/stock-count?view=1&voucher_no=${Number(count.voucher_no)}&branch_id=${Number(branch.id)}` : null,
        });
      }
    }
    result.rows.sort((a, b) => String(a.branchName).localeCompare(String(b.branchName)) || String(a.groupName).localeCompare(String(b.groupName)) || a.stockType.localeCompare(b.stockType));
    return { ...result, asOfDate, branchCount: branches.length, branchName: branches.length === 1 ? branches[0].name : null,
      recordedCount: result.rows.filter((row) => row.countDate).length };
  } catch (err) {
    console.error("Error in PhysicalCountReportService:", err);
    return { ...emptyCounts(), unavailable: true };
  }
};

const withLatestPhysicalCounts = (loader, scopeKey) => async (args) => {
  try {
    const page = await loader(args);
    if (page.filters?.reportLoaded && !page.filters?.validationErrors?.length) {
      page.reportData.physicalCounts = await getLatestPhysicalCounts({ req: args.req, filters: page.filters, options: page.options, scopeKey });
    }
    return page;
  } catch (err) {
    console.error("Error in PhysicalCountReportService:", err);
    throw err;
  }
};

module.exports = { getLatestPhysicalCounts, withLatestPhysicalCounts };
