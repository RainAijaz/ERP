'use strict';

const { createHash } = require('node:crypto');
const knex = require('../../db/knex');
const { HttpError } = require('../../middleware/errors/http-error');
const { canAccessScope } = require('../../middleware/access/role-permissions');
const { handleScreenApproval, hasPermission } = require('../../middleware/approvals/screen-approval');
const { canonicalJson } = require('../../utils/canonical-json');
const { insertActivityLog } = require('../../utils/audit-log');
const { normalizeEligibility, eligibilityKey, validateEligibilityReferences, CONDITION_FIELDS } = require('./commission-eligibility-service');
const { TYPES, itemTypesForCommission, searchCommissionOptions } = require('./commission-configuration-service');
const { supersedeCommissionRule, normalizeRuleDate, todayYmd, deriveValueTypeFromBasis } = require('./commission-rules-service');
const { normalizeRecalcInput, buildRecalcPlan, applyRecalcPlan, COMPUTABLE_TYPES } = require('./commission-recalc-service');

const MODE = 'COMMISSION_BATCH_V1';
const scopeFields = { SKU: ['sku_ids','sku_id'], ARTICLE: ['article_ids','article_id'], CATEGORY: ['category_ids','category_id'], GROUP: ['group_ids','group_id'], SUBGROUP: ['subgroup_ids','subgroup_id'], ALL: [null,null] };
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (key = 'commission_batch_invalid', status = 400, cardId = null) => { throw new HttpError(status,key,cardId ? { card_id:cardId } : undefined); };
const bool = value => value === true || value === 'true' || value === 'on';
const ids = (value, cardId) => {
  if (!Array.isArray(value) || !value.length || value.length > 500 || value.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) fail('commission_invalid_conditions',400,cardId);
  return [...new Set(value.map(Number))].sort((a,b)=>a-b);
};
const sourceOverlap = (a,b) => ['branch_ids','source_labour_ids','department_ids','stage_ids'].every(key => !a[key] || !b[key] || a[key].some(id => b[key].includes(id)));
const validationError = err => {
  if(!err.status && !err.code && ['commission_invalid_conditions','commission_stage_required','error_branch_out_of_scope','error_employee_not_at_branch','error_invalid_date_range'].includes(err.message))err.status=400;
  return err;
};
const overlapsDates = (a,b) => (a.effective_from || '1900-01-01') <= (b.effective_to || '9999-12-31') && (b.effective_from || '1900-01-01') <= (a.effective_to || '9999-12-31');
const identity = row => canonicalJson([row.commission_type,row.commission_basis,row.apply_on,Number(row.branch_id)||0,...['sku_id','article_id','category_id','group_id','subgroup_id'].map(key=>Number(row[key])||0),eligibilityKey(row.eligibility)]);

const normalizeBatch = raw => {
  if (!raw || typeof raw !== 'object' || Number(raw.version) !== 1 || !Number.isSafeInteger(Number(raw.employee_id)) || Number(raw.employee_id) <= 0 || !Array.isArray(raw.cards) || !raw.cards.length || raw.cards.length > 20) fail();
  const from = normalizeRuleDate(raw.defaults?.effective_from);
  const to = normalizeRuleDate(raw.defaults?.effective_to);
  if (!from || to === undefined || (to && to < from)) fail('error_invalid_date_range');
  const cardIds = new Set(); let selections = 0;
  const cards = raw.cards.map(card => {
    if (!card || typeof card !== 'object' || !/^[\w-]{1,80}$/.test(String(card.card_id || '')) || cardIds.has(card.card_id)) fail();
    const id = card.card_id; cardIds.add(id);
    if (!TYPES.has(card.commission_type) || !Object.hasOwn(scopeFields,card.apply_on)) fail('commission_batch_invalid',400,id);
    const basis = card.commission_basis || 'FIXED_PER_UNIT';
    const valueType = deriveValueTypeFromBasis(basis);
    const rate = Number(card.value);
    if (!valueType || card.value == null || String(card.value).trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 99999999.99 || !/^\d+(\.\d{1,2})?$/.test(String(card.value))) fail('error_invalid_rate_value',400,id);
    if (card.status && !['active','inactive'].includes(card.status))fail('error_invalid_status',400,id);
    if (!['PER_PAIR','PER_DOZEN'].includes(card.rate_type)) fail('error_invalid_rate_type',400,id);
    const effectiveFrom = card.effective_from ? normalizeRuleDate(card.effective_from) : from;
    const effectiveTo = Object.hasOwn(card,'effective_to') ? normalizeRuleDate(card.effective_to) : to;
    if (!effectiveFrom || effectiveTo === undefined || (effectiveTo && effectiveTo < effectiveFrom)) fail('error_invalid_date_range',400,id);
    let conditions = card.eligibility || {};
    if (typeof conditions === 'string') { try { conditions=JSON.parse(conditions); } catch { fail('commission_invalid_conditions',400,id); } }
    if (!conditions || Object.keys(conditions).some(key=>!CONDITION_FIELDS.includes(key) && key!=='sales_quantity_scope')) fail('commission_invalid_conditions',400,id);
    const eligibility = normalizeEligibility(conditions,card.commission_type);
    const [plural] = scopeFields[card.apply_on];
    const selected = plural ? ids(card[plural],id) : [];
    selections += selected.length;
    if (selections > 1000) fail('commission_batch_too_large');
    for (const [other] of Object.values(scopeFields)) if (other && other !== plural && card[other]?.length) fail('commission_batch_invalid',400,id);
    return { card_id:id,commission_type:card.commission_type,apply_on:card.apply_on, ...(plural ? {[plural]:selected}:{}),
      commission_basis:basis,rate_type:card.rate_type,value:rate,value_type:valueType,reverse_on_returns:bool(card.reverse_on_returns),
      effective_from:effectiveFrom,effective_to:effectiveTo || null,eligibility,
      replace_existing_sku_rates:bool(card.replace_existing_sku_rates),status:card.status === 'inactive' ? 'inactive' : 'active' };
  }).sort((a,b)=>a.card_id.localeCompare(b.card_id));
  return {version:1,employee_id:Number(raw.employee_id),defaults:{effective_from:from,effective_to:to || null},clear_unmatched:bool(raw.clear_unmatched),cards};
};

const validateAccess = async (db,req,employeeId) => {
  if (!canAccessScope(req,'SCREEN','hr_payroll.commissions','view')) fail('error_branch_out_of_scope',403);
  const employee = await db('erp.employees').where('id',employeeId).first();
  if (!employee || employee.status !== 'active') fail('error_required_fields');
  const branches = (await db('erp.employee_branch').where('employee_id',employeeId).select('branch_id')).map(row=>Number(row.branch_id));
  if (!branches.length) fail('error_employee_not_at_branch');
  if (!req.user?.isAdmin) {
    if (branches.some(id=>!(req.branchScope || []).map(Number).includes(id))) fail('error_branch_out_of_scope',403);
    const { getUserEntityBlockedSet } = require('../administration/entity-ledger-access-service');
    if ((await getUserEntityBlockedSet({ userId:Number(req.user.id),entityType:'EMPLOYEE' })).has(employeeId)) fail('error_branch_out_of_scope',403);
  }
  return {employee,branches};
};

const productRows = (db,card) => {
  const query=db('erp.skus as s').join('erp.variants as v','v.id','s.variant_id').join('erp.items as i','i.id','v.item_id')
    .whereIn('i.item_type',itemTypesForCommission(card.commission_type));
  const [plural] = scopeFields[card.apply_on];
  const column={SKU:'s.id',ARTICLE:'i.id',CATEGORY:'i.product_type_id',GROUP:'i.group_id',SUBGROUP:'i.subgroup_id'}[card.apply_on];
  if (plural) query.whereIn(column,card[plural]);
  return query;
};

const validateBatch = async (db,req,batch) => {
  const scope=await validateAccess(db,req,batch.employee_id);
  const existing=(await db('erp.employee_commission_rules').where('employee_id',batch.employee_id).orderBy('id')).map(row=>({...row,
    effective_from:normalizeRuleDate(row.effective_from),effective_to:normalizeRuleDate(row.effective_to),eligibility:normalizeEligibility(row.eligibility,row.commission_type)}));
  const expanded=[]; const retired=[]; const summaries=[];
  for (const card of batch.cards) {
    card.eligibility=await validateEligibilityReferences({db,eligibility:card.eligibility,commissionType:card.commission_type,employeeIds:[batch.employee_id],allowedBranchIds:scope.branches});
    const reviewedConditions=[];
    const kinds={excluded_category_ids:'category',excluded_article_ids:'article',excluded_sku_ids:'sku',excluded_grade_ids:'grade',excluded_group_ids:'group',excluded_subgroup_ids:'subgroup',branch_ids:'branch',source_labour_ids:'worker',department_ids:'department',stage_ids:'stage'};
    for(const [key,values] of Object.entries(card.eligibility)) if(kinds[key]) {
      const options=await searchCommissionOptions({db,input:{kind:kinds[key],ids:values.join(','),commission_type:card.commission_type},req,locale:req.locale || 'en'});
      if(options.options.length!==values.length)fail('commission_invalid_conditions',400,card.card_id);
      reviewedConditions.push({key,labels:options.options.map(option=>option.label)});
    }
    const [plural,singular]=scopeFields[card.apply_on];
    if (plural) {
      const columns={SKU:['erp.skus','id'],ARTICLE:['erp.items','id'],CATEGORY:['erp.product_types','id'],GROUP:['erp.product_groups','id'],SUBGROUP:['erp.product_subgroups','id']};
      const [table,column]=columns[card.apply_on];
      const targets=await db(table).whereIn(column,card[plural]).select('*');
      if (targets.length !== card[plural].length || targets.some(row=>row.is_active===false)) fail('commission_invalid_conditions',400,card.card_id);
      const covered=await productRows(db,card).distinct({target:{SKU:'s.id',ARTICLE:'i.id',CATEGORY:'i.product_type_id',GROUP:'i.group_id',SUBGROUP:'i.subgroup_id'}[card.apply_on]});
      // Articles with no SKU yet are valid and cover future variants dynamically.
      if (card.apply_on==='ARTICLE') {
        if(targets.some(row=>!itemTypesForCommission(card.commission_type).includes(row.item_type))) fail('commission_invalid_conditions',400,card.card_id);
      } else if(covered.length !== card[plural].length) fail('commission_invalid_conditions',400,card.card_id);
      summaries.push({card_id:card.card_id,scope:card.apply_on,products:targets.map(row=>({id:Number(row.id),label:row.sku_code || row.code ? `${row.sku_code || row.code} - ${(req.locale==='ur'?row.name_ur:'') || row.name || ''}` : (req.locale==='ur'?row.name_ur:'') || row.name})),reviewed_conditions:reviewedConditions,...card});
    } else summaries.push({...card,products:[],reviewed_conditions:reviewedConditions});
    const affectedFrom=card.effective_from;
    if(await db('erp.employee_payroll_runs').where('employee_id',batch.employee_id).where('period_to','>=',affectedFrom).first('id')) fail('salary_period_finalized',400,card.card_id);
    for (const selected of plural ? card[plural] : [null]) {
      expanded.push({employee_id:batch.employee_id,...card, ...(singular ? {[singular]:selected}:{}),branch_id:null});
    }
    if(card.replace_existing_sku_rates && card.apply_on!=='SKU') {
      const matches=await productRows(db,card).select('s.id');
      const selectedSkus=new Set(matches.map(row=>Number(row.id)));
      existing.filter(row=>row.apply_on==='SKU' && row.commission_type===card.commission_type && row.commission_basis===card.commission_basis &&
        eligibilityKey(row.eligibility)===eligibilityKey(card.eligibility) && selectedSkus.has(Number(row.sku_id)) && !row.branch_id)
        .forEach(row=>retired.push({id:Number(row.id),from:card.effective_from}));
    }
  }
  for(let i=0;i<expanded.length;i++) {
    const row=expanded[i]; const [,_target]=scopeFields[row.apply_on];
    const sameProduct=other=>other.apply_on===row.apply_on && (!_target || Number(other[_target])===Number(row[_target])) &&
      other.commission_type===row.commission_type && other.commission_basis===row.commission_basis && !other.branch_id;
    const conflicts=expanded.slice(i+1).filter(sameProduct).some(other=>overlapsDates(row,other) && sourceOverlap(row.eligibility,other.eligibility));
    const conflictsExisting=existing.filter(sameProduct).filter(other=>identity(row)!==identity(other)).some(other=>other.status==='active' && overlapsDates(row,other) && sourceOverlap(row.eligibility,other.eligibility));
    if(conflicts || conflictsExisting) fail('commission_batch_overlap',400,row.card_id);
  }
  const candidates=existing.map(row=>({...row}));
  const close = (predicate,from) => {
    for(let i=candidates.length-1;i>=0;i--) if(predicate(candidates[i])) {
      if(candidates[i].effective_from && candidates[i].effective_from>=from) candidates.splice(i,1);
      else if(!candidates[i].effective_to || candidates[i].effective_to>=from) {
        const day=new Date(from+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-1);candidates[i].effective_to=day.toISOString().slice(0,10);
      }
    }
  };
  retired.forEach(row=>close(candidate=>Number(candidate.id)===row.id,row.from));
  let nextId=-1;
  expanded.forEach(row=>{close(candidate=>identity(candidate)===identity(row),row.effective_from);candidates.push({...row,id:nextId--,inherited_sku_copy:false});});
  return {...scope,existing,expanded,candidates,retired,summaries};
};

const recalcInputs = (batch,branches) => {
  const result=[];
  for(const type of [...new Set(batch.cards.map(card=>card.commission_type))]) {
    if(!COMPUTABLE_TYPES.includes(type)) continue;
    const cards=batch.cards.filter(card=>card.commission_type===type);
    const from=cards.map(card=>card.effective_from).sort()[0];
    const to=cards.map(card=>card.effective_to || todayYmd()).sort().at(-1);
    if(from>todayYmd()) continue;
    result.push(normalizeRecalcInput({employee_id:batch.employee_id,commission_types:[type],from_date:from,to_date:to>todayYmd()?todayYmd():to,allowedBranchIds:branches,clear_orphans:true}));
  }
  return result;
};

// Hash actual source records, not just money: equal totals with changed product,
// worker attribution or rule breakdown still invalidate a reviewed preview.
const reviewedState = async (db,batch,validated) => {
  const inputs=recalcInputs(batch,validated.branches);
  const from=inputs.map(row=>row.fromDate).sort()[0] || todayYmd();
  const to=inputs.map(row=>row.toDate).sort().at(-1) || todayYmd();
  const vouchers=await db('erp.voucher_header').whereIn('branch_id',validated.branches).whereBetween('voucher_date',[from,to]).whereIn('voucher_type_code',['SALES_VOUCHER','STN_OUT','DCV','PROD_FG','PROD_SFG']).orderBy('id').limit(2001);
  if(vouchers.length>2000) fail('error_recalc_over_limit');
  const voucherIds=vouchers.map(row=>row.id);
  const state={day:todayYmd(),batch,employee:validated.employee,branches:validated.branches.sort((a,b)=>a-b),rules:validated.existing,vouchers};
  for(const [key,table,column] of [['lines','erp.voucher_line','voucher_header_id'],['sales','erp.sales_header','voucher_id'],['dcv','erp.dcv_header','voucher_id'],['stock','erp.stock_ledger','voucher_header_id']]) {
    state[key]=voucherIds.length?await db(table).whereIn(column,voucherIds).orderBy(column):[];
    state[key].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
  }
  const lineIds=state.lines.map(row=>row.id);
  state.stageLines=lineIds.length?await db('erp.dcv_line').whereIn('voucher_line_id',lineIds).orderBy('voucher_line_id'):[];
  state.earnings=voucherIds.length?await db('erp.commission_ledger').where('employee_id',batch.employee_id).whereIn('voucher_id',voucherIds).orderBy('id'):[];
  state.payroll=await db('erp.employee_payroll_runs').where('employee_id',batch.employee_id).orderBy('id');
  // Aggregate on the server to avoid returning/preloading large catalogues.
  state.catalogue={};
  for(const table of ['items','variants','skus','product_types','product_groups','product_subgroups','grades']) {
    const result=await db.raw(`SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY t.id),'')) AS signature FROM erp.?? t`,[table]);
    state.catalogue[table]=result.rows[0].signature;
  }
  return hash(state);
};

const financialPreview = async (db,batch,validated,projected=true) => {
  const plans=[];
  for(const input of recalcInputs(batch,validated.branches)) {
    const plan=await buildRecalcPlan({db,input,ruleOverrides:projected?validated.candidates:null});
    if(plan.over_limit) fail('error_recalc_over_limit');
    plans.push(plan);
  }
  if(plans.reduce((sum,plan)=>sum+plan.counts.writes,0)>500) fail('error_recalc_over_limit');
  return plans;
};

const previewBatch = async ({req,input,db=knex}) => {
  try {
    const batch=normalizeBatch(input);
    return await db.transaction(async trx=>{
      const validated=await validateBatch(trx,req,batch);
      const fingerprint=await reviewedState(trx,batch,validated);
      const plans=await financialPreview(trx,batch,validated);
      const rows=plans.flatMap(plan=>plan.rows).map(({write,...row})=>row);
      return {preview_hash:fingerprint,cards:validated.summaries,rows,
        requires_clear_confirmation:rows.some(row=>row.status==='cleared'),
        classification_fallback:rows.some(row=>row.classification_fallback),
        totals:plans.reduce((total,plan)=>({old_total:total.old_total+plan.totals.old_total,new_total:total.new_total+plan.totals.new_total,delta:total.delta+plan.totals.delta}),{old_total:0,new_total:0,delta:0})};
    },{isolationLevel:'repeatable read',readOnly:true});
  } catch(err) { console.error('Error in CommissionBatchService:',err);throw validationError(err); }
};

const applyBatchTx = async ({trx,req,batch,validated,approvalId=null}) => {
  const previews=await financialPreview(trx,batch,validated);
  if(!batch.clear_unmatched && previews.some(plan=>plan.orphans.length)) fail('commission_batch_clear_required');
  // Lock the employee before any earning/history writes, as payroll does.
  await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended('erp-payroll:' || ?::text,0))",[batch.employee_id]);
  for(const retired of validated.retired) {
    const day=new Date(retired.from+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-1);
    await trx('erp.employee_commission_rules').where('id',retired.id).where('effective_from','>=',retired.from).del();
    await trx('erp.employee_commission_rules').where('id',retired.id).where(q=>q.whereNull('effective_to').orWhere('effective_to','>=',retired.from)).update({effective_to:day.toISOString().slice(0,10)});
  }
  const ruleIds=[];
  for(const row of validated.expanded) ruleIds.push(await supersedeCommissionRule({trx,employeeId:batch.employee_id,commissionType:row.commission_type,applyOn:row.apply_on,
    skuId:row.sku_id,articleId:row.article_id,categoryId:row.category_id,groupId:row.group_id,subgroupId:row.subgroup_id,
    effectiveFrom:row.effective_from,effectiveTo:row.effective_to,values:{commission_basis:row.commission_basis,value_type:row.value_type,rate_type:row.rate_type,value:row.value,
      reverse_on_returns:row.reverse_on_returns,eligibility:row.eligibility,status:row.status,inherited_sku_copy:false}}));
  const plans=await financialPreview(trx,batch,validated,false);
  let writes=0;
  for(const plan of plans) {
    await applyRecalcPlan({trx,rows:plan.rows,provenance:{at:new Date().toISOString(),by:req.user.id,source:'commission-batch',approval_request_id:approvalId}});
    writes+=plan.counts.writes;
  }
  const action=approvalId?'APPROVE':validated.expanded.some(row=>validated.existing.some(prior=>identity(row)===identity(prior)))?'UPDATE':'CREATE';
  await insertActivityLog(trx,{user_id:req.user.id,branch_id:req.branchId,entity_type:'EMPLOYEE',entity_id:batch.employee_id,action,
    context:{source:'commission-batch',approval_request_id:approvalId,rule_ids:ruleIds,cards:batch.cards,message:`[${req.user.id}] performed [${action}] on [${batch.employee_id}] at [${new Date().toISOString()}].`}});
  return {applied:true,entityId:String(batch.employee_id),rule_ids:ruleIds,writes};
};

const saveBatch = async ({req,input,db=knex}) => {
  const postCommit=[];
  try {
    const batch=normalizeBatch(input);const payloadHash=hash(batch);
    const key=String(input.idempotency_key || '');const fingerprint=String(input.preview_hash || '');
    if(!/^[\w-]{8,100}$/.test(key) || !/^[a-f0-9]{64}$/.test(fingerprint)) fail();
    const result=await db.transaction(async trx=>{
      await validateAccess(trx,req,batch.employee_id);
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[`commission-batch:${req.user.id}:${key}`]);
      await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended('erp-payroll:' || ?::text,0))",[batch.employee_id]);
      const prior=await trx('erp.commission_batches').where({requested_by:req.user.id,idempotency_key:key}).first();
      if(prior) {
        if(prior.payload_hash!==payloadHash) fail('commission_batch_key_reused',409);
        if(prior.status==='PENDING' && prior.approval_request_id) {
          const decision=await trx('erp.approval_request').where('id',prior.approval_request_id).first('status');
          if(decision && ['REJECTED','WITHDRAWN'].includes(decision.status))return {closed:true,queued:false,approval_request_id:prior.approval_request_id,approval_status:decision.status,message:req.res.locals.t(decision.status==='REJECTED'?'approval_rejected':'approval_withdrawn')};
        }
        return prior.result;
      }
      const validated=await validateBatch(trx,req,batch);
      if(await reviewedState(trx,batch,validated)!==fingerprint) fail('commission_batch_stale',409);
      const plans=await financialPreview(trx,batch,validated);
      if(!batch.clear_unmatched && plans.some(plan=>plan.orphans.length)) fail('commission_batch_clear_required');
      const [receipt]=await trx('erp.commission_batches').insert({requested_by:req.user.id,employee_id:batch.employee_id,idempotency_key:key,payload_hash:payloadHash,preview_hash:fingerprint,payload:batch,status:'PENDING'}).returning('*');
      const updating=validated.retired.length>0 || plans.some(plan=>plan.rows.some(row=>Number(row.previous_rate)!==0 && row.previous_rate!=null && row.will_write)) || validated.expanded.some(row=>validated.existing.some(prior=>identity(row)===identity(prior)));
      const creating=validated.expanded.some(row=>!validated.existing.some(prior=>identity(row)===identity(prior)));
      const action=updating?'edit':'create';
      const forceQueue=(updating && !hasPermission(req.user,'hr_payroll.commissions','edit')) || (creating && !hasPermission(req.user,'hr_payroll.commissions','create'));
      const approval=await handleScreenApproval({req,scopeKey:'hr_payroll.commissions',action,forceQueue,entityType:'EMPLOYEE',entityId:String(batch.employee_id),
        summary:req.res.locals.t('commission_batch_title'),oldValue:null,newValue:{...batch,mode:MODE,batch_id:Number(receipt.id),preview_hash:fingerprint,
          allowed_branch_ids:validated.branches,reviewed_employee:(req.locale==='ur'?validated.employee.name_ur:'') || validated.employee.name,reviewed_cards:validated.summaries,reviewed_rows:plans.flatMap(plan=>plan.rows).map(({write,...row})=>row)},db:trx,postCommit});
      if(approval.queued) {
        const queued={queued:true,approval_request_id:approval.requestId,message:req.res.locals.t('approval_sent')};
        await trx('erp.commission_batches').where('id',receipt.id).update({approval_request_id:approval.requestId,result:queued});
        return queued;
      }
      const applied=await applyBatchTx({trx,req,batch,validated});
      const response={ok:true,...applied,message:req.res.locals.t('commission_batch_saved')};
      await trx('erp.commission_batches').where('id',receipt.id).update({status:'APPLIED',applied_at:trx.fn.now(),result:response});
      return response;
    },{isolationLevel:'serializable'});
    postCommit.forEach(notify=>{try {notify();} catch(err) {console.error('Error in CommissionBatchNotification:',err);}});
    return result;
  } catch(err) {
    if(['23505','40001'].includes(err.code)) {
      const prior=await db('erp.commission_batches').where({requested_by:req.user.id,idempotency_key:String(input.idempotency_key || '')}).first();
      if(prior) {
        if(prior.payload_hash!==hash(normalizeBatch(input)))fail('commission_batch_key_reused',409);
        return prior.result;
      }
      if(err.code==='40001')fail('commission_batch_stale',409);
    }
    console.error('Error in CommissionBatchService:',err);throw validationError(err);
  }
};

const applyBatchApproval = async ({trx,request,decidedBy}) => {
  try {
    const values=request.new_value;
    const receipt=await trx('erp.commission_batches').where({id:values.batch_id,approval_request_id:request.id}).forUpdate().first();
    if(!receipt || Number(receipt.requested_by)!==Number(request.requested_by) || String(receipt.employee_id)!==String(request.entity_id)) fail();
    if(receipt.status==='APPLIED') return {...receipt.result,applied:true};
    const { loadUserContext }=require('../../middleware/core/auth');
    const maker=await loadUserContext(receipt.requested_by,{freshPermissions:true});const approver=await loadUserContext(decidedBy,{freshPermissions:true});
    if(!canAccessScope({user:approver},'SCREEN','administration.approvals','approve')) fail('error_branch_out_of_scope',403);
    if(!approver.isAdmin && values.allowed_branch_ids.some(id=>!approver.branchIds.map(Number).includes(Number(id)))) fail('error_branch_out_of_scope',403);
    const { resolveTranslation }=require('../../middleware/core/locale');
    const req={user:maker,branchId:request.branch_id,branchScope:maker.branchIds.map(Number),locale:'en',res:{locals:{t:key=>resolveTranslation('en',key)}}};
    const batch=normalizeBatch(receipt.payload);
    if(hash(normalizeBatch(values))!==receipt.payload_hash || values.preview_hash!==receipt.preview_hash) fail('commission_batch_stale',409);
    await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended('erp-payroll:' || ?::text,0))",[batch.employee_id]);
    const validated=await validateBatch(trx,req,batch);
    if(await reviewedState(trx,batch,validated)!==receipt.preview_hash) fail('commission_batch_stale',409);
    const applied=await applyBatchTx({trx,req:{...req,user:approver},batch,validated,approvalId:request.id});
    await trx('erp.commission_batches').where('id',receipt.id).update({status:'APPLIED',applied_at:trx.fn.now(),result:applied});
    return applied;
  } catch(err) {console.error('Error in CommissionBatchService:',err);throw err;}
};

module.exports={MODE,normalizeBatch,previewBatch,saveBatch,applyBatchApproval};
