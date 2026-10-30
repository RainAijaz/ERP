const express = require('express');
const knex = require('../../db/knex');
const { requirePermission } = require('../../middleware/access/role-permissions');
const { handleScreenApproval } = require('../../middleware/approvals/screen-approval');
const { queueAuditLog } = require('../../utils/audit-log');
const { publicErrorMessage } = require('../../middleware/errors/friendly-error');
const { todayYmd } = require('../../services/hr-payroll/commission-rules-service');
const { previewPayroll,finalizePayroll,payrollPageData,loadPayrollSnapshot } = require('../../services/hr-payroll/payroll-run-service');
const router = express.Router();
const scopeKey = 'hr_payroll.employees';
require('../../utils/approval-previews/payroll-configuration-preview-provider');
router.get('/',requirePermission('SCREEN',scopeKey,'view'),async (req,res,next) => {
  try {
    const data = await payrollPageData({ req });
    res.render('base/layouts/main',{ title:res.locals.t('salary_payroll_runs'),view:'../../hr_payroll/payroll-runs', user:req.user, branchId:req.branchId, branchScope:req.branchScope, isAdmin:req.user?.isAdmin || false, csrfToken:res.locals.csrfToken,...data });
  } catch(err) { console.error('Error in PayrollRunService:',err); next(err); }
});
router.post('/preview',requirePermission('SCREEN',scopeKey,'view'),async (req,res) => {
  try {
    const preview = await previewPayroll({ req,input:req.body });
    res.json({ snapshot:preview.snapshot,hash:preview.hash });
  } catch(err) {
    console.error('Error in PayrollRunService:',err);
    res.status(400).json({ message:publicErrorMessage(err,res.locals.t) });
  }
});
router.get('/:id/snapshot',requirePermission('SCREEN',scopeKey,'view'),async(req,res)=>{
  try { res.json({snapshot:await loadPayrollSnapshot({req,id:req.params.id})}); }
  catch(err) { console.error('Error in PayrollRunService:',err); res.status(400).json({message:publicErrorMessage(err,res.locals.t)}); }
});
router.post('/finalize',requirePermission('SCREEN',scopeKey,'view'),async (req,res) => {
  try {
    const preview = await previewPayroll({ req,input:req.body });
    if(preview.normalized.to>todayYmd())throw new Error('salary_period_not_ended');
    if (preview.hash !== req.body.preview_hash) throw new Error('salary_preview_changed');
    const approval = await handleScreenApproval({ req,scopeKey,action:'edit',entityType:'EMPLOYEE',entityId:preview.normalized.employeeId,
      summary:`${res.locals.t('salary_finalize')} ${preview.employee.name} (${preview.normalized.from} / ${preview.normalized.to})`,
      oldValue:null,newValue:{ mode:'PAYROLL_FINALIZE', input:req.body, preview_hash:preview.hash,snapshot:preview.snapshot },t:res.locals.t });
    if (approval.queued) return res.status(202).json({ queued:true,message:res.locals.t('approval_sent') });
    const run = await knex.transaction(trx => finalizePayroll({ trx,req,input:req.body,expectedHash:preview.hash }));
    queueAuditLog(req,{ entityType:'EMPLOYEE',entityId:preview.normalized.employeeId,action:'CREATE',context:{ source:'payroll-finalize',payroll_run_id:run.id } });
    res.json({ id:run.id,message:res.locals.t('salary_finalized') });
  } catch(err) {
    console.error('Error in PayrollRunService:',err);
    res.status(400).json({ message:publicErrorMessage(err,res.locals.t) });
  }
});
module.exports = router;
