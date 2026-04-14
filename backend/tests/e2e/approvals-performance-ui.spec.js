const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getTwoDistinctUsers,
  createApprovalRequest,
  deleteApprovalRequests,
  closeDb,
} = require("./utils/db");

test.describe("Approvals performance and mobile UI regressions", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    requesterId: null,
    createdIds: [],
  };

  test.beforeAll(async () => {
    const branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);

    if (!branch || !users) {
      ctx.skipReason = "Missing branch or users for approvals e2e setup.";
      return;
    }

    ctx.ready = true;
    ctx.branchId = branch.id;
    ctx.requesterId = users.secondary.id;

    const now = Date.now();
    for (let idx = 0; idx < 30; idx += 1) {
      const id = await createApprovalRequest({
        branch_id: ctx.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: "ACCOUNT",
        entity_id: "NEW",
        summary: `Perf Pending Approval ${idx + 1}`,
        new_value: { _action: "create", name: `E2E Perf Account ${idx + 1}` },
        status: "PENDING",
        requested_by: ctx.requesterId,
        requested_at: new Date(now + idx),
      });
      if (id) ctx.createdIds.push(id);
    }
  });

  test.afterAll(async () => {
    try {
      await deleteApprovalRequests(ctx.createdIds);
    } finally {
      await closeDb();
    }
  });

  test.beforeEach(() => {
    test.skip(!ctx.ready, ctx.skipReason);
  });

  test("pending approvals table supports horizontal scroll and no inline JSON payload attrs", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });

    const tableInfo = await page.locator("table").first().evaluate((table) => {
      const wrapper = table.closest("div.overflow-x-auto");
      const firstViewButton = table.querySelector("[data-approval-view]");
      return {
        hasOverflowWrapper: Boolean(wrapper),
        wrapperOverflowX: wrapper
          ? window.getComputedStyle(wrapper).overflowX
          : "",
        tableMinWidth: window.getComputedStyle(table).minWidth,
        hasInlineOldPayload: Boolean(
          firstViewButton && firstViewButton.hasAttribute("data-old"),
        ),
        hasInlineNewPayload: Boolean(
          firstViewButton && firstViewButton.hasAttribute("data-new"),
        ),
      };
    });

    expect(tableInfo.hasOverflowWrapper).toBe(true);
    expect(["auto", "scroll"]).toContain(tableInfo.wrapperOverflowX);
    expect(tableInfo.tableMinWidth).toBe("980px");
    expect(tableInfo.hasInlineOldPayload).toBe(false);
    expect(tableInfo.hasInlineNewPayload).toBe(false);

    await page.locator("[data-approval-view]").first().click();
    await expect(page.locator("[data-approval-detail-modal]")).toBeVisible();
    await expect(page.locator("[data-approval-detail-close]")).toBeVisible();
  });

  test("pending approvals list paginates with next/prev navigation", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });

    const nextPageLink = page
      .locator('a[href*="/administration/approvals?status=PENDING&page=2"]')
      .first();
    await expect(nextPageLink).toBeVisible();
    await nextPageLink.click();
    await expect(page).toHaveURL(/status=PENDING&page=2/i);

    const prevPageLink = page
      .locator('a[href*="/administration/approvals?status=PENDING&page=1"]')
      .first();
    await expect(prevPageLink).toBeVisible();
  });
});
