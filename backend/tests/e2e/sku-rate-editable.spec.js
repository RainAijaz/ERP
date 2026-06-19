/**
 * E2E tests for the per-article rate_editable feature.
 *
 * Covers:
 *  1. SKU page (admin): Fixed pill shown by default; clicking it
 *     toggles the variant to Flexible and back.
 *  2. Sales Voucher UI (std user, no approve perm):
 *     - pair_rate is readonly when SKU has rate_editable = false
 *     - pair_rate is editable when SKU has rate_editable = true
 *     - Typing a custom rate updates totals correctly
 */

const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  upsertUserWithPermissions,
  setUserScopePermission,
  getFirstFgVariantWithRate,
  setVariantRateEditable,
  closeDb,
} = require("./utils/db");

// ─── constants ────────────────────────────────────────────────────────────

const STD_PREFIX = "E2E_RATE_STD"; // maps to E2E_RATE_STD_USER / E2E_RATE_STD_PASSWORD

// ─── helpers ──────────────────────────────────────────────────────────────

/** Sets a <select data-f="..."> by dispatching native change. */
const selectByValue = async (locator, value) => {
  await locator.evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
};

/** Selects the first non-empty option in a <select>. */
const selectFirstOption = async (locator) => {
  const values = await locator.locator("option").evaluateAll((opts) =>
    opts.map((o) => String(o.value || "").trim()).filter((v) => v.length > 0),
  );
  if (!values.length) return null;
  await selectByValue(locator, values[0]);
  return values[0];
};

/** Ensures there is at least one row in the lines table. */
const ensureRow = async (page) => {
  const rows = page.locator("[data-lines-body] tr[data-i]");
  if ((await rows.count()) === 0) {
    const addBtn = page.locator("[data-add-row]").first();
    if ((await addBtn.count()) === 0) return null;
    await addBtn.click();
    await page.waitForTimeout(200);
  }
  const row = page.locator("[data-lines-body] tr[data-i]").first();
  if ((await row.count()) === 0) return null;
  await expect(row).toBeVisible();
  return row;
};

/** Fills the minimum required sales voucher header fields. */
const fillSalesHeader = async (page) => {
  const customerSel = page.locator('select[name="customer_party_id"]').first();
  const salesmanSel = page.locator('select[name="salesman_employee_id"]').first();
  if ((await customerSel.count()) > 0) await selectFirstOption(customerSel);
  if ((await salesmanSel.count()) > 0) await selectFirstOption(salesmanSel);
};

// ─── fixture state ────────────────────────────────────────────────────────

let fixture = null; // { variant_id, sku_id, sku_code, sale_rate }
let stdUserId = null;

test.beforeAll(async () => {
  fixture = await getFirstFgVariantWithRate();
  if (!fixture) return;

  // Ensure we start with rate_editable = false
  await setVariantRateEditable(fixture.variant_id, false);

  // Create a non-admin user with VOUCHER:SALES_VOUCHER view+create (no approve)
  const branch = await getBranch();
  stdUserId = await upsertUserWithPermissions({
    username: process.env.E2E_RATE_STD_USER || "e2e_rate_std",
    password: process.env.E2E_RATE_STD_PASSWORD || process.env.E2E_RATE_STD_PASS || "Rate@123",
    branchId: branch?.id || null,
    scopeKeys: [],
  });

  if (stdUserId) {
    await setUserScopePermission({
      userId: stdUserId,
      scopeType: "VOUCHER",
      scopeKey: "SALES_VOUCHER",
      permissions: {
        can_navigate: true,
        can_view: true,
        can_create: true,
        can_edit: true,
        can_approve: false, // deliberately no approve → canOverrideRateDiscount stays false
      },
    });
  }
});

test.afterAll(async () => {
  if (fixture) await setVariantRateEditable(fixture.variant_id, false);
  await closeDb();
});

// ══════════════════════════════════════════════════════════════════════════
// 1. SKU PAGE TOGGLE
// ══════════════════════════════════════════════════════════════════════════

test.describe("SKU page — rate_editable toggle", () => {
  // Reset to fixed before every SKU page test
  test.beforeEach(async () => {
    if (fixture) await setVariantRateEditable(fixture.variant_id, false);
  });

  test("Fixed pill is shown by default for an FG variant", async ({ page }) => {
    test.skip(!fixture, "No active FG variant with sale_rate > 0 found in DB.");

    await login(page, "E2E_ADMIN");
    const url = `/master-data/products/skus?item_type=FG&search=${encodeURIComponent(fixture.sku_code)}`;
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
    test.skip(!resp || resp.status() !== 200, "SKU page not accessible.");

    const toggleForm = page.locator(`form[action*="/${fixture.variant_id}/rate-editable-toggle"]`);
    await expect(toggleForm).toBeVisible({ timeout: 8000 });

    const btnText = ((await toggleForm.locator("button[type='submit']").textContent()) || "").trim().toLowerCase();
    expect(btnText).toContain("fixed");
  });

  test("Toggle Fixed → Flexible changes DB and renders Flexible pill", async ({ page }) => {
    test.skip(!fixture, "No active FG variant with sale_rate > 0 found in DB.");

    const searchUrl = `/master-data/products/skus?item_type=FG&search=${encodeURIComponent(fixture.sku_code)}`;
    await login(page, "E2E_ADMIN");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

    // Click the Fixed toggle button
    const toggleForm = page.locator(`form[action*="/${fixture.variant_id}/rate-editable-toggle"]`);
    await expect(toggleForm).toBeVisible({ timeout: 8000 });

    // Submit and wait for redirect, then re-navigate to verify
    await toggleForm.locator("button[type='submit']").click();
    await page.waitForLoadState("domcontentloaded");

    // Re-navigate to the search URL to get a fresh render
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

    const toggleForm2 = page.locator(`form[action*="/${fixture.variant_id}/rate-editable-toggle"]`);
    await expect(toggleForm2).toBeVisible({ timeout: 8000 });

    const btnText = ((await toggleForm2.locator("button[type='submit']").textContent()) || "").trim().toLowerCase();
    expect(btnText).toContain("flexible");
  });

  test("Toggle Flexible → Fixed changes DB and renders Fixed pill", async ({ page }) => {
    test.skip(!fixture, "No active FG variant with sale_rate > 0 found in DB.");

    // Start with rate_editable = true
    await setVariantRateEditable(fixture.variant_id, true);

    const searchUrl = `/master-data/products/skus?item_type=FG&search=${encodeURIComponent(fixture.sku_code)}`;
    await login(page, "E2E_ADMIN");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

    const toggleForm = page.locator(`form[action*="/${fixture.variant_id}/rate-editable-toggle"]`);
    await expect(toggleForm).toBeVisible({ timeout: 8000 });

    // Verify it currently shows Flexible
    const btnBefore = ((await toggleForm.locator("button[type='submit']").textContent()) || "").trim().toLowerCase();
    expect(btnBefore).toContain("flexible");

    // Click to toggle back
    await toggleForm.locator("button[type='submit']").click();
    await page.waitForLoadState("domcontentloaded");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

    const toggleForm2 = page.locator(`form[action*="/${fixture.variant_id}/rate-editable-toggle"]`);
    await expect(toggleForm2).toBeVisible({ timeout: 8000 });

    const btnAfter = ((await toggleForm2.locator("button[type='submit']").textContent()) || "").trim().toLowerCase();
    expect(btnAfter).toContain("fixed");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. SALES VOUCHER UI — READONLY vs EDITABLE pair_rate
// ══════════════════════════════════════════════════════════════════════════

test.describe("Sales Voucher UI — pair_rate readonly/editable", () => {
  test.beforeEach(async () => {
    if (fixture) await setVariantRateEditable(fixture.variant_id, false);
  });

  test("pair_rate is READONLY for fixed SKU (std user, no approve perm)", async ({ page }) => {
    test.skip(!fixture || !stdUserId, "Fixture or std user not available.");

    await login(page, STD_PREFIX);
    const resp = await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    test.skip(!resp || resp.status() !== 200, "Sales voucher page not accessible.");

    await fillSalesHeader(page);
    const row = await ensureRow(page);
    test.skip(!row, "Could not add a line row.");

    const skuSelect = row.locator('select[data-f="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    await selectByValue(skuSelect, String(fixture.sku_id));
    await page.waitForTimeout(300);

    const rateInput = page.locator("[data-lines-body] tr[data-i='0'] input[data-f='pair_rate']").first();
    await expect(rateInput).toBeVisible();

    const isReadonly = await rateInput.evaluate((el) => el.readOnly || el.hasAttribute("readonly"));
    expect(isReadonly).toBe(true);

    const classes = await rateInput.getAttribute("class") || "";
    expect(classes).toContain("bg-slate-100");
  });

  test("pair_rate is EDITABLE for rate_editable SKU (std user, no approve perm)", async ({ page }) => {
    test.skip(!fixture || !stdUserId, "Fixture or std user not available.");

    await setVariantRateEditable(fixture.variant_id, true);

    await login(page, STD_PREFIX);
    const resp = await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    test.skip(!resp || resp.status() !== 200, "Sales voucher page not accessible.");

    await fillSalesHeader(page);
    const row = await ensureRow(page);
    test.skip(!row, "Could not add a line row.");

    const skuSelect = row.locator('select[data-f="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    await selectByValue(skuSelect, String(fixture.sku_id));
    await page.waitForTimeout(300);

    const rateInput = page.locator("[data-lines-body] tr[data-i='0'] input[data-f='pair_rate']").first();
    await expect(rateInput).toBeVisible();

    const isReadonly = await rateInput.evaluate((el) => el.readOnly || el.hasAttribute("readonly"));
    expect(isReadonly).toBe(false);

    const classes = await rateInput.getAttribute("class") || "";
    expect(classes).toContain("bg-white");
    expect(classes).not.toContain("bg-slate-100");
  });

  test("Custom rate updates totals correctly for rate_editable SKU", async ({ page }) => {
    test.skip(!fixture || !stdUserId, "Fixture or std user not available.");

    await setVariantRateEditable(fixture.variant_id, true);

    await login(page, STD_PREFIX);
    const resp = await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    test.skip(!resp || resp.status() !== 200, "Sales voucher page not accessible.");

    await fillSalesHeader(page);
    const row = await ensureRow(page);
    test.skip(!row, "Could not add a line row.");

    const skuSelect = row.locator('select[data-f="sku_id"]').first();
    await selectByValue(skuSelect, String(fixture.sku_id));
    await page.waitForTimeout(300);

    const rateInput  = page.locator("[data-lines-body] tr[data-i='0'] input[data-f='pair_rate']").first();
    const qtyInput   = page.locator("[data-lines-body] tr[data-i='0'] input[data-f='sale_qty']").first();
    const totalInput = page.locator("[data-lines-body] tr[data-i='0'] input[data-f='total_amount']").first();

    await expect(rateInput).toBeVisible();

    const qty        = 10;
    const customRate = Number((Number(fixture.sale_rate) + 50).toFixed(1));

    await qtyInput.fill(String(qty));
    await qtyInput.dispatchEvent("change");
    await page.waitForTimeout(100);

    await rateInput.fill(String(customRate));
    await rateInput.dispatchEvent("change");
    await page.waitForTimeout(100);

    const totalRaw = await totalInput.inputValue();
    const totalNum = Number(String(totalRaw || "0").replace(/,/g, ""));
    const expected = qty * customRate;

    // Allow ±1 for rounding at the pair level
    expect(Math.abs(totalNum - expected)).toBeLessThanOrEqual(1);
  });

  test("rate_editable=true field shows default sale_rate pre-filled (editable but starts correct)", async ({ page }) => {
    test.skip(!fixture || !stdUserId, "Fixture or std user not available.");

    await setVariantRateEditable(fixture.variant_id, true);

    await login(page, STD_PREFIX);
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

    await fillSalesHeader(page);
    const row = await ensureRow(page);
    test.skip(!row, "Could not add a line row.");

    const skuSelect = row.locator('select[data-f="sku_id"]').first();
    await selectByValue(skuSelect, String(fixture.sku_id));
    await page.waitForTimeout(300);

    const rateInput = page.locator("[data-lines-body] tr[data-i='0'] input[data-f='pair_rate']").first();
    const rawValue  = await rateInput.inputValue();
    const rateValue = Number(String(rawValue || "0").replace(/,/g, ""));

    // The auto-populated rate should match the SKU's sale_rate
    expect(Math.abs(rateValue - Number(fixture.sale_rate))).toBeLessThanOrEqual(1);
  });
});
