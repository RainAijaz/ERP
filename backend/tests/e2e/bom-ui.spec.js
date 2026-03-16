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

const openRmView = async (page, view = "materials") => {
  if (view === "materials" || view === "sku_rules") {
    await page.locator(`[data-rm-mode-toggle="${view}"]`).click();
    return;
  }
  await page.locator('[data-rm-mode-toggle="advanced"]').click();
  await page.locator(`[data-rm-view-toggle="${view}"]`).click();
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
    await selectOptionForced(page.locator('select[name="item_id"]'), fixture.fgItemId);
    await page.locator('input[name="output_qty"]').fill("1.5");
    await selectOptionForced(page.locator('select[name="output_uom_id"]'), fixture.uomId);

    await openRmView(page, "materials");

    const rmRow = page.locator('[data-lines-body="rm"] tr').first();
    await expect(rmRow).toBeVisible();
    await selectOptionForced(rmRow.locator('[data-col="rm_item_id"]'), fixture.rmItemId);
    await selectOptionForced(rmRow.locator('[data-col="dept_id"]'), fixture.deptId);
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
      await selectFirstNonEmptyOption(sfgRow.locator('[data-col="sfg_sku_id"]'));
      await sfgRow.locator('[data-col="required_qty"]').fill("1");
    }

    const labourSelectionRow = page
      .locator('[data-lines-body="labour_selection"] tr')
      .first();
    await expect(labourSelectionRow).toBeVisible();
    await selectOptionForced(
      labourSelectionRow.locator('[data-col="labour_id"]'),
      fixture.labourId,
    );
    await selectOptionForced(
      labourSelectionRow.locator('[data-col="dept_id"]'),
      fixture.deptId,
    );
    await selectOptionForced(
      labourSelectionRow.locator('[data-col="rate_type"]'),
      "PER_PAIR",
    );
    await page.locator('[data-labour-view-toggle="size_rules"]').click();
    const labourRateRow = page
      .locator('[data-lines-body="labour_rule"] [data-labour-rule-entry="true"]')
      .first();
    await expect(labourRateRow).toBeVisible();
    await labourRateRow.locator('[data-labour-rule-col="rate_value"]').fill("15");

    await openRmView(page, "size_rules");
    const ruleRows = page.locator("[data-rule-entry]");
    const ruleRowCount = await ruleRows.count();
    const hasRuleRows = ruleRowCount > 0;
    if (hasRuleRows) {
      const ruleRow = ruleRows.first();
      await expect(ruleRow).toBeVisible();
      await ruleRow.locator("[data-rule-qty]").fill("1.25");
      await expect(ruleRow.locator("[data-rule-qty]")).toHaveValue("1.25");
    }

    await expect(rmRow.locator('[data-col="rm_item_id"]')).toHaveValue(
      String(fixture.rmItemId),
    );
    if (hasSfgRows) {
      await expect(sfgRows.first().locator('[data-col="sfg_sku_id"]')).not.toHaveValue("");
    }
    await expect(labourSelectionRow.locator('[data-col="labour_id"]')).toHaveValue(
      String(fixture.labourId),
    );

    await openRmView(page, "sku_rules");
    const skuRuleChipCount = await page.locator("[data-sku-rule-chip]").count();
    for (let chipIndex = 0; chipIndex < skuRuleChipCount; chipIndex += 1) {
      await page.locator("[data-sku-rule-chip]").nth(chipIndex).click();
      const skuRuleRows = page.locator('[data-sku-rule-row="true"]');
      const skuRuleCount = await skuRuleRows.count();
      for (let rowIndex = 0; rowIndex < skuRuleCount; rowIndex += 1) {
        const row = skuRuleRows.nth(rowIndex);
        const colorSelect = row.locator('[data-sku-rule-col="rm_color_id"]');
        if (await colorSelect.count()) {
          await selectFirstNonEmptyOption(colorSelect);
        }
        await row.locator('[data-sku-rule-col="required_qty"]').fill("1");
      }
    }

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
    if (hasRuleRows) {
      expect(draftSnapshot.counts.rule).toBe(1);
    } else {
      expect(draftSnapshot.counts.rule).toBe(0);
    }

    const approveBtn = page
      .locator(`form[action$="/${firstBomId}/send-for-approval"] button`)
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

    const createVersionBtn = page
      .locator(`form[action$="/${firstBomId}/create-new-version"] button`)
      .first();
    await expect(createVersionBtn).toBeVisible();
    await createVersionBtn.click();
    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, {
      timeout: 30000,
    });

    const secondBomId = parseBomIdFromUrl(page.url());
    expect(secondBomId).toBeTruthy();
    expect(secondBomId).not.toBe(firstBomId);
    ctx.createdBomIds.push(secondBomId);

    const newVersionSnapshot = await getBomSnapshot(secondBomId);
    expect(newVersionSnapshot).toBeTruthy();
    expect(newVersionSnapshot.header.status).toBe("DRAFT");
    expect(Number(newVersionSnapshot.header.version_no)).toBe(
      Number(approvedSnapshot.header.version_no) + 1,
    );
    expect(newVersionSnapshot.counts.rm).toBe(1);
    expect(newVersionSnapshot.counts.sfg).toBeGreaterThanOrEqual(0);
    expect(newVersionSnapshot.counts.labour).toBeGreaterThanOrEqual(1);
    if (hasRuleRows) {
      expect(newVersionSnapshot.counts.rule).toBe(1);
    } else {
      expect(newVersionSnapshot.counts.rule).toBe(0);
    }
  });
});
