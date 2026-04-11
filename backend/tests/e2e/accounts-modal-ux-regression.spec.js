const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

test.describe("Accounts modal UX regressions", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 620 });
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/master-data/accounts", {
      waitUntil: "domcontentloaded",
    });
    test.skip(!response || response.status() >= 400, "Accounts page unavailable.");
  });

  test("add modal supports vertical scrolling and clean searchable select rendering", async ({ page }) => {
    await page.locator("[data-modal-open]").first().click();

    const modalShell = page.locator("#modal-shell");
    const modalForm = page.locator("[data-modal-form]");
    await expect(modalShell).toBeVisible();
    await expect(modalForm).toBeVisible();

    const shellStyle = await modalShell.evaluate((node) => {
      const style = window.getComputedStyle(node);
      return {
        overflowY: style.overflowY,
        alignItems: style.alignItems,
      };
    });
    expect(["auto", "scroll"]).toContain(shellStyle.overflowY);

    const shellScrollState = await modalShell.evaluate((node) => {
      const canScroll = node.scrollHeight > node.clientHeight;
      const before = node.scrollTop;
      node.scrollTop = before + 160;
      return {
        canScroll,
        before,
        after: node.scrollTop,
      };
    });
    if (shellScrollState.canScroll) {
      expect(shellScrollState.after).toBeGreaterThan(shellScrollState.before);
    }

    const subgroupState = await page.evaluate(() => {
      const form = document.querySelector("[data-modal-form]");
      if (!(form instanceof HTMLElement)) {
        return { wrappers: 0, hiddenWrapped: false, hiddenSelectExists: false };
      }
      return {
        wrappers: form.querySelectorAll(
          "[data-searchable-wrapper] select[data-field='subgroup_id']",
        ).length,
        hiddenWrapped: Boolean(
          form.querySelector("[data-searchable-wrapper] [data-account-group-source]"),
        ),
        hiddenSelectExists: Boolean(form.querySelector("[data-account-group-source]")),
      };
    });

    expect(subgroupState.hiddenSelectExists).toBeTruthy();
    expect(subgroupState.wrappers).toBe(1);
    expect(subgroupState.hiddenWrapped).toBeFalsy();

    await page.locator("[data-modal-form] select[data-field='account_type']").selectOption("EXPENSE", { force: true });

    const filteredGroupCount = await page.evaluate(() => {
      const groupSelect = document.querySelector(
        "[data-modal-form] select[data-field='subgroup_id']",
      );
      if (!(groupSelect instanceof HTMLSelectElement)) return 0;
      return Array.from(groupSelect.options).filter((opt) => String(opt.value || "").trim()).length;
    });
    expect(filteredGroupCount).toBeGreaterThan(0);

    const hasAllBranchesOption = await page.evaluate(() => {
      const branchSelect = document.querySelector(
        "[data-modal-form] select[data-field='branch_ids']",
      );
      if (!(branchSelect instanceof HTMLSelectElement)) return false;
      return Array.from(branchSelect.options).some((opt) =>
        ["__all__", "all"].includes(String(opt.value || "").trim().toLowerCase()),
      );
    });
    expect(hasAllBranchesOption).toBeTruthy();
  });

  test("edit modal remains usable and not clipped at top", async ({ page }) => {
    const editButton = page.locator("[data-edit]").first();
    test.skip((await editButton.count()) === 0, "No editable account rows available.");

    await editButton.click();
    const modalShell = page.locator("#modal-shell");
    const modalPanel = page.locator("#modal-shell > div").first();

    await expect(modalShell).toBeVisible();
    await expect(modalPanel).toBeVisible();

    const box = await modalPanel.boundingBox();
    expect(box).not.toBeNull();
    expect(box.y).toBeGreaterThanOrEqual(0);

    const canReachFooter = await modalShell.evaluate((node) => {
      const saveBtn = document.querySelector("[data-modal-form] button[type='submit']");
      if (!(saveBtn instanceof HTMLElement)) return false;
      const shellRect = node.getBoundingClientRect();
      const buttonRect = saveBtn.getBoundingClientRect();
      if (buttonRect.bottom <= shellRect.bottom) return true;
      node.scrollTop = node.scrollHeight;
      const afterRect = saveBtn.getBoundingClientRect();
      return afterRect.bottom <= shellRect.bottom;
    });

    expect(canReachFooter).toBeTruthy();
  });
});
