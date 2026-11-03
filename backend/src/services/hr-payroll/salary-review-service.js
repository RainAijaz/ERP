'use strict';

const knex = require('../../db/knex');
const { workerConfig } = require('./guaranteed-pay-service');
const { normalizeRuleDate, todayYmd } = require('./commission-rules-service');
const { toLocalDateOnly } = require('../../utils/date-only');
const { toIdListWithAll, normalizeReportBranchIds, getReportAllowedBranchIds } = require('../../utils/report-branch-scope');
const { canAccessScope } = require('../../middleware/access/role-permissions');
const { handleScreenApproval } = require('../../middleware/approvals/screen-approval');
const { getUserEntityBlockedSet } = require('../administration/entity-ledger-access-service');
const { insertActivityLog } = require('../../utils/audit-log');
const { HttpError } = require('../../middleware/errors/http-error');

const STATUSES = ['needs', 'checked', 'never', 'recheck'];
const branchScopeKey = branchIds => branchIds.length ? [...branchIds].sort((a, b) => a - b).join(',') : 'ALL';
const parseSalaryReviewFilters = (input = {}) => {
  const tokens = (Array.isArray(input.salary_review_status) ? input.salary_review_status : [input.salary_review_status])
    .flatMap(value => String(value || '').split(',')).map(value => value.trim().toLowerCase());
  return {
    salaryReviewStatuses: tokens.some(value => ['all', '__all__'].includes(value)) ? [] : [...new Set(tokens.filter(value => STATUSES.includes(value)))],
    salaryReviewUserIds: toIdListWithAll(input.salary_review_user_ids),
  };
};

const latestReviews = async ({ db = knex, cfg, entityIds, branchIds }) => {
  if (!entityIds.length) return [];
  return db('erp.worker_salary_reviews as r').leftJoin('erp.users as u', 'u.id', 'r.checked_by')
    .whereIn(`r.${cfg.idColumn}`, entityIds).where('r.branch_scope', branchScopeKey(branchIds))
    .distinctOn(`r.${cfg.idColumn}`).select('r.*', 'u.username as reviewer_name')
    .orderBy(`r.${cfg.idColumn}`).orderBy('r.id', 'desc');
};

const fingerprints = args => require('./hr-payroll-report-service').loadSalaryReviewFingerprints(args);

const attachSalaryReviews = async ({ req, kind, filters, options, reportData, balances = false, db = knex }) => {
  try {
    const cfg = workerConfig(kind);
    const branchIds = req.user?.isAdmin || filters.canFilterAllBranches ? filters.branchIds : getReportAllowedBranchIds(req);
    const end = balances ? filters.asOn : filters.to;
    reportData.salaryReviewContext = { kind, source: balances ? 'balances' : 'ledger', reportEnd: end, branchIds, canManage: Boolean(req.user?.isAdmin), today: todayYmd() };
    const reloadParams = new URLSearchParams({ load_report: '1', branch_ids: branchIds.join(',') });
    if (balances) {
      reloadParams.set('as_on', end); reloadParams.set('view_mode', filters.viewMode || 'summary');
      reloadParams.set('salary_review_status', (filters.salaryReviewStatuses || []).join(','));
      reloadParams.set('salary_review_user_ids', (filters.salaryReviewUserIds || []).join(','));
    } else {
      reloadParams.set('entity_id', String(filters.entityId || '')); reloadParams.set('from_date', filters.from);
      reloadParams.set('to_date', end); reloadParams.set('ledger_view', filters.ledgerView);
    }
    reportData.salaryReviewContext.reloadUrl = `/reports/hr-payroll/${kind}-${balances ? 'balances' : 'ledger'}?${reloadParams}`;
    options.salaryReviewers = [];
    if (!filters.reportLoaded) return;
    const entities = balances ? reportData.rows : reportData.entity ? [{ entity_id: reportData.entity.id }] : [];
    const ids = entities.map(row => Number(row.entity_id));
    if (!ids.length) return;
    const latest = await latestReviews({ db, cfg, entityIds: ids, branchIds });
    const previous = new Map(latest.map(row => [Number(row[cfg.idColumn]), row]));
    const snapshots = await fingerprints({ db, kind, branchIds, reviews: [
      ...ids.map(id => ({ entity_id: id, checked_through: end, key: `report:${id}` })),
      ...latest.map(row => ({ entity_id: row[cfg.idColumn], checked_through: toLocalDateOnly(row.checked_through), key: `checked:${row[cfg.idColumn]}` })),
    ] });
    const reviewers = new Map();
    for (const row of entities) {
      const id = Number(row.entity_id), review = previous.get(id);
      const date = review ? toLocalDateOnly(review.checked_through) : '';
      const changed = Boolean(review && snapshots.get(`checked:${id}`) !== review.source_fingerprint);
      row.salaryReview = {
        id: Number(review?.id || 0), entityId: id, checkedThrough: date,
        checkedBy: review?.reviewer_name || '', checkedById: Number(review?.checked_by || 0),
        checkedOn: review?.checked_at || null, fingerprint: snapshots.get(`report:${id}`),
        status: changed ? 'recheck' : !review ? 'never' : date >= end ? 'checked' : 'needs',
      };
      if (review) reviewers.set(Number(review.checked_by), { id: Number(review.checked_by), name: review.reviewer_name || String(review.checked_by) });
    }
    options.salaryReviewers = [...reviewers.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!balances) { reportData.salaryReview = entities[0]?.salaryReview || null; return; }
    const selected = filters.salaryReviewStatuses || [], users = filters.salaryReviewUserIds || [];
    reportData.rows = entities.filter(row => {
      const review = row.salaryReview;
      const match = !selected.length || selected.includes(review.status) || (selected.includes('needs') && review.status !== 'checked');
      return match && (!users.length || users.includes(review.checkedById));
    });
  } catch (err) { console.error('Error in SalaryReviewReportService:', err); throw err; }
};

const normalizeReviewInput = (req, input) => {
  if (!input || !['employee', 'labour'].includes(input.kind)) throw new HttpError(400, 'salary_review_invalid');
  const cfg = workerConfig(input.kind);
  if (!['ledger', 'balances'].includes(input.source)) throw new HttpError(400, 'salary_review_invalid');
  const entityId = Number(input.entity_id), expectedId = Number(input.expected_review_id);
  const through = String(input.checked_through || ''), end = String(input.report_end || '');
  if (!Number.isSafeInteger(entityId) || entityId <= 0 || !Number.isSafeInteger(expectedId) || expectedId < 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(through) || normalizeRuleDate(through) !== through ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end) || normalizeRuleDate(end) !== end ||
      through < '1900-01-01' || through > end || through > todayYmd() || !/^[a-f0-9]{64}$/.test(String(input.report_fingerprint || ''))) throw new HttpError(400, 'salary_review_invalid');
  const scopeKey = `${input.kind}_${input.source}`;
  if (!canAccessScope(req, 'REPORT', scopeKey, 'load')) throw new HttpError(403, 'permission_denied');
  const branchIds = normalizeReportBranchIds({ req, input, scopeKey });
  return { cfg, entityId, expectedId, through, end, branchIds, scopeKey, reportFingerprint: input.report_fingerprint };
};

const assertReviewEntity = async (db, req, normalized) => {
  const { cfg, entityId, branchIds } = normalized;
  const entity = await db(cfg.table).where({ id: entityId }).whereRaw("lower(trim(coalesce(status, ''))) = 'active'").first();
  if (!entity) throw new HttpError(400, 'salary_review_invalid');
  if (!req.user?.isAdmin) {
    if (!getReportAllowedBranchIds(req).length) throw new HttpError(403, 'error_branch_out_of_scope');
    const blocked = await getUserEntityBlockedSet({ db, userId: Number(req.user?.id), entityType: cfg.type });
    if (blocked.has(entityId)) throw new HttpError(403, 'error_branch_out_of_scope');
  }
  if (branchIds.length && !await db(cfg.branchTable).where(cfg.idColumn, entityId).whereIn('branch_id', branchIds).first()) throw new HttpError(403, 'error_branch_out_of_scope');
  return entity;
};

const verifyReview = async ({ db = knex, req, normalized }) => {
  const entity = await assertReviewEntity(db, req, normalized);
  const { cfg, entityId, branchIds, expectedId, end, through, reportFingerprint } = normalized;
  const [latest] = await latestReviews({ db, cfg, entityIds: [entityId], branchIds });
  if (Number(latest?.id || 0) !== expectedId) throw new HttpError(409, 'salary_review_changed');
  const hashes = await fingerprints({ db, kind: cfg.kind, branchIds, reviews: [
    { entity_id: entityId, checked_through: end, key: 'report' },
    { entity_id: entityId, checked_through: through, key: 'checked' },
  ] });
  if (hashes.get('report') !== reportFingerprint) throw new HttpError(409, 'salary_review_changed');
  return { entity, latest, checkedFingerprint: hashes.get('checked') };
};

// The same guarded writer is used by direct admin saves and approval replay.
const applySalaryReviewTx = async ({ trx, req, input, requestedBy, approvalRequestId = null }) => {
  try {
    if (!req.user?.isAdmin) throw new HttpError(403, 'permission_denied');
    const normalized = normalizeReviewInput(req, input);
    const { cfg, entityId, branchIds, through, end } = normalized;
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`salary-review:${cfg.kind}:${entityId}:${branchScopeKey(branchIds)}`]);
    const verified = await verifyReview({ db: trx, req, normalized });
    const [saved] = await trx('erp.worker_salary_reviews').insert({
      [cfg.idColumn]: entityId, branch_scope: branchScopeKey(branchIds), branch_ids: JSON.stringify(branchIds),
      checked_through: through, report_end: end, source_fingerprint: verified.checkedFingerprint,
      checked_by: req.user.id, requested_by: requestedBy || req.user.id, approval_request_id: approvalRequestId,
    }).returning('id');
    await insertActivityLog(trx, {
      branch_id: req.branchId || null, user_id: req.user.id, entity_type: cfg.type, entity_id: entityId,
      action: 'UPDATE', ip_address: req.ip,
      context: { source: 'salary-review', salary_review_id: saved.id, checked_through: through, branch_ids: branchIds,
        approval_request_id: approvalRequestId, previous_review_id: verified.latest?.id || null,
        summary: `${req.user.id} performed SALARY_REVIEW on ${entityId} at ${new Date().toISOString()}.` },
    });
    return { applied: true, entityId: String(entityId), id: saved.id };
  } catch (err) { console.error('Error in SalaryReviewService:', err); throw err; }
};

const submitSalaryReview = async ({ req, input, t }) => {
  try {
    const normalized = normalizeReviewInput(req, input);
    const verified = await verifyReview({ req, normalized });
    const cleanInput = { kind: normalized.cfg.kind, source: input.source, entity_id: normalized.entityId,
      checked_through: normalized.through, report_end: normalized.end, branch_ids: normalized.branchIds,
      expected_review_id: normalized.expectedId, report_fingerprint: normalized.reportFingerprint };
    const approval = await handleScreenApproval({ req, scopeKey: normalized.cfg.scopeKey, action: 'edit',
      entityType: normalized.cfg.type, entityId: normalized.entityId,
      forceQueue: !req.user?.isAdmin, summary: `${t('salary_review_title')}: ${verified.entity.name} (${normalized.through})`,
      oldValue: verified.latest ? { checked_through: toLocalDateOnly(verified.latest.checked_through), checked_by: verified.latest.reviewer_name } : null,
      newValue: { mode: 'SALARY_REVIEW', input: cleanInput }, t });
    if (approval.queued) return { queued: true, requestId: approval.requestId, message: t('change_submitted_admin_approval') };
    const result = await knex.transaction(trx => applySalaryReviewTx({ trx, req, input: cleanInput }));
    return { ...result, queued: false, message: t('salary_review_saved') };
  } catch (err) { console.error('Error in SalaryReviewService:', err); throw err; }
};

const applySalaryReviewApproval = async (trx, request, userId) => {
  const input = request.new_value?.input;
  if (!input || input.kind?.toUpperCase() !== request.entity_type || String(input.entity_id) !== String(request.entity_id)) throw new HttpError(400, 'salary_review_invalid');
  return applySalaryReviewTx({ trx, input, requestedBy: request.requested_by, approvalRequestId: request.id,
    req: { user: { id: userId, isAdmin: true }, branchId: request.branch_id, branchScope: [] } });
};

module.exports = { parseSalaryReviewFilters, attachSalaryReviews, submitSalaryReview, applySalaryReviewTx, applySalaryReviewApproval };
