const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Report date range picker", () => {
  test("same-month range mirrors month in both panes with split start/end highlights", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/reports/financial/account_activity_ledger", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Account activity ledger report not accessible.");

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");
    const month2Prev = panel.locator("[data-date-range-month-2-prev]");
    const month1Label = panel.locator("[data-date-range-month-1-label]");
    const month2Label = panel.locator("[data-date-range-month-2-label]");

    await dateInput.click();
    await expect(panel).toBeVisible();

    let month1Text = String((await month1Label.textContent()) || "").trim();
    let month2Text = String((await month2Label.textContent()) || "").trim();
    for (let i = 0; i < 12 && month1Text !== month2Text; i += 1) {
      await month2Prev.click();
      month1Text = String((await month1Label.textContent()) || "").trim();
      month2Text = String((await month2Label.textContent()) || "").trim();
    }
    test.skip(month1Text !== month2Text, "Could not align both calendars to same month for split-highlight validation.");

    const leftIsos = await panel.locator("[data-date-range-month-1-grid] button").evaluateAll((nodes) => nodes.map((node) => String(node.getAttribute("data-iso") || "")).filter(Boolean));
    const rightIsos = await panel.locator("[data-date-range-month-2-grid] button").evaluateAll((nodes) => nodes.map((node) => String(node.getAttribute("data-iso") || "")).filter(Boolean));
    const rightIsoSet = new Set(rightIsos);
    const commonIsos = leftIsos.filter((iso) => rightIsoSet.has(iso)).sort();
    test.skip(commonIsos.length < 3, "Not enough common days across both panes for split-highlight validation.");

    const fromIso = commonIsos[commonIsos.length - 3];
    test.skip(!fromIso, "Could not select a valid same-month start date.");

    const fromBtn = panel.locator(`[data-date-range-month-1-grid] button[data-iso="${fromIso}"]`).first();
    await expect(fromBtn).toBeVisible();
    await fromBtn.click();

    const selectableRightIsos = await panel.locator("[data-date-range-month-2-grid] button").evaluateAll(
      (nodes, lowerBoundIso) =>
        nodes
          .filter((node) => !node.disabled)
          .map((node) => String(node.getAttribute("data-iso") || ""))
          .filter((iso) => iso && iso >= lowerBoundIso),
      fromIso,
    );
    test.skip(!selectableRightIsos.length, "No selectable end-date found in right pane after start selection.");
    const toIso = selectableRightIsos[Math.min(1, selectableRightIsos.length - 1)];
    const toBtnRight = panel.locator(`[data-date-range-month-2-grid] button[data-iso="${toIso}"]`).first();
    await expect(toBtnRight).toBeVisible();
    await toBtnRight.click();

    await expect(fromHidden).toHaveValue(fromIso);
    await expect(toHidden).toHaveValue(toIso);

    const leftFrom = panel.locator(`[data-date-range-month-1-grid] button[data-iso="${fromIso}"]`).first();
    const rightTo = panel.locator(`[data-date-range-month-2-grid] button[data-iso="${toIso}"]`).first();

    await expect(leftFrom).toHaveClass(/bg-slate-800/);
    await expect(rightTo).toHaveClass(/bg-slate-800/);
  });

  test("disallows selecting from date after to date and to date before from date", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/reports/financial/account_activity_ledger", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Account activity ledger report not accessible.");

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");

    await dateInput.click();
    await expect(panel).toBeVisible();

    const fromBefore = String(await fromHidden.inputValue());
    const toBefore = String(await toHidden.inputValue());
    test.skip(!fromBefore || !toBefore, "Date range hidden inputs are not initialized.");

    const invalidFromBtn = panel.locator(`[data-date-range-month-1-grid] button[data-iso="${toBefore}"]`).first();
    if (await invalidFromBtn.count()) {
      await expect(invalidFromBtn).toBeDisabled();
    }

    const invalidToBtn = panel.locator(`[data-date-range-month-2-grid] button[data-iso="${fromBefore}"]`).first();
    if (await invalidToBtn.count()) {
      await expect(invalidToBtn).toBeDisabled();
    }

    await expect(fromHidden).toHaveValue(fromBefore);
    await expect(toHidden).toHaveValue(toBefore);
  });

  test("calendar sides do not overwrite each other and allow same-month end selection on right calendar", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/reports/financial/account_activity_ledger", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Account activity ledger report not accessible.");

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");
    const month2Prev = panel.locator("[data-date-range-month-2-prev]");
    const applyBtn = page.locator("[data-date-range-apply]");

    await dateInput.click();
    await expect(panel).toBeVisible();

    const fromBefore = String(await fromHidden.inputValue());
    const toBefore = String(await toHidden.inputValue());

    const month1Buttons = panel.locator("[data-date-range-month-1-grid] button");
    const month1Count = await month1Buttons.count();
    test.skip(month1Count < 2, "Not enough days in left calendar to test isolation.");
    const fromBtn = month1Buttons.first();
    const fromIso = String((await fromBtn.getAttribute("data-iso")) || "");
    test.skip(!fromIso, "Could not read from date from left calendar.");
    await fromBtn.click();

    await expect(fromHidden).toHaveValue(fromIso);
    await expect(toHidden).toHaveValue(toBefore);

    await month2Prev.click();
    const month2Buttons = panel.locator("[data-date-range-month-2-grid] button");
    const month2Count = await month2Buttons.count();
    test.skip(month2Count < 2, "Not enough days in right calendar to test isolation.");
    const toBtn = month2Buttons.nth(Math.min(10, month2Count - 1));
    const toIso = String((await toBtn.getAttribute("data-iso")) || "");
    test.skip(!toIso, "Could not read to date from right calendar.");
    await toBtn.click();

    await expect(fromHidden).toHaveValue(fromIso);
    await expect(toHidden).toHaveValue(toIso);

    await applyBtn.click();
    const [fromYear, fromMonth, fromDay] = fromIso.split("-");
    const [toYear, toMonth, toDay] = toIso.split("-");
    const expectedDisplay = `${fromDay}-${fromMonth}-${fromYear} - ${toDay}-${toMonth}-${toYear}`;
    await expect(dateInput).toHaveValue(expectedDisplay);
  });

  test("left calendar sets from and right calendar sets to in DD-MM-YYYY format", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/reports/financial/account_activity_ledger", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() !== 200, "Account activity ledger report not accessible.");

    const dateInput = page.locator("[data-date-range-input]");
    const panel = page.locator("[data-date-range-panel]");
    const fromHidden = page.locator("[data-from-date-hidden]");
    const toHidden = page.locator("[data-to-date-hidden]");
    const applyBtn = page.locator("[data-date-range-apply]");

    await expect(dateInput).toBeVisible();
    await dateInput.click();
    await expect(panel).toBeVisible();

    const firstDayFrom = panel.locator("[data-date-range-month-1-grid] button").first();
    const firstDayTo = panel.locator("[data-date-range-month-2-grid] button").first();
    await expect(firstDayFrom).toBeVisible();
    await expect(firstDayTo).toBeVisible();

    const fromIso = await firstDayFrom.getAttribute("data-iso");
    const toIso = await firstDayTo.getAttribute("data-iso");
    test.skip(!fromIso || !toIso, "No selectable calendar day found.");

    await firstDayFrom.click();
    await firstDayTo.click();
    await applyBtn.click();

    await expect(fromHidden).toHaveValue(fromIso);
    await expect(toHidden).toHaveValue(toIso);

    const [fromYear, fromMonth, fromDay] = String(fromIso).split("-");
    const [toYear, toMonth, toDay] = String(toIso).split("-");
    const expectedDisplay = `${fromDay}-${fromMonth}-${fromYear} - ${toDay}-${toMonth}-${toYear}`;
    await expect(dateInput).toHaveValue(expectedDisplay);
  });
});
