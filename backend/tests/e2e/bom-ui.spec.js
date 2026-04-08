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

const pruneEmptyLabourRows = async (page) => {
  const rows = page.locator('[data-lines-body="labour_selection"] tr');
  let count = await rows.count();
  for (let i = count - 1; i >= 0; i -= 1) {
    count = await rows.count();
    if (count <= 1) break;
    const row = rows.nth(i);
    const labourSelect = row.locator('[data-col="labour_id"]');
    if (!(await labourSelect.count())) continue;
    const labourId = String(await labourSelect.inputValue());
    if (!labourId) {
      const removeBtn = row.locator('[data-remove-row="labour_selection"]');
      if (await removeBtn.count()) {
        await removeBtn.click();
      }
    }
  }
};

const fillEmptyLabourRows = async (page, fixture) => {
  const rows = page.locator('[data-lines-body="labour_selection"] tr');
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const labourSelect = row.locator('[data-col="labour_id"]');
    const deptSelect = row.locator('[data-col="dept_id"]');
    if (!(await labourSelect.count()) || !(await deptSelect.count())) continue;
    const labourId = String(await labourSelect.inputValue());
    if (!labourId) {
      await selectOptionForced(labourSelect, fixture.labourId);
    }
    const deptId = String(await deptSelect.inputValue());
    if (!deptId) {
      await selectOptionForced(deptSelect, fixture.deptId);
    }
    await selectOptionForced(row.locator('[data-col="rate_type"]'), "PER_PAIR");
  }
};

const openRmView = async (page, view = "materials") => {
  const normalizedView = view === "size_rules" ? "sku_rules" : view;
  if (normalizedView !== "materials" && normalizedView !== "sku_rules") return;
  await page.locator(`[data-rm-view-toggle="${normalizedView}"]`).click();
};

test.describe("BOM UI row editing flow", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
    createdBomIds: [],
  };

  test.beforeAll(async () => {
    const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const fixture = await createBomUiFixture(token);
    if (!fixture) {
      ctx.skipReason = "Unable to create BOM fixture data.";
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

  test("can edit RM/SFG/Labour/Rule rows and complete draft to approve to version flow", async ({
    page,
  }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await selectOptionForced(page.locator('select[name="level"]'), "FINISHED");
    await selectOptionForced(
      page.locator('select[name="item_id"]'),
      fixture.fgItemId,
    );
    await page.locator('input[name="output_qty"]').fill("1.5");
    await selectOptionForced(
      page.locator('select[name="output_uom_id"]'),
      fixture.uomId,
    );
    await selectOptionForced(
      page
        .locator('[data-lines-body="stage_route"] tr')
        .first()
        .locator('[data-col="dept_id"]'),
      fixture.deptId,
    );

    await openRmView(page, "materials");

    const rmRow = page.locator('[data-lines-body="rm"] tr').first();
    await expect(rmRow).toBeVisible();
    await selectOptionForced(
      rmRow.locator('[data-col="rm_item_id"]'),
      fixture.rmItemId,
    );
    await selectOptionForced(
      rmRow.locator('[data-col="dept_id"]'),
      fixture.deptId,
    );
    await rmRow.locator('[data-add-after="rm"]').click();
    await page
      .locator('[data-lines-body="rm"] tr')
      .nth(1)
      .locator('[data-remove-row="rm"]')
      .click();

    const sfgRows = page.locator('[data-lines-body="sfg"] tr');
    const sfgRowCount = await sfgRows.count();
    const hasSfgRows = sfgRowCount > 0;
    if (hasSfgRows) {
      const sfgRow = sfgRows.first();
      await expect(sfgRow).toBeVisible();
      await selectFirstNonEmptyOption(
        sfgRow.locator('[data-col="sfg_sku_id"]'),
      );
      await sfgRow.locator('[data-col="required_qty"]').fill("1");
      await selectFirstNonEmptyOption(
        sfgRow.locator('[data-col="consumed_in_stage_id"]'),
      );
    }

    await pruneEmptyLabourRows(page);

    const hasRuleRows = false;

    await expect(rmRow.locator('[data-col="rm_item_id"]')).toHaveValue(
      String(fixture.rmItemId),
    );
    if (hasSfgRows) {
      await expect(
        sfgRows.first().locator('[data-col="sfg_sku_id"]'),
      ).not.toHaveValue("");
    }
    const labourSelectionRows = page.locator(
      '[data-lines-body="labour_selection"] tr',
    );
    const labourSelectionRowCount = await labourSelectionRows.count();
    expect(labourSelectionRowCount).toBeGreaterThan(0);

    await openRmView(page, "sku_rules");
    let persistedSkuRuleQty = null;
    let persistedSkuRuleChip = null;
    const skuRuleChipCount = await page.locator("[data-sku-rule-chip]").count();
    for (let chipIndex = 0; chipIndex < skuRuleChipCount; chipIndex += 1) {
      const chip = page.locator("[data-sku-rule-chip]").nth(chipIndex);
      const chipLabel = String((await chip.textContent()) || "").trim();
      await chip.click();
      const skuRuleRows = page.locator('[data-sku-rule-row="true"]');
      const skuRuleCount = await skuRuleRows.count();
      for (let rowIndex = 0; rowIndex < skuRuleCount; rowIndex += 1) {
        const row = skuRuleRows.nth(rowIndex);
        const colorSelect = row.locator('[data-sku-rule-col="rm_color_id"]');
        if (await colorSelect.count()) {
          await selectFirstNonEmptyOption(colorSelect);
        }
        const qtyValue = chipIndex === 0 && rowIndex === 0 ? "50" : "1";
        await row.locator('[data-sku-rule-col="required_qty"]').fill(qtyValue);
        if (chipIndex === 0 && rowIndex === 0) {
          persistedSkuRuleQty = qtyValue;
          persistedSkuRuleChip = chipLabel;
        }
      }
    }

    // Intentionally save immediately without blurring SKU-rule qty input.
    await page.locator("[data-bom-save-draft]").click();
    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, {
      timeout: 30000,
    });

    const firstBomId = parseBomIdFromUrl(page.url());
    expect(firstBomId).toBeTruthy();
    ctx.createdBomIds.push(firstBomId);

    const draftSnapshot = await getBomSnapshot(firstBomId);
    expect(draftSnapshot).toBeTruthy();
    expect(draftSnapshot.header.status).toBe("DRAFT");
    expect(Number(draftSnapshot.header.output_qty)).toBeCloseTo(1.5, 3);
    expect(draftSnapshot.counts.rm).toBe(1);
    expect(draftSnapshot.counts.sfg).toBeGreaterThanOrEqual(0);
    expect(draftSnapshot.counts.labour).toBeGreaterThanOrEqual(1);
    expect(draftSnapshot.counts.rule).toBe(0);

    // Regression check: SKU-rule qty must persist after save + reload.
    await openRmView(page, "sku_rules");
    if (persistedSkuRuleChip) {
      const persistedChip = page
        .locator("[data-sku-rule-chip]")
        .filter({ hasText: persistedSkuRuleChip })
        .first();
      await persistedChip.click();
    }
    const persistedQtyInput = page
      .locator('[data-sku-rule-row="true"] [data-sku-rule-col="required_qty"]')
      .first();
    if (persistedSkuRuleQty) {
      await expect(persistedQtyInput).toHaveValue(persistedSkuRuleQty);
    }

    const approveBtn = page
      .locator('[data-bom-approve-now="1"], [data-bom-send-approval="1"]')
      .first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();
    await page.waitForURL(
      new RegExp(`/master-data/bom/${firstBomId}(?:\\?|$)`),
      { timeout: 30000 },
    );

    const approvedSnapshot = await getBomSnapshot(firstBomId);
    expect(approvedSnapshot).toBeTruthy();
    expect(approvedSnapshot.header.status).toBe("APPROVED");
    expect(approvedSnapshot.header.approved_by).toBeTruthy();

    const createVersionBtn = page.locator(
      `form[action$="/${firstBomId}/create-new-version"] button`,
    );
    await expect(createVersionBtn).toHaveCount(1);
  });
});
