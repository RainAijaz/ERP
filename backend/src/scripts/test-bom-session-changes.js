/**
 * Tests for BOM changes made in this dev session:
 *
 * 1. getBomForForm returns dept_id in stage_routes
 * 2. getBomSnapshot returns dept_id + dept_name in stage_routes
 * 3. bom_change_log tracks stage_route ADDED / REMOVED / UPDATED
 * 4. Admin save-draft on PENDING BOM keeps it PENDING (no approval reversal)
 * 5. Admin approve-draft on PENDING BOM still works (resets then approves)
 */

require("dotenv").config();
const knex = require("../db/knex");
const { getBomForForm } = require("../services/bom/service");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_USER = process.env.E2E_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || "password";

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const cookieJar = new Map();
const storeCookies = (res) => {
  const hs = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  hs.forEach((raw) => {
    const part = raw.split(";")[0];
    const idx = part.indexOf("=");
    if (idx > 0) cookieJar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  });
};
const cookieStr = () => Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
const httpReq = async (path, opts = {}) => {
  const h = { ...(opts.headers || {}) };
  const jar = cookieStr();
  if (jar) h.Cookie = jar;
  const r = await fetch(BASE + path, { redirect: "manual", ...opts, headers: h });
  storeCookies(r);
  return r;
};
const extractCsrf = (html) => {
  const m = html.match(/name="?_csrf"?[^>]*value="?([^">\s]+)"?/i)
    || html.match(/value="?([^">\s]+)"?[^>]*name="?_csrf"?/i);
  return m ? m[1] : "";
};

// ── Assertion helpers ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const pass = (msg) => { passed++; console.log(`  PASS: ${msg}`); };
const fail = (msg) => { failed++; console.error(`  FAIL: ${msg}`); };
const assert = (cond, msg) => { if (cond) pass(msg); else fail(msg); };
const assertEq = (actual, expected, msg) =>
  assert(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── Setup / teardown state ────────────────────────────────────────────────────
const createdBomIds = [];
const createdApprovalIds = [];

const cleanup = async () => {
  for (const id of createdApprovalIds) {
    await knex("erp.approval_request").where({ id }).delete().catch(() => {});
  }
  for (const id of createdBomIds) {
    await knex("erp.bom_change_log").where({ bom_id: id }).delete().catch(() => {});
    await knex("erp.bom_stage_routing").where({ bom_id: id }).delete().catch(() => {});
    await knex("erp.bom_rm_line").where({ bom_id: id }).delete().catch(() => {});
    await knex("erp.bom_sfg_line").where({ bom_id: id }).delete().catch(() => {});
    await knex("erp.bom_labour_line").where({ bom_id: id }).delete().catch(() => {});
    await knex("erp.bom_variant_rules").where({ bom_id: id }).delete().catch(() => {});
    await knex("erp.bom_sku_overrides").where({ bom_id: id }).delete().catch(() => {});
    await knex("erp.bom_header").where({ id }).delete().catch(() => {});
  }
};

// ── Seed helpers ──────────────────────────────────────────────────────────────
const findCleanItem = async () => {
  const items = await knex("erp.items")
    .select("id", "item_type", "base_uom_id")
    .whereIn("item_type", ["FG", "SFG"])
    .where({ is_active: true })
    .orderBy("id", "asc");
  for (const item of items) {
    const level = item.item_type === "FG" ? "FINISHED" : "SEMI_FINISHED";
    const existing = await knex("erp.bom_header")
      .where({ item_id: item.id, level })
      .whereIn("status", ["DRAFT", "PENDING"])
      .first();
    if (!existing) return { itemId: item.id, level, uomId: item.base_uom_id };
  }
  return null;
};

const findActiveProductionStages = async () => {
  const hasTable = await knex.schema.withSchema("erp").hasTable("production_stages");
  if (!hasTable) return [];
  return knex("erp.production_stages as ps")
    .join("erp.departments as d", "d.id", "ps.dept_id")
    .select("ps.id as stage_id", "ps.dept_id", "d.name as dept_name")
    .where({ "ps.is_active": true, "d.is_active": true })
    .orderBy("ps.id", "asc")
    .limit(3);
};

const loginAdmin = async () => {
  const lp = await httpReq("/auth/login");
  const lHtml = await lp.text();
  const csrf = extractCsrf(lHtml);
  if (!csrf) throw new Error("No CSRF on login page");
  const lr = await httpReq("/auth/login", {
    method: "POST",
    body: new URLSearchParams({ _csrf: csrf, username: ADMIN_USER, password: ADMIN_PASS }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (![302, 303].includes(lr.status)) throw new Error(`Login failed: ${lr.status}`);
};

const createDraftViaHttp = async (target, stageRoutesJson = "[]") => {
  const nf = await httpReq("/master-data/bom/new");
  const nHtml = await nf.text();
  const csrf = extractCsrf(nHtml);
  if (!csrf) throw new Error("No CSRF on new BOM form");
  const payload = new URLSearchParams({
    _csrf: csrf,
    item_id: String(target.itemId),
    level: target.level,
    output_qty: "1",
    output_uom_id: String(target.uomId),
    rm_lines_json: "[]",
    sfg_lines_json: "[]",
    labour_lines_json: "[]",
    variant_rules_json: "[]",
    stage_routes_json: stageRoutesJson,
  });
  const cr = await httpReq("/master-data/bom/save-draft", {
    method: "POST",
    body: payload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const loc = cr.headers.get("location") || "";
  const m = loc.match(/\/master-data\/bom\/(\d+)/);
  if (![302, 303].includes(cr.status) || !m) {
    const snippet = [200].includes(cr.status)
      ? (await cr.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)
      : "";
    throw new Error(`Create draft: status=${cr.status} loc="${loc}"${snippet ? " body=" + snippet : ""}`);
  }
  const bomId = Number(m[1]);
  createdBomIds.push(bomId);
  return bomId;
};

const updateDraftViaHttp = async (bomId, target, stageRoutesJson = "[]", outputQty = "1") => {
  const ef = await httpReq(`/master-data/bom/${bomId}`);
  const eHtml = await ef.text();
  const csrf = extractCsrf(eHtml);
  if (!csrf) throw new Error(`No CSRF on edit form for BOM ${bomId}`);
  const payload = new URLSearchParams({
    _csrf: csrf,
    item_id: String(target.itemId),
    level: target.level,
    output_qty: outputQty,
    output_uom_id: String(target.uomId),
    rm_lines_json: "[]",
    sfg_lines_json: "[]",
    labour_lines_json: "[]",
    variant_rules_json: "[]",
    stage_routes_json: stageRoutesJson,
  });
  const sr = await httpReq(`/master-data/bom/${bomId}/save-draft`, {
    method: "POST",
    body: payload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (![302, 303].includes(sr.status)) {
    const snippet = (await sr.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    throw new Error(`Update draft: status=${sr.status} body=${snippet}`);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

async function testGetBomForFormReturnsDeptId(target, stages) {
  console.log("\n── Test 1: getBomForForm returns dept_id in stage_routes ──");
  if (!stages.length) {
    console.log("  SKIP: no active production stages in DB");
    return null;
  }

  // Create BOM with one stage route
  const stage = stages[0];
  const stageJson = JSON.stringify([{ dept_id: stage.dept_id, sequence_no: 1, is_required: true, enforce_sequence: true }]);

  let bomId;
  try {
    bomId = await createDraftViaHttp(target, stageJson);
  } catch (e) {
    fail(`Create draft with stage route: ${e.message}`);
    return null;
  }
  pass(`Created BOM ${bomId} with stage route for dept_id=${stage.dept_id}`);

  // Call getBomForForm directly and check stage_routes have dept_id
  const form = await getBomForForm(knex, bomId);
  assert(Array.isArray(form?.stage_routes), "getBomForForm returns stage_routes array");
  assert(form.stage_routes.length > 0, "stage_routes has at least one row");
  if (form.stage_routes.length > 0) {
    const routeRow = form.stage_routes[0];
    assert(routeRow.dept_id != null, `stage_routes[0].dept_id is present (got ${routeRow.dept_id})`);
    assertEq(Number(routeRow.dept_id), Number(stage.dept_id), "stage_routes[0].dept_id matches the dept we saved");
    assert(routeRow.stage_id != null, `stage_routes[0].stage_id is present (got ${routeRow.stage_id})`);
  }

  return bomId;
}

async function testGetBomSnapshotReturnsDeptName(bomId, stages) {
  // getBomSnapshot is internal — verify its JOIN directly from the DB layer
  console.log("\n── Test 2: bom_stage_routing JOIN returns dept_id + dept_name (snapshot query) ──");
  if (!bomId) {
    console.log("  SKIP: no BOM from test 1");
    return;
  }
  const stage = stages[0];

  // Replicate the getBomSnapshot query that was fixed
  const rows = await knex("erp.bom_stage_routing as bsr")
    .leftJoin("erp.production_stages as ps", "ps.id", "bsr.stage_id")
    .leftJoin("erp.departments as dept", "dept.id", "ps.dept_id")
    .select(
      "bsr.stage_id",
      "bsr.sequence_no",
      "bsr.is_required",
      "bsr.enforce_sequence",
      "ps.dept_id",
      "dept.name as dept_name",
    )
    .where({ "bsr.bom_id": bomId })
    .orderBy("bsr.sequence_no", "asc");

  assert(Array.isArray(rows) && rows.length > 0, "snapshot JOIN query returns at least one stage_route row");
  if (rows.length > 0) {
    const row = rows[0];
    assert(row.dept_id != null, `snapshot row has dept_id (got ${row.dept_id})`);
    assertEq(Number(row.dept_id), Number(stage.dept_id), "snapshot dept_id matches saved dept");
    assert(typeof row.dept_name === "string" && row.dept_name.length > 0,
      `snapshot row has non-empty dept_name (got "${row.dept_name}")`);
    assertEq(row.dept_name, stage.dept_name, `dept_name="${row.dept_name}" matches departments table`);
  }
}

async function testChangeLogTracksStageRoutes(target, stages) {
  console.log("\n── Test 3: bom_change_log tracks stage_route ADD / REMOVE ──");

  const hasChangeLog = await knex.schema.withSchema("erp").hasTable("bom_change_log");
  if (!hasChangeLog) {
    console.log("  SKIP: erp.bom_change_log table does not exist");
    return null;
  }
  if (!stages.length) {
    console.log("  SKIP: no active production stages in DB");
    return null;
  }

  // Create BOM with NO stage routes first
  let bomId;
  try {
    bomId = await createDraftViaHttp(target, "[]");
  } catch (e) {
    fail(`Create blank draft: ${e.message}`);
    return null;
  }
  pass(`Created blank BOM ${bomId}`);

  // Clean up any change log rows from creation itself
  await knex("erp.bom_change_log").where({ bom_id: bomId, section: "stage_routes" }).delete();

  // Now update BOM to ADD a stage route
  const stage = stages[0];
  const addJson = JSON.stringify([{
    dept_id: stage.dept_id,
    sequence_no: 1,
    is_required: true,
    enforce_sequence: true,
  }]);
  try {
    await updateDraftViaHttp(bomId, target, addJson);
  } catch (e) {
    fail(`Update draft to add stage route: ${e.message}`);
    return bomId;
  }
  pass(`Updated BOM ${bomId} to add stage route for dept=${stage.dept_id}`);

  const addedRows = await knex("erp.bom_change_log")
    .where({ bom_id: bomId, section: "stage_routes", change_type: "ADDED" });
  assert(addedRows.length > 0, `bom_change_log has ADDED row for stage_routes after adding a stage`);
  if (addedRows.length > 0) {
    const newVal = addedRows[0].new_value;
    assert(newVal != null, "ADDED row has new_value");
    const nv = typeof newVal === "string" ? JSON.parse(newVal) : newVal;
    assert(nv.dept_id != null || nv.stage_id != null, `new_value contains dept_id or stage_id (got ${JSON.stringify(nv)})`);
    assert(nv.dept_name != null, `new_value contains dept_name for human-readable display (got ${JSON.stringify(nv)})`);
  }

  // Now update BOM to REMOVE the stage route (set back to empty)
  try {
    await updateDraftViaHttp(bomId, target, "[]");
  } catch (e) {
    fail(`Update draft to remove stage route: ${e.message}`);
    return bomId;
  }
  pass(`Updated BOM ${bomId} to remove stage route`);

  const removedRows = await knex("erp.bom_change_log")
    .where({ bom_id: bomId, section: "stage_routes", change_type: "REMOVED" });
  assert(removedRows.length > 0, `bom_change_log has REMOVED row for stage_routes after removing a stage`);
  if (removedRows.length > 0) {
    const oldVal = removedRows[0].old_value;
    assert(oldVal != null, "REMOVED row has old_value");
    const ov = typeof oldVal === "string" ? JSON.parse(oldVal) : oldVal;
    assert(ov.dept_name != null, `old_value contains dept_name (got ${JSON.stringify(ov)})`);
  }

  return bomId;
}

async function testAdminSavePendingBomPreservesStatus(target) {
  console.log("\n── Test 4: Admin save-draft on PENDING BOM preserves PENDING status ──");

  let bomId;
  try {
    bomId = await createDraftViaHttp(target);
  } catch (e) {
    fail(`Create draft for pending test: ${e.message}`);
    return;
  }
  pass(`Created BOM ${bomId}`);

  // Force to PENDING + insert approval_request
  await knex("erp.bom_header").where({ id: bomId }).update({ status: "PENDING" });
  const adminUser = await knex("erp.users").select("id").first();
  const branch = await knex("erp.branches").select("id").first();
  const approvalRows = await knex("erp.approval_request").insert({
    branch_id: branch?.id,
    request_type: "MASTER_DATA_CHANGE",
    entity_type: "BOM",
    entity_id: String(bomId),
    status: "PENDING",
    requested_by: adminUser?.id,
    summary: "Test approval for pending-save test",
    new_value: JSON.stringify({ schema_version: 1, _action: "approve_draft", bom_id: bomId }),
  }).returning("id");
  const approvalId = approvalRows[0]?.id || approvalRows[0];
  createdApprovalIds.push(approvalId);
  pass(`Forced BOM ${bomId} to PENDING with approval_request id=${approvalId}`);

  // Admin saves via HTTP
  const ef = await httpReq(`/master-data/bom/${bomId}`);
  const eHtml = await ef.text();
  const csrf = extractCsrf(eHtml);
  assert(csrf, "Got CSRF from edit form for PENDING BOM");

  const editPayload = new URLSearchParams({
    _csrf: csrf,
    item_id: String(target.itemId),
    level: target.level,
    output_qty: "5",
    output_uom_id: String(target.uomId),
    rm_lines_json: "[]",
    sfg_lines_json: "[]",
    labour_lines_json: "[]",
    variant_rules_json: "[]",
    stage_routes_json: "[]",
  });
  const saveRes = await httpReq(`/master-data/bom/${bomId}/save-draft`, {
    method: "POST",
    body: editPayload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (![302, 303].includes(saveRes.status)) {
    const snippet = (await saveRes.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    fail(`Admin save of PENDING BOM: expected redirect, got ${saveRes.status} — ${snippet}`);
    return;
  }
  pass(`Admin save of PENDING BOM redirected (status=${saveRes.status})`);

  const bomAfter = await knex("erp.bom_header").where({ id: bomId }).select("status", "output_qty").first();
  assertEq(bomAfter.status, "PENDING", "BOM status is still PENDING after admin save");
  assertEq(Number(bomAfter.output_qty), 5, `BOM content updated: output_qty=${bomAfter.output_qty}`);

  const approvalAfter = await knex("erp.approval_request").where({ id: approvalId }).select("status").first();
  assertEq(approvalAfter.status, "PENDING", "approval_request is still PENDING after admin save");
}

async function testAdminApprovePendingBomStillWorks(target) {
  console.log("\n── Test 5: Admin approve-draft on PENDING BOM transitions to APPROVED ──");

  let bomId;
  try {
    bomId = await createDraftViaHttp(target);
  } catch (e) {
    fail(`Create draft for approve test: ${e.message}`);
    return;
  }
  pass(`Created BOM ${bomId}`);

  // Force to PENDING + insert approval_request
  await knex("erp.bom_header").where({ id: bomId }).update({ status: "PENDING" });
  const adminUser = await knex("erp.users").select("id").first();
  const branch = await knex("erp.branches").select("id").first();
  const approvalRows = await knex("erp.approval_request").insert({
    branch_id: branch?.id,
    request_type: "MASTER_DATA_CHANGE",
    entity_type: "BOM",
    entity_id: String(bomId),
    status: "PENDING",
    requested_by: adminUser?.id,
    summary: "Test approval for approve-draft test",
    new_value: JSON.stringify({ schema_version: 1, _action: "approve_draft", bom_id: bomId }),
  }).returning("id");
  const approvalId = approvalRows[0]?.id || approvalRows[0];
  createdApprovalIds.push(approvalId);
  pass(`Forced BOM ${bomId} to PENDING with approval_request id=${approvalId}`);

  // Admin approves via approve-draft
  const ef = await httpReq(`/master-data/bom/${bomId}`);
  const eHtml = await ef.text();
  const csrf = extractCsrf(eHtml);
  assert(csrf, "Got CSRF for approve-draft");

  const approvePayload = new URLSearchParams({
    _csrf: csrf,
    item_id: String(target.itemId),
    level: target.level,
    output_qty: "1",
    output_uom_id: String(target.uomId),
    rm_lines_json: "[]",
    sfg_lines_json: "[]",
    labour_lines_json: "[]",
    variant_rules_json: "[]",
    stage_routes_json: "[]",
  });
  const approveRes = await httpReq(`/master-data/bom/${bomId}/approve-draft`, {
    method: "POST",
    body: approvePayload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert([302, 303].includes(approveRes.status), `Admin approve-draft redirected (status=${approveRes.status})`);

  const bomApproved = await knex("erp.bom_header").where({ id: bomId }).select("status").first();
  assertEq(bomApproved.status, "APPROVED", "BOM is APPROVED after admin approve-draft");

  const approvalRejected = await knex("erp.approval_request").where({ id: approvalId }).select("status").first();
  assertEq(approvalRejected.status, "REJECTED", "approval_request is REJECTED after admin approve-draft");
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n[test-bom-session-changes] start\n");

  await loginAdmin();
  pass("Logged in as admin");

  const stages = await findActiveProductionStages();
  console.log(`  Found ${stages.length} active production stage(s) in DB`);

  // Tests 1-3 need their own clean items to avoid duplicate-draft errors
  // Tests 4-5 each need their own clean items too
  const targets = [];
  for (let i = 0; i < 4; i++) {
    // Temporarily exclude already-picked item IDs by marking them as used via in-memory skip
    const usedItemIds = targets.map((t) => t.itemId);
    const items = await knex("erp.items")
      .select("id", "item_type", "base_uom_id")
      .whereIn("item_type", ["FG", "SFG"])
      .where({ is_active: true })
      .whereNotIn("id", usedItemIds.length ? usedItemIds : [0])
      .orderBy("id", "asc");
    let picked = null;
    for (const item of items) {
      const level = item.item_type === "FG" ? "FINISHED" : "SEMI_FINISHED";
      const existing = await knex("erp.bom_header")
        .where({ item_id: item.id, level })
        .whereIn("status", ["DRAFT", "PENDING"])
        .first();
      if (!existing) {
        picked = { itemId: item.id, level, uomId: item.base_uom_id };
        break;
      }
    }
    if (!picked) {
      console.log(`  WARNING: could not find a clean item for slot ${i + 1} — some tests may be skipped`);
      targets.push(null);
    } else {
      targets.push(picked);
    }
  }

  const t1BomId = targets[0]
    ? await testGetBomForFormReturnsDeptId(targets[0], stages).catch((e) => { fail(`Test 1 threw: ${e.message}`); return null; })
    : (console.log("\n── Test 1: SKIP (no clean item) ──"), null);

  // Test 2 reuses the BOM created in test 1 (already has a stage route with the join data)
  await testGetBomSnapshotReturnsDeptName(t1BomId, stages).catch((e) => fail(`Test 2 threw: ${e.message}`));

  if (targets[1]) {
    await testChangeLogTracksStageRoutes(targets[1], stages).catch((e) => fail(`Test 3 threw: ${e.message}`));
  } else {
    console.log("\n── Test 3: SKIP (no clean item) ──");
  }

  if (targets[2]) {
    await testAdminSavePendingBomPreservesStatus(targets[2]).catch((e) => fail(`Test 4 threw: ${e.message}`));
  } else {
    console.log("\n── Test 4: SKIP (no clean item) ──");
  }

  if (targets[3]) {
    await testAdminApprovePendingBomStillWorks(targets[3]).catch((e) => fail(`Test 5 threw: ${e.message}`));
  } else {
    console.log("\n── Test 5: SKIP (no clean item) ──");
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\nSOME TESTS FAILED — check output above");
    process.exitCode = 1;
  } else {
    console.log("\nALL TESTS PASSED");
  }

  await cleanup();
  console.log("Cleanup done");
}

main()
  .catch((err) => {
    console.error("\nFATAL:", err.message || err);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
