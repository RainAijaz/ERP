const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomUiFixture,
  cleanupBomUiFixture,
  closeDb,
} = require("./utils/db");

const selectOptionForced = async (locator, value) =>
  locator.selectOption(String(value), { force: true });

test.describe("BOM header qty apply clears SFG qty", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
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
      bomIds: [],
    });
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await login(page, "E2E_ADMIN");
  });

  test("Apply (Clear Quantities) clears SFG Step Quantity input", async ({ page }) => {
    const fixture = ctx.fixture;
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await selectOptionForced(page.locator('select[name="level"]'), "FINISHED");
    await selectOptionForced(page.locator('select[name="item_id"]'), fixture.fgItemId);
    await page.locator('input[name="output_qty"]').fill("1");
    await selectOptionForced(page.locator('select[name="output_uom_id"]'), fixture.uomId);
    await selectOptionForced(
      page.locator('[data-lines-body="stage_route"] tr').first().locator('[data-col="dept_id"]'),
      fixture.deptId,
    );

    const sfgRow = page.locator('[data-lines-body="sfg"] tr').first();
    await expect(sfgRow).toBeVisible();
    await selectOptionForced(sfgRow.locator('[data-col="sfg_sku_id"]'), fixture.sfgSkuId);
    await sfgRow.locator('[data-col="required_qty"]').fill("2");
    await expect(sfgRow.locator('[data-col="required_qty"]')).toHaveValue("2");

    const outputQty = page.locator('input[name="output_qty"]');
    await outputQty.fill("3");
    await outputQty.blur();

    const headerModal = page.locator("[data-bom-header-change-modal]");
    await expect(headerModal).toBeVisible();
    await page.locator("[data-bom-header-modal-apply]").click();
    await expect(headerModal).toBeHidden();

    await expect(sfgRow.locator('[data-col="required_qty"]')).toHaveValue("");
  });
});
