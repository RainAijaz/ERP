/*
 * Reports must be readable on a phone.
 *
 * Every report renders a wide table (846px–1680px) inside an `overflow-x-auto`
 * wrapper that is ~316px on a 390px phone. Before views/base/partials/
 * report-mobile-tables.js, that meant the reader saw the first column and
 * nothing else — scroll right and the figures appeared, but the item names had
 * scrolled away, so no row could be read as a whole. Stock Balances was the
 * worst case because its identity columns are the widest.
 *
 * The existing mobile specs could not catch this: mobile-layout-regression and
 * mobile-voucher-layout measure document-level scrollWidth (the wrapper scrolls
 * *itself*, so the document stays 390px), and mobile-overflow-audit skips
 * anything inside an intentional scroller — which is exactly where the report
 * tables live. This spec measures the table against the viewport instead.
 */
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const TOLERANCE_PX = 4;

// One report per shape: grouped bands + subtotals (stock), a 14-column register
// (pending GRN), a grouped <thead> (stock movement), a hierarchical statement
// (P&L), and a plain ledger-style grid (trial balance).
const REPORTS = [
  "/reports/inventory/stock-balances",
  "/reports/inventory/stock-amount",
  "/reports/inventory/stock-movement",
  "/reports/purchases/pending-grn",
  "/reports/production/control",
  "/reports/financial/trial_balance",
  "/reports/financial/profit_and_loss",
];

// Reports render nothing until Load is pressed.
const loadReport = async (page, path) => {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path}: no response`).toBeTruthy();
  expect(response.status(), `${path}: unreachable`).toBeLessThan(400);

  const load = page
    .locator('button[type="submit"]')
    .filter({ hasText: /^\s*(Load|LOAD)\s*$/ })
    .first();
  if (await load.count()) {
    await load.click();
    await page.waitForLoadState("domcontentloaded");
  }
  await page.waitForTimeout(1200);
};

const measureTables = () => {
  const vw = document.documentElement.clientWidth;
  return [...document.querySelectorAll("table")]
    .filter((table) => {
      const r = table.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    })
    .map((table) => ({
      width: Math.round(table.getBoundingClientRect().width),
      viewport: vw,
      card: table.hasAttribute("data-mobile-report-card"),
      display: getComputedStyle(table).display,
      treeGrid: table.hasAttribute("data-tree-grid"),
      // A card is only readable if its cells carry their column's label.
      labelled: [...table.querySelectorAll("tbody td")].some((td) =>
        td.hasAttribute("data-mobile-label"),
      ),
      bodyRows: table.tBodies[0] ? table.tBodies[0].rows.length : 0,
    }));
};

test.describe("Report tables on a phone", () => {
  test.setTimeout(5 * 60 * 1000);

  test("no report table is wider than the viewport", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");

    const failures = [];
    for (const path of REPORTS) {
      await loadReport(page, path);
      const tables = await page.evaluate(measureTables);

      tables.forEach((t, i) => {
        if (t.treeGrid) return; // keeps its scroller on purpose
        if (t.width > t.viewport + TOLERANCE_PX) {
          failures.push(
            `${path} table#${i}: ${t.width}px wide in a ${t.viewport}px viewport`,
          );
        }
        if (t.bodyRows > 0 && !t.card) {
          failures.push(`${path} table#${i}: card mode not applied`);
        }
        if (t.bodyRows > 0 && t.card && !t.labelled) {
          failures.push(`${path} table#${i}: cells carry no data-mobile-label`);
        }
      });
    }

    expect(failures, `Report mobile failures:\n${failures.join("\n")}`).toEqual([]);
  });

  test("desktop keeps real tables", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await login(page, "E2E_ADMIN");
    await loadReport(page, "/reports/inventory/stock-balances");

    const tables = await page.evaluate(measureTables);
    const withRows = tables.filter((t) => t.bodyRows > 0);
    expect(withRows.length, "expected a loaded report table").toBeGreaterThan(0);
    withRows.forEach((t) => {
      expect(t.card, "card mode must not apply on desktop").toBe(false);
      expect(t.display, "desktop must keep table layout").toBe("table");
    });
  });

  // The card CSS is scoped `@media screen and (max-width: 1023px)`. Without the
  // `screen and`, it would also match while printing and shred the A4 layout
  // that report-utils.ejs builds under @media print.
  test("print media keeps the report as a real table", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");
    await loadReport(page, "/reports/inventory/stock-balances");

    const onScreen = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-report-table]")).display,
    );

    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(200);
    const printed = await page.evaluate(() => ({
      table: getComputedStyle(document.querySelector("[data-report-table]")).display,
      thead: getComputedStyle(document.querySelector("[data-report-table] thead"))
        .display,
    }));
    await page.emulateMedia({ media: "screen" });

    expect(onScreen, "card mode should apply on a narrow screen").toBe("block");
    expect(printed.table, "print must keep table layout").toBe("table");
    expect(printed.thead, "print must keep column headers").not.toBe("none");
  });

  // The column labels are drawn with a CSS ::before so that they stay out of
  // textContent — which is what the CSV export and the print view read.
  test("card labels do not leak into the exported cell text", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");
    await loadReport(page, "/reports/inventory/stock-balances");

    const leaked = await page.evaluate(() => {
      const cells = [...document.querySelectorAll("[data-report-table] tbody td[data-mobile-label]")];
      return cells
        .filter((td) => {
          const label = td.getAttribute("data-mobile-label");
          return label && td.textContent.includes(label);
        })
        .map((td) => td.textContent.trim().slice(0, 40));
    });

    expect(leaked, "labels must not be part of cell text").toEqual([]);
  });
});
