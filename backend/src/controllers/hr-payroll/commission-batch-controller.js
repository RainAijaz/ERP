'use strict';
const { previewBatch, saveBatch } = require('../../services/hr-payroll/commission-batch-service');
const { publicErrorMessage } = require('../../middleware/errors/friendly-error');

const respond = operation => async (req,res) => {
  try {
    const result=await operation({req,input:req.body});
    return res.status(result.queued?202:200).json(result);
  } catch(err) {
    const status=err.status || (['40001','40P01'].includes(err.code)?409:500);
    return res.status(status).json({message:publicErrorMessage(err,res.locals.t),...(err.details?.card_id?{card_id:err.details.card_id}:{})});
  }
};
module.exports={preview:respond(previewBatch),save:respond(saveBatch)};
