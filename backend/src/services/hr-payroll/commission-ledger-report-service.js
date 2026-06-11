const knex = require("../../db/knex");

const toDateSafe = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return Array.isArray(req?.branchScope)
    ? req.branchScope.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
};

const getCommissionLedgerReportPageData = async ({ req, input = {} }) => {
  const locale = req?.res?.locals?.locale || req?.locale || "en";

  const fromDate = toDateSafe(input.from_date) || toDateSafe(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));
  const toDate = toDateSafe(input.to_date) || toDateSafe(new Date().toISOString().slice(0, 10));
  const employeeId = input.employee_id ? Number(input.employee_id) : null;
  const commissionType = input.commission_type || null;
  const reportLoaded = Boolean(input.load_report);

  const allowedBranchIds = getAllowedBranchIds(req);

  // Employee options for filter dropdown
  const nameExpr = locale === "ur" ? "COALESCE(e.name_ur, e.name)" : "e.name";
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
    const labelExpr = locale === "ur" ? "COALESCE(e.name_ur, e.name)" : "e.name";
    let query = knex("erp.commission_ledger as cl")
      .join("erp.voucher_header as vh", "cl.voucher_id", "vh.id")
      .join("erp.employees as e", "cl.employee_id", "e.id")
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
      )
      .whereBetween("vh.voucher_date", [fromDate, toDate])
      .orderBy("vh.voucher_date", "desc")
      .orderBy("cl.id", "desc");

    if (employeeId) query = query.where("cl.employee_id", employeeId);
    if (commissionType) query = query.where("cl.commission_type", commissionType);
    if (allowedBranchIds.length) query = query.whereIn("vh.branch_id", allowedBranchIds);

    rows = await query;
    grandTotal = rows.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
  }

  return {
    filters: {
      reportLoaded,
      fromDate,
      toDate,
      employeeId,
      commissionType,
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
