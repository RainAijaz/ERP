'use strict';
const { getStockCountDetailsReportPageData } = require('../../services/inventory/stock-count-report-service');

exports.load = async (req, res, next) => {
  try {
    const data = await getStockCountDetailsReportPageData({ req, input: req.method === 'POST' ? req.body : req.query });
    return res.render('base/layouts/main', {
      ...data, title: res.locals.t('stock_count_details_report'), user: req.user,
      branchId: req.branchId, branchScope: req.branchScope, csrfToken: res.locals.csrfToken,
      t: res.locals.t, view: '../../reports/inventory-stock-count-details', reportPath: `${req.baseUrl}/stock-count-details`,
    });
  } catch (err) {
    console.error('Error in StockCountReportController:', err);
    if (typeof req.flash === 'function') req.flash('error', res.locals.t('generic_error'));
    return next(err);
  }
};
