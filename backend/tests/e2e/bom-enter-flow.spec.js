const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomUiFixture,
  cleanupBomUiFixture,
  closeDb,
} = require("./utils/db");

const selectOptionForced = async (locator, value) =>
  locator.selectOption(String(value), { force: true });

test.describe("BOM Enter key flow", () => {
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

  test("mandatory-in-flow Enter keeps selected department and appends next stage row", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await selectOptionForced(page.locator('select[name="level"]'), "FINISHED");
    await selectOptionForced(page.locator('select[name="item_id"]'), fixture.fgItemId);
    await page.locator('input[name="output_qty"]').fill("1");
    await selectOptionForced(page.locator('select[name="output_uom_id"]'), fixture.uomId);

    const stageRows = page.locator('[data-lines-body="stage_route"] tr');
    const firstStageRow = stageRows.first();
    await expect(firstStageRow).toBeVisible();
    const deptSelect = firstStageRow.locator('select[data-col="dept_id"]');
    await selectOptionForced(deptSelect, "");
    await expect(deptSelect).toHaveValue("");
    const deptInput = deptSelect
      .locator("xpath=ancestor::*[@data-searchable-wrapper][1]//input[@type='text']")
      .first();
    await deptInput.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    await expect(stageRows).toHaveCount(2);
    await expect(firstStageRow.locator('select[data-col="dept_id"]')).not.toHaveValue("");
  });
});
