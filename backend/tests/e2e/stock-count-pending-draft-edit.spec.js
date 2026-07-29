// E2E coverage for editing a PENDING Physical Count Correction from the voucher
// screen (the real edit UI, not an HTTP replay):
//
//  - the edit lands ON the voucher immediately (lines + refreshed System Qty
//    snapshot), so the reviewer sees the real numbers instead of the pre-edit
//    ones, while status stays PENDING and nothing posts to stock;
//  - refreshing the pending approval NEVER transfers authorship: the original
//    maker stays `requested_by`, even when an admin is the one editing. That
//    also keeps the maker != checker CHECK satisfied, so the admin can still
//    approve it afterwards.
//
// The whole point is the browser path, so the edit is driven through the form.

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
  getApprovalsForVoucher,
  getStockCountLinesForVoucher,
  countStockLedgerRowsForVoucher,
  getReasonCodeIdByCode,
} = require("./utils/db");

// The blind-count screen loads a whole product group, which can outrun
// Playwright's 30s default navigation timeout on a busy dev box.
const NAV_TIMEOUT = 90000;

const OPERATOR_USER =
  process.env.E2E_SC_DRAFT_OPERATOR_USER || "e2e_sc_draft_operator";
const OPERATOR_PASS =
  process.env.E2E_SC_DRAFT_OPERATOR_PASS || "ScDraftEdit@123";

const nonEmptyOptionValues = async (locator) =>
  locator
    .locator("option")
    .evaluateAll((options) =>
      options.map((o) => String(o.value || "").trim()).filter(Boolean),
    );

const getPhysicalReasonValue = async (reasonSelect) =>
  reasonSelect.locator("option").evaluateAll((options) => {
    const normalize = (v) =>
      String(v || "")
        .replace(/[^a-z0-9]+/gi, "")
        .toUpperCase();
    const match = options
      .map((o) => ({
        value: String(o.value || "").trim(),
        code: normalize(o.getAttribute("data-reason-value") || ""),
      }))
      .filter((r) => r.value)
      .find((r) => r.code.startsWith("PHYSICALCOUNT"));
    return match ? match.value : "";
  });

// .fill() alone never commits the value into the screen's own state — that
// happens on change/blur.
const fillCountedQty = async (page, index, value) => {
  const input = page.locator(
    `input[data-line-index="${index}"][data-row-field="counted_stock_qty"]`,
  );
  await input.fill(String(value));
  await input.blur();
};

const dismissErrorModal = async (page) => {
  const okButton = page.locator('button:has-text("OK")').first();
  if (await okButton.count()) await okButton.click().catch(() => {});
};

const clickConfirmAndWaitForPost = async (page, { timeout = 8000 } = {}) => {
  const confirmButton = page
    .locator('[data-stock-count-form] button[type="submit"]')
    .first();
  try {
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === "POST" && r.url().includes("/vouchers/stock-count"),
        { timeout },
      ),
      confirmButton.click(),
    ]);
    // The POST response only comes back after the transaction commits; without
    // waiting for it the next DB read can race the save.
    await page
      .waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().includes("/vouchers/stock-count"),
        { timeout },
      )
      .catch(() => {});
    return request.postData() || "";
  } catch (err) {
    return null;
  }
};

// Confirm runs a reconciliation pass that can append rows for articles holding
// stock that were missing from the loaded list; they arrive blank and block the
// save. Top up every blank row, keep the last one off-by-one so the "at least
// one line must differ" rule still holds, and retry.
const fillBlankCountsAndConfirm = async (
  page,
  { attempts = 3, offset = 1 } = {},
) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const rowCount = await page.locator("tr[data-line-index]").count();
    let lastFillableIndex = -1;
    for (let i = 0; i < rowCount; i++) {
      const input = page.locator(
        `input[data-line-index="${i}"][data-row-field="counted_stock_qty"]`,
      );
      if (!(await input.count())) continue;
      lastFillableIndex = i;
      if (String(await input.inputValue()).trim() !== "") continue;
      const sysQty = await page
        .locator(
          `tr[data-line-index="${i}"] input[data-display-field="system_qty"]`,
        )
        .inputValue();
      await fillCountedQty(page, i, Number(sysQty) || 0);
    }
    if (lastFillableIndex >= 0) {
      const sysQty = await page
        .locator(
          `tr[data-line-index="${lastFillableIndex}"] input[data-display-field="system_qty"]`,
        )
        .inputValue();
      await fillCountedQty(
        page,
        lastFillableIndex,
        (Number(sysQty) || 0) + offset + attempt,
      );
    }
    const body = await clickConfirmAndWaitForPost(page);
    if (body !== null) return body;
    await dismissErrorModal(page);
    await page.waitForTimeout(300);
  }
  return null;
};

// Navigating right after a login can be cancelled by the login redirect still
// settling (net::ERR_ABORTED). That is a harness race, not a product failure —
// retry instead of failing the run.
const gotoStable = async (page, url, attempts = 4) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
    } catch (err) {
      lastErr = err;
      if (!String(err.message).includes("ERR_ABORTED")) throw err;
      await page.waitForTimeout(750);
    }
  }
  throw lastErr;
};

// FG + Physical Count Correction + a product group auto-loads the blind-count
// article list; there is no SKU picker to drive in this mode.
const openPhysicalCountForm = async (page, { noteText }) => {
  const response = await gotoStable(page, "/vouchers/stock-count?new=1");
  expect(response?.status()).toBe(200);

  const stockType = page.locator("[data-stock-type]");
  if (await stockType.count()) await stockType.selectOption("FG");

  const reasonSelect = page.locator("[data-reason-code]");
  const physicalValue = await getPhysicalReasonValue(reasonSelect);
  test.skip(!physicalValue, "No physical-count reason configured.");
  await reasonSelect.selectOption(physicalValue);

  const reasonNotes = page.locator("[data-reason-notes]");
  if (await reasonNotes.count()) await reasonNotes.fill(noteText);

  await page.waitForFunction(
    () =>
      (document.querySelector("[data-product-group]") || {}).options?.length >
      1,
    { timeout: 15000 },
  );
  const groupValues = await nonEmptyOptionValues(
    page.locator("[data-product-group]"),
  );
  test.skip(!groupValues.length, "No product groups configured.");
  await page.locator("[data-product-group]").selectOption(groupValues[0]);

  // A blank starter row exists before the article list lands, so wait for the
  // loading overlay to clear rather than for "a row to exist".
  await page
    .waitForSelector("[data-table-loading-overlay]", {
      state: "visible",
      timeout: 3000,
    })
    .catch(() => {});
  await page
    .waitForSelector("[data-table-loading-overlay].hidden", { timeout: 15000 })
    .catch(() => {});
};

const relogin = async (page, prefix) => {
  await page.goto("about:blank").catch(() => {});
  await page.context().clearCookies();
  await login(page, prefix);
};

test.describe("Stock count: editing a pending Physical Count Correction", () => {
  test.describe.configure({ mode: "serial", timeout: 240000 });

  const state = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    operatorUserId: null,
    policySnapshots: {},
    overrideSnapshot: [],
  };

  test.beforeAll(async () => {
    process.env.E2E_SC_DRAFT_OPERATOR_USER = OPERATOR_USER;
    process.env.E2E_SC_DRAFT_OPERATOR_PASS = OPERATOR_PASS;

    const branch = await getBranch();
    state.branchId = Number(branch?.id || 0) || null;

    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    state.adminUserId = Number(adminUser?.id || 0) || null;
    if (!state.adminUserId) {
      state.skipReason = "Missing E2E admin user.";
      return;
    }
    if (!(await getReasonCodeIdByCode("PHYSICAL_COUNT"))) {
      state.skipReason = "PHYSICAL_COUNT reason code not found in this DB.";
      return;
    }

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

    for (const action of ["create", "edit"]) {
      state.policySnapshots[action] = await getApprovalPolicy({
        entityType: "VOUCHER_TYPE",
        entityKey: "STOCK_COUNT_ADJ",
        action,
      });
      await upsertApprovalPolicy({
        entityType: "VOUCHER_TYPE",
        entityKey: "STOCK_COUNT_ADJ",
        action,
        requiresApproval: true,
      });
    }

    state.overrideSnapshot = await listInventoryNegativeStockOverrides({
      voucherTypeCode: "STOCK_COUNT_ADJ",
    });
    await clearInventoryNegativeStockOverrides({
      voucherTypeCode: "STOCK_COUNT_ADJ",
    });

    state.ready = true;
  });

  test.afterAll(async () => {
    for (const action of ["create", "edit"]) {
      const snapshot = state.policySnapshots[action];
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
    }
    await replaceInventoryNegativeStockOverrides({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      rows: state.overrideSnapshot,
      updatedBy: state.adminUserId,
    });
    // NOTE: deliberately not calling closeDb() — utils/db.js holds ONE knex
    // pool shared by every spec in the worker, so closing it here makes any
    // spec that runs after this file fail with "Unable to acquire a connection".
    // Playwright tears the worker down at the end of the run.
  });

  test.beforeEach(async () => {
    test.skip(!state.ready, state.skipReason || "Fixture setup failed.");
  });

  test("an admin's edit lands on the pending voucher but keeps the original requester and does not post", async ({
    page,
  }) => {
    // --- the operator raises the count ---
    await relogin(page, "E2E_SC_DRAFT_OPERATOR");
    await openPhysicalCountForm(page, {
      noteText: "Draft-edit spec: created.",
    });
    expect(
      await fillBlankCountsAndConfirm(page),
      "operator create POST never fired",
    ).not.toBeNull();

    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });
    expect(created?.id, "operator's voucher was not created").toBeTruthy();
    const voucherId = Number(created.id);
    expect(String(created.status).toUpperCase()).toBe("PENDING");

    const afterCreate = await getApprovalsForVoucher(voucherId);
    expect(afterCreate.length).toBe(1);
    expect(Number(afterCreate[0].requested_by)).toBe(
      Number(state.operatorUserId),
    );
    const approvalId = Number(afterCreate[0].id);
    const linesAtCreate = await getStockCountLinesForVoucher(voucherId);
    expect(linesAtCreate.length).toBeGreaterThan(0);

    // --- the admin corrects it from the voucher screen ---
    await relogin(page, "E2E_ADMIN");
    await gotoStable(
      page,
      `/vouchers/stock-count?view=1&voucher_no=${created.voucher_no}`,
    );
    await expect
      .poll(async () => page.locator("tr[data-line-index]").count(), {
        timeout: 15000,
      })
      .toBeGreaterThan(0);
    await expect(
      page.locator("[data-stock-count-form] input[name='voucher_id']"),
    ).toHaveValue(String(voucherId));

    // A different offset than the create, so the saved qty must visibly change.
    expect(
      await fillBlankCountsAndConfirm(page, { offset: 5 }),
      "admin edit POST never fired",
    ).not.toBeNull();

    // 1. Still exactly one approval, the same row, still PENDING.
    const afterEdit = await getApprovalsForVoucher(voucherId);
    expect(afterEdit.length).toBe(1);
    expect(Number(afterEdit[0].id)).toBe(approvalId);
    expect(String(afterEdit[0].status).toUpperCase()).toBe("PENDING");

    // 2. The maker is untouched: the operator raised it, not the admin.
    expect(
      Number(afterEdit[0].requested_by),
      "editing must not transfer authorship of the request",
    ).toBe(Number(state.operatorUserId));
    expect(Number(afterEdit[0].requested_by)).not.toBe(
      Number(state.adminUserId),
    );

    // 3. The edit is visible on the voucher itself, not just in the request.
    const linesAfterEdit = await getStockCountLinesForVoucher(voucherId);
    expect(linesAfterEdit.length).toBeGreaterThan(0);
    // FG counts are stored in the *_pairs columns (physical_qty stays 0 there).
    const countedOf = (lines) =>
      JSON.stringify(
        lines.map((l) => [
          Number(l.qty || 0),
          Number(l.physical_qty_pairs || 0),
        ]),
      );
    expect(
      countedOf(linesAfterEdit),
      "the pending voucher still shows the pre-edit counts",
    ).not.toBe(countedOf(linesAtCreate));

    // 4. Saving re-took the System Qty snapshot on every line.
    for (const line of linesAfterEdit) {
      expect(
        line.system_qty_pairs_snapshot ?? line.system_qty_snapshot,
      ).not.toBeNull();
    }

    // 5. Nothing posted: still PENDING, unapproved, zero stock ledger rows.
    const header = await getVoucherHeaderById(voucherId);
    expect(String(header.status).toUpperCase()).toBe("PENDING");
    expect(header.approved_by).toBeFalsy();
    expect(
      await countStockLedgerRowsForVoucher(voucherId),
      "a pending voucher must not have posted stock",
    ).toBe(0);

    // 6. Posting still happens only from the Approvals page — and the admin is
    // able to decide it precisely because step 2 left the operator as maker
    // (the maker != checker CHECK would reject an admin-authored request).
    const approvalsPage = await page.request.get("/administration/approvals");
    const csrf = ((await approvalsPage.text()).match(
      /name="_csrf"[^>]*?value="([^"]*)"/,
    ) || [])[1];
    expect(csrf, "no CSRF token on the approvals page").toBeTruthy();
    const decision = await page.request.post(
      `/administration/approvals/${approvalId}/approve`,
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        data: new URLSearchParams({ _csrf: csrf }).toString(),
        maxRedirects: 0,
      },
    );
    expect([302, 303]).toContain(decision.status());

    await expect
      .poll(
        async () =>
          String(
            (await getVoucherHeaderById(voucherId))?.status || "",
          ).toUpperCase(),
        { timeout: 10000 },
      )
      .toBe("APPROVED");
    expect(
      await countStockLedgerRowsForVoucher(voucherId),
      "approving from the Approvals page must post the count",
    ).toBeGreaterThan(0);
  });

  test("the maker editing their own pending count sees it applied, with one approval and nothing posted", async ({
    page,
  }) => {
    await relogin(page, "E2E_SC_DRAFT_OPERATOR");
    await openPhysicalCountForm(page, { noteText: "Draft-edit spec: self." });
    expect(await fillBlankCountsAndConfirm(page)).not.toBeNull();

    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });
    expect(created?.id).toBeTruthy();
    const voucherId = Number(created.id);
    const approvalId = Number((await getApprovalsForVoucher(voucherId))[0].id);
    const linesAtCreate = await getStockCountLinesForVoucher(voucherId);

    // Same user reopens and re-counts.
    await gotoStable(
      page,
      `/vouchers/stock-count?view=1&voucher_no=${created.voucher_no}`,
    );
    await expect
      .poll(async () => page.locator("tr[data-line-index]").count(), {
        timeout: 15000,
      })
      .toBeGreaterThan(0);
    expect(await fillBlankCountsAndConfirm(page, { offset: 7 })).not.toBeNull();

    const approvals = await getApprovalsForVoucher(voucherId);
    expect(approvals.length).toBe(1);
    expect(Number(approvals[0].id)).toBe(approvalId);
    expect(Number(approvals[0].requested_by)).toBe(
      Number(state.operatorUserId),
    );
    expect(String(approvals[0].status).toUpperCase()).toBe("PENDING");

    const pairsOf = (lines) =>
      JSON.stringify(lines.map((l) => Number(l.physical_qty_pairs || 0)));
    expect(pairsOf(await getStockCountLinesForVoucher(voucherId))).not.toBe(
      pairsOf(linesAtCreate),
    );

    const header = await getVoucherHeaderById(voucherId);
    expect(String(header.status).toUpperCase()).toBe("PENDING");
    expect(await countStockLedgerRowsForVoucher(voucherId)).toBe(0);
  });

  test("repeated edits keep the ORIGINAL baseline in old_value while new_value tracks the latest counts", async ({
    page,
  }) => {
    await relogin(page, "E2E_SC_DRAFT_OPERATOR");
    await openPhysicalCountForm(page, { noteText: "Draft-edit spec: diff." });
    expect(await fillBlankCountsAndConfirm(page)).not.toBeNull();

    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });
    const voucherId = Number(created.id);

    await relogin(page, "E2E_ADMIN");
    const editOnce = async (offset) => {
      await gotoStable(
        page,
        `/vouchers/stock-count?view=1&voucher_no=${created.voucher_no}`,
      );
      await expect
        .poll(async () => page.locator("tr[data-line-index]").count(), {
          timeout: 15000,
        })
        .toBeGreaterThan(0);
      expect(await fillBlankCountsAndConfirm(page, { offset })).not.toBeNull();
      return (await getApprovalsForVoucher(voucherId))[0];
    };

    const afterFirst = await editOnce(4);
    const afterSecond = await editOnce(9);

    expect(Number(afterSecond.id)).toBe(Number(afterFirst.id));
    expect(Number(afterSecond.requested_by)).toBe(Number(state.operatorUserId));

    // The baseline must NOT drift to "the voucher as I last edited it" —
    // otherwise, now that edits land on the voucher, the reviewer's before/after
    // diff would compare the edited voucher against itself.
    expect(
      JSON.stringify(afterSecond.old_value),
      "old_value must stay the state at first submission",
    ).toBe(JSON.stringify(afterFirst.old_value));

    // ...while the proposal keeps up with the newest counts.
    expect(
      JSON.stringify(afterSecond.new_value),
      "new_value must reflect the latest edit",
    ).not.toBe(JSON.stringify(afterFirst.new_value));
  });

  test("rejecting an edited pending count leaves it unposted", async ({
    page,
  }) => {
    await relogin(page, "E2E_SC_DRAFT_OPERATOR");
    await openPhysicalCountForm(page, { noteText: "Draft-edit spec: reject." });
    expect(await fillBlankCountsAndConfirm(page)).not.toBeNull();

    const created = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });
    const voucherId = Number(created.id);
    const approvalId = Number((await getApprovalsForVoucher(voucherId))[0].id);

    await relogin(page, "E2E_ADMIN");
    await gotoStable(
      page,
      `/vouchers/stock-count?view=1&voucher_no=${created.voucher_no}`,
    );
    await expect
      .poll(async () => page.locator("tr[data-line-index]").count(), {
        timeout: 15000,
      })
      .toBeGreaterThan(0);
    expect(await fillBlankCountsAndConfirm(page, { offset: 3 })).not.toBeNull();

    const approvalsPage = await page.request.get("/administration/approvals");
    const csrf = ((await approvalsPage.text()).match(
      /name="_csrf"[^>]*?value="([^"]*)"/,
    ) || [])[1];
    expect(csrf).toBeTruthy();
    const decision = await page.request.post(
      `/administration/approvals/${approvalId}/reject`,
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        data: new URLSearchParams({
          _csrf: csrf,
          decision_notes: "e2e reject",
        }).toString(),
        maxRedirects: 0,
      },
    );
    expect([302, 303]).toContain(decision.status());

    await expect
      .poll(
        async () =>
          String(
            (await getApprovalsForVoucher(voucherId))[0]?.status || "",
          ).toUpperCase(),
        { timeout: 10000 },
      )
      .toBe("REJECTED");
    expect(
      await countStockLedgerRowsForVoucher(voucherId),
      "a rejected count must never post stock",
    ).toBe(0);
    expect(
      String(
        (await getVoucherHeaderById(voucherId))?.status || "",
      ).toUpperCase(),
    ).not.toBe("APPROVED");
  });
});
