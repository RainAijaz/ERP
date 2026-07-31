/*
 * Per-element mobile overflow audit.
 *
 * Why this exists alongside mobile-layout-regression.spec.js: that spec (and
 * mobile-voucher-layout.spec.js) only measure document-level scrollWidth. Both
 * <html> and <body> carry `overflow-x-hidden` (base/layouts/main.ejs), so a
 * section that overruns the viewport is silently CLIPPED rather than making the
 * document scroll — the user loses content with no way to reach it, and the
 * document-level check stays green.
 *
 * This spec walks the DOM and compares each element's right edge against the
 * viewport, ignoring anything inside a deliberate horizontal scroller.
 */
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const TOLERANCE_PX = 2;

const PATHS = [
  "/",
  "/administration/approvals",
  "/vouchers/sales?new=1",
  "/vouchers/sales-order?new=1",
  "/vouchers/purchase?new=1",
  "/vouchers/goods-receipt-note?new=1",
  "/vouchers/cash?new=1",
  "/vouchers/bank?new=1",
  "/vouchers/journal?new=1",
  "/vouchers/inventory?new=1",
  "/vouchers/stock-transfer-out?new=1",
  "/vouchers/stock-count?new=1",
  "/vouchers/consumption?new=1",
  "/vouchers/returnable-dispatch?new=1",
];

// Runs in the page: report every element whose right edge exceeds the viewport
// and that is NOT inside an intentional overflow-x scroll container.
const collectOverflow = (tolerance) => {
  const vw = document.documentElement.clientWidth;
  const seen = [];

  const inScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
      p = p.parentElement;
    }
    return false;
  };

  document.querySelectorAll("body *").forEach((el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    if (style.position === "fixed") return; // toasts/modals are viewport-anchored
    // searchable-select.js keeps the native <select> in the DOM as an sr-only
    // clipped element. It still has a wide bounding box but paints nothing.
    if (el.classList.contains("sr-only")) return;
    if (style.clip === "rect(0px, 0px, 0px, 0px)") return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;

    const over = Math.round(r.right - vw);
    if (over <= tolerance) return;
    if (inScroller(el)) return;

    seen.push({
      over,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || "").slice(0, 90),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50),
    });
  });

  // Report only the outermost offender per subtree — a wide parent makes every
  // descendant look broken and buries the actual cause.
  return seen
    .sort((a, b) => b.over - a.over)
    .slice(0, 12);
};

test.describe("Mobile per-element overflow", () => {
  test.setTimeout(4 * 60 * 1000);

  test("no element overruns a 390px viewport outside an intentional scroller", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");

    const failures = [];

    for (const path of PATHS) {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      // Fail loudly on a bad path: silently skipping 404s once hid the sales
      // voucher — the most-used screen — from this entire audit.
      if (!response || response.status() >= 400) {
        failures.push(
          `${path}: unreachable (${response ? response.status() : "no response"})`,
        );
        continue;
      }

      // Let lazy charts / async line rendering settle.
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);

      const offenders = await page.evaluate(collectOverflow, TOLERANCE_PX);
      if (offenders.length) failures.push({ path, offenders });
    }

    const report = failures
      .map((f) =>
        typeof f === "string"
          ? f
          : `${f.path}\n` +
            f.offenders
              .map((o) => `    +${o.over}px  <${o.tag} class="${o.cls}"> "${o.text}"`)
              .join("\n"),
      )
      .join("\n");

    expect(failures, `Mobile overflow offenders:\n${report}`).toEqual([]);
  });

  test("voucher line entry renders as stacked cards, not a wide table", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");

    const voucherPaths = PATHS.filter((p) => p.startsWith("/vouchers/"));
    const failures = [];

    for (const path of voucherPaths) {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      // Fail loudly on a bad path: silently skipping 404s once hid the sales
      // voucher — the most-used screen — from this entire audit.
      if (!response || response.status() >= 400) {
        failures.push(
          `${path}: unreachable (${response ? response.status() : "no response"})`,
        );
        continue;
      }
      await page.waitForTimeout(1000);

      const state = await page.evaluate(() => {
        const table = document.querySelector("[data-lines-table]");
        if (!table) return null;
        const body = table.querySelector("[data-lines-body]") || table.tBodies[0];
        const firstCell = body && body.rows[0] && body.rows[0].cells[0];
        return {
          cardMode: table.hasAttribute("data-mobile-card"),
          tableWidth: Math.round(table.getBoundingClientRect().width),
          viewport: document.documentElement.clientWidth,
          rows: body ? body.rows.length : 0,
          labelled: firstCell ? firstCell.hasAttribute("data-mobile-label") : null,
          hasAddBar: Boolean(document.querySelector("[data-mobile-add-bar]")),
        };
      });

      if (!state) continue;
      if (!state.cardMode) failures.push(`${path}: card mode not applied`);
      if (state.tableWidth > state.viewport + TOLERANCE_PX) {
        failures.push(
          `${path}: table is ${state.tableWidth}px wide in a ${state.viewport}px viewport`,
        );
      }
      if (state.rows > 0 && state.labelled === false) {
        failures.push(`${path}: line cells are missing data-mobile-label`);
      }
    }

    expect(failures, `Voucher mobile card failures:\n${failures.join("\n")}`).toEqual(
      [],
    );
  });

  // The card CSS is scoped `@media screen and (max-width: 1023px)`. Without the
  // `screen and`, a narrow print rendering would also match and destroy the
  // A4-landscape gate pass laid out by the @media print rules in head.ejs.
  test("print media keeps the line table as a real table", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const onScreen = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-lines-table]")).display,
    );

    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(200);
    const printed = await page.evaluate(() => ({
      table: getComputedStyle(document.querySelector("[data-lines-table]")).display,
      thead: getComputedStyle(document.querySelector("[data-lines-table] thead")).display,
    }));

    expect(onScreen, "card mode should apply on a narrow screen").toBe("block");
    expect(printed.table, "print must keep table layout").toBe("table");
    expect(printed.thead, "print must keep column headers").not.toBe("none");
  });
});
