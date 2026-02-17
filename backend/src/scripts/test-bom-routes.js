require("dotenv").config();

const knex = require("../db/knex");
const { handleScreenApproval } = require("../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../utils/approval-entity-map");
const { applyApprovedBomChange } = require("../services/bom/service");

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const sessionCookieName = process.env.SESSION_COOKIE_NAME || "erp_session";
const authUsername = process.env.AUTH_USERNAME || process.env.E2E_ADMIN_USER || "";
const authPassword = process.env.AUTH_PASSWORD || process.env.E2E_ADMIN_PASSWORD || process.env.E2E_ADMIN_PASS || "";
let cookie = process.env.SESSION_COOKIE || "";
if (cookie && !cookie.includes("=")) cookie = `${sessionCookieName}=${cookie}`;

const cookieJar = new Map();

const parseSetCookie = (setCookieHeader) => {
  if (!setCookieHeader) return [];
  if (Array.isArray(setCookieHeader)) return setCookieHeader;
  return String(setCookieHeader).split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/g);
};

const storeCookies = (res) => {
  const headers = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : parseSetCookie(res.headers.get("set-cookie"));
  (headers || []).forEach((raw) => {
    const part = String(raw).split(";")[0];
    const idx = part.indexOf("=");
    if (idx <= 0) return;
    cookieJar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  });
};

const cookieHeader = () =>
  Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

const request = async (path, { method = "GET", body, headers = {}, redirect = "manual" } = {}) => {
  const finalHeaders = { ...headers };
  const jar = cookieHeader();
  if (jar) finalHeaders.Cookie = jar;
  const res = await fetch(`${baseUrl}${path}`, { method, headers: finalHeaders, body, redirect });
  storeCookies(res);
  return res;
};

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const extractCsrf = (html) => {
  const byNameFirst = html.match(/name=['"]_csrf['"][^>]*value=['"]([^'"]+)['"]/i);
  if (byNameFirst) return byNameFirst[1];
  const byValueFirst = html.match(/value=['"]([^'"]+)['"][^>]*name=['"]_csrf['"]/i);
  return byValueFirst ? byValueFirst[1] : "";
};

const extractOptions = (html, name) => {
  const selectMatch = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  if (!selectMatch) return [];
  const results = [];
  const regex = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/gi;
  let m;
  while ((m = regex.exec(selectMatch[1]))) {
    if (!m[1].trim()) continue;
    results.push({ value: m[1].trim(), label: m[2].trim() });
  }
  return results;
};

const loginIfNeeded = async () => {
  if (cookie) {
    cookie
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const idx = pair.indexOf("=");
        if (idx <= 0) return;
        cookieJar.set(pair.slice(0, idx), pair.slice(idx + 1));
      });
  }

  const home = await request("/", { redirect: "manual" });
  if (home.status !== 302) return;

  if (!authUsername || !authPassword) {
    throw new Error("No active session cookie and no AUTH_USERNAME/AUTH_PASSWORD provided.");
  }

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
    redirect: "manual",
  });
  assert([302, 303].includes(loginRes.status), `Login failed, status ${loginRes.status}`);
};

async function run() {
  const createdBomIds = [];
  const approvalIds = [];
  try {
    console.log("[test-bom-routes] start");
    await loginIfNeeded();

    const listRes = await request("/master-data/bom");
    assert(listRes.status === 200, "BOM list page should load.");

    const newRes = await request("/master-data/bom/new");
    assert(newRes.status === 200, "BOM new form page should load.");
    const newHtml = await newRes.text();
    const csrf = extractCsrf(newHtml);
    assert(Boolean(csrf), "BOM form csrf token missing.");

    const itemOptions = extractOptions(newHtml, "item_id");
    const levelOptions = extractOptions(newHtml, "level");
    const uomOptions = extractOptions(newHtml, "output_uom_id");
    assert(itemOptions.length > 0, "BOM form must expose item options.");
    assert(levelOptions.length > 0, "BOM form must expose level options.");
    assert(uomOptions.length > 0, "BOM form must expose output uom options.");

    const primaryItem = itemOptions[0].value;
    const primaryLevel = levelOptions[0].value;
    const primaryUom = uomOptions[0].value;

    const draftPayload = new URLSearchParams();
    draftPayload.set("_csrf", csrf);
    draftPayload.set("item_id", primaryItem);
    draftPayload.set("level", primaryLevel);
    draftPayload.set("output_qty", "1");
    draftPayload.set("output_uom_id", primaryUom);
    draftPayload.set("rm_lines_json", "[]");
    draftPayload.set("sfg_lines_json", "[]");
    draftPayload.set("labour_lines_json", "[]");
    draftPayload.set("variant_rules_json", "[]");

    const createDraftRes = await request("/master-data/bom/save-draft", {
      method: "POST",
      body: draftPayload.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    assert([302, 303].includes(createDraftRes.status), "Create draft should redirect.");
    const location = createDraftRes.headers.get("location") || "";
    const createdIdMatch = location.match(/\/master-data\/bom\/(\d+)/);
    assert(createdIdMatch, "Draft redirect should include created BOM id.");
    const createdBomId = Number(createdIdMatch[1]);
    createdBomIds.push(createdBomId);

    const duplicateRes = await request("/master-data/bom/save-draft", {
      method: "POST",
      body: draftPayload.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const duplicateHtml = await duplicateRes.text();
    assert(duplicateHtml.toLowerCase().includes("draft"), "Duplicate draft attempt should show draft uniqueness error.");

    const detailRes = await request(`/master-data/bom/${createdBomId}`);
    assert(detailRes.status === 200, "Created BOM detail page should load.");
    const detailHtml = await detailRes.text();
    const detailCsrf = extractCsrf(detailHtml);
    assert(Boolean(detailCsrf), "Detail csrf missing.");

    const updateDraftPayload = new URLSearchParams();
    updateDraftPayload.set("_csrf", detailCsrf);
    updateDraftPayload.set("item_id", primaryItem);
    updateDraftPayload.set("level", primaryLevel);
    updateDraftPayload.set("output_qty", "1.25");
    updateDraftPayload.set("output_uom_id", primaryUom);
    updateDraftPayload.set("rm_lines_json", "[]");
    updateDraftPayload.set("sfg_lines_json", "[]");
    updateDraftPayload.set("labour_lines_json", "[]");
    updateDraftPayload.set("variant_rules_json", "[]");
    const updateDraftRes = await request(`/master-data/bom/${createdBomId}/save-draft`, {
      method: "POST",
      body: updateDraftPayload.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    assert([302, 303].includes(updateDraftRes.status), "Update draft should redirect.");
    const updatedDraftRow = await knex("erp.bom_header").select("id", "output_qty").where({ id: createdBomId }).first();
    assert(Number(updatedDraftRow?.output_qty) === 1.25, "Draft update should persist changed output_qty.");

    const refreshedDetailRes = await request(`/master-data/bom/${createdBomId}`);
    const refreshedDetailHtml = await refreshedDetailRes.text();
    const refreshedDetailCsrf = extractCsrf(refreshedDetailHtml);
    assert(Boolean(refreshedDetailCsrf), "Refreshed detail csrf missing.");

    const approvePayload = new URLSearchParams();
    approvePayload.set("_csrf", refreshedDetailCsrf);
    const approveRes = await request(`/master-data/bom/${createdBomId}/send-for-approval`, {
      method: "POST",
      body: approvePayload.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    assert([302, 303].includes(approveRes.status), "Send-for-approval should redirect.");

    const approvedRow = await knex("erp.bom_header").select("id", "status", "version_no", "item_id", "level").where({ id: createdBomId }).first();
    assert(approvedRow && approvedRow.status === "APPROVED", "Admin send-for-approval should mark draft as APPROVED.");

    const versionPayload = new URLSearchParams();
    versionPayload.set("_csrf", refreshedDetailCsrf);
    const versionRes = await request(`/master-data/bom/${createdBomId}/create-new-version`, {
      method: "POST",
      body: versionPayload.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    assert([302, 303].includes(versionRes.status), "Create-new-version should redirect.");
    const versionLocation = versionRes.headers.get("location") || "";
    const versionMatch = versionLocation.match(/\/master-data\/bom\/(\d+)/);
    assert(versionMatch, "Create-new-version redirect must include new BOM id.");
    const newVersionId = Number(versionMatch[1]);
    createdBomIds.push(newVersionId);

    const newVersionRow = await knex("erp.bom_header").select("id", "status", "version_no").where({ id: newVersionId }).first();
    assert(newVersionRow && newVersionRow.status === "DRAFT", "New version should be in DRAFT status.");
    assert(Number(newVersionRow.version_no) === Number(approvedRow.version_no) + 1, "New version_no should increment by 1.");

    const countBeforeInvalidVersion = await knex("erp.bom_header")
      .where({ item_id: approvedRow.item_id, level: approvedRow.level })
      .count({ count: "*" })
      .first();
    const invalidVersionPayload = new URLSearchParams();
    invalidVersionPayload.set("_csrf", refreshedDetailCsrf);
    const invalidVersionRes = await request(`/master-data/bom/${newVersionId}/create-new-version`, {
      method: "POST",
      body: invalidVersionPayload.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    assert([302, 303].includes(invalidVersionRes.status), "Create-new-version from draft should return redirect with notice.");
    const countAfterInvalidVersion = await knex("erp.bom_header")
      .where({ item_id: approvedRow.item_id, level: approvedRow.level })
      .count({ count: "*" })
      .first();
    assert(Number(countBeforeInvalidVersion?.count || 0) === Number(countAfterInvalidVersion?.count || 0), "Create-new-version from draft should not create a BOM.");

    const user = await knex("erp.users").select("id").first();
    const branch = await knex("erp.branches").select("id").first();
    assert(user && branch, "Seed users/branches required for approval reroute check.");
    const queued = await handleScreenApproval({
      req: {
        branchId: branch.id,
        ip: "127.0.0.1",
        user: {
          id: user.id,
          isAdmin: false,
          permissions: {
            "SCREEN:master_data.bom": {
              can_create: false,
              can_edit: false,
              can_delete: false,
              can_approve: false,
              can_navigate: true,
            },
          },
        },
      },
      scopeKey: "master_data.bom",
      action: "create",
      entityType: SCREEN_ENTITY_TYPES["master_data.bom"],
      entityId: "NEW",
      summary: "BOM route reroute test",
      oldValue: null,
      newValue: { schema_version: 1, _action: "create" },
      t: (key) => key,
    });
    assert(queued.queued === true, "No-permission create should queue approval request.");
    if (queued.requestId) approvalIds.push(queued.requestId);

    const candidateItems = await knex("erp.items")
      .select("id", "item_type", "base_uom_id")
      .whereIn("item_type", ["FG", "SFG"])
      .andWhere({ is_active: true })
      .orderBy("id", "asc");
    let applyTarget = null;
    for (const item of candidateItems) {
      const level = item.item_type === "FG" ? "FINISHED" : "SEMI_FINISHED";
      const draft = await knex("erp.bom_header").select("id").where({ item_id: item.id, level, status: "DRAFT" }).first();
      if (!draft) {
        applyTarget = {
          itemId: Number(item.id),
          level,
          uomId: Number(item.base_uom_id || primaryUom),
        };
        break;
      }
    }

    if (applyTarget) {
      const approvalApplyCreate = await knex.transaction(async (trx) =>
        applyApprovedBomChange(
          trx,
          {
            requested_by: user.id,
            entity_id: "NEW",
            new_value: {
              schema_version: 1,
              _action: "create",
              input: {
                header: {
                  item_id: applyTarget.itemId,
                  level: applyTarget.level,
                  output_qty: 1,
                  output_uom_id: applyTarget.uomId,
                },
                rm_lines: [],
                sfg_lines: [],
                labour_lines: [],
                variant_rules: [],
              },
            },
          },
          user.id,
        ),
      );
      assert(approvalApplyCreate && approvalApplyCreate.applied === true, "applyApprovedBomChange(create) should apply.");
      const appliedCreateId = Number(approvalApplyCreate.entityId);
      createdBomIds.push(appliedCreateId);

      await knex.transaction(async (trx) => {
        const updated = await applyApprovedBomChange(
          trx,
          {
            requested_by: user.id,
            entity_id: String(appliedCreateId),
            new_value: {
              schema_version: 1,
              _action: "update",
              input: {
                header: {
                  item_id: applyTarget.itemId,
                  level: applyTarget.level,
                  output_qty: 2,
                  output_uom_id: applyTarget.uomId,
                },
                rm_lines: [],
                sfg_lines: [],
                labour_lines: [],
                variant_rules: [],
              },
            },
          },
          user.id,
        );
        assert(updated && updated.applied === true, "applyApprovedBomChange(update) should apply.");
      });
      const postUpdateRow = await knex("erp.bom_header").select("id", "output_qty").where({ id: appliedCreateId }).first();
      assert(Number(postUpdateRow?.output_qty) === 2, "applyApprovedBomChange(update) should persist updated output_qty.");

      await knex.transaction(async (trx) => {
        const approved = await applyApprovedBomChange(
          trx,
          {
            requested_by: user.id,
            entity_id: String(appliedCreateId),
            new_value: {
              schema_version: 1,
              _action: "approve_draft",
              bom_id: appliedCreateId,
            },
          },
          user.id,
        );
        assert(approved && approved.applied === true, "applyApprovedBomChange(approve_draft) should apply.");
      });
      const postApproveRow = await knex("erp.bom_header").select("id", "status").where({ id: appliedCreateId }).first();
      assert(postApproveRow?.status === "APPROVED", "applyApprovedBomChange(approve_draft) should set status APPROVED.");

      const approvalApplyVersion = await knex.transaction(async (trx) =>
        applyApprovedBomChange(
          trx,
          {
            requested_by: user.id,
            entity_id: String(appliedCreateId),
            new_value: {
              schema_version: 1,
              _action: "create_version_from",
              source_bom_id: appliedCreateId,
            },
          },
          user.id,
        ),
      );
      assert(approvalApplyVersion && approvalApplyVersion.applied === true, "applyApprovedBomChange(create_version_from) should apply.");
      createdBomIds.push(Number(approvalApplyVersion.entityId));
    } else {
      console.log("[test-bom-routes] warning: skipped approval-applier path tests due no free item+level draft slot");
    }

    console.log("[test-bom-routes] PASS");
  } catch (err) {
    console.error("[test-bom-routes] FAIL", err.message);
    process.exitCode = 1;
  } finally {
    if (approvalIds.length) {
      await knex("erp.approval_request").whereIn("id", approvalIds).del();
    }
    if (createdBomIds.length) {
      await knex("erp.bom_header").whereIn("id", createdBomIds).del();
    }
    await knex.destroy();
  }
}

run();
