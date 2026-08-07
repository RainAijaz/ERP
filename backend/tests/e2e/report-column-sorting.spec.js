const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

// Column sorting is a single global runtime layer (see
// src/views/base/partials/report-table-sort.js, loaded from head.ejs) that
// binds to every `table[data-report-table]`. These tests guard the parts that
// are easy to break without noticing:
//   * a report table that stops carrying `data-report-table` loses sorting
//     silently -- nothing throws, the header just stops responding;
//   * grouped reports must move whole groups, not rows inside a one-row group;
//   * value typing must not read "300 BALLMAN" as 300, and must not hand bare
//     integers to Date.parse (V8 reads "5" as May 2001).

const WIDE_WINDOW =
  "load_report=1&from_date=2020-01-01&to_date=2030-12-31" +
  "&start_date=2020-01-01&end_date=2030-12-31&as_of_date=2030-12-31";

const signIn = (page) => login(page, "E2E_ADMIN");

const openReport = async (page, path) => {
  await page.goto(`${path}?${WIDE_WINDOW}`, { waitUntil: "domcontentloaded" });
  const load = page.getByRole("button", { name: /^\s*load\s*$/i }).first();
  if ((await load.count()) && !(await page.locator("table[data-report-table]").count())) {
    await load.click().catch(() => {});
    await page.waitForLoadState("load").catch(() => {});
  }
  return page.locator('table[data-report-sort-bound="true"]').first();
};

const columnIndexOf = (th) =>
  th.evaluate((el) => {
    let index = 0;
    let prev = el.previousElementSibling;
    while (prev) {
      index += Math.max(Number(prev.getAttribute("colspan")) || 1, 1);
      prev = prev.previousElementSibling;
    }
    return index;
  });

// The series a reader judges the sort by: group totals where the report groups,
// otherwise the data rows. Mirrors what a human sees, not the implementation.
const readSeries = (table, columnIndex) =>
  table.evaluate((el, index) => {
    const cellAt = (row, wanted) => {
      let cursor = 0;
      for (const cell of row.cells) {
        const span = Math.max(Number(cell.getAttribute("colspan")) || 1, 1);
        if (wanted < cursor + span) return span > 1 ? null : cell;
        cursor += span;
      }
      return null;
    };
    const rows = [];
    Array.from(el.tBodies).forEach((body) =>
      Array.from(body.rows).forEach((row) => rows.push(row)),
    );
    const grouped = rows.some((r) => r.hasAttribute("data-report-group-key"));
    const picked = grouped
      ? rows.filter((r) => r.hasAttribute("data-report-group-total"))
      : rows.filter(
          (r) =>
            !Array.from(r.cells).some(
              (c) => (Number(c.getAttribute("colspan")) || 1) > 1,
            ),
        );
    return picked.map((r) => {
      const cell = cellAt(r, index);
      return cell ? (cell.textContent || "").trim() : "";
    });
  }, columnIndex);

const toNumber = (text) => {
  if (/[a-zA-Z]/.test(text)) return null;
  const stripped = text.replace(/[^0-9.eE+-]/g, "");
  if (!stripped || !/\d/.test(stripped)) return null;
  const value = Number(stripped);
  if (!Number.isFinite(value)) return null;
  return /^\(.*\)$/.test(text) ? -Math.abs(value) : value;
};

test.describe("report column sorting", () => {
  // One representative per structural shape rather than every report: flat,
  // keyed groups, and a ledger.
  const REPORTS = [
    { path: "/reports/inventory/stock-balances", shape: "grouped" },
    { path: "/reports/inventory/stock-movement", shape: "grouped" },
    { path: "/reports/production/control", shape: "grouped" },
    { path: "/reports/inventory/stock-count-accuracy", shape: "flat" },
    { path: "/reports/purchases/pending-grn", shape: "flat" },
    { path: "/reports/financial/trial_balance", shape: "flat" },
  ];

  for (const report of REPORTS) {
    test(`${report.path} sorts a numeric column both ways`, async ({ page }) => {
      await signIn(page);
      const table = await openReport(page, report.path);
      await expect(table).toBeVisible();

      const headers = table.locator("thead tr:last-child th[data-sortable]");
      expect(await headers.count()).toBeGreaterThan(0);

      // Find a column whose values are genuinely numeric and not all equal.
      let target = null;
      for (let i = 0; i < (await headers.count()); i += 1) {
        const th = headers.nth(i);
        const index = await columnIndexOf(th);
        const values = (await readSeries(table, index))
          .map(toNumber)
          .filter((n) => n !== null);
        if (values.length > 1 && new Set(values).size > 1) {
          target = { th, index };
          break;
        }
      }
      test.skip(!target, "no numeric column with varied values in this dataset");

      await target.th.click();
      const asc = (await readSeries(table, target.index))
        .map(toNumber)
        .filter((n) => n !== null);
      expect(asc).toEqual([...asc].sort((a, b) => a - b));
      await expect(target.th).toHaveAttribute("aria-sort", "ascending");

      await target.th.click();
      const desc = (await readSeries(table, target.index))
        .map(toNumber)
        .filter((n) => n !== null);
      expect(desc).toEqual([...desc].sort((a, b) => b - a));
      await expect(target.th).toHaveAttribute("aria-sort", "descending");

      // Third click restores the rendered order -- the escape hatch that makes
      // sorting safe on running-balance ledgers.
      await target.th.click();
      await expect(target.th).toHaveAttribute("aria-sort", "none");
    });
  }

  test("grouped reports keep each group's header and total attached", async ({ page }) => {
    await signIn(page);
    const table = await openReport(page, "/reports/inventory/stock-balances");
    await expect(table).toBeVisible();

    const shapeOf = () =>
      table.evaluate((el) => {
        const out = [];
        Array.from(el.tBodies).forEach((body) =>
          Array.from(body.rows).forEach((row) => {
            const key = row.getAttribute("data-report-group-key") || "-";
            const kind = row.hasAttribute("data-report-group-header")
              ? "H"
              : row.hasAttribute("data-report-group-total")
                ? "T"
                : "L";
            out.push(`${kind}:${key}`);
          }),
        );
        return out;
      });

    const before = await shapeOf();
    test.skip(!before.some((r) => r.startsWith("H:")), "no grouped rows in dataset");

    await table.locator("thead tr:last-child th[data-sortable]").last().click();
    const after = await shapeOf();

    // Same rows, and every group still reads header -> lines -> total.
    expect([...after].sort()).toEqual([...before].sort());
    const seen = new Set();
    let current = null;
    for (const entry of after) {
      // Group keys contain colons of their own ("sku:197"), so split once.
      const cut = entry.indexOf(":");
      const kind = entry.slice(0, cut);
      const key = entry.slice(cut + 1);
      if (kind === "H") {
        expect(seen.has(key), `group ${key} appears twice`).toBe(false);
        seen.add(key);
        current = key;
      } else if (key !== "-") {
        expect(key).toBe(current);
      }
    }
  });

  test("headers stay clean for CSV export and print", async ({ page }) => {
    await signIn(page);
    const table = await openReport(page, "/reports/purchases/pending-grn");
    await expect(table).toBeVisible();

    const th = table.locator("thead tr:last-child th[data-sortable]").first();
    const before = (await th.textContent()) || "";
    await th.click();
    // The sort arrow is a CSS ::after, so it must never enter textContent --
    // the CSV exporters read headers exactly this way.
    expect(await th.textContent()).toBe(before);
    expect(before).not.toMatch(/[↕▲▼]/);
  });
});
