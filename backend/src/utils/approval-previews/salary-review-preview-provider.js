const knex = require('../../db/knex');
const { registerApprovalPreviewProvider } = require('../approval-preview-registry');
const { workerConfig } = require('../../services/hr-payroll/guaranteed-pay-service');

registerApprovalPreviewProvider(async ({ res, request, side }) => {
  if (request.new_value?.mode !== 'SALARY_REVIEW') return null;
  try {
    const input = request.new_value.input;
    const cfg = workerConfig(input.kind);
    const entity = await knex(cfg.table).where('id', request.entity_id).first('name');
    const branches = input.branch_ids?.length ? await knex('erp.branches').whereIn('id', input.branch_ids).orderBy('name').pluck('name') : [];
    const summary = [
      { label: res.locals.t(input.kind === 'employee' ? 'employees' : 'labours'), value: entity?.name || request.entity_id },
      { label: res.locals.t('salary_review_through'), value: side === 'old' ? request.old_value?.checked_through || '-' : input.checked_through },
      { label: res.locals.t('branches'), value: branches.length ? branches.join(', ') : res.locals.t('all') },
    ];
    return { previewAction: 'edit', previewReadOnly: true, previewType: 'payroll-configuration',
      previewLabel: res.locals.t('salary_review_title'), previewTitle: res.locals.t('salary_review_title'),
      previewValues: { summary, exceptionRows: [] }, formPartial: '../../administration/approvals/payroll-configuration-preview.ejs' };
  } catch (err) { console.error('Error in SalaryReviewApprovalPreviewService:', err); throw err; }
});
