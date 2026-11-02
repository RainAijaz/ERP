const express = require('express');
const knex = require('../../db/knex');
const { requirePermission, canAccessScope } = require('../../middleware/access/role-permissions');
const { workerConfig } = require('../../services/hr-payroll/guaranteed-pay-service');
const { handleScreenApproval } = require('../../middleware/approvals/screen-approval');
const { queueAuditLog } = require('../../utils/audit-log');
const { publicErrorMessage } = require('../../middleware/errors/friendly-error');
const { previewPayroll,finalizePayroll,payrollPageData,loadPayrollSnapshot,assertPayrollPeriodEnded } = require('../../services/hr-payroll/payroll-run-service');
const router = express.Router();
const scopeKey = 'hr_payroll.employees';
const payrollAccess = (req,res,next) => {
  if (['hr_payroll.employees','hr_payroll.labours'].some(key => canAccessScope(req,'SCREEN',key,'view'))) return next();
  return requirePermission('SCREEN',scopeKey,'view')(req,res,next);
};
require('../../utils/approval-previews/payroll-configuration-preview-provider');
router.get('/',payrollAccess,async (req,res,next) => {
  try {
    const data = await payrollPageData({ req });
    res.render('base/layouts/main',{ title:res.locals.t('salary_payroll_runs'),view:'../../hr_payroll/payroll-runs', user:req.user, branchId:req.branchId, branchScope:req.branchScope, isAdmin:req.user?.isAdmin || false, csrfToken:res.locals.csrfToken,...data });
  } catch(err) { console.error('Error in PayrollRunService:',err); next(err); }
});
router.post('/preview',payrollAccess,async (req,res) => {
  try {
    const preview = await previewPayroll({ req,input:req.body });
    res.json({ snapshot:preview.snapshot,hash:preview.hash });
  } catch(err) {
    console.error('Error in PayrollRunService:',err);
    res.status(400).json({ message:publicErrorMessage(err,res.locals.t) });
  }
});
router.get(['/:kind/:id/snapshot','/:id/snapshot'],payrollAccess,async(req,res)=>{
  try { res.json({snapshot:await loadPayrollSnapshot({req,id:req.params.id,kind:req.params.kind || 'employee'})}); }
  catch(err) { console.error('Error in PayrollRunService:',err); res.status(400).json({message:publicErrorMessage(err,res.locals.t)}); }
});
router.post('/finalize',payrollAccess,async (req,res) => {
  try {
    const preview = await previewPayroll({ req,input:req.body });
    const cfg = workerConfig(preview.normalized.kind);
    assertPayrollPeriodEnded(preview.normalized);
    if (preview.hash !== req.body.preview_hash) throw new Error('salary_preview_changed');
    const approval = await handleScreenApproval({ req,scopeKey:cfg.scopeKey,action:'edit',entityType:cfg.type,entityId:preview.normalized.employeeId,
      summary:`${res.locals.t('salary_finalize')} ${preview.employee.name} (${preview.normalized.from} / ${preview.normalized.to})`,
      oldValue:null,newValue:{ mode:'PAYROLL_FINALIZE', input:req.body, preview_hash:preview.hash,snapshot:preview.snapshot },t:res.locals.t });
    if (approval.queued) return res.status(202).json({ queued:true,message:res.locals.t('approval_sent') });
    const run = await knex.transaction(trx => finalizePayroll({ trx,req,input:req.body,expectedHash:preview.hash }));
    queueAuditLog(req,{ entityType:cfg.type,entityId:preview.normalized.employeeId,action:'CREATE',context:{ source:'payroll-finalize',payroll_run_id:run.id } });
    res.json({ id:run.id,message:res.locals.t('salary_finalized') });
  } catch(err) {
    console.error('Error in PayrollRunService:',err);
    res.status(400).json({ message:publicErrorMessage(err,res.locals.t) });
  }
});
module.exports = router;
