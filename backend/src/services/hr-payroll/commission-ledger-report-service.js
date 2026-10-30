const knex = require("../../db/knex");
const { normalizeRuleDate } = require('./commission-rules-service');
const {
  getReportAllowedBranchIds,
  reportCanFilterAllBranches,
} = require("../../utils/report-branch-scope");

const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return getReportAllowedBranchIds(req);
};

const getCommissionLedgerReportPageData = async ({ req, input = {} }) => {
  const locale = req?.res?.locals?.locale || req?.locale || "en";

  const fromDate = normalizeRuleDate(input.from_date);
  const toDate = normalizeRuleDate(input.to_date);
  if (fromDate === undefined || toDate === undefined || (fromDate && toDate && fromDate>toDate)) throw new Error(req.res.locals.t('error_invalid_date_range'));
  const employeeId = input.employee_id ? Number(input.employee_id) : null;
  const commissionType = input.commission_type || null;
  const reportLoaded = Boolean(input.load_report);

  const canFilterAllBranches = reportCanFilterAllBranches(
    req,
    "commission_ledger",
  );
  const allowedBranchIds = canFilterAllBranches ? [] : getAllowedBranchIds(req);

  // Employee options for filter dropdown
  const nameExpr = locale === "ur" ? "COALESCE(NULLIF(e.name_ur, ''), e.name)" : "e.name";
  let empQuery = knex("erp.employees as e")
    .select("e.id as value", knex.raw(`${nameExpr} as label`))
    .whereRaw("lower(trim(e.status)) = 'active'")
    .orderByRaw(`${nameExpr} asc`);
  if (allowedBranchIds.length) {
    empQuery = empQuery.whereExists(function branchScope() {
      this.select(1)
        .from("erp.employee_branch as eb")
        .whereRaw("eb.employee_id = e.id")
        .whereIn("eb.branch_id", allowedBranchIds);
    });
  }
  const employeeOptions = await empQuery;

  let rows = [];
  let grandTotal = 0;

  if (reportLoaded) {
    const labelExpr = locale === "ur" ? "COALESCE(NULLIF(e.name_ur, ''), e.name)" : "e.name";
    let query = knex("erp.commission_ledger as cl")
      .join("erp.voucher_header as vh", "cl.voucher_id", "vh.id")
      .join("erp.employees as e", "cl.employee_id", "e.id")
      .join('erp.branches as b','b.id','vh.branch_id')
      .select(
        "cl.id",
        "cl.voucher_id",
        "cl.employee_id",
        knex.raw(`${labelExpr} as employee_name`),
        "cl.commission_type",
        "cl.total_amount",
        "cl.lines_detail",
        "vh.voucher_no",
        "vh.voucher_type_code",
        "vh.voucher_date",
        "vh.branch_id",
        'b.name as branch_name',
      )
      .where('vh.status','APPROVED')
      .orderBy("vh.voucher_date", "desc")
      .orderBy("cl.id", "desc").limit(2001);
    if (fromDate) query.where('vh.voucher_date','>=',fromDate);
    if (toDate) query.where('vh.voucher_date','<=',toDate);

    if (employeeId) query = query.where("cl.employee_id", employeeId);
    if (commissionType) query = query.where("cl.commission_type", commissionType);
    if (allowedBranchIds.length) query = query.whereIn("vh.branch_id", allowedBranchIds);

    rows = await query;
    if (rows.length>2000) throw new Error(req.res.locals.t('commission_report_too_large'));
    const ids={sku:new Set(),worker:new Set(),department:new Set(),stage:new Set(),grade:new Set(),rule:new Set()};
    rows.forEach(row=>(row.lines_detail || []).forEach(line=>{
      if(line.sku_id)ids.sku.add(Number(line.sku_id));if(line.labour_id)ids.worker.add(Number(line.labour_id));
      if(line.dept_id)ids.department.add(Number(line.dept_id));if(line.stage_id)ids.stage.add(Number(line.stage_id));
      if(line.context?.grade_id)ids.grade.add(Number(line.context.grade_id));
      (line.entries || []).forEach(entry=>{if(entry.rule_id)ids.rule.add(Number(entry.rule_id));});
    }));
    const maps={};
    for (const [kind,table,column] of [['sku','erp.skus','sku_code'],['worker','erp.labours','name'],['department','erp.departments','name'],['stage','erp.production_stages','name'],['grade','erp.grades','name'],['rule','erp.employee_commission_rules','rate_type']]) {
      if(ids[kind].size>20000) throw new Error(req.res.locals.t('commission_report_too_large'));
      const names=ids[kind].size ? await knex(table).whereIn('id',[...ids[kind]]).select('id',column):[];
      maps[kind]=new Map(names.map(row=>[Number(row.id),row[column]]));
    }
    rows.forEach(row=>row.lines_detail=(row.lines_detail || []).map(line=>({...line,
      sku_code:maps.sku.get(Number(line.sku_id)),worker_name:maps.worker.get(Number(line.labour_id)),
      department_name:maps.department.get(Number(line.dept_id)),stage_name:maps.stage.get(Number(line.stage_id)),grade_name:maps.grade.get(Number(line.context?.grade_id)),
      entries:(line.entries || []).map(entry=>({...entry,rate_type:entry.rate_type || maps.rule.get(Number(entry.rule_id))}))})));
    grandTotal = rows.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
  }

  return {
    filters: {
      reportLoaded,
      fromDate,
      toDate,
      employeeId,
      commissionType,
      canFilterAllBranches,
    },
    options: {
      employees: employeeOptions,
    },
    reportData: {
      rows,
      grandTotal,
    },
  };
};

module.exports = { getCommissionLedgerReportPageData };
