/**
 * Regression suite for labour rate resolution (Add Labour Rates -> Affected SKUs).
 *
 * Guards the rule that `apply_on` is NOT a row's real scope: the bulk save writes
 * one row PER ARTICLE and stamps it with the scope the user picked in the modal
 * (GROUP/SUBGROUP) while still setting `sku_id`. A reader that matches on
 * `apply_on` alone never finds an article's own rule, falls through to the broad
 * branch, and hands every article in the group the same arbitrary sibling rate.
 *
 * Everything runs inside a transaction that is always rolled back, so this is
 * safe against a populated database.
 *
 * Usage: npm run test:labour-rates
 */
require("dotenv").config({ quiet: true });
const knex = require("../db/knex");
const {
  buildBulkPreviewRows,
} = require("../services/hr-payroll/labour-rates-service");

const ROLLBACK = "__ROLLBACK__";
let passed = 0;
let failed = 0;

const check = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    console.log(`  OK   ${name}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${name}`);
  console.log(`       expected ${JSON.stringify(expected)}`);
  console.log(`       actual   ${JSON.stringify(actual)}`);
};

const skip = (name) => console.log(`  SKIP ${name}`);

const pickFixture = async (trx) => {
  const group = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("i.group_id")
    .count("* as n")
    .where("i.item_type", "SFG")
    .whereNotNull("i.group_id")
    .groupBy("i.group_id")
    .orderBy("n", "desc")
    .first();
  if (!group) return null;

  const skus = await trx("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id", "s.sku_code", "i.subgroup_id", "i.group_id")
    .where("i.group_id", group.group_id)
    .where("i.item_type", "SFG")
    .orderBy("s.sku_code")
    .limit(6);
  if (skus.length < 4) return null;

  const labourDept = await trx("erp.labour_department as ld")
    .join("erp.labours as l", "l.id", "ld.labour_id")
    .select("ld.labour_id", "ld.dept_id")
    .first();
  if (!labourDept) return null;

  return {
    groupId: Number(group.group_id),
    // pg returns bigint as string; the service compares numerically.
    skus: skus.map((sku) => ({
      id: Number(sku.id),
      sku_code: String(sku.sku_code || ""),
      subgroup_id: Number(sku.subgroup_id || 0) || null,
    })),
    labourId: Number(labourDept.labour_id),
    deptId: Number(labourDept.dept_id),
  };
};

const run = async (trx) => {
  const fixture = await pickFixture(trx);
  if (!fixture) {
    console.log("SKIP: database has no SFG group with >= 4 skus and a labour.");
    return;
  }
  const { groupId, skus, labourId, deptId } = fixture;
  const [articleA, articleB, articleC, articleD] = skus;
  console.log(
    `fixture: group ${groupId}, ${skus.length} SFG skus, labour ${labourId}, dept ${deptId}`,
  );

  // Clean slate for this labour/dept inside the rolled-back transaction.
  await trx("erp.labour_rate_rules")
    .where({ labour_id: labourId, dept_id: deptId })
    .del();

  const insertRule = async (row) =>
    Number(
      (
        await trx("erp.labour_rate_rules")
          .insert({
            labour_id: labourId,
            dept_id: deptId,
            applies_to_all_labours: false,
            rate_type: "PER_DOZEN",
            status: "active",
            ...row,
          })
          .returning("id")
      )[0].id,
    );

  // The shape the modal actually writes: per-article rows stamped apply_on=GROUP.
  const ruleA = await insertRule({
    apply_on: "GROUP",
    sku_id: articleA.id,
    group_id: groupId,
    rate_value: 96,
  });
  const ruleB = await insertRule({
    apply_on: "GROUP",
    sku_id: articleB.id,
    group_id: groupId,
    rate_value: 600,
  });
  // A legacy per-article row stamped apply_on=SKU.
  await insertRule({ apply_on: "SKU", sku_id: articleC.id, rate_value: 11 });
  // A genuine group-wide row (no article pinned) - the only legitimate fallback.
  let ruleGroupWide = await insertRule({
    apply_on: "GROUP",
    sku_id: null,
    group_id: groupId,
    rate_value: 20,
  });

  const preview = async (labourIds = [labourId], baseRate = null) => {
    const rows = await buildBulkPreviewRows({
      db: trx,
      labourIds,
      deptId,
      applyOn: "GROUP",
      groupIds: [groupId],
      articleType: "SFG",
      rateType: "PER_DOZEN",
      baseRate,
    });
    return new Map(rows.map((row) => [Number(row.sku_id), row]));
  };

  console.log("\n[1] a per-article rate wins over the group-wide rule");
  let rows = await preview();
  check(
    "article A shows its own 96",
    [
      rows.get(articleA.id).previous_rate,
      rows.get(articleA.id).previous_source,
      rows.get(articleA.id).previous_rule_id,
    ],
    [96, "SKU", ruleA],
  );
  check(
    "article B shows its own 600, not article A's rate",
    [
      rows.get(articleB.id).previous_rate,
      rows.get(articleB.id).previous_source,
      rows.get(articleB.id).previous_rule_id,
    ],
    [600, "SKU", ruleB],
  );
  check(
    "a legacy apply_on=SKU row still resolves",
    [
      rows.get(articleC.id).previous_rate,
      rows.get(articleC.id).previous_source,
    ],
    [11, "SKU"],
  );
  check(
    "article D (no rule of its own) falls back to the group-wide 20",
    [
      rows.get(articleD.id).previous_rate,
      rows.get(articleD.id).previous_source,
      rows.get(articleD.id).previous_rule_id,
    ],
    [20, "GROUP", ruleGroupWide],
  );
  check(
    "the stored rate type is reported",
    rows.get(articleA.id).previous_rate_type,
    "PER_DOZEN",
  );

  console.log("\n[2] with no group-wide rule, unruled articles show nothing");
  await trx("erp.labour_rate_rules").where({ id: ruleGroupWide }).del();
  rows = await preview();
  check("article A is unchanged", rows.get(articleA.id).previous_rate, 96);
  check(
    "article D now has no previous rate",
    [
      rows.get(articleD.id).previous_rate,
      rows.get(articleD.id).previous_source,
    ],
    [null, null],
  );

  console.log("\n[3] subgroup-wide beats group-wide; per-article beats both");
  ruleGroupWide = await insertRule({
    apply_on: "GROUP",
    sku_id: null,
    group_id: groupId,
    rate_value: 20,
  });
  const ruleSubgroupWide = articleD.subgroup_id
    ? await insertRule({
        apply_on: "SUBGROUP",
        sku_id: null,
        subgroup_id: articleD.subgroup_id,
        rate_value: 77,
      })
    : null;
  rows = await preview();
  if (ruleSubgroupWide) {
    check(
      "article D takes the subgroup 77 over the group 20",
      [
        rows.get(articleD.id).previous_rate,
        rows.get(articleD.id).previous_source,
      ],
      [77, "SUBGROUP"],
    );
  } else {
    skip("subgroup precedence (article D has no subgroup)");
  }
  check("article A still takes its own 96", rows.get(articleA.id).previous_rate, 96);

  console.log("\n[4] a sku-pinned SUBGROUP row never leaks onto its siblings");
  if (ruleSubgroupWide) {
    await trx("erp.labour_rate_rules").where({ id: ruleSubgroupWide }).del();
  }
  await insertRule({
    apply_on: "SUBGROUP",
    sku_id: articleD.id,
    subgroup_id: articleD.subgroup_id,
    rate_value: 555,
  });
  const siblings = skus.filter(
    (sku) =>
      sku.id !== articleD.id &&
      Number(sku.subgroup_id || 0) === Number(articleD.subgroup_id || 0),
  );
  rows = await preview();
  check(
    "article D shows its own 555",
    [
      rows.get(articleD.id).previous_rate,
      rows.get(articleD.id).previous_source,
    ],
    [555, "SKU"],
  );
  if (siblings.length) {
    check(
      `sibling ${siblings[0].sku_code} does NOT inherit 555`,
      rows.get(siblings[0].id).previous_rate === 555,
      false,
    );
  } else {
    skip("sibling leak (no sibling shares article D's subgroup)");
  }

  console.log("\n[5] status matching tolerates casing/padding, skips inactive");
  await trx("erp.labour_rate_rules")
    .where({ id: ruleA })
    .update({ status: " ACTIVE " });
  await trx("erp.labour_rate_rules")
    .where({ id: ruleB })
    .update({ status: "inactive" });
  rows = await preview();
  check(
    "a rule stored as ' ACTIVE ' is still found",
    rows.get(articleA.id).previous_rate,
    96,
  );
  check(
    "an inactive rule is ignored (falls back to the group 20)",
    [
      rows.get(articleB.id).previous_rate,
      rows.get(articleB.id).previous_source,
    ],
    [20, "GROUP"],
  );

  console.log("\n[6] a multi-labour selection reports no previous rate");
  const otherLabour = await trx("erp.labours")
    .select("id")
    .whereNot("id", labourId)
    .first();
  if (otherLabour) {
    const multi = await buildBulkPreviewRows({
      db: trx,
      labourIds: [labourId, Number(otherLabour.id)],
      deptId,
      applyOn: "GROUP",
      groupIds: [groupId],
      articleType: "SFG",
      rateType: "PER_DOZEN",
      baseRate: "5",
    });
    check(
      "every previous rate is null",
      multi.every((row) => row.previous_rate === null),
      true,
    );
    check("the base rate is still seeded", multi[0].new_rate, 5);
  } else {
    skip("multi-labour selection (only one labour exists)");
  }
};

(async () => {
  try {
    await knex
      .transaction(async (trx) => {
        await run(trx);
        // Never persist the fixture.
        throw new Error(ROLLBACK);
      })
      .catch((err) => {
        if (err.message !== ROLLBACK) throw err;
      });
    console.log(`\n${passed} passed, ${failed} failed (fixture rolled back)`);
  } catch (err) {
    console.error("\nSuite crashed:", err);
    failed += 1;
  } finally {
    await knex.destroy();
  }
  process.exit(failed ? 1 : 0);
})();
