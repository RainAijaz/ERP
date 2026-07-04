/**
 * Sales SKU packed/loose bucket-routing regression
 *
 * Covers the bug where a sales voucher line entered in PACKED (DZN) mode
 * could still have its stock drawn from / oversell shortfall posted onto the
 * LOOSE (pairs) bucket in erp.stock_balance_sku, because
 * applySalesSkuStockOutTx picked whichever bucket sorted first / existed,
 * instead of the bucket the line was actually entered against
 * (voucher_line.meta.is_packed). This could drive the loose bucket negative
 * while the real packed bucket sat healthy, and could eventually trip the
 * erp.stock_balance_sku wac >= 0 CHECK constraint on a later voucher delete
 * once quantity crossed back above zero on the wrong bucket.
 *
 * Scenarios:
 *   1. Packed-mode sale draws from the packed bucket; loose stays untouched.
 *   2. Packed-mode oversell (no prior packed stock) posts its shortfall onto
 *      the packed bucket, not hardcoded loose (the scenario from the bug
 *      report screenshots).
 *   3. Deleting that oversold packed voucher reverses cleanly — no
 *      stock_balance_sku_wac_check crash — and restores the packed bucket.
 *   4. Loose-mode sale still draws from the loose bucket (regression guard:
 *      the fix must not break the unaffected path).
 */

const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);

const BRANCH_ID = 1;
const SKU_ID = 25; // "300-2" — FG sku whose base uom (PAIR) has a DZN packed conversion (factor 12)
const PACKED_UOM_ID = 1; // DZN
const BASE_UOM_ID = 34; // PAIR

const uniqueToken = (prefix) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

// ── low-level UI helpers (mirrors tests/e2e/credit-sales-negative-return.spec.js) ──

const setSelectValue = async (selectLocator, value) => {
  await expect(selectLocator).toHaveCount(1);
  await selectLocator.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(value));
};

// ── DB helpers ───────────────────────────────────────────────────────────────

const getBalance = (isPacked) =>
  db("erp.stock_balance_sku")
    .select("qty_pairs", "value", "wac")
    .where({
      branch_id: BRANCH_ID,
      stock_state: "ON_HAND",
      category: "FG",
      is_packed: isPacked,
      sku_id: SKU_ID,
    })
    .first();

const setBalance = ({ isPacked, qtyPairs, value, wac }) =>
  db("erp.stock_balance_sku")
    .insert({
      branch_id: BRANCH_ID,
      stock_state: "ON_HAND",
      category: "FG",
      is_packed: isPacked,
      sku_id: SKU_ID,
      qty_pairs: qtyPairs,
      value,
      wac,
      last_txn_at: db.fn.now(),
    })
    .onConflict(["branch_id", "stock_state", "category", "is_packed", "sku_id"])
    .merge({ qty_pairs: qtyPairs, value, wac, last_txn_at: db.fn.now() });

const deleteBalance = (isPacked) =>
  db("erp.stock_balance_sku")
    .where({
      branch_id: BRANCH_ID,
      stock_state: "ON_HAND",
      category: "FG",
      is_packed: isPacked,
      sku_id: SKU_ID,
    })
    .del();

const findWithRetries = async (resolver, attempts = 15, delayMs = 300) => {
  for (let i = 0; i < attempts; i += 1) {
    const row = await resolver();
    if (row?.id) return row;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
};

// The form's "reference_no" input (input[name="reference_no"]) is persisted
// to voucher_header.book_no server-side — matches the pattern already proven
// in credit-sales-negative-return.spec.js.
const getVoucherByBookNo = (bookNo) =>
  db("erp.voucher_header")
    .select("id", "voucher_no")
    .where({ voucher_type_code: "SALES_VOUCHER", book_no: bookNo })
    .orderBy("id", "desc")
    .first();

const getVoucherNoFromUrl = (page) => {
  const params = new URL(page.url()).searchParams;
  const n = Number(params.get("voucher_no") || "");
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Creates a cash sales voucher for SKU_ID via the real UI form.
// unit: "PACKED" (DZN, default for this SKU) or "LOOSE" (PAIR).
// qty is expressed in whatever unit is selected (dozens for PACKED, pairs for LOOSE).
const createCashSaleViaUi = async (page, { unit, qty, bookNo }) => {
  await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

  await page.locator('input[name="reference_no"]').first().fill(bookNo);
  await page.locator('input[name="customer_name"]').first().fill("E2E Walk-in Customer");
  await page.locator('input[name="customer_phone_number"]').first().fill("03211234567");
  await setSelectValue(
    page.locator('select[data-salesman]').first(),
    await page
      .locator('select[data-salesman] option:not([value=""])')
      .first()
      .evaluate((el) => el.value),
  );
  await setSelectValue(
    page.locator('select[data-receive-account]').first(),
    await page
      .locator('select[data-receive-account] option:not([value=""])')
      .first()
      .evaluate((el) => el.value),
  );

  if ((await page.locator("[data-lines-body] tr").count()) === 0) {
    await page.locator("[data-add-row]").click();
  }
  const row = page.locator("[data-lines-body] tr").first();
  await expect(row).toBeVisible();

  await setSelectValue(row.locator('select[data-f="sku_id"]').first(), SKU_ID);

  // Selecting the SKU rebuilds the row and defaults uom_id to the packed
  // option (see index.ejs linesBody "change" handler: getDefaultUomIdForSku
  // (sku, true)). For a LOOSE-mode scenario, explicitly switch to the base
  // (PAIR) unit afterwards, mirroring a user picking "Pair" from the dropdown.
  const rowAfterSkuPick = page.locator("[data-lines-body] tr").first();
  if (unit === "LOOSE") {
    await setSelectValue(
      rowAfterSkuPick.locator('select[data-f="uom_id"]').first(),
      BASE_UOM_ID,
    );
  } else {
    await expect(rowAfterSkuPick.locator('select[data-f="uom_id"]').first()).toHaveValue(
      String(PACKED_UOM_ID),
    );
  }

  const saleQtyInput = rowAfterSkuPick.locator('input[data-f="sale_qty"]').first();
  await saleQtyInput.fill(String(qty));
  await saleQtyInput.blur();

  // CASH sales require full payment received up-front — mirror the final amount.
  const finalInput = page.locator("[data-final]").first();
  const finalRaw = await finalInput.inputValue().catch(() => "0");
  const receivedInput = page.locator("[data-received]").first();
  await receivedInput.fill(String(finalRaw || "0").replace(/,/g, ""));
  await receivedInput.blur();

  await page.locator("[data-sales-voucher-form] button[type='submit']").click();
  await page.waitForLoadState("domcontentloaded");

  const errorModal = page.locator("[data-ui-error-modal]");
  if (await errorModal.isVisible().catch(() => false)) {
    const msg = await errorModal.textContent().catch(() => "");
    throw new Error(`Unexpected error after submit: ${msg}`);
  }

  const voucherNo = getVoucherNoFromUrl(page);
  const created = await findWithRetries(async () => {
    const byBook = await getVoucherByBookNo(bookNo);
    if (byBook?.id) return byBook;
    if (!voucherNo) return null;
    return db("erp.voucher_header")
      .select("id", "voucher_no")
      .where({ voucher_type_code: "SALES_VOUCHER", voucher_no: voucherNo })
      .first();
  });
  expect(created?.id, "voucher should have been persisted in DB").toBeTruthy();
  return created;
};

// Deletes a voucher via the real UI delete form (bypassing the client-side
// confirm modal, which is just a UX gate — not part of what's under test).
// voucherNo is the business-facing sequential number (erp.voucher_header.voucher_no),
// not the DB primary key — that's what the page's ?voucher_no= query param expects.
const deleteVoucherViaUi = async (page, voucherNo) => {
  // The page performs a client-side redirect/normalization right after load
  // for this route, which can abort Playwright's initial navigation promise
  // (net::ERR_ABORTED) even though the page settles correctly — ignore it and
  // just wait for the expected content below.
  await page
    .goto(`/vouchers/sales?voucher_no=${voucherNo}&view=1`, {
      waitUntil: "domcontentloaded",
    })
    .catch(() => {});
  const deleteForm = page.locator("[data-delete-voucher-form]");
  await expect(deleteForm).toHaveCount(1);
  await deleteForm.evaluate((form) => form.requestSubmit());

  // A global submit interceptor (main.ejs) shows a "Confirm Delete" modal for
  // any destructive form submit — confirm it to actually proceed.
  const confirmYes = page.locator("[data-global-delete-confirm-yes]");
  await confirmYes.waitFor({ state: "visible", timeout: 5000 });
  await confirmYes.click();
  await page.waitForLoadState("domcontentloaded");

  const errorModal = page.locator("[data-ui-error-modal]");
  if (await errorModal.isVisible().catch(() => false)) {
    const msg = await errorModal.textContent().catch(() => "");
    throw new Error(`Unexpected error deleting voucher: ${msg}`);
  }
};

test.describe("Sales SKU packed/loose bucket routing", () => {
  const createdVoucherIds = [];
  let snapshot = { packed: null, loose: null };

  test.beforeAll(async () => {
    snapshot.packed = await getBalance(true);
    snapshot.loose = await getBalance(false);
  });

  test.afterAll(async () => {
    // Undo everything this suite touched so the dev DB is left exactly as found.
    if (createdVoucherIds.length) {
      await db("erp.voucher_header").whereIn("id", createdVoucherIds).del();
    }
    if (snapshot.packed) {
      await setBalance({ isPacked: true, ...snapshot.packed });
    } else {
      await deleteBalance(true);
    }
    if (snapshot.loose) {
      await setBalance({ isPacked: false, ...snapshot.loose });
    } else {
      await deleteBalance(false);
    }
    await db.destroy();
  });

  test.beforeEach(async () => {
    // Deterministic baseline before each scenario: packed bucket healthy
    // with plenty of stock, loose bucket empty (no row at all — matches the
    // "packed stock exists, loose was never even seeded" bug scenario).
    await setBalance({ isPacked: true, qtyPairs: 240, value: 24000, wac: 100 });
    await deleteBalance(false);
  });

  test("packed-mode sale draws from the packed bucket, loose stays untouched", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const bookNo = uniqueToken("E2E-PACKED-SALE");

    const voucher = await createCashSaleViaUi(page, { unit: "PACKED", qty: 2, bookNo });
    createdVoucherIds.push(Number(voucher.id));

    const packed = await getBalance(true);
    const loose = await getBalance(false);

    expect(Number(packed?.qty_pairs || 0), "packed bucket drawn down by 24 pairs (2 DZN)").toBe(
      240 - 24,
    );
    expect(Number(packed?.wac || 0), "packed wac non-negative").toBeGreaterThanOrEqual(0);
    expect(
      !loose || Number(loose.qty_pairs) === 0,
      "loose bucket must NOT have been created/drawn negative",
    ).toBeTruthy();

    const ledgerRows = await db("erp.stock_ledger")
      .select("is_packed", "qty_pairs", "direction")
      .where({ voucher_header_id: Number(voucher.id) });
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].is_packed, "ledger row tagged is_packed=true").toBe(true);
    expect(Number(ledgerRows[0].qty_pairs)).toBe(24);
    expect(Number(ledgerRows[0].direction)).toBe(-1);
  });

  test("packed-mode oversell with no prior packed stock posts its shortfall onto the packed bucket, not loose", async ({
    page,
  }) => {
    // Re-baseline: no stock in EITHER bucket, simulating the reported scenario
    // where a packed sale happens before any packed balance row exists yet.
    await deleteBalance(true);
    await deleteBalance(false);

    await login(page, "E2E_ADMIN");
    const bookNo = uniqueToken("E2E-PACKED-OVERSELL");

    const voucher = await createCashSaleViaUi(page, { unit: "PACKED", qty: 3, bookNo });
    createdVoucherIds.push(Number(voucher.id));

    const packed = await getBalance(true);
    const loose = await getBalance(false);

    expect(
      Number(packed?.qty_pairs || 0),
      "shortfall (3 DZN = 36 pairs) landed on the packed bucket as a negative balance",
    ).toBe(-36);
    expect(Number(packed?.wac || 0), "packed wac stays non-negative even when oversold").toBeGreaterThanOrEqual(
      0,
    );
    expect(
      !loose || Number(loose.qty_pairs) === 0,
      "loose bucket must stay untouched by a packed-mode oversell",
    ).toBeTruthy();
  });

  test("deleting an oversold packed voucher reverses cleanly without the wac constraint crashing", async ({
    page,
  }) => {
    await deleteBalance(true);
    await deleteBalance(false);

    await login(page, "E2E_ADMIN");
    const bookNo = uniqueToken("E2E-PACKED-DEL");

    const voucher = await createCashSaleViaUi(page, { unit: "PACKED", qty: 3, bookNo });

    const packedBeforeDelete = await getBalance(true);
    expect(Number(packedBeforeDelete?.qty_pairs || 0)).toBe(-36);

    await deleteVoucherViaUi(page, Number(voucher.voucher_no));
    createdVoucherIds.push(Number(voucher.id));

    // Delete is a soft-delete (status flip), not a row removal.
    const afterDelete = await db("erp.voucher_header")
      .select("status")
      .where({ id: Number(voucher.id) })
      .first();
    expect(
      String(afterDelete?.status || "").toUpperCase(),
      "voucher status flipped to REJECTED after delete",
    ).toBe("REJECTED");

    const packedAfterDelete = await getBalance(true);
    expect(
      Number(packedAfterDelete?.qty_pairs || 0),
      "packed bucket restored back to 0 after the sale was reversed",
    ).toBe(0);
    expect(
      Number(packedAfterDelete?.wac || 0),
      "wac non-negative after reversal (the original crash: stock_balance_sku_wac_check)",
    ).toBeGreaterThanOrEqual(0);
  });

  test("loose-mode sale still draws from the loose bucket (fix does not break the unaffected path)", async ({
    page,
  }) => {
    await setBalance({ isPacked: false, qtyPairs: 50, value: 5000, wac: 100 });

    await login(page, "E2E_ADMIN");
    const bookNo = uniqueToken("E2E-LOOSE-SALE");

    const voucher = await createCashSaleViaUi(page, { unit: "LOOSE", qty: 5, bookNo });
    createdVoucherIds.push(Number(voucher.id));

    const packed = await getBalance(true);
    const loose = await getBalance(false);

    expect(Number(loose?.qty_pairs || 0), "loose bucket drawn down by 5 pairs").toBe(50 - 5);
    expect(
      Number(packed?.qty_pairs || 0),
      "packed bucket untouched by a loose-mode sale",
    ).toBe(240);

    const ledgerRows = await db("erp.stock_ledger")
      .select("is_packed", "qty_pairs", "direction")
      .where({ voucher_header_id: Number(voucher.id) });
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].is_packed, "ledger row tagged is_packed=false").toBe(false);
    expect(Number(ledgerRows[0].qty_pairs)).toBe(5);
  });
});
