// Approval mode for retroactive commission recalculation.
//
// The queued payload carries slim rows (voucher, employee, type, old, new) so the
// approver commits exactly the numbers they reviewed. It deliberately does NOT
// carry the write descriptors — those are re-derived here at apply time, both to
// keep the payload small and so a tampered payload cannot dictate what is written.
//
// A row whose freshly-derived amount no longer matches what was approved is
// SKIPPED, not silently written: something changed between review and approval,
// and the approver's number is the one that was authorised.
const {
  normalizeRecalcInput,
  buildRecalcPlan,
  applyRecalcPlan,
} = require("../services/hr-payroll/commission-recalc-service");

const RECALC_APPROVAL_MODE = "COMMISSION_RECALC";
const MATCH_EPSILON = 0.005;

const rowKey = (voucherId, employeeId, commissionType) =>
  `${Number(voucherId)}:${Number(employeeId)}:${commissionType}`;

const applyCommissionRecalcApproval = async (trx, request, decidedBy = null) => {
  const values =
    request?.new_value && typeof request.new_value === "object" ? request.new_value : {};

  const input = normalizeRecalcInput({
    commission_types: values.commission_types,
    from_date: values.from_date,
    to_date: values.to_date,
    employee_id: values.employee_id,
    clear_orphans: values.clear_orphans,
  });
  if (!input.fromDate || !input.toDate) return false;

  const approvedRows = Array.isArray(values.rows) ? values.rows : [];
  if (!approvedRows.length) return false;
  const approvedByKey = new Map(
    approvedRows.map((row) => [rowKey(row.v, row.e, row.t), Number(row.w)]),
  );

  const plan = await buildRecalcPlan({ db: trx, input });

  const rowsToWrite = [];
  let skipped = 0;
  for (const row of plan.rows) {
    const key = rowKey(row.voucher_id, row.employee_id, row.commission_type);
    if (!approvedByKey.has(key)) continue;
    if (Math.abs(Number(row.new_rate) - approvedByKey.get(key)) > MATCH_EPSILON) {
      skipped += 1;
      continue;
    }
    rowsToWrite.push({ ...row, will_write: true });
  }

  if (!rowsToWrite.length) return false;

  const result = await applyRecalcPlan({
    trx,
    rows: rowsToWrite,
    provenance: {
      at: new Date().toISOString(),
      by: decidedBy,
      source: "commission-recalc-approval",
      approval_request_id: request?.id || null,
      from_date: input.fromDate,
      to_date: input.toDate,
    },
  });

  if (skipped) {
    console.warn(
      `[commission-recalc] approval ${request?.id}: ${skipped} row(s) skipped — recomputed amount no longer matches the approved figure.`,
    );
  }

  // Partial success must not return falsy: the approve route treats that as a
  // total failure and rolls the whole decision back.
  return {
    applied: true,
    entityId: String(request?.entity_id || ""),
    written: rowsToWrite.length,
    skipped,
    ...result,
  };
};

module.exports = {
  RECALC_APPROVAL_MODE,
  applyCommissionRecalcApproval,
};
