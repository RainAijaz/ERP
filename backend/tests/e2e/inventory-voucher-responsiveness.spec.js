const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const LARGE_VOUCHER_NO = process.env.E2E_INVENTORY_LARGE_VOUCHER_NO || "1";

test.describe("Inventory voucher – responsiveness and Enter-key row append", () => {
  /**
   * Scenario 1: Page with many rows does not block the main thread.
   *
   * We measure the longest gap between consecutive requestAnimationFrame
   * callbacks after page load.  If the main thread is blocked by a large
   * synchronous operation the rAF gap will exceed 1 second.
   * With the chunked insertion fix each gap should stay well under 500 ms.
   */
  test("main thread stays responsive while rows load", async ({ page }) => {
    // Inject rAF gap monitor before navigation so it starts immediately
    await page.addInitScript(() => {
      window.__rafMaxGapMs = 0;
      let last = null;
      const tick = (now) => {
        if (last !== null) {
          const gap = now - last;
          if (gap > window.__rafMaxGapMs) window.__rafMaxGapMs = gap;
        }
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await login(page, "E2E_ADMIN");

    const response = await page.goto(
      `/vouchers/inventory?voucher_no=${LARGE_VOUCHER_NO}&view=1`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(
      !response || response.status() !== 200,
      `Inventory voucher #${LARGE_VOUCHER_NO} not accessible.`,
    );

    // Wait until at least one row is visible
    await expect(
      page.locator("[data-lines-body] tr[data-row-index]").first(),
    ).toBeVisible({ timeout: 10000 });

    const rowCount = await page
      .locator("[data-lines-body] tr[data-row-index]")
      .count();
    test.skip(rowCount < 1, "No rows to test.");

    // Wait for all selects to be initialized (chunked batches complete)
    await page.waitForFunction(
      () => {
        const sels = Array.from(
          document.querySelectorAll(
            "[data-lines-body] tr[data-row-index] select[data-searchable-select='true']",
          ),
        );
        return sels.length > 0 && sels.every((s) => s.dataset.searchableReady === "true");
      },
      { timeout: 20000 },
    );

    // Read the worst rAF gap recorded during the entire load
    const maxGapMs = await page.evaluate(() => window.__rafMaxGapMs);

    // Allow up to 1 000 ms (1 s) gap – anything larger means a hard freeze.
    // On a fast dev machine with the fix in place this is typically < 200 ms.
    expect(maxGapMs).toBeLessThan(1000);
  });

  /**
   * Scenario 2: Pressing Enter on the last field of the last row appends a
   * new row whose first dropdown field immediately opens on the next Enter.
   *
   * Before the fix the newly appended row was in an async rAF batch so its
   * searchable select was not yet initialised when the navigator tried to
   * focus it, meaning the second Enter had no effect on the dropdown.
   */
  test("Enter on last row appends new row with an immediately focusable dropdown", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    // Navigate to a new (blank) inventory voucher so we control the row count
    const response = await page.goto("/vouchers/inventory?new=1", {
      waitUntil: "domcontentloaded",
    });
    // Fallback: some apps don't support ?new=1; use the base path instead
    const fallback =
      !response ||
      response.status() !== 200 ||
      !(await page
        .locator("[data-lines-body] tr[data-row-index]")
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false));

    if (fallback) {
      const r2 = await page.goto("/vouchers/inventory", {
        waitUntil: "domcontentloaded",
      });
      test.skip(
        !r2 || r2.status() !== 200,
        "Inventory voucher page not accessible.",
      );
    }

    // Wait for the first (and possibly only) row
    const rows = page.locator("[data-lines-body] tr[data-row-index]");
    await expect(rows.first()).toBeVisible({ timeout: 8000 });

    // Wait until the first row's SKU/item select is enhanced
    await page.waitForFunction(
      () => {
        const firstRow = document.querySelector(
          "[data-lines-body] tr[data-row-index='0']",
        );
        if (!firstRow) return false;
        const sel = firstRow.querySelector(
          "select[data-searchable-select='true']",
        );
        return sel && sel.dataset.searchableReady === "true";
      },
      { timeout: 10000 },
    );

    // Verify the first select in row 0 has a searchable wrapper
    const firstRowFirstWrapper = page
      .locator("[data-lines-body] tr[data-row-index='0'] [data-searchable-wrapper]")
      .first();
    await expect(firstRowFirstWrapper).toBeVisible();

    // Focus the LAST field of the first row (the qty or rate number input)
    const lastInput = page
      .locator(
        "[data-lines-body] tr[data-row-index='0'] input[type='number'][data-row-field]",
      )
      .last();
    await lastInput.focus();

    const rowCountBefore = await rows.count();

    // Press Enter – this should append a new row
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(rowCountBefore + 1, { timeout: 3000 });

    const newRowIndex = rowCountBefore; // 0-based index of the new row
    const newRow = page.locator(
      `[data-lines-body] tr[data-row-index='${newRowIndex}']`,
    );
    await expect(newRow).toBeVisible({ timeout: 3000 });

    // The new row's first searchable select MUST be enhanced already
    // (last row is always initialised synchronously after the fix)
    const newRowSelectReady = await page.evaluate((idx) => {
      const tr = document.querySelector(
        `[data-lines-body] tr[data-row-index='${idx}']`,
      );
      if (!tr) return false;
      const sel = tr.querySelector("select[data-searchable-select='true']");
      return sel ? sel.dataset.searchableReady === "true" : false;
    }, newRowIndex);

    expect(newRowSelectReady).toBe(true);

    // The searchable input in the new row must be focusable
    const newRowWrapper = newRow
      .locator("[data-searchable-wrapper] input[type='text']")
      .first();
    await expect(newRowWrapper).toBeVisible({ timeout: 2000 });
  });
});
