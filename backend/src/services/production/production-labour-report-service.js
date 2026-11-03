'use strict';

const knex = require('../../db/knex');
const { HttpError } = require('../../middleware/errors/http-error');
const { localizedNameSelect } = require('../../utils/localized-name');
const { normalizeReportBranchIds, getReportAllowedBranchIds, reportCanFilterAllBranches, toIdListWithAll, toStringListWithAll } = require('../../utils/report-branch-scope');

const UNASSIGNED = '__UNASSIGNED__';
const parseLabourFilter = value => {
  const tokens = toStringListWithAll(value);
  if (tokens.some(token => token.toUpperCase() !== UNASSIGNED && (!/^[1-9]\d*$/.test(token) || !Number.isSafeInteger(Number(token))))) throw new HttpError(400, 'production_report_invalid_labours');
  return { labourIds: toIdListWithAll(tokens), labourUnassigned: tokens.some(token => token.toUpperCase() === UNASSIGNED) };
};

const matchesLabourFilter = (id, filters) => (!filters.labourIds?.length && !filters.labourUnassigned) ||
  filters.labourIds?.includes(Number(id)) || (filters.labourUnassigned && !Number(id));

const loadProductionLabours = async ({ req, branchIds, scopeKey, db = knex }) => {
  try {
    const allBranches = req.user?.isAdmin || reportCanFilterAllBranches(req, scopeKey);
    if (!allBranches && !getReportAllowedBranchIds(req).length) return [];
    const scoped = normalizeReportBranchIds({ req, value: branchIds, scopeKey });
    const hasDcvLine = await db.schema.withSchema('erp').hasTable('dcv_line');
    const query = db('erp.labours as l').select('l.id', localizedNameSelect('l', 'name', req.locale)).orderBy('l.name');
    if (scoped.length) query.where(function scopedLabours() {
      this.whereExists(function assignedBranch() {
        this.select(1).from('erp.labour_branch as lb').whereRaw('lb.labour_id = l.id').whereIn('lb.branch_id', scoped);
      }).orWhereExists(function historicalHeader() {
        this.select(1).from('erp.dcv_header as dh').join('erp.voucher_header as vh', 'vh.id', 'dh.voucher_id')
          .whereRaw('dh.labour_id = l.id').where('vh.status', 'APPROVED').whereIn('vh.branch_id', scoped);
      });
      if (hasDcvLine) this.orWhereExists(function historicalLine() {
        this.select(1).from('erp.dcv_line as dl').join('erp.voucher_line as historical_vl', 'historical_vl.id', 'dl.voucher_line_id')
          .join('erp.voucher_header as vh', 'vh.id', 'historical_vl.voucher_header_id')
          .whereRaw('dl.labour_id = l.id').where('vh.status', 'APPROVED').whereIn('vh.branch_id', scoped);
      });
    });
    return await query;
  } catch (err) { console.error('Error in ProductionLabourOptionsService:', err); throw err; }
};

// Consumption may combine several output rows. Attribute only when every
// matching source row resolves to the same worker; never copy the first worker
// from a multi-worker DCV onto the whole material consumption.
const resolveConsumptionLabours = async ({ rows, db = knex }) => {
  try {
    const result = new Map();
    const ids = [...new Set(rows.map(row => Number(row.source_voucher_id || 0)).filter(id => id > 0))];
    if (!ids.length) return result;
    const hasLines = await db.schema.withSchema('erp').hasTable('dcv_line');
    const labourSql = hasLines ? 'COALESCE(dl.labour_id, dh.labour_id)' : 'dh.labour_id';
    let query = db('erp.voucher_header as vh').join('erp.voucher_line as svl', 'svl.voucher_header_id', 'vh.id')
      .join('erp.dcv_header as dh', 'dh.voucher_id', 'vh.id')
      .whereIn('vh.id', ids).where({ 'vh.status': 'APPROVED', 'vh.voucher_type_code': 'DCV', 'svl.line_kind': 'SKU' })
      .whereIn('vh.branch_id', [...new Set(rows.map(row => Number(row.branch_id)))])
      .select('vh.id as voucher_id', 'vh.branch_id', 'svl.sku_id');
    if (hasLines) query.leftJoin('erp.dcv_line as dl', 'dl.voucher_line_id', 'svl.id');
    query.leftJoin('erp.labours as l', 'l.id', db.raw(labourSql)).select(db.raw(`${labourSql} as labour_id`),
      db.raw((hasLines ? 'COALESCE(dl.dept_id, dh.dept_id)' : 'dh.dept_id') + ' as dept_id'),
      db.raw((hasLines ? 'COALESCE(dl.stage_id, dh.stage_id)' : 'dh.stage_id') + ' as stage_id'), localizedNameSelect('l', 'labour_name', rows[0]?.report_locale || 'en'));
    const sourceRows = await query;
    const byVoucher = new Map();
    for (const source of sourceRows) { const group = byVoucher.get(Number(source.voucher_id)) || []; group.push(source); byVoucher.set(Number(source.voucher_id), group); }
    for (const row of rows) {
      // A multi-department DCV's header describes only its first department.
      // Without per-consumption metadata, inspect every source row instead of
      // treating that legacy header fallback as proof of worker ownership.
      const meta = row.metaObj || {}, skuId = Number(meta.source_sku_id || 0), deptId = Number(meta.department_id || meta.dept_id || 0), stageId = Number(meta.stage_id || 0);
      const candidates = (byVoucher.get(Number(row.source_voucher_id)) || []).filter(source => Number(source.branch_id) === Number(row.branch_id) &&
        (!skuId || Number(source.sku_id) === skuId) && (!deptId || Number(source.dept_id) === deptId) && (!stageId || Number(source.stage_id) === stageId));
      const workers = new Set(candidates.map(source => Number(source.labour_id || 0)));
      const onlyId = workers.size === 1 ? [...workers][0] : 0;
      const worker = onlyId ? candidates.find(source => Number(source.labour_id) === onlyId) : null;
      result.set(row, { id: onlyId || null, name: worker?.labour_name || null, ambiguous: workers.size > 1 });
    }
    return result;
  } catch (err) { console.error('Error in ProductionConsumptionLabourService:', err); throw err; }
};

module.exports = { UNASSIGNED, parseLabourFilter, matchesLabourFilter, loadProductionLabours, resolveConsumptionLabours };
