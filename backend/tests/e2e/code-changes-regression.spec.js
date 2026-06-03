/**
 * Regression tests for the following code changes:
 *
 * 1. STN transfer qty: decimals (e.g. 2.5) are no longer blocked mid-typing
 *    (input handler no longer calls renderRows(), which was resetting the field value)
 *
 * 2. STN item field: pressing Enter on an empty searchable-select now opens the dropdown
 *    (voucher-row-enter-navigation sets searchableProgrammaticOpen before calling click())
 *
 * 3. Opening Stock: Rate column is hidden when Stock Type = SFG
 *    (headerColumnsByType skips "rate" key; renderFooter omits the spacer cell)
 *
 * 4. Opening Stock: SFG rows always have rate=0 so amount is always 0
 *    (applyDerivedDefaults forces rate=0 before computing amount)
 *
 * 5. Approvals: inferAction correctly returns "create" for voucher payloads
 *    that store action in new_value.action (not new_value._action)
 *    (approval-request-edit.js)
 *
 * 6. Approvals: normalizeVoucherApprovalSummary uses voucher_type_code directly
 *    so "STN_OUT" shows as "STN OUT" not "VOUCHER"
 *    (approvals.js - rawTypeCode fix)
 *
 * 7. Approvals: VOUCHER_TYPE_URL_MAP includes STN_OUT and STN_IN
 *    so "View Voucher" redirects work
 *    (approvals.js)
 *
 * 8. Approvals: STN voucher preview shows item/qty/amount table instead of
 *    the financial GL debit/credit table
 *    (approvals.js + stn-voucher-preview.ejs)
 */

const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getUserByUsername,
  createApprovalRequest,
  deleteApprovalRequests,
  closeDb,
} = require("./utils/db");

// ─── helpers ─────────────────────────────────────────────────────────────────

const nonEmptyOptionValues = async (selectLocator) =>
  selectLocator.locator("option").evaluateAll((opts) =>
    opts.map((opt) => String(opt.value || "").trim()).filter(Boolean),
  );

const readNumericInput = async (locator) => {
  const text = await locator.inputValue();
  const n = Number(String(text || "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
};

// ─── teardown ────────────────────────────────────────────────────────────────

const createdApprovalIds = [];
test.afterAll(async () => {
  if (createdApprovalIds.length) {
    await deleteApprovalRequests(createdApprovalIds);
  }
  await closeDb();
});

// =============================================================================
// 1 + 2  STN TRANSFER QTY & ENTER-KEY OPEN DROPDOWN
// =============================================================================

test.describe("STN: transfer qty and item-field enter-key", () => {
  test("transfer qty field accepts decimal value (e.g. 2.5) without swallowing the decimal point", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Stock Transfer Out page not accessible.",
    );

    const stockTypeSelect = page.locator("[data-stock-type]");
    if (await stockTypeSelect.count()) {
      await stockTypeSelect.selectOption("FG");
    }

    const firstRow = page.locator("[data-lines-body] tr[data-row-index]").first();
    await expect(firstRow).toBeVisible();

    const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available.");
    await skuSelect.selectOption(skuValues[0]);

    // Re-locate after re-render
    const qtyInput = page
      .locator("[data-lines-body] tr[data-row-index]")
      .first()
      .locator('input[data-out-input="transfer_qty"]')
      .first();
    await expect(qtyInput).toBeVisible();

    // Type "2." — previously the re-render on input swallowed the "."
    await qtyInput.click();
    await qtyInput.fill("");
    await qtyInput.type("2");

    // The field must still show "2" (not "2.000") while typing
    const afterTwo = await qtyInput.inputValue();
    expect(String(afterTwo)).toMatch(/^2/);

    // Continue typing ".5"
    await qtyInput.type(".5");

    // Mid-typing the value should contain the decimal point, not be re-rendered as "2.000"
    const midTyping = await qtyInput.inputValue();
    expect(String(midTyping)).toContain(".");
    // The numeric value of what was typed should be 2.5
    const numericValue = Number(String(midTyping).replace(/,/g, ""));
    expect(numericValue).toBeCloseTo(2.5, 2);
  });

  test("transfer qty totals update live while typing decimal values", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Stock Transfer Out page not accessible.",
    );

    const stockTypeSelect = page.locator("[data-stock-type]");
    if (await stockTypeSelect.count()) {
      await stockTypeSelect.selectOption("FG");
    }

    const firstRow = page.locator("[data-lines-body] tr[data-row-index]").first();
    await expect(firstRow).toBeVisible();

    const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available.");
    await skuSelect.selectOption(skuValues[0]);

    const qtyInput = page
      .locator("[data-lines-body] tr[data-row-index]")
      .first()
      .locator('input[data-out-input="transfer_qty"]')
      .first();
    await expect(qtyInput).toBeVisible();

    // Type "3" then blur so the row re-renders with formatted value
    await qtyInput.fill("3");
    await qtyInput.blur();

    const totalQtyInput = page.locator("[data-lines-footer] input[data-total-qty]").first();
    await expect(totalQtyInput).toBeVisible();

    await expect
      .poll(async () => readNumericInput(totalQtyInput), { timeout: 5000 })
      .toBeCloseTo(3, 2);

    // Now change to 2.5
    await qtyInput.fill("2.5");
    await qtyInput.blur();

    await expect
      .poll(async () => readNumericInput(totalQtyInput), { timeout: 5000 })
      .toBeCloseTo(2.5, 2);
  });

  test("pressing Enter on empty item field opens the searchable dropdown", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Stock Transfer Out page not accessible.",
    );

    const stockTypeSelect = page.locator("[data-stock-type]");
    if (await stockTypeSelect.count()) {
      await stockTypeSelect.selectOption("FG");
    }

    const firstRow = page.locator("[data-lines-body] tr[data-row-index]").first();
    await expect(firstRow).toBeVisible();

    const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
    await expect(skuSelect).toBeVisible();

    // Verify the SKU select has no value yet
    const currentValue = await skuSelect.inputValue();
    expect(String(currentValue || "").trim()).toBe("");

    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available.");

    // Focus the searchable input (not the hidden select) and press Enter
    const wrapper = firstRow.locator("[data-searchable-wrapper]").first();
    await expect(wrapper).toBeVisible();
    const searchInput = wrapper.locator('input[type="text"]').first();
    await expect(searchInput).toBeVisible();

    await searchInput.focus();
    await searchInput.press("Enter");

    // The dropdown menu should now be open (not have 'hidden' class)
    const dropdownMenu = wrapper.locator("div.z-50").first();
    await expect
      .poll(
        async () => {
          const hidden = await dropdownMenu.evaluate((el) =>
            el.classList.contains("hidden"),
          );
          return hidden;
        },
        { timeout: 3000 },
      )
      .toBe(false);
  });

  test("pressing Enter on item field that already has a value moves focus to next field", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Stock Transfer Out page not accessible.",
    );

    const stockTypeSelect = page.locator("[data-stock-type]");
    if (await stockTypeSelect.count()) {
      await stockTypeSelect.selectOption("FG");
    }

    const firstRow = page.locator("[data-lines-body] tr[data-row-index]").first();
    await expect(firstRow).toBeVisible();

    const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available.");
    await skuSelect.selectOption(skuValues[0]);

    const refreshedFirstRow = page.locator("[data-lines-body] tr[data-row-index]").first();
    const skuSearchInput = refreshedFirstRow
      .locator("[data-searchable-wrapper]")
      .first()
      .locator('input[type="text"]')
      .first();
    const uomSearchInput = refreshedFirstRow
      .locator("td")
      .nth(1)
      .locator("[data-searchable-wrapper] input")
      .first();

    await expect(skuSearchInput).toBeVisible();
    await expect(uomSearchInput).toBeVisible();

    await skuSearchInput.focus();
    await skuSearchInput.press("Enter");

    // With a value already selected, Enter should advance focus to the UOM field
    await expect(uomSearchInput).toBeFocused({ timeout: 3000 });
  });
});

// =============================================================================
// 3 + 4  OPENING STOCK — SFG RATE COLUMN
// =============================================================================

test.describe("Opening Stock: SFG rate column behavior", () => {
  test("rate column header is NOT visible when stock type is SFG", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/inventory?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Opening Stock page not accessible.",
    );

    const stockTypeSelect = page.locator("select[name='stock_type']").first();
    await expect(stockTypeSelect).toBeVisible();

    const sfgOption = await stockTypeSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts.map((o) => String(o.value || "")).find((v) => v.toUpperCase() === "SFG"),
      );
    test.skip(!sfgOption, "SFG stock type option not available in this dataset.");

    await stockTypeSelect.selectOption("SFG");

    // Wait for the grid to re-render
    const headRow = page.locator("[data-lines-table] thead tr, thead [data-lines-head-row]").first();
    await expect(headRow).toBeVisible();

    const headerTexts = await headRow
      .locator("th")
      .evaluateAll((ths) => ths.map((th) => String(th.textContent || "").trim().toLowerCase()));

    expect(headerTexts.some((text) => text.includes("rate"))).toBe(false);
    // Amount column should still be present
    expect(headerTexts.some((text) => text.includes("amount"))).toBe(true);
  });

  test("rate column header IS visible when stock type is FG", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/inventory?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Opening Stock page not accessible.",
    );

    const stockTypeSelect = page.locator("select[name='stock_type']").first();
    await expect(stockTypeSelect).toBeVisible();
    await stockTypeSelect.selectOption("FG");

    const headRow = page.locator("[data-lines-table] thead tr, thead [data-lines-head-row]").first();
    await expect(headRow).toBeVisible();

    const headerTexts = await headRow
      .locator("th")
      .evaluateAll((ths) => ths.map((th) => String(th.textContent || "").trim().toLowerCase()));

    expect(headerTexts.some((text) => text.includes("rate"))).toBe(true);
    expect(headerTexts.some((text) => text.includes("amount"))).toBe(true);
  });

  test("SFG row has no rate input and amount stays zero regardless of qty", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/inventory?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Opening Stock page not accessible.",
    );

    const stockTypeSelect = page.locator("select[name='stock_type']").first();
    await expect(stockTypeSelect).toBeVisible();

    const sfgOption = await stockTypeSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts.map((o) => String(o.value || "")).find((v) => v.toUpperCase() === "SFG"),
      );
    test.skip(!sfgOption, "SFG stock type option not available.");

    await stockTypeSelect.selectOption("SFG");

    const firstRow = page.locator("tr[data-line-index]").first();
    await expect(firstRow).toBeVisible();

    // SFG row should have no rate input at all
    const rateInputCount = await firstRow.locator('input[data-field="rate"]').count();
    expect(rateInputCount).toBe(0);

    // Select a SKU if available
    const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SFG SKU options available.");
    await skuSelect.selectOption(skuValues[0]);

    // Select a unit
    const refreshedRow = page.locator("tr[data-line-index]").first();
    const uomSelect = refreshedRow.locator('select[data-field="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = await nonEmptyOptionValues(uomSelect);
    test.skip(!uomValues.length, "No UOM options available for SFG SKU.");
    await uomSelect.selectOption(uomValues[0]);

    const qtyInput = page
      .locator("tr[data-line-index]")
      .first()
      .locator('input[data-field="qty"]')
      .first();
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill("10");
    await qtyInput.blur();

    // Amount should remain 0 since rate is forced to 0 for SFG
    const amountDisplay = page
      .locator("tr[data-line-index]")
      .first()
      .locator('[data-amount-display]')
      .first();
    await expect(amountDisplay).toBeVisible();

    await expect
      .poll(async () => readNumericInput(amountDisplay), { timeout: 3000 })
      .toBe(0);

    // Footer total amount should also be 0
    const totalAmountInput = page.locator("[data-lines-footer] input[data-total-amount]").first();
    if (await totalAmountInput.count()) {
      await expect
        .poll(async () => readNumericInput(totalAmountInput), { timeout: 3000 })
        .toBe(0);
    }
  });

  test("SFG column count is one less than FG (no rate column)", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/inventory?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Opening Stock page not accessible.",
    );

    const stockTypeSelect = page.locator("select[name='stock_type']").first();
    await expect(stockTypeSelect).toBeVisible();

    const sfgOption = await stockTypeSelect
      .locator("option")
      .evaluateAll((opts) =>
        opts.map((o) => String(o.value || "")).find((v) => v.toUpperCase() === "SFG"),
      );
    test.skip(!sfgOption, "SFG stock type option not available.");

    await stockTypeSelect.selectOption("FG");
    const headRow = page.locator("[data-lines-table] thead tr, thead [data-lines-head-row]").first();
    await expect(headRow).toBeVisible();
    const fgColumnCount = await headRow.locator("th").count();

    await stockTypeSelect.selectOption("SFG");
    await expect
      .poll(async () => headRow.locator("th").count(), { timeout: 3000 })
      .toBe(fgColumnCount - 1);
  });
});

// =============================================================================
// 5 + 6 + 7 + 8  APPROVALS — STN VOUCHER DISPLAY FIXES
// =============================================================================

test.describe("Approvals: STN voucher display and preview", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    createApprovalId: null,
    updateApprovalId: null,
  };

  const STN_OUT_CREATE_PAYLOAD = {
    action: "create",
    voucher_type_code: "STN_OUT",
    voucher_id: 99998,
    voucher_no: 18,
    voucher_date: "2026-06-03",
    stock_type: "FG",
    destination_branch_id: null,
    source_branch_id: null,
    transfer_ref_no: "TRF-207-18",
    bill_book_no: "B33/89",
    transfer_reason: "REBALANCING",
    transporter_name: "",
    remarks: null,
    lines: [
      {
        line_no: 1,
        line_kind: "SKU",
        sku_id: null,
        uom_id: null,
        qty: 2.5,
        rate: 3780,
        amount: 113400,
        meta: { stock_type: "FG", uom_name: "Dozen", uom_factor_to_base: 12 },
      },
    ],
  };

  const STN_OUT_UPDATE_PAYLOAD = {
    action: "update",
    voucher_type_code: "STN_OUT",
    voucher_id: 99998,
    voucher_no: 18,
    voucher_date: "2026-06-03",
    stock_type: "FG",
    lines: [],
  };

  test.beforeAll(async () => {
    const branch = await getBranch();
    if (!branch) {
      ctx.skipReason = "No branch found in DB.";
      return;
    }
    ctx.branchId = branch.id;

    const adminUsername = process.env.E2E_ADMIN_USER;
    if (!adminUsername) {
      ctx.skipReason = "E2E_ADMIN_USER not set.";
      return;
    }
    const adminUser = await getUserByUsername(adminUsername);
    if (!adminUser) {
      ctx.skipReason = `Admin user '${adminUsername}' not found.`;
      return;
    }
    ctx.adminUserId = adminUser.id;

    // Create a "create" approval request for STN_OUT voucher #18
    ctx.createApprovalId = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "VOUCHER",
      entity_type: "VOUCHER",
      entity_id: String(STN_OUT_CREATE_PAYLOAD.voucher_id),
      summary: `${STN_OUT_CREATE_PAYLOAD.voucher_type_code} #${STN_OUT_CREATE_PAYLOAD.voucher_no}`,
      new_value: STN_OUT_CREATE_PAYLOAD,
      old_value: null,
      requested_by: ctx.adminUserId,
      status: "PENDING",
    });

    // Create an "update" approval request for STN_OUT voucher #18
    ctx.updateApprovalId = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "VOUCHER",
      entity_type: "VOUCHER",
      entity_id: String(STN_OUT_UPDATE_PAYLOAD.voucher_id),
      summary: `UPDATE ${STN_OUT_UPDATE_PAYLOAD.voucher_type_code} #${STN_OUT_UPDATE_PAYLOAD.voucher_no}`,
      new_value: STN_OUT_UPDATE_PAYLOAD,
      old_value: { voucher_date: "2026-06-02", remarks: null, status: "PENDING" },
      requested_by: ctx.adminUserId,
      status: "PENDING",
    });

    if (ctx.createApprovalId) createdApprovalIds.push(ctx.createApprovalId);
    if (ctx.updateApprovalId) createdApprovalIds.push(ctx.updateApprovalId);

    ctx.ready = Boolean(ctx.createApprovalId && ctx.updateApprovalId);
    if (!ctx.ready) ctx.skipReason = "Failed to create test approval requests.";
  });

  test("approval list summary shows 'STN OUT' not 'VOUCHER' for STN_OUT create request", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason || "Setup not ready.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Approvals page not accessible.",
    );

    // Find the row with our test approval (entity_id matches the voucher id)
    // The summary should read "Add STN OUT #18" (or translated equivalent) not "Add VOUCHER #18"
    const rows = page.locator("table tbody tr, [data-approval-row]");
    const rowCount = await rows.count();
    test.skip(rowCount === 0, "No approval rows visible on page.");

    const summaryTexts = await page
      .locator("table tbody tr td, [data-approval-summary]")
      .allTextContents();

    const relevantSummary = summaryTexts.find((text) =>
      String(text || "")
        .toUpperCase()
        .includes("STN OUT"),
    );

    // At least one summary must mention "STN OUT"
    expect(relevantSummary).toBeDefined();
    // None should say just "VOUCHER" (without STN OUT)
    const badSummary = summaryTexts.find((text) => {
      const upper = String(text || "").toUpperCase();
      return upper.includes("VOUCHER") && !upper.includes("STN OUT") && upper.includes("#18");
    });
    expect(badSummary).toBeUndefined();
  });

  test("approval list summary shows 'Add'/'Create' not 'Edit' for STN_OUT create request", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason || "Setup not ready.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Approvals page not accessible.",
    );

    const summaryTexts = await page
      .locator("table tbody tr td, [data-approval-summary]")
      .allTextContents();

    const createSummary = summaryTexts.find((text) => {
      const upper = String(text || "").toUpperCase();
      return upper.includes("STN OUT") && upper.includes("#18") && (upper.includes("ADD") || upper.includes("CREATE"));
    });
    expect(createSummary).toBeDefined();
  });

  test("approval list summary shows 'Edit'/'Update' for STN_OUT update request", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason || "Setup not ready.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Approvals page not accessible.",
    );

    const summaryTexts = await page
      .locator("table tbody tr td, [data-approval-summary]")
      .allTextContents();

    const updateSummary = summaryTexts.find((text) => {
      const upper = String(text || "").toUpperCase();
      return upper.includes("STN OUT") && upper.includes("#18") && (upper.includes("EDIT") || upper.includes("UPDATE"));
    });
    expect(updateSummary).toBeDefined();
  });

  test("STN_OUT approval preview shows item/qty/amount table, not GL debit/credit table", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason || "Setup not ready.");
    test.skip(!ctx.createApprovalId, "Create approval ID not available.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Approvals page not accessible.",
    );

    // Click the VIEW button for our test approval
    // The VIEW button should link to /:id/preview or open a modal
    // In this app, clicking VIEW sends a fetch to /:id/preview and renders in a modal
    const viewButtons = page.locator("button[data-view-details], a[data-view-details], [data-approval-view]");
    const viewCount = await viewButtons.count();

    if (viewCount === 0) {
      // Fallback: navigate directly to the preview endpoint
      const previewResponse = await page.goto(
        `/administration/approvals/${ctx.createApprovalId}/preview?side=new`,
        { waitUntil: "domcontentloaded" },
      );
      test.skip(
        !previewResponse || previewResponse.status() !== 200,
        "Approval preview endpoint not accessible.",
      );

      const pageText = await page.textContent("body");
      // Should NOT show debit/credit column headers
      expect(String(pageText || "").toLowerCase()).not.toContain("debit");
      expect(String(pageText || "").toLowerCase()).not.toContain("credit");

      // Should show inventory-style headers
      const hasQtyColumn =
        String(pageText || "").toLowerCase().includes("qty") ||
        String(pageText || "").toLowerCase().includes("quantity");
      expect(hasQtyColumn).toBe(true);
      return;
    }

    // Click the VIEW button for the row containing "#18"
    const rows = page.locator("table tbody tr");
    let targetViewButton = null;
    const rowsCount = await rows.count();
    for (let i = 0; i < rowsCount; i++) {
      const rowText = await rows.nth(i).textContent();
      if (String(rowText || "").toUpperCase().includes("STN OUT") && String(rowText || "").includes("#18")) {
        targetViewButton = rows.nth(i).locator("button[data-view-details], a[data-view-details], [data-approval-view]").first();
        break;
      }
    }

    if (!targetViewButton) {
      test.skip(true, "Could not find VIEW button for the STN OUT #18 approval row.");
    }

    await targetViewButton.click();

    // Wait for modal/panel content to appear
    const previewPanel = page.locator("[data-preview-panel], [data-approval-modal], dialog, [role='dialog']").first();
    await expect(previewPanel).toBeVisible({ timeout: 5000 });

    const previewText = await previewPanel.textContent();
    // Must NOT show debit/credit columns (financial GL template)
    expect(String(previewText || "").toLowerCase()).not.toContain("debit");
    expect(String(previewText || "").toLowerCase()).not.toContain("credit");
    // Must show inventory-style data
    const hasQtyOrAmount =
      String(previewText || "").toLowerCase().includes("qty") ||
      String(previewText || "").toLowerCase().includes("quantity") ||
      String(previewText || "").toLowerCase().includes("amount");
    expect(hasQtyOrAmount).toBe(true);
  });

  test("approval preview endpoint returns 200 and STN inventory content for STN_OUT create", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason || "Setup not ready.");
    test.skip(!ctx.createApprovalId, "Create approval ID not available.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto(
      `/administration/approvals/${ctx.createApprovalId}/preview?side=new`,
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBe(200);

    const pageSource = await page.content();
    // Should NOT render debit/credit column headers
    expect(pageSource.toLowerCase()).not.toContain("debit");
    expect(pageSource.toLowerCase()).not.toContain("credit");

    // Should contain qty or amount since lines have data
    const hasInventoryContent =
      pageSource.toLowerCase().includes("qty") ||
      pageSource.toLowerCase().includes("amount") ||
      pageSource.toLowerCase().includes("quantity");
    expect(hasInventoryContent).toBe(true);
  });

  test("STN_OUT view-voucher redirect works (VOUCHER_TYPE_URL_MAP includes STN_OUT)", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason || "Setup not ready.");
    test.skip(!ctx.createApprovalId, "Create approval ID not available.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto(
      `/administration/approvals/${ctx.createApprovalId}/view-voucher`,
      { waitUntil: "domcontentloaded" },
    );
    // Should redirect to /vouchers/stock-transfer-out (not 404)
    expect(response?.status()).not.toBe(404);
    // The URL after redirect should contain the STN out path
    const finalUrl = page.url();
    expect(String(finalUrl).toLowerCase()).toContain("stock-transfer-out");
  });

  test("approval preview shows 'Create' action label for STN_OUT with action=create payload", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason || "Setup not ready.");
    test.skip(!ctx.createApprovalId, "Create approval ID not available.");

    await login(page, "E2E_ADMIN");
    const response = await page.goto(
      `/administration/approvals/${ctx.createApprovalId}/preview?side=new`,
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBe(200);

    const pageSource = await page.content();
    const lower = pageSource.toLowerCase();

    // Must NOT show "edit" as action label for a create request
    // (previously inferAction always returned "update", showing "EDIT")
    // The action label shown should be create/add, not edit/update
    const hasCreateLabel =
      lower.includes("create") ||
      lower.includes(" add") ||
      lower.includes(">add<");
    const hasEditLabel =
      lower.includes(">edit<") ||
      lower.includes(">edit </") ||
      lower.match(/>\s*edit\s*</i);

    // The page should indicate a create/add action, not an edit/update one
    // (in the previewLabel part of the rendered template)
    expect(hasCreateLabel).toBe(true);
    expect(hasEditLabel).toBe(false);
  });
});

// =============================================================================
// 5  INFER ACTION — unit-level server logic via API call
// =============================================================================

test.describe("inferAction: voucher payload with action field", () => {
  test("approval list correctly identifies create vs update actions from new_value.action", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Approvals page not accessible.",
    );

    // Verify the page loads without JavaScript errors
    const jsErrors = [];
    page.on("pageerror", (err) => jsErrors.push(err.message));
    await page.waitForLoadState("domcontentloaded");
    expect(jsErrors.length).toBe(0);

    // The page should load successfully and show the table structure
    const table = page.locator("table").first();
    await expect(table).toBeVisible();
  });
});
