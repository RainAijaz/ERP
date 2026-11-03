'use strict';

const knex = require('../../db/knex');
const { HttpError } = require('../../middleware/errors/http-error');
const { canAccessScope } = require('../../middleware/access/role-permissions');
const { normalizeDateOnly, toLocalDateOnly } = require('../../utils/date-only');
const { toBoolean } = require('../../utils/report-filter-types');
const { localizedNameSelect } = require('../../utils/localized-name');
const { WIP_ON_HAND } = require('../production/wip-pool');
const { normalizeReportBranchIds, reportCanFilterAllBranches, getReportAllowedBranchIds, toIdListWithAll, toStringListWithAll } = require('../../utils/report-branch-scope');

const SCOPE = 'stock_count_details';
const STOCK_TYPES = ['RM', 'SFG', 'FG', 'WIP'];
const STATUSES = ['APPROVED', 'PENDING', 'REJECTED'];
const VIEW_OPTIONS = [
  { value: 'all', labelKey: 'all' }, { value: 'article', labelKey: 'article' },
  { value: 'voucher', labelKey: 'voucher' }, { value: 'sku', labelKey: 'sku' },
  { value: 'department', labelKey: 'department' }, { value: 'branch', labelKey: 'branch' },
  { value: 'date', labelKey: 'date' },
];
const money = value => Number(Number(value || 0).toFixed(2));
const qty = value => Number(Number(value || 0).toFixed(3));

const parseFilters = ({ req, input }) => {
  const today = toLocalDateOnly(new Date());
  const from = input.from_date === undefined ? today.slice(0, 8) + '01' : String(input.from_date).trim();
  const to = input.to_date === undefined ? today : String(input.to_date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || normalizeDateOnly(from) !== from || normalizeDateOnly(to) !== to || from > to) throw new HttpError(400, 'invalid_date_range');
  const orderBy = String(input.order_by || 'all').trim().toLowerCase();
  const stockTypes = toStringListWithAll(input.stock_types).map(value => value.toUpperCase());
  const statuses = toStringListWithAll(input.approval_statuses).map(value => value.toUpperCase());
  if (!VIEW_OPTIONS.some(option => option.value === orderBy) || stockTypes.some(value => !STOCK_TYPES.includes(value)) || statuses.some(value => !STATUSES.includes(value))) throw new HttpError(400, 'stock_count_invalid_filters');
  for (const field of ['branch_ids', 'reason_ids', 'product_group_ids', 'product_subgroup_ids', 'article_ids']) {
    if (toStringListWithAll(input[field]).some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new HttpError(400, 'stock_count_invalid_filters');
  }
  return {
    from, to, orderBy, reportLoaded: toBoolean(input.load_report),
    branchIds: normalizeReportBranchIds({ req, input, scopeKey: SCOPE }),
    canFilterAllBranches: reportCanFilterAllBranches(req, SCOPE),
    stockTypes, statuses,
    reasonIds: toIdListWithAll(input.reason_ids), articleIds: toIdListWithAll(input.article_ids),
    productGroupIds: toIdListWithAll(input.product_group_ids), productSubgroupIds: toIdListWithAll(input.product_subgroup_ids),
  };
};

const buildGroups = (rows, orderBy, locale) => {
  if (orderBy === 'all') return [{ key: 'all', rows }];
  const groups = new Map();
  for (const row of rows) {
    const [id, label] = {
      article: [row.articleId, row.articleName],
      voucher: [row.voucherId, row.voucherNo],
      sku: [row.skuId ? `sku:${row.skuId}` : `article:${row.articleId}`, row.skuCode || row.articleName],
      department: [row.departmentId, row.departmentName],
      branch: [row.branchId, row.branchName],
      date: [row.date, row.date],
    }[orderBy];
    const key = `${orderBy}:${id}`;
    if (!groups.has(key)) groups.set(key, { key, label, labelKey: orderBy === 'department' && !id ? 'production_report_unassigned' : '', rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), locale, { numeric: true }) || a.key.localeCompare(b.key, locale, { numeric: true }));
};

const getStockCountDetailsReportPageData = async ({ req, input = {}, db = knex }) => {
  try {
    const filters = parseFilters({ req, input });
    const locale = String(req.locale || 'en').toLowerCase();
    const canViewCostFields = canAccessScope(req, 'REPORT', SCOPE, 'view_cost_fields');
    const canViewVouchers = canAccessScope(req, 'VOUCHER', 'STOCK_COUNT_ADJ', 'view') && canAccessScope(req, 'REPORT', SCOPE, 'view_details');
    const restricted = !req.user?.isAdmin && !filters.canFilterAllBranches;
    const allowed = getReportAllowedBranchIds(req);
    const hasWip = await db.schema.withSchema('erp').hasTable('wip_count_header');
    return await db.transaction(async trx => {
      let branchesQuery = trx('erp.branches as b').select('b.id', localizedNameSelect('b', 'name', locale)).orderBy('b.name');
      if (restricted) branchesQuery.whereIn('b.id', allowed);
      const branches = await branchesQuery;
      const options = { branches, reasons: [], productGroups: [], productSubgroups: [], articles: [], viewOptions: VIEW_OPTIONS };
      const reportData = { rows: [], groups: [], unitTotals: [], totals: { vouchers: 0, lines: 0, pending: 0, increaseValue: 0, decreaseValue: 0, netValue: 0 }, canViewCostFields, canViewVouchers };
      if (restricted && !allowed.length) return { filters, options, reportData };
      let query = trx('erp.voucher_header as vh').join('erp.voucher_line as vl', 'vl.voucher_header_id', 'vh.id')
        .leftJoin('erp.stock_count_header as sch', 'sch.voucher_id', 'vh.id')
        .leftJoin('erp.stock_count_line as scl', 'scl.voucher_line_id', 'vl.id')
        .leftJoin('erp.skus as s', 's.id', 'vl.sku_id').leftJoin('erp.variants as v', 'v.id', 's.variant_id')
        .leftJoin('erp.items as i', function () { this.on('i.id', '=', trx.raw('COALESCE(v.item_id, vl.item_id)')); })
        .leftJoin('erp.product_groups as pg', 'pg.id', 'i.group_id')
        .leftJoin('erp.product_subgroups as psg', 'psg.id', 'i.subgroup_id')
        .leftJoin('erp.uom as u', 'u.id', 'i.base_uom_id').leftJoin('erp.branches as b', 'b.id', 'vh.branch_id')
        .where('vh.voucher_type_code', 'STOCK_COUNT_ADJ').whereBetween('vh.voucher_date', [filters.from, filters.to])
        .select('vh.id as voucher_id', 'vh.voucher_no', 'vh.voucher_date', 'vh.branch_id', 'vh.status', 'vl.id as line_id', 'vl.line_no', 'vl.sku_id', 'vl.item_id', 'vl.qty', 'vl.meta',
          'sch.item_type_scope', 'sch.reason_code_id', 'sch.notes', 'scl.system_qty_snapshot', 'scl.physical_qty', 'scl.system_qty_pairs_snapshot', 'scl.physical_qty_pairs',
          's.sku_code', 'i.id as article_id', 'i.item_type', 'i.group_id as product_group_id', 'i.subgroup_id as product_subgroup_id',
          localizedNameSelect('pg', 'product_group_name', locale), localizedNameSelect('psg', 'product_subgroup_name', locale),
          'u.code as unit_code', localizedNameSelect('i', 'article_name', locale), localizedNameSelect('b', 'branch_name', locale));
      if (filters.branchIds.length) query.whereIn('vh.branch_id', filters.branchIds);
      if (restricted) query.whereIn('vh.branch_id', allowed);
      if (hasWip) {
        query.leftJoin('erp.wip_count_header as wc', 'wc.voucher_id', 'vh.id').leftJoin('erp.departments as d', 'd.id', 'wc.dept_id')
          .leftJoin('erp.reason_codes as rc', 'rc.id', trx.raw('COALESCE(wc.reason_code_id, sch.reason_code_id)'))
          .select('wc.dept_id', 'wc.reason_code_id as wip_reason_id', 'wc.reason_notes', localizedNameSelect('d', 'department_name', locale), 'rc.name as reason_name');
      } else {
        query.leftJoin('erp.reason_codes as rc', 'rc.id', 'sch.reason_code_id')
          .select(trx.raw('NULL::bigint as dept_id'), trx.raw('NULL::bigint as wip_reason_id'), trx.raw('NULL::text as department_name'), trx.raw('NULL::text as reason_notes'), 'rc.name as reason_name');
      }
      const rawRows = await query.orderBy('vh.voucher_date').orderBy('vh.id').orderBy('vl.line_no');
      const voucherIds = [...new Set(rawRows.map(row => Number(row.voucher_id)))];
      if (!voucherIds.length) return { filters, options, reportData };
      const warehouseLedger = await trx('erp.stock_ledger as sl').whereIn('sl.voucher_header_id', voucherIds)
        .where('sl.stock_state', 'ON_HAND').select('sl.voucher_line_id')
        .sum({ posted_in: trx.raw('CASE WHEN sl.direction = 1 THEN CASE WHEN sl.category = \'RM\' THEN sl.qty ELSE sl.qty_pairs END ELSE 0 END'),
          posted_out: trx.raw('CASE WHEN sl.direction = -1 THEN CASE WHEN sl.category = \'RM\' THEN sl.qty ELSE sl.qty_pairs END ELSE 0 END'),
          increase_value: trx.raw('CASE WHEN sl.direction = 1 THEN ABS(sl.value) ELSE 0 END'), decrease_value: trx.raw('CASE WHEN sl.direction = -1 THEN ABS(sl.value) ELSE 0 END') })
        .groupBy('sl.voucher_line_id');
      const wipLedger = hasWip ? await trx('erp.wip_dept_ledger as wl').whereIn('wl.source_voucher_id', voucherIds).where('wl.stock_state', WIP_ON_HAND)
        .select('wl.source_voucher_id', 'wl.dept_id', 'wl.sku_id')
        .sum({ posted_in: trx.raw('CASE WHEN wl.direction = 1 THEN wl.qty_pairs ELSE 0 END'), posted_out: trx.raw('CASE WHEN wl.direction = -1 THEN wl.qty_pairs ELSE 0 END'),
          increase_value: trx.raw('CASE WHEN wl.direction = 1 THEN wl.cost_value ELSE 0 END'), decrease_value: trx.raw('CASE WHEN wl.direction = -1 THEN wl.cost_value ELSE 0 END') })
        .groupBy('wl.source_voucher_id', 'wl.dept_id', 'wl.sku_id') : [];
      const warehouse = new Map(warehouseLedger.map(row => [Number(row.voucher_line_id), row]));
      const wipKey = row => `${row.source_voucher_id || row.voucher_id}:${row.dept_id}:${row.sku_id}`;
      const wip = new Map(wipLedger.map(row => [wipKey(row), row]));
      const seenWip = new Set(), wipCounts = new Map();
      rawRows.filter(row => row.wip_reason_id).forEach(row => wipCounts.set(wipKey(row), (wipCounts.get(wipKey(row)) || 0) + 1));
      const reasonMap = new Map(), productGroupMap = new Map(), productSubgroupMap = new Map(), articleMap = new Map();
      const rows = rawRows.map(row => {
        const isWip = Boolean(row.wip_reason_id), meta = typeof row.meta === 'object' && row.meta ? row.meta : {};
        const stockType = row.item_type_scope || row.item_type;
        const systemRaw = isWip ? meta.system_qty : stockType === 'RM' ? row.system_qty_snapshot : row.system_qty_pairs_snapshot;
        const countedRaw = isWip ? row.qty : stockType === 'RM' ? row.physical_qty : row.physical_qty_pairs;
        const systemQty = systemRaw == null ? null : qty(systemRaw);
        const countedQty = countedRaw == null ? null : qty(countedRaw);
        const difference = systemQty == null || countedQty == null ? null : qty(countedQty - systemQty);
        const key = wipKey(row), sharedPosting = isWip && wipCounts.get(key) > 1;
        const posting = row.status === 'APPROVED' ? isWip ? seenWip.has(key) ? null : wip.get(key) : warehouse.get(Number(row.line_id)) : null;
        if (isWip) seenWip.add(key);
        const postedIn = qty(posting?.posted_in), postedOut = qty(posting?.posted_out);
        const increaseValue = canViewCostFields ? money(posting?.increase_value) : null, decreaseValue = canViewCostFields ? money(posting?.decrease_value) : null;
        const reasonId = Number(row.wip_reason_id || row.reason_code_id || 0);
        if (reasonId) reasonMap.set(reasonId, { id: reasonId, name: row.reason_name || '-' });
        if (row.product_group_id) productGroupMap.set(Number(row.product_group_id), { id: Number(row.product_group_id), name: row.product_group_name || '-' });
        if (row.product_subgroup_id) productSubgroupMap.set(Number(row.product_subgroup_id), { id: Number(row.product_subgroup_id), name: row.product_subgroup_name || '-' });
        if (row.article_id) articleMap.set(Number(row.article_id), { id: Number(row.article_id), name: row.article_name || '-' });
        return { voucherId: Number(row.voucher_id), voucherNo: row.voucher_no, lineId: Number(row.line_id), date: toLocalDateOnly(row.voucher_date),
          branchId: Number(row.branch_id), branchName: row.branch_name || '-', status: row.status, reasonId, reasonName: row.reason_name || '-',
          departmentId: Number(row.dept_id || 0), departmentName: row.department_name, articleId: Number(row.article_id || 0), articleName: row.article_name || '-', skuId: Number(row.sku_id || 0), skuCode: row.sku_code || '',
          productGroupId: Number(row.product_group_id || 0), productSubgroupId: Number(row.product_subgroup_id || 0),
          stockType: isWip ? 'WIP' : stockType, sourceKey: isWip ? 'stock_count_source_wip' : 'stock_count_source_warehouse',
          unit: stockType === 'RM' && !isWip ? row.unit_code || '' : 'PAIR', systemQty, countedQty, difference,
          postedIn, postedOut, increaseValue, decreaseValue, netValue: canViewCostFields ? money(increaseValue - decreaseValue) : null,
          unitCost: canViewCostFields && postedIn + postedOut > 0 ? Number(((increaseValue + decreaseValue) / (postedIn + postedOut)).toFixed(6)) : null,
          notes: row.reason_notes || row.notes || '', sharedPosting,
          postingMissing: row.status === 'APPROVED' && difference !== null && difference !== 0 && !(isWip ? wip.has(key) : warehouse.has(Number(row.line_id))),
          voucherUrl: canViewVouchers && Number(row.branch_id) === Number(req.branchId) ? `/vouchers/stock-count?voucher_no=${encodeURIComponent(row.voucher_no)}&view=1` : '',
        };
      });
      const byName = map => [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
      options.reasons = byName(reasonMap); options.articles = byName(articleMap);
      options.productGroups = byName(productGroupMap); options.productSubgroups = byName(productSubgroupMap);
      if (!filters.reportLoaded) return { filters, options, reportData };
      reportData.rows = rows.filter(row => (!filters.stockTypes.length || filters.stockTypes.includes(row.stockType)) &&
        (!filters.statuses.length || filters.statuses.includes(row.status)) && (!filters.reasonIds.length || filters.reasonIds.includes(row.reasonId)) &&
        (!filters.productGroupIds.length || filters.productGroupIds.includes(row.productGroupId)) &&
        (!filters.productSubgroupIds.length || filters.productSubgroupIds.includes(row.productSubgroupId)) &&
        (!filters.articleIds.length || filters.articleIds.includes(row.articleId)));
      reportData.groups = buildGroups(reportData.rows, filters.orderBy, locale);
      const unitTotals = new Map();
      for (const row of reportData.rows) {
        const key = `${row.stockType}:${row.unit}`;
        const total = unitTotals.get(key) || { stockType: row.stockType, unit: row.unit, postedIn: 0, postedOut: 0 };
        total.postedIn = qty(total.postedIn + row.postedIn); total.postedOut = qty(total.postedOut + row.postedOut); unitTotals.set(key, total);
      }
      reportData.unitTotals = [...unitTotals.values()];
      reportData.totals = { vouchers: new Set(reportData.rows.map(row => row.voucherId)).size, lines: reportData.rows.length,
        pending: new Set(reportData.rows.filter(row => row.status === 'PENDING').map(row => row.voucherId)).size,
        increaseValue: canViewCostFields ? money(reportData.rows.reduce((sum, row) => sum + row.increaseValue, 0)) : null,
        decreaseValue: canViewCostFields ? money(reportData.rows.reduce((sum, row) => sum + row.decreaseValue, 0)) : null,
        netValue: canViewCostFields ? money(reportData.rows.reduce((sum, row) => sum + row.netValue, 0)) : null };
      return { filters, options, reportData };
    }, { isolationLevel: 'repeatable read', readOnly: true });
  } catch (err) { console.error('Error in StockCountReportService:', err); throw err; }
};

module.exports = { getStockCountDetailsReportPageData };
