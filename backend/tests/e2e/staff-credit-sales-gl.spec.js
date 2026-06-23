/**
 * Staff Credit Sales — GL posting fix regression
 *
 * Verifies that credit sales vouchers for employee and labour buyers:
 *   1. Save successfully without a GL error modal
 *   2. Produce balanced GL entries (DR total = CR total)
 *   3. Post a DEBIT to the staff-receivable (or AR) control account,
 *      proving the sale is recorded as a receivable from the staff member
 *
 * Before the fix, the posting failed with:
 *   "GL posting failed: … requires control account code 'gl_staff_receivable'
 *    in group(s) 'staff_receivable_control, accounts_receivable_control'"
 * because the preferred-code check errored even when exactly one account
 * existed in those groups (no ambiguity to resolve).
 */

const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);

const uniqueToken = (prefix) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

// ── UI helpers ───────────────────────────────────────────────────────────────

const selectOptionByValuePrefix = async (selectLocator, prefix) => {
  const values = await selectLocator
    .locator("option")
    .evaluateAll((opts) =>
      opts.map((o) => String(o.value || "").trim()).filter(Boolean),
    );
  const selected = values.find((v) => v.startsWith(prefix));
  if (!selected) return null;
  await selectLocator.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selected);
  return selected;
};

const selectOptionByIndex = async (selectLocator, idx = 0) => {
  const values = await selectLocator
    .locator("option")
    .evaluateAll((opts) =>
      opts.map((o) => String(o.value || "").trim()).filter(Boolean),
    );
  if (!values.length) return null;
  const selected = values[Math.min(idx, values.length - 1)];
  await selectLocator.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selected);
  return selected;
};

// ── DB helpers ───────────────────────────────────────────────────────────────

const getVoucherNoFromUrl = (page) => {
  const params = new URL(page.url()).searchParams;
  const n = Number(params.get("voucher_no") || "");
  return Number.isFinite(n) && n > 0 ? n : null;
};

const findVoucherWithRetries = async (resolver, attempts = 15, delayMs = 300) => {
  for (let i = 0; i < attempts; i++) {
    const row = await resolver();
    if (row?.id) return row;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
};

const getSalesVoucherByBookNo = (bookNo) =>
  db("erp.voucher_header")
    .select("id", "voucher_no", "branch_id")
    .where({ voucher_type_code: "SALES_VOUCHER", book_no: bookNo })
    .orderBy("id", "desc")
    .first();

const getSalesVoucherByVoucherNo = (voucherNo) =>
  db("erp.voucher_header")
    .select("id", "voucher_no", "branch_id")
    .where({ voucher_type_code: "SALES_VOUCHER", voucher_no: Number(voucherNo) })
    .orderBy("id", "desc")
    .first();

const getLatestSalesVoucher = () =>
  db("erp.voucher_header")
    .select("id", "voucher_no", "branch_id")
    .where({ voucher_type_code: "SALES_VOUCHER" })
    .orderBy("id", "desc")
    .first();

const getSalesHeader = (voucherId) =>
  db("erp.sales_header")
    .select("payment_type", "buyer_employee_id", "buyer_labour_id", "customer_party_id")
    .where({ voucher_id: Number(voucherId) })
    .first();

const getGlEntries = async (voucherId) => {
  const batch = await db("erp.gl_batch")
    .select("id")
    .where({ source_voucher_id: Number(voucherId) })
    .first();
  if (!batch?.id) return [];
  return db("erp.gl_entry as ge")
    .join("erp.accounts as a", "a.id", "ge.account_id")
    .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .select(
      "ge.id",
      "ge.account_id",
      "ge.dr",
      "ge.cr",
      "a.code as account_code",
      "a.name as account_name",
      "ag.code as group_code",
      "ag.name as group_name",
    )
    .where({ "ge.batch_id": batch.id });
};

// ── shared voucher submission flow ───────────────────────────────────────────

const submitStaffCreditSale = async (page, { buyerPrefix, billNo }) => {
  await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

  // Switch to CREDIT
  await page.locator('[data-payment-type-option="CREDIT"]').click();
  await expect(page.locator("[data-payment-type]")).toHaveValue("CREDIT");

  // Pick salesman
  await selectOptionByIndex(
    page.locator('select[name="salesman_employee_id"]').first(),
    0,
  );

  // Bill number
  await page.locator('input[name="reference_no"]').first().fill(billNo);

  // Select buyer (EMPLOYEE: or LABOUR:)
  const customerSelect = page.locator("select[data-customer-select-wrap]").first();
  const picked = await selectOptionByValuePrefix(customerSelect, buyerPrefix);
  if (!picked) return { skipped: true, reason: `No ${buyerPrefix} buyer in dataset` };

  // Add SKU line
  if ((await page.locator("[data-lines-body] tr").count()) === 0) {
    await page.locator("[data-add-row]").click();
  }
  const row = page.locator("[data-lines-body] tr").first();
  await expect(row).toBeVisible();

  const skuSelect = row
    .locator('select[data-f="sku_id"], select[data-f="sales_order_line_id"]')
    .first();
  const skuPicked = await selectOptionByIndex(skuSelect, 0);
  if (!skuPicked) return { skipped: true, reason: "No SKU available" };

  const saleQtyInput = row.locator('input[data-f="sale_qty"]').first();
  await saleQtyInput.fill("1");
  await saleQtyInput.blur();

  // Snapshot before submit
  const beforeVoucher = await getLatestSalesVoucher();

  // Submit
  await page.locator("[data-sales-voucher-form] button[type='submit']").click();
  await page.waitForLoadState("domcontentloaded");

  return { skipped: false, beforeVoucher };
};

// ── test suite ───────────────────────────────────────────────────────────────

test.describe("Staff Credit Sales — GL posting fix", () => {
  test.afterAll(() => db.destroy());

  // ── 1. Employee buyer ──────────────────────────────────────────────────────
  test("employee credit sale saves and posts balanced GL with staff receivable debit", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const billNo = uniqueToken("E2E-EMP-CREDIT");
    const result = await submitStaffCreditSale(page, {
      buyerPrefix: "EMPLOYEE:",
      billNo,
    });

    if (result.skipped) {
      test.skip(true, result.reason);
      return;
    }

    // ── 1a. No error modal ─────────────────────────────────────────────────
    const errorModal = page.locator("[data-ui-error-modal]");
    if (await errorModal.isVisible().catch(() => false)) {
      const msg = await errorModal.textContent().catch(() => "");
      throw new Error(`GL error modal shown for employee credit sale: ${msg}`);
    }

    // ── 1b. Voucher persisted ──────────────────────────────────────────────
    const voucherNo = getVoucherNoFromUrl(page);
    const created = await findVoucherWithRetries(async () => {
      const byBook = await getSalesVoucherByBookNo(billNo);
      if (byBook?.id) return byBook;
      if (!voucherNo) return null;
      return getSalesVoucherByVoucherNo(voucherNo);
    });
    expect(created?.id, "Employee credit sale voucher must exist in DB").toBeTruthy();

    // ── 1c. sales_header has buyer_employee_id set ─────────────────────────
    const header = await getSalesHeader(created.id);
    expect(
      String(header?.payment_type || "").toUpperCase(),
      "payment_type must be CREDIT",
    ).toBe("CREDIT");
    expect(
      Number(header?.buyer_employee_id || 0),
      "buyer_employee_id must be set for employee buyer",
    ).toBeGreaterThan(0);
    expect(
      Number(header?.customer_party_id || 0),
      "customer_party_id must be null for employee buyer",
    ).toBe(0);

    // ── 1d. GL entries exist and are balanced ──────────────────────────────
    const entries = await getGlEntries(created.id);
    expect(entries.length, "GL entries must exist after save").toBeGreaterThan(0);

    const totalDr = entries.reduce((s, e) => s + Number(e.dr || 0), 0);
    const totalCr = entries.reduce((s, e) => s + Number(e.cr || 0), 0);
    expect(
      Math.abs(totalDr - totalCr),
      `GL must be balanced — DR=${totalDr} CR=${totalCr}`,
    ).toBeLessThanOrEqual(0.01);

    // ── 1e. A debit entry is on staff-receivable or AR control account ──────
    const staffReceivableGroups = new Set([
      "staff_receivable_control",
      "accounts_receivable_control",
    ]);
    const receivableDebitEntry = entries.find(
      (e) =>
        Number(e.dr || 0) > 0 &&
        staffReceivableGroups.has(String(e.group_code || "")),
    );
    expect(
      receivableDebitEntry,
      `Expected a debit GL entry in staff/AR receivable control group. Entries: ${JSON.stringify(
        entries.map((e) => ({
          account: e.account_code,
          group: e.group_code,
          dr: e.dr,
          cr: e.cr,
        })),
      )}`,
    ).toBeTruthy();
  });

  // ── 2. Labour buyer ────────────────────────────────────────────────────────
  test("labour credit sale saves and posts balanced GL with staff receivable debit", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const billNo = uniqueToken("E2E-LAB-CREDIT");
    const result = await submitStaffCreditSale(page, {
      buyerPrefix: "LABOUR:",
      billNo,
    });

    if (result.skipped) {
      test.skip(true, result.reason);
      return;
    }

    // ── 2a. No error modal ─────────────────────────────────────────────────
    const errorModal = page.locator("[data-ui-error-modal]");
    if (await errorModal.isVisible().catch(() => false)) {
      const msg = await errorModal.textContent().catch(() => "");
      throw new Error(`GL error modal shown for labour credit sale: ${msg}`);
    }

    // ── 2b. Voucher persisted ──────────────────────────────────────────────
    const voucherNo = getVoucherNoFromUrl(page);
    const created = await findVoucherWithRetries(async () => {
      const byBook = await getSalesVoucherByBookNo(billNo);
      if (byBook?.id) return byBook;
      if (!voucherNo) return null;
      return getSalesVoucherByVoucherNo(voucherNo);
    });
    expect(created?.id, "Labour credit sale voucher must exist in DB").toBeTruthy();

    // ── 2c. sales_header has buyer_labour_id set ───────────────────────────
    const header = await getSalesHeader(created.id);
    expect(
      String(header?.payment_type || "").toUpperCase(),
      "payment_type must be CREDIT",
    ).toBe("CREDIT");
    expect(
      Number(header?.buyer_labour_id || 0),
      "buyer_labour_id must be set for labour buyer",
    ).toBeGreaterThan(0);
    expect(
      Number(header?.customer_party_id || 0),
      "customer_party_id must be null for labour buyer",
    ).toBe(0);

    // ── 2d. GL entries exist and are balanced ──────────────────────────────
    const entries = await getGlEntries(created.id);
    expect(entries.length, "GL entries must exist after save").toBeGreaterThan(0);

    const totalDr = entries.reduce((s, e) => s + Number(e.dr || 0), 0);
    const totalCr = entries.reduce((s, e) => s + Number(e.cr || 0), 0);
    expect(
      Math.abs(totalDr - totalCr),
      `GL must be balanced — DR=${totalDr} CR=${totalCr}`,
    ).toBeLessThanOrEqual(0.01);

    // ── 2e. A debit entry is on staff-receivable or AR control account ──────
    const staffReceivableGroups = new Set([
      "staff_receivable_control",
      "accounts_receivable_control",
    ]);
    const receivableDebitEntry = entries.find(
      (e) =>
        Number(e.dr || 0) > 0 &&
        staffReceivableGroups.has(String(e.group_code || "")),
    );
    expect(
      receivableDebitEntry,
      `Expected a debit GL entry in staff/AR receivable control group. Entries: ${JSON.stringify(
        entries.map((e) => ({
          account: e.account_code,
          group: e.group_code,
          dr: e.dr,
          cr: e.cr,
        })),
      )}`,
    ).toBeTruthy();
  });

  // ── 3. Regression: old error message must not appear ──────────────────────
  test("error modal must NOT contain gl_staff_receivable message for any staff buyer", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    // Try employee first, then labour — whichever is available
    for (const prefix of ["EMPLOYEE:", "LABOUR:"]) {
      const billNo = uniqueToken("E2E-REGRESSION");
      await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

      await page.locator('[data-payment-type-option="CREDIT"]').click();
      await expect(page.locator("[data-payment-type]")).toHaveValue("CREDIT");

      await selectOptionByIndex(
        page.locator('select[name="salesman_employee_id"]').first(),
        0,
      );
      await page.locator('input[name="reference_no"]').first().fill(billNo);

      const customerSelect = page.locator("select[data-customer-select-wrap]").first();
      const picked = await selectOptionByValuePrefix(customerSelect, prefix);
      if (!picked) continue;

      if ((await page.locator("[data-lines-body] tr").count()) === 0) {
        await page.locator("[data-add-row]").click();
      }
      const row = page.locator("[data-lines-body] tr").first();
      const skuSelect = row
        .locator('select[data-f="sku_id"], select[data-f="sales_order_line_id"]')
        .first();
      const skuPicked = await selectOptionByIndex(skuSelect, 0);
      if (!skuPicked) continue;

      const saleQtyInput = row.locator('input[data-f="sale_qty"]').first();
      await saleQtyInput.fill("1");
      await saleQtyInput.blur();

      await page.locator("[data-sales-voucher-form] button[type='submit']").click();
      await page.waitForLoadState("domcontentloaded");

      const errorModal = page.locator("[data-ui-error-modal]");
      if (await errorModal.isVisible().catch(() => false)) {
        const msg = await errorModal.textContent().catch(() => "");
        expect(
          msg,
          `Must not see gl_staff_receivable error for ${prefix} buyer`,
        ).not.toContain("gl_staff_receivable");
      }

      // Found and tested one staff buyer — done
      return;
    }

    test.skip(true, "No EMPLOYEE or LABOUR buyers available in this dataset");
  });
});
