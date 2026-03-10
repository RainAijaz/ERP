const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const parseQty = (text) => {
  const normalized = String(text || "")
    .replace(/,/g, "")
    .trim();
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
};

const loadReport = async (page, reportType = "pending") => {
  await page.goto("/reports/sales/sales-order-report", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByRole("heading", { name: /sales order report/i }),
  ).toBeVisible();
  await expect(page.locator("[data-date-range-input]")).toBeVisible();
  await expect(page.locator('input[name="from_date"]')).toHaveAttribute(
    "type",
    "hidden",
  );
  await expect(page.locator('input[name="to_date"]')).toHaveAttribute(
    "type",
    "hidden",
  );
  await expect(page.locator('select[name="party_id"]')).toBeVisible();
  await expect(page.locator('select[name="product_id"]')).toBeVisible();
  await expect(
    page.locator('input[name="report_type"][value="pending"]'),
  ).toBeVisible();
  await expect(
    page.locator('input[name="report_type"][value="closed"]'),
  ).toBeVisible();
  await expect(
    page.locator('input[name="report_type"][value="complete"]'),
  ).toBeVisible();

  await page
    .locator(`input[name="report_type"][value="${reportType}"]`)
    .check();
  await page.getByRole("button", { name: /^load$/i }).click();

  await expect(page.locator("[data-report-table]")).toBeVisible();
};

test.describe("Sales Order Report", () => {
  test("renders filters and loads pending report", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await loadReport(page, "pending");

    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("supports report type toggles closed and complete", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    await loadReport(page, "closed");
    await expect(
      page.locator('input[name="report_type"][value="closed"]'),
    ).toBeChecked();

    await loadReport(page, "complete");
    await expect(
      page.locator('input[name="report_type"][value="complete"]'),
    ).toBeChecked();
  });

  test("keeps quantity math consistent on loaded rows", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await loadReport(page, "pending");

    const row = page.locator("[data-table-body] tr[data-row]").first();
    await expect(row).toBeVisible();

    const cellCount = await row.locator("td").count();
    if (cellCount < 14) {
      test.skip(true, "No data rows available in current dataset.");
    }

    const orderedText = await row
      .locator("td")
      .nth(cellCount - 4)
      .innerText();
    const deliveredText = await row
      .locator("td")
      .nth(cellCount - 3)
      .innerText();
    const remainingText = await row
      .locator("td")
      .nth(cellCount - 2)
      .innerText();

    const ordered = parseQty(orderedText);
    const delivered = parseQty(deliveredText);
    const remaining = parseQty(remainingText);
    const expectedRemaining = Number((ordered - delivered).toFixed(3));

    expect(Math.abs(remaining - expectedRemaining)).toBeLessThanOrEqual(0.011);
    expect(remaining).toBeGreaterThanOrEqual(-0.011);
  });
});
