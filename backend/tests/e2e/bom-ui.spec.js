const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { createBomUiFixture, getBomSnapshot, cleanupBomUiFixture, closeDb } = require("./utils/db");

const parseBomIdFromUrl = (url) => {
  const match = String(url || "").match(/\/master-data\/bom\/(\d+)(?:\?|$)/i);
  return match ? Number(match[1]) : null;
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

  test("can edit RM/SFG/Labour/Rule rows and complete draft to approve to version flow", async ({ page }) => {
    const fixture = ctx.fixture;

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await page.locator('select[name="level"]').selectOption("FINISHED");
    await page.locator('select[name="item_id"]').selectOption(String(fixture.fgItemId));
    await page.locator('input[name="output_qty"]').fill("1.5");
    await page.locator('select[name="output_uom_id"]').selectOption(String(fixture.uomId));

    const rmRow = page.locator('[data-lines-body="rm"] tr').first();
    await expect(rmRow).toBeVisible();
    await rmRow.locator('[data-col="rm_item_id"]').selectOption(String(fixture.rmItemId));
    await rmRow.locator('[data-col="color_id"]').selectOption(String(fixture.colorId));
    await rmRow.locator('[data-col="dept_id"]').selectOption(String(fixture.deptId));
    await rmRow.locator('[data-col="qty"]').fill("2");
    await rmRow.locator('[data-col="normal_loss_pct"]').fill("1");
    await rmRow.locator('[data-add-after="rm"]').click();
    await page.locator('[data-lines-body="rm"] tr').nth(1).locator('[data-remove-row="rm"]').click();

    const sfgRow = page.locator('[data-lines-body="sfg"] tr').first();
    await expect(sfgRow).toBeVisible();
    await sfgRow.locator('[data-col="fg_size_id"]').selectOption(String(fixture.sizeId));
    await sfgRow.locator('[data-col="sfg_sku_id"]').selectOption(String(fixture.sfgSkuId));
    await sfgRow.locator('[data-col="required_qty"]').fill("1");

    const labourRow = page.locator('[data-lines-body="labour"] tr').first();
    await expect(labourRow).toBeVisible();
    await labourRow.locator('[data-col="size_scope"]').selectOption("SPECIFIC");
    await labourRow.locator('[data-col="size_id"]').selectOption(String(fixture.sizeId));
    await labourRow.locator('[data-col="labour_id"]').selectOption(String(fixture.labourId));
    await labourRow.locator('[data-col="dept_id"]').selectOption(String(fixture.deptId));
    await labourRow.locator('[data-col="rate_type"]').selectOption("PER_PAIR");
    await labourRow.locator('[data-col="rate_value"]').fill("15");

    const ruleRow = page.locator('[data-lines-body="rule"] tr').first();
    await expect(ruleRow).toBeVisible();
    await ruleRow.locator('[data-col="size_scope"]').selectOption("SPECIFIC");
    await ruleRow.locator('[data-col="size_id"]').selectOption(String(fixture.sizeId));
    await ruleRow.locator('[data-col="packing_scope"]').selectOption("SPECIFIC");
    await ruleRow.locator('[data-col="packing_type_id"]').selectOption(String(fixture.packingTypeId));
    await ruleRow.locator('[data-col="color_scope"]').selectOption("SPECIFIC");
    await ruleRow.locator('[data-col="color_id"]').selectOption(String(fixture.colorId));
    await ruleRow.locator('[data-col="action_type"]').selectOption("ADJUST_QTY");
    await ruleRow.locator('[data-col="material_scope"]').selectOption("SPECIFIC");
    await ruleRow.locator('[data-col="target_rm_item_id"]').selectOption(String(fixture.rmItemId));
    await ruleRow.locator('[data-col="new_value"]').fill('{"qty":1.25}');

    await expect(rmRow.locator('[data-col="rm_item_id"]')).toHaveValue(String(fixture.rmItemId));
    await expect(sfgRow.locator('[data-col="sfg_sku_id"]')).toHaveValue(String(fixture.sfgSkuId));
    await expect(labourRow.locator('[data-col="labour_id"]')).toHaveValue(String(fixture.labourId));
    await expect(ruleRow.locator('[data-col="target_rm_item_id"]')).toHaveValue(String(fixture.rmItemId));
    await page.locator('button[form="bom-form"]').click();
    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 30000 });

    const firstBomId = parseBomIdFromUrl(page.url());
    expect(firstBomId).toBeTruthy();
    ctx.createdBomIds.push(firstBomId);

    const draftSnapshot = await getBomSnapshot(firstBomId);
    expect(draftSnapshot).toBeTruthy();
    expect(draftSnapshot.header.status).toBe("DRAFT");
    expect(Number(draftSnapshot.header.output_qty)).toBeCloseTo(1.5, 3);
    expect(draftSnapshot.counts.rm).toBe(1);
    expect(draftSnapshot.counts.sfg).toBe(1);
    expect(draftSnapshot.counts.labour).toBe(1);
    expect(draftSnapshot.counts.rule).toBe(1);

    const approveBtn = page.locator(`form[action$="/${firstBomId}/send-for-approval"] button`).first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();
    await page.waitForURL(new RegExp(`/master-data/bom/${firstBomId}(?:\\?|$)`), { timeout: 30000 });

    const approvedSnapshot = await getBomSnapshot(firstBomId);
    expect(approvedSnapshot).toBeTruthy();
    expect(approvedSnapshot.header.status).toBe("APPROVED");
    expect(approvedSnapshot.header.approved_by).toBeTruthy();

    const createVersionBtn = page.locator(`form[action$="/${firstBomId}/create-new-version"] button`).first();
    await expect(createVersionBtn).toBeVisible();
    await createVersionBtn.click();
    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 30000 });

    const secondBomId = parseBomIdFromUrl(page.url());
    expect(secondBomId).toBeTruthy();
    expect(secondBomId).not.toBe(firstBomId);
    ctx.createdBomIds.push(secondBomId);

    const newVersionSnapshot = await getBomSnapshot(secondBomId);
    expect(newVersionSnapshot).toBeTruthy();
    expect(newVersionSnapshot.header.status).toBe("DRAFT");
    expect(Number(newVersionSnapshot.header.version_no)).toBe(Number(approvedSnapshot.header.version_no) + 1);
    expect(newVersionSnapshot.counts.rm).toBe(1);
    expect(newVersionSnapshot.counts.sfg).toBe(1);
    expect(newVersionSnapshot.counts.labour).toBe(1);
    expect(newVersionSnapshot.counts.rule).toBe(1);
  });
});
