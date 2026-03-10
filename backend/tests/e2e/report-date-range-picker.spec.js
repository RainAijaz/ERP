const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const DATE_RANGE_REPORT_PATHS = [
  "/reports/financial/account_activity_ledger",
  "/reports/sales/sales-order-report",
  "/reports/returnables/control",
  "/reports/returnables/vendor-performance",
];

async function openReportWithDateRange(page) {
  for (const path of DATE_RANGE_REPORT_PATHS) {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    const ok = !!response && response.status() === 200;
    if (!ok) continue;
    const hasInput =
      (await page.locator("[data-date-range-input]").count()) > 0;
    const hasPanel =
      (await page.locator("[data-date-range-panel]").count()) > 0;
    const hasFrom = (await page.locator("[data-from-date-hidden]").count()) > 0;
    const hasTo = (await page.locator("[data-to-date-hidden]").count()) > 0;
    if (hasInput && hasPanel && hasFrom && hasTo) return path;
  }
  return null;
}

test.describe("Report date range picker", () => {
  test("commits from/to values only on Apply", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const activePath = await openReportWithDateRange(page);
    test.skip(
      !activePath,
      "No accessible report page with shared date-range picker was found.",
    );

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");
    const applyBtn = panel.locator("[data-date-range-apply]");

    await dateInput.click();
    await expect(panel).toBeVisible();

    const fromBefore = String(await fromHidden.inputValue());
    const toBefore = String(await toHidden.inputValue());
    const month1Buttons = panel.locator(
      "[data-date-range-month-1-grid] button",
    );
    const month2Buttons = panel.locator(
      "[data-date-range-month-2-grid] button",
    );
    test.skip(
      (await month1Buttons.count()) < 1 || (await month2Buttons.count()) < 1,
      "Calendar day buttons are missing.",
    );

    const fromBtn = month1Buttons.first();
    const fromIso = String((await fromBtn.getAttribute("data-iso")) || "");
    test.skip(!fromIso, "Could not resolve a start date from left calendar.");
    await fromBtn.click();

    const toBtn = month2Buttons.first();
    const toIso = String((await toBtn.getAttribute("data-iso")) || "");
    test.skip(!toIso, "Could not resolve an end date from right calendar.");
    await toBtn.click();

    await expect(fromHidden).toHaveValue(fromBefore);
    await expect(toHidden).toHaveValue(toBefore);

    await applyBtn.click();
    await expect(fromHidden).toHaveValue(fromIso);
    await expect(toHidden).toHaveValue(toIso);
  });

  test("cancel discards in-panel edits and restores previously applied dates", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const activePath = await openReportWithDateRange(page);
    test.skip(
      !activePath,
      "No accessible report page with shared date-range picker was found.",
    );

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");
    const cancelBtn = panel.locator("[data-date-range-cancel]");

    await expect(dateInput).toBeVisible();
    await dateInput.click();
    await expect(panel).toBeVisible();

    const fromBefore = String(await fromHidden.inputValue());
    const toBefore = String(await toHidden.inputValue());

    const firstDayFrom = panel
      .locator("[data-date-range-month-1-grid] button")
      .first();
    const firstDayTo = panel
      .locator("[data-date-range-month-2-grid] button")
      .first();
    await expect(firstDayFrom).toBeVisible();
    await expect(firstDayTo).toBeVisible();

    const fromIso = await firstDayFrom.getAttribute("data-iso");
    const toIso = await firstDayTo.getAttribute("data-iso");
    test.skip(!fromIso || !toIso, "No selectable calendar day found.");

    await firstDayFrom.click();
    await firstDayTo.click();

    await expect(fromHidden).toHaveValue(fromBefore);
    await expect(toHidden).toHaveValue(toBefore);

    await cancelBtn.click();
    await expect(panel).toBeHidden();

    await expect(fromHidden).toHaveValue(fromBefore);
    await expect(toHidden).toHaveValue(toBefore);
  });

  test("outside click closes panel and discards in-panel edits", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const activePath = await openReportWithDateRange(page);
    test.skip(
      !activePath,
      "No accessible report page with shared date-range picker was found.",
    );

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");

    await dateInput.click();
    await expect(panel).toBeVisible();

    const fromBefore = String(await fromHidden.inputValue());
    const toBefore = String(await toHidden.inputValue());

    const firstDayFrom = panel
      .locator("[data-date-range-month-1-grid] button")
      .first();
    const firstDayTo = panel
      .locator("[data-date-range-month-2-grid] button")
      .first();
    await firstDayFrom.click();
    await firstDayTo.click();

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await expect(panel).toBeHidden();

    await expect(fromHidden).toHaveValue(fromBefore);
    await expect(toHidden).toHaveValue(toBefore);
  });

  test("allows re-anchoring start then selecting new end in one open session", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");

    const activePath = await openReportWithDateRange(page);
    test.skip(
      !activePath,
      "No accessible report page with shared date-range picker was found.",
    );

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");
    const month1Next = panel.locator("[data-date-range-month-1-next]");
    const applyBtn = panel.locator("[data-date-range-apply]");

    await dateInput.click();
    await expect(panel).toBeVisible();

    const toBefore = String(await toHidden.inputValue());

    let newFromIso = "";
    for (let i = 0; i < 12 && !newFromIso; i += 1) {
      const candidate = await panel
        .locator("[data-date-range-month-1-grid] button")
        .evaluateAll((nodes, lowerBound) => {
          const isos = nodes
            .map((node) => String(node.getAttribute("data-iso") || ""))
            .filter(Boolean)
            .sort();
          return isos.find((iso) => !lowerBound || iso > lowerBound) || "";
        }, toBefore);
      if (candidate) {
        newFromIso = String(candidate);
        break;
      }
      await month1Next.click();
    }

    test.skip(
      !newFromIso,
      "Could not find a new start date beyond current end date.",
    );

    const newFromBtn = panel
      .locator(
        `[data-date-range-month-1-grid] button[data-iso="${newFromIso}"]`,
      )
      .first();
    await newFromBtn.click();

    await expect(panel.locator("[data-date-range-to-display]")).toHaveText("-");

    const newToIso = await panel
      .locator("[data-date-range-month-2-grid] button")
      .evaluateAll((nodes, lowerBound) => {
        const isos = nodes
          .map((node) => String(node.getAttribute("data-iso") || ""))
          .filter(Boolean)
          .sort();
        return isos.find((iso) => iso >= lowerBound) || "";
      }, newFromIso);

    test.skip(
      !newToIso,
      "Could not find a new end date after re-anchoring start date.",
    );

    const newToBtn = panel
      .locator(`[data-date-range-month-2-grid] button[data-iso="${newToIso}"]`)
      .first();
    await newToBtn.click();
    await applyBtn.click();

    await expect(fromHidden).toHaveValue(newFromIso);
    await expect(toHidden).toHaveValue(newToIso);
  });
});
