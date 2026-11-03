const express = require('express');
const { requirePermission, canAccessScope } = require('../../middleware/access/role-permissions');
const controller = require('../../controllers/hr-payroll/payroll-controller');
const router = express.Router();
const payrollAccess = (req, res, next) => {
  if (['hr_payroll.employees', 'hr_payroll.labours'].some(key => canAccessScope(req, 'SCREEN', key, 'view'))) return next();
  return requirePermission('SCREEN', 'hr_payroll.employees', 'view')(req, res, next);
};
require('../../utils/approval-previews/payroll-configuration-preview-provider');
router.get('/', controller.redirect);
router.get('/workspace/:kind/:entityId', payrollAccess, controller.workspace);
router.post('/preview', payrollAccess, controller.preview);
router.post('/finalize', payrollAccess, controller.finalize);
router.get(['/:kind/:id/snapshot', '/:id/snapshot'], payrollAccess, controller.snapshot);
module.exports = router;
