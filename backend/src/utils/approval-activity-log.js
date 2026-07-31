"use strict";

/**
 * Activity-log writers for approval_request rows.
 *
 * `approval_request` has no "last edited by" column: once a request is queued,
 * anyone with rights can rewrite its payload (an admin on the Approvals page,
 * or an approver re-saving the still-pending voucher/BOM on its own screen)
 * and the row shows only the ORIGINAL maker afterwards. The activity log is
 * therefore the only record that a queued request was amended, and by whom.
 *
 * Two shapes, both landing on action='UPDATE' with a `pending-approval-edit`
 * family source so the Activity Log can label them "Pending Approval Updated"
 * instead of a plain "Updated"/"Submitted For Approval":
 *
 *   logPendingApprovalEditTx      - the request payload was edited directly
 *   logVoucherApprovalWriteTx     - a voucher write either RAISED a request
 *                                   (SUBMIT) or refreshed one that was already
 *                                   pending (UPDATE)
 */

const { insertActivityLog } = require("./audit-log");

const PENDING_APPROVAL_EDIT_SOURCE = "pending-approval-edit";

const safeJson = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_err) {
    return null;
  }
};

/**
 * Best-effort voucher type for an approval_request row: the column when the
 * DB has it, otherwise whatever the queued payload recorded. Used so the
 * Activity Log can label and link the row to the right voucher screen.
 */
const resolveRequestVoucherTypeCode = (request) => {
  const direct = String(request?.voucher_type_code || "")
    .trim()
    .toUpperCase();
  if (direct) return direct;
  const payload = safeJson(request?.new_value) || {};
  const fromPayload = String(
    payload?.voucher_type_code || payload?.voucherTypeCode || "",
  )
    .trim()
    .toUpperCase();
  return fromPayload || null;
};

/**
 * Record that a still-PENDING approval request was amended.
 *
 * @param {object}   params.db        knex or a transaction (use the same trx
 *                                    that wrote the request, so the log can
 *                                    never survive a rolled-back edit)
 * @param {object}   params.req       express request (user, ip, branch)
 * @param {object}   params.request   the approval_request row BEFORE the edit
 * @param {Array}    params.changedFields  [{ field, old_value, new_value }]
 * @param {string}   params.source    who performed the edit, for the details pane
 * @param {object}   params.extraContext  merged into context_json
 */
const logPendingApprovalEditTx = async ({
  db,
  req,
  request,
  changedFields = [],
  source = "approval-request-edit",
  newValue = null,
  extraContext = {},
}) => {
  if (!db || !request) return;

  await insertActivityLog(db, {
    branch_id: request.branch_id ?? req?.branchId ?? null,
    user_id: req?.user?.id ?? null,
    entity_type: request.entity_type,
    entity_id: request.entity_id,
    voucher_type_code: resolveRequestVoucherTypeCode(request),
    action: "UPDATE",
    ip_address: req?.ip || null,
    context: {
      source,
      approval_request_id: request.id,
      request_type: request.request_type || null,
      request_status: request.status || "PENDING",
      summary: request.summary || null,
      // The maker stays the maker on an edit, so spell out that the editor is
      // someone else -- that difference is the whole point of the record.
      original_requested_by: request.requested_by ?? null,
      edited_by: req?.user?.id ?? null,
      changed_fields: changedFields,
      old_value: request.new_value || null,
      new_value: newValue ?? null,
      ...extraContext,
    },
  });
};

/**
 * Record a voucher write that went through the approval queue.
 *
 * `existingPending` is the row returned by findPendingVoucherApprovalTx BEFORE
 * the write. When it is set, the voucher already had a queued request and this
 * save rewrote it in place -- a different event from raising a new one, and the
 * only trace of it.
 */
const logVoucherApprovalWriteTx = async ({
  trx,
  req,
  voucherId,
  voucherTypeCode,
  summary,
  newValue = null,
  approvalRequestId = null,
  existingPending = null,
  source,
  extraContext = {},
}) => {
  if (!trx) return;
  const refreshed = Boolean(existingPending);

  await insertActivityLog(trx, {
    branch_id: req?.branchId ?? null,
    user_id: req?.user?.id ?? null,
    entity_type: "VOUCHER",
    entity_id: String(voucherId),
    voucher_type_code: voucherTypeCode || null,
    action: refreshed ? "UPDATE" : "SUBMIT",
    ip_address: req?.ip || null,
    context: {
      source: refreshed ? PENDING_APPROVAL_EDIT_SOURCE : source,
      // Kept on both branches so the details pane always names the service.
      service: source,
      approval_request_id: approvalRequestId || null,
      summary,
      new_value: newValue,
      refreshed_existing_request: refreshed,
      original_requested_by: existingPending?.requested_by ?? req?.user?.id ?? null,
      edited_by: req?.user?.id ?? null,
      ...extraContext,
    },
  });
};

module.exports = {
  PENDING_APPROVAL_EDIT_SOURCE,
  resolveRequestVoucherTypeCode,
  logPendingApprovalEditTx,
  logVoucherApprovalWriteTx,
};
