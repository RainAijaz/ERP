/**
 * Credit Sales Voucher — pure-return (negative total) regression
 *
 * Verifies the fix that allows a credit sales voucher whose return lines
 * exceed (or replace) sales lines, producing a negative final amount.
 *
 * Before the fix three checks blocked this:
 *   1. sales-voucher-service.js — finalAmount < 0 guard rejected non-CASH
 *   2. sales-voucher-service.js — maxAllowedReceivedAmount went negative,
 *      so even paymentReceivedAmount=0 failed the > check
 *   3. gl-posting-service.js   — hard-errored on negative netSaleAmount
 *                                 for non-CASH vouchers
 */

const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);

const uniqueToken = (prefix) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

// ── low-level UI helpers (self-contained, no shared import needed) ──────────

const selectOptionByIndex = async (selectLocator, optionIndex = 0) => {
  await expect(selectLocator).toHaveCount(1);
  const values = await selectLocator
    .locator("option")
    .evaluateAll((opts) =>
      opts.map((o) => String(o.value || "").trim()).filter(Boolean),
    );
  if (!values.length) return null;
  const selected = values[Math.min(optionIndex, values.length - 1)];
  await selectLocator.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selected);
  return selected;
};

// Selects the first option whose value starts with the given prefix (e.g. "PARTY:")
const selectOptionByValuePrefix = async (selectLocator, prefix) => {
  await expect(selectLocator).toHaveCount(1);
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

// ── DB helpers ───────────────────────────────────────────────────────────────

const getLatestVoucherByType = ({ voucherTypeCode }) =>
  db("erp.voucher_header")
    .select("id", "voucher_no", "book_no", "created_at")
    .where({ voucher_type_code: voucherTypeCode })
    .orderBy("id", "desc")
    .first();

const getVoucherByBookNo = ({ voucherTypeCode, bookNo }) =>
  db("erp.voucher_header")
    .select("id", "voucher_no", "book_no", "created_at")
    .where({ voucher_type_code: voucherTypeCode, book_no: bookNo })
    .orderBy("id", "desc")
    .first();

const getVoucherByVoucherNo = ({ voucherTypeCode, voucherNo }) =>
  db("erp.voucher_header")
    .select("id", "voucher_no", "book_no", "created_at")
    .where({
      voucher_type_code: voucherTypeCode,
      voucher_no: Number(voucherNo),
    })
    .orderBy("id", "desc")
    .first();

const findWithRetries = async (resolver, attempts = 15, delayMs = 300) => {
  for (let i = 0; i < attempts; i += 1) {
    const row = await resolver();
    if (row?.id) return row;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
};

const getVoucherNoFromUrl = (page) => {
  const params = new URL(page.url()).searchParams;
  const n = Number(params.get("voucher_no") || "");
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ── test suite ───────────────────────────────────────────────────────────────

test.describe("Credit Sales Voucher — 7-dozen pure return (negative total)", () => {
  test.afterAll(() => db.destroy());

  test(
    "saves a credit voucher with only return lines (7 dozen) without error",
    async ({ page }) => {
      await login(page, "E2E_ADMIN");
      await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

      const before = await getLatestVoucherByType({
        voucherTypeCode: "SALES_VOUCHER",
      });

      const bookNo = uniqueToken("E2E-CR-RETURN");

      // ── header ────────────────────────────────────────────────────────────
      await page
        .locator('input[name="reference_no"]')
        .first()
        .fill(bookNo);

      await selectOptionByIndex(
        page.locator('select[name="salesman_employee_id"]').first(),
        0,
      );

      // switch to CREDIT first so the party customer field appears
      await page.locator('[data-payment-type-option="CREDIT"]').click();
      await expect(page.locator("[data-payment-type]")).toHaveValue("CREDIT");

      // the credit-sale customer uses data-customer-select-wrap (not name=customer_party_id)
      // pick first PARTY: type so the AR control account (partyReceivable) is used for GL
      const customerSelectResult = await selectOptionByValuePrefix(
        page.locator('select[data-customer-select-wrap]').first(),
        "PARTY:",
      );
      test.skip(!customerSelectResult, "No PARTY type customer available in this dataset");

      // ── return line: 7 dozen, no sale qty ────────────────────────────────
      // ensure at least one row exists
      if ((await page.locator("[data-lines-body] tr").count()) === 0) {
        await page.locator("[data-add-row]").click();
      }

      const row = page.locator("[data-lines-body] tr").first();
      await expect(row).toBeVisible();

      // pick first available SKU
      const skuSelect = row
        .locator('select[data-f="sku_id"], select[data-f="sales_order_line_id"]')
        .first();
      await selectOptionByIndex(skuSelect, 0);

      // clear the sale qty so this is a pure return row
      const saleQtyInput = row.locator('input[data-f="sale_qty"]').first();
      await saleQtyInput.fill("");
      await saleQtyInput.blur();

      // enter 7 dozen as the return quantity
      const returnQtyInput = row.locator('input[data-f="return_qty"]').first();
      await expect(returnQtyInput).toBeVisible();
      await returnQtyInput.fill("7");
      await returnQtyInput.blur();

      // pick first return reason if the field is present
      const reasonSelect = row
        .locator('select[data-f="return_reason_id"]')
        .first();
      if ((await reasonSelect.count()) > 0) {
        await selectOptionByIndex(reasonSelect, 0);
      }

      // ── assert the UI shows a negative final amount ───────────────────────
      const finalInput = page.locator("[data-final]").first();
      if ((await finalInput.count()) > 0) {
        const raw = await finalInput
          .inputValue()
          .catch(() => finalInput.textContent());
        const finalVal = Number(String(raw || "0").replace(/,/g, ""));
        expect(finalVal).toBeLessThan(0);
      }

      // payment received must be 0 on a negative-total credit voucher
      const receivedInput = page.locator("[data-received]").first();
      if ((await receivedInput.count()) > 0) {
        await receivedInput.fill("0");
        await receivedInput.blur();
      }

      // ── submit ────────────────────────────────────────────────────────────
      await page
        .locator("[data-sales-voucher-form] button[type='submit']")
        .click();
      await page.waitForLoadState("domcontentloaded");

      // must NOT show an error modal
      const errorModal = page.locator("[data-ui-error-modal]");
      if (await errorModal.isVisible().catch(() => false)) {
        const msg = await errorModal.textContent().catch(() => "");
        throw new Error(`Unexpected error after submit: ${msg}`);
      }

      // ── verify voucher exists in DB ───────────────────────────────────────
      const voucherNo = getVoucherNoFromUrl(page);

      let created = await findWithRetries(async () => {
        const byBook = await getVoucherByBookNo({
          voucherTypeCode: "SALES_VOUCHER",
          bookNo,
        });
        if (byBook?.id) return byBook;
        if (!voucherNo) return null;
        return getVoucherByVoucherNo({
          voucherTypeCode: "SALES_VOUCHER",
          voucherNo,
        });
      });

      // last-resort fallback: newest voucher created after our snapshot
      if (!created?.id) {
        const latest = await getLatestVoucherByType({
          voucherTypeCode: "SALES_VOUCHER",
        });
        if (latest?.id && Number(latest.id) > Number(before?.id || 0)) {
          created = latest;
        }
      }

      expect(created?.id, "voucher should have been persisted in DB").toBeTruthy();

      // ── verify payment_type = CREDIT ──────────────────────────────────────
      const salesHeader = await db("erp.sales_header")
        .select("payment_type", "customer_party_id")
        .where({ voucher_id: Number(created.id) })
        .first();

      expect(
        String(salesHeader?.payment_type || "").toUpperCase(),
        "payment_type must be CREDIT",
      ).toBe("CREDIT");

      expect(
        Number(salesHeader?.customer_party_id || 0),
        "customer_party_id must be set for credit voucher",
      ).toBeGreaterThan(0);

      // ── verify the net line amount is negative (returns exceed sales) ─────
      const lineSum = await db("erp.voucher_line")
        .where({ voucher_header_id: Number(created.id), line_kind: "SKU" })
        .sum({ total: db.raw("COALESCE(amount, 0)") })
        .first();

      expect(
        Number(lineSum?.total || 0),
        "net SKU line total must be negative (pure return voucher)",
      ).toBeLessThan(0);
    },
  );
});
