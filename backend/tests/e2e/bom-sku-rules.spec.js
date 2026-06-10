const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomUiFixture,
  getBomSnapshot,
  cleanupBomUiFixture,
  closeDb,
} = require("./utils/db");

const parseBomIdFromUrl = (url) => {
  const match = String(url || "").match(/\/master-data\/bom\/(\d+)(?:\?|$)/i);
  return match ? Number(match[1]) : null;
};

const selectOptionForced = async (locator, value) =>
  locator.selectOption(String(value), { force: true });

const selectFirstNonEmptyOption = async (locator) => {
  const firstValue = await locator.evaluate((node) => {
    const options = Array.from(node.options || []);
    const first = options.find((opt) => String(opt.value || "").trim() !== "");
    return first ? String(first.value) : "";
  });
  if (!firstValue) return "";
  await locator.selectOption(firstValue, { force: true });
  return firstValue;
};

const openSkuRulesView = async (page) => {
  await page.locator('[data-rm-view-toggle="sku_rules"]').click();
  await expect(page.locator('[data-rm-view="sku_rules"]')).not.toHaveClass(/hidden/);
};

const fillBomHeader = async (page, { itemId, outputQty = "1", outputUomId }) => {
  await selectOptionForced(page.locator('select[name="level"]'), "FINISHED");
  await selectOptionForced(page.locator('select[name="item_id"]'), itemId);
  await page.locator('input[name="output_qty"]').fill(String(outputQty));
  await selectOptionForced(page.locator('select[name="output_uom_id"]'), outputUomId);
};

const addRmRow = async (page, { rmItemId, deptId }) => {
  const rmBody = page.locator('[data-lines-body="rm"]');
  await page.locator('[data-rm-view-toggle="materials"]').click();
  const rmRow = rmBody.locator("tr").first();
  await expect(rmRow).toBeVisible();
  await selectOptionForced(rmRow.locator('[data-col="rm_item_id"]'), rmItemId);
  await selectOptionForced(rmRow.locator('[data-col="dept_id"]'), deptId);
  await rmRow.locator('[data-col="qty"]').fill("5");
};

const saveDraft = async (page) => {
  await page.locator("[data-bom-save-draft]").click();
  await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 30000 });
};

test.describe("BOM SKU rules — size/color persistence and badges", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
    createdBomIds: [],
  };

  test.beforeAll(async () => {
    const token = `skurules${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const fixture = await createBomUiFixture(token);
    if (!fixture) {
      ctx.skipReason = "Unable to create BOM SKU rules fixture data.";
      return;
    }
    ctx.ready = true;
    ctx.fixture = fixture;
  });

  test.afterAll(async () => {
    await cleanupBomUiFixture({
      fixture: ctx.fixture,
      bomIds: ctx.createdBomIds,
    });
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await login(page, "E2E_ADMIN");
  });

  test("color override persists after save draft and reload", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    await openSkuRulesView(page);

    const firstChip = page.locator("[data-sku-rule-chip]").first();
    await expect(firstChip).toBeVisible();
    await firstChip.click();

    const colorSelect = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="rm_color_id"]');

    const colorCount = await colorSelect.count();
    if (colorCount === 0) {
      test.skip(true, "No color dropdown for this RM item — fixture has no color purchase rates");
      return;
    }

    const selectedColor = await selectFirstNonEmptyOption(colorSelect);
    if (!selectedColor) {
      test.skip(true, "Color dropdown has no selectable options");
      return;
    }

    await saveDraft(page);
    const bomId = parseBomIdFromUrl(page.url());
    expect(bomId).toBeTruthy();
    ctx.createdBomIds.push(bomId);

    const snapshot = await getBomSnapshot(bomId);
    expect(snapshot?.header?.status).toBe("DRAFT");

    await openSkuRulesView(page);
    const chipAfterReload = page.locator("[data-sku-rule-chip]").first();
    await chipAfterReload.click();

    const colorSelectReloaded = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="rm_color_id"]');
    await expect(colorSelectReloaded).toHaveValue(selectedColor);
  });

  test("chip shows no badge when no qty is entered (empty state)", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    await openSkuRulesView(page);

    const firstChip = page.locator("[data-sku-rule-chip]").first();
    await expect(firstChip).toBeVisible();

    const fullBadge = firstChip.locator('[data-sku-chip-badge="full"]');
    const partialBadge = firstChip.locator('[data-sku-chip-badge="partial"]');
    await expect(fullBadge).toHaveCount(0);
    await expect(partialBadge).toHaveCount(0);
  });

  test("chip shows green badge after filling qty for all RM lines", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    await openSkuRulesView(page);

    const firstChip = page.locator("[data-sku-rule-chip]").first();
    await firstChip.click();

    const qtyInput = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="required_qty"]');
    await qtyInput.fill("10");
    await qtyInput.dispatchEvent("change");

    await expect(firstChip.locator('[data-sku-chip-badge="full"]')).toBeVisible();
    await expect(firstChip.locator('[data-sku-chip-badge="partial"]')).toHaveCount(0);
  });

  test("badge refreshes live as user types qty without full re-render", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    await openSkuRulesView(page);

    const firstChip = page.locator("[data-sku-rule-chip]").first();
    await firstChip.click();

    const qtyInput = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="required_qty"]');

    // no badge initially
    await expect(firstChip.locator('[data-sku-chip-badge="full"]')).toHaveCount(0);

    // type a value — badge should appear without leaving the field
    await qtyInput.fill("3");
    await qtyInput.dispatchEvent("input");

    await expect(firstChip.locator('[data-sku-chip-badge="full"]')).toBeVisible();

    // clear the value — badge should disappear
    await qtyInput.fill("");
    await qtyInput.dispatchEvent("input");

    await expect(firstChip.locator('[data-sku-chip-badge="full"]')).toHaveCount(0);
  });

  test("save-draft warning modal appears when SKU rules are partial (state injection)", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    await openSkuRulesView(page);

    // Inject a second (fake) RM line into state so the SKU rules table renders 2 rows.
    // The fake ID won't match any real item so it can never have a valid override.
    await page.evaluate(
      ({ rmItemId, deptId }) => {
        const state = window.__bomState;
        if (!state) return;
        state.rm.push({
          rm_item_id: String(Number(rmItemId) + 99999),
          dept_id: String(deptId),
          qty: "1",
          uom_id: "",
        });
      },
      { rmItemId: fixture.rmItemId, deptId: fixture.deptId },
    );

    // Re-click the chip to trigger a re-render. The table now shows 2 rows.
    const firstChip = page.locator("[data-sku-rule-chip]").first();
    await firstChip.click();

    // Fill qty for the first (real) row so syncSkuRulesFromDom preserves it.
    const firstQtyInput = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="required_qty"]');
    await firstQtyInput.fill("10");
    await firstQtyInput.dispatchEvent("change");

    // Chip should now show partial badge (1 of 2 covered)
    await expect(firstChip.locator('[data-sku-chip-badge="partial"]')).toBeVisible();

    // Click Save Draft — warning modal should appear because rules are partial
    await page.locator("[data-bom-save-draft]").click();

    const warnModal = page.locator("[data-bom-sku-warn-modal]");
    await expect(warnModal).toBeVisible({ timeout: 3000 });

    // "Review SKU Rules" closes modal without navigating away
    const closeBtn = warnModal.locator("[data-bom-sku-warn-close]").first();
    await closeBtn.click();
    await expect(warnModal).toBeHidden();
    await expect(page).toHaveURL(/\/master-data\/bom\/new/);
  });

  test("save-draft warning 'Save Anyway' proceeds to save the draft", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    await openSkuRulesView(page);

    await page.evaluate(
      ({ rmItemId, deptId }) => {
        const state = window.__bomState;
        if (!state) return;
        state.rm.push({
          rm_item_id: String(Number(rmItemId) + 99999),
          dept_id: String(deptId),
          qty: "1",
          uom_id: "",
        });
      },
      { rmItemId: fixture.rmItemId, deptId: fixture.deptId },
    );

    const firstChip = page.locator("[data-sku-rule-chip]").first();
    await firstChip.click();

    const firstQtyInput = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="required_qty"]');
    await firstQtyInput.fill("7");
    await firstQtyInput.dispatchEvent("change");

    await page.locator("[data-bom-save-draft]").click();

    const warnModal = page.locator("[data-bom-sku-warn-modal]");
    await expect(warnModal).toBeVisible({ timeout: 3000 });

    const confirmBtn = warnModal.locator("[data-bom-sku-warn-confirm]");
    await confirmBtn.click();

    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 30000 });
    const bomId = parseBomIdFromUrl(page.url());
    expect(bomId).toBeTruthy();
    ctx.createdBomIds.push(bomId);

    const snapshot = await getBomSnapshot(bomId);
    expect(snapshot?.header?.status).toBe("DRAFT");
  });

  test("BOM with zero-rule SKUs can be approved (new partial-rule policy)", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    // Save draft without filling any SKU rules (zero rules = intentionally skipped)
    await page.locator("[data-bom-save-draft]").click();

    // If warning modal appears (shouldn't for zero rules, only for partial), dismiss it
    const warnModal = page.locator("[data-bom-sku-warn-modal]");
    const modalVisible = await warnModal.isVisible().catch(() => false);
    if (modalVisible) {
      await warnModal.locator("[data-bom-sku-warn-confirm]").click();
    }

    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 30000 });
    const bomId = parseBomIdFromUrl(page.url());
    expect(bomId).toBeTruthy();
    ctx.createdBomIds.push(bomId);

    // Approve with zero SKU rules — should succeed
    const approveBtn = page.locator('[data-bom-approve-now="1"], [data-bom-send-approval="1"]').first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();
    await page.waitForURL(new RegExp(`/master-data/bom/${bomId}(?:\\?|$)`), { timeout: 30000 });

    const approvedSnapshot = await getBomSnapshot(bomId);
    expect(approvedSnapshot?.header?.status).toBe("APPROVED");
  });

  test("switching tabs does not reset size/color dropdowns in SKU rules", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId });

    await openSkuRulesView(page);

    const firstChip = page.locator("[data-sku-rule-chip]").first();
    await firstChip.click();

    const colorSelect = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="rm_color_id"]');
    const colorCount = await colorSelect.count();
    if (colorCount === 0) {
      test.skip(true, "No color dropdown for fixture RM item");
      return;
    }
    const selectedColor = await selectFirstNonEmptyOption(colorSelect);
    if (!selectedColor) {
      test.skip(true, "Color dropdown has no selectable options");
      return;
    }

    // Switch to Materials view and back
    await page.locator('[data-rm-view-toggle="materials"]').click();
    await openSkuRulesView(page);
    await firstChip.click();

    const colorSelectAfter = page
      .locator('[data-sku-rule-row="true"]')
      .first()
      .locator('[data-sku-rule-col="rm_color_id"]');
    await expect(colorSelectAfter).toHaveValue(selectedColor);
  });
});
