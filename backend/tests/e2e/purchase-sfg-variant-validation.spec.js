const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getSfgPurchaseValidationFixture,
  sumSfgSkuQtyPairs,
  getSfgInLedgerRow,
  getLatestVoucherHeader,
} = require("./utils/db");

const GENERAL_PURCHASE_TYPE = "PI";

// General Purchase lives at /vouchers/purchase; ?new=1 opens a blank form.
const GENERAL_PURCHASE_PATH = "/vouchers/purchase";
const GENERAL_PURCHASE_URL = `${GENERAL_PURCHASE_PATH}?new=1`;

const getSelectOptionValues = async (selectLocator) =>
  selectLocator
    .locator("option")
    .evaluateAll((options) =>
      options.map((o) => String(o.value || "").trim()).filter(Boolean),
    );

// Posts a General Purchase form-encoded payload directly (bypassing the
// constrained UI dropdowns) so we can exercise the server-side rule with an
// arbitrary color/size. maxRedirects:0 keeps success as a 302 and validation
// failures as a 400 JSON body (see error-handler when Accept: application/json).
const postPurchase = async (page, { csrf, voucherDate, supplierId, line }) =>
  page.request.post(GENERAL_PURCHASE_PATH, {
    headers: { Accept: "application/json" },
    maxRedirects: 0,
    form: {
      _csrf: csrf,
      voucher_id: "",
      voucher_date: voucherDate,
      purchase_category: "RAW_MATERIAL",
      supplier_party_id: String(supplierId),
      reference_no: `SFG-VAR-E2E-${Date.now()}`,
      description: "",
      payment_type: "CREDIT",
      lines_json: JSON.stringify([line]),
    },
  });

test.describe("General Purchase - SFG variant (SKU) validation", () => {
  test.describe.configure({ mode: "serial" });

  let fixture = null;

  test.beforeAll(async () => {
    fixture = await getSfgPurchaseValidationFixture();
  });

  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  test("SFG line color/size selectors are constrained to real variants", async ({
    page,
  }) => {
    test.skip(
      !fixture,
      "No SFG item with an active variant/SKU (and no rm rates) in this DB.",
    );

    // The dimension we can meaningfully assert on: a valid variant value that
    // must appear, plus a spare active value that must NOT (it's not a variant).
    const canCheckColor =
      Boolean(fixture.validColorId) && Boolean(fixture.bogusColorId);
    const canCheckSize =
      Boolean(fixture.validSizeId) && Boolean(fixture.bogusSizeId);
    test.skip(
      !canCheckColor && !canCheckSize,
      "Fixture lacks a valid+bogus color or size pair to compare.",
    );

    const response = await page.goto(GENERAL_PURCHASE_URL, {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "General Purchase page not accessible.",
    );

    const itemSelect = page
      .locator("[data-lines-body] tr")
      .first()
      .locator('select[data-row-field="item"]');
    const itemOptions = await getSelectOptionValues(itemSelect);
    test.skip(
      !itemOptions.includes(String(fixture.itemId)),
      "SFG fixture item not offered in this branch's purchase form.",
    );

    // Picking the SFG item re-renders the row's color + size selects from the
    // item's real variants only — no purchase-rate-derived or free options.
    await itemSelect.selectOption(String(fixture.itemId));

    if (canCheckColor) {
      const colorSelect = page
        .locator("[data-lines-body] tr")
        .first()
        .locator('select[data-row-field="color"]');
      await expect
        .poll(async () => getSelectOptionValues(colorSelect))
        .toContain(String(fixture.validColorId));
      const colorOptions = await getSelectOptionValues(colorSelect);
      expect(colorOptions).not.toContain(String(fixture.bogusColorId));
    }

    if (canCheckSize) {
      const sizeSelect = page
        .locator("[data-lines-body] tr")
        .first()
        .locator('select[data-row-field="size"]');
      await expect
        .poll(async () => getSelectOptionValues(sizeSelect))
        .toContain(String(fixture.validSizeId));
      const sizeOptions = await getSelectOptionValues(sizeSelect);
      expect(sizeOptions).not.toContain(String(fixture.bogusSizeId));
    }
  });

  test("server rejects an SFG line whose color/size is not a defined SKU", async ({
    page,
  }) => {
    test.skip(
      !fixture,
      "No SFG item with an active variant/SKU (and no rm rates) in this DB.",
    );
    test.skip(
      !fixture.bogusColorId,
      "No spare active color available to form a bogus (non-variant) combo.",
    );

    const response = await page.goto(GENERAL_PURCHASE_URL, {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "General Purchase page not accessible.",
    );

    const supplierOptions = await getSelectOptionValues(
      page.locator("[data-supplier-select]"),
    );
    test.skip(!supplierOptions.length, "No supplier options available.");

    const itemOptions = await getSelectOptionValues(
      page
        .locator("[data-lines-body] tr")
        .first()
        .locator('select[data-row-field="item"]'),
    );
    test.skip(
      !itemOptions.includes(String(fixture.itemId)),
      "SFG fixture item not offered in this branch's purchase form.",
    );

    const csrf = await page
      .locator("[data-purchase-voucher-form] input[name='_csrf']")
      .first()
      .inputValue();
    const voucherDate =
      (await page
        .locator("[data-purchase-voucher-form] input[name='voucher_date']")
        .first()
        .inputValue()
        .catch(() => "")) || new Date().toISOString().slice(0, 10);

    const res = await postPurchase(page, {
      csrf,
      voucherDate,
      supplierId: supplierOptions[0],
      line: {
        line_type: "RAW_MATERIAL",
        item_id: fixture.itemId,
        color_id: fixture.bogusColorId, // valid, active color, but not a variant of this SFG
        size_id: fixture.validSizeId,
        qty: "1.000",
        rate: "100",
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(String(body.error || "")).toMatch(/does not match any defined SKU/i);
  });

  test("server accepts an SFG line that matches a real variant", async ({
    page,
  }) => {
    test.skip(
      !fixture,
      "No SFG item with an active variant/SKU (and no rm rates) in this DB.",
    );

    const response = await page.goto(GENERAL_PURCHASE_URL, {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "General Purchase page not accessible.",
    );

    const supplierOptions = await getSelectOptionValues(
      page.locator("[data-supplier-select]"),
    );
    test.skip(!supplierOptions.length, "No supplier options available.");

    const itemOptions = await getSelectOptionValues(
      page
        .locator("[data-lines-body] tr")
        .first()
        .locator('select[data-row-field="item"]'),
    );
    test.skip(
      !itemOptions.includes(String(fixture.itemId)),
      "SFG fixture item not offered in this branch's purchase form.",
    );

    const csrf = await page
      .locator("[data-purchase-voucher-form] input[name='_csrf']")
      .first()
      .inputValue();
    const voucherDate =
      (await page
        .locator("[data-purchase-voucher-form] input[name='voucher_date']")
        .first()
        .inputValue()
        .catch(() => "")) || new Date().toISOString().slice(0, 10);

    const res = await postPurchase(page, {
      csrf,
      voucherDate,
      supplierId: supplierOptions[0],
      line: {
        line_type: "RAW_MATERIAL",
        item_id: fixture.itemId,
        color_id: fixture.validColorId,
        size_id: fixture.validSizeId,
        qty: "1.000",
        rate: "100",
      },
    });

    // Success redirects (302); a create-approval policy would also redirect.
    // The key assertion is that the variant rule did not reject the line (400).
    expect(res.status()).not.toBe(400);
    expect([302, 200]).toContain(res.status());
  });

  test("SFG purchase posts SKU stock to the ledger and balance", async ({
    page,
  }) => {
    test.skip(
      !fixture || !fixture.skuId,
      "No SFG item with an active variant/SKU (and no rm rates) in this DB.",
    );

    const response = await page.goto(GENERAL_PURCHASE_URL, {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "General Purchase page not accessible.",
    );

    const supplierOptions = await getSelectOptionValues(
      page.locator("[data-supplier-select]"),
    );
    test.skip(!supplierOptions.length, "No supplier options available.");

    const itemOptions = await getSelectOptionValues(
      page
        .locator("[data-lines-body] tr")
        .first()
        .locator('select[data-row-field="item"]'),
    );
    test.skip(
      !itemOptions.includes(String(fixture.itemId)),
      "SFG fixture item not offered in this branch's purchase form.",
    );

    const csrf = await page
      .locator("[data-purchase-voucher-form] input[name='_csrf']")
      .first()
      .inputValue();
    const voucherDate =
      (await page
        .locator("[data-purchase-voucher-form] input[name='voucher_date']")
        .first()
        .inputValue()
        .catch(() => "")) || new Date().toISOString().slice(0, 10);

    const purchasedPairs = 3;
    const beforeHeader = await getLatestVoucherHeader({
      voucherTypeCode: GENERAL_PURCHASE_TYPE,
    });
    const beforePairs = await sumSfgSkuQtyPairs(fixture.skuId);

    const res = await postPurchase(page, {
      csrf,
      voucherDate,
      supplierId: supplierOptions[0],
      line: {
        line_type: "RAW_MATERIAL",
        item_id: fixture.itemId,
        color_id: fixture.validColorId,
        size_id: fixture.validSizeId,
        qty: `${purchasedPairs}.000`,
        rate: "100",
      },
    });
    expect(res.status()).not.toBe(400);

    const afterHeader = await getLatestVoucherHeader({
      voucherTypeCode: GENERAL_PURCHASE_TYPE,
    });
    expect(afterHeader).toBeTruthy();
    expect(Number(afterHeader.id)).toBeGreaterThan(Number(beforeHeader?.id || 0));

    // Stock only posts once the voucher is APPROVED. If a create-approval policy
    // queued it (PENDING), we can't verify stock here — skip that assertion.
    test.skip(
      String(afterHeader.status || "").toUpperCase() !== "APPROVED",
      "Voucher queued for approval; SKU stock not yet posted.",
    );

    // A category='SFG' IN ledger row exists for the SKU, in whole pairs.
    const ledgerRow = await getSfgInLedgerRow({
      skuId: fixture.skuId,
      voucherHeaderId: afterHeader.id,
    });
    expect(ledgerRow).toBeTruthy();
    expect(Number(ledgerRow.qty_pairs)).toBe(purchasedPairs);
    expect(ledgerRow.item_id).toBeNull(); // SFG ledger rows are SKU-keyed, not item-keyed
    expect(Number(ledgerRow.value)).toBeCloseTo(purchasedPairs * 100, 1);

    // The SKU on-hand balance grew by exactly the purchased pairs.
    const afterPairs = await sumSfgSkuQtyPairs(fixture.skuId);
    expect(afterPairs - beforePairs).toBe(purchasedPairs);
  });

  test("deleting an SFG purchase rolls back the SKU stock", async ({ page }) => {
    test.skip(
      !fixture || !fixture.skuId,
      "No SFG item with an active variant/SKU (and no rm rates) in this DB.",
    );

    const response = await page.goto(GENERAL_PURCHASE_URL, {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "General Purchase page not accessible.",
    );

    const supplierOptions = await getSelectOptionValues(
      page.locator("[data-supplier-select]"),
    );
    test.skip(!supplierOptions.length, "No supplier options available.");
    const itemOptions = await getSelectOptionValues(
      page
        .locator("[data-lines-body] tr")
        .first()
        .locator('select[data-row-field="item"]'),
    );
    test.skip(
      !itemOptions.includes(String(fixture.itemId)),
      "SFG fixture item not offered in this branch's purchase form.",
    );

    const csrf = await page
      .locator("[data-purchase-voucher-form] input[name='_csrf']")
      .first()
      .inputValue();
    const voucherDate =
      (await page
        .locator("[data-purchase-voucher-form] input[name='voucher_date']")
        .first()
        .inputValue()
        .catch(() => "")) || new Date().toISOString().slice(0, 10);

    const purchasedPairs = 4;
    const beforePairs = await sumSfgSkuQtyPairs(fixture.skuId);

    await postPurchase(page, {
      csrf,
      voucherDate,
      supplierId: supplierOptions[0],
      line: {
        line_type: "RAW_MATERIAL",
        item_id: fixture.itemId,
        color_id: fixture.validColorId,
        size_id: fixture.validSizeId,
        qty: `${purchasedPairs}.000`,
        rate: "100",
      },
    });

    const header = await getLatestVoucherHeader({
      voucherTypeCode: GENERAL_PURCHASE_TYPE,
    });
    test.skip(
      String(header?.status || "").toUpperCase() !== "APPROVED",
      "Voucher queued for approval; nothing posted to roll back.",
    );
    expect(await sumSfgSkuQtyPairs(fixture.skuId)).toBe(
      beforePairs + purchasedPairs,
    );

    // Hard-delete the voucher; stock impact must reverse fully.
    const del = await page.request.post("/vouchers/purchase/delete", {
      headers: { Accept: "application/json" },
      maxRedirects: 0,
      form: { _csrf: csrf, voucher_id: String(header.id) },
    });
    expect(del.status()).not.toBe(400);

    expect(await sumSfgSkuQtyPairs(fixture.skuId)).toBe(beforePairs);
    const ledgerRow = await getSfgInLedgerRow({
      skuId: fixture.skuId,
      voucherHeaderId: header.id,
    });
    expect(ledgerRow).toBeNull(); // ledger rows removed on rollback
  });
});
