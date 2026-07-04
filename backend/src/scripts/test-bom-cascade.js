require("dotenv").config();

const knex = require("../db/knex");
const bomCascadeService = require("../services/bom/cascade-service");

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
// Part A: pure-function tests (no DB)
// ---------------------------------------------------------------------------
const runPureUnitTests = () => {
  // buildCascadeMergedLines: safe add/update/remove applied, everything else
  // (edited/added by the user, not selected) passes through verbatim.
  const plan = {
    sections: {
      rm_lines: {
        safe: [
          { key: "1:5:0:0", action: "update", parentValue: { rm_item_id: 1, dept_id: 5, color_id: null, size_id: null, uom_id: 9, normal_loss_pct: 0 } },
          { key: "2:5:0:0", action: "add", parentValue: { rm_item_id: 2, dept_id: 5, color_id: null, size_id: null, uom_id: 9 } },
          { key: "3:5:0:0", action: "remove", dependentValue: { rm_item_id: 3, dept_id: 5, qty: 4 } },
        ],
        allCurrentRows: [
          { rm_item_id: 1, dept_id: 5, color_id: null, size_id: null, uom_id: 1, qty: 10, normal_loss_pct: 0 },
          { rm_item_id: 3, dept_id: 5, color_id: null, size_id: null, uom_id: 1, qty: 4, normal_loss_pct: 0 },
          { rm_item_id: 4, dept_id: 6, color_id: null, size_id: null, uom_id: 1, qty: 7, normal_loss_pct: 0 }, // user-added, untouched by cascade
        ],
      },
      stage_routes: { safe: [], allCurrentRows: [] },
      sfg_lines: { safe: [], allCurrentRows: [] },
      sku_overrides: {
        safe: [],
        allCurrentRows: [
          { sku_id: 100, target_rm_item_id: 3, dept_id: 5, is_excluded: false, override_qty: 2 }, // references the rm line being removed
          { sku_id: 100, target_rm_item_id: 4, dept_id: 6, is_excluded: true, override_qty: null }, // unrelated, must survive verbatim
        ],
      },
    },
  };
  const merged = bomCascadeService.buildCascadeMergedLines({
    plan,
    selectedKeysBySection: { rm_lines: ["1:5:0:0", "2:5:0:0", "3:5:0:0"], stage_routes: [], sfg_lines: [], sku_overrides: [] },
  });

  const rmByCombo = new Map(merged.rm_lines.map((r) => [`${r.rm_item_id}:${r.dept_id}`, r]));
  assert(rmByCombo.get("1:5")?.uom_id === 9, "Safe update should apply the parent's structural uom_id.");
  assert(rmByCombo.get("1:5")?.qty === 10, "Safe update must NOT overwrite the dependent's own qty (qty is intrinsic per-BOM).");
  assert(rmByCombo.has("2:5"), "Safe add should insert the new RM line.");
  assert(rmByCombo.get("2:5")?.qty === 0, "A newly cascaded RM line should start at qty 0 (derived later from SKU rules).");
  assert(!rmByCombo.has("3:5"), "Safe remove should drop the RM line.");
  assert(rmByCombo.has("4:6"), "A user-added RM line untouched by the parent delta must pass through verbatim.");

  const overrideKeys = merged.sku_overrides.map((o) => `${o.sku_id}:${o.target_rm_item_id}:${o.dept_id}`);
  assert(!overrideKeys.includes("100:3:5"), "An override referencing a removed RM line must be dropped, not left dangling.");
  assert(overrideKeys.includes("100:4:6"), "An override unrelated to the cascade must survive verbatim.");

  console.log("[test-bom-cascade] Part A.1 (buildCascadeMergedLines) PASS");

  // resolveDependentSkuOverrideTarget: unambiguous match / no match / ambiguous match.
  const sourceSkuIdToVariantKey = new Map([[10, "1|0|2|3"], [11, "1|0|2|4"]]);
  const dependentVariantKeyToSkuIds = new Map([["1|0|2|3", [20]], ["1|0|2|4", [21, 22]]]);
  const clean = bomCascadeService.resolveDependentSkuOverrideTarget(10, { sourceSkuIdToVariantKey, dependentVariantKeyToSkuIds });
  assert(clean.skuId === 20, "Unambiguous variant match should resolve to the single dependent SKU.");
  const ambiguous = bomCascadeService.resolveDependentSkuOverrideTarget(11, { sourceSkuIdToVariantKey, dependentVariantKeyToSkuIds });
  assert(ambiguous.skipped === "multiple_matching_skus", "Two dependent SKUs sharing a variant key must be left unresolved, not guessed.");
  const noMatch = bomCascadeService.resolveDependentSkuOverrideTarget(999, { sourceSkuIdToVariantKey, dependentVariantKeyToSkuIds });
  assert(noMatch.skipped === "no_matching_sku", "An unknown parent sku_id should report no_matching_sku.");

  console.log("[test-bom-cascade] Part A.2 (resolveDependentSkuOverrideTarget) PASS");
};

// ---------------------------------------------------------------------------
// Part B: DB-backed 3-way merge scenario
// ---------------------------------------------------------------------------
// Wrapped in a transaction (the callback parameter shadows the outer `knex`
// import, so every call below runs against the transaction) so a mid-build
// failure never leaves partial fixture rows behind.
const buildFixture = (token) => knex.transaction(async (knex) => {
  const admin = await knex("erp.users").select("id").where({ username: "admin" }).first();
  assert(admin, "Expected an admin user to exist.");
  const branch = await knex("erp.branches").select("id").orderBy("id", "asc").first();
  const uom = await knex("erp.uom").select("id").where({ is_active: true }).orderBy("id", "asc").first();
  const uom2 = await knex("erp.uom").select("id").where({ is_active: true }).whereNot("id", uom.id).orderBy("id", "asc").first();
  // A third, distinct uom for B's independent edit, so a correctly-ignored
  // conflict (B keeps its own value) is never indistinguishable from an
  // incorrectly-applied one (B ends up with the parent's new value).
  const uom3 = await knex("erp.uom").select("id").where({ is_active: true }).whereNotIn("id", [uom.id, uom2.id]).orderBy("id", "asc").first();
  assert(uom3, "Expected at least 3 active UOMs for the cascade conflict test.");
  const pairUom = await knex("erp.uom").select("id").whereRaw("is_active = true AND (UPPER(code)='PAIR' OR UPPER(name)='PAIR')").first();
  const productionUomId = Number(pairUom?.id || uom.id);
  const dept = await knex("erp.departments").select("id").where({ is_active: true, is_production: true }).orderBy("id", "asc").first();
  const group = await knex("erp.product_groups").select("id").where({ is_active: true }).orderBy("id", "asc").first();
  const size = await knex("erp.sizes").select("id").where({ is_active: true }).orderBy("id", "asc").first();
  const color = await knex("erp.colors").select("id").where({ is_active: true }).orderBy("id", "asc").first();
  const packing = await knex("erp.packing_types").select("id").where({ is_active: true }).orderBy("id", "asc").first();
  assert(branch && uom && uom2 && dept && group && size && color && packing, "Missing base master data for cascade fixture.");

  const insertRmItem = async (suffix, rate) => {
    const [inserted] = await knex("erp.items")
      .insert({
        item_type: "RM",
        code: `e2e_casc_rm_${suffix}_${token}`.slice(0, 80),
        name: `E2E Cascade RM ${suffix} ${token}`,
        group_id: group.id,
        base_uom_id: uom.id,
        created_by: admin.id,
      })
      .returning(["id"]);
    const id = Number(inserted?.id || inserted);
    await knex("erp.rm_purchase_rates").insert({
      rm_item_id: id,
      color_id: null,
      purchase_rate: rate,
      avg_purchase_rate: rate,
      is_active: true,
      created_by: admin.id,
    });
    return id;
  };
  const rmShared = await insertRmItem("shared", 10);
  const rmNew = await insertRmItem("new", 4);
  // Copied everywhere and never touched by anyone - keeps every dependent's
  // rm_lines section "eligible" (at least one 'copied'-origin row) even
  // though rmShared itself gets edited/updated, matching the accepted v1
  // limitation that a section with zero remaining 'copied' rows looks
  // indistinguishable from "never copied".
  const rmStable = await insertRmItem("stable", 2);

  const insertArticle = async (suffix) => {
    const [itemInserted] = await knex("erp.items")
      .insert({
        item_type: "FG",
        code: `e2e_casc_${suffix}_${token}`.slice(0, 80),
        name: `E2E Cascade ${suffix} ${token}`,
        group_id: group.id,
        base_uom_id: productionUomId,
        uses_sfg: false,
        created_by: admin.id,
      })
      .returning(["id"]);
    const itemId = Number(itemInserted?.id || itemInserted);
    const [variantInserted] = await knex("erp.variants")
      .insert({
        item_id: itemId,
        size_id: size.id,
        color_id: color.id,
        packing_type_id: packing.id,
        sale_rate: 100,
        is_active: true,
        created_by: admin.id,
      })
      .returning(["id"]);
    const variantId = Number(variantInserted?.id || variantInserted);
    const [skuInserted] = await knex("erp.skus")
      .insert({ variant_id: variantId, sku_code: `E2E-CASC-${suffix}-${token}`.slice(0, 80), is_active: true })
      .returning(["id"]);
    const skuId = Number(skuInserted?.id || skuInserted);
    return { itemId, variantId, skuId };
  };

  const articleA = await insertArticle("A");
  const articleB = await insertArticle("B");
  const articleC = await insertArticle("C");

  const insertApprovedBom = async ({ itemId, bomNoSuffix, rmLines, skuOverrides, copiedFromBomId = null, versionNo = 1 }) => {
    const [bomInserted] = await knex("erp.bom_header")
      .insert({
        bom_no: `E2E-CASCBOM-${bomNoSuffix}-${token}`.slice(0, 120),
        item_id: itemId,
        level: "FINISHED",
        output_qty: 1,
        output_uom_id: productionUomId,
        status: "APPROVED",
        version_no: versionNo,
        created_by: admin.id,
        approved_by: admin.id,
        approved_at: knex.fn.now(),
        copied_from_bom_id: copiedFromBomId,
      })
      .returning(["id"]);
    const bomId = Number(bomInserted?.id || bomInserted);
    if (rmLines.length) {
      await knex("erp.bom_rm_line").insert(
        rmLines.map((line) => ({ bom_id: bomId, color_id: null, size_id: null, ...line })),
      );
    }
    if (skuOverrides.length) {
      await knex("erp.bom_sku_override_line").insert(
        skuOverrides.map((row) => ({ bom_id: bomId, is_excluded: false, override_uom_id: uom.id, ...row })),
      );
    }
    return bomId;
  };

  const bomA1 = await insertApprovedBom({
    itemId: articleA.itemId,
    bomNoSuffix: "A1",
    rmLines: [
      { rm_item_id: rmShared, dept_id: dept.id, qty: 10, uom_id: uom.id, normal_loss_pct: 0 },
      { rm_item_id: rmStable, dept_id: dept.id, qty: 1, uom_id: uom.id, normal_loss_pct: 0 },
    ],
    skuOverrides: [
      { sku_id: articleA.skuId, target_rm_item_id: rmShared, dept_id: dept.id, override_qty: 5 },
      { sku_id: articleA.skuId, target_rm_item_id: rmStable, dept_id: dept.id, override_qty: 1 },
    ],
  });

  const bomB1 = await insertApprovedBom({
    itemId: articleB.itemId,
    bomNoSuffix: "B1",
    rmLines: [
      { rm_item_id: rmShared, dept_id: dept.id, qty: 5, uom_id: uom.id, normal_loss_pct: 0 },
      { rm_item_id: rmStable, dept_id: dept.id, qty: 1, uom_id: uom.id, normal_loss_pct: 0 },
    ],
    skuOverrides: [
      { sku_id: articleB.skuId, target_rm_item_id: rmShared, dept_id: dept.id, override_qty: 5 },
      { sku_id: articleB.skuId, target_rm_item_id: rmStable, dept_id: dept.id, override_qty: 1 },
    ],
    copiedFromBomId: bomA1,
  });
  const bomC1 = await insertApprovedBom({
    itemId: articleC.itemId,
    bomNoSuffix: "C1",
    rmLines: [
      { rm_item_id: rmShared, dept_id: dept.id, qty: 5, uom_id: uom.id, normal_loss_pct: 0 },
      { rm_item_id: rmStable, dept_id: dept.id, qty: 1, uom_id: uom.id, normal_loss_pct: 0 },
    ],
    skuOverrides: [
      { sku_id: articleC.skuId, target_rm_item_id: rmShared, dept_id: dept.id, override_qty: 5 },
      { sku_id: articleC.skuId, target_rm_item_id: rmStable, dept_id: dept.id, override_qty: 1 },
    ],
    copiedFromBomId: bomA1,
  });

  // Simulate "the maker independently edited B's copy": change B's rm_line
  // uom and its sku_override qty. This is exactly the DB state a real hand
  // edit + save-draft + re-approve would leave behind.
  await knex("erp.bom_rm_line").where({ bom_id: bomB1, rm_item_id: rmShared, dept_id: dept.id }).update({ uom_id: uom3.id });
  await knex("erp.bom_sku_override_line")
    .where({ bom_id: bomB1, sku_id: articleB.skuId, target_rm_item_id: rmShared, dept_id: dept.id })
    .update({ override_qty: 99 });

  // Parent A v2: update rmShared's uom (same identity key - triggers UPDATE),
  // and add a brand-new rmNew line + matching sku override (triggers ADD).
  const bomA2 = await insertApprovedBom({
    itemId: articleA.itemId,
    bomNoSuffix: "A2",
    versionNo: 2,
    rmLines: [
      { rm_item_id: rmShared, dept_id: dept.id, qty: 10, uom_id: uom2.id, normal_loss_pct: 0 },
      { rm_item_id: rmStable, dept_id: dept.id, qty: 1, uom_id: uom.id, normal_loss_pct: 0 },
      { rm_item_id: rmNew, dept_id: dept.id, qty: 3, uom_id: uom.id, normal_loss_pct: 0 },
    ],
    skuOverrides: [
      { sku_id: articleA.skuId, target_rm_item_id: rmShared, dept_id: dept.id, override_qty: 8 },
      { sku_id: articleA.skuId, target_rm_item_id: rmStable, dept_id: dept.id, override_qty: 1 },
      { sku_id: articleA.skuId, target_rm_item_id: rmNew, dept_id: dept.id, override_qty: 3 },
    ],
  });
  return {
    admin, dept, rmShared, rmNew, rmStable,
    articleA, articleB, articleC,
    bomA1, bomA2, bomB1, bomC1,
    createdItemIds: [articleA.itemId, articleB.itemId, articleC.itemId, rmShared, rmNew, rmStable],
    createdSkuIds: [articleA.skuId, articleB.skuId, articleC.skuId],
    createdVariantIds: [articleA.variantId, articleB.variantId, articleC.variantId],
    createdBomIds: [bomA1, bomA2, bomB1, bomC1],
  };
});

const cleanupFixture = async (fixture, extraBomIds = []) => {
  if (!fixture) return;
  const bomIds = [...new Set([...(fixture.createdBomIds || []), ...extraBomIds])];
  if (bomIds.length) {
    await knex("erp.bom_change_log").whereIn("bom_id", bomIds).del();
    await knex("erp.bom_sku_override_line").whereIn("bom_id", bomIds).del();
    await knex("erp.bom_stage_routing").whereIn("bom_id", bomIds).del();
    await knex("erp.bom_rm_line").whereIn("bom_id", bomIds).del();
    await knex("erp.bom_header").whereIn("id", bomIds).del();
  }
  if (fixture.createdSkuIds?.length) await knex("erp.skus").whereIn("id", fixture.createdSkuIds).del();
  if (fixture.createdVariantIds?.length) await knex("erp.variants").whereIn("id", fixture.createdVariantIds).del();
  if (fixture.rmShared) await knex("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmShared }).del();
  if (fixture.rmNew) await knex("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmNew }).del();
  if (fixture.rmStable) await knex("erp.rm_purchase_rates").where({ rm_item_id: fixture.rmStable }).del();
  if (fixture.createdItemIds?.length) await knex("erp.items").whereIn("id", fixture.createdItemIds).del();
};

const runDbScenario = async () => {
  const token = `${Date.now()}`.slice(-8);
  let fixture = null;
  const extraBomIds = [];
  try {
    fixture = await buildFixture(token);

    // --- Dependent C (fully unedited): everything should be classified safe.
    const planC = await bomCascadeService.computeDependentMergePlan(knex, {
      dependentApprovedBomId: fixture.bomC1,
      parentNewBomId: fixture.bomA2,
    });
    assert(planC.eligible, `Plan for C should be eligible (reason=${planC.reason}).`);
    const cRmSafeKeys = planC.sections.rm_lines.safe.map((e) => e.action);
    assert(cRmSafeKeys.includes("update"), "C's unedited RM line should be classified as a safe update.");
    assert(cRmSafeKeys.includes("add"), "The parent's new RM line should be a safe add for C.");
    assert(planC.sections.rm_lines.conflicts.length === 0, "C should have no RM conflicts (nothing edited).");
    assert(
      planC.sections.sku_overrides.safe.some((e) => e.action === "update"),
      "C's unedited SKU override should be a safe update.",
    );
    assert(
      planC.sections.sku_overrides.safe.some((e) => e.action === "add"),
      "The parent's new SKU override should be a safe add for C.",
    );

    // --- Dependent B (independently edited): the shared line must conflict.
    const planB = await bomCascadeService.computeDependentMergePlan(knex, {
      dependentApprovedBomId: fixture.bomB1,
      parentNewBomId: fixture.bomA2,
    });
    assert(planB.eligible, "Plan for B should be eligible.");
    assert(planB.sections.rm_lines.conflicts.length === 1, "B's edited RM line must be a conflict, not safe.");
    assert(
      planB.sections.rm_lines.safe.some((e) => e.action === "add"),
      "The brand-new RM line is independent of B's edit and should still be a safe add.",
    );
    assert(planB.sections.sku_overrides.conflicts.length === 1, "B's edited SKU override must be a conflict.");
    assert(planB.hasAnyConflict, "hasAnyConflict should be true for B.");

    console.log("[test-bom-cascade] Part B.1 (computeDependentMergePlan classification) PASS");

    // --- Apply the cascade for C (nothing conflicting - apply everything safe).
    const cSelected = {
      rm_lines: planC.sections.rm_lines.safe.map((e) => e.key),
      sku_overrides: planC.sections.sku_overrides.safe.map((e) => e.key),
      stage_routes: [],
      sfg_lines: [],
    };
    const resultC = await bomCascadeService.createCascadeDraft(knex, {
      dependentApprovedBomId: fixture.bomC1,
      parentNewBomId: fixture.bomA2,
      selectedKeysBySection: cSelected,
      userId: fixture.admin.id,
      t: (key) => key,
    });
    extraBomIds.push(resultC.id);
    assert(resultC.appliedCount === cSelected.rm_lines.length + cSelected.sku_overrides.length, "appliedCount should match the selected keys.");

    const cNewHeader = await knex("erp.bom_header").where({ id: resultC.id }).first();
    assert(cNewHeader.status === "DRAFT", "Cascade should create a DRAFT, never an approved BOM directly.");
    assert(Number(cNewHeader.copied_from_bom_id) === Number(fixture.bomA2), "The new draft should re-anchor copied_from_bom_id to the parent's new version.");
    const cNewRmLines = await knex("erp.bom_rm_line").where({ bom_id: resultC.id });
    const cSharedLine = cNewRmLines.find((r) => Number(r.rm_item_id) === fixture.rmShared);
    const parentSharedLine = await knex("erp.bom_rm_line")
      .where({ bom_id: fixture.bomA2, rm_item_id: fixture.rmShared })
      .first();
    assert(
      Number(cSharedLine.uom_id) === Number(parentSharedLine.uom_id),
      "C's cascaded RM line should now have the parent's new uom_id.",
    );
    assert(cNewRmLines.some((r) => Number(r.rm_item_id) === fixture.rmNew), "C's cascade draft should include the newly added RM line.");
    const cChangeLogRows = await knex("erp.bom_change_log").where({ bom_id: resultC.id });
    assert(cChangeLogRows.length > 0, "Cascade draft creation should produce bom_change_log rows.");

    console.log("[test-bom-cascade] Part B.2 (createCascadeDraft applies safe changes, re-anchors provenance) PASS");

    // --- Apply the cascade for B, deliberately including the conflicting
    // key in the request (simulating a stale/tampered client) - it must be
    // silently dropped, never applied.
    const bTamperedSelected = {
      rm_lines: [...planB.sections.rm_lines.safe.map((e) => e.key), ...planB.sections.rm_lines.conflicts.map((e) => e.key)],
      sku_overrides: [],
      stage_routes: [],
      sfg_lines: [],
    };
    const resultB = await bomCascadeService.createCascadeDraft(knex, {
      dependentApprovedBomId: fixture.bomB1,
      parentNewBomId: fixture.bomA2,
      selectedKeysBySection: bTamperedSelected,
      userId: fixture.admin.id,
      t: (key) => key,
    });
    extraBomIds.push(resultB.id);
    const bNewRmLines = await knex("erp.bom_rm_line").where({ bom_id: resultB.id });
    const bSharedLine = bNewRmLines.find((r) => Number(r.rm_item_id) === fixture.rmShared);
    const parentSharedLineForB = await knex("erp.bom_rm_line")
      .where({ bom_id: fixture.bomA2, rm_item_id: fixture.rmShared })
      .first();
    assert(
      Number(bSharedLine.uom_id) !== Number(parentSharedLineForB.uom_id),
      "Even if a tampered request asks for it, a conflicting line must never be overwritten.",
    );
    assert(bNewRmLines.some((r) => Number(r.rm_item_id) === fixture.rmNew), "The safe add should still apply for B despite the unrelated conflict.");

    console.log("[test-bom-cascade] Part B.3 (conflict keys are never applied, even if requested) PASS");

    // --- Draft-uniqueness guard: a second cascade attempt for C (which now
    // has an open DRAFT from resultC) must be rejected, not silently
    // duplicated.
    let guardError = null;
    try {
      await bomCascadeService.createCascadeDraft(knex, {
        dependentApprovedBomId: fixture.bomC1,
        parentNewBomId: fixture.bomA2,
        selectedKeysBySection: cSelected,
        userId: fixture.admin.id,
        t: (key) => key,
      });
    } catch (err) {
      guardError = err;
    }
    assert(guardError && guardError.code === "BOM_CASCADE_DRAFT_EXISTS", "Creating a second cascade draft while one is open must throw BOM_CASCADE_DRAFT_EXISTS.");

    console.log("[test-bom-cascade] Part B.4 (draft-uniqueness guard) PASS");

    // --- listCascadeCandidates summary sanity check.
    const candidates = await bomCascadeService.listCascadeCandidates(knex, {
      itemId: fixture.articleA.itemId,
      level: "FINISHED",
      parentNewBomId: fixture.bomA2,
    });
    const candidateB = candidates.find((c) => Number(c.item_id) === fixture.articleB.itemId);
    assert(candidateB && candidateB.hasActiveDraft, "B should now show as having an active draft in the candidates list.");

    console.log("[test-bom-cascade] Part B.5 (listCascadeCandidates) PASS");
  } finally {
    await cleanupFixture(fixture, extraBomIds);
  }
};

// ---------------------------------------------------------------------------
// Part C: light HTTP smoke test for the 3 new routes
// ---------------------------------------------------------------------------
const runHttpSmokeTest = async () => {
  const token = `http${Date.now()}`.slice(-10);
  let fixture = null;
  const extraBomIds = [];
  try {
    fixture = await buildFixture(token);
    await loginIfNeeded();

    const listRes = await request(
      `/master-data/bom/cascade?parent_item_id=${fixture.articleA.itemId}&level=FINISHED&parent_bom_id=${fixture.bomA2}`,
    );
    assert(listRes.status === 200, `Cascade list page should return 200, got ${listRes.status}`);
    const listHtml = await listRes.text();
    assert(listHtml.includes("Review dependent BOM updates") || listHtml.includes("bom_cascade_review_title"), "List page should render the review title.");

    const detailRes = await request(
      `/master-data/bom/cascade/${fixture.bomB1}?parent_bom_id=${fixture.bomA2}`,
    );
    assert(detailRes.status === 200, `Cascade detail page should return 200, got ${detailRes.status}`);
    const detailHtml = await detailRes.text();
    const csrf = extractCsrf(detailHtml);
    assert(Boolean(csrf), "Detail page should expose a csrf token.");

    console.log("[test-bom-cascade] Part C (HTTP smoke test) PASS");
  } finally {
    await cleanupFixture(fixture, extraBomIds);
  }
};

async function run() {
  try {
    console.log("[test-bom-cascade] start");
    runPureUnitTests();
    await runDbScenario();
    await runHttpSmokeTest();
    console.log("[test-bom-cascade] PASS");
  } catch (err) {
    console.error("[test-bom-cascade] FAIL", err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
}

run();
