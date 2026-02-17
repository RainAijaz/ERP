const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { createBomNegativeFixture, cleanupBomUiFixture, closeDb } = require("./utils/db");

const parseBomIdFromUrl = (url) => {
  const match = String(url || "").match(/\/master-data\/bom\/(\d+)(?:\?|$)/i);
  return match ? Number(match[1]) : null;
};

const fillBomHeader = async (page, { itemId, level = "FINISHED", outputQty = "1", outputUomId }) => {
  await page.locator('select[name="level"]').selectOption(String(level));
  await page.locator('select[name="item_id"]').selectOption(String(itemId));
  await page.locator('input[name="output_qty"]').fill(String(outputQty));
  await page.locator('select[name="output_uom_id"]').selectOption(String(outputUomId));
};

const submitBomForm = async (page) => {
  await page.locator('button[form="bom-form"]').click();
  await page.waitForLoadState("domcontentloaded");
};

test.describe("BOM UI negative validations", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
    createdBomIds: [],
  };

  test.beforeAll(async () => {
    const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const fixture = await createBomNegativeFixture(token);
    if (!fixture) {
      ctx.skipReason = "Unable to create BOM negative fixture data.";
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

  test("blocks save when RM line has no active purchase rate", async ({ page }) => {
    const fixture = ctx.fixture;
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      level: "FINISHED",
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    const rmRow = page.locator('[data-lines-body="rm"] tr').first();
    await rmRow.locator('[data-col="rm_item_id"]').selectOption(String(fixture.rmNoRateItemId));
    await rmRow.locator('[data-col="dept_id"]').selectOption(String(fixture.deptId));
    await rmRow.locator('[data-col="qty"]').fill("1");
    await rmRow.locator('[data-col="normal_loss_pct"]').fill("0");

    await submitBomForm(page);
    await expect(page).toHaveURL(/\/master-data\/bom\/save-draft/i);
    await expect(page.getByText(/Missing required material rates/i)).toBeVisible();
  });

  test("blocks save when SFG SKU has no approved BOM", async ({ page }) => {
    const fixture = ctx.fixture;
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      level: "FINISHED",
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    const sfgRow = page.locator('[data-lines-body="sfg"] tr').first();
    await sfgRow.locator('[data-col="fg_size_id"]').selectOption(String(fixture.sizeId));
    await sfgRow.locator('[data-col="sfg_sku_id"]').evaluate(
      (node, value) => {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = `Injected ${value}`;
        node.appendChild(option);
        node.value = String(value);
        node.dispatchEvent(new Event("change", { bubbles: true }));
      },
      fixture.sfgNoApprovedSkuId,
    );
    await sfgRow.locator('[data-col="required_qty"]').fill("1");

    await submitBomForm(page);
    await expect(page).toHaveURL(/\/master-data\/bom\/save-draft/i);
    await expect(page.getByText(/Selected SFG item has no approved BOM/i)).toBeVisible();
  });

  test("prevents duplicate draft for same item and level", async ({ page }) => {
    const fixture = ctx.fixture;
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      level: "FINISHED",
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await submitBomForm(page);
    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 10000 });

    const firstBomId = parseBomIdFromUrl(page.url());
    expect(firstBomId).toBeTruthy();
    ctx.createdBomIds.push(firstBomId);

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      level: "FINISHED",
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await submitBomForm(page);

    await expect(page).toHaveURL(/\/master-data\/bom\/save-draft/i);
    await expect(page.getByText(/A draft already exists for this item and level/i).first()).toBeVisible();
  });
});
