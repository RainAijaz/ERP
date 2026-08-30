// Read-only diagnostic: explains why a department still holds work-in-process pairs after
// later stages have run. It writes nothing.
//
// The pool (erp.wip_dept_balance) is per SKU per department. A department challan voucher
// CREDITS the department it is posted to, and DEBITS the previous stage's department -- but the
// debit only happens when resolveDcvStageTransitionForBomProfile finds a "previous required"
// route, and it only ever debits as many pairs as the later stage actually OUTPUT. That leaves
// four distinct reasons for a stage-1 balance to sit there, and they are easy to confuse:
//
//   1. NORMAL. Stage 1 produced more than stage 2 consumed. The remainder is genuine
//      work-in-progress waiting at that stage -- nothing is wrong.
//   2. NO APPROVED BOM, or an approved BOM with NO stage routing rows. hasStageRouting is then
//      false, so every stage only ever credits its own department and nothing is ever debited.
//      Every department accrues forever.
//   3. ORPHANED DEPARTMENT. The balance sits at a department that is not in this SKU's routing
//      at all (usually because the routing was edited after the pairs were booked). No stage
//      names it as a predecessor, so nothing will ever drain it.
//   4. SKIPPED PREDECESSOR. The route immediately before a stage has enforce_sequence = false,
//      so the drain skips back past it to an earlier stage. The skipped stage accrues and the
//      earlier one is drained twice.
//
// Usage (from backend/):
//   node src/scripts/diagnose-wip-stage-balance.js --article="UPPER 11/1"
//   node src/scripts/diagnose-wip-stage-balance.js --sku-id=117
//   node src/scripts/diagnose-wip-stage-balance.js --article="UPPER" --branch-id=3 --ledger

require("dotenv").config();
const knex = require("../db/knex");
const { toLocalDateOnly } = require("../utils/date-only");

const readArg = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const toInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const loadTargets = async ({ article, skuId }) => {
  let query = knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select(
      "s.id as sku_id",
      "s.sku_code",
      "i.id as item_id",
      "i.name as article",
      "i.item_type",
    )
    .orderBy("s.id");

  if (skuId) return query.where("s.id", skuId);
  if (article) return query.whereRaw("i.name ilike ?", [`%${article}%`]);
  // No filter given: only report SKUs that actually hold pool stock, so the output stays useful.
  return query.whereIn(
    "s.id",
    knex("erp.wip_dept_balance").distinct("sku_id").where("qty_pairs", ">", 0),
  );
};

const run = async () => {
  const article = readArg("article");
  const skuId = toInt(readArg("sku-id"));
  const branchId = toInt(readArg("branch-id"));
  const showLedger = hasFlag("ledger");

  const targets = await loadTargets({ article, skuId });
  if (!targets.length) {
    console.log("No SKU matched.");
    return;
  }

  for (const target of targets) {
    console.log(
      `\n=== ${target.sku_code}  (sku ${target.sku_id})  ${target.article}  [${target.item_type}] ===`,
    );

    const bom = await knex("erp.bom_header")
      .select("id", "version_no")
      .where({ item_id: target.item_id, status: "APPROVED" })
      .orderBy("version_no", "desc")
      .first();

    const routes = bom
      ? await knex("erp.bom_stage_routing as bsr")
          .join("erp.production_stages as ps", "ps.id", "bsr.stage_id")
          .select(
            "bsr.sequence_no",
            "ps.name as stage",
            "ps.dept_id",
            "bsr.is_required",
            "bsr.enforce_sequence",
          )
          .where({ "bsr.bom_id": bom.id })
          .orderBy("bsr.sequence_no")
      : [];

    if (!bom) {
      console.log("  BOM: none approved  -> CAUSE 2: nothing ever drains any department");
    } else if (!routes.length) {
      console.log(
        `  BOM ${bom.id} v${bom.version_no}: no stage routing rows  -> CAUSE 2: nothing ever drains any department`,
      );
    } else {
      console.log(`  BOM ${bom.id} v${bom.version_no} routing:`);
      routes.forEach((route) => {
        const flags = [];
        if (route.is_required === false) flags.push("NOT REQUIRED");
        if (route.enforce_sequence === false) flags.push("SEQUENCE NOT ENFORCED");
        console.log(
          `    seq ${route.sequence_no}  ${route.stage}  (dept ${route.dept_id})` +
            (flags.length ? `  [${flags.join(", ")}]` : ""),
        );
      });
    }

    // Which department each stage actually debits. Mirrors the resolver: the nearest earlier
    // route that is BOTH required AND sequence-enforced.
    const drains = new Map();
    routes.forEach((route) => {
      const previous = [...routes]
        .filter(
          (candidate) =>
            candidate.is_required !== false &&
            candidate.enforce_sequence !== false &&
            Number(candidate.sequence_no) < Number(route.sequence_no),
        )
        .sort((a, b) => Number(b.sequence_no) - Number(a.sequence_no))[0];
      if (previous) drains.set(Number(previous.dept_id), route.stage);
    });

    let balanceQuery = knex("erp.wip_dept_balance as wb")
      .join("erp.departments as d", "d.id", "wb.dept_id")
      .select(
        "wb.branch_id",
        "wb.dept_id",
        "d.name as dept",
        "wb.stock_state",
        "wb.qty_pairs",
        "wb.cost_value",
      )
      .where("wb.sku_id", target.sku_id)
      .andWhere("wb.qty_pairs", "!=", 0)
      .orderBy(["wb.branch_id", "wb.dept_id"]);
    if (branchId) balanceQuery = balanceQuery.where("wb.branch_id", branchId);
    const balances = await balanceQuery;

    console.log("  Pool balances:");
    if (!balances.length) console.log("    (none)");
    balances.forEach((row) => {
      const inRouting = routes.some(
        (route) => Number(route.dept_id) === Number(row.dept_id),
      );
      const drainedBy = drains.get(Number(row.dept_id));
      let verdict;
      if (!routes.length) {
        verdict = "CAUSE 2 - no routing, never drains";
      } else if (!inRouting) {
        verdict = "CAUSE 3 - department is not in this SKU's routing, never drains";
      } else if (!drainedBy) {
        verdict =
          "final stage or never a predecessor - drains only when it posts to stock";
      } else {
        verdict = `drained by ${drainedBy}, so this is CAUSE 1: output not yet passed on`;
      }
      console.log(
        `    branch ${row.branch_id}  ${row.dept}  ${row.stock_state}  ` +
          `${row.qty_pairs} pairs, value ${row.cost_value}  -> ${verdict}`,
      );
    });

    // A stage whose own predecessor is skipped accrues silently; call it out even when its
    // balance is currently zero, because it will grow with the next voucher.
    routes.forEach((route, index) => {
      if (index === 0) return;
      const immediate = routes[index - 1];
      if (
        immediate.is_required === false ||
        immediate.enforce_sequence === false
      ) {
        console.log(
          `  WARNING  CAUSE 4: ${route.stage} skips past ${immediate.stage} when it drains, ` +
            `so ${immediate.stage} accrues and the stage before it is drained twice.`,
        );
      }
    });

    if (showLedger) {
      let ledgerQuery = knex("erp.wip_dept_ledger as wl")
        .join("erp.departments as d", "d.id", "wl.dept_id")
        .leftJoin("erp.voucher_header as vh", "vh.id", "wl.source_voucher_id")
        .select(
          "wl.txn_date",
          "d.name as dept",
          "wl.stock_state",
          "wl.direction",
          "wl.qty_pairs",
          "vh.voucher_type_code",
          "vh.voucher_no",
        )
        .where("wl.sku_id", target.sku_id)
        .orderBy(["wl.txn_date", "wl.id"]);
      if (branchId) ledgerQuery = ledgerQuery.where("wl.branch_id", branchId);
      const ledger = await ledgerQuery;
      console.log("  Ledger:");
      if (!ledger.length) console.log("    (none)");
      ledger.forEach((row) => {
        const sign = Number(row.direction) < 0 ? "-" : "+";
        console.log(
          `    ${toLocalDateOnly(row.txn_date)}  ${row.dept}  ${row.stock_state}  ` +
            `${sign}${row.qty_pairs}  ${row.voucher_type_code || "?"} #${row.voucher_no || "?"}`,
        );
      });
    }
  }
};

run()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
