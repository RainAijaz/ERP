const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

// The sorting layer is loaded from head.ejs, so it executes on *every* page in
// the app, not just reports. These tests guard the blast radius rather than the
// feature: a page that stops working, a master-data list whose own sorter or
// filtering broke, or a report whose in-browser pagination fell out of step
// with the rows the sort just reordered.

const signIn = (page) => login(page, "E2E_ADMIN");

const WIDE_WINDOW =
  "load_report=1&from_date=2020-01-01&to_date=2030-12-31" +
  "&start_date=2020-01-01&end_date=2030-12-31&as_of_date=2030-12-31";

const collectErrors = (page) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  return errors;
};

test.describe("report sorting — blast radius", () => {
  // A spread of page types, not only reports: the script runs everywhere.
  const PAGES = [
    "/",
    "/master-data/parties",
    "/master-data/accounts",
    "/master-data/bom",
    "/reports/inventory/stock-balances",
    "/reports/production/control",
    "/reports/sales/sales-order-report",
    "/reports/purchases/supplier-listings",
    "/reports/sales/customer-listings",
    "/reports/hr-payroll/employee-ledger",
    "/reports/hr-payroll/commission-ledger",
    "/reports/sales/sales-discount-report",
    "/reports/production/department-wip",
    "/reports/production/department-wip-balances",
  ];

  for (const path of PAGES) {
    test(`${path} loads with no JS errors`, async ({ page }) => {
      const errors = collectErrors(page);
      await signIn(page);
      await page.goto(`${path}?${WIDE_WINDOW}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);

      // Ignore noise the app already emits (missing favicons, aborted SSE).
      const real = errors.filter(
        (e) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(e),
      );
      expect(real, `JS errors on ${path}:\n${real.join("\n")}`).toEqual([]);
      await expect(page.locator("body")).toBeVisible();
    });
  }

  test("master-data list keeps its own sorter, search and page size", async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page);
    await page.goto("/master-data/parties", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);

    // The master-data screens are driven by basic-info-utils.ejs, whose sort
    // buttons carry data-sort-index. The new layer must leave those alone.
    const legacy = page.locator("thead [data-sort-key][data-sort-index]");
    expect(await legacy.count()).toBeGreaterThan(0);
    expect(
      await page.locator("thead th[data-sortable]").count(),
      "the global layer must not bind master-data headers",
    ).toBe(0);

    const visibleNames = () =>
      page.$$eval("tbody tr[data-row]:not(.hidden) td:nth-child(2)", (tds) =>
        tds.map((td) => td.textContent.trim()),
      );

    await legacy.nth(1).click();
    await page.waitForTimeout(300);
    const asc = await visibleNames();
    await legacy.nth(1).click();
    await page.waitForTimeout(300);
    const desc = await visibleNames();
    expect(asc.length).toBeGreaterThan(1);
    expect(desc).not.toEqual(asc);

    // Search still narrows the list.
    const search = page.locator("[data-search-input], input[type='search']").first();
    if (await search.count()) {
      const before = (await visibleNames()).length;
      await search.fill(asc[0].slice(0, 4));
      await page.waitForTimeout(600);
      const after = (await visibleNames()).length;
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThanOrEqual(before);
      await search.fill("");
      await page.waitForTimeout(600);
    }

    // Page size still applies.
    const pageSize = page.locator("[data-page-size]").first();
    if (await pageSize.count()) {
      await pageSize.selectOption("10").catch(() => {});
      await page.waitForTimeout(500);
      expect((await visibleNames()).length).toBeLessThanOrEqual(10);
    }

    expect(errors.filter((e) => !/favicon|ERR_ABORTED/i.test(e))).toEqual([]);
  });

  test("sorting a paginated report keeps pagination in step", async ({ page }) => {
    await signIn(page);
    await page.goto(`/reports/sales/customer-listings?${WIDE_WINDOW}`, {
      waitUntil: "domcontentloaded",
    });
    const table = page.locator('table[data-report-sort-bound="true"]').first();
    await expect(table).toBeVisible();

    // This report paginates in the browser via basic-info-utils.ejs, which
    // pages off data-orig-index. After a sort the indexes are renumbered and
    // that layer re-pages, so the rows on screen must be the first N of the
    // new order -- not a scattered leftover of the pre-sort order.
    const shownRows = () =>
      table.evaluate((el) => {
        const rows = [];
        Array.from(el.tBodies).forEach((body) =>
          Array.from(body.rows).forEach((row) => {
            if (row.classList.contains("hidden")) return;
            if (Array.from(row.cells).some((c) => (Number(c.getAttribute("colspan")) || 1) > 1)) return;
            rows.push({
              index: Number(row.dataset.origIndex),
              text: (row.cells[1]?.textContent || "").trim(),
            });
          }),
        );
        return rows;
      });

    const th = table.locator("thead tr:last-child th[data-sortable]").nth(1);
    await th.click();
    await page.waitForTimeout(500);

    const rows = await shownRows();
    expect(rows.length).toBeGreaterThan(1);
    const indexes = rows.map((r) => r.index).filter((n) => Number.isFinite(n));
    if (indexes.length) {
      // Visible page is a contiguous run starting at the top of the new order.
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      expect(Math.min(...indexes)).toBe(0);
    }
  });

  test("reports I added group markers to still render their groups", async ({ page }) => {
    await signIn(page);
    const GROUPED = [
      "/reports/production/control",
      "/reports/production/department-wip",
      "/reports/production/department-wip-balances",
      "/reports/sales/sales-order-report",
    ];

    for (const path of GROUPED) {
      await page.goto(`${path}?${WIDE_WINDOW}`, { waitUntil: "domcontentloaded" });
      const table = page.locator('table[data-report-sort-bound="true"]').first();
      if (!(await table.count())) continue; // no data for this report locally

      const shape = await table.evaluate((el) => {
        const rows = [];
        Array.from(el.tBodies).forEach((body) =>
          Array.from(body.rows).forEach((r) => rows.push(r)),
        );
        const keyed = rows.filter((r) => r.hasAttribute("data-report-group-key"));
        return {
          headers: keyed.filter((r) => r.hasAttribute("data-report-group-header")).length,
          totals: keyed.filter((r) => r.hasAttribute("data-report-group-total")).length,
          lines: keyed.filter((r) => r.hasAttribute("data-report-group-line")).length,
        };
      });

      // Every group must carry a header and a total, or block sorting silently
      // falls back to sorting rows inside one-row groups (i.e. does nothing).
      expect(shape.headers, `${path} has no group headers`).toBeGreaterThan(0);
      expect(shape.totals, `${path} header/total mismatch`).toBe(shape.headers);
      expect(shape.lines, `${path} has no group lines`).toBeGreaterThan(0);
    }
  });
});
