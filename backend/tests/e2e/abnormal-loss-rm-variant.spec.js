const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomUiFixture,
  cleanupBomUiFixture,
  closeDb,
} = require("./utils/db");

const selectOptionForced = async (locator, value) =>
  locator.selectOption(String(value), { force: true });

const getNonEmptyOptionValues = async (locator) =>
  locator
    .locator("option")
    .evaluateAll((options) =>
      options
        .map((option) => String(option.value || "").trim())
        .filter(Boolean),
    );

test.describe("Abnormal loss RM variant serialization", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
  };

  test.beforeAll(async () => {
    const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const fixture = await createBomUiFixture(`loss${token}`);
    if (!fixture) {
      ctx.skipReason = "Unable to create abnormal-loss fixture data.";
      return;
    }
    ctx.ready = true;
    ctx.fixture = fixture;
  });

  test.afterAll(async () => {
    await cleanupBomUiFixture({ fixture: ctx.fixture, bomIds: [] });
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await login(page, "E2E_ADMIN");
  });

  test("RM loss row includes color/size variant fields in lines_json", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    const response = await page.goto("/vouchers/abnormal-loss?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Abnormal loss voucher page not accessible.",
    );

    const lossTypeSelect = page.locator("[data-loss-type-header]");
    await expect(lossTypeSelect).toBeVisible();
    await selectOptionForced(lossTypeSelect, "RM_LOSS");

    const deptSelect = page.locator("[data-loss-department-header]");
    await expect(deptSelect).toBeVisible();
    const deptOptions = await getNonEmptyOptionValues(deptSelect);
    test.skip(
      !deptOptions.length,
      "No production department options available.",
    );
    const deptValue = deptOptions.includes(String(fixture.deptId))
      ? String(fixture.deptId)
      : deptOptions[0];
    await selectOptionForced(deptSelect, deptValue);

    const firstRow = page.locator("[data-lines-body] tr").first();
    await expect(firstRow).toBeVisible();

    const entitySelect = firstRow.locator('select[data-field="entity_ref"]');
    const entityValues = await getNonEmptyOptionValues(entitySelect);
    const expectedEntity = `RM:${fixture.rmItemId}`;
    test.skip(
      !entityValues.includes(expectedEntity),
      "Fixture RM item is not available in abnormal loss voucher item options.",
    );
    await selectOptionForced(entitySelect, expectedEntity);

    const colorSelect = firstRow.locator('select[data-field="rm_color_id"]');
    await expect(colorSelect).toBeVisible();
    const colorValues = await getNonEmptyOptionValues(colorSelect);
    test.skip(
      !colorValues.length,
      "No RM color options available for selected item.",
    );
    const selectedColorId = colorValues.includes(String(fixture.colorId))
      ? String(fixture.colorId)
      : colorValues[0];
    await selectOptionForced(colorSelect, selectedColorId);

    const sizeSelect = firstRow.locator('select[data-field="rm_size_id"]');
    await expect(sizeSelect).toBeVisible();
    const sizeValues = await getNonEmptyOptionValues(sizeSelect);
    const selectedSizeId = sizeValues.includes(String(fixture.sizeId))
      ? String(fixture.sizeId)
      : sizeValues[0] || "";
    if (selectedSizeId) {
      await selectOptionForced(sizeSelect, selectedSizeId);
    }

    const qtyInput = firstRow.locator('input[data-field="qty"]');
    await qtyInput.fill("2");

    const rateInput = firstRow.locator('input[data-field="rate"]');
    const amountInput = firstRow.locator('input[data-field="amount"]');
    const rateValue = Number(await rateInput.inputValue());
    const amountValue = Number(await amountInput.inputValue());
    expect(rateValue).toBeGreaterThan(0);
    expect(amountValue).toBeCloseTo(Number((2 * rateValue).toFixed(2)), 2);

    const linesJson = await page.evaluate(() => {
      const form = document.querySelector("[data-production-form]");
      if (!(form instanceof HTMLFormElement)) return "";
      form.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
        },
        { once: true },
      );
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      }
      const linesInput = form.querySelector("[data-lines-json]");
      if (!(linesInput instanceof HTMLInputElement)) return "";
      return String(linesInput.value || "");
    });

    expect(linesJson).toBeTruthy();
    const parsedLines = JSON.parse(linesJson);
    expect(Array.isArray(parsedLines)).toBeTruthy();
    expect(parsedLines.length).toBeGreaterThan(0);

    const firstLine = parsedLines[0];
    expect(firstLine.loss_type).toBe("RM_LOSS");
    expect(Number(firstLine.item_id)).toBe(Number(fixture.rmItemId));
    expect(Number(firstLine.rm_color_id)).toBe(Number(selectedColorId));
    if (selectedSizeId) {
      expect(Number(firstLine.rm_size_id)).toBe(Number(selectedSizeId));
    } else {
      expect(
        firstLine.rm_size_id === null || firstLine.rm_size_id === "",
      ).toBeTruthy();
    }
    expect(Number(firstLine.amount)).toBeCloseTo(
      Number((2 * rateValue).toFixed(2)),
      2,
    );
  });
});
