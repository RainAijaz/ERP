// E2E coverage for the voucher approval-reconciliation fixes:
//  - Editing a PENDING Physical Count Correction never creates a duplicate
//    approval (the queue path refreshes the existing pending row in place).
//  - A non-Physical reason (or an already-approved count) lets an admin's
//    Confirm apply directly and clears/creates no pending approval.
//  - When an admin Confirms a voucher that a non-admin left pending, the stale
//    approval is RESOLVED to APPROVED (with the admin as decider) so it leaves
//    the Pending Approvals page and shows under Approved — not orphaned.
//
// Drives the real UI -> HTTP -> service -> DB path for STOCK_COUNT_ADJ, whose
// reason-gated behavior exercises both de-dupe (Behavior A) and
// resolve-on-confirm (Behavior B) that are shared by every voucher service.

const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getUserByUsername,
  upsertUserWithPermissions,
  setUserScopePermission,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  clearInventoryNegativeStockOverrides,
  listInventoryNegativeStockOverrides,
  replaceInventoryNegativeStockOverrides,
  getLatestVoucherHeader,
  getVoucherHeaderById,
  countPendingApprovalsForVoucher,
  getApprovalsForVoucher,
  getReasonCodeIdByCode,
  closeDb,
} = require("./utils/db");

const OPERATOR_USER =
  process.env.E2E_APPROVAL_RECON_OPERATOR_USER || "e2e_approval_recon_operator";
const OPERATOR_PASS =
  process.env.E2E_APPROVAL_RECON_OPERATOR_PASS || "ApprovalRecon@123";

const setSelectValue = async (locator, value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  await locator.selectOption(normalized, { force: true }).catch(() => {});
  let selected = String((await locator.inputValue()) || "").trim();
  if (selected === normalized) return selected;
  await locator.evaluate((element, nextValue) => {
    const select = element;
    select.value = String(nextValue || "");
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, normalized);
  return String((await locator.inputValue()) || "").trim();
};

const getNonEmptyOptionValues = async (locator) =>
  locator
    .locator("option")
    .evaluateAll((options) =>
      options.map((o) => String(o.value || "").trim()).filter(Boolean),
    );

// Pick a reason option value by kind: Physical Count Correction (want=true) or
// any other reason (want=false). Matches on the option's data-reason-value code.
const pickReasonValue = async (reasonSelect, wantPhysical) =>
  reasonSelect.locator("option").evaluateAll((options, want) => {
    const normalize = (v) =>
      String(v || "")
        .replace(/[^a-z0-9]+/gi, "")
        .toUpperCase();
    const rows = options
      .map((o) => ({
        value: String(o.value || "").trim(),
        code: normalize(o.getAttribute("data-reason-value") || ""),
      }))
      .filter((r) => r.value);
    const isPhysical = (code) => code.startsWith("PHYSICALCOUNT");
    const match = rows.find((r) =>
      want ? isPhysical(r.code) : r.code && !isPhysical(r.code),
    );
    return match ? match.value : "";
  }, wantPhysical);

const submitVoucherForm = async (page) => {
  await page.locator("[data-voucher-form] button[type='submit']").click();
};

// Submit the create form and capture the exact form-encoded body the browser
// POSTs, so an edit/confirm can be replayed deterministically via HTTP (the
// stock-count edit UI doesn't cleanly round-trip a pending voucher's lines).
const submitAndCaptureBody = async (page) => {
  const requestPromise = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().includes("/vouchers/stock-count"),
  );
  // Wait for the POST response too: it is sent only after the create
  // transaction commits, so the next voucher-number allocation can't race it.
  const responsePromise = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes("/vouchers/stock-count"),
  );
  await submitVoucherForm(page);
  const request = await requestPromise;
  await responsePromise;
  return request.postData() || "";
};

const readCsrfToken = async (page) => {
  const html = await (
    await page.request.get("/vouchers/stock-count?new=1")
  ).text();
  const m =
    html.match(/name="_csrf"[^>]*?value="([^"]*)"/) ||
    html.match(/value="([^"]*)"[^>]*?name="_csrf"/);
  return m ? m[1] : "";
};

// Generic authenticated form POST to the stock-count route (real route ->
// service -> DB), with a fresh CSRF token for the current session.
const postStockCount = async (page, fields) => {
  const params = new URLSearchParams();
  params.set("_csrf", await readCsrfToken(page));
  params.set("voucher_id", String(fields.voucherId || ""));
  params.set("lines_json", fields.linesJson);
  params.set("voucher_date", fields.voucherDate);
  params.set("stock_type", fields.stockType || "FG");
  params.set("reason_code_id", String(fields.reasonCodeId));
  params.set("reason_notes", fields.reasonNotes || "E2E approval reconciliation.");
  const res = await page.request.post("/vouchers/stock-count", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: params.toString(),
    maxRedirects: 0,
  });
  expect(
    [302, 303].includes(res.status()),
    `stock-count POST expected redirect, got ${res.status()}`,
  ).toBe(true);
  return res;
};

// Re-submit a stock count as an edit of `voucherId`, replaying the captured
// create body with a fresh CSRF token for the current session and a bumped
// qty (so there is still a difference). Goes through the real route + service.
const editStockCountViaPost = async (page, capturedBody, { voucherId, qtyIn }) => {
  const params = new URLSearchParams(capturedBody);
  params.set("_csrf", await readCsrfToken(page));
  params.set("voucher_id", String(voucherId));
  const lines = JSON.parse(params.get("lines_json") || "[]");
  if (lines[0]) {
    lines[0].qty_in = qtyIn;
    lines[0].qty_out = 0;
  }
  params.set("lines_json", JSON.stringify(lines));
  const res = await page.request.post("/vouchers/stock-count", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: params.toString(),
    maxRedirects: 0,
  });
  expect(
    [302, 303].includes(res.status()),
    `edit POST expected redirect, got ${res.status()}`,
  ).toBe(true);
};

// Enter a positive counted difference on the first line so the voucher is valid
// (a difference is required) and never trips negative-stock routing. The qty
// controls only exist once a SKU has been locked onto the row.
const setPositiveDifference = async (page, qtyIn) => {
  const firstRow = page.locator("tr[data-line-index]").first();
  const qtyInInput = firstRow.locator('input[data-field="qty_in"]').first();
  const countedInput = firstRow
    .locator('input[data-field="counted_stock_qty"]')
    .first();
  await expect
    .poll(
      async () =>
        (await qtyInInput.count()) + (await countedInput.count()) > 0,
      { timeout: 10000 },
    )
    .toBe(true);

  if (await qtyInInput.count()) {
    await qtyInInput.fill(String(qtyIn));
    await qtyInInput.dispatchEvent("change");
    await qtyInInput.blur();
    return;
  }
  // Packed layout: no qty_in/qty_out, only a counted total.
  const systemInput = firstRow.locator("td").nth(2).locator("input").first();
  const systemQty = Number(
    String((await systemInput.inputValue()) || "0").replace(/,/g, ""),
  );
  await countedInput.fill(
    String((Number.isFinite(systemQty) ? systemQty : 0) + qtyIn),
  );
  await countedInput.dispatchEvent("change");
  await countedInput.blur();
};

const fillNewStockCount = async (page, { wantPhysical, qtyIn }) => {
  const response = await page.goto("/vouchers/stock-count?new=1", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.status()).toBe(200);

  const stockType = page.locator("[data-stock-type]");
  if (await stockType.count()) await setSelectValue(stockType, "FG");

  const reasonSelect = page.locator("[data-reason-code]");
  await expect(reasonSelect).toBeVisible();
  await expect
    .poll(async () => (await getNonEmptyOptionValues(reasonSelect)).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  const reasonValue = await pickReasonValue(reasonSelect, wantPhysical);
  test.skip(
    !reasonValue,
    `No ${wantPhysical ? "Physical Count" : "non-Physical"} reason available for Stock Count.`,
  );
  await setSelectValue(reasonSelect, reasonValue);
  const reasonNotes = page.locator("[data-reason-notes]");
  if (await reasonNotes.count()) {
    await reasonNotes.fill("E2E approval reconciliation check.");
  }

  const firstRow = page.locator("tr[data-line-index]").first();
  await expect(firstRow).toBeVisible();
  const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
  await expect(skuSelect).toBeVisible();
  const skuValues = await getNonEmptyOptionValues(skuSelect);
  test.skip(!skuValues.length, "No SKU options available for Stock Count.");
  // Selecting the SKU locks the article: the row re-renders and replaces the
  // <select> with a read-only textbox, so never read the value back afterwards.
  // The unit auto-populates to a valid default (e.g. Dozen).
  await skuSelect.selectOption(String(skuValues[0]), { force: true });

  await setPositiveDifference(page, qtyIn);
};

// Switching users mid-test on the same page: clear the prior session first so
// navigating to /auth/login is a clean load (avoids ERR_ABORTED on the redirect).
const relogin = async (page, prefix) => {
  // Settle the current page first: the stock-count screen fires background
  // fetches, and clearing cookies + navigating mid-flight can ERR_ABORTED.
  await page.goto("about:blank").catch(() => {});
  await page.context().clearCookies();
  await login(page, prefix);
};

const pollVoucherStatus = (voucherId) =>
  expect.poll(
    async () =>
      String((await getVoucherHeaderById(voucherId))?.status || "").toUpperCase(),
    { timeout: 10000 },
  );

const waitForNewVoucher = async ({ createdBy, branchId, afterId }) =>
  expect
    .poll(
      async () =>
        Number(
          (
            await getLatestVoucherHeader({
              voucherTypeCode: "STOCK_COUNT_ADJ",
              createdBy,
              branchId,
            })
          )?.id || 0,
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThan(Number(afterId || 0));

test.describe("Voucher approval reconciliation (stock count)", () => {
  test.describe.configure({ mode: "serial" });

  const state = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    operatorUserId: null,
    physicalReasonId: null,
    policySnapshots: { create: null, edit: null },
    overrideSnapshot: [],
  };

  test.beforeAll(async () => {
    process.env.E2E_APPROVAL_RECON_OPERATOR_USER = OPERATOR_USER;
    process.env.E2E_APPROVAL_RECON_OPERATOR_PASS = OPERATOR_PASS;

    const branch = await getBranch();
    state.branchId = Number(branch?.id || 0) || null;

    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    state.adminUserId = Number(adminUser?.id || 0) || null;
    if (!state.adminUserId) {
      state.skipReason = "Missing E2E admin user.";
      return;
    }

    state.physicalReasonId = await getReasonCodeIdByCode("PHYSICAL_COUNT");

    state.operatorUserId = await upsertUserWithPermissions({
      username: OPERATOR_USER,
      password: OPERATOR_PASS,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId: state.branchId,
      scopeKeys: [],
    });
    if (!state.operatorUserId) {
      state.skipReason = "Unable to provision operator user.";
      return;
    }
    await setUserScopePermission({
      userId: state.operatorUserId,
      scopeType: "VOUCHER",
      scopeKey: "STOCK_COUNT_ADJ",
      permissions: {
        can_navigate: true,
        can_view: true,
        can_create: true,
        can_edit: true,
        can_delete: false,
        can_print: true,
        can_approve: false,
      },
    });

    // Snapshot + require approval on create & edit so the queue path is engaged.
    state.policySnapshots.create = await getApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STOCK_COUNT_ADJ",
      action: "create",
    });
    state.policySnapshots.edit = await getApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STOCK_COUNT_ADJ",
      action: "edit",
    });
    await upsertApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STOCK_COUNT_ADJ",
      action: "create",
      requiresApproval: true,
    });
    await upsertApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STOCK_COUNT_ADJ",
      action: "edit",
      requiresApproval: true,
    });

    // Remove negative-stock overrides so routing depends only on our positive diffs.
    state.overrideSnapshot = await listInventoryNegativeStockOverrides({
      voucherTypeCode: "STOCK_COUNT_ADJ",
    });
    await clearInventoryNegativeStockOverrides({
      voucherTypeCode: "STOCK_COUNT_ADJ",
    });

    state.ready = true;
  });

  test.afterAll(async () => {
    const restore = async (action, snapshot) => {
      if (snapshot && typeof snapshot.requires_approval === "boolean") {
        await upsertApprovalPolicy({
          entityType: "VOUCHER_TYPE",
          entityKey: "STOCK_COUNT_ADJ",
          action,
          requiresApproval: snapshot.requires_approval,
        });
      } else {
        await deleteApprovalPolicy({
          entityType: "VOUCHER_TYPE",
          entityKey: "STOCK_COUNT_ADJ",
          action,
        });
      }
    };
    await restore("create", state.policySnapshots.create);
    await restore("edit", state.policySnapshots.edit);
    await replaceInventoryNegativeStockOverrides({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      rows: state.overrideSnapshot,
      updatedBy: state.adminUserId,
    });
    await closeDb();
  });

  test.beforeEach(async () => {
    test.skip(!state.ready, state.skipReason || "Fixture setup failed.");
  });

  test("re-editing a still-pending voucher refreshes the same approval, never duplicates (Behavior A)", async ({
    page,
  }) => {
    // A non-admin's queued voucher, re-edited while still pending, must keep
    // exactly one PENDING approval (the queue path refreshes it in place).
    const before = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });

    await relogin(page, "E2E_APPROVAL_RECON_OPERATOR");
    await fillNewStockCount(page, { wantPhysical: false, qtyIn: 3 });
    const capturedBody = await submitAndCaptureBody(page);
    await expect(page).toHaveURL(/\/vouchers\/stock-count/i);
    await expect(page.locator("[data-ui-error-modal]")).toBeHidden();

    await waitForNewVoucher({
      createdBy: state.operatorUserId,
      branchId: state.branchId,
      afterId: before?.id,
    });
    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });
    const voucherId = Number(created.id);

    await pollVoucherStatus(voucherId).toBe("PENDING");
    expect(await countPendingApprovalsForVoucher(voucherId)).toBe(1);
    const firstApproval = (await getApprovalsForVoucher(voucherId))[0];

    // Edit + Confirm again -> STILL exactly one pending approval (de-duped),
    // and it is the SAME row refreshed, not a new one.
    await editStockCountViaPost(page, capturedBody, { voucherId, qtyIn: 5 });
    await expect
      .poll(async () => countPendingApprovalsForVoucher(voucherId), { timeout: 10000 })
      .toBe(1);
    const afterApprovals = await getApprovalsForVoucher(voucherId);
    expect(afterApprovals.length).toBe(1);
    expect(Number(afterApprovals[0].id)).toBe(Number(firstApproval.id));
    expect(String(afterApprovals[0].status).toUpperCase()).toBe("PENDING");
    expect(String((await getVoucherHeaderById(voucherId))?.status).toUpperCase()).toBe("PENDING");
  });

  test("admin create with a non-Physical reason self-approves and creates no pending approval", async ({
    page,
  }) => {
    const before = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });

    await relogin(page, "E2E_ADMIN");
    await fillNewStockCount(page, { wantPhysical: false, qtyIn: 4 });
    await submitVoucherForm(page);
    await expect(page).toHaveURL(/\/vouchers\/stock-count/i);
    await expect(page.locator("[data-ui-error-modal]")).toBeHidden();

    await waitForNewVoucher({
      createdBy: state.adminUserId,
      branchId: state.branchId,
      afterId: before?.id,
    });
    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });
    const voucherId = Number(created.id);

    await pollVoucherStatus(voucherId).toBe("APPROVED");
    expect(await countPendingApprovalsForVoucher(voucherId)).toBe(0);
  });

  test("admin Confirm of a non-admin's pending voucher resolves the approval to APPROVED (leaves Pending, shows in Approved)", async ({
    page,
  }) => {
    // Non-admin creates a non-Physical stock count -> queues (pending).
    const beforeOp = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });
    await relogin(page, "E2E_APPROVAL_RECON_OPERATOR");
    await fillNewStockCount(page, { wantPhysical: false, qtyIn: 6 });
    const capturedBody = await submitAndCaptureBody(page);
    await expect(page).toHaveURL(/\/vouchers\/stock-count/i);
    await expect(page.locator("[data-ui-error-modal]")).toBeHidden();

    await waitForNewVoucher({
      createdBy: state.operatorUserId,
      branchId: state.branchId,
      afterId: beforeOp?.id,
    });
    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });
    const voucherId = Number(created.id);
    await pollVoucherStatus(voucherId).toBe("PENDING");
    expect(await countPendingApprovalsForVoucher(voucherId)).toBe(1);

    // Admin opens it and Confirms -> voucher posts and the approval is resolved.
    await relogin(page, "E2E_ADMIN");
    await editStockCountViaPost(page, capturedBody, { voucherId, qtyIn: 8 });

    await pollVoucherStatus(voucherId).toBe("APPROVED");
    await expect
      .poll(async () => countPendingApprovalsForVoucher(voucherId), { timeout: 10000 })
      .toBe(0);

    const approvals = await getApprovalsForVoucher(voucherId);
    expect(approvals.length).toBe(1);
    const [row] = approvals;
    expect(String(row.status).toUpperCase()).toBe("APPROVED");
    expect(Number(row.decided_by)).toBe(Number(state.adminUserId));
    expect(Number(row.requested_by)).toBe(Number(state.operatorUserId));
    expect(row.decided_at).toBeTruthy();
  });

  test("an admin's Physical Count Correction stays queued (reason gating), and re-editing it de-dupes the approval", async ({
    page,
  }) => {
    test.skip(
      !state.physicalReasonId,
      "PHYSICAL_COUNT reason code not found in this DB.",
    );

    await relogin(page, "E2E_ADMIN");

    // Grab a valid (sku_id, uom_id) pair from a throwaway non-Physical create.
    await fillNewStockCount(page, { wantPhysical: false, qtyIn: 2 });
    const seedBody = await submitAndCaptureBody(page);
    const seedLine = JSON.parse(
      new URLSearchParams(seedBody).get("lines_json") || "[]",
    )[0];
    expect(seedLine && seedLine.sku_id).toBeTruthy();
    const voucherDate = new URLSearchParams(seedBody).get("voucher_date");
    // A large counted total guarantees a difference vs. current system qty
    // without needing to know it (physical count uses counted_stock_qty).
    const physicalLines = (counted) =>
      JSON.stringify([
        { sku_id: seedLine.sku_id, uom_id: seedLine.uom_id, counted_stock_qty: counted },
      ]);

    const before = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });

    // Create a Physical Count Correction as admin -> must QUEUE (never self-approve).
    await postStockCount(page, {
      voucherId: "",
      linesJson: physicalLines(777),
      voucherDate,
      stockType: "FG",
      reasonCodeId: state.physicalReasonId,
      reasonNotes: "E2E physical count gating.",
    });

    await waitForNewVoucher({
      createdBy: state.adminUserId,
      branchId: state.branchId,
      afterId: before?.id,
    });
    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });
    const voucherId = Number(created.id);

    // Reason gating: Physical Count Correction queues even for an admin.
    await pollVoucherStatus(voucherId).toBe("PENDING");
    expect(await countPendingApprovalsForVoucher(voucherId)).toBe(1);
    const firstApproval = (await getApprovalsForVoucher(voucherId))[0];

    // Admin edits + Confirms again -> STILL exactly one pending approval, same row.
    await postStockCount(page, {
      voucherId,
      linesJson: physicalLines(888),
      voucherDate,
      stockType: "FG",
      reasonCodeId: state.physicalReasonId,
      reasonNotes: "E2E physical count gating (edited).",
    });

    await expect
      .poll(async () => countPendingApprovalsForVoucher(voucherId), { timeout: 10000 })
      .toBe(1);
    const afterApprovals = await getApprovalsForVoucher(voucherId);
    expect(afterApprovals.length).toBe(1);
    expect(Number(afterApprovals[0].id)).toBe(Number(firstApproval.id));
    expect(String(afterApprovals[0].status).toUpperCase()).toBe("PENDING");
    expect(
      String((await getVoucherHeaderById(voucherId))?.status).toUpperCase(),
    ).toBe("PENDING");
  });
});
