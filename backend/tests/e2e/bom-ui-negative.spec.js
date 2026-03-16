const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomNegativeFixture,
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

const openAdvancedRmMaterials = async (page) => {
  await page.locator('[data-rm-mode-toggle="materials"]').click();
};

const fillBomHeader = async (
  page,
  { itemId, level = "FINISHED", outputQty = "1", outputUomId },
) => {
  await selectOptionForced(page.locator('select[name="level"]'), level);
  await selectOptionForced(page.locator('select[name="item_id"]'), itemId);
  await page.locator('input[name="output_qty"]').fill(String(outputQty));
  await selectOptionForced(
    page.locator('select[name="output_uom_id"]'),
    outputUomId,
  );
};

const submitBomForm = async (page) => {
  await page.locator("[data-bom-save-draft]").click();
  await page.waitForLoadState("domcontentloaded");
};

const submitBomApprove = async (page) => {
  await page.locator("[data-bom-approve-now]").click();
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

  test("blocks save when RM line has no active purchase rate", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      level: "FINISHED",
      outputQty: "1",
      outputUomId: fixture.uomId,
    });
    await openAdvancedRmMaterials(page);
    const rmRow = page.locator('[data-lines-body="rm"] tr').first();
    await selectOptionForced(
      rmRow.locator('[data-col="rm_item_id"]'),
      fixture.rmNoRateItemId,
    );
    await selectOptionForced(rmRow.locator('[data-col="dept_id"]'), fixture.deptId);

    await submitBomForm(page);
    await expect(page).toHaveURL(/\/master-data\/bom\/save-draft/i);
    await expect(page).not.toHaveURL(/\/master-data\/bom\/\d+(?:\?|$)/i);
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
    await expect(sfgRow).toBeVisible();
    await sfgRow.locator('[data-col="sfg_sku_id"]').evaluate((node, value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `Injected ${value}`;
      node.appendChild(option);
      node.value = String(value);
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, fixture.sfgNoApprovedSkuId);
    await sfgRow.locator('[data-col="required_qty"]').fill("1");

    await submitBomForm(page);
    await expect(page).toHaveURL(/\/master-data\/bom\/save-draft/i);
    await expect(page).not.toHaveURL(/\/master-data\/bom\/\d+(?:\?|$)/i);
  });

  test("does not create draft when approve-now fails mandatory readiness", async ({ page }) => {
    const fixture = ctx.fixture;
    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });

    await fillBomHeader(page, {
      itemId: fixture.fgItemId,
      level: "FINISHED",
      outputQty: "1",
      outputUomId: fixture.uomId,
    });

    await submitBomApprove(page);
    await expect(page).toHaveURL(/\/master-data\/bom\/save-draft/i);
    await expect(page).not.toHaveURL(/\/master-data\/bom\/\d+(?:\?|$)/i);

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    const selectableItemIds = await page.locator('select[name="item_id"]').evaluate((node) =>
      Array.from(node.options || [])
        .map((opt) => String(opt.value || "").trim())
        .filter(Boolean),
    );
    expect(selectableItemIds).toContain(String(fixture.fgItemId));
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
    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, {
      timeout: 10000,
    });

    const firstBomId = parseBomIdFromUrl(page.url());
    expect(firstBomId).toBeTruthy();
    ctx.createdBomIds.push(firstBomId);

    await page.goto("/master-data/bom/new", { waitUntil: "domcontentloaded" });
    await selectOptionForced(page.locator('select[name="level"]'), "FINISHED");
    const selectableItemIds = await page.locator('select[name="item_id"]').evaluate((node) =>
      Array.from(node.options || [])
        .map((opt) => String(opt.value || "").trim())
        .filter(Boolean),
    );
    expect(selectableItemIds).not.toContain(String(fixture.fgItemId));
  });
});
