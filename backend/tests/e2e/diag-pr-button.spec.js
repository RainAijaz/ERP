const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test("diagnostic: check confirm button disabled state on new PR form", async ({ page }) => {
  await login(page, "E2E_ADMIN");
  await page.goto("/vouchers/purchase-return?new=1", { waitUntil: "domcontentloaded" });

  const submitBtn = page.locator('form[data-purchase-voucher-form] button[type="submit"]');
  const isDisabled = await submitBtn.evaluate((el) => el.disabled);
  const btnHtml = await submitBtn.evaluate((el) => el.outerHTML);
  console.log("Button disabled:", isDisabled);
  console.log("Button HTML:", btnHtml.substring(0, 300));
  expect(isDisabled).toBe(false);
});

test("diagnostic: submit PR and watch server response", async ({ page }) => {
  const responses = [];
  page.on("response", (resp) => {
    if (resp.url().includes("purchase-return")) {
      responses.push({ url: resp.url(), status: resp.status() });
    }
  });

  await login(page, "E2E_ADMIN");
  await page.goto("/vouchers/purchase-return?new=1", { waitUntil: "domcontentloaded" });

  // Fill minimal required fields
  const returnReasonOpts = await page
    .locator('select[name="return_reason"]')
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => String(o.value || "").trim()).filter(Boolean));

  if (returnReasonOpts.length) {
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);
  }

  const firstRow = page.locator("[data-lines-body] tr").first();
  const itemOpts = await firstRow
    .locator('select[data-row-field="item"]')
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => String(o.value || "").trim()).filter(Boolean));

  if (itemOpts.length) {
    await firstRow.locator('select[data-row-field="item"]').selectOption(itemOpts[0]);
    await firstRow.locator('input[data-row-field="qty"]').fill("1.000");
    await firstRow.locator('input[data-row-field="rate"]').fill("50");
  }

  await page.locator('input[name="reference_no"]').fill(`PR-DIAG-${Date.now()}`);

  // Capture the POST form data and response
  const [postResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("purchase-return") && r.request().method() === "POST"),
    page.locator('form[data-purchase-voucher-form] button[type="submit"]').click(),
  ]);

  console.log("POST response status:", postResp.status());
  console.log("POST response URL:", postResp.url());
  console.log("POST redirected to:", postResp.headers()["location"] || "(no redirect)");

  // Wait a bit more for any follow-up navigation
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  console.log("Final URL:", page.url());
  console.log("All PR responses:", JSON.stringify(responses));

  // The POST should succeed (redirect = 302/303)
  expect(postResp.status()).toBeLessThan(500);
});
