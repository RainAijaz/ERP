const { normalizeEligibility, validateEligibilityReferences } = require('./commission-eligibility-service');

const TYPES = new Set(['SALESMAN_SALE','BRANCH_SALE','TRANSFER','PARTY','PRODUCTION_FG','PRODUCTION_SFG','PRODUCTION_STAGE']);
const itemTypesForCommission = (type) => type === 'PRODUCTION_SFG' ? ['SFG'] : type === 'PRODUCTION_STAGE' ? ['FG','SFG'] : ['FG'];

const searchCommissionOptions = async ({ db, input, req, locale = 'en' }) => {
  const kind = String(input.kind || '');
  const type = String(input.commission_type || 'SALESMAN_SALE');
  if (!TYPES.has(type)) throw new Error('error_invalid_commission_type');
  const term = String(input.q || '').trim().slice(0, 100);
  const offset = Math.max(0, Math.min(Number.parseInt(input.offset, 10) || 0, 100000));
  const ids = String(input.ids || '').split(',').filter(Boolean).map(Number);
  if (ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('commission_invalid_conditions');
  const allowed = req.user?.isAdmin ? null : (req.branchScope || []).map(Number);
  let query;
  if (kind === 'sku') {
    query = db('erp.skus as o').join('erp.variants as v','v.id','o.variant_id').join('erp.items as i','i.id','v.item_id')
      .select('o.id as value',db.raw(`o.sku_code || ' - ' || ${locale==='ur'?"COALESCE(NULLIF(i.name_ur,''),i.name)":'i.name'} as label`))
      .whereIn('i.item_type',itemTypesForCommission(type));
    if (term) query.where((q) => q.whereILike('o.sku_code',`%${term}%`).orWhereILike('i.name',`%${term}%`));
  } else {
    const tables = { worker: 'erp.labours', department: 'erp.departments', stage: 'erp.production_stages',
      grade: 'erp.grades', group: 'erp.product_groups', subgroup: 'erp.product_subgroups', branch: 'erp.branches' };
    if (!tables[kind]) throw new Error('commission_invalid_conditions');
    const label = locale === 'ur' ? "COALESCE(NULLIF(o.name_ur,''),o.name)" : 'o.name';
    query = db(`${tables[kind]} as o`).select('o.id as value',db.raw(`${label} as label`));
    if (term) query.whereILike('o.name',`%${term}%`);
    if (kind === 'branch' && allowed) query.whereIn('o.id',allowed);
    if (kind === 'worker' && allowed) query.whereExists(function () {
      this.select(1).from('erp.labour_branch as lb').whereRaw('lb.labour_id=o.id').whereIn('lb.branch_id',allowed);
    });
    if (kind === 'worker') query.where('o.status','active');
    if (kind === 'stage' && input.department_ids) {
      const departments = normalizeEligibility({ department_ids: String(input.department_ids).split(',') }).department_ids;
      query.whereIn('o.dept_id', departments);
    }
    if (kind === 'group' || kind === 'subgroup') query.whereExists(function () {
      this.select(1).from('erp.items as i').whereRaw(`i.${kind === 'group' ? 'group_id' : 'subgroup_id'}=o.id`).whereIn('i.item_type',itemTypesForCommission(type));
    });
  }
  if (ids.length) query.whereIn('o.id',ids);
  const rows = await query.orderBy('label').orderBy('o.id').offset(ids.length ? 0 : offset).limit(ids.length || 51);
  return { options: rows.slice(0,ids.length || 50), has_more: !ids.length && rows.length > 50, offset };
};

const validateConfiguration = async ({ db, eligibility, commissionType, employeeIds, req }) =>
  validateEligibilityReferences({ db, eligibility, commissionType, employeeIds,
    allowedBranchIds: req.user?.isAdmin ? null : (req.branchScope || []).map(Number) });

// DCV lines are the authoritative record for worker and department attribution.
// Both live posting and historical recalculation use this exact loader.
const loadStageCommissionLines = async (db, voucherId) => {
  const rows = await db('erp.voucher_line as vl').leftJoin('erp.dcv_line as dl','dl.voucher_line_id','vl.id')
    .join('erp.dcv_header as dh','dh.voucher_id','vl.voucher_header_id')
    .where('vl.voucher_header_id',voucherId).where('vl.line_kind','SKU')
    .select('vl.*',db.raw('COALESCE(dl.labour_id,dh.labour_id) as labour_id'),db.raw('COALESCE(dl.dept_id,dh.dept_id) as dept_id'),db.raw('CASE WHEN dl.voucher_line_id IS NULL THEN dh.stage_id ELSE dl.stage_id END as stage_id')).orderBy('vl.line_no');
  return rows.map((row) => ({ ...row, total_pairs: Number(row.meta?.total_pairs ?? row.qty) || 0 }));
};

const captureProductionCommissionContexts = async (db,voucherId) => {
  await db.raw(`UPDATE erp.voucher_line vl SET meta=COALESCE(vl.meta,'{}'::jsonb) ||
    jsonb_build_object('commission_context',jsonb_build_object('sku_id',s.id,'grade_id',v.grade_id,'group_id',i.group_id,'subgroup_id',i.subgroup_id))
    FROM erp.skus s JOIN erp.variants v ON v.id=s.variant_id JOIN erp.items i ON i.id=v.item_id
    WHERE vl.voucher_header_id=? AND vl.sku_id=s.id AND
      COALESCE((vl.meta->'commission_context'->>'sku_id')::bigint,0)<>s.id`,[voucherId]);
  const rows = await db('erp.voucher_line').where('voucher_header_id',voucherId).where('line_kind','SKU').select('line_no','meta');
  return new Map(rows.map(row=>[Number(row.line_no),row.meta?.commission_context]));
};

module.exports = { TYPES, itemTypesForCommission, searchCommissionOptions, validateConfiguration, loadStageCommissionLines, captureProductionCommissionContexts };
