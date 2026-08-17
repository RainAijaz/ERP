"use strict";

/**
 * Shared reconciliation helpers for voucher `approval_request` rows.
 *
 * Every voucher approval links to its voucher via
 *   entity_type = 'VOUCHER'  AND  entity_id = String(voucherId)
 * (see the per-service `createApprovalRequest` helpers). These helpers keep the
 * approval_request table in sync with what actually happens on the voucher
 * screen, so that:
 *   - a voucher never accumulates more than one PENDING approval, and
 *   - when a voucher is confirmed/posted (or deleted) directly, its lingering
 *     PENDING approval is resolved instead of being orphaned on the
 *     "Pending Approvals" page.
 *
 * DB constraints these helpers respect (010_administration.sql):
 *   - maker != checker: `decided_by <> requested_by`, except for WITHDRAWN,
 *     which is by definition the maker closing their own request.
 *   - once decided, both `decided_by` and `decided_at` must be non-null.
 */

const {
  SYSTEM_DECISION_NOTES,
  systemNoteForVoucherResolution,
} = require("./approval-decision-notes");

const PENDING = "PENDING";

/**
 * Return the (single) PENDING approval_request row for a voucher, or null.
 * Ordered by id so re-edits always target the same, earliest pending row.
 */
async function findPendingVoucherApprovalTx(trx, voucherId) {
  const id = Number(voucherId || 0);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await trx("erp.approval_request")
    .select("id", "request_type", "requested_by", "old_value", "new_value")
    .where({
      entity_type: "VOUCHER",
      entity_id: String(id),
      status: PENDING,
    })
    .orderBy("id", "asc")
    .first();
  return row || null;
}

/**
 * Resolve any PENDING approval_request(s) for a voucher when it is confirmed
 * (status='APPROVED') or deleted (status='REJECTED') directly on the voucher
 * screen. The row is UPDATED (not deleted) so it moves to the Approved/Rejected
 * tab of the approvals page with the confirmer recorded as the decider.
 *
 * The maker != checker DB rule means a user can never *decide* their own
 * request, so a user resolving their own voucher gets those rows closed as
 * WITHDRAWN instead (the one status the maker may set on their own request --
 * see 102_approval_withdraw.sql). Before WITHDRAWN existed these rows had to be
 * skipped, which left them stranded on the Pending Approvals page forever.
 *
 * @returns {Promise<number>} number of rows resolved
 */
async function resolvePendingVoucherApprovalsTx({
  trx,
  voucherId,
  decidedBy,
  status,
}) {
  const id = Number(voucherId || 0);
  const decider = Number(decidedBy || 0);
  const nextStatus = String(status || "").toUpperCase();
  if (!Number.isInteger(id) || id <= 0) return 0;
  if (!Number.isInteger(decider) || decider <= 0) return 0;
  if (nextStatus !== "APPROVED" && nextStatus !== "REJECTED") return 0;

  const pendingForVoucher = () =>
    trx("erp.approval_request").where({
      entity_type: "VOUCHER",
      entity_id: String(id),
      status: PENDING,
    });

  // Nobody typed a reason here -- the request is being closed as a side effect
  // of what happened on the voucher screen -- so record a SYSTEM: sentinel
  // instead of NULL. The requester sees a translated sentence rather than a
  // blank "Rejection Reason", and the decision_notes CHECK constraint (which
  // requires a note on REJECTED/WITHDRAWN) is satisfied.
  const decided = await pendingForVoucher()
    .andWhereNot("requested_by", decider)
    .update({
      status: nextStatus,
      decided_by: decider,
      decided_at: trx.fn.now(),
      decision_notes: systemNoteForVoucherResolution(nextStatus),
    });

  const withdrawn = await pendingForVoucher()
    .andWhere("requested_by", decider)
    .update({
      status: "WITHDRAWN",
      decided_by: decider,
      decided_at: trx.fn.now(),
      decision_notes: SYSTEM_DECISION_NOTES.SELF_RESOLVED,
    });

  return Number(decided || 0) + Number(withdrawn || 0);
}

module.exports = {
  findPendingVoucherApprovalTx,
  resolvePendingVoucherApprovalsTx,
};
