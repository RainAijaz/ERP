const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const MOBILE_VIEWPORT = { width: 390, height: 844 };

const VOUCHER_PATHS = [
  "/vouchers/cash?new=1",
  "/vouchers/bank?new=1",
  "/vouchers/journal?new=1",
  "/vouchers/purchase?new=1",
];

test.describe("Voucher mobile layout guard", () => {
  test("voucher pages should avoid page overflow and header collisions on mobile", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await login(page, "E2E_ADMIN");

    const failures = [];

    for (const path of VOUCHER_PATHS) {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      if (!response || response.status() >= 400) {
        failures.push({
          path,
          reason: `unavailable (${response ? response.status() : "no response"})`,
        });
        continue;
      }

      await page.waitForTimeout(150);

      const diagnostics = await page.evaluate(() => {
        const root = document.scrollingElement || document.documentElement;
        const viewportWidth = document.documentElement.clientWidth;
        const overflowPx = Math.max(
          0,
          Math.ceil(root.scrollWidth - viewportWidth),
        );

        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        };

        const intersects = (a, b) => {
          const left = Math.max(a.left, b.left);
          const right = Math.min(a.right, b.right);
          const top = Math.max(a.top, b.top);
          const bottom = Math.min(a.bottom, b.bottom);
          return right - left > 1 && bottom - top > 1;
        };

        const headerOverlaps = [];
        const rows = Array.from(
          document.querySelectorAll(
            "[data-lines-table] thead tr, table thead tr",
          ),
        );
        rows.forEach((row) => {
          const headers = Array.from(row.querySelectorAll("th"))
            .filter((el) => isVisible(el))
            .map((el) => ({
              text:
                String(el.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim() || "(empty)",
              rect: el.getBoundingClientRect(),
            }));

          for (let i = 0; i < headers.length; i += 1) {
            for (let j = i + 1; j < headers.length; j += 1) {
              if (!intersects(headers[i].rect, headers[j].rect)) continue;
              headerOverlaps.push(`${headers[i].text} <> ${headers[j].text}`);
            }
          }
        });

        const clippingHeaders = Array.from(
          document.querySelectorAll("[data-lines-table] th, table th"),
        )
          .filter((el) => isVisible(el) && el.scrollWidth - el.clientWidth > 2)
          .map(
            (el) =>
              String(el.textContent || "")
                .replace(/\s+/g, " ")
                .trim() || "(empty)",
          )
          .slice(0, 8);

        const tableWidthIssues = Array.from(
          document.querySelectorAll("[data-lines-table]"),
        )
          .map((table) => {
            const container =
              table.closest(".overflow-x-auto") || table.parentElement;
            if (!container) return null;
            return {
              hasHorizontalScrollContainer:
                container.classList.contains("overflow-x-auto"),
              tableScrollWidth: table.scrollWidth,
              containerClientWidth: container.clientWidth,
            };
          })
          .filter(Boolean);

        return {
          overflowPx,
          headerOverlaps: Array.from(new Set(headerOverlaps)).slice(0, 8),
          clippingHeaders,
          tableWidthIssues,
        };
      });

      const hasBadTableContainer = diagnostics.tableWidthIssues.some((item) => {
        const widerThanContainer =
          item.tableScrollWidth - item.containerClientWidth > 2;
        return widerThanContainer && !item.hasHorizontalScrollContainer;
      });

      if (
        diagnostics.overflowPx > 2 ||
        diagnostics.headerOverlaps.length > 0 ||
        diagnostics.clippingHeaders.length > 0 ||
        hasBadTableContainer
      ) {
        failures.push({
          path,
          overflowPx: diagnostics.overflowPx,
          overlaps: diagnostics.headerOverlaps,
          clipping: diagnostics.clippingHeaders,
          hasBadTableContainer,
        });
      }
    }

    const errorText = failures
      .map((f) => {
        if (f.reason) return `${f.path} | ${f.reason}`;
        return `${f.path} | overflow=${f.overflowPx}px | overlaps=${(f.overlaps || []).join("; ") || "none"} | clipping=${(f.clipping || []).join("; ") || "none"} | badTableContainer=${Boolean(f.hasBadTableContainer)}`;
      })
      .join("\n");

    expect(
      failures,
      `Voucher mobile layout regressions:\n${errorText}`,
    ).toEqual([]);
  });
});
