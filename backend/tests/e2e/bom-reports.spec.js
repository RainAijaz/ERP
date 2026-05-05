const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const getDateOnly = (daysOffset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const getFirstItemId = async (page) =>
  page
    .locator('select[name="item_ids"]')
    .first()
    .evaluate((node) => {
      const options = Array.from(node?.options || []);
      const match = options.find((opt) => {
        const value = String(opt.value || "").trim();
        return value && value !== "__ALL__";
      });
      return match ? String(match.value) : "";
    });

const gotoReportAndLoad = async (page, path, params = {}) => {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/login/i);
  await expect(page.locator("h1")).toBeVisible();

  const query = new URLSearchParams({ load_report: "1", ...params });
  await page.goto(`${path}?${query.toString()}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/auth\/login/i);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Error in Bom");
};

test.describe("BOM reports smoke", () => {
  test("all BOM report screens load with DB-backed filters", async ({ page }) => {
    const fromDate = getDateOnly(-30);
    const toDate = getDateOnly(0);

    await login(page, "E2E_ADMIN");
    await page.goto("/master-data/bom/reports", { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/login/i);
    await expect(page.locator("h1")).toBeVisible();

    await page.goto("/master-data/bom/reports/version-history", {
      waitUntil: "domcontentloaded",
    });
    const firstItemId = await getFirstItemId(page);
    test.skip(!firstItemId, "No BOM item options available for BOM ledger reports.");

    await gotoReportAndLoad(page, "/master-data/bom/reports/version-history", {
      item_ids: firstItemId,
      from_date: fromDate,
      to_date: toDate,
    });

    await gotoReportAndLoad(page, "/master-data/bom/reports/lifecycle-status", {
      from_date: fromDate,
      to_date: toDate,
    });

    await gotoReportAndLoad(page, "/master-data/bom/reports/approval-queue-aging", {
      request_status: "PENDING",
      from_date: fromDate,
      to_date: toDate,
    });

    await gotoReportAndLoad(page, "/master-data/bom/reports/change-log", {
      item_ids: firstItemId,
      limit: "25",
    });

    await gotoReportAndLoad(page, "/master-data/bom/reports/cost-breakdown", {
      item_ids: firstItemId,
      explosion_mode: "DIRECT",
      valuation_mode: "WAC_FALLBACK_PURCHASE",
      labour_aggregation: "AVG",
    });

    await gotoReportAndLoad(page, "/master-data/bom/reports/cost-breakdown", {
      item_ids: firstItemId,
      explosion_mode: "EXPLODED",
      valuation_mode: "WAC_FALLBACK_PURCHASE",
      labour_aggregation: "AVG",
    });
  });
});
