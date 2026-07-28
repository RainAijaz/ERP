const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

// Regression guard for the "Created At" range filter on the product master-data
// screens. These pages render each row's created_at into data-created-at, and the
// shared client-side filter (base/partials/basic-info-utils.ejs) compares it with
// Date.parse() against the <input type="date"> values.
//
// created_at arrives from pg as a Date object, so `String(date).slice(0, 10)`
// produced "Tue Jul 28" — no year — which Date.parse() resolves to year 2001.
// Every row then sorted before any realistic start date and the list came back
// empty, i.e. the filter looked broken. The attribute must be a real local
// YYYY-MM-DD.

const PAGES = [
  { name: "SKUs (FG)", url: "/master-data/products/skus?item_type=FG" },
  { name: "SKUs (SFG)", url: "/master-data/products/skus?item_type=SFG" },
  { name: "Finished", url: "/master-data/products/finished" },
  { name: "Semi-Finished", url: "/master-data/products/semi-finished" },
  { name: "Raw Materials", url: "/master-data/products/raw-materials" },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const readRows = (page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr[data-row]"));
    return {
      all: rows.map((r) => r.dataset.createdAt || ""),
      visible: rows
        .filter((r) => !r.classList.contains("hidden"))
        .map((r) => r.dataset.createdAt || ""),
    };
  });

const goto = async (page, url, params = {}) => {
  const query = Object.entries(params)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const sep = url.includes("?") ? "&" : "?";
  // Not networkidle: these pages hold an open SSE stream for approval
  // notifications, so the network never goes idle.
  await page.goto(query ? `${url}${sep}${query}` : url, {
    waitUntil: "domcontentloaded",
  });
  // The client-side filter pass stamps data-filter-visible on each row; wait for
  // it rather than racing it.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("tr[data-row]").length === 0 ||
        document.querySelector("tr[data-row][data-filter-visible]") !== null,
      null,
      { timeout: 10000 },
    )
    .catch(() => {});
  return readRows(page);
};

test.describe("product screens: created_at range filter", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  for (const { name, url } of PAGES) {
    test(`${name} renders a parseable ISO date on every row`, async ({
      page,
    }) => {
      const { all } = await goto(page, url);
      test.skip(all.length === 0, `${name} has no rows in this database`);

      expect(all.filter((d) => d && !ISO_DATE.test(d))).toEqual([]);

      // "Tue Jul 28" parsed to 2001, which is what silently pushed every row out
      // of range. Check the parse in the real browser, not just the format.
      const years = await page.evaluate(
        (dates) => [
          ...new Set(
            dates
              .filter(Boolean)
              .map((d) => new Date(Date.parse(d)).getFullYear()),
          ),
        ],
        all,
      );
      expect(years).not.toContain(2001);
      expect(years.every((y) => y >= 2000 && y <= 2100)).toBe(true);
    });
  }

  // Behavioural check on the SKU screen the bug was reported against. Expected
  // values are derived from whatever data this database happens to hold, so the
  // test travels between machines.
  test("SKU date range keeps in-range rows and drops the rest", async ({
    page,
  }) => {
    const skuUrl = PAGES[0].url;
    const unfiltered = await goto(page, skuUrl);
    const dates = unfiltered.visible.filter(Boolean).sort();
    test.skip(dates.length === 0, "no dated SKU rows in this database");

    const min = dates[0];
    const max = dates[dates.length - 1];
    const pick = dates[Math.floor(dates.length / 2)];

    // A single day that exists in the data: only that day survives.
    const single = await goto(page, skuUrl, {
      created_at_start: pick,
      created_at_end: pick,
    });
    expect(single.visible.length).toBeGreaterThan(0);
    expect([...new Set(single.visible)]).toEqual([pick]);

    // Full span, both boundaries inclusive: nothing is lost.
    const full = await goto(page, skuUrl, {
      created_at_start: min,
      created_at_end: max,
    });
    expect(full.visible.length).toBe(unfiltered.visible.length);

    // Open-ended start only.
    const startOnly = await goto(page, skuUrl, { created_at_start: pick });
    expect(startOnly.visible.length).toBeGreaterThan(0);
    expect(startOnly.visible.every((d) => d >= pick)).toBe(true);

    // Open-ended end only.
    const endOnly = await goto(page, skuUrl, { created_at_end: pick });
    expect(endOnly.visible.length).toBeGreaterThan(0);
    expect(endOnly.visible.every((d) => d <= pick)).toBe(true);

    // startOnly and endOnly overlap exactly on `pick`, so together they account
    // for every row plus that day's rows counted twice.
    const pickCount = unfiltered.visible.filter((d) => d === pick).length;
    expect(startOnly.visible.length + endOnly.visible.length).toBe(
      unfiltered.visible.length + pickCount,
    );

    // A range entirely before the data: nothing survives.
    const empty = await goto(page, skuUrl, {
      created_at_start: "1990-01-01",
      created_at_end: "1990-12-31",
    });
    expect(empty.visible.length).toBe(0);
  });
});
