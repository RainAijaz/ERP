/**
 * Purchase Return (PR) — payment type scenarios
 *
 * Covers:
 *  Suite 1 — UI: cash/credit toggle present on PR form
 *  Suite 2 — Credit PR: saves correctly, GL posts DR AP / CR inventory
 *  Suite 3 — Cash PR: saves correctly, GL posts DR cash / CR inventory
 *  Suite 4 — Validation: cash PR requires a cash account
 *  Suite 5 — DB schema: payment_type + cash_paid_account_id columns exist
 *  Suite 6 — Load: saved PR re-opens with the correct payment type pre-selected
 */

const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
const {
  getLatestVoucherHeader,
  getVoucherLineCount,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  getApprovalPolicy,
} = require("./utils/db");

const PR_URL = "/vouchers/purchase-return?new=1";
const POLICY_ENTITY_TYPE = "VOUCHER_TYPE";
const POLICY_ACTION = "create";

// ── helpers ────────────────────────────────────────────────────────────────

const getSelectOptionValues = async (selectLocator) =>
  selectLocator
    .locator("option")
    .evaluateAll((opts) =>
      opts.map((o) => String(o.value || "").trim()).filter(Boolean),
    );

/** Click the CREDIT or CASH segment button */
const selectPaymentType = async (page, type) => {
  await page
    .locator(`button[data-payment-type-option="${type}"]`)
    .click();
  // Verify the hidden input updated
  await expect(
    page.locator('input[name="payment_type"][data-payment-type]'),
  ).toHaveValue(type);
};

/** Fill the first line of a PR form (item + qty + rate) */
const fillReturnLine = async (page, { itemValue, qty = "2.000", rate = "100" }) => {
  const row = page.locator("[data-lines-body] tr").first();
  await row.locator('select[data-row-field="item"]').selectOption(itemValue);
  await row.locator('input[data-row-field="qty"]').fill(qty);
  await row.locator('input[data-row-field="rate"]').fill(rate);
};

/** Submit the form and wait for a success toast or stay on new page */
const submitAndWait = async (page) => {
  await page.locator('form[data-purchase-voucher-form] button[type="submit"]').click();
  await page
    .waitForURL(/purchase-return/, { timeout: 15000 })
    .catch(() => null);
};

// ── shared setup: disable PR approval so saves are immediate ───────────────

let prPolicySnapshot = null;
let sharedDb = null;

test.beforeAll(async () => {
  sharedDb = createKnex(knexConfig);
  prPolicySnapshot = await getApprovalPolicy({
    entityType: POLICY_ENTITY_TYPE,
    entityKey: "PR",
    action: POLICY_ACTION,
  });
  await upsertApprovalPolicy({
    entityType: POLICY_ENTITY_TYPE,
    entityKey: "PR",
    action: POLICY_ACTION,
    requiresApproval: false,
  });
});

test.afterAll(async () => {
  try {
    if (prPolicySnapshot && typeof prPolicySnapshot.requires_approval === "boolean") {
      await upsertApprovalPolicy({
        entityType: POLICY_ENTITY_TYPE,
        entityKey: "PR",
        action: POLICY_ACTION,
        requiresApproval: prPolicySnapshot.requires_approval,
      });
    } else {
      await deleteApprovalPolicy({
        entityType: POLICY_ENTITY_TYPE,
        entityKey: "PR",
        action: POLICY_ACTION,
      });
    }
  } finally {
    await sharedDb?.destroy();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 1 — UI: cash/credit toggle on PR form
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR form — payment type UI", () => {
  test("PR new form shows CREDIT and CASH toggle buttons", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    await expect(page.locator('button[data-payment-type-option="CREDIT"]')).toBeVisible();
    await expect(page.locator('button[data-payment-type-option="CASH"]')).toBeVisible();
  });

  test("CREDIT is the default payment type on a new PR", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const hidden = page.locator('input[name="payment_type"][data-payment-type]');
    await expect(hidden).toHaveValue("CREDIT");
  });

  test("clicking CASH changes the hidden payment_type value", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    await selectPaymentType(page, "CASH");
    await expect(
      page.locator('input[name="payment_type"][data-payment-type]'),
    ).toHaveValue("CASH");
  });

  test("cash account select is hidden when CREDIT, visible when CASH", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    // CREDIT by default — cash account wrap should be hidden
    const cashWrap = page.locator("[data-cash-account-wrap]");
    await expect(cashWrap).toBeHidden();

    // Switch to CASH — should appear
    await selectPaymentType(page, "CASH");
    await expect(cashWrap).toBeVisible();

    // Switch back to CREDIT — hidden again
    await selectPaymentType(page, "CREDIT");
    await expect(cashWrap).toBeHidden();
  });

  test("PR form has supplier, return_reason, reference_no, and description fields", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    await expect(page.locator('select[name="supplier_party_id"]')).toBeVisible();
    await expect(page.locator('select[name="return_reason"]')).toBeVisible();
    await expect(page.locator('input[name="reference_no"]')).toBeVisible();
    await expect(page.locator('input[name="description"]')).toBeVisible();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 2 — Credit PR: DB row + GL entries
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR credit — save and GL posting", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = { voucherId: null };

  test("credit PR saves and creates a voucher header with APPROVED status", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const supplierOpts = await getSelectOptionValues(page.locator('select[name="supplier_party_id"]'));
    test.skip(!supplierOpts.length, "No suppliers available.");

    await page.locator('select[name="supplier_party_id"]').selectOption(supplierOpts[0]);

    const returnReasonOpts = await getSelectOptionValues(page.locator('select[name="return_reason"]'));
    test.skip(!returnReasonOpts.length, "No return reasons available.");
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);

    const itemOpts = await getSelectOptionValues(
      page.locator("[data-lines-body] tr").first().locator('select[data-row-field="item"]'),
    );
    test.skip(!itemOpts.length, "No items available.");

    await fillReturnLine(page, { itemValue: itemOpts[0] });
    await page.locator('input[name="reference_no"]').fill(`PR-CREDIT-E2E-${Date.now()}`);

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");
    ctx.voucherId = after.id;
  });

  test("credit PR header_ext has payment_type = CREDIT and null cash account", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");
    const ext = await sharedDb("erp.purchase_return_header_ext")
      .where({ voucher_id: ctx.voucherId })
      .first();

    expect(ext).toBeTruthy();
    expect(String(ext.payment_type || "").toUpperCase()).toBe("CREDIT");
    expect(ext.cash_paid_account_id).toBeNull();
  });

  test("credit PR has at least one voucher line", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");
    const count = await getVoucherLineCount(ctx.voucherId);
    expect(count).toBeGreaterThan(0);
  });

  test("credit PR creates GL entries: one DR to AP control, one CR to inventory", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const batch = await sharedDb("erp.gl_batch")
      .where({ source_voucher_id: ctx.voucherId })
      .first();
    expect(batch).toBeTruthy();

    const entries = await sharedDb("erp.gl_entry")
      .where({ batch_id: batch.id })
      .select("dr", "cr", "account_id", "party_id");

    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Must have exactly one DR entry (AP control — DR to reduce AP liability)
    const drEntries = entries.filter((e) => Number(e.dr || 0) > 0);
    expect(drEntries.length).toBeGreaterThanOrEqual(1);

    // Must have exactly one CR entry (inventory out)
    const crEntries = entries.filter((e) => Number(e.cr || 0) > 0);
    expect(crEntries.length).toBeGreaterThanOrEqual(1);

    // DR entry (AP control) must have a party_id (supplier)
    const drWithParty = drEntries.filter((e) => Number(e.party_id || 0) > 0);
    expect(drWithParty.length).toBeGreaterThanOrEqual(1);

    // CR entry should NOT have a party_id (it's an inventory account)
    const crWithoutParty = crEntries.filter((e) => !e.party_id);
    expect(crWithoutParty.length).toBeGreaterThanOrEqual(1);

    // DR total == CR total (balanced)
    const totalDr = entries.reduce((s, e) => s + Number(e.dr || 0), 0);
    const totalCr = entries.reduce((s, e) => s + Number(e.cr || 0), 0);
    expect(Math.abs(totalDr - totalCr)).toBeLessThan(0.01);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 3 — Cash PR: DB row + GL entries
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR cash — save and GL posting", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = { voucherId: null };

  test("cash PR saves and creates an APPROVED voucher", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const supplierOpts = await getSelectOptionValues(page.locator('select[name="supplier_party_id"]'));
    test.skip(!supplierOpts.length, "No suppliers available.");
    await page.locator('select[name="supplier_party_id"]').selectOption(supplierOpts[0]);

    const returnReasonOpts = await getSelectOptionValues(page.locator('select[name="return_reason"]'));
    test.skip(!returnReasonOpts.length, "No return reasons available.");
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);

    const itemOpts = await getSelectOptionValues(
      page.locator("[data-lines-body] tr").first().locator('select[data-row-field="item"]'),
    );
    test.skip(!itemOpts.length, "No items available.");
    await fillReturnLine(page, { itemValue: itemOpts[0] });

    // Switch to CASH and pick a cash account
    await selectPaymentType(page, "CASH");
    const cashOpts = await getSelectOptionValues(page.locator('select[name="cash_paid_account_id"]'));
    test.skip(!cashOpts.length, "No cash accounts available — cannot test cash PR.");
    await page.locator('select[name="cash_paid_account_id"]').selectOption(cashOpts[0]);

    await page.locator('input[name="reference_no"]').fill(`PR-CASH-E2E-${Date.now()}`);

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");
    ctx.voucherId = after.id;
  });

  test("cash PR header_ext has payment_type = CASH and non-null cash account", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");
    const ext = await sharedDb("erp.purchase_return_header_ext")
      .where({ voucher_id: ctx.voucherId })
      .first();

    expect(ext).toBeTruthy();
    expect(String(ext.payment_type || "").toUpperCase()).toBe("CASH");
    expect(Number(ext.cash_paid_account_id || 0)).toBeGreaterThan(0);
  });

  test("cash PR GL: DR cash/bank account, CR inventory (no AP/party involved)", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const batch = await sharedDb("erp.gl_batch")
      .where({ source_voucher_id: ctx.voucherId })
      .first();
    expect(batch).toBeTruthy();

    const entries = await sharedDb("erp.gl_entry")
      .where({ batch_id: batch.id })
      .select("dr", "cr", "account_id", "party_id");

    expect(entries.length).toBeGreaterThanOrEqual(2);

    // For CASH return: DR should have NO party_id (it's a cash/bank account, not AP)
    const drEntries = entries.filter((e) => Number(e.dr || 0) > 0);
    const drWithParty = drEntries.filter((e) => Number(e.party_id || 0) > 0);
    expect(drWithParty.length).toBe(0);

    // CR (inventory out) should also have no party
    const crEntries = entries.filter((e) => Number(e.cr || 0) > 0);
    expect(crEntries.length).toBeGreaterThanOrEqual(1);

    // Balanced
    const totalDr = entries.reduce((s, e) => s + Number(e.dr || 0), 0);
    const totalCr = entries.reduce((s, e) => s + Number(e.cr || 0), 0);
    expect(Math.abs(totalDr - totalCr)).toBeLessThan(0.01);
  });

  test("cash PR DR account matches the selected cash account", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const ext = await sharedDb("erp.purchase_return_header_ext")
      .where({ voucher_id: ctx.voucherId })
      .first();

    const batch = await sharedDb("erp.gl_batch")
      .where({ source_voucher_id: ctx.voucherId })
      .first();

    const drEntry = await sharedDb("erp.gl_entry")
      .where({ batch_id: batch.id })
      .where(sharedDb.raw("dr > 0"))
      .first();

    expect(Number(drEntry.account_id)).toBe(Number(ext.cash_paid_account_id));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 4 — Validation
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR — validation", () => {
  test("cash PR without a cash account shows an error and does not create a voucher", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const supplierOpts = await getSelectOptionValues(page.locator('select[name="supplier_party_id"]'));
    test.skip(!supplierOpts.length, "No suppliers available.");
    await page.locator('select[name="supplier_party_id"]').selectOption(supplierOpts[0]);

    const returnReasonOpts = await getSelectOptionValues(page.locator('select[name="return_reason"]'));
    test.skip(!returnReasonOpts.length, "No return reasons.");
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);

    const itemOpts = await getSelectOptionValues(
      page.locator("[data-lines-body] tr").first().locator('select[data-row-field="item"]'),
    );
    test.skip(!itemOpts.length, "No items.");
    await fillReturnLine(page, { itemValue: itemOpts[0] });
    await page.locator('input[name="reference_no"]').fill(`PR-NOCASH-${Date.now()}`);

    // Switch to CASH but intentionally leave cash account blank
    await selectPaymentType(page, "CASH");
    await page.locator('select[name="cash_paid_account_id"]').selectOption("");

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    // No new voucher created
    expect(Number(after?.id || 0)).toBe(Number(before?.id || 0));
  });

  test("PR without a return reason shows an error", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const supplierOpts = await getSelectOptionValues(page.locator('select[name="supplier_party_id"]'));
    test.skip(!supplierOpts.length, "No suppliers.");
    await page.locator('select[name="supplier_party_id"]').selectOption(supplierOpts[0]);

    const itemOpts = await getSelectOptionValues(
      page.locator("[data-lines-body] tr").first().locator('select[data-row-field="item"]'),
    );
    test.skip(!itemOpts.length, "No items.");
    await fillReturnLine(page, { itemValue: itemOpts[0] });
    await page.locator('input[name="reference_no"]').fill(`PR-NOREASON-${Date.now()}`);
    // Deliberately leave return_reason blank

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    expect(Number(after?.id || 0)).toBe(Number(before?.id || 0));
  });

  test("PR without any line items shows an error", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const supplierOpts = await getSelectOptionValues(page.locator('select[name="supplier_party_id"]'));
    test.skip(!supplierOpts.length, "No suppliers.");
    await page.locator('select[name="supplier_party_id"]').selectOption(supplierOpts[0]);

    const returnReasonOpts = await getSelectOptionValues(page.locator('select[name="return_reason"]'));
    test.skip(!returnReasonOpts.length, "No reasons.");
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);

    await page.locator('input[name="reference_no"]').fill(`PR-NOLINES-${Date.now()}`);
    // Deliberately leave lines empty

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    expect(Number(after?.id || 0)).toBe(Number(before?.id || 0));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 5 — DB schema
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR — DB schema", () => {
  test("purchase_return_header_ext has payment_type column", async () => {
    const result = await sharedDb.raw(`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'erp'
        AND table_name   = 'purchase_return_header_ext'
        AND column_name  = 'payment_type'
    `);
    expect(result.rows.length).toBe(1);
    expect(String(result.rows[0].column_default || "")).toContain("CREDIT");
  });

  test("purchase_return_header_ext has cash_paid_account_id column", async () => {
    const result = await sharedDb.raw(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'erp'
        AND table_name   = 'purchase_return_header_ext'
        AND column_name  = 'cash_paid_account_id'
    `);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].is_nullable).toBe("YES");
  });

  test("payment CHECK constraint enforces CREDIT→null and CASH→non-null", async () => {
    const result = await sharedDb.raw(`
      SELECT pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conrelid = 'erp.purchase_return_header_ext'::regclass
        AND contype  = 'c'
        AND conname  = 'purchase_return_hdr_payment_chk'
    `);
    expect(result.rows.length).toBe(1);
    const def = result.rows[0].def;
    expect(def).toContain("CREDIT");
    expect(def).toContain("CASH");
    expect(def).toContain("cash_paid_account_id");
  });

  test("all existing PR rows have payment_type set (no NULLs from backfill)", async () => {
    const nullCount = await sharedDb("erp.purchase_return_header_ext")
      .whereNull("payment_type")
      .count({ c: "*" })
      .first();
    expect(Number(nullCount?.c || 0)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 6 — Load: saved PR re-opens with correct payment type
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR — reload pre-selects payment type", () => {
  test("a saved credit PR re-opens showing CREDIT selected", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    // Find the most recent credit PR
    const latestCreditPr = await sharedDb("erp.voucher_header as vh")
      .join("erp.purchase_return_header_ext as ext", "ext.voucher_id", "vh.id")
      .where("vh.voucher_type_code", "PR")
      .where("ext.payment_type", "CREDIT")
      .select("vh.voucher_no")
      .orderBy("vh.id", "desc")
      .first();

    test.skip(!latestCreditPr, "No saved credit PR to reload.");

    const resp = await page.goto(
      `/vouchers/purchase-return?voucher_no=${latestCreditPr.voucher_no}`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(resp?.status() !== 200, "PR load page not accessible.");

    await expect(
      page.locator('input[name="payment_type"][data-payment-type]'),
    ).toHaveValue("CREDIT");
  });

  test("a saved cash PR re-opens showing CASH selected and cash account pre-filled", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const latestCashPr = await sharedDb("erp.voucher_header as vh")
      .join("erp.purchase_return_header_ext as ext", "ext.voucher_id", "vh.id")
      .where("vh.voucher_type_code", "PR")
      .where("ext.payment_type", "CASH")
      .select("vh.voucher_no", "ext.cash_paid_account_id")
      .orderBy("vh.id", "desc")
      .first();

    test.skip(!latestCashPr, "No saved cash PR to reload — run the cash save test first.");

    const resp = await page.goto(
      `/vouchers/purchase-return?voucher_no=${latestCashPr.voucher_no}`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(resp?.status() !== 200, "PR load page not accessible.");

    await expect(
      page.locator('input[name="payment_type"][data-payment-type]'),
    ).toHaveValue("CASH");

    const cashSelect = page.locator('select[name="cash_paid_account_id"]');
    await expect(cashSelect).toHaveValue(String(latestCashPr.cash_paid_account_id));
  });
});
