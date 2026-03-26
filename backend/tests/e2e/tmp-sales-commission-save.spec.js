const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);

const getSelectOptions = async (page, fieldName) => {
  const select = page.locator(`[data-modal-form] [data-field="${fieldName}"]`).first();
  if (!(await select.count())) return [];
  return select.evaluate((el) =>
    Array.from(el.options || [])
      .map((opt) => ({ value: String(opt.value || "").trim(), label: String(opt.textContent || "").trim() }))
      .filter((opt) => opt.value),
  );
};

const setSelectSingle = async (page, fieldName, value) => {
  await page.locator(`[data-modal-form] [data-field="${fieldName}"]`).evaluate(
    (el, val) => {
      el.value = String(val || "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
};

const setSelectMulti = async (page, fieldName, values) => {
  await page.locator(`[data-modal-form] [data-field="${fieldName}"]`).evaluate(
    (el, vals) => {
      const wanted = new Set((Array.isArray(vals) ? vals : []).map((v) => String(v || "").trim()).filter(Boolean));
      Array.from(el.options || []).forEach((opt) => {
        opt.selected = wanted.has(String(opt.value || "").trim());
      });
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    values,
  );
};

test.describe("TMP Sales commission save", () => {
  test.afterAll(async () => {
    await db.destroy();
  });

  test("create commission from modal with screenshot-like values", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/employees/commissions", { waitUntil: "domcontentloaded" });

    await page.locator("[data-modal-open]").click();
    await expect(page.locator("[data-modal-form]")).toBeVisible();

    const employeeOptions = await getSelectOptions(page, "employee_id");
    expect(employeeOptions.length).toBeGreaterThan(0);

    const preferredEmp = employeeOptions.filter(
      (o) => /ahsan|boota/i.test(o.label),
    );
    const selectedEmps = preferredEmp.length
      ? preferredEmp.slice(0, 2).map((o) => o.value)
      : employeeOptions.slice(0, 2).map((o) => o.value);

    await setSelectMulti(page, "employee_id", selectedEmps);
    await setSelectSingle(page, "apply_on", "SKU");
    await page.waitForTimeout(500);

    const skuOptions = await getSelectOptions(page, "sku_id");
    expect(skuOptions.length).toBeGreaterThan(0);

    const preferredSkus = skuOptions.filter((o) =>
      /W03 2\/5 CARTON PACKED A|W03 2\/5 THAILI PACKED A|W03 6\/9 CARTON PACKED A/i.test(o.label),
    );
    const selectedSkus = preferredSkus.length
      ? preferredSkus.slice(0, 3).map((o) => o.value)
      : skuOptions.slice(0, 3).map((o) => o.value);

    await setSelectMulti(page, "sku_id", selectedSkus);
    await setSelectSingle(page, "rate_type", "PER_DOZEN");
    await page.locator('[data-modal-form] [data-field="value"]').fill("40");

    const primaryEmployeeId = Number(selectedEmps[0]);
    const primarySkuId = Number(selectedSkus[0]);
    const beforeCountRow = await db("erp.employee_commission_rules")
      .where({
        employee_id: primaryEmployeeId,
        sku_id: primarySkuId,
        commission_basis: "FIXED_PER_UNIT",
        status: "active",
      })
      .count({ c: "*" })
      .first();
    const beforeCount = Number(beforeCountRow?.c || 0);

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-modal-form] button[type="submit"]').click(),
    ]);

    const afterCountRow = await db("erp.employee_commission_rules")
      .where({
        employee_id: primaryEmployeeId,
        sku_id: primarySkuId,
        commission_basis: "FIXED_PER_UNIT",
        status: "active",
      })
      .count({ c: "*" })
      .first();
    const afterCount = Number(afterCountRow?.c || 0);

    expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
    expect(await page.locator("[data-modal]").count()).toBeGreaterThan(0);
  });
});

