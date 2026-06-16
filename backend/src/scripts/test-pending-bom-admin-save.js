require("dotenv").config();
const knex = require("../db/knex");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const cookieJar = new Map();

const storeCookies = (res) => {
  const headers = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  headers.forEach((raw) => {
    const part = raw.split(";")[0];
    const idx = part.indexOf("=");
    if (idx > 0) cookieJar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  });
};

const cookieStr = () =>
  Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");

const req = async (path, opts = {}) => {
  const h = { ...(opts.headers || {}) };
  const jar = cookieStr();
  if (jar) h.Cookie = jar;
  const r = await fetch(BASE + path, { redirect: "manual", ...opts, headers: h });
  storeCookies(r);
  return r;
};

const extractCsrf = (html) => {
  const m1 = html.match(/name="?_csrf"?[^>]*value="?([^">\s]+)"?/i);
  if (m1) return m1[1];
  const m2 = html.match(/value="?([^">\s]+)"?[^>]*name="?_csrf"?/i);
  return m2 ? m2[1] : "";
};

const pass = (msg) => console.log(`  PASS: ${msg}`);
const assert = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  pass(msg);
};

async function run() {
  console.log("\n[test-pending-bom-admin-save] start\n");

  // LOGIN
  const lp = await req("/auth/login");
  const lHtml = await lp.text();
  const lCsrf = extractCsrf(lHtml);
  assert(lCsrf, "Got CSRF from login page");

  const lr = await req("/auth/login", {
    method: "POST",
    body: new URLSearchParams({
      _csrf: lCsrf,
      username: process.env.E2E_ADMIN_USER || "admin",
      password: process.env.E2E_ADMIN_PASSWORD || "password",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert([302, 303].includes(lr.status), `Login redirected (status=${lr.status})`);

  // PICK A CLEAN ITEM+LEVEL (no existing DRAFT/PENDING)
  const items = await knex("erp.items")
    .select("id", "item_type", "base_uom_id")
    .whereIn("item_type", ["FG", "SFG"])
    .where({ is_active: true })
    .orderBy("id", "asc");

  const fallbackUom = (await knex("erp.uom").select("id").where({ is_active: true }).first())?.id;

  let target = null;
  for (const item of items) {
    const level = item.item_type === "FG" ? "FINISHED" : "SEMI_FINISHED";
    const existing = await knex("erp.bom_header")
      .where({ item_id: item.id, level })
      .whereIn("status", ["DRAFT", "PENDING"])
      .first();
    if (!existing) {
      target = { itemId: item.id, level, uomId: item.base_uom_id || fallbackUom };
      break;
    }
  }
  assert(Boolean(target), `Found a clean item+level for test BOM`);
  console.log(`    → itemId=${target.itemId}, level=${target.level}, uomId=${target.uomId}`);

  // GET NEW FORM CSRF
  const nf = await req("/master-data/bom/new");
  const nHtml = await nf.text();
  const nCsrf = extractCsrf(nHtml);
  assert(nCsrf, "Got CSRF from new BOM form");

  // CREATE DRAFT VIA HTTP
  const createPayload = new URLSearchParams({
    _csrf: nCsrf,
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

  const cr = await req("/master-data/bom/save-draft", {
    method: "POST",
    body: createPayload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const location = cr.headers.get("location") || "";
  const bomIdMatch = location.match(/\/master-data\/bom\/(\d+)/);
  if (![302, 303].includes(cr.status) || !bomIdMatch) {
    const errHtml = [200].includes(cr.status) ? await cr.text() : "";
    const snippet = errHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    throw new Error(`Create draft returned ${cr.status}, location="${location}"${snippet ? "\nBody: " + snippet : ""}`);
  }
  const bomId = Number(bomIdMatch[1]);
  pass(`Create draft redirected → BOM id=${bomId}`);

  // FORCE BOM TO PENDING (simulates non-admin send-for-approval)
  await knex("erp.bom_header").where({ id: bomId }).update({ status: "PENDING" });
  const adminUser = await knex("erp.users").select("id").first();
  const branch = await knex("erp.branches").select("id").first();
  const fakeApprovalRows = await knex("erp.approval_request")
    .insert({
      branch_id: branch?.id,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "BOM",
      entity_id: String(bomId),
      status: "PENDING",
      requested_by: adminUser?.id,
      summary: "Test: fake pending approval for admin-save test",
      new_value: JSON.stringify({ schema_version: 1, _action: "approve_draft", bom_id: bomId }),
    })
    .returning("id");
  const fakeApprovalId = fakeApprovalRows[0]?.id || fakeApprovalRows[0];
  pass(`Forced BOM ${bomId} to PENDING + inserted fake approval_request id=${fakeApprovalId}`);

  // PRE-CONDITIONS
  const bomBefore = await knex("erp.bom_header").where({ id: bomId }).select("status", "output_qty").first();
  assert(bomBefore.status === "PENDING", `Pre-condition: BOM status is PENDING`);
  const approvalBefore = await knex("erp.approval_request").where({ id: fakeApprovalId }).select("status").first();
  assert(approvalBefore.status === "PENDING", `Pre-condition: approval_request is PENDING`);

  // ADMIN SAVES THE PENDING BOM VIA HTTP
  const ef = await req(`/master-data/bom/${bomId}`);
  const eHtml = await ef.text();
  const eCsrf = extractCsrf(eHtml);
  assert(eCsrf, "Got CSRF from edit form for PENDING BOM");

  const editPayload = new URLSearchParams({
    _csrf: eCsrf,
    item_id: String(target.itemId),
    level: target.level,
    output_qty: "2",
    output_uom_id: String(target.uomId),
    rm_lines_json: "[]",
    sfg_lines_json: "[]",
    labour_lines_json: "[]",
    variant_rules_json: "[]",
    stage_routes_json: "[]",
  });

  const saveRes = await req(`/master-data/bom/${bomId}/save-draft`, {
    method: "POST",
    body: editPayload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (![302, 303].includes(saveRes.status)) {
    const errHtml = await saveRes.text();
    const snippet = errHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    throw new Error(`Admin save of PENDING BOM got ${saveRes.status}\nBody: ${snippet}`);
  }
  pass(`Admin save of PENDING BOM redirected (status=${saveRes.status})`);

  // KEY ASSERTIONS
  const bomAfter = await knex("erp.bom_header").where({ id: bomId }).select("status", "output_qty").first();
  assert(
    bomAfter.status === "PENDING",
    `BOM status remained PENDING after admin save (got "${bomAfter.status}")`
  );
  assert(
    Number(bomAfter.output_qty) === 2,
    `BOM content updated: output_qty=${bomAfter.output_qty} (expected 2)`
  );

  const approvalAfter = await knex("erp.approval_request").where({ id: fakeApprovalId }).select("status").first();
  assert(
    approvalAfter.status === "PENDING",
    `approval_request remained PENDING after admin save (got "${approvalAfter.status}")`
  );

  // ALSO TEST: Admin APPROVING a PENDING BOM still works (should reset to DRAFT then approve)
  const ef2 = await req(`/master-data/bom/${bomId}`);
  const eHtml2 = await ef2.text();
  const eCsrf2 = extractCsrf(eHtml2);
  assert(eCsrf2, "Got CSRF for approve flow");

  const approvePayload = new URLSearchParams({
    _csrf: eCsrf2,
    item_id: String(target.itemId),
    level: target.level,
    output_qty: "2",
    output_uom_id: String(target.uomId),
    rm_lines_json: "[]",
    sfg_lines_json: "[]",
    labour_lines_json: "[]",
    variant_rules_json: "[]",
    stage_routes_json: "[]",
  });

  const approveRes = await req(`/master-data/bom/${bomId}/approve-draft`, {
    method: "POST",
    body: approvePayload.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert(
    [302, 303].includes(approveRes.status),
    `Admin approve of PENDING BOM redirected (status=${approveRes.status})`
  );

  const bomApproved = await knex("erp.bom_header").where({ id: bomId }).select("status").first();
  assert(bomApproved.status === "APPROVED", `BOM is APPROVED after admin approve-draft (got "${bomApproved.status}")`);

  const approvalRejected = await knex("erp.approval_request").where({ id: fakeApprovalId }).select("status").first();
  assert(
    approvalRejected.status === "REJECTED",
    `approval_request was REJECTED during approve-draft flow (got "${approvalRejected.status}")`
  );

  console.log("\n  ALL TESTS PASSED\n");
  console.log("  Summary:");
  console.log("  - Admin save-draft on PENDING BOM: preserves PENDING status, keeps approval_request intact");
  console.log("  - Admin approve-draft on PENDING BOM: transitions to APPROVED, rejects old approval_request");

  // CLEANUP
  await knex("erp.approval_request").where({ id: fakeApprovalId }).delete().catch(() => {});
  await knex("erp.bom_change_log").where({ bom_id: bomId }).delete().catch(() => {});
  await knex("erp.bom_stage_routing").where({ bom_id: bomId }).delete().catch(() => {});
  await knex("erp.bom_rm_lines").where({ bom_id: bomId }).delete().catch(() => {});
  await knex("erp.bom_sfg_lines").where({ bom_id: bomId }).delete().catch(() => {});
  await knex("erp.bom_labour_lines").where({ bom_id: bomId }).delete().catch(() => {});
  await knex("erp.bom_variant_rules").where({ bom_id: bomId }).delete().catch(() => {});
  await knex("erp.bom_sku_overrides").where({ bom_id: bomId }).delete().catch(() => {});
  await knex("erp.bom_header").where({ id: bomId }).delete();
  console.log("  Cleanup done");
}

run()
  .catch((err) => {
    console.error("\n" + (err.message || err));
    process.exit(1);
  })
  .finally(() => knex.destroy());
