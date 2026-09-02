// =============================================================================
// align-fg-boms-by-article-letter.js
// =============================================================================
// Give every FG article that shares a leading letter the same FINISHED BOM.
//
//   J201, J300, j450   -> group "J"
//   W201, W450         -> group "W"
//   t10, t11           -> group "T"     (case-insensitive)
//   116, 300, 321      -> no leading letter, reported and skipped
//
// Per letter group the script picks ONE approved FINISHED BOM as the template
// (the most complete one, see --template to override) and copies it onto every
// other article in that group as a **DRAFT** BOM. Nothing goes live: each draft
// still has to be approved in the app, so maker-checker stays fully intact.
//
// The copy is the same mapping the "Copy from another article" button on the BOM
// screen performs -- it goes through bom/services/copy-service.js, so per-SKU
// rules are re-pointed from the template's SKUs onto the target article's own
// SKUs by matching **size + grade + packing** (colour is deliberately ignored;
// this business does not treat colour as a distinguishing variant). A source SKU
// whose size/packing combination the target article does not carry is reported
// and left out rather than guessed at.
//
// Sections copied (all four by default, --sections to narrow):
//   rm             erp.bom_rm_line            material recipe per department
//   sku_overrides  erp.bom_sku_override_line  the per-SKU rules -- "same size +
//                                             packaging => same SKU" mapping
//   stage_routes   erp.bom_stage_routing      CUTTING -> ... -> DC PROI sequence
//   sfg            erp.bom_sfg_line           re-pointed to the TARGET article's
//                                             own linked SFG of the same size;
//                                             a global SFG copies across as-is
//
// Labour lines are never copied (rates are per article/labour, not per recipe).
//
// WHAT IT WILL NOT TOUCH
//   - Any article whose code does not start with A-Z.
//   - A group with no approved FINISHED BOM to copy from (reported as REVIEW).
//   - The template article itself.
//   - An article that already has a DRAFT BOM (reported; --overwrite-drafts
//     rewrites drafts created by --created-by, other people's are always left).
//   - An article with a PENDING BOM approval request -- approving it later would
//     clobber whatever this script wrote.
//   - Inactive articles (--include-inactive-items to include them).
//   - SEMI_FINISHED BOMs. This is FINISHED only.
//
// AN ARTICLE THAT ALREADY HAS AN APPROVED BOM still gets a draft (that is what
// "all articles with that letter have the same BOM" means). The approved version
// keeps serving production until someone approves the new draft. Use
// --only-missing to restrict the run to articles that have no BOM at all.
//
// Dry run by default; nothing is committed without --apply:
//   node src/scripts/align-fg-boms-by-article-letter.js --created-by=3
//   node src/scripts/align-fg-boms-by-article-letter.js --apply --created-by=3
//
// Flags:
//   --apply                    commit (default is a rolled-back rehearsal)
//   --created-by=N             erp.users.id the drafts are created as. REQUIRED,
//                              dry run included. Pick someone who will NOT be the
//                              approver -- a BOM cannot be approved by its maker.
//   --letters=J,W              only these groups
//   --targets=J300,J450        only these article codes as targets
//   --template=J:J201,W:W201   pin the template article per letter by code
//   --sections=rm,sfg          narrow what is copied (default: all four)
//   --only-missing             only articles with no FINISHED BOM at all
//   --overwrite-drafts         rewrite an existing draft made by --created-by
//                              instead of skipping it (its labour lines are
//                              preserved; every other section is replaced)
//   --include-inactive-items   also target is_active = false articles
//   --limit=N                  stop after N drafts (staged rollout)
//   --no-validate              skip the send-for-approval readiness check
//   --verbose                  print every skipped line, not just the first few
//
// NOTE ON LOCKING: creating a BOM number takes a SHARE ROW EXCLUSIVE lock on
// erp.bom_header, held until the transaction ends, which blocks other BOM saves
// for the duration. Run it at a quiet moment, or use --limit to go in batches.
// =============================================================================

const knex = require("../db/knex");
const bomService = require("../services/bom/service");
const bomCopyService = require("../services/bom/copy-service");
const { insertBomChangeLog } = require("../utils/bom-change-log");
const { resolveTranslation } = require("../middleware/core/locale");

// The BOM services expect the request-scoped translator. Outside a request there
// is none, so resolve straight against the English table.
const t = (key) => resolveTranslation("en", key);

const TAG = "[align-fg-boms-by-letter]";
const LEVEL = "FINISHED";

const ALL_SECTIONS = ["rm", "sku_overrides", "stage_routes", "sfg"];
const SECTION_TABLE = {
  rm: "erp.bom_rm_line",
  sku_overrides: "erp.bom_sku_override_line",
  stage_routes: "erp.bom_stage_routing",
  sfg: "erp.bom_sfg_line",
};
// copy-service reports keyed differently from the section names it accepts.
const SECTION_REPORT_KEY = {
  rm: "rm_lines",
  sku_overrides: "sku_overrides",
  stage_routes: "stage_routes",
  sfg: "sfg_lines",
};
const SECTION_LABEL = {
  rm: "rm",
  sku_overrides: "sku",
  stage_routes: "stg",
  sfg: "sfg",
};

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
const csv = (value) =>
  String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

const APPLY = hasFlag("apply") || process.env.APPLY === "1";
const CREATED_BY = toPositiveInt(flagValue("created-by"));
const ONLY_MISSING = hasFlag("only-missing");
const OVERWRITE_DRAFTS = hasFlag("overwrite-drafts");
const INCLUDE_INACTIVE_ITEMS = hasFlag("include-inactive-items");
const VERBOSE = hasFlag("verbose");
const LIMIT = toPositiveInt(flagValue("limit"));
const VALIDATE = !hasFlag("no-validate");

const ONLY_LETTERS = new Set(
  csv(flagValue("letters", "")).map((part) => part.toUpperCase()),
);
const ONLY_TARGET_CODES = new Set(
  csv(flagValue("targets", "")).map((part) => part.toLowerCase()),
);
const TEMPLATE_OVERRIDES = new Map(
  csv(flagValue("template", "")).map((pair) => {
    const idx = pair.indexOf(":");
    if (idx < 0) return [pair.toUpperCase(), null];
    return [
      pair.slice(0, idx).trim().toUpperCase(),
      pair.slice(idx + 1).trim().toLowerCase(),
    ];
  }),
);

const SECTIONS = (() => {
  const raw = flagValue("sections", null);
  if (raw === null) return [...ALL_SECTIONS];
  const picked = csv(raw)
    .map((part) => part.toLowerCase())
    .filter((part) => ALL_SECTIONS.includes(part));
  return picked.length ? picked : [...ALL_SECTIONS];
})();

// Thrown to unwind the transaction after a successful dry run.
const ROLLBACK = Symbol("dry-run");

class AbortError extends Error {}

const tableExists = async (db, qualified) => {
  const result = await db.raw("SELECT to_regclass(?) AS reg", [qualified]);
  return Boolean(result?.rows?.[0]?.reg);
};

const pad = (value, width) => String(value ?? "").padEnd(width, " ");
const padStart = (value, width) => String(value ?? "").padStart(width, " ");

// Leading letter of the article code, uppercased. Null when the code starts with
// a digit or a symbol -- those articles have no letter family and are skipped.
const letterOf = (code) => {
  const first = String(code || "").trim().charAt(0);
  if (!first) return null;
  const upper = first.toUpperCase();
  return upper >= "A" && upper <= "Z" ? upper : null;
};

// -----------------------------------------------------------------------------
// BOM number. Mirrors nextBomNo in bom/service.js (max(id) + 1, zero padded) but
// skips numbers already taken, because this script mints several in one go and a
// hand-entered bom_no would otherwise collide on the UNIQUE index.
// -----------------------------------------------------------------------------
let bomNoLockTaken = false;
const nextBomNo = async (trx) => {
  if (!bomNoLockTaken) {
    await trx.raw("LOCK TABLE erp.bom_header IN SHARE ROW EXCLUSIVE MODE");
    bomNoLockTaken = true;
  }
  const row = await trx("erp.bom_header").max("id as max").first();
  let next = Number(row?.max || 0) + 1;
  // Bounded so a pathological numbering scheme cannot spin forever.
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const candidate = `BOM-${String(next).padStart(6, "0")}`;
    const clash = await trx("erp.bom_header")
      .select("id")
      .where({ bom_no: candidate })
      .first();
    if (!clash) return candidate;
    next += 1;
  }
  throw new AbortError("Could not find a free bom_no after 10000 attempts.");
};

// The target article must be able to express the template's output UOM, or the
// batch size silently changes meaning (12 DOZEN vs 12 PAIR). Same rule the BOM
// form applies in validateAndNormalizeInput.
const outputUomUsable = async (trx, { outputUomId, baseUomId }) => {
  const out = toPositiveInt(outputUomId);
  const base = toPositiveInt(baseUomId);
  if (!out || !base) return false;
  if (out === base) return true;
  if (!(await tableExists(trx, "erp.uom_conversions"))) return false;
  const row = await trx("erp.uom_conversions")
    .select("from_uom_id")
    .where({ from_uom_id: out, to_uom_id: base, is_active: true })
    .first();
  return Boolean(row);
};

const loadLineCounts = async (trx, bomIds) => {
  const per = new Map(bomIds.map((id) => [id, {}]));
  const totals = new Map(bomIds.map((id) => [id, 0]));
  if (!bomIds.length) return { per, totals };
  for (const section of SECTIONS) {
    const table = SECTION_TABLE[section];
    if (!(await tableExists(trx, table))) continue;
    const rows = await trx(table)
      .select("bom_id")
      .count({ n: "*" })
      .whereIn("bom_id", bomIds)
      .groupBy("bom_id");
    (rows || []).forEach((row) => {
      const id = Number(row.bom_id);
      const n = Number(row.n) || 0;
      if (!per.has(id)) return;
      per.get(id)[section] = n;
      totals.set(id, (totals.get(id) || 0) + n);
    });
  }
  return { per, totals };
};

const resolveActor = async (trx) => {
  if (!CREATED_BY) {
    // Required for the dry run too, so the rehearsal exercises exactly the same
    // insert and the same "is this draft mine?" ownership check as --apply.
    throw new AbortError(
      "--created-by=N is required: erp.bom_header.created_by is NOT NULL. " +
        "Pick an active user who will NOT approve these drafts (a BOM cannot be " +
        "approved by its own maker).",
    );
  }
  // erp.users has no is_active flag; login control is the free-text `status`
  // column, default 'Active'.
  const user = await trx("erp.users")
    .select("id", "username", "status")
    .where({ id: CREATED_BY })
    .first();
  if (!user) {
    throw new AbortError(`--created-by=${CREATED_BY}: no erp.users row with that id.`);
  }
  if (String(user.status || "").trim().toLowerCase() !== "active") {
    throw new AbortError(
      `--created-by=${CREATED_BY} (${user.username}) has status "${user.status}". Pick an active user.`,
    );
  }
  return user;
};

// -----------------------------------------------------------------------------
// Group the FG articles by leading letter and pick a template per group.
// -----------------------------------------------------------------------------
const buildGroups = async (trx) => {
  const lifecycleSupported = await trx.schema
    .withSchema("erp")
    .hasColumn("bom_header", "is_active")
    .catch(() => false);

  let itemQuery = trx("erp.items")
    .select("id", "code", "name", "item_type", "is_active", "sfg_part_type")
    .where("item_type", "FG")
    .orderBy("code", "asc");
  if (!INCLUDE_INACTIVE_ITEMS) itemQuery = itemQuery.andWhere("is_active", true);
  const items = await itemQuery;

  const noLetter = [];
  const groups = new Map();
  items.forEach((item) => {
    const letter = letterOf(item.code);
    if (!letter) {
      noLetter.push(item);
      return;
    }
    if (ONLY_LETTERS.size && !ONLY_LETTERS.has(letter)) return;
    if (!groups.has(letter)) groups.set(letter, { letter, items: [] });
    groups.get(letter).items.push(item);
  });

  const itemIds = [...groups.values()].flatMap((g) => g.items.map((i) => i.id));
  if (!itemIds.length) return { groups, noLetter };

  // Every FINISHED BOM of every grouped article, so we can both pick templates
  // (approved only) and tell which targets already have a BOM / a draft.
  let bomQuery = trx("erp.bom_header as bh")
    .select(
      "bh.id",
      "bh.bom_no",
      "bh.item_id",
      "bh.status",
      "bh.version_no",
      "bh.output_qty",
      "bh.output_uom_id",
      "bh.created_by",
      "bh.approved_at",
    )
    .where("bh.level", LEVEL)
    .whereIn("bh.item_id", itemIds)
    .orderBy([
      { column: "bh.item_id", order: "asc" },
      { column: "bh.version_no", order: "desc" },
    ]);
  if (lifecycleSupported) bomQuery = bomQuery.select("bh.is_active");
  const boms = await bomQuery;
  boms.forEach((bom) => {
    if (!lifecycleSupported) bom.is_active = true;
  });

  const bomsByItem = new Map();
  boms.forEach((bom) => {
    const itemId = Number(bom.item_id);
    if (!bomsByItem.has(itemId)) bomsByItem.set(itemId, []);
    bomsByItem.get(itemId).push(bom);
  });

  const approvedBoms = boms.filter(
    (bom) => bom.status === "APPROVED" && bom.is_active !== false,
  );
  const { per, totals } = await loadLineCounts(
    trx,
    approvedBoms.map((bom) => Number(bom.id)),
  );

  groups.forEach((group) => {
    group.boms = bomsByItem;
    // Latest approved version per article, then the most complete of those.
    const latestPerItem = new Map();
    group.items.forEach((item) => {
      const candidates = (bomsByItem.get(Number(item.id)) || []).filter(
        (bom) => bom.status === "APPROVED" && bom.is_active !== false,
      );
      if (!candidates.length) return;
      // Already ordered version_no DESC.
      latestPerItem.set(Number(item.id), candidates[0]);
    });
    group.candidates = [...latestPerItem.values()].map((bom) => ({
      ...bom,
      lineCounts: per.get(Number(bom.id)) || {},
      lineTotal: totals.get(Number(bom.id)) || 0,
    }));

    const override = TEMPLATE_OVERRIDES.get(group.letter);
    if (override) {
      const wanted = group.items.find(
        (item) => String(item.code || "").toLowerCase() === override,
      );
      group.templateOverrideCode = override;
      group.template = wanted
        ? group.candidates.find(
            (bom) => Number(bom.item_id) === Number(wanted.id),
          ) || null
        : null;
      if (!group.template) group.templateOverrideFailed = true;
      return;
    }

    group.template =
      [...group.candidates].sort((a, b) => {
        if (b.lineTotal !== a.lineTotal) return b.lineTotal - a.lineTotal;
        const aAt = a.approved_at ? new Date(a.approved_at).getTime() : 0;
        const bAt = b.approved_at ? new Date(b.approved_at).getTime() : 0;
        if (bAt !== aAt) return bAt - aAt;
        return Number(b.version_no || 0) - Number(a.version_no || 0);
      })[0] || null;
  });

  return { groups, noLetter, lifecycleSupported };
};

// -----------------------------------------------------------------------------
// Write one draft.
// -----------------------------------------------------------------------------
const writeDraft = async (
  trx,
  { targetItem, template, payload, existingDraft, actorId, copiedFromSupported, lifecycleSupported },
) => {
  let bomId = existingDraft ? Number(existingDraft.id) : null;
  let versionNo = existingDraft ? Number(existingDraft.version_no || 1) : 1;
  let bomNo = existingDraft ? existingDraft.bom_no : null;
  const before = bomId ? await bomService.getBomSnapshot(trx, bomId) : null;

  if (!bomId) {
    const maxVersionRow = await trx("erp.bom_header")
      .where({ item_id: targetItem.id, level: LEVEL })
      .max("version_no as max")
      .first();
    versionNo = Number(maxVersionRow?.max || 0) + 1;
    bomNo = await nextBomNo(trx);
    const insertPayload = {
      bom_no: bomNo,
      item_id: targetItem.id,
      level: LEVEL,
      output_qty: template.output_qty,
      output_uom_id: template.output_uom_id,
      status: "DRAFT",
      version_no: versionNo,
      created_by: actorId,
    };
    if (lifecycleSupported) insertPayload.is_active = true;
    if (copiedFromSupported) insertPayload.copied_from_bom_id = Number(template.id);
    const inserted = await trx("erp.bom_header")
      .insert(insertPayload)
      .returning(["id", "version_no", "bom_no"]);
    const row = inserted?.[0] || inserted;
    bomId = Number(row?.id || row);
    versionNo = Number(row?.version_no || versionNo);
    bomNo = row?.bom_no || bomNo;
  } else {
    const updatePayload = {
      output_qty: template.output_qty,
      output_uom_id: template.output_uom_id,
    };
    if (copiedFromSupported) updatePayload.copied_from_bom_id = Number(template.id);
    await trx("erp.bom_header").where({ id: bomId }).update(updatePayload);
  }

  // replaceBomLines deletes EVERY section before re-inserting, so anything this
  // run is not copying has to be handed back to it or it is silently dropped.
  // That means labour (never copied from a template) and, when --sections
  // narrows the run, every section left out of it. On a fresh draft `before` is
  // null and these all collapse to empty.
  const keep = (section, snapshotKey) =>
    SECTIONS.includes(section)
      ? payload.lines[SECTION_REPORT_KEY[section]] || []
      : before?.[snapshotKey] || [];

  await bomService.replaceBomLines(trx, bomId, {
    rm_lines: keep("rm", "rm_lines"),
    sfg_lines: keep("sfg", "sfg_lines"),
    labour_lines: before?.labour_lines || [],
    stage_routes: keep("stage_routes", "stage_routes"),
    variant_rules: [],
    sku_overrides: keep("sku_overrides", "sku_overrides"),
  });

  const after = await bomService.getBomSnapshot(trx, bomId);
  await insertBomChangeLog(trx, {
    bomId,
    versionNo,
    requestId: null,
    changedBy: actorId,
    before,
    after,
  });

  return { bomId, bomNo, versionNo, reused: Boolean(existingDraft) };
};

// -----------------------------------------------------------------------------
const run = async () => {
  console.log(`${TAG} mode: ${APPLY ? "APPLY (writes committed)" : "DRY RUN (rolled back)"}`);
  console.log(`${TAG} sections: ${SECTIONS.join(", ")}`);
  if (ONLY_LETTERS.size) console.log(`${TAG} letters: ${[...ONLY_LETTERS].join(", ")}`);
  if (ONLY_TARGET_CODES.size)
    console.log(`${TAG} targets: ${[...ONLY_TARGET_CODES].join(", ")}`);
  if (ONLY_MISSING) console.log(`${TAG} --only-missing: articles with no FINISHED BOM only`);
  if (OVERWRITE_DRAFTS) console.log(`${TAG} --overwrite-drafts: existing drafts by the actor are rewritten`);
  if (LIMIT) console.log(`${TAG} --limit: stop after ${LIMIT} draft(s)`);

  const summary = {
    groups: 0,
    groupsSkipped: 0,
    created: 0,
    rewritten: 0,
    skipped: 0,
    linesCopied: 0,
    linesSkipped: 0,
    ready: 0,
    needsFix: 0,
  };
  const skipTally = new Map();
  const bumpSkip = (reason) =>
    skipTally.set(reason, (skipTally.get(reason) || 0) + 1);
  const validationTally = new Map();

  await knex
    .transaction(async (trx) => {
      // Role-level defaults can be tight; a bulk run needs more headroom.
      await trx.raw("SET LOCAL statement_timeout = '120s'");
      await trx.raw("SET LOCAL idle_in_transaction_session_timeout = '300s'");

      const actor = await resolveActor(trx);
      const actorId = actor ? Number(actor.id) : null;
      if (actor) console.log(`${TAG} drafts created as user ${actor.id} (${actor.username})`);

      const copiedFromSupported = await bomService.hasBomCopiedFromColumn(trx);
      const { groups, noLetter, lifecycleSupported } = await buildGroups(trx);

      if (noLetter.length) {
        console.log(
          `\n${TAG} ${noLetter.length} FG article(s) have no leading letter and are skipped: ` +
            noLetter.map((i) => i.code).join(", "),
        );
      }

      const letters = [...groups.keys()].sort();
      if (!letters.length) throw new AbortError("No FG article groups matched.");

      for (const letter of letters) {
        const group = groups.get(letter);
        const template = group.template;

        console.log(`\n${TAG} ===== ${letter} =====  ${group.items.length} article(s)`);

        if (group.templateOverrideFailed) {
          console.log(
            `  REVIEW  --template=${letter}:${group.templateOverrideCode} names an article ` +
              `with no active approved FINISHED BOM in this group. Group skipped.`,
          );
          summary.groupsSkipped += 1;
          bumpSkip("template_override_not_found");
          continue;
        }
        if (!template) {
          console.log(
            `  REVIEW  no approved FINISHED BOM in this group -- nothing to copy from. ` +
              `Articles: ${group.items.map((i) => i.code).join(", ")}`,
          );
          summary.groupsSkipped += 1;
          bumpSkip("group_has_no_approved_bom");
          continue;
        }

        const templateItem = group.items.find(
          (i) => Number(i.id) === Number(template.item_id),
        );
        const counts = SECTIONS.map(
          (s) => `${SECTION_LABEL[s]} ${template.lineCounts?.[s] || 0}`,
        ).join("  ");
        console.log(
          `  template: ${templateItem?.code} "${templateItem?.name}" ` +
            `${template.bom_no} v${template.version_no}  (${counts})`,
        );

        const targets = group.items
          .filter((item) => Number(item.id) !== Number(template.item_id))
          .filter(
            (item) =>
              !ONLY_TARGET_CODES.size ||
              ONLY_TARGET_CODES.has(String(item.code || "").toLowerCase()),
          );

        if (!targets.length) {
          console.log("  (no other article in this group)");
          continue;
        }

        summary.groups += 1;

        for (const targetItem of targets) {
          if (LIMIT && summary.created + summary.rewritten >= LIMIT) {
            console.log(`  ${pad(targetItem.code, 16)} SKIP  limit reached`);
            summary.skipped += 1;
            bumpSkip("limit_reached");
            continue;
          }

          const existingBoms = (group.boms.get(Number(targetItem.id)) || []).filter(
            (bom) => bom.is_active !== false,
          );
          const drafts = existingBoms.filter((bom) => bom.status === "DRAFT");
          const label = pad(targetItem.code, 16);

          if (ONLY_MISSING && existingBoms.length) {
            console.log(`  ${label} SKIP  --only-missing, already has ${existingBoms.length} BOM(s)`);
            summary.skipped += 1;
            bumpSkip("only_missing_has_bom");
            continue;
          }

          let existingDraft = null;
          if (drafts.length) {
            const mine = drafts.find(
              (bom) => actorId && Number(bom.created_by) === actorId,
            );
            if (OVERWRITE_DRAFTS && mine) {
              existingDraft = mine;
            } else {
              console.log(
                `  ${label} SKIP  draft exists (${drafts
                  .map((d) => `${d.bom_no} by user ${d.created_by}`)
                  .join(", ")})` +
                  (OVERWRITE_DRAFTS ? " -- not created by --created-by" : ""),
              );
              summary.skipped += 1;
              bumpSkip("draft_exists");
              continue;
            }
          }

          const pending = await bomService.hasPendingApprovalForBomTargetTx(trx, {
            itemId: Number(targetItem.id),
          });
          if (pending) {
            console.log(`  ${label} SKIP  a BOM approval request is PENDING for this article`);
            summary.skipped += 1;
            bumpSkip("pending_approval");
            continue;
          }

          const baseUomRow = await trx("erp.items")
            .select("base_uom_id")
            .where({ id: targetItem.id })
            .first();
          const uomOk = await outputUomUsable(trx, {
            outputUomId: template.output_uom_id,
            baseUomId: baseUomRow?.base_uom_id,
          });
          if (!uomOk) {
            console.log(
              `  ${label} SKIP  cannot use the template's output UOM ` +
                `(uom ${template.output_uom_id} -> base ${baseUomRow?.base_uom_id}, no active conversion)`,
            );
            summary.skipped += 1;
            bumpSkip("output_uom_unconvertible");
            continue;
          }

          let payload = null;
          try {
            payload = await bomCopyService.buildCopyPayload(trx, {
              sourceBomId: Number(template.id),
              targetItemId: Number(targetItem.id),
              targetLevel: LEVEL,
              sections: SECTIONS.join(","),
              t,
              locale: "en",
            });
          } catch (err) {
            console.log(`  ${label} SKIP  ${err?.message || err}`);
            summary.skipped += 1;
            bumpSkip("copy_payload_failed");
            continue;
          }

          const copiedTotal = SECTIONS.reduce(
            (sum, s) => sum + (payload.lines[SECTION_REPORT_KEY[s]]?.length || 0),
            0,
          );
          if (!copiedTotal) {
            console.log(
              `  ${label} SKIP  nothing mapped onto this article (no matching SKUs / sizes)`,
            );
            summary.skipped += 1;
            bumpSkip("nothing_to_copy");
            continue;
          }

          const written = await writeDraft(trx, {
            targetItem,
            template,
            payload,
            existingDraft,
            actorId,
            copiedFromSupported,
            lifecycleSupported,
          });

          const detail = SECTIONS.map((s) => {
            const rep = payload.report[SECTION_REPORT_KEY[s]] || { total: 0, copied: 0 };
            return `${SECTION_LABEL[s]} ${padStart(rep.copied, 3)}/${pad(rep.total, 3)}`;
          }).join(" ");
          // A draft nobody can submit is not a delivered BOM. Send-for-approval
          // enforces rules a DRAFT save does not (notably: an RM line must name
          // a colour/size when that raw material has colour/size variants), and
          // the copy inherits the template's shape -- so a template approved
          // before those rules tightened breeds drafts that all fail the same
          // way. Check now, in the dry run, rather than at approval time.
          let readiness = "";
          let pendingValidationNotes = [];
          if (VALIDATE) {
            try {
              await bomService.validateDraftReadyForApproval(trx, {
                bomId: written.bomId,
                t,
                intent: "send",
              });
              summary.ready += 1;
              readiness = "  READY";
            } catch (err) {
              summary.needsFix += 1;
              const issues = (err?.details || [])
                .map((d) => d.message)
                .filter(Boolean);
              readiness = `  NEEDS FIX (${issues.length || 1})`;
              const show = VERBOSE ? issues : issues.slice(0, 3);
              show.forEach((message) => {
                validationTally.set(message, (validationTally.get(message) || 0) + 1);
              });
              pendingValidationNotes = show.length
                ? show
                : [err?.message || String(err)];
            }
          }

          console.log(
            `  ${label} ${written.reused ? "REWRITE" : "DRAFT  "} ${written.bomNo} v${written.versionNo}  ${detail}${readiness}`,
          );
          pendingValidationNotes.forEach((message) =>
            console.log(`      ! ${message}`),
          );
          pendingValidationNotes = [];

          SECTIONS.forEach((s) => {
            const rep = payload.report[SECTION_REPORT_KEY[s]];
            if (!rep) return;
            summary.linesCopied += rep.copied;
            summary.linesSkipped += rep.skipped.length;
            const show = VERBOSE ? rep.skipped : rep.skipped.slice(0, 3);
            show.forEach((entry) => console.log(`      - ${SECTION_LABEL[s]}: ${entry.label}`));
            if (!VERBOSE && rep.skipped.length > show.length) {
              console.log(
                `      - ${SECTION_LABEL[s]}: ... ${rep.skipped.length - show.length} more (--verbose)`,
              );
            }
          });

          if (written.reused) summary.rewritten += 1;
          else summary.created += 1;
        }
      }

      console.log(`\n${TAG} ---------------- summary ----------------`);
      console.log(`${TAG} groups processed      : ${summary.groups}`);
      console.log(`${TAG} groups skipped        : ${summary.groupsSkipped}`);
      console.log(`${TAG} drafts created        : ${summary.created}`);
      console.log(`${TAG} drafts rewritten      : ${summary.rewritten}`);
      console.log(`${TAG} articles skipped      : ${summary.skipped}`);
      console.log(`${TAG} lines copied          : ${summary.linesCopied}`);
      console.log(`${TAG} lines not mapped      : ${summary.linesSkipped}`);
      if (VALIDATE) {
        console.log(`${TAG} ready to send        : ${summary.ready}`);
        console.log(`${TAG} need a manual fix    : ${summary.needsFix}`);
      }
      if (skipTally.size) {
        console.log(`${TAG} skip reasons:`);
        [...skipTally.entries()]
          .sort((a, b) => b[1] - a[1])
          .forEach(([reason, n]) => console.log(`${TAG}   ${pad(reason, 30)} ${n}`));
      }
      if (validationTally.size) {
        console.log(
          `${TAG} approval blockers (these drafts save fine, but cannot be sent for approval as-is):`,
        );
        [...validationTally.entries()]
          .sort((a, b) => b[1] - a[1])
          .forEach(([message, n]) => console.log(`${TAG}   x${padStart(n, 4)}  ${message}`));
      }

      if (!APPLY) throw ROLLBACK;
    })
    .catch((err) => {
      if (err === ROLLBACK) {
        console.log(`\n${TAG} DRY RUN -- transaction rolled back, nothing was written.`);
        console.log(`${TAG} Re-run with --apply --created-by=N to commit.`);
        return;
      }
      throw err;
    });
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    if (err instanceof AbortError) console.error(`${TAG} ABORT: ${err.message}`);
    else console.error(`${TAG} FAILED:`, err);
    await knex.destroy();
    process.exit(1);
  });
