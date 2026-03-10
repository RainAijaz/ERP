const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const assertVendorSelectionPersists = async (page, reportPath) => {
  const response = await page.goto(reportPath, {
    waitUntil: "domcontentloaded",
  });
  test.skip(
    !response || response.status() !== 200,
    `Returnables report is not accessible: ${reportPath}`,
  );

  await page.waitForSelector("[data-returnables-report-form]");

  const selectedVendor = await page.evaluate(() => {
    const select = document.querySelector('select[name="vendor_ids"]');
    if (!(select instanceof HTMLSelectElement)) return null;

    const options = Array.from(select.options || []);
    const allOption = options.find(
      (opt) => String(opt.value || "") === "__ALL__",
    );
    const target = options.find((opt) => {
      const value = String(opt.value || "");
      return value && value !== "__ALL__";
    });
    if (!target) return null;

    if (allOption) allOption.selected = false;
    options.forEach((opt) => {
      if (opt !== target && String(opt.value || "") !== "__ALL__") {
        opt.selected = false;
      }
    });
    target.selected = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      value: String(target.value || ""),
      label: String(target.textContent || "").trim(),
    };
  });

  test.skip(
    !selectedVendor,
    "No selectable vendor option found (other than ALL).",
  );

  const form = page.locator("[data-returnables-report-form]");
  const loadButton = form.locator('button[type="submit"]');

  const navPromise = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 })
    .catch(() => null);

  await loadButton.click();
  await navPromise;

  const postLoadState = await page.evaluate(() => {
    const select = document.querySelector('select[name="vendor_ids"]');
    if (!(select instanceof HTMLSelectElement)) return null;
    const selectedValues = Array.from(select.selectedOptions).map((opt) =>
      String(opt.value || ""),
    );
    return {
      selectedValues,
      hasAllSelected: selectedValues.includes("__ALL__"),
    };
  });

  expect(postLoadState).not.toBeNull();
  expect(postLoadState.hasAllSelected).toBeFalsy();
  expect(postLoadState.selectedValues).toContain(selectedVendor.value);
};

const assertMultiVendorSelectionPersists = async (page, reportPath) => {
  const response = await page.goto(reportPath, {
    waitUntil: "domcontentloaded",
  });
  test.skip(
    !response || response.status() !== 200,
    `Returnables report is not accessible: ${reportPath}`,
  );

  await page.waitForSelector("[data-returnables-report-form]");

  const selectedVendors = await page.evaluate(() => {
    const select = document.querySelector('select[name="vendor_ids"]');
    if (!(select instanceof HTMLSelectElement)) return null;

    const options = Array.from(select.options || []);
    const allOption = options.find(
      (opt) => String(opt.value || "") === "__ALL__",
    );
    const targets = options.filter((opt) => {
      const value = String(opt.value || "");
      return value && value !== "__ALL__";
    });
    if (targets.length < 2) return null;

    if (allOption) allOption.selected = false;
    options.forEach((opt) => {
      opt.selected = false;
    });
    targets[0].selected = true;
    targets[1].selected = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    return [String(targets[0].value || ""), String(targets[1].value || "")];
  });

  test.skip(
    !selectedVendors || selectedVendors.length < 2,
    "Not enough vendor options to validate multi-select persistence.",
  );

  const form = page.locator("[data-returnables-report-form]");
  const loadButton = form.locator('button[type="submit"]');

  const navPromise = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 })
    .catch(() => null);

  await loadButton.click();
  await navPromise;

  const postLoadState = await page.evaluate(() => {
    const select = document.querySelector('select[name="vendor_ids"]');
    if (!(select instanceof HTMLSelectElement)) return null;
    const selectedValues = Array.from(select.selectedOptions).map((opt) =>
      String(opt.value || ""),
    );
    return {
      selectedValues,
      hasAllSelected: selectedValues.includes("__ALL__"),
    };
  });

  expect(postLoadState).not.toBeNull();
  expect(postLoadState.hasAllSelected).toBeFalsy();
  expect(postLoadState.selectedValues).toEqual(
    expect.arrayContaining(selectedVendors),
  );
};

test.describe("Returnables report filter persistence", () => {
  test("keeps non-ALL vendor selection after Load submit", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await assertVendorSelectionPersists(page, "/reports/returnables/control");
  });

  test("keeps non-ALL vendor selection after Load submit on vendor performance", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await assertVendorSelectionPersists(page, "/reports/returnables/vendor-performance");
  });

  test("keeps multi vendor selection after Load submit", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await assertMultiVendorSelectionPersists(page, "/reports/returnables/control");
  });

  test("keeps multi vendor selection after Load submit on vendor performance", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await assertMultiVendorSelectionPersists(page, "/reports/returnables/vendor-performance");
  });
});
