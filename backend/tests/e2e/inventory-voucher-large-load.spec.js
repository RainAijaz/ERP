const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const LARGE_VOUCHER_NO =
  process.env.E2E_INVENTORY_LARGE_VOUCHER_NO || "1";

test.describe("Inventory voucher – large row load and loading spinner", () => {
  /**
   * Scenario 1: Voucher with many rows renders without freezing.
   *
   * We verify that the batched initSearchableSelects mechanism completes —
   * every searchable select inside the rows gets data-searchable-ready="true"
   * within a reasonable timeout (15 s).  On the unpatched code this would
   * either block the main thread indefinitely or leave rows blank.
   */
  test("voucher with many rows renders all rows without freezing", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto(
      `/vouchers/inventory?voucher_no=${LARGE_VOUCHER_NO}&view=1`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(
      !response || response.status() !== 200,
      `Inventory voucher #${LARGE_VOUCHER_NO} not accessible (HTTP ${response?.status()}).`,
    );

    // At least one data row must be present in the DOM before we proceed
    const firstRow = page.locator("[data-lines-body] tr[data-row-index]").first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    const rows = page.locator("[data-lines-body] tr[data-row-index]");
    const rowCount = await rows.count();
    test.skip(
      rowCount < 1,
      `Voucher #${LARGE_VOUCHER_NO} has no rows — nothing to test.`,
    );

    // Wait until EVERY searchable <select> inside the table body has been
    // enhanced (data-searchable-ready="true").  With the batched rAF init
    // this completes in a few hundred ms even for 200 rows.  Without the
    // patch the browser would hang and either timeout or show Page-Unresponsive.
    await page.waitForFunction(
      () => {
        const selects = Array.from(
          document.querySelectorAll(
            "[data-lines-body] tr[data-row-index] select[data-searchable-select='true']",
          ),
        );
        // Must have at least one select and all must be ready
        return (
          selects.length > 0 &&
          selects.every((s) => s.dataset.searchableReady === "true")
        );
      },
      { timeout: 15000 },
    );

    // All rows must still be in the DOM (nothing was silently dropped)
    const finalCount = await rows.count();
    expect(finalCount).toBe(rowCount);

    // Every row must have been enhanced (has a searchable wrapper, not blank)
    const enhancedCount = await page
      .locator("[data-lines-body] tr[data-row-index]:has([data-searchable-wrapper])")
      .count();
    expect(enhancedCount).toBe(rowCount);

    // The last row must be visible and its row-number cell must equal rowCount
    const lastRow = rows.last();
    await expect(lastRow).toBeVisible();

    // Row-number is the last <td> in each row
    const lastRowNumberText = await lastRow.locator("td").last().textContent();
    expect(Number(lastRowNumberText?.trim() ?? "0")).toBe(rowCount);
  });

  /**
   * Scenario 2: Loading spinner appears when the Load Voucher button is clicked.
   *
   * Strategy: intercept erpLoadingOverlay.show AND trigger the click inside a
   * single page.evaluate() call so the Promise resolves synchronously (when
   * show() is called) before window.location.href destroys the JS context.
   * This avoids any timing race across the navigation boundary.
   */
  test("loading spinner appears when Load Voucher button is clicked", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto(
      `/vouchers/inventory?voucher_no=${LARGE_VOUCHER_NO}&view=1`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(
      !response || response.status() !== 200,
      `Inventory voucher page not accessible (HTTP ${response?.status()}).`,
    );

    const loadButton = page.locator("[data-load-voucher]");
    await expect(loadButton).toBeVisible();

    const hasOverlayApi = await page.evaluate(
      () => typeof window.erpLoadingOverlay?.show === "function",
    );
    test.skip(!hasOverlayApi, "erpLoadingOverlay.show not found on page.");

    // Use a different voucher number so a new HTTP request is triggered
    const differentVoucherNo = String(Number(LARGE_VOUCHER_NO) + 99999);

    // Fill the input before the evaluate block
    const voucherNoInput = page.locator("[data-voucher-no-input]");
    await voucherNoInput.fill(differentVoucherNo);

    // Wrap show() AND trigger the programmatic click inside ONE evaluate call.
    // The Promise resolves the moment show() is invoked — synchronously before
    // window.location.href fires and destroys the page JS context.
    // Playwright returns the resolved value before context teardown.
    const result = await page.evaluate((btnSelector) => {
      return new Promise((resolve, reject) => {
        const orig = window.erpLoadingOverlay.show;
        window.erpLoadingOverlay.show = function (opts) {
          const ret = orig.call(this, opts);
          // Resolve immediately – before location.href is assigned
          resolve({ showCalled: true, showContext: opts && opts.context });
          window.erpLoadingOverlay.show = orig; // restore
          return ret;
        };
        // Safety timeout if show() is never called (e.g. button disabled)
        setTimeout(
          () => reject(new Error("erpLoadingOverlay.show was not called")),
          2000,
        );
        // Trigger the click handler synchronously
        const btn = document.querySelector(btnSelector);
        if (!btn) {
          reject(new Error("Load button not found in DOM"));
        } else {
          btn.click();
        }
      });
    }, "[data-load-voucher]");

    // The show() call must have happened with the "page" context
    expect(result.showCalled).toBe(true);
    expect(result.showContext).toBe("page");

    // Navigation must complete (server may return 404 for the fake voucher #
    // but the URL change still proves the button fired window.location.href)
    await page.waitForURL(
      new RegExp(`voucher_no=${differentVoucherNo}`),
      { timeout: 15000 },
    );

    // After the new page loads the spinner must be gone
    await expect(
      page.locator("[data-global-loading-overlay='true']"),
    ).not.toBeVisible();
  });
});
