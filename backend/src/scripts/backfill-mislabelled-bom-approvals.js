// One-time backfill: erp.approval_request rows recorded as REJECTED for BOMs
// that were actually APPROVED.
//
// The BOM screen's "Approve" button used to run resetBomFromPendingForAdmin
// before approving: it flipped the queued request to REJECTED (just to knock
// the BOM out of PENDING so the old DRAFT-only guard would pass), then approved
// the BOM. approveBomDirectTx never revisits approval_request, so the row stayed
// on REJECTED while the BOM went APPROVED + ACTIVE. Every BOM an admin approved
// from the BOM screen therefore shows up on the Rejected tab of the approvals
// page, naming the approver as the rejecter.
//
// The route fix (resolvePendingBomApprovalsTx) stops new rows from being
// mislabelled; this repairs the history.
//
// Signature of the bug, and why it is safe to match on:
//   - request status REJECTED, BOM status APPROVED
//   - the request's decided_by IS the BOM's approved_by, and
//   - decided_at and approved_at are moments apart -- both were written by the
//     same HTTP request, the reject immediately before the approve.
// A genuine rejection that was later re-approved fails at least one of those
// (different user, or a real gap), so those rows are reported and left alone.
//
// Rows whose requester is also the approver are closed as WITHDRAWN, not
// APPROVED: the maker-checker CHECK in 010_administration.sql forbids
// decided_by = requested_by for anything else. (The old code could not create
// such a row -- its REJECTED update would have violated that CHECK and 500'd --
// but the script handles it rather than crashing the whole transaction.)
//
// Dry run by default, like backfill-stranded-voucher-approvals.js:
//   node src/scripts/backfill-mislabelled-bom-approvals.js           # preview
//   APPLY=1 node src/scripts/backfill-mislabelled-bom-approvals.js   # write
//   WINDOW_SECONDS=60 node src/scripts/...                           # tighten
//
// Re-running is a no-op: repaired rows are no longer REJECTED.

const knex = require("../db/knex");
const { insertActivityLog } = require("../utils/audit-log");

const TAG = "[backfill-mislabelled-bom-approvals]";

// entity_id is text; only numeric ids point at a bom_header row.
const NUMERIC_ENTITY_ID = "ar.entity_id ~ '^[0-9]+$'";

// How close decided_at and approved_at must be to count as "the same request".
// Generous by default: the old code rejected first and only then saved the
// draft, validated it and resolved the preview, which could take seconds.
const DEFAULT_WINDOW_SECONDS = 300;

const windowSeconds = () => {
  const raw = Number(process.env.WINDOW_SECONDS || DEFAULT_WINDOW_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_SECONDS;
};

const findCandidateRows = (trx) =>
  trx("erp.approval_request as ar")
    // Guard the cast inside the join: entity_id is text and other request types
    // put non-numeric values there.
    .join(
      "erp.bom_header as bh",
      "bh.id",
      knex.raw(
        `CASE WHEN ${NUMERIC_ENTITY_ID} THEN ar.entity_id::bigint ELSE NULL END`,
      ),
    )
    .where("ar.entity_type", "BOM")
    .andWhere("ar.status", "REJECTED")
    .andWhere("bh.status", "APPROVED")
    .whereRaw(NUMERIC_ENTITY_ID)
    .select(
      "ar.id",
      "ar.entity_id",
      "ar.branch_id",
      "ar.requested_by",
      "ar.decided_by",
      "ar.decided_at",
      "ar.summary",
      "bh.bom_no",
      "bh.approved_by",
      "bh.approved_at",
    )
    .orderBy("ar.id", "asc");

const secondsApart = (a, b) => {
  const ta = a ? new Date(a).getTime() : NaN;
  const tb = b ? new Date(b).getTime() : NaN;
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb) / 1000;
};

// Pure so the dry run and the write path can never disagree.
const classify = (row, maxGapSeconds) => {
  const decidedBy = Number(row.decided_by || 0);
  const approvedBy = Number(row.approved_by || 0);
  const requestedBy = Number(row.requested_by || 0);
  const gap = secondsApart(row.decided_at, row.approved_at);

  if (!decidedBy || !approvedBy || decidedBy !== approvedBy) {
    return {
      repair: false,
      why: `rejecter (${decidedBy || "none"}) is not the approver (${approvedBy || "none"})`,
      gap,
    };
  }
  if (gap === null) {
    return { repair: false, why: "missing decided_at or approved_at", gap };
  }
  if (gap > maxGapSeconds) {
    return {
      repair: false,
      why: `rejected ${Math.round(gap)}s from the approval -- outside the ${maxGapSeconds}s window`,
      gap,
    };
  }

  // decided_by = requested_by is legal only for WITHDRAWN.
  if (requestedBy && requestedBy === decidedBy) {
    return {
      repair: true,
      status: "WITHDRAWN",
      decidedBy,
      why: "approver was also the requester",
      gap,
    };
  }
  return {
    repair: true,
    status: "APPROVED",
    decidedBy,
    why: "BOM was approved by the same user in the same action",
    gap,
  };
};

const run = async () => {
  const apply = process.env.APPLY === "1";
  const maxGapSeconds = windowSeconds();

  await knex.transaction(async (trx) => {
    const rows = await findCandidateRows(trx);

    if (!rows.length) {
      console.log(`${TAG} no REJECTED requests against an APPROVED BOM -- nothing to do`);
      return;
    }

    console.log(
      `${TAG} ${rows.length} REJECTED request(s) against an APPROVED BOM` +
        ` (window ${maxGapSeconds}s)${apply ? "" : " [DRY RUN]"}:`,
    );

    const plan = [];
    const counts = {};
    for (const row of rows) {
      const verdict = classify(row, maxGapSeconds);
      const label = `request=${row.id} bom=${row.bom_no || row.entity_id}`;
      const gapText = verdict.gap === null ? "n/a" : `${Math.round(verdict.gap)}s`;
      if (!verdict.repair) {
        console.log(`  KEEP ${label} (gap ${gapText}) -- ${verdict.why}`);
        counts.KEPT = (counts.KEPT || 0) + 1;
        continue;
      }
      plan.push({ row, verdict });
      counts[verdict.status] = (counts[verdict.status] || 0) + 1;
      console.log(
        `  FIX  ${label} (gap ${gapText}) REJECTED -> ${verdict.status}` +
          ` by user ${verdict.decidedBy} -- ${verdict.why}`,
      );
      if (row.summary) console.log(`         ${row.summary}`);
    }

    console.log(
      `${TAG} totals: ${Object.entries(counts)
        .map(([k, n]) => `${k}=${n}`)
        .join(" ") || "none"}`,
    );

    if (!plan.length) {
      console.log(`${TAG} no rows matched the bug signature -- nothing to write`);
      return;
    }

    if (!apply) {
      console.log(`${TAG} DRY RUN -- re-run with APPLY=1 to write these changes`);
      return;
    }

    let written = 0;
    for (const { row, verdict } of plan) {
      await trx("erp.approval_request")
        .where({ id: row.id, status: "REJECTED" })
        .update({
          status: verdict.status,
          decided_by: verdict.decidedBy,
          // Keep the original timestamp: it is when the approval actually
          // happened, only the status was wrong.
          decided_at: row.decided_at || trx.fn.now(),
          decision_notes: `Corrected by backfill: ${verdict.why}`,
        });

      await insertActivityLog(trx, {
        branch_id: row.branch_id,
        user_id: verdict.decidedBy,
        entity_type: "BOM",
        entity_id: String(row.entity_id),
        action: verdict.status === "APPROVED" ? "APPROVE" : "CANCEL",
        ip_address: null,
        context: {
          source: "approval-backfill",
          approval_request_id: row.id,
          decision: verdict.status,
          previous_status: "REJECTED",
          reason: verdict.why,
          bom_no: row.bom_no || null,
          summary: row.summary || null,
        },
      });
      written += 1;
    }

    console.log(`${TAG} corrected ${written} request(s)`);
  });
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`${TAG} failed:`, err);
    await knex.destroy();
    process.exit(1);
  });
