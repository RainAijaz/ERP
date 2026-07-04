// Deep, browser-driven coverage of the "copy BOM from approved BOM" and
// "copy SKU values from another SKU" features themselves (as opposed to
// bom-copy-fixes.spec.js, which targets the specific bugs found in review).
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomCopyFixture,
  cleanupBomCopyFixture,
  deleteBomHeaderById,
  getBomSnapshot,
  closeDb,
} = require("./utils/db");

const parseBomIdFromUrl = (url) => {
  const match = String(url || "").match(/\/master-data\/bom\/(\d+)(?:\?|$)/i);
  return match ? Number(match[1]) : null;
};

const selectOptionForced = async (locator, value) =>
  locator.selectOption(String(value), { force: true });

const fillBomHeader = async (page, { itemId, outputQty = "1", outputUomId }) => {
  await selectOptionForced(page.locator('select[name="level"]'), "FINISHED");
  await selectOptionForced(page.locator('select[name="item_id"]'), itemId);
  await page.locator('input[name="output_qty"]').fill(String(outputQty));
  await selectOptionForced(page.locator('select[name="output_uom_id"]'), outputUomId);
};

const addRmRow = async (page, { rmItemId, deptId }, rowIndex = 0) => {
  await page.locator('[data-rm-view-toggle="materials"]').click();
  const rmRow = page.locator('[data-lines-body="rm"] tr').nth(rowIndex);
  await expect(rmRow).toBeVisible();
  await selectOptionForced(rmRow.locator('[data-col="rm_item_id"]'), rmItemId);
  await selectOptionForced(rmRow.locator('[data-col="dept_id"]'), deptId);
};

const addSecondRmRow = async (page) => {
  const firstRow = page.locator('[data-lines-body="rm"] tr').first();
  await firstRow.locator('[data-add-after="rm"]').click();
};

const openSkuRulesView = async (page) => {
  await page.locator('[data-rm-view-toggle="sku_rules"]').click();
  await expect(page.locator('[data-rm-view="sku_rules"]')).not.toHaveClass(/hidden/);
};

const saveDraft = async (page) => {
  await page.locator("[data-bom-save-draft]").click();
  await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 30000 });
};

const openCopyFromBomModal = async (page) => {
  await page.locator("[data-bom-copy-open]").click();
  await expect(page.locator("[data-bom-copy-modal]")).toBeVisible();
};

test.describe("BOM copy feature - deep scenario coverage", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
    createdBomIds: [],
  };

  test.beforeAll(async () => {
    const token = `bomcopydeep${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const fixture = await createBomCopyFixture(token);
    if (!fixture) {
      ctx.skipReason = "Unable to create BOM copy-feature fixture data.";
      return;
    }
    ctx.ready = true;
    ctx.fixture = fixture;
  });

  test.afterAll(async () => {
    await cleanupBomCopyFixture(ctx.fixture, ctx.createdBomIds);
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await login(page, "E2E_ADMIN");
  });

  test("copying into a fresh draft populates RM lines + stage routes and the saved draft shows the provenance badge", async ({
    page,
  }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.articleBId,
      outputQty: "1",
      outputUomId: fixture.productionUomId,
    });

    await openCopyFromBomModal(page);
    await selectOptionForced(
      page.locator("[data-bom-copy-source]"),
      fixture.bomAId,
    );

    // Defaults: RM + SKU overrides + stage routes checked, SFG unchecked.
    await expect(page.locator('[data-bom-copy-section="rm"]')).toBeChecked();
    await expect(page.locator('[data-bom-copy-section="sku_overrides"]')).toBeChecked();
    await expect(page.locator('[data-bom-copy-section="stage_routes"]')).toBeChecked();
    await expect(page.locator('[data-bom-copy-section="sfg"]')).not.toBeChecked();

    await page.locator("[data-bom-copy-apply]").click();
    await expect(page.locator('[data-bom-copy-step="result"]')).toBeVisible();
    await expect(page.locator("[data-bom-copy-report]")).toContainText("1 / 1");
    await page.locator("[data-bom-copy-done]").click();
    await expect(page.locator("[data-bom-copy-modal]")).toBeHidden();

    // RM line copied into the Materials table.
    await page.locator('[data-rm-view-toggle="materials"]').click();
    const rmRow = page.locator('[data-lines-body="rm"] tr').first();
    await expect(rmRow.locator('[data-col="rm_item_id"]')).toHaveValue(
      String(fixture.rmItemId),
    );

    // Stage route copied.
    const stageRow = page.locator('[data-lines-body="stage_route"] tr').first();
    await expect(stageRow.locator('[data-col="dept_id"]')).toHaveValue(
      String(fixture.deptId),
    );

    // copied_from_bom_id hidden input is set before saving.
    await expect(page.locator('[data-bom-copied-from]')).toHaveValue(
      String(fixture.bomAId),
    );

    await saveDraft(page);
    const bomId = parseBomIdFromUrl(page.url());
    expect(bomId).toBeTruthy();
    ctx.createdBomIds.push(bomId);

    const snapshot = await getBomSnapshot(bomId);
    expect(snapshot?.header?.status).toBe("DRAFT");

    await expect(page.getByText("Copied from")).toBeVisible();

    // Free up Article B's "/new" slot immediately for the next test in this
    // serial suite (a user's own DRAFT for an item hides it from the picker).
    await deleteBomHeaderById(bomId);
    ctx.createdBomIds = ctx.createdBomIds.filter((id) => id !== bomId);
  });

  test("copying into a draft that already has RM data prompts to replace before applying", async ({
    page,
  }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.articleBId,
      outputQty: "1",
      outputUomId: fixture.productionUomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmOrphanItemId, deptId: fixture.deptId });

    await openCopyFromBomModal(page);
    await selectOptionForced(
      page.locator("[data-bom-copy-source]"),
      fixture.bomAId,
    );
    await page.locator("[data-bom-copy-apply]").click();

    const confirmModal = page.locator("[data-global-delete-confirm-modal]");
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("[data-global-delete-confirm-yes]").click();

    await expect(page.locator('[data-bom-copy-step="result"]')).toBeVisible();
    await page.locator("[data-bom-copy-done]").click();

    // The manually-entered orphan RM line was replaced by the copied one.
    await page.locator('[data-rm-view-toggle="materials"]').click();
    const rmRow = page.locator('[data-lines-body="rm"] tr').first();
    await expect(rmRow.locator('[data-col="rm_item_id"]')).toHaveValue(
      String(fixture.rmItemId),
    );
  });

  test("sku_overrides is auto-disabled when Raw Materials is unchecked; SFG stays disabled until Production Stages is checked", async ({
    page,
  }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.articleBId,
      outputQty: "1",
      outputUomId: fixture.productionUomId,
    });
    await openCopyFromBomModal(page);
    await selectOptionForced(
      page.locator("[data-bom-copy-source]"),
      fixture.bomAId,
    );

    const rmCheckbox = page.locator('[data-bom-copy-section="rm"]');
    const skuOverridesCheckbox = page.locator('[data-bom-copy-section="sku_overrides"]');
    const stageCheckbox = page.locator('[data-bom-copy-section="stage_routes"]');
    const sfgCheckbox = page.locator('[data-bom-copy-section="sfg"]');

    // Stage Routes is checked by default, so SFG starts enabled (still
    // unchecked - it's opt-in, but not blocked).
    await expect(sfgCheckbox).not.toBeChecked();
    await expect(sfgCheckbox).toBeEnabled();

    await rmCheckbox.uncheck();
    await expect(skuOverridesCheckbox).not.toBeChecked();
    await expect(skuOverridesCheckbox).toBeDisabled();

    await stageCheckbox.uncheck();
    await expect(sfgCheckbox).toBeDisabled();
    await stageCheckbox.check();
    await expect(sfgCheckbox).toBeEnabled();
  });

  test("copy SKU values: merge only fills empty materials, replace overwrites everything", async ({
    page,
  }) => {
    const fixture = ctx.fixture;

    // Build a fresh Article B draft with two RM lines directly (not copied),
    // so both skuB and skuB2 start with empty SKU rules.
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.articleBId,
      outputQty: "1",
      outputUomId: fixture.productionUomId,
    });
    await addRmRow(page, { rmItemId: fixture.rmItemId, deptId: fixture.deptId }, 0);
    await addSecondRmRow(page);
    await addRmRow(page, { rmItemId: fixture.rmOrphanItemId, deptId: fixture.deptId }, 1);

    await openSkuRulesView(page);

    // Open skuB and fill BOTH materials.
    await page.locator(`[data-sku-rule-chip="${fixture.skuBId}"]`).click();
    const rowsForB = page.locator('[data-sku-rule-row="true"]');
    await rowsForB.nth(0).locator('[data-sku-rule-col="required_qty"]').fill("10");
    await rowsForB.nth(0).locator('[data-sku-rule-col="required_qty"]').dispatchEvent("change");
    await rowsForB.nth(1).locator('[data-sku-rule-col="required_qty"]').fill("20");
    await rowsForB.nth(1).locator('[data-sku-rule-col="required_qty"]').dispatchEvent("change");

    // Open skuB2 and pre-fill only the FIRST material (rmItemId) with a
    // different value, leaving the second (rmOrphanItemId) empty.
    await page.locator(`[data-sku-rule-chip="${fixture.skuB2Id}"]`).click();
    const rowsForB2 = page.locator('[data-sku-rule-row="true"]');
    await rowsForB2.nth(0).locator('[data-sku-rule-col="required_qty"]').fill("99");
    await rowsForB2.nth(0).locator('[data-sku-rule-col="required_qty"]').dispatchEvent("change");

    // Copy from skuB into skuB2 with Merge (default).
    await page.locator("[data-sku-copy-from-open]").click();
    await expect(page.locator("[data-sku-copy-modal]")).toBeVisible();
    await selectOptionForced(page.locator("[data-sku-copy-source]"), fixture.skuBId);
    await expect(page.locator("[data-sku-copy-mode-wrap]")).toBeVisible();
    await expect(
      page.locator('[data-sku-copy-mode][value="merge"]'),
    ).toBeChecked();
    await page.locator("[data-sku-copy-apply]").click();
    await expect(page.locator("[data-sku-copy-modal]")).toBeHidden();

    const rowsForB2AfterMerge = page.locator('[data-sku-rule-row="true"]');
    // Untouched: skuB2's own pre-existing value for rmItemId must survive.
    await expect(
      rowsForB2AfterMerge.nth(0).locator('[data-sku-rule-col="required_qty"]'),
    ).toHaveValue("99");
    // Filled: the empty rmOrphanItemId material is now copied from skuB.
    await expect(
      rowsForB2AfterMerge.nth(1).locator('[data-sku-rule-col="required_qty"]'),
    ).toHaveValue("20");

    // Now copy again with Replace - this time skuB's value for rmItemId
    // (10) must overwrite skuB2's own value (99).
    await page.locator("[data-sku-copy-from-open]").click();
    await selectOptionForced(page.locator("[data-sku-copy-source]"), fixture.skuBId);
    await page.locator('[data-sku-copy-mode][value="replace"]').check();
    await page.locator("[data-sku-copy-apply]").click();

    const rowsForB2AfterReplace = page.locator('[data-sku-rule-row="true"]');
    await expect(
      rowsForB2AfterReplace.nth(0).locator('[data-sku-rule-col="required_qty"]'),
    ).toHaveValue("10");
    await expect(
      rowsForB2AfterReplace.nth(1).locator('[data-sku-rule-col="required_qty"]'),
    ).toHaveValue("20");

    await saveDraft(page);
    const bomId = parseBomIdFromUrl(page.url());
    expect(bomId).toBeTruthy();
    ctx.createdBomIds.push(bomId);
  });

  test("copy-payload rejects copying a BOM onto its own article", async ({ page }) => {
    const fixture = ctx.fixture;
    const params = new URLSearchParams({
      target_item_id: String(fixture.articleAId),
      target_level: "FINISHED",
      sections: "rm",
    });
    const res = await page.request.get(
      `/master-data/bom/${fixture.bomAId}/copy-payload?${params.toString()}`,
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(String(body.message || "")).not.toHaveLength(0);
  });

  test("copy-sources lists the approved BOM and excludes the requesting article itself", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    const res = await page.request.get(
      `/master-data/bom/copy-sources?level=FINISHED&exclude_item_id=${fixture.articleAId}`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(
      body.sources.some((row) => Number(row.item_id) === Number(fixture.articleAId)),
    ).toBe(false);

    const resIncluded = await page.request.get(
      `/master-data/bom/copy-sources?level=FINISHED&exclude_item_id=${fixture.articleBId}`,
    );
    const bodyIncluded = await resIncluded.json();
    expect(
      bodyIncluded.sources.some((row) => Number(row.bom_id) === Number(fixture.bomAId)),
    ).toBe(true);
  });
});
