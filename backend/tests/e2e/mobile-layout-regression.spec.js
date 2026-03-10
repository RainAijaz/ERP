const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const MOBILE_VIEWPORT = { width: 390, height: 844 };

const EXTRA_PATHS = [
  "/",
  "/reports/purchases",
  "/reports/financial/voucher_register",
  "/reports/financial/cash_book",
  "/vouchers/cash?new=1",
  "/vouchers/bank?new=1",
  "/vouchers/journal?new=1",
  "/vouchers/purchase?new=1",
];

const shouldCheckPath = (path) => {
  const value = String(path || "").trim();
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/auth/logout")) return false;
  if (value.startsWith("/events/")) return false;
  return true;
};

const normalizePath = (href, origin) => {
  try {
    const url = new URL(String(href || ""), origin);
    return `${url.pathname}${url.search || ""}`;
  } catch (err) {
    return "";
  }
};

test.describe("Mobile layout regressions", () => {
  test.setTimeout(6 * 60 * 1000);

  test("navigable pages should not create document-level horizontal scroll on mobile", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const origin = new URL(page.url()).origin;

    const navLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((el) => el.getAttribute("href") || "")
        .filter(Boolean);
    });

    const allPaths = Array.from(
      new Set([
        ...EXTRA_PATHS,
        ...navLinks.map((href) => normalizePath(href, origin)),
      ]),
    ).filter(shouldCheckPath);

    const failures = [];

    for (const targetPath of allPaths) {
      const response = await page.goto(targetPath, {
        waitUntil: "domcontentloaded",
      });
      if (!response) continue;
      if (response.status() >= 400) continue;

      await page.waitForTimeout(120);

      const diagnostics = await page.evaluate(() => {
        const root = document.scrollingElement || document.documentElement;
        const viewportWidth = document.documentElement.clientWidth;
        const overflowPx = Math.max(
          0,
          Math.ceil(root.scrollWidth - viewportWidth),
        );

        const intersects = (a, b) => {
          const left = Math.max(a.left, b.left);
          const right = Math.min(a.right, b.right);
          const top = Math.max(a.top, b.top);
          const bottom = Math.min(a.bottom, b.bottom);
          return right - left > 1 && bottom - top > 1;
        };

        const headerOverlaps = [];
        const rows = Array.from(document.querySelectorAll("table thead tr"));
        rows.forEach((row) => {
          const headers = Array.from(row.querySelectorAll("th"))
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return {
                text:
                  String(el.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim() || "(empty)",
                rect,
                visible:
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden",
              };
            })
            .filter((item) => item.visible);

          for (let i = 0; i < headers.length; i += 1) {
            for (let j = i + 1; j < headers.length; j += 1) {
              if (!intersects(headers[i].rect, headers[j].rect)) continue;
              headerOverlaps.push(`${headers[i].text} <> ${headers[j].text}`);
            }
          }
        });

        const overflowingTableHeaders = Array.from(
          document.querySelectorAll("th"),
        )
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              return false;
            return el.scrollWidth - el.clientWidth > 2;
          })
          .slice(0, 5)
          .map((el) => {
            const text = String(el.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
            return text || "(empty)";
          });

        return {
          overflowPx,
          overflowingTableHeaders,
          headerOverlaps: Array.from(new Set(headerOverlaps)).slice(0, 8),
        };
      });

      if (
        diagnostics.overflowPx > 2 ||
        diagnostics.overflowingTableHeaders.length > 0 ||
        diagnostics.headerOverlaps.length > 0
      ) {
        failures.push({
          path: targetPath,
          overflowPx: diagnostics.overflowPx,
          overflowingTableHeaders: diagnostics.overflowingTableHeaders,
          headerOverlaps: diagnostics.headerOverlaps,
        });
      }
    }

    const errorText = failures
      .map(
        (entry) =>
          `${entry.path} | overflow=${entry.overflowPx}px | headers=${entry.overflowingTableHeaders.join("; ") || "none"} | overlaps=${entry.headerOverlaps.join("; ") || "none"}`,
      )
      .join("\n");

    expect(
      failures,
      `Mobile layout regressions detected:\n${errorText}`,
    ).toEqual([]);
  });
});
