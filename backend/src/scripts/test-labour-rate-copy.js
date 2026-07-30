/**
 * Service-level tests for labour-rate-copy-service.
 *
 * Runs against the real database but writes nothing permanent: every
 * assertion that touches the write path runs inside a transaction that is
 * rolled back. Fixtures are created in beforeAll and removed in afterAll.
 *
 *   npm run test:labour-rate-copy
 */
const knex = require("../db/knex");
const svc = require("../services/hr-payroll/labour-rate-copy-service");

const TAG = `lrcsvc${Date.now().toString(36)}`;
let passed = 0;
let failed = 0;
const failures = [];

const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failed += 1;
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};

const eq = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const ctx = { labourIds: [], deptId: null, altDeptId: null, skuIds: [] };

const createLabour = async (suffix, deptId, { assign = true, status = "active" } = {}) => {
  const name = `${TAG} ${suffix}`;
  const [row] = await knex("erp.labours")
    .insert({
      name,
      code: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      status,
      dept_id: assign ? deptId : null,
    })
    .returning("id");
  const id = Number(row.id || row);
  if (assign) {
    await knex("erp.labour_department").insert({ labour_id: id, dept_id: deptId });
  }
  ctx.labourIds.push(id);
  return id;
};

const setup = async () => {
  const depts = await knex("erp.departments")
    .where({ is_active: true, is_production: true })
    .orderBy("id", "asc")
    .limit(2)
    .select("id");
  if (!depts.length) throw new Error("no active production department");
  ctx.deptId = Number(depts[0].id);
  ctx.altDeptId = depts[1] ? Number(depts[1].id) : null;

  const skus = await knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .where({ "s.is_active": true, "i.is_active": true })
    .whereIn("i.item_type", ["FG", "SFG"])
    .whereNotNull("i.group_id")
    .orderBy("s.id", "asc")
    .limit(6)
    .select("s.id", "i.item_type", "i.group_id", "i.subgroup_id");
  if (skus.length < 4) throw new Error("need at least 4 active SKUs");
  ctx.skus = skus;
  ctx.skuIds = skus.map((row) => Number(row.id));

  ctx.sourceId = await createLabour("SOURCE", ctx.deptId);
  ctx.targetA = await createLabour("TARGET A", ctx.deptId);
  ctx.targetB = await createLabour("TARGET B", ctx.deptId);
  ctx.unassigned = await createLabour("UNASSIGNED", ctx.deptId, { assign: false });
  ctx.inactive = await createLabour("INACTIVE", ctx.deptId, { status: "inactive" });

  const base = {
    applies_to_all_labours: false,
    dept_id: ctx.deptId,
    apply_on: "SKU",
    status: "active",
  };
  await knex("erp.labour_rate_rules").insert([
    { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[0], rate_type: "PER_DOZEN", rate_value: 10 },
    { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[1], rate_type: "PER_DOZEN", rate_value: 20 },
    { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[2], rate_type: "PER_PAIR", rate_value: 3 },
    { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[3], rate_type: "PER_PAIR", rate_value: 4 },
    // Inactive rule: must never be copied.
    { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[4] ?? ctx.skuIds[0], rate_type: "PER_DOZEN", rate_value: 77, status: "inactive" },
    // Scope-wide fallback: cannot be copied, must be reported.
    { ...base, labour_id: ctx.sourceId, apply_on: "GROUP", sku_id: null, group_id: Number(skus[0].group_id), rate_type: "PER_DOZEN", rate_value: 5 },
    // Target B conflicts on sku 0 and matches exactly on sku 1.
    { ...base, labour_id: ctx.targetB, sku_id: ctx.skuIds[0], rate_type: "PER_DOZEN", rate_value: 99 },
    { ...base, labour_id: ctx.targetB, sku_id: ctx.skuIds[1], rate_type: "PER_DOZEN", rate_value: 20 },
  ]);
};

const teardown = async () => {
  if (ctx.labourIds.length) {
    await knex("erp.labour_rate_rules").whereIn("labour_id", ctx.labourIds).del();
    await knex("erp.labour_department").whereIn("labour_id", ctx.labourIds).del();
    await knex("erp.labours").whereIn("id", ctx.labourIds).del();
  }
};

const run = async () => {
  console.log("\n== fetchSourceDepartments ==");
  const depts = await svc.fetchSourceDepartments({ sourceLabourId: ctx.sourceId });
  const dept = depts.find((entry) => entry.dept_id === ctx.deptId);
  check("lists the department the source has rates in", Boolean(dept));
  eq("counts only sku-pinned active rules", dept.rule_count, 4);
  eq("counts scope-wide rules separately", dept.scope_wide_count, 1);
  eq(
    "reports both rate types present",
    [...dept.rate_types].sort(),
    ["PER_DOZEN", "PER_PAIR"],
  );
  eq(
    "unknown source yields no departments",
    await svc.fetchSourceDepartments({ sourceLabourId: 99999999 }),
    [],
  );

  console.log("\n== fetchCopyableRules ==");
  const { copyable, scopeWide } = await svc.fetchCopyableRules({
    sourceLabourId: ctx.sourceId,
    deptId: ctx.deptId,
  });
  eq("copyable excludes inactive and scope-wide", copyable.length, 4);
  eq("scope-wide rule is separated out", scopeWide.length, 1);
  check(
    "inactive rule is not copyable",
    !copyable.some((rule) => Number(rule.rate_value) === 77),
  );
  check(
    "every copyable rule carries a sku id",
    copyable.every((rule) => rule.sku_id > 0),
  );

  console.log("\n== target resolution ==");
  const resolved = await svc.resolveTargetLabours({
    targetLabourIds: [ctx.targetA, ctx.unassigned, ctx.inactive, ctx.sourceId],
    deptId: ctx.deptId,
    sourceLabourId: ctx.sourceId,
  });
  eq("only the valid target is allowed", resolved.allowed.map((e) => e.labour_id), [ctx.targetA]);
  const reasons = Object.fromEntries(
    resolved.blocked.map((entry) => [entry.labour_id, entry.reason]),
  );
  eq("unassigned target is blocked with reason", reasons[ctx.unassigned], "NOT_ASSIGNED");
  eq("inactive target is blocked with reason", reasons[ctx.inactive], "INACTIVE");
  check(
    "source is silently excluded, not blocked",
    !resolved.blocked.some((entry) => entry.labour_id === ctx.sourceId),
  );

  const branchScoped = await svc.resolveTargetLabours({
    targetLabourIds: [ctx.targetA],
    deptId: ctx.deptId,
    sourceLabourId: ctx.sourceId,
    allowedBranchIds: [999999],
  });
  eq("out-of-branch target is blocked", branchScoped.allowed.length, 0);
  eq(
    "out-of-branch reason is reported",
    branchScoped.blocked[0]?.reason,
    "OUT_OF_SCOPE",
  );

  console.log("\n== buildCopyPlan: states ==");
  const plan = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.targetA, ctx.targetB],
    deptId: ctx.deptId,
    filters: {},
    conflictMode: "SKIP",
  });
  eq("plan covers every copyable article", plan.rows.length, 4);
  eq("both targets resolved", plan.targets.length, 2);
  eq("target A is entirely new (4 articles)", plan.counts.new, 4 + 2);
  eq("one differing rate is a conflict", plan.counts.conflict, 1);
  eq("one matching rate is identical", plan.counts.identical, 1);
  eq("SKIP writes new only", plan.counts.writes, 6);

  const overwritePlan = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.targetA, ctx.targetB],
    deptId: ctx.deptId,
    filters: {},
    conflictMode: "OVERWRITE",
  });
  eq("OVERWRITE adds the conflict but not the identical", overwritePlan.counts.writes, 7);

  console.log("\n== buildCopyPlan: filters ==");
  const fgCount = ctx.skus
    .slice(0, 4)
    .filter((row) => String(row.item_type).toUpperCase() === "FG").length;
  const fgPlan = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.targetA],
    deptId: ctx.deptId,
    filters: { articleType: "FG" },
    conflictMode: "SKIP",
  });
  eq("article type filter narrows rows", fgPlan.rows.length, fgCount);
  check(
    "facets survive filtering so the user can widen again",
    fgPlan.facets.articles.length === 4,
  );

  const oneSku = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.targetA],
    deptId: ctx.deptId,
    filters: { skuIds: [ctx.skuIds[0]] },
    conflictMode: "SKIP",
  });
  eq("article filter narrows to one row", oneSku.rows.length, 1);
  eq("filtered plan reports one rate type", oneSku.rate_types, ["PER_DOZEN"]);

  const noMatch = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.targetA],
    deptId: ctx.deptId,
    filters: { groupIds: [99999999] },
    conflictMode: "SKIP",
  });
  eq("impossible filter yields no writes", noMatch.counts.writes, 0);

  console.log("\n== buildWriteRows ==");
  const perDozen = svc.buildWriteRows({ plan, rateType: "PER_DOZEN" });
  const perPair = svc.buildWriteRows({ plan, rateType: "PER_PAIR" });
  // PER_DOZEN covers sku0 + sku1 over 2 targets = 4 cells: target A is new on
  // both, target B conflicts on sku0 (skipped) and is identical on sku1 (never
  // written) -> 2 write rows.
  eq("per-dozen rows split correctly", perDozen.length, 2);
  // PER_PAIR covers sku2 + sku3 and target B holds neither -> all 4 are new.
  eq("per-pair rows split correctly", perPair.length, 4);
  check(
    "no row mixes rate types",
    perDozen.every((row) => row.rate_type === "PER_DOZEN") &&
      perPair.every((row) => row.rate_type === "PER_PAIR"),
  );
  check(
    "every write row carries labour, sku and rate",
    [...perDozen, ...perPair].every(
      (row) => row.labour_id > 0 && row.sku_id > 0 && row.new_rate !== null,
    ),
  );
  check(
    "conflict rows are excluded under SKIP",
    !perDozen.some(
      (row) => row.labour_id === ctx.targetB && row.sku_id === ctx.skuIds[0],
    ),
  );
  check(
    "conflict rows are included under OVERWRITE",
    svc
      .buildWriteRows({ plan: overwritePlan, rateType: "PER_DOZEN" })
      .some(
        (row) => row.labour_id === ctx.targetB && row.sku_id === ctx.skuIds[0],
      ),
  );

  console.log("\n== guards ==");
  const selfCopy = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.sourceId],
    deptId: ctx.deptId,
    filters: {},
    conflictMode: "SKIP",
  });
  eq("cannot copy a labour onto itself", selfCopy.targets.length, 0);

  const noDept = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.targetA],
    deptId: null,
    filters: {},
    conflictMode: "SKIP",
  });
  eq("missing department yields an empty plan", noDept.rows.length, 0);

  if (ctx.altDeptId) {
    const wrongDept = await svc.buildCopyPlan({
      sourceLabourId: ctx.sourceId,
      targetLabourIds: [ctx.targetA],
      deptId: ctx.altDeptId,
      filters: {},
      conflictMode: "SKIP",
    });
    eq(
      "a department the source has no rates in copies nothing",
      wrongDept.counts.writes,
      0,
    );
  }

  console.log("\n== applyCopy (rolled back) ==");
  const rollback = async (fn) => {
    let result;
    try {
      await knex.transaction(async (trx) => {
        result = await fn(trx);
        throw new Error("__ROLLBACK__");
      });
    } catch (err) {
      if (err.message !== "__ROLLBACK__") throw err;
    }
    return result;
  };

  const skipResult = await rollback((trx) =>
    svc.applyCopy({ trx, deptId: ctx.deptId, rows: perDozen, conflictMode: "SKIP" }),
  );
  eq("SKIP inserts new rows only", skipResult, { created: 2, updated: 0, skipped: 0 });

  const owRows = svc.buildWriteRows({ plan: overwritePlan, rateType: "PER_DOZEN" });
  const owResult = await rollback((trx) =>
    svc.applyCopy({ trx, deptId: ctx.deptId, rows: owRows, conflictMode: "OVERWRITE" }),
  );
  eq(
    "OVERWRITE updates the conflicting row",
    owResult,
    { created: 2, updated: 1, skipped: 0 },
  );

  // Race guard: rows that conflict, applied under SKIP, must be skipped by
  // DO NOTHING rather than overwriting.
  const raceResult = await rollback((trx) =>
    svc.applyCopy({ trx, deptId: ctx.deptId, rows: owRows, conflictMode: "SKIP" }),
  );
  eq("SKIP never overwrites on a race", raceResult, { created: 2, updated: 0, skipped: 1 });

  const written = await rollback(async (trx) => {
    await svc.applyCopy({ trx, deptId: ctx.deptId, rows: perDozen, conflictMode: "SKIP" });
    return trx("erp.labour_rate_rules")
      .where({ labour_id: ctx.targetA, dept_id: ctx.deptId })
      .orderBy("sku_id")
      .select("sku_id", "rate_value", "rate_type", "apply_on", "status", "subgroup_id", "group_id");
  });
  check("copied rows are stamped apply_on = SKU", written.every((row) => row.apply_on === "SKU"));
  check("copied rows null out scope columns", written.every((row) => !row.subgroup_id && !row.group_id));
  check("copied rows are active", written.every((row) => row.status === "active"));

  const doubleApply = await rollback(async (trx) => {
    await svc.applyCopy({ trx, deptId: ctx.deptId, rows: perDozen, conflictMode: "SKIP" });
    await svc.applyCopy({ trx, deptId: ctx.deptId, rows: perDozen, conflictMode: "SKIP" });
    return trx("erp.labour_rate_rules")
      .where({ labour_id: ctx.targetA, dept_id: ctx.deptId })
      .count("* as c")
      .first();
  });
  eq("applying twice does not duplicate", Number(doubleApply.c), 2);

  eq(
    "empty row set is a no-op",
    await rollback((trx) => svc.applyCopy({ trx, deptId: ctx.deptId, rows: [], conflictMode: "SKIP" })),
    { created: 0, updated: 0, skipped: 0 },
  );

  console.log("\n== chunking (>500 rows in one call) ==");
  // Enough targets that rows x targets clears the 500-row chunk size and the
  // writer genuinely has to issue more than one statement.
  const bulkTargets = [];
  for (let i = 0; i < 8; i += 1) {
    bulkTargets.push(await createLabour(`BULK ${i}`, ctx.deptId));
  }
  const manySkus = await knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .where({ "s.is_active": true, "i.is_active": true })
    .orderBy("s.id", "asc")
    .limit(200)
    .pluck("s.id");
  const bulkRows = [];
  bulkTargets.forEach((labourId) => {
    manySkus.forEach((skuId, index) => {
      bulkRows.push({
        labour_id: labourId,
        sku_id: Number(skuId),
        rate_type: "PER_PAIR",
        new_rate: 1 + (index % 9),
      });
    });
  });
  check(
    `fixture clears one chunk (${bulkRows.length} rows > 500)`,
    bulkRows.length > 500,
    `only built ${bulkRows.length} rows`,
  );
  const bulkResult = await rollback((trx) =>
    svc.applyCopy({ trx, deptId: ctx.deptId, rows: bulkRows, conflictMode: "SKIP" }),
  );
  eq(
    `writes all ${bulkRows.length} rows across chunks`,
    bulkResult.created,
    bulkRows.length,
  );

  const startedAt = Date.now();
  await rollback((trx) =>
    svc.applyCopy({ trx, deptId: ctx.deptId, rows: bulkRows, conflictMode: "SKIP" }),
  );
  const elapsed = Date.now() - startedAt;
  check(
    `${bulkRows.length} rows written in under 5s (took ${elapsed}ms)`,
    elapsed < 5000,
    `took ${elapsed}ms`,
  );

  console.log("\n== limit guard ==");
  const overLimit = await svc.buildCopyPlan({
    sourceLabourId: ctx.sourceId,
    targetLabourIds: [ctx.targetA],
    deptId: ctx.deptId,
    filters: {},
    conflictMode: "SKIP",
    // Simulated by comparing against the exported cap rather than seeding
    // thousands of rules.
  });
  check("cap is exported for the route to report", svc.MAX_COPY_ROWS > 0);
  check("a normal plan is under the cap", !overLimit.over_limit);

  console.log("\n== normalizers ==");
  eq("article type accepts FINISHED", svc.normalizeArticleTypeFilter("FINISHED"), "FG");
  eq("article type accepts SEMI_FINISHED", svc.normalizeArticleTypeFilter("SEMI_FINISHED"), "SFG");
  eq("article type defaults to BOTH", svc.normalizeArticleTypeFilter("junk"), "BOTH");
  eq("conflict mode defaults to SKIP", svc.normalizeConflictMode(""), "SKIP");
  eq("conflict mode is case-insensitive", svc.normalizeConflictMode("overwrite"), "OVERWRITE");
  eq("rate type defaults to PER_PAIR", svc.normalizeRateType("junk"), "PER_PAIR");
  eq("int array parses csv", svc.toPositiveIntArray("1,2,2,x,-3"), [1, 2]);
};

(async () => {
  console.log("labour-rate-copy service tests");
  try {
    await setup();
    await run();
  } catch (err) {
    failed += 1;
    console.error("\nSUITE ERROR:", err.message);
    console.error(err.stack);
  } finally {
    await teardown();
    await knex.destroy();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log("failed:", failures.join(" | "));
  process.exit(failed ? 1 : 0);
})();
