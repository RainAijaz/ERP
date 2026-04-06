const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const db = createKnex(knexConfig);

const nonEmptyOptionValues = async (selectLocator) =>
  selectLocator.locator("option").evaluateAll((opts) =>
    opts.map((opt) => String(opt.value || "").trim()).filter(Boolean),
  );

const getNonPhysicalReasonValue = async (reasonSelect) =>
  reasonSelect.locator("option").evaluateAll((options) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/[^a-z0-9]+/gi, "")
        .toUpperCase();
    const rows = options
      .map((option) => ({
        value: String(option.value || "").trim(),
        code: normalize(option.getAttribute("data-reason-value") || ""),
      }))
      .filter((row) => row.value);
    const nonPhysical = rows.find((row) => !row.code.startsWith("PHYSICALCOUNT"));
    return nonPhysical ? nonPhysical.value : rows[0]?.value || "";
  });

const getPhysicalReasonValue = async (reasonSelect) =>
  reasonSelect.locator("option").evaluateAll((options) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/[^a-z0-9]+/gi, "")
        .toUpperCase();
    const rows = options
      .map((option) => ({
        value: String(option.value || "").trim(),
        code: normalize(option.getAttribute("data-reason-value") || ""),
      }))
      .filter((row) => row.value);
    const physical = rows.find((row) => row.code.startsWith("PHYSICALCOUNT"));
    return physical ? physical.value : "";
  });

const toInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const round2 = (value) => Number(Number(value || 0).toFixed(2));

let uomGraphPromise = null;
const loadUomGraph = async () => {
  if (!uomGraphPromise) {
    uomGraphPromise = db("erp.uom_conversions")
      .select("from_uom_id", "to_uom_id", "factor")
      .where({ is_active: true })
      .then((rows) => {
        const graph = new Map();
        const addEdge = (from, to, factor) => {
          if (!graph.has(from)) graph.set(from, []);
          graph.get(from).push({ to, factor });
        };
        (rows || []).forEach((row) => {
          const from = toInt(row.from_uom_id);
          const to = toInt(row.to_uom_id);
          const factor = Number(row.factor || 0);
          if (!from || !to || !(factor > 0)) return;
          addEdge(from, to, factor);
          addEdge(to, from, 1 / factor);
        });
        return graph;
      });
  }
  return uomGraphPromise;
};

const getFactorToBase = async ({ fromUomId, baseUomId }) => {
  const from = toInt(fromUomId);
  const to = toInt(baseUomId);
  if (!from || !to) return null;
  if (from === to) return 1;
  const graph = await loadUomGraph();
  if (!graph.has(from)) return null;
  const visited = new Set([from]);
  const queue = [{ node: from, factor: 1 }];
  while (queue.length) {
    const current = queue.shift();
    const edges = graph.get(current.node) || [];
    for (const edge of edges) {
      const next = toInt(edge.to);
      const factor = Number(current.factor) * Number(edge.factor || 0);
      if (!next || !(factor > 0)) continue;
      if (next === to) return factor;
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push({ node: next, factor });
    }
  }
  return null;
};

const getActiveBranchId = async (page) => {
  const cookies = await page.context().cookies();
  const branchCookie = cookies.find(
    (cookie) => String(cookie.name || "").trim() === "active_branch_id",
  );
  return toInt(branchCookie?.value);
};

const getSkuBaseMeta = async (skuId) =>
  db("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("i.base_uom_id", db.raw("upper(coalesce(i.item_type::text, '')) as item_type"))
    .where("s.id", Number(skuId))
    .first();

const getStockBuckets = async ({ branchId, category, skuId }) => {
  const packedFlagSql = `CASE
  WHEN sln.is_packed IS NOT NULL THEN sln.is_packed
  WHEN pl.is_packed IS NOT NULL THEN pl.is_packed
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'PACKED' THEN true
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'LOOSE' THEN false
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('true','t','1','yes') THEN true
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('false','f','0','no') THEN false
  ELSE false
END`;

  const rows = await db("erp.stock_ledger as sl")
    .leftJoin("erp.voucher_line as vl", "vl.id", "sl.voucher_line_id")
    .leftJoin("erp.sales_line as sln", "sln.voucher_line_id", "vl.id")
    .leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id")
    .select(db.raw(`${packedFlagSql} as is_packed`))
    .select(
      db.raw(
        "COALESCE(SUM(CASE WHEN sl.direction = 1 THEN COALESCE(sl.qty_pairs, 0) ELSE -COALESCE(sl.qty_pairs, 0) END), 0) as qty_pairs",
      ),
    )
    .where({
      "sl.branch_id": Number(branchId),
      "sl.stock_state": "ON_HAND",
      "sl.category": String(category || "").trim().toUpperCase(),
      "sl.sku_id": Number(skuId),
    })
    .groupBy(db.raw(packedFlagSql));
  const loose = rows.find((row) => row.is_packed === false);
  const packed = rows.find((row) => row.is_packed === true);
  return {
    looseQtyPairs: Number(loose?.qty_pairs || 0),
    packedQtyPairs: Number(packed?.qty_pairs || 0),
  };
};

const readNumericInputValue = async (locator) => {
  const text = await locator.inputValue();
  const normalized = String(text || "").replace(/,/g, "").trim();
  const num = Number(normalized);
  return Number.isFinite(num) ? num : NaN;
};

const verifyQtyForUom = async ({
  page,
  uomId,
  expectedQty,
  valueLocator,
  uomSelectLocator,
}) => {
  await uomSelectLocator.selectOption(String(uomId));
  await expect
    .poll(async () => readNumericInputValue(valueLocator), { timeout: 5000 })
    .toBe(round3(expectedQty));
};

test.afterAll(async () => {
  await db.destroy();
});

test.describe("Inventory voucher qty field behavior", () => {
  test("stock transfer out: Enter on first column searchable item moves to uom", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Transfer Out page not accessible.");

    const linesBody = page.locator("[data-lines-body]");
    await expect(linesBody).toBeVisible();

    const stockType = page.locator('[data-stock-type]');
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const firstRow = page.locator('[data-lines-body] tr[data-row-index]').first();
    await expect(firstRow).toBeVisible();

    const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available for Stock Transfer Out first-column Enter test.");
    await skuSelect.selectOption(skuValues[0]);

    const refreshedFirstRow = page.locator('[data-lines-body] tr[data-row-index]').first();
    const firstColumnSearchInput = refreshedFirstRow
      .locator("td")
      .nth(0)
      .locator("[data-searchable-wrapper] input")
      .first();
    const uomSearchInput = refreshedFirstRow
      .locator("td")
      .nth(1)
      .locator("[data-searchable-wrapper] input")
      .first();

    await expect(firstColumnSearchInput).toBeVisible();
    await expect(uomSearchInput).toBeVisible();

    await firstColumnSearchInput.focus();
    await firstColumnSearchInput.press("Enter");
    await expect(uomSearchInput).toBeFocused();
  });

  test("stock transfer out: Enter on transfer qty appends/moves to next row first field", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Transfer Out page not accessible.");

    const linesBody = page.locator("[data-lines-body]");
    await expect(linesBody).toBeVisible();

    const stockType = page.locator('[data-stock-type]');
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const rows = page.locator('[data-lines-body] tr[data-row-index]');
    await expect(rows.first()).toBeVisible();

    const firstRow = rows.first();
    const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available for Stock Transfer Out qty-field test.");
    await skuSelect.selectOption(skuValues[0]);

    const refreshedFirstRow = page.locator('[data-lines-body] tr[data-row-index]').first();
    const uomSelect = refreshedFirstRow.locator('select[data-out-change="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = await nonEmptyOptionValues(uomSelect);
    test.skip(!uomValues.length, "No unit options available for selected SKU.");
    await uomSelect.selectOption(uomValues[0]);

    const qtyInput = page
      .locator('[data-lines-body] tr[data-row-index]')
      .first()
      .locator('input[data-out-input="transfer_qty"]')
      .first();
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill("1");
    await qtyInput.focus();
    await qtyInput.press("Enter");

    const secondRow = page.locator('[data-lines-body] tr[data-row-index]').nth(1);
    await expect(secondRow).toBeVisible();

    const secondRowFirstSearchInput = secondRow
      .locator("td")
      .nth(0)
      .locator("[data-searchable-wrapper] input")
      .first();
    await expect(secondRowFirstSearchInput).toBeVisible();
    await expect(secondRowFirstSearchInput).toBeFocused();
  });

  test("stock count adjustment: Enter on qty in moves focus to qty out", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-count?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Count page not accessible.");

    const rows = page.locator('tr[data-line-index]');
    await expect(rows.first()).toBeVisible();

    const stockType = page.locator('[data-stock-type]');
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const reasonSelect = page.locator("[data-reason-code]");
    if (await reasonSelect.count()) {
      const reasonValue = await getNonPhysicalReasonValue(reasonSelect);
      test.skip(!reasonValue, "No reason codes available for Stock Count qty-field test.");
      await reasonSelect.selectOption(reasonValue);
    }

    const firstRow = page.locator('tr[data-line-index]').first();
    const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available for Stock Count qty-field test.");
    await skuSelect.selectOption(skuValues[0]);

    const refreshedFirstRow = page.locator('tr[data-line-index]').first();
    const uomSelect = refreshedFirstRow.locator('select[data-field="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = await nonEmptyOptionValues(uomSelect);
    test.skip(!uomValues.length, "No unit options available for selected SKU in Stock Count.");
    await uomSelect.selectOption(uomValues[0]);

    const qtyInInput = page
      .locator('tr[data-line-index]')
      .first()
      .locator('input[data-field="qty_in"]')
      .first();
    const qtyOutInput = page
      .locator('tr[data-line-index]')
      .first()
      .locator('input[data-field="qty_out"]')
      .first();
    await expect(qtyInInput).toBeVisible();
    await expect(qtyOutInput).toBeVisible();

    await qtyInInput.fill("1");
    await qtyInInput.focus();
    await qtyInInput.press("Enter");
    await expect(qtyOutInput).toBeFocused();
  });

  test("stock count adjustment: non-physical footer totals include system qty, qty in and qty out", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-count?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Count page not accessible.");

    const stockType = page.locator("[data-stock-type]");
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const reasonSelect = page.locator("[data-reason-code]");
    await expect(reasonSelect).toBeVisible();
    const reasonValue = await getNonPhysicalReasonValue(reasonSelect);
    test.skip(!reasonValue, "No non-physical reason configured.");
    await reasonSelect.selectOption(reasonValue);

    const firstRow = page.locator("tr[data-line-index]").first();
    const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available for stock-count total footer test.");
    const skuId = toInt(skuValues[0]);
    test.skip(!skuId, "Invalid SKU option selected.");
    await skuSelect.selectOption(String(skuId));

    const skuMeta = await getSkuBaseMeta(skuId);
    test.skip(!skuMeta, "Selected SKU metadata not found.");
    const baseUomId = toInt(skuMeta.base_uom_id);
    test.skip(!baseUomId, "Base UOM not found for selected SKU.");

    const refreshedRow = page.locator("tr[data-line-index]").first();
    const uomSelect = refreshedRow.locator('select[data-field="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = (await nonEmptyOptionValues(uomSelect)).map((value) => toInt(value)).filter(Boolean);
    test.skip(!uomValues.length, "No UOM options available.");
    const selectedUomId = toInt(uomValues[0]);
    test.skip(!selectedUomId, "Invalid UOM option selected.");
    await uomSelect.selectOption(String(selectedUomId));

    const factorToBase = await getFactorToBase({ fromUomId: selectedUomId, baseUomId });
    test.skip(!(factorToBase > 0), "UOM conversion factor not available.");

    const rowAfterUom = page.locator("tr[data-line-index]").first();
    const systemQtyInput = rowAfterUom.locator('input[data-display-field="system_qty"]').first();
    const qtyInInput = rowAfterUom.locator('input[data-field="qty_in"]').first();
    const qtyOutInput = rowAfterUom.locator('input[data-field="qty_out"]').first();
    const pairRateInput = rowAfterUom.locator('input[data-display-field="pair_rate"]').first();
    await expect(systemQtyInput).toBeVisible();
    await expect(qtyInInput).toBeVisible();
    await expect(qtyOutInput).toBeVisible();
    await expect(pairRateInput).toBeVisible();

    const systemQty = await readNumericInputValue(systemQtyInput);
    const pairRate = await readNumericInputValue(pairRateInput);
    test.skip(!Number.isFinite(systemQty), "System qty is not numeric.");
    test.skip(!Number.isFinite(pairRate), "Pair rate is not numeric.");

    await qtyInInput.fill("5");
    await qtyInInput.focus();
    await qtyInInput.press("Enter");
    await qtyOutInput.fill("2");
    await qtyOutInput.focus();
    await qtyOutInput.press("Enter");

    const totalSystemQtyInput = page.locator("[data-lines-footer] input[data-total-system-qty]").first();
    const totalQtyInInput = page.locator("[data-lines-footer] input[data-total-qty-in]").first();
    const totalQtyOutInput = page.locator("[data-lines-footer] input[data-total-qty-out]").first();
    const totalDiffInput = page.locator("[data-lines-footer] input[data-total-diff]").first();
    const totalAmountInput = page.locator("[data-lines-footer] input[data-total-amount]").first();
    await expect(totalSystemQtyInput).toBeVisible();
    await expect(totalQtyInInput).toBeVisible();
    await expect(totalQtyOutInput).toBeVisible();
    await expect(totalDiffInput).toBeVisible();
    await expect(totalAmountInput).toBeVisible();

    const expectedDiff = round3(5 - 2);
    const expectedAmount = round2(Number(expectedDiff) * Number(factorToBase) * Number(pairRate));

    await expect.poll(async () => readNumericInputValue(totalSystemQtyInput), { timeout: 5000 }).toBe(round3(systemQty));
    await expect.poll(async () => readNumericInputValue(totalQtyInInput), { timeout: 5000 }).toBe(round3(5));
    await expect.poll(async () => readNumericInputValue(totalQtyOutInput), { timeout: 5000 }).toBe(round3(2));
    await expect.poll(async () => readNumericInputValue(totalDiffInput), { timeout: 5000 }).toBe(expectedDiff);
    await expect.poll(async () => readNumericInputValue(totalAmountInput), { timeout: 5000 }).toBe(expectedAmount);
  });

  test("stock count adjustment: physical-count reason shows counted stock field", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-count?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Count page not accessible.");

    const reasonSelect = page.locator("[data-reason-code]");
    await expect(reasonSelect).toBeVisible();
    const physicalReasonValue = await reasonSelect.locator("option").evaluateAll((options) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/[^a-z0-9]+/gi, "")
          .toUpperCase();
      const physical = options
        .map((option) => ({
          value: String(option.value || "").trim(),
          code: normalize(option.getAttribute("data-reason-value") || ""),
        }))
        .find((entry) => entry.value && entry.code.startsWith("PHYSICALCOUNT"));
      return physical ? physical.value : "";
    });
    test.skip(!physicalReasonValue, "No physical-count reason configured for Stock Count.");
    await reasonSelect.selectOption(physicalReasonValue);

    const firstRow = page.locator("tr[data-line-index]").first();
    await expect(firstRow).toBeVisible();

    const countedStockInput = firstRow.locator('input[data-field="counted_stock_qty"]').first();
    await expect(countedStockInput).toBeVisible();
    await expect(firstRow.locator('input[data-field="qty_in"]')).toHaveCount(0);
    await expect(firstRow.locator('input[data-field="qty_out"]')).toHaveCount(0);
  });

  test("stock count adjustment: amount diff uses pair-rate conversion for dozen qty-out", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-count?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Count page not accessible.");

    const stockType = page.locator("[data-stock-type]");
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const reasonSelect = page.locator("[data-reason-code]");
    await expect(reasonSelect).toBeVisible();
    const reasonValue = await getNonPhysicalReasonValue(reasonSelect);
    test.skip(!reasonValue, "No non-physical reason configured.");
    await reasonSelect.selectOption(reasonValue);

    const firstRow = page.locator("tr[data-line-index]").first();
    const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available for amount conversion test.");
    const skuId = toInt(skuValues[0]);
    test.skip(!skuId, "Invalid SKU option selected.");
    await skuSelect.selectOption(String(skuId));

    const skuMeta = await getSkuBaseMeta(skuId);
    test.skip(!skuMeta, "Selected SKU metadata not found.");
    test.skip(String(skuMeta.item_type || "") !== "FG", "Selected SKU is not FG.");
    const baseUomId = toInt(skuMeta.base_uom_id);
    test.skip(!baseUomId, "Base UOM not found for selected SKU.");

    const refreshedRow = page.locator("tr[data-line-index]").first();
    const uomSelect = refreshedRow.locator('select[data-field="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = (await nonEmptyOptionValues(uomSelect)).map((value) => toInt(value)).filter(Boolean);
    test.skip(!uomValues.length, "No UOM options available.");

    const nonBaseUomId = uomValues.find((uomId) => Number(uomId) !== Number(baseUomId));
    test.skip(!nonBaseUomId, "Need non-base UOM to verify pair-rate conversion.");
    await uomSelect.selectOption(String(nonBaseUomId));

    const factorToBase = await getFactorToBase({ fromUomId: nonBaseUomId, baseUomId });
    test.skip(!(factorToBase > 0), "UOM conversion factor not available.");

    const rowAfterUom = page.locator("tr[data-line-index]").first();
    const pairRateInput = rowAfterUom.locator('input[data-display-field="pair_rate"]').first();
    const qtyOutInput = rowAfterUom.locator('input[data-field="qty_out"]').first();
    const amountInput = rowAfterUom.locator('input[data-display-field="amount_diff"]').first();
    await expect(pairRateInput).toBeVisible();
    await expect(qtyOutInput).toBeVisible();
    await expect(amountInput).toBeVisible();

    const pairRate = await readNumericInputValue(pairRateInput);
    test.skip(!Number.isFinite(pairRate), "Pair rate is not numeric.");

    await qtyOutInput.fill("1");
    await qtyOutInput.focus();
    await qtyOutInput.press("Enter");

    const expectedAmount = round2(-1 * Number(factorToBase) * Number(pairRate));
    await expect.poll(async () => readNumericInputValue(amountInput), { timeout: 5000 }).toBe(expectedAmount);
  });

  test("stock count adjustment: counted-stock enter updates difference/amount immediately", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-count?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Count page not accessible.");

    const stockType = page.locator("[data-stock-type]");
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const reasonSelect = page.locator("[data-reason-code]");
    await expect(reasonSelect).toBeVisible();
    const physicalReasonValue = await getPhysicalReasonValue(reasonSelect);
    test.skip(!physicalReasonValue, "No physical-count reason configured.");
    await reasonSelect.selectOption(physicalReasonValue);

    const firstRow = page.locator("tr[data-line-index]").first();
    const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No SKU options available for counted-stock update test.");
    const skuId = toInt(skuValues[0]);
    test.skip(!skuId, "Invalid SKU option selected.");
    await skuSelect.selectOption(String(skuId));

    const skuMeta = await getSkuBaseMeta(skuId);
    test.skip(!skuMeta, "Selected SKU metadata not found.");
    test.skip(String(skuMeta.item_type || "") !== "FG", "Selected SKU is not FG.");
    const baseUomId = toInt(skuMeta.base_uom_id);
    test.skip(!baseUomId, "Base UOM not found for selected SKU.");

    const refreshedRow = page.locator("tr[data-line-index]").first();
    const uomSelect = refreshedRow.locator('select[data-field="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = (await nonEmptyOptionValues(uomSelect)).map((value) => toInt(value)).filter(Boolean);
    test.skip(!uomValues.length, "No UOM options available.");
    await uomSelect.selectOption(String(uomValues[0]));

    const selectedUomId = toInt(uomValues[0]);
    const factorToBase = await getFactorToBase({ fromUomId: selectedUomId, baseUomId });
    test.skip(!(factorToBase > 0), "UOM conversion factor not available.");

    const rowAfterUom = page.locator("tr[data-line-index]").first();
    const systemQtyInput = rowAfterUom.locator('input[data-display-field="system_qty"]').first();
    const countedStockInput = rowAfterUom.locator('input[data-field="counted_stock_qty"]').first();
    const differenceInput = rowAfterUom.locator('input[data-display-field="difference_qty"]').first();
    const pairRateInput = rowAfterUom.locator('input[data-display-field="pair_rate"]').first();
    const amountInput = rowAfterUom.locator('input[data-display-field="amount_diff"]').first();
    await expect(systemQtyInput).toBeVisible();
    await expect(countedStockInput).toBeVisible();
    await expect(differenceInput).toBeVisible();
    await expect(pairRateInput).toBeVisible();
    await expect(amountInput).toBeVisible();

    const systemQty = await readNumericInputValue(systemQtyInput);
    const pairRate = await readNumericInputValue(pairRateInput);
    test.skip(!Number.isFinite(systemQty), "System qty is not numeric.");
    test.skip(!Number.isFinite(pairRate), "Pair rate is not numeric.");

    const nextCounted = round3(Math.max(Number(systemQty) + 1, 0));
    await countedStockInput.fill(String(nextCounted));
    await countedStockInput.focus();
    await countedStockInput.press("Enter");

    const expectedDifference = round3(Number(nextCounted) - Number(systemQty));
    await expect.poll(async () => readNumericInputValue(differenceInput), { timeout: 5000 }).toBe(expectedDifference);
    const expectedAmount = round2(Number(expectedDifference) * Number(factorToBase) * Number(pairRate));
    await expect.poll(async () => readNumericInputValue(amountInput), { timeout: 5000 }).toBe(expectedAmount);
  });

  test("stock transfer out: available qty is strict status bucket by selected unit", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Transfer Out page not accessible.");

    const branchId = await getActiveBranchId(page);
    test.skip(!branchId, "Active branch cookie not available.");

    const stockType = page.locator("[data-stock-type]");
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const firstRow = page.locator('[data-lines-body] tr[data-row-index]').first();
    const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No FG SKU options available.");
    const skuId = toInt(skuValues[0]);
    test.skip(!skuId, "Invalid SKU option selected.");
    await skuSelect.selectOption(String(skuId));

    const skuMeta = await getSkuBaseMeta(skuId);
    test.skip(!skuMeta, "Selected SKU metadata not found.");
    test.skip(String(skuMeta.item_type || "") !== "FG", "Selected SKU is not FG.");
    const baseUomId = toInt(skuMeta.base_uom_id);
    test.skip(!baseUomId, "Base UOM not found for selected SKU.");

    const refreshedFirstRow = page.locator('[data-lines-body] tr[data-row-index]').first();
    const uomSelect = refreshedFirstRow.locator('select[data-out-change="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = (await nonEmptyOptionValues(uomSelect)).map((value) => toInt(value)).filter(Boolean);
    test.skip(!uomValues.length, "No UOM options available for selected SKU.");

    const baseOption = uomValues.find((uomId) => Number(uomId) === Number(baseUomId));
    const nonBaseOption = uomValues.find((uomId) => Number(uomId) !== Number(baseUomId));
    test.skip(!baseOption || !nonBaseOption, "Need both base and non-base UOM options to validate strict bucket behavior.");

    const factorBase = await getFactorToBase({ fromUomId: baseOption, baseUomId });
    const factorNonBase = await getFactorToBase({ fromUomId: nonBaseOption, baseUomId });
    test.skip(!(factorBase > 0) || !(factorNonBase > 0), "UOM conversion factor missing for selected options.");

    const buckets = await getStockBuckets({ branchId, category: "FG", skuId });
    const expectedBaseQty = buckets.looseQtyPairs / factorBase;
    const expectedNonBaseQty = buckets.packedQtyPairs / factorNonBase;

    const availableQtyInput = page
      .locator('[data-lines-body] tr[data-row-index]')
      .first()
      .locator("td")
      .nth(2)
      .locator("input")
      .first();
    await expect(availableQtyInput).toBeVisible();

    await verifyQtyForUom({
      page,
      uomId: baseOption,
      expectedQty: expectedBaseQty,
      valueLocator: availableQtyInput,
      uomSelectLocator: uomSelect,
    });

    await verifyQtyForUom({
      page,
      uomId: nonBaseOption,
      expectedQty: expectedNonBaseQty,
      valueLocator: availableQtyInput,
      uomSelectLocator: uomSelect,
    });
  });

  test("stock count adjustment: system qty is strict status bucket by selected unit", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/vouchers/stock-count?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Stock Count page not accessible.");

    const branchId = await getActiveBranchId(page);
    test.skip(!branchId, "Active branch cookie not available.");

    const stockType = page.locator("[data-stock-type]");
    if (await stockType.count()) {
      await stockType.selectOption("FG");
    }

    const firstRow = page.locator("tr[data-line-index]").first();
    const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
    await expect(skuSelect).toBeVisible();
    const skuValues = await nonEmptyOptionValues(skuSelect);
    test.skip(!skuValues.length, "No FG SKU options available for Stock Count.");
    const skuId = toInt(skuValues[0]);
    test.skip(!skuId, "Invalid SKU option selected.");
    await skuSelect.selectOption(String(skuId));

    const skuMeta = await getSkuBaseMeta(skuId);
    test.skip(!skuMeta, "Selected SKU metadata not found.");
    test.skip(String(skuMeta.item_type || "") !== "FG", "Selected SKU is not FG.");
    const baseUomId = toInt(skuMeta.base_uom_id);
    test.skip(!baseUomId, "Base UOM not found for selected SKU.");

    const refreshedRow = page.locator("tr[data-line-index]").first();
    const uomSelect = refreshedRow.locator('select[data-field="uom_id"]').first();
    await expect(uomSelect).toBeVisible();
    const uomValues = (await nonEmptyOptionValues(uomSelect)).map((value) => toInt(value)).filter(Boolean);
    test.skip(!uomValues.length, "No UOM options available for selected SKU.");

    const baseOption = uomValues.find((uomId) => Number(uomId) === Number(baseUomId));
    const nonBaseOption = uomValues.find((uomId) => Number(uomId) !== Number(baseUomId));
    test.skip(!baseOption || !nonBaseOption, "Need both base and non-base UOM options to validate strict bucket behavior.");

    const factorBase = await getFactorToBase({ fromUomId: baseOption, baseUomId });
    const factorNonBase = await getFactorToBase({ fromUomId: nonBaseOption, baseUomId });
    test.skip(!(factorBase > 0) || !(factorNonBase > 0), "UOM conversion factor missing for selected options.");

    const buckets = await getStockBuckets({ branchId, category: "FG", skuId });
    const expectedBaseQty = buckets.looseQtyPairs / factorBase;
    const expectedNonBaseQty = buckets.packedQtyPairs / factorNonBase;

    const systemQtyInput = page
      .locator("tr[data-line-index]")
      .first()
      .locator("td")
      .nth(2)
      .locator("input")
      .first();
    await expect(systemQtyInput).toBeVisible();

    await verifyQtyForUom({
      page,
      uomId: baseOption,
      expectedQty: expectedBaseQty,
      valueLocator: systemQtyInput,
      uomSelectLocator: uomSelect,
    });

    await verifyQtyForUom({
      page,
      uomId: nonBaseOption,
      expectedQty: expectedNonBaseQty,
      valueLocator: systemQtyInput,
      uomSelectLocator: uomSelect,
    });
  });
});
