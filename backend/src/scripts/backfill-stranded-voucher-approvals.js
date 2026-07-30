// One-time backfill: erp.approval_request rows left PENDING even though their
// voucher already moved on.
//
// Two shipped fixes each closed a leak but neither cleaned up history:
//   - voucher-approval-sync.js resolves a voucher's PENDING approval when the
//     voucher is confirmed/deleted directly, but until WITHDRAWN existed it had
//     to SKIP rows whose requester was the confirmer (the maker-checker CHECK
//     forbade recording them as decider). Those stayed PENDING forever.
//   - the same reconciliation shipped with no backfill at all, so any voucher
//     confirmed before it existed can still have a stranded request.
//
// Such rows sit on the Pending Approvals page and inflate the pending KPI
// forever: the voucher is already APPROVED/REJECTED, so approving or rejecting
// the request does nothing useful.
//
// What it will NOT touch (these are legitimately pending):
//   - entity_id = 'NEW' -- no voucher exists yet, the payload is in new_value
//   - vouchers still in status PENDING
//   - non-VOUCHER request types (a pending master-data/BOM change is only
//     stale once a human decides it is)
//
// Resolution per row:
//   voucher APPROVED + a different approver -> APPROVED (that approver)
//   voucher REJECTED + a different rejecter -> REJECTED (that rejecter)
//   either, but the requester is the one who did it -> WITHDRAWN (requester)
//   numeric entity_id whose voucher row is gone -> WITHDRAWN (requester)
// WITHDRAWN is the honest record when the maker closed it themselves, and the
// only status the maker-checker CHECK allows on one's own request.
//
// Unlike cleanup-stuck-grn-in-headers.js this defaults to a DRY RUN, because
// there is no other way to preview which rows it would close:
//   node src/scripts/backfill-stranded-voucher-approvals.js          # preview
//   APPLY=1 node src/scripts/backfill-stranded-voucher-approvals.js  # write

const knex = require("../db/knex");
const { insertActivityLog } = require("../utils/audit-log");

const TAG = "[backfill-stranded-voucher-approvals]";

const AUDIT_ACTION = {
  APPROVED: "APPROVE",
  REJECTED: "REJECT",
  WITHDRAWN: "CANCEL",
};

// entity_id is text and may hold 'NEW'; only numeric ids point at a voucher.
const NUMERIC_ENTITY_ID = "ar.entity_id ~ '^[0-9]+$'";

const findStrandedRows = (trx) =>
  trx("erp.approval_request as ar")
    // The cast must be guarded inside the join: entity_id is text and holds
    // 'NEW' for some rows, which would blow up a bare ::bigint. Same shape as
    // dashboard-metrics-service.js.
    .leftJoin(
      "erp.voucher_header as vh",
      "vh.id",
      knex.raw(
        `CASE WHEN ${NUMERIC_ENTITY_ID} THEN ar.entity_id::bigint ELSE NULL END`,
      ),
    )
    .where("ar.status", "PENDING")
    .andWhere("ar.entity_type", "VOUCHER")
    .whereRaw(NUMERIC_ENTITY_ID)
    // Stranded = the voucher is no longer awaiting anything, or is gone.
    .andWhere((qb) =>
      qb.whereNull("vh.id").orWhereNot("vh.status", "PENDING"),
    )
    .select(
      "ar.id",
      "ar.entity_id",
      "ar.branch_id",
      "ar.requested_by",
      "ar.summary",
      "vh.id as voucher_row_id",
      "vh.status as voucher_status",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.approved_by",
      "vh.approved_at",
    )
    .orderBy("ar.id", "asc");

// Decide the closing status for one stranded row. Kept pure so the dry run and
// the write path can never disagree about what would happen.
const resolveTarget = (row) => {
  const requestedBy = Number(row.requested_by || 0);
  const decider = Number(row.approved_by || 0);
  const voucherStatus = String(row.voucher_status || "");

  const selfClosed = !decider || decider === requestedBy;
  if (!row.voucher_row_id) {
    return {
      status: "WITHDRAWN",
      decidedBy: requestedBy,
      decidedAt: null,
      why: "voucher row no longer exists",
    };
  }
  if (voucherStatus === "APPROVED") {
    return selfClosed
      ? {
          status: "WITHDRAWN",
          decidedBy: requestedBy,
          decidedAt: row.approved_at || null,
          why: "requester confirmed their own voucher",
        }
      : {
          status: "APPROVED",
          decidedBy: decider,
          decidedAt: row.approved_at || null,
          why: "voucher was confirmed by another user",
        };
  }
  if (voucherStatus === "REJECTED") {
    return selfClosed
      ? {
          status: "WITHDRAWN",
          decidedBy: requestedBy,
          decidedAt: row.approved_at || null,
          why: "requester deleted their own voucher",
        }
      : {
          status: "REJECTED",
          decidedBy: decider,
          decidedAt: row.approved_at || null,
          why: "voucher was deleted by another user",
        };
  }
  // Any other non-PENDING status: close it without claiming a decision.
  return {
    status: "WITHDRAWN",
    decidedBy: requestedBy,
    decidedAt: row.approved_at || null,
    why: `voucher status ${voucherStatus || "(none)"}`,
  };
};

const run = async () => {
  const apply = process.env.APPLY === "1";

  await knex.transaction(async (trx) => {
    const rows = await findStrandedRows(trx);

    if (!rows.length) {
      console.log(`${TAG} nothing stranded -- no rows to close`);
      return;
    }

    console.log(
      `${TAG} found ${rows.length} stranded PENDING request(s)${apply ? "" : " (DRY RUN)"}:`,
    );

    const plan = [];
    const counts = {};
    for (const row of rows) {
      const target = resolveTarget(row);
      plan.push({ row, target });
      counts[target.status] = (counts[target.status] || 0) + 1;
      console.log(
        `  request=${row.id} voucher=${row.voucher_no || row.entity_id}` +
          ` (${row.voucher_status || "missing"}) -> ${target.status}` +
          ` by user ${target.decidedBy} -- ${target.why}`,
      );
      if (row.summary) console.log(`      ${row.summary}`);
    }

    console.log(
      `${TAG} totals: ${Object.entries(counts)
        .map(([status, n]) => `${status}=${n}`)
        .join(" ")}`,
    );

    if (!apply) {
      console.log(`${TAG} DRY RUN -- re-run with APPLY=1 to write these changes`);
      return;
    }

    let written = 0;
    for (const { row, target } of plan) {
      if (!target.decidedBy) {
        console.log(
          `  SKIP request=${row.id}: no user to record as decider (requested_by is empty)`,
        );
        continue;
      }
      await trx("erp.approval_request")
        .where({ id: row.id, status: "PENDING" })
        .update({
          status: target.status,
          decided_by: target.decidedBy,
          decided_at: target.decidedAt || trx.fn.now(),
          decision_notes: `Closed by backfill: ${target.why}`,
        });

      await insertActivityLog(trx, {
        branch_id: row.branch_id,
        user_id: target.decidedBy,
        entity_type: "VOUCHER",
        entity_id: String(row.entity_id),
        voucher_type_code: row.voucher_type_code || null,
        action: AUDIT_ACTION[target.status] || "CANCEL",
        ip_address: null,
        context: {
          source: "approval-backfill",
          approval_request_id: row.id,
          decision: target.status,
          reason: target.why,
          voucher_status: row.voucher_status || null,
          summary: row.summary || null,
        },
      });
      written += 1;
    }

    console.log(`${TAG} closed ${written} request(s)`);
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
