// One-time backfill: erp.voucher_header rows left PENDING even though their
// approval request was already rejected or withdrawn.
//
// The mirror image of backfill-stranded-voucher-approvals.js: there the
// request was stranded PENDING behind a decided voucher, here the voucher is
// stranded PENDING behind a decided request.
//
// Cause: unwindPendingApprovalRequestTx only flipped the header to REJECTED
// when the request's new_value.action read "create". But createApprovalRequest
// keeps one PENDING request per voucher and rewrites it in place, so re-saving
// a queued Physical Count Correction relabelled its original create request as
// "update" -- and the rejection then closed the request while leaving the
// header on PENDING. The voucher screen reads vh.status directly, so a
// rejected stock count still showed "Pending". Fixed in approvals.js; this
// closes the rows that already got stuck.
//
// Such a voucher is a zombie: no PENDING request is left that could ever
// approve it, and it never posted stock or GL (only the approve path writes
// those, and it flips the status as it does). REJECTED is the same status a
// normal rejection or a delete lands on, so the voucher screens and the
// history list already handle it.
//
// What it will NOT touch:
//   - vouchers whose latest closed request was a "delete" (rejecting a
//     deletion must never be what deletes the voucher)
//   - vouchers that still have any PENDING request (a live decision)
//   - vouchers not in status PENDING (already decided, nothing stranded)
//
// Dry run by default, like backfill-stranded-voucher-approvals.js:
//   node src/scripts/backfill-rejected-voucher-headers.js          # preview
//   APPLY=1 node src/scripts/backfill-rejected-voucher-headers.js  # write

const knex = require("../db/knex");
const { insertActivityLog } = require("../utils/audit-log");

const TAG = "[backfill-rejected-voucher-headers]";

// entity_id is text and may hold 'NEW'; only numeric ids point at a voucher.
const NUMERIC_ENTITY_ID = "ar.entity_id ~ '^[0-9]+$'";

const findStrandedHeaders = (trx) =>
  trx("erp.voucher_header as vh")
    .join(
      "erp.approval_request as ar",
      "vh.id",
      knex.raw(
        `CASE WHEN ${NUMERIC_ENTITY_ID} THEN ar.entity_id::bigint ELSE NULL END`,
      ),
    )
    .where("vh.status", "PENDING")
    .andWhere("ar.request_type", "VOUCHER")
    .andWhere("ar.entity_type", "VOUCHER")
    .whereIn("ar.status", ["REJECTED", "WITHDRAWN"])
    // Rejecting a delete must never be what deletes the voucher.
    .andWhereRaw("coalesce(lower(ar.new_value->>'action'), '') <> 'delete'")
    // A live decision still exists -> not stranded.
    .whereNotExists((qb) =>
      qb
        .select(knex.raw("1"))
        .from("erp.approval_request as p")
        .whereRaw("p.entity_id = ar.entity_id")
        .andWhere("p.request_type", "VOUCHER")
        .andWhere("p.entity_type", "VOUCHER")
        .andWhere("p.status", "PENDING"),
    )
    .select(
      "vh.id as voucher_id",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.branch_id",
      "ar.id as request_id",
      "ar.status as request_status",
      "ar.summary",
      "ar.decided_by",
      "ar.decided_at",
      "ar.requested_by",
      knex.raw("lower(ar.new_value->>'action') as action"),
    )
    .orderBy("ar.decided_at", "desc");

// Several closed requests can point at one voucher (older history plus the
// rewritten row). The most recently decided one is the decision that stranded
// it, so it supplies the decider recorded on the header.
const keepLatestPerVoucher = (rows) => {
  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    const key = String(row.voucher_id);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
};

const run = async () => {
  const apply = process.env.APPLY === "1";

  await knex.transaction(async (trx) => {
    const rows = keepLatestPerVoucher(await findStrandedHeaders(trx));

    if (!rows.length) {
      console.log(`${TAG} nothing stranded -- no voucher headers to close`);
      return;
    }

    console.log(
      `${TAG} found ${rows.length} PENDING voucher header(s) behind a closed request${
        apply ? "" : " (DRY RUN)"
      }:`,
    );

    const counts = {};
    for (const row of rows) {
      const type = row.voucher_type_code || "(unknown)";
      counts[type] = (counts[type] || 0) + 1;
      console.log(
        `  voucher=${row.voucher_id} ${type} #${row.voucher_no}` +
          ` <- request=${row.request_id} ${row.request_status}` +
          ` action=${row.action || "(none)"} -> REJECTED`,
      );
      if (row.summary) console.log(`      ${row.summary}`);
    }

    console.log(
      `${TAG} totals: ${Object.entries(counts)
        .map(([type, n]) => `${type}=${n}`)
        .join(" ")}`,
    );

    if (!apply) {
      console.log(
        `${TAG} DRY RUN -- re-run with APPLY=1 to write these changes`,
      );
      return;
    }

    let written = 0;
    for (const row of rows) {
      // Whoever closed the request is the honest decider; fall back to the
      // requester for a withdrawal that predates decided_by being recorded.
      const decidedBy =
        Number(row.decided_by || 0) || Number(row.requested_by || 0) || null;

      const updated = await trx("erp.voucher_header")
        .where({ id: row.voucher_id, status: "PENDING" })
        .update({
          status: "REJECTED",
          approved_by: decidedBy,
          approved_at: row.decided_at || trx.fn.now(),
        });
      if (!updated) continue;

      await insertActivityLog(trx, {
        branch_id: row.branch_id,
        user_id: decidedBy,
        entity_type: "VOUCHER",
        entity_id: String(row.voucher_id),
        voucher_type_code: row.voucher_type_code || null,
        action: "REJECT",
        ip_address: null,
        context: {
          source: "voucher-header-backfill",
          approval_request_id: row.request_id,
          decision: "REJECTED",
          reason: `request closed as ${row.request_status} but header stayed PENDING`,
          request_action: row.action || null,
          summary: row.summary || null,
        },
      });
      written += 1;
    }

    console.log(`${TAG} closed ${written} voucher header(s)`);
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
