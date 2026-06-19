const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { getFirstFgVariantWithRate, closeDb } = require("./utils/db");

let fixture = null;
test.beforeAll(async () => {
  fixture = await getFirstFgVariantWithRate();
});
test.afterAll(async () => { await closeDb(); });

test("SKU toggle - diagnose network response", async ({ page }) => {
  test.skip(!fixture, "No fixture");
  await login(page, "E2E_ADMIN");
  const searchUrl = `/master-data/products/skus?item_type=FG&search=${encodeURIComponent(fixture.sku_code)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

  const toggleForm = page.locator(`form[action*="/${fixture.variant_id}/rate-editable-toggle"]`);
  await expect(toggleForm).toBeVisible({ timeout: 8000 });

  // Intercept all requests to see what happens
  const requests = [];
  const responses = [];
  page.on("request", req => requests.push({ url: req.url(), method: req.method() }));
  page.on("response", resp => responses.push({ url: resp.url(), status: resp.status() }));

  await toggleForm.locator("button[type='submit']").click();
  await page.waitForLoadState("domcontentloaded");

  console.log("=== REQUESTS ===");
  requests.forEach(r => console.log(r.method, r.url));
  console.log("=== RESPONSES ===");
  responses.forEach(r => console.log(r.status, r.url));
  console.log("=== FINAL URL ===", page.url());

  expect(true).toBe(true); // always pass
});
