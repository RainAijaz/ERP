// Covers the multi-row Semi-Finished grid on the BOM form.
//
// An article can consume more than one semi-finished input per size (e.g. an Upper
// AND a shared global part). The grid used to be rebuilt as exactly one row per
// article SKU, which silently discarded any extra row. These tests pin the new
// behaviour: rows are seeded per SIZE, can be added and removed, and survive the
// re-renders that syncStateFromDom triggers.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const SFG_ROWS = '[data-lines-body="sfg"] tr';

const pickFinishedItemUsingSfg = async (page) => {
  // The SFG section only renders for a FINISHED BOM whose item has uses_sfg = true.
  const levelSelect = page.locator('select[name="level"]');
  await levelSelect.selectOption("FINISHED", { force: true });

  const itemSelect = page.locator('select[name="item_id"]');
  const values = await itemSelect.evaluate((node) =>
    Array.from(node.options || [])
      .map((o) => String(o.value || "").trim())
      .filter(Boolean),
  );

  for (const value of values) {
    await itemSelect.selectOption(value, { force: true });
    await page.waitForTimeout(250);

    // The section only un-hides once the whole header is complete, so fill the rest
    // of it before judging. Use the article's own base unit as the output unit to
    // avoid tripping the "needs an active UOM conversion" header validation.
    await page.locator('input[name="output_qty"]').fill("1");
    const uomSelect = page.locator('select[name="output_uom_id"]');
    const pairValue = await uomSelect.evaluate((node) => {
      const opts = Array.from(node.options || []).filter((o) => String(o.value || "").trim());
      const pair = opts.find((o) => /pair/i.test(o.textContent || ""));
      return String((pair || opts[0] || {}).value || "");
    });
    if (pairValue) await uomSelect.selectOption(pairValue, { force: true });
    await page.waitForTimeout(400);

    const rows = await page.locator(SFG_ROWS).count();
    const visible = await page.locator("#bom-sfg").isVisible().catch(() => false);
    if (rows > 0 && visible) return value;
  }
  return "";
};

const clickRowButton = async (page, rowIndex, selector) => {
  await page
    .locator(`${SFG_ROWS} >> nth=${rowIndex}`)
    .locator(selector)
    .click({ force: true });
  await page.waitForTimeout(300);
};

test.describe("BOM semi-finished grid supports multiple rows per size", () => {
  test.describe.configure({ mode: "serial" });

  test("a size can hold more than one semi-finished row", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/master-data/bom/new");

    const itemValue = await pickFinishedItemUsingSfg(page);
    test.skip(!itemValue, "No finished article with uses_sfg and SKUs available in this database.");

    const initialRows = await page.locator(SFG_ROWS).count();
    expect(initialRows).toBeGreaterThan(0);

    // Every seeded row must carry a size, since rows are keyed by size.
    const firstSizeId = await page
      .locator(`${SFG_ROWS} >> nth=0`)
      .locator('[data-col="fg_size_id"]')
      .inputValue();
    expect(firstSizeId).not.toEqual("");

    // The "+" on a row adds another row for the SAME size.
    await clickRowButton(page, 0, "[data-add-after]");

    expect(await page.locator(SFG_ROWS).count()).toBe(initialRows + 1);
    const secondSizeId = await page
      .locator(`${SFG_ROWS} >> nth=1`)
      .locator('[data-col="fg_size_id"]')
      .inputValue();
    expect(secondSizeId).toBe(firstSizeId);
  });

  test("an added blank row is not swallowed by a re-render", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/master-data/bom/new");

    const itemValue = await pickFinishedItemUsingSfg(page);
    test.skip(!itemValue, "No finished article with uses_sfg and SKUs available in this database.");

    const initialRows = await page.locator(SFG_ROWS).count();
    await clickRowButton(page, 0, "[data-add-after]");
    expect(await page.locator(SFG_ROWS).count()).toBe(initialRows + 1);

    // Touching an unrelated field runs syncStateFromDom + a full re-render. The new
    // blank row shares a size with an existing blank row, so a dedupe keyed only on
    // size would merge it away here.
    await page.locator('input[name="output_qty"]').fill("2");
    await page.locator('input[name="output_qty"]').blur();
    await page.waitForTimeout(400);

    expect(await page.locator(SFG_ROWS).count()).toBe(initialRows + 1);
  });

  test("a row can be removed and every size stays represented", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/master-data/bom/new");

    const itemValue = await pickFinishedItemUsingSfg(page);
    test.skip(!itemValue, "No finished article with uses_sfg and SKUs available in this database.");

    const initialRows = await page.locator(SFG_ROWS).count();
    await clickRowButton(page, 0, "[data-add-after]");
    expect(await page.locator(SFG_ROWS).count()).toBe(initialRows + 1);

    await clickRowButton(page, 1, "[data-remove-row]");

    // Back to the seeded state: one row per size, none of them lost.
    expect(await page.locator(SFG_ROWS).count()).toBe(initialRows);
    const sizeIds = await page
      .locator(`${SFG_ROWS} [data-col="fg_size_id"]`)
      .evaluateAll((nodes) => nodes.map((n) => String(n.value || "")));
    expect(sizeIds.every(Boolean)).toBe(true);
    expect(new Set(sizeIds).size).toBe(initialRows);
  });
});
