'use strict';
const { registerApprovalPreviewProvider } = require('../approval-preview-registry');
registerApprovalPreviewProvider(async ({req,res,request,side})=>{
  const values=side==='old'?request?.old_value:request?.new_value;
  if(values?.mode!=='COMMISSION_BATCH_V1')return null;
  return {previewAction:'edit',previewReadOnly:true,previewLabel:res.locals.t('commission_batch_title'),previewType:'commission-batch',
    previewTitle:res.locals.t('commission_batch_title'),locale:req.locale,previewValues:values,
    formPartial:'../../administration/approvals/commission-batch-preview.ejs'};
});
module.exports={};
