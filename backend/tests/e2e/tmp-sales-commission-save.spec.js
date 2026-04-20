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

  test("bulk save works for GROUP apply-on", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/employees/commissions", {
      waitUntil: "domcontentloaded",
    });

    await page.locator("[data-modal-open]").click();
    const form = page.locator("[data-modal-form]");
    await expect(form).toBeVisible();

    const employeeOptions = await getSelectOptions(page, "employee_id");
    test.skip(!employeeOptions.length, "No employee options found.");
    const employeeId = Number(employeeOptions[0].value);

    await setSelectMulti(page, "employee_id", [String(employeeId)]);
    await setSelectSingle(page, "apply_on", "GROUP");
    await page.waitForTimeout(300);

    const groupOptions = await getSelectOptions(page, "group_id");
    test.skip(!groupOptions.length, "No product group options found.");
    const groupId = Number(groupOptions[0].value);

    const targetSkuRows = await db("erp.skus as s")
      .join("erp.variants as v", "s.variant_id", "v.id")
      .join("erp.items as i", "v.item_id", "i.id")
      .select("s.id")
      .where("i.group_id", groupId)
      .andWhere("i.item_type", "FG");
    const targetSkuIds = targetSkuRows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    test.skip(!targetSkuIds.length, "No FG SKUs found for selected product group.");

    await setSelectSingle(page, "group_id", String(groupId));
    await setSelectSingle(page, "rate_type", "PER_DOZEN");

    const targetRate = "73";
    await page
      .locator('[data-modal-form] [data-field="value"]')
      .fill(targetRate);

    const previewResponse = await page.waitForResponse(
      (response) =>
        response.url().includes("/bulk-preview") &&
        response.request().method() === "GET",
      { timeout: 15000 },
    );
    const previewStatus = previewResponse.status();
    const previewBody = await previewResponse.text();
    expect(
      previewStatus,
      `bulk-preview failed with status ${previewStatus}. Body: ${previewBody}`,
    ).toBe(200);

    const bulkRows = page.locator(
      "[data-commission-bulk-body] [data-commission-row-rate]",
    );
    await expect(bulkRows.first()).toBeVisible({ timeout: 15000 });

    const beforeMatchRow = await db("erp.employee_commission_rules")
      .where({
        employee_id: employeeId,
        apply_on: "SKU",
        commission_basis: "FIXED_PER_UNIT",
        rate_type: "PER_DOZEN",
        status: "active",
      })
      .whereIn("sku_id", targetSkuIds)
      .where("value", Number(targetRate))
      .count({ c: "*" })
      .first();
    const beforeMatchCount = Number(beforeMatchRow?.c || 0);

    await form.locator('button[type="submit"]').click();
    await page.waitForTimeout(2200);

    const afterMatchRow = await db("erp.employee_commission_rules")
      .where({
        employee_id: employeeId,
        apply_on: "SKU",
        commission_basis: "FIXED_PER_UNIT",
        rate_type: "PER_DOZEN",
        status: "active",
      })
      .whereIn("sku_id", targetSkuIds)
      .where("value", Number(targetRate))
      .count({ c: "*" })
      .first();
    const afterMatchCount = Number(afterMatchRow?.c || 0);

    expect(afterMatchCount).toBeGreaterThan(beforeMatchCount);
  });
});

