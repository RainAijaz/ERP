const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const masterDataPages = [
  "/master-data/basic-info/units",
  "/master-data/basic-info/sizes",
  "/master-data/basic-info/colors",
  "/master-data/basic-info/grades",
  "/master-data/basic-info/packing-types",
  "/master-data/basic-info/cities",
  "/master-data/basic-info/product-groups",
  "/master-data/basic-info/product-subgroups",
  "/master-data/basic-info/product-types",
  "/master-data/basic-info/sales-discount-policies",
  "/master-data/basic-info/party-groups",
  "/master-data/basic-info/account-groups",
  "/master-data/basic-info/departments",
  "/master-data/basic-info/production-stages",
  "/master-data/basic-info/uom-conversions",
  "/master-data/accounts",
  "/master-data/parties",
  "/master-data/products/finished",
  "/master-data/products/raw-materials",
  "/master-data/products/semi-finished",
  "/master-data/products/skus",
  "/master-data/assets",
  "/master-data/asset-types",
  "/master-data/bom",
];

const normalizeCsv = (value) =>
  String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();

test.describe("Master Data edit modal selection persistence", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  for (const path of masterDataPages) {
    test(`edit modal preserves selected values on ${path}`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });

      const editBtn = page.locator("[data-edit]").first();
      if ((await editBtn.count()) === 0) {
        test.skip(true, `No edit trigger found on ${path}`);
      }

      await editBtn.click();
      const modal = page.locator("[data-modal]");
      if ((await modal.count()) === 0) {
        test.skip(true, `No modal found on ${path}`);
      }
      await expect(modal).toBeVisible();

      await page.waitForTimeout(120);

      const result = await page.evaluate(() => {
        const btn = document.querySelector("[data-edit]");
        const form = document.querySelector("[data-modal-form]");
        if (!btn || !form) {
          return { skipped: true, reason: "Missing edit button or modal form", issues: [] };
        }

        const issues = [];
        const formFields = Array.from(form.querySelectorAll("[data-field]"));

        const asList = (value) =>
          String(value || "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
            .sort();

        const attrNameForField = (fieldName) => `data-${String(fieldName || "").replace(/_/g, "-")}`;

        formFields.forEach((field) => {
          const fieldName = String(field.getAttribute("data-field") || "").trim();
          if (!fieldName) return;

          const rawExpected = btn.getAttribute(attrNameForField(fieldName));
          if (rawExpected === null) return;

          if (field instanceof HTMLInputElement && field.type === "checkbox") {
            if (field.dataset.multi === "true") {
              const expectedValues = asList(rawExpected);
              const shouldBeChecked = expectedValues.includes(String(field.value || ""));
              if (field.checked !== shouldBeChecked) {
                issues.push(`checkbox:${fieldName}:${field.value}:expected-${shouldBeChecked}-got-${field.checked}`);
              }
            } else {
              const expectedChecked = rawExpected === "true" || rawExpected === "1" || rawExpected === "on";
              if (field.checked !== expectedChecked) {
                issues.push(`checkbox:${fieldName}:expected-${expectedChecked}-got-${field.checked}`);
              }
            }
            return;
          }

          if (field instanceof HTMLSelectElement && field.multiple) {
            const expectedValues = asList(rawExpected);
            const selectedValues = Array.from(field.selectedOptions).map((opt) => String(opt.value || "")).sort();
            if (expectedValues.join("|") !== selectedValues.join("|")) {
              issues.push(`multiselect:${fieldName}:expected-${expectedValues.join(",")}-got-${selectedValues.join(",")}`);
            }
            return;
          }

          if (field instanceof HTMLInputElement && field.type === "radio") {
            if (field.checked && String(field.value || "") !== String(rawExpected || "")) {
              issues.push(`radio:${fieldName}:expected-${rawExpected}-got-${field.value}`);
            }
            return;
          }

          const actualValue = String(field.value || "");
          if (actualValue !== String(rawExpected || "")) {
            issues.push(`field:${fieldName}:expected-${rawExpected}-got-${actualValue}`);
          }
        });

        return { skipped: false, reason: "", issues };
      });

      if (result.skipped) {
        test.skip(true, `${path}: ${result.reason}`);
      }

      expect(result.issues, `${path} mismatches:\n${result.issues.join("\n")}`).toEqual([]);

      const multiselects = page.locator("[data-modal-form] select[multiple]");
      const multiselectCount = await multiselects.count();
      for (let i = 0; i < multiselectCount; i += 1) {
        const select = multiselects.nth(i);
        const selected = await select.evaluate((node) =>
          Array.from(node.selectedOptions).map((opt) => String(opt.value || "")),
        );
        const expectedRaw = await select.evaluate((node) => {
          const name = node.getAttribute("data-field");
          if (!name) return null;
          const btn = document.querySelector("[data-edit]");
          if (!btn) return null;
          const attr = `data-${String(name).replace(/_/g, "-")}`;
          return btn.getAttribute(attr);
        });
        if (expectedRaw !== null) {
          expect(selected.sort()).toEqual(normalizeCsv(expectedRaw));
        }
      }
    });
  }
});
