const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

// Regression test for the SKU list PDF export, which silently did nothing.
// Root cause: the SKU page renders one <table>/<thead> per item group
// inside [data-table-body], but buildExportTable() in basic-info-utils.ejs
// read `thead th` across the WHOLE document, so headers were multiplied by
// the number of groups and desynced from each row's actual <td> count.
// jsPDF's autoTable then had to lay out a huge, mostly-empty grid, which
// hung the main thread long enough that no file ever downloaded and no
// error was ever thrown/caught.
test.describe("SKU list PDF export", () => {
  test("Download > PDF produces a real PDF file without hanging", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/master-data/products/skus?item_type=FG", {
      waitUntil: "domcontentloaded",
    });

    const downloadButton = page.locator("[data-download-button]");
    test.skip(
      !(await downloadButton.isVisible().catch(() => false)),
      "Download button not visible for this user/permissions.",
    );

    // Need at least one SKU group rendered so the multi-table bug can occur.
    const groupCount = await page.locator(".sku-group-block").count();
    test.skip(groupCount < 2, "Need at least 2 SKU groups to reproduce the multi-table export bug.");

    await downloadButton.click();
    const pdfOption = page.getByRole("button", { name: /^pdf$/i });
    await expect(pdfOption).toBeVisible();

    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await pdfOption.click();
    const download = await downloadPromise;

    expect(String(download.suggestedFilename() || "").toLowerCase()).toMatch(/\.pdf$/);

    const pdfPath = await download.path();
    expect(pdfPath).toBeTruthy();
    const fs = require("fs");
    const stats = fs.statSync(pdfPath);
    expect(stats.size).toBeGreaterThan(500);

    const header = fs.readFileSync(pdfPath, { encoding: "latin1", flag: "r" }).slice(0, 5);
    expect(header).toBe("%PDF-");
  });

  test("the real buildExportTable/autoTable call uses one group's header row, not all of them", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/master-data/products/skus?item_type=FG", {
      waitUntil: "domcontentloaded",
    });

    const groupCount = await page.locator(".sku-group-block").count();
    test.skip(groupCount < 2, "Need at least 2 SKU groups to reproduce the multi-table export bug.");

    // Preload the real vendor libs the app itself uses, then monkey-patch
    // autoTable so we can inspect exactly what the app's own buildExportTable()
    // handed to jsPDF - this exercises the actual production code path
    // instead of re-implementing the selector logic in the test.
    await page.addScriptTag({ url: "/vendor/jspdf.umd.min.js" });
    await page.addScriptTag({ url: "/vendor/jspdf.plugin.autotable.min.js" });
    await page.evaluate(() => {
      window.__capturedAutoTableHead = null;
      const proto = window.jspdf.jsPDF.API;
      const original = proto.autoTable;
      proto.autoTable = function patchedAutoTable(opts) {
        window.__capturedAutoTableHead = (opts && opts.head && opts.head[0]) || null;
        return original.call(this, opts);
      };
    });

    const downloadButton = page.locator("[data-download-button]");
    await downloadButton.click();
    const pdfOption = page.getByRole("button", { name: /^pdf$/i });
    await expect(pdfOption).toBeVisible();

    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await pdfOption.click();
    await downloadPromise;

    const rowCellCount = await page.locator("[data-row]").first().locator("td").count();
    const capturedHead = await page.evaluate(() => window.__capturedAutoTableHead);

    expect(capturedHead).not.toBeNull();
    // Real column count for the FG view (#, sku_code, size, grade, color,
    // packing, pair_rate, dozen_rate) is rowCellCount - 1 (Actions column
    // excluded). Before the fix this was that number multiplied by the SKU
    // group count instead.
    expect(capturedHead.length).toBe(rowCellCount - 1);
  });
});
