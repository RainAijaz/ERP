const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const pagesToValidate = [
  "/master-data/products/finished",
  "/master-data/products/raw-materials",
  "/master-data/accounts",
  "/master-data/parties",
  "/hr-payroll/labour-rates",
];

async function readEnhancedControlBox(page, selectSelector) {
  return page.evaluate((selector) => {
    const select = document.querySelector(selector);
    if (!(select instanceof HTMLSelectElement)) return null;
    const wrapper =
      select.closest("[data-searchable-wrapper]") ||
      (select.parentElement?.matches("[data-searchable-wrapper]")
        ? select.parentElement
        : null);
    if (!(wrapper instanceof HTMLElement)) return null;
    const input = wrapper.querySelector('input[type="text"]');
    if (!(input instanceof HTMLInputElement)) return null;
    const rect = input.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    return {
      inputWidth: Math.round(rect.width),
      inputHeight: Math.round(rect.height),
      wrapperWidth: Math.round(wrapperRect.width),
      wrapperHeight: Math.round(wrapperRect.height),
    };
  }, selectSelector);
}

test.describe("Shared table controls and auto-translate regressions", () => {
  test("table controls keep compact dimensions across modules", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    let validatedPages = 0;

    for (const targetPath of pagesToValidate) {
      const response = await page.goto(targetPath, { waitUntil: "domcontentloaded" });
      test.skip(!response || response.status() !== 200, `Page unavailable: ${targetPath}`);

      await page.waitForTimeout(120);

      const compactBoxes = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll("[data-table-controls] [data-searchable-wrapper] input[type='text']"),
        ).map((input) => {
          const rect = input.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        });
      });

      if (!compactBoxes.length) {
        continue;
      }

      validatedPages += 1;
      compactBoxes.forEach((box) => {
        expect(box.height, `height too large on ${targetPath}`).toBeLessThanOrEqual(40);
        expect(box.width, `width too large on ${targetPath}`).toBeLessThanOrEqual(180);
      });

      const pageSizeBox = await readEnhancedControlBox(page, "select[data-page-size]");
      if (pageSizeBox) {
        expect(pageSizeBox.inputWidth, `page-size width on ${targetPath}`).toBeLessThanOrEqual(110);
        expect(pageSizeBox.inputHeight, `page-size height on ${targetPath}`).toBeLessThanOrEqual(40);
      }

      const statusBox = await readEnhancedControlBox(page, "select[data-status-filter]");
      if (statusBox) {
        expect(statusBox.inputWidth, `status width on ${targetPath}`).toBeLessThanOrEqual(150);
        expect(statusBox.inputHeight, `status height on ${targetPath}`).toBeLessThanOrEqual(40);
      }

      const ratesBox = await readEnhancedControlBox(page, "select[data-rm-view]");
      if (ratesBox) {
        expect(ratesBox.inputWidth, `rates width on ${targetPath}`).toBeLessThanOrEqual(150);
        expect(ratesBox.inputHeight, `rates height on ${targetPath}`).toBeLessThanOrEqual(40);
      }
    }

    expect(validatedPages).toBeGreaterThanOrEqual(3);
  });

  test("auto translate fills Urdu field from English name", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/administration/branches", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Branches page not accessible.");

    const createButton = page.locator('button[onclick*="/administration/branches/new"]').first();
    test.skip(!(await createButton.count()), "Create branch action not available for this user.");
    await createButton.click();
    await expect(page.locator('#modal-content input[name="name"]')).toBeVisible();
    await expect(page.locator('#modal-content input[name="name_ur"]')).toBeVisible();

    await page.locator('#modal-content input[name="name"]').fill("Ali Khan Traders");

    const translateButton = page.locator('#modal-content [data-translate-button]').first();
    await expect(translateButton).toBeVisible();
    await translateButton.click();

    await expect
      .poll(async () => {
        return page.locator('#modal-content input[name="name_ur"]').inputValue();
      }, { timeout: 15000 })
      .not.toEqual("");
  });
});
