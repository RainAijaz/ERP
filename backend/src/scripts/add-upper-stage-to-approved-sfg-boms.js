// One-time data change, both edits in a single transaction:
//   1. append the UPPER production stage as the LAST stage route of every
//      APPROVED semi-finished (SFG) BOM;
//   2. clear "Follow Sequence" (bom_stage_routing.enforce_sequence) on the
//      PRINTING route of those same BOMs.
//
// Both write straight to erp.bom_stage_routing rather than going through
// bom/service.js: that path rewrites every line of a BOM and raises an approval
// request per BOM, which is the wrong shape for a bulk routing correction. The
// change IS recorded in erp.bom_change_log (section "stage_routes") so the BOM
// Change Log report still explains where the rows came from.
//
// Consequence worth knowing before --apply: production-voucher-service treats
// the highest-sequence REQUIRED route as the final stage, and that is the stage
// where WIP is converted into real SFG stock. Making UPPER last moves that
// conversion from whatever stage is last today onto UPPER, so SFG stock will
// only be created once production is posted at the UPPER stage.
//
// What it will NOT touch:
//   - BOMs that already have an UPPER route as their last stage (nothing to do)
//   - BOMs where an UPPER route exists mid-sequence (reported as REVIEW; moving
//     it would renumber a live routing, which is a different decision)
//   - BOMs with no stage routes at all (adding one would switch stage routing
//     ON for a BOM that has none -- pass --include-unrouted to override)
//   - FINISHED BOMs, drafts, pending and rejected BOMs
//
// Dry run by default; nothing is committed without --apply:
//   node src/scripts/add-upper-stage-to-approved-sfg-boms.js           # preview
//   node src/scripts/add-upper-stage-to-approved-sfg-boms.js --apply   # write
//
// Useful flags:
//   --upper-stage=NAME        stage to append          (default "UPPER")
//   --printing-stage=NAME     stage to unmark          (default "PRINTING")
//   --upper-stage-id=N        pick a stage by id when the name is ambiguous
//   --printing-stage-id=N     same, for the printing stage
//   --bom=12,34               limit to these bom_header ids (rehearsal)
//   --changed-by=N            user id for the change log (default: the BOM's
//                             own approver, else its creator)
//   --upper-not-required      insert UPPER with is_required = false
//   --upper-no-follow-sequence insert UPPER with enforce_sequence = false
//   --include-unrouted        also add UPPER to BOMs that have no routes yet

const knex = require("../db/knex");
const { buildChangeRows } = require("../utils/bom-change-log");

const TAG = "[add-upper-stage-to-approved-sfg-boms]";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const flagValue = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
};
const toPositiveInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

const APPLY = hasFlag("apply") || process.env.APPLY === "1";
const UPPER_NEEDLE = flagValue("upper-stage", "UPPER");
const PRINTING_NEEDLE = flagValue("printing-stage", "PRINTING");
const UPPER_STAGE_ID = toPositiveInt(flagValue("upper-stage-id"));
const PRINTING_STAGE_ID = toPositiveInt(flagValue("printing-stage-id"));
const CHANGED_BY = toPositiveInt(flagValue("changed-by"));
const UPPER_IS_REQUIRED = !hasFlag("upper-not-required");
const UPPER_ENFORCE_SEQUENCE = !hasFlag("upper-no-follow-sequence");
const INCLUDE_UNROUTED = hasFlag("include-unrouted");
const ONLY_BOM_IDS = String(flagValue("bom", ""))
  .split(",")
  .map((part) => toPositiveInt(part))
  .filter(Boolean);

// Thrown to unwind the transaction after a successful dry run.
const ROLLBACK = Symbol("dry-run");

class AbortError extends Error {}

const stageQuery = (trx) =>
  trx("erp.production_stages as ps")
    .leftJoin("erp.departments as d", "d.id", "ps.dept_id")
    .select(
      "ps.id",
      "ps.code",
      "ps.name",
      "ps.is_active",
      "ps.dept_id",
      "d.name as dept_name",
      "d.is_active as dept_is_active",
      "d.is_production as dept_is_production",
    );

const describeStage = (row) =>
  `id=${row.id} code=${row.code} name="${row.name}" dept="${row.dept_name || "?"}" (dept_id=${row.dept_id})`;

// Stage rows are auto-created from departments by bom/service.js, so `name` is
// the department name and `code` is usually DEPT-<id>; match on either.
const resolveStage = async (trx, { label, explicitId, needle }) => {
  if (explicitId) {
    const row = await stageQuery(trx).where("ps.id", explicitId).first();
    if (!row) {
      throw new AbortError(
        `${label}: no erp.production_stages row with id ${explicitId}.`,
      );
    }
    return row;
  }

  const norm = String(needle || "").trim().toUpperCase();
  if (!norm) throw new AbortError(`${label}: empty stage name.`);

  const exact = await stageQuery(trx)
    .where("ps.is_active", true)
    .andWhere((qb) =>
      qb
        .whereRaw("upper(trim(ps.name)) = ?", [norm])
        .orWhereRaw("upper(trim(ps.code)) = ?", [norm]),
    );

  if (exact.length === 1) return exact[0];

  if (exact.length > 1) {
    throw new AbortError(
      [
        `${label}: "${needle}" matches ${exact.length} active stages, refusing to guess.`,
        ...exact.map((row) => `    ${describeStage(row)}`),
        `  Re-run with --${label.toLowerCase()}-stage-id=<id>.`,
      ].join("\n"),
    );
  }

  // Nothing matched. Say exactly what does exist so the fix is obvious.
  const fuzzy = await stageQuery(trx)
    .where("ps.is_active", true)
    .andWhereRaw("upper(ps.name) like ?", [`%${norm}%`]);
  const dept = await trx("erp.departments")
    .select("id", "name", "is_active", "is_production")
    .whereRaw("upper(trim(name)) = ?", [norm])
    .first();

  const lines = [
    `${label}: no ACTIVE production stage named "${needle}" exists. Nothing was changed.`,
  ];
  if (fuzzy.length) {
    lines.push("  Similar active stages:");
    fuzzy.forEach((row) => lines.push(`    ${describeStage(row)}`));
  }
  if (dept) {
    lines.push(
      `  A department "${dept.name}" (id=${dept.id}, active=${dept.is_active}, production=${dept.is_production}) does exist,`,
      "  but no production stage is mapped to it yet. Stages are created from",
      "  departments the first time one is used on a BOM's Stage Routing tab.",
    );
  } else {
    lines.push(
      `  No department named "${needle}" exists either -- create the department`,
      "  (Production = yes) and use it on one BOM first, then re-run this script.",
    );
  }
  lines.push("  Active production stages on this database:");
  const all = await stageQuery(trx)
    .where("ps.is_active", true)
    .orderBy("ps.name", "asc");
  all.forEach((row) => lines.push(`    ${describeStage(row)}`));
  throw new AbortError(lines.join("\n"));
};

const assertUsableStage = (row, { label, requireProductionDept }) => {
  if (row.is_active !== true) {
    throw new AbortError(
      `${label}: stage ${describeStage(row)} is INACTIVE. Reactivate it first.`,
    );
  }
  if (!requireProductionDept) return;
  if (row.dept_is_active !== true || row.dept_is_production !== true) {
    throw new AbortError(
      [
        `${label}: department "${row.dept_name}" (id=${row.dept_id}) is`,
        `  active=${row.dept_is_active}, production=${row.dept_is_production}.`,
        "  A stage route on a non-production or inactive department is invisible",
        "  to the BOM form and to production vouchers. Fix the department first.",
      ].join("\n"),
    );
  }
};

// Same column list and ordering as getBomSnapshot() in bom/service.js, so the
// change-log payloads read identically to ones written by the BOM screen.
const snapshotRoute = (row) => ({
  stage_id: row.stage_id,
  sequence_no: row.sequence_no,
  is_required: row.is_required,
  enforce_sequence: row.enforce_sequence,
  dept_id: row.dept_id,
  dept_name: row.dept_name,
});

const run = async (trx) => {
  const upper = await resolveStage(trx, {
    label: "UPPER",
    explicitId: UPPER_STAGE_ID,
    needle: UPPER_NEEDLE,
  });
  assertUsableStage(upper, { label: "UPPER", requireProductionDept: true });

  const printing = await resolveStage(trx, {
    label: "PRINTING",
    explicitId: PRINTING_STAGE_ID,
    needle: PRINTING_NEEDLE,
  });
  assertUsableStage(printing, {
    label: "PRINTING",
    requireProductionDept: false,
  });

  console.log(`${TAG} UPPER stage    -> ${describeStage(upper)}`);
  console.log(`${TAG} PRINTING stage -> ${describeStage(printing)}`);
  console.log("");

  const hasLifecycleColumn = await trx.schema
    .withSchema("erp")
    .hasColumn("bom_header", "is_active");

  let bomQuery = trx("erp.bom_header as bh")
    .join("erp.items as i", "i.id", "bh.item_id")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.item_id",
      "bh.version_no",
      "bh.approved_by",
      "bh.created_by",
      "i.name as item_name",
    )
    .modify((qb) => {
      if (hasLifecycleColumn) qb.select("bh.is_active");
    })
    .where("bh.level", "SEMI_FINISHED")
    .andWhere("bh.status", "APPROVED")
    .orderBy([
      { column: "i.name", order: "asc" },
      { column: "bh.version_no", order: "asc" },
    ]);
  if (ONLY_BOM_IDS.length) bomQuery = bomQuery.whereIn("bh.id", ONLY_BOM_IDS);
  const boms = await bomQuery;

  if (!boms.length) {
    console.log(`${TAG} No APPROVED semi-finished BOMs found. Nothing to do.`);
    return { inserted: 0, updated: 0, logged: 0 };
  }

  const bomIds = boms.map((row) => Number(row.id));

  // Production reads the highest approved version per item, so older approved
  // versions are inert. They are still updated (the ask was "all approved"),
  // but flagged so the counts are not surprising.
  const latestVersionByItem = new Map();
  boms.forEach((row) => {
    const itemId = Number(row.item_id);
    const version = Number(row.version_no || 0);
    if (version > Number(latestVersionByItem.get(itemId) || 0)) {
      latestVersionByItem.set(itemId, version);
    }
  });

  const routeRows = await trx("erp.bom_stage_routing as bsr")
    .leftJoin("erp.production_stages as ps", "ps.id", "bsr.stage_id")
    .leftJoin("erp.departments as dept", "dept.id", "ps.dept_id")
    .select(
      "bsr.id as route_id",
      "bsr.bom_id",
      "bsr.stage_id",
      "bsr.sequence_no",
      "bsr.is_required",
      "bsr.enforce_sequence",
      "ps.dept_id",
      "ps.name as stage_name",
      "dept.name as dept_name",
    )
    .whereIn("bsr.bom_id", bomIds)
    .orderBy([
      { column: "bsr.bom_id", order: "asc" },
      { column: "bsr.sequence_no", order: "asc" },
    ]);

  const routesByBom = new Map();
  routeRows.forEach((row) => {
    const key = Number(row.bom_id);
    if (!routesByBom.has(key)) routesByBom.set(key, []);
    routesByBom.get(key).push(row);
  });

  // A pending "update" request carries the whole form payload captured at SUBMIT
  // time. Approving it runs saveBomDraftTx -> replaceBomLines, which DELETEs every
  // bom_stage_routing row for the BOM and re-inserts only what the payload holds
  // -- so it drops the UPPER row and restores PRINTING's enforce_sequence, with no
  // error. Other actions do not rewrite this BOM's routes.
  const pendingRows = await trx("erp.approval_request")
    .select("id", "entity_id", "requested_by")
    .select(
      trx.raw("COALESCE(new_value ->> '_action', '') AS pending_action"),
    )
    .where({ entity_type: "BOM", status: "PENDING" })
    .whereIn("entity_id", bomIds.map(String));
  const pendingByBomId = new Map();
  pendingRows.forEach((row) => {
    const key = String(row.entity_id);
    if (!pendingByBomId.has(key)) pendingByBomId.set(key, []);
    pendingByBomId.get(key).push(row);
  });
  const CLOBBERING_ACTIONS = new Set(["update", "create"]);
  const clobberingRequests = (bomId) =>
    (pendingByBomId.get(String(bomId)) || []).filter((row) =>
      CLOBBERING_ACTIONS.has(String(row.pending_action || "").toLowerCase()),
    );

  const plans = boms.map((bom) => {
    const bomId = Number(bom.id);
    const routes = routesByBom.get(bomId) || [];
    const upperRoute = routes.find(
      (row) => Number(row.stage_id) === Number(upper.id),
    );
    const printingRoute = routes.find(
      (row) => Number(row.stage_id) === Number(printing.id),
    );
    const maxSeq = routes.reduce(
      (acc, row) => Math.max(acc, Number(row.sequence_no || 0)),
      0,
    );

    let upperAction = "ADD";
    let upperNote = "";
    if (upperRoute) {
      const isLast = Number(upperRoute.sequence_no) === maxSeq;
      upperAction = isLast ? "SKIP" : "REVIEW";
      upperNote = isLast
        ? "already last"
        : `already present at seq ${upperRoute.sequence_no} of ${maxSeq} -- left as is`;
    } else if (!routes.length && !INCLUDE_UNROUTED) {
      upperAction = "SKIP";
      upperNote = "BOM has no stage routing (use --include-unrouted)";
    }

    let printingAction = "SKIP";
    let printingNote = "no PRINTING route on this BOM";
    if (printingRoute) {
      if (printingRoute.enforce_sequence === false) {
        printingNote = "follow sequence already off";
      } else {
        printingAction = "UNMARK";
        printingNote = `seq ${printingRoute.sequence_no}`;
      }
    }

    return {
      bom,
      bomId,
      routes,
      maxSeq,
      upperAction,
      upperNote,
      printingRoute,
      printingAction,
      printingNote,
      isLatestVersion:
        Number(bom.version_no || 0) ===
        Number(latestVersionByItem.get(Number(bom.item_id)) || 0),
      clobberingRequests: clobberingRequests(bomId),
      otherPendingActions: (pendingByBomId.get(String(bomId)) || [])
        .map((row) => String(row.pending_action || "?").toLowerCase())
        .filter((action) => !CLOBBERING_ACTIONS.has(action)),
    };
  });

  const pad = (value, width) => String(value).padEnd(width);
  console.log(
    `${pad("BOM", 12)} ${pad("ITEM", 34)} ${pad("V", 3)} ${pad("UPPER", 8)} ${pad("PRINTING", 9)} NOTES`,
  );
  console.log("-".repeat(120));
  plans.forEach((plan) => {
    const notes = [plan.upperNote, plan.printingNote].filter(Boolean);
    if (!plan.isLatestVersion) notes.push("superseded version");
    plan.clobberingRequests.forEach((row) =>
      notes.push(
        `!! PENDING "${row.pending_action}" request #${row.id} WILL REVERT THIS`,
      ),
    );
    if (plan.otherPendingActions.length) {
      notes.push(`pending ${plan.otherPendingActions.join("/")} (harmless)`);
    }
    console.log(
      `${pad(plan.bom.bom_no, 12)} ${pad(String(plan.bom.item_name).slice(0, 33), 34)} ${pad(plan.bom.version_no, 3)} ${pad(plan.upperAction, 8)} ${pad(plan.printingAction, 9)} ${notes.join("; ")}`,
    );
  });
  console.log("");

  const inserts = [];
  const updates = [];
  const changeLogRows = [];

  plans.forEach((plan) => {
    const before = plan.routes.map(snapshotRoute);
    const after = plan.routes.map(snapshotRoute);

    if (plan.upperAction === "ADD") {
      const nextSeq = plan.maxSeq + 1;
      inserts.push({
        bom_id: plan.bomId,
        stage_id: upper.id,
        sequence_no: nextSeq,
        is_required: UPPER_IS_REQUIRED,
        enforce_sequence: UPPER_ENFORCE_SEQUENCE,
      });
      after.push({
        stage_id: upper.id,
        sequence_no: nextSeq,
        is_required: UPPER_IS_REQUIRED,
        enforce_sequence: UPPER_ENFORCE_SEQUENCE,
        dept_id: upper.dept_id,
        dept_name: upper.dept_name,
      });
    }

    if (plan.printingAction === "UNMARK") {
      updates.push(Number(plan.printingRoute.route_id));
      const target = after.find(
        (row) => Number(row.stage_id) === Number(printing.id),
      );
      if (target) target.enforce_sequence = false;
    }

    const rows = buildChangeRows({
      bomId: plan.bomId,
      versionNo: plan.bom.version_no,
      requestId: null,
      changedBy:
        CHANGED_BY ||
        toPositiveInt(plan.bom.approved_by) ||
        toPositiveInt(plan.bom.created_by) ||
        null,
      section: "stage_routes",
      beforeRows: before,
      afterRows: after,
    });
    changeLogRows.push(...rows);
  });

  if (inserts.length) await trx("erp.bom_stage_routing").insert(inserts);
  if (updates.length) {
    await trx("erp.bom_stage_routing")
      .whereIn("id", updates)
      .update({ enforce_sequence: false });
  }
  if (changeLogRows.length) {
    await trx("erp.bom_change_log").insert(changeLogRows);
  }

  const counts = {
    boms: plans.length,
    inserted: inserts.length,
    updated: updates.length,
    logged: changeLogRows.length,
    review: plans.filter((plan) => plan.upperAction === "REVIEW").length,
    unrouted: plans.filter((plan) => !plan.routes.length).length,
    pending: plans.filter((plan) => plan.clobberingRequests.length).length,
  };

  console.log(`${TAG} approved SFG BOMs scanned : ${counts.boms}`);
  console.log(`${TAG} UPPER routes appended     : ${counts.inserted}`);
  console.log(`${TAG} PRINTING routes unmarked  : ${counts.updated}`);
  console.log(`${TAG} bom_change_log rows       : ${counts.logged}`);
  if (counts.review) {
    console.log(
      `${TAG} NEEDS REVIEW              : ${counts.review} BOM(s) already have UPPER mid-sequence`,
    );
  }
  if (counts.unrouted) {
    console.log(
      `${TAG} no stage routing          : ${counts.unrouted} BOM(s)${INCLUDE_UNROUTED ? " (included)" : " (skipped)"}`,
    );
  }
  if (counts.pending) {
    console.log("");
    console.log(
      `${TAG} WARNING: ${counts.pending} BOM(s) have a PENDING create/update request.`,
    );
    console.log(
      `${TAG}   Approving one runs replaceBomLines, which deletes ALL of that BOM's`,
    );
    console.log(
      `${TAG}   bom_stage_routing rows and re-inserts only what the request payload`,
    );
    console.log(
      `${TAG}   captured at submit time -- i.e. it silently removes the UPPER row`,
    );
    console.log(
      `${TAG}   added here and sets PRINTING's follow-sequence back to ON.`,
    );
    console.log(
      `${TAG}   Decide those requests first, then re-run this script for those BOMs.`,
    );
  }
  return counts;
};

(async () => {
  let failed = false;
  console.log(`${TAG} mode: ${APPLY ? "APPLY (writes committed)" : "DRY RUN"}`);
  if (ONLY_BOM_IDS.length) {
    console.log(`${TAG} restricted to bom ids: ${ONLY_BOM_IDS.join(", ")}`);
  }
  console.log("");
  try {
    await knex.transaction(async (trx) => {
      await run(trx);
      if (!APPLY) throw ROLLBACK;
    });
    console.log(`\n${TAG} committed.`);
  } catch (err) {
    if (err === ROLLBACK) {
      console.log(
        `\n${TAG} dry run complete -- rolled back, nothing was written.`,
      );
      console.log(`${TAG} re-run with --apply to commit.`);
    } else if (err instanceof AbortError) {
      failed = true;
      console.error(`\n${TAG} ABORTED\n${err.message}`);
    } else {
      failed = true;
      console.error(`\n${TAG} FAILED:`, err);
    }
  } finally {
    await knex.destroy();
  }
  process.exit(failed ? 1 : 0);
})();
