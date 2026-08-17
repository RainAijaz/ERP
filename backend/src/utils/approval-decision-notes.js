"use strict";

/**
 * The note stored in `erp.approval_request.decision_notes` when a request is
 * closed.
 *
 * Two kinds of note land in that column:
 *
 *   1. Free text a human typed. A checker MUST give a reason when rejecting,
 *      and a maker MUST give one when withdrawing (see routes/administration/
 *      approvals.js). Stored verbatim, rendered as-is.
 *
 *   2. A machine note, written when a request is closed with nobody at the
 *      keyboard -- e.g. deleting a voucher on the voucher screen auto-closes
 *      its lingering PENDING approval (utils/voucher-approval-sync.js).
 *
 * Machine notes are stored as a stable `SYSTEM:<token>` sentinel rather than an
 * English sentence, because the requester who reads them may be on the Urdu UI.
 * The token is resolved to a translated string at render time by
 * resolveDecisionNoteText(). Storing the sentinel (not the prose) also means
 * re-wording the message never requires a data migration.
 *
 * The column is a plain unbounded `text`, but the value flows into a table
 * cell, a line-clamped notification body and a toast, so every writer normalizes
 * through MAX_DECISION_NOTE_LENGTH.
 */

const SYSTEM_NOTE_PREFIX = "SYSTEM:";

/** Machine-written decision notes. Values are persisted -- do not rename. */
const SYSTEM_DECISION_NOTES = {
  /** The voucher was deleted on its own screen; the request closed as REJECTED. */
  VOUCHER_DELETED: `${SYSTEM_NOTE_PREFIX}voucher_deleted`,
  /** The voucher was confirmed on its own screen; the request closed as APPROVED. */
  VOUCHER_CONFIRMED: `${SYSTEM_NOTE_PREFIX}voucher_confirmed`,
  /** The requester resolved their own entity, so the request closed as WITHDRAWN. */
  SELF_RESOLVED: `${SYSTEM_NOTE_PREFIX}self_resolved`,
};

const SYSTEM_NOTE_TRANSLATION_KEYS = {
  [SYSTEM_DECISION_NOTES.VOUCHER_DELETED]: "decision_note_voucher_deleted",
  [SYSTEM_DECISION_NOTES.VOUCHER_CONFIRMED]: "decision_note_voucher_confirmed",
  [SYSTEM_DECISION_NOTES.SELF_RESOLVED]: "decision_note_self_resolved",
};

const MAX_DECISION_NOTE_LENGTH = 500;

/** Trim and cap a human-typed note. Returns "" for blank/whitespace-only input. */
const normalizeDecisionNote = (value) =>
  String(value === null || value === undefined ? "" : value)
    .trim()
    .slice(0, MAX_DECISION_NOTE_LENGTH);

/**
 * The sentinel to record when voucher-approval-sync closes a request that a
 * human never decided. `nextStatus` is the status being written.
 */
const systemNoteForVoucherResolution = (nextStatus) => {
  const status = String(nextStatus || "").toUpperCase();
  if (status === "REJECTED") return SYSTEM_DECISION_NOTES.VOUCHER_DELETED;
  if (status === "APPROVED") return SYSTEM_DECISION_NOTES.VOUCHER_CONFIRMED;
  return SYSTEM_DECISION_NOTES.SELF_RESOLVED;
};

/**
 * Render a stored note for display. Machine sentinels are translated via `t`;
 * anything else is human free text and passes through untouched.
 *
 * Callers must still escape the result -- it is user-supplied text.
 */
const resolveDecisionNoteText = (note, t) => {
  const raw = String(note === null || note === undefined ? "" : note).trim();
  if (!raw) return "";
  const key = SYSTEM_NOTE_TRANSLATION_KEYS[raw];
  if (!key) return raw;
  return typeof t === "function" ? t(key) : raw;
};

module.exports = {
  MAX_DECISION_NOTE_LENGTH,
  SYSTEM_DECISION_NOTES,
  normalizeDecisionNote,
  resolveDecisionNoteText,
  systemNoteForVoucherResolution,
};
