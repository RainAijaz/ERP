require("dotenv").config();

const knex = require("../db/knex");
const bomService = require("../services/bom/service");
const bomCopyService = require("../services/bom/copy-service");

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const authUsername = process.env.AUTH_USERNAME || process.env.E2E_ADMIN_USER || "";
const authPassword = process.env.AUTH_PASSWORD || process.env.E2E_ADMIN_PASSWORD || process.env.E2E_ADMIN_PASS || "";

const cookieJar = new Map();
const storeCookies = (res) => {
  const headers = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  (headers || []).forEach((raw) => {
    const part = String(raw).split(";")[0];
    const idx = part.indexOf("=");
    if (idx <= 0) return;
    cookieJar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  });
};
const cookieHeader = () => Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
const request = async (path, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  const jar = cookieHeader();
  if (jar) headers.Cookie = jar;
  const res = await fetch(`${baseUrl}${path}`, { ...opts, headers, redirect: "manual" });
  storeCookies(res);
  return res;
};
const extractCsrf = (html) => {
  const m = html.match(/name=['"]_csrf['"][^>]*value=['"]([^'"]+)['"]/i);
  return m ? m[1] : "";
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const loginIfNeeded = async () => {
  const home = await request("/", { redirect: "manual" });
  if (home.status !== 302) return;
  assert(authUsername && authPassword, "No session and no AUTH_USERNAME/AUTH_PASSWORD provided.");
  const loginPage = await request("/auth/login");
  const html = await loginPage.text();
  const csrf = extractCsrf(html);
  assert(Boolean(csrf), "Unable to extract csrf token for login.");
  const payload = new URLSearchParams();
  payload.set("_csrf", csrf);
  payload.set("username", authUsername);
  payload.set("password", authPassword);
  const loginRes = await request("/auth/login", {
    method: "POST",
    body: payload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert([302, 303].includes(loginRes.status), `Login failed, status ${loginRes.status}`);
};

// ---------------------------------------------------------------------------
// Part A: pure-function tests for mapSkuOverridesToTarget (no DB, no server)
// ---------------------------------------------------------------------------
const runMappingUnitTests = () => {
  const sourceSkus = [
    { sku_id: 1, sku_code: "SRC-A", size_id: 1, grade_id: null, color_id: 1, packing_type_id: 1 },
    { sku_id: 2, sku_code: "SRC-B", size_id: 2, grade_id: null, color_id: 1, packing_type_id: 1 },
    { sku_id: 3, sku_code: "SRC-C", size_id: 3, grade_id: null, color_id: 1, packing_type_id: 1 },
  ];
  const targetSkus = [
    { sku_id: 10, sku_code: "TGT-A", size_id: 1, grade_id: null, color_id: 1, packing_type_id: 1 },
    { sku_id: 11, sku_code: "TGT-B-1", size_id: 2, grade_id: null, color_id: 1, packing_type_id: 1 },
    { sku_id: 12, sku_code: "TGT-B-2", size_id: 2, grade_id: null, color_id: 1, packing_type_id: 1 },
  ];
  const copiedRmComboSet = new Set(["100:5", "200:5"]);

  const overrides = [
    // clean match: SRC-A -> TGT-A, rm/dept copied
    { sku_id: 1, target_rm_item_id: 100, dept_id: 5, override_qty: 3, is_excluded: false },
    // ambiguous match: SRC-B has two target candidates (TGT-B-1, TGT-B-2)
    { sku_id: 2, target_rm_item_id: 100, dept_id: 5, override_qty: 4, is_excluded: false },
    // no matching sku at all
    { sku_id: 3, target_rm_item_id: 100, dept_id: 5, override_qty: 5, is_excluded: false },
    // rm/dept combo not in the copied RM lines
    { sku_id: 1, target_rm_item_id: 999, dept_id: 5, override_qty: 1, is_excluded: false },
    // unknown source sku_id (not in sourceSkus at all)
    { sku_id: 777, target_rm_item_id: 100, dept_id: 5, override_qty: 1, is_excluded: false },
  ];

  const { mapped, skipped } = bomCopyService.mapSkuOverridesToTarget({
    overrides,
    sourceSkus,
    targetSkus,
    copiedRmComboSet,
  });

  assert(mapped.length === 1, `Expected exactly 1 clean mapping, got ${mapped.length}`);
  assert(mapped[0].sku_id === 10, "Clean match should map SRC-A's override onto TGT-A (sku_id 10).");
  assert(Number(mapped[0].override_qty) === 3, "Mapped override should preserve override_qty.");

  assert(skipped.length === 4, `Expected 4 skipped rows, got ${skipped.length}`);
  const reasons = skipped.map((s) => s.reason).sort();
  assert(
    JSON.stringify(reasons) ===
      JSON.stringify(["missing_rm_line", "multiple_matching_skus", "no_matching_sku", "no_matching_sku"].sort()),
    `Unexpected skip reasons: ${JSON.stringify(reasons)}`,
  );

  // Duplicate-after-mapping: two source overrides map onto the same target combo.
  const dupSourceSkus = [
    { sku_id: 1, sku_code: "SRC-A", size_id: 1, grade_id: null, color_id: 1, packing_type_id: 1 },
    { sku_id: 2, sku_code: "SRC-A-dup", size_id: 1, grade_id: null, color_id: 1, packing_type_id: 1 },
  ];
  const dupTargetSkus = [
    { sku_id: 10, sku_code: "TGT-A", size_id: 1, grade_id: null, color_id: 1, packing_type_id: 1 },
  ];
  const dupOverrides = [
    { sku_id: 1, target_rm_item_id: 100, dept_id: 5, override_qty: 3, is_excluded: false },
    { sku_id: 2, target_rm_item_id: 100, dept_id: 5, override_qty: 9, is_excluded: false },
  ];
  const dupResult = bomCopyService.mapSkuOverridesToTarget({
    overrides: dupOverrides,
    sourceSkus: dupSourceSkus,
    targetSkus: dupTargetSkus,
    copiedRmComboSet,
  });
  assert(dupResult.mapped.length === 1, "Only the first override for a given target combo should be mapped.");
  assert(dupResult.skipped.length === 1 && dupResult.skipped[0].reason === "duplicate_after_mapping", "Second override onto the same target combo should be skipped as duplicate_after_mapping.");

  console.log("[test-bom-copy] Part A (mapSkuOverridesToTarget unit tests) PASS");
};

// ---------------------------------------------------------------------------
// Part B: direct DB smoke test against real data (read-only)
// ---------------------------------------------------------------------------
const runDbSmokeTest = async () => {
  const source = await knex("erp.bom_header as bh")
    .select("bh.id as bom_id", "bh.item_id", "bh.bom_no", "bh.version_no")
    .where("bh.status", "APPROVED")
    .andWhere("bh.level", "FINISHED")
    .orderBy("bh.id", "desc")
    .first();
  assert(source, "Expected at least one APPROVED FINISHED BOM in the database for this smoke test.");

  // Find a target FG item at the same level with no bom_header row yet (this
  // is the article a user would be creating/editing a draft for).
  const existingBomItemIds = (await knex("erp.bom_header").distinct("item_id")).map((r) => Number(r.item_id));
  const targetItem = await knex("erp.items")
    .select("id", "name", "base_uom_id")
    .where({ item_type: "FG", is_active: true })
    .whereNotIn("id", [...existingBomItemIds, Number(source.item_id)])
    .first();
  assert(targetItem, "Expected at least one FG item without an existing BOM for the copy target.");

  // listApprovedCopySources is called from the target article's context, so
  // it excludes the *target* item, not the source item.
  const sources = await bomCopyService.listApprovedCopySources(knex, {
    level: "FINISHED",
    excludeItemId: targetItem.id,
  });
  assert(Array.isArray(sources), "listApprovedCopySources should return an array.");
  assert(
    sources.some((row) => Number(row.bom_id) === Number(source.bom_id)),
    "listApprovedCopySources should include the known approved source BOM.",
  );

  const payload = await bomCopyService.buildCopyPayload(knex, {
    sourceBomId: source.bom_id,
    targetItemId: targetItem.id,
    targetLevel: "FINISHED",
    sections: "rm,sku_overrides,stage_routes",
    t: (key) => key,
  });

  assert(payload.source.bom_id === Number(source.bom_id), "Copy payload should echo the source bom_id.");
  const sourceRmCount = Number((await knex("erp.bom_rm_line").where({ bom_id: source.bom_id }).count("id as c"))[0].c);
  const sourceStageCount = Number(
    (await knex("erp.bom_stage_routing").where({ bom_id: source.bom_id }).count("id as c"))[0].c,
  );
  const sourceOverrideCount = Number(
    (await knex("erp.bom_sku_override_line").where({ bom_id: source.bom_id }).count("id as c"))[0].c,
  );

  assert(payload.report.rm_lines.total === sourceRmCount, "RM line report total should match source RM line count.");
  assert(payload.lines.rm_lines.length === payload.report.rm_lines.copied, "Copied RM lines array length should match report.");
  assert(payload.report.stage_routes.total === sourceStageCount, "Stage route report total should match source count.");
  assert(
    payload.report.sku_overrides.total === sourceOverrideCount,
    "SKU override report total should match source override count.",
  );
  assert(
    payload.report.sku_overrides.copied + payload.report.sku_overrides.skipped.length === sourceOverrideCount,
    "SKU override copied+skipped should account for every source override row.",
  );

  console.log("[test-bom-copy] Part B (DB smoke test) PASS", {
    sourceBomId: source.bom_id,
    targetItemId: targetItem.id,
    rmCopied: payload.report.rm_lines.copied,
    stageCopied: payload.report.stage_routes.copied,
    skuOverridesCopied: payload.report.sku_overrides.copied,
    skuOverridesSkipped: payload.report.sku_overrides.skipped.length,
  });

  return { source, targetItem, payload };
};

// ---------------------------------------------------------------------------
// Part C: HTTP smoke test for the two new GET endpoints (read-only, no mutation)
// ---------------------------------------------------------------------------
const runHttpSmokeTest = async ({ source, targetItem, payload }) => {
  const sourcesRes = await request(
    `/master-data/bom/copy-sources?level=FINISHED&exclude_item_id=${targetItem.id}`,
  );
  assert(sourcesRes.status === 200, `GET /copy-sources should return 200, got ${sourcesRes.status}`);
  const sourcesJson = await sourcesRes.json();
  assert(sourcesJson.ok === true, "GET /copy-sources should return ok:true");
  assert(Array.isArray(sourcesJson.sources), "GET /copy-sources should return a sources array");
  assert(
    sourcesJson.sources.some((row) => Number(row.bom_id) === Number(source.bom_id)),
    "GET /copy-sources should include the known source BOM",
  );

  const payloadRes = await request(
    `/master-data/bom/${source.bom_id}/copy-payload?target_item_id=${targetItem.id}&target_level=FINISHED&sections=rm,sku_overrides,stage_routes`,
  );
  assert(payloadRes.status === 200, `GET /copy-payload should return 200, got ${payloadRes.status}`);
  const payloadJson = await payloadRes.json();
  assert(payloadJson.ok === true, "GET /copy-payload should return ok:true");
  assert(
    payloadJson.report.rm_lines.total === payload.report.rm_lines.total,
    "HTTP copy-payload RM report should match the direct service-level result",
  );
  assert(
    payloadJson.lines.rm_lines.length === payload.lines.rm_lines.length,
    "HTTP copy-payload RM lines length should match the direct service-level result",
  );

  // Invalid combination should be rejected with a plain-language 400, not a 500.
  const invalidRes = await request(
    `/master-data/bom/${source.bom_id}/copy-payload?target_item_id=${source.item_id}&target_level=FINISHED&sections=rm`,
  );
  assert(invalidRes.status === 400, "Copying a BOM onto its own article should be rejected with 400.");

  console.log("[test-bom-copy] Part C (HTTP smoke test) PASS");
};

// ---------------------------------------------------------------------------
// Part D: DB-direct mutation test - create a draft from copied lines, verify
// provenance, change log, and the copied-vs-edited comparison. Cleans up after.
// ---------------------------------------------------------------------------
const runDraftMutationTest = async ({ source, targetItem, payload }) => {
  const admin = await knex("erp.users").select("id").where({ username: authUsername || "admin" }).first();
  assert(admin, "Expected an admin user row to exist for the draft-mutation test.");

  let createdBomId = null;
  try {
    const input = {
      header: {
        item_id: Number(targetItem.id),
        level: "FINISHED",
        output_qty: 1,
        output_uom_id: Number(targetItem.base_uom_id),
        copied_from_bom_id: Number(source.bom_id),
      },
      rm_lines: payload.lines.rm_lines,
      sku_rules: [],
      sfg_lines: [],
      labour_lines: [],
      stage_routes: payload.lines.stage_routes,
    };

    const result = await bomService.saveBomDraft(knex, {
      input,
      bomId: null,
      userId: admin.id,
      requestId: null,
      t: (key) => key,
    });
    createdBomId = result.id;
    assert(createdBomId, "saveBomDraft should return a created BOM id.");

    const headerRow = await knex("erp.bom_header").where({ id: createdBomId }).first();
    assert(
      Number(headerRow.copied_from_bom_id) === Number(source.bom_id),
      "Created draft should persist copied_from_bom_id.",
    );

    const changeLogRows = await knex("erp.bom_change_log").where({ bom_id: createdBomId, section: "rm_lines" });
    assert(
      changeLogRows.length === payload.lines.rm_lines.length,
      `Expected ${payload.lines.rm_lines.length} rm_lines change-log rows, got ${changeLogRows.length}`,
    );
    assert(
      changeLogRows.every((row) => row.change_type === "ADDED"),
      "All rm_lines change-log rows for a brand-new draft should be ADDED.",
    );

    let comparison = await bomCopyService.buildCopyComparison(knex, { bomId: createdBomId });
    assert(comparison, "buildCopyComparison should return a comparison for a copied draft.");
    assert(Number(comparison.source.bom_id) === Number(source.bom_id), "Comparison source bom_id should match.");

    // NOTE: bom_rm_line.qty/uom_id are always server-derived (qty from SKU
    // Rules aggregation, uom_id from the RM item's own base unit - see
    // validateAndNormalizeInput). We passed sku_rules: [] here, so the server
    // legitimately recomputes qty to 0, which the comparison correctly
    // reports as 'edited' rather than 'copied'. This is expected: in the real
    // browser flow the client also copies SKU Overrides (checked by default)
    // and converts them to sku_rules_json at submit time, so qty is
    // re-derived back to the original total there.
    assert(
      comparison.sections.rm_lines.rows.every((entry) => entry.origin === "edited"),
      "With no SKU rules submitted, RM lines should be reported as 'edited' (server-recomputed qty), not silently 'copied'.",
    );

    // stage_routes fields are NOT server-recomputed, so an untouched copy
    // should be classified as 'copied' - this is the real happy-path proof.
    assert(
      comparison.sections.stage_routes.rows.every((entry) => entry.origin === "copied"),
      "Every untouched stage route should be classified as 'copied'.",
    );
    assert(comparison.sections.stage_routes.removedCount === 0, "No stage routes were removed yet.");

    // Now edit one stage route and re-save; it should flip to 'edited' while
    // the others remain 'copied'.
    if (payload.lines.stage_routes.length > 1) {
      const editedStageRoutes = payload.lines.stage_routes.map((line, idx) =>
        idx === 0 ? { ...line, is_required: !line.is_required } : line,
      );
      await bomService.saveBomDraft(knex, {
        input: { ...input, stage_routes: editedStageRoutes },
        bomId: createdBomId,
        userId: admin.id,
        requestId: null,
        t: (key) => key,
      });
      comparison = await bomCopyService.buildCopyComparison(knex, { bomId: createdBomId });
      const editedCount = comparison.sections.stage_routes.rows.filter((entry) => entry.origin === "edited").length;
      const copiedCount = comparison.sections.stage_routes.rows.filter((entry) => entry.origin === "copied").length;
      assert(editedCount === 1, `Expected exactly 1 edited stage route after modification, got ${editedCount}`);
      assert(
        copiedCount === payload.lines.stage_routes.length - 1,
        `Expected the remaining stage routes to stay 'copied', got ${copiedCount}`,
      );
    }

    console.log("[test-bom-copy] Part D (draft mutation + comparison) PASS", { createdBomId });
  } finally {
    if (createdBomId) {
      await knex("erp.bom_header").where({ id: createdBomId }).del();
    }
  }
};

async function run() {
  try {
    console.log("[test-bom-copy] start");
    runMappingUnitTests();

    await loginIfNeeded();
    const { source, targetItem, payload } = await runDbSmokeTest();
    await runHttpSmokeTest({ source, targetItem, payload });
    await runDraftMutationTest({ source, targetItem, payload });

    console.log("[test-bom-copy] PASS");
  } catch (err) {
    console.error("[test-bom-copy] FAIL", err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
}

run();
