const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getUserByUsername,
  getMaxSkuId,
  createApprovalRequest,
  deleteApprovalRequests,
  closeDb,
} = require("./utils/db");

// A bulk labour-rate approval payload carries EVERY sku in the requested scope,
// with new_rate backfilled to previous_rate for the ones the requester never
// touched (backend/src/routes/hr-payroll/labours.js). Before this fix the
// approver saw one undifferentiated wall of rows and could not tell which rates
// were actually being changed. These specs pin the reviewer-facing behaviour:
// changed rows are highlighted, and the grid defaults to showing only those.
//
// The fixtures deliberately omit `article_type` so the preview route's
// enrichLabourRateRowsFromScope() early-returns and the seeded previous/new
// rates are rendered verbatim — the rendering logic is what is under test, not
// the live-rate re-lookup.
test.describe("Labour rate approval - changed rows", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    createdIds: [],
    mixedSummary: "",
    noopSummary: "",
    sku: {},
  };

  const buildRow = (skuId, code, name, previousRate, newRate) => ({
    sku_id: skuId,
    sku_code: code,
    item_name: name,
    previous_rate: previousRate,
    new_rate: newRate,
    subgroup_id: null,
    group_id: null,
  });

  const seedRequest = async ({ branchId, userId, summary, rows }) =>
    createApprovalRequest({
      branch_id: branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "LABOUR",
      entity_id: "ALL",
      summary,
      new_value: {
        mode: "BULK_LABOUR_RATE_SKU_UPSERT",
        labour_id: "ALL",
        dept_id: null,
        apply_on: "SKU",
        rate_type: "PER_PAIR",
        status: "ACTIVE",
        rows,
      },
      status: "PENDING",
      requested_by: userId,
      requested_at: new Date(),
    });

  test.beforeAll(async () => {
    const branch = await getBranch();
    const user = await getUserByUsername(process.env.E2E_ADMIN_USER);
    if (!branch || !user) {
      ctx.skipReason = `Missing fixture data. hasBranch=${Boolean(branch)} hasUser=${Boolean(user)}`;
      return;
    }

    // Beyond every real sku/variant id, so hydrateSkuRows() cannot rewrite the
    // codes and names this spec asserts on.
    const base = (await getMaxSkuId()) + 1000;
    const stamp = Date.now();
    ctx.sku = {
      untouched: { id: base + 1, code: `E2E-RATE-A-${stamp}`, name: "E2E Rate Alpha" },
      raised: { id: base + 2, code: `E2E-RATE-B-${stamp}`, name: "E2E Rate Bravo" },
      lowered: { id: base + 3, code: `E2E-RATE-C-${stamp}`, name: "E2E Rate Charlie" },
      firstRate: { id: base + 4, code: `E2E-RATE-D-${stamp}`, name: "E2E Rate Delta" },
      untouched2: { id: base + 5, code: `E2E-RATE-E-${stamp}`, name: "E2E Rate Echo" },
    };

    ctx.mixedSummary = `Add Labour Rates - E2E Mixed ${stamp}`;
    ctx.noopSummary = `Add Labour Rates - E2E Noop ${stamp}`;

    const mixedRows = [
      buildRow(ctx.sku.untouched.id, ctx.sku.untouched.code, ctx.sku.untouched.name, 10, 10),
      buildRow(ctx.sku.raised.id, ctx.sku.raised.code, ctx.sku.raised.name, 10, 12.5),
      buildRow(ctx.sku.lowered.id, ctx.sku.lowered.code, ctx.sku.lowered.name, 15, 9),
      buildRow(ctx.sku.firstRate.id, ctx.sku.firstRate.code, ctx.sku.firstRate.name, null, 8),
      // "10.00" vs 10 — the string/number drift a real jsonb payload produces
      // must still read as unchanged.
      buildRow(ctx.sku.untouched2.id, ctx.sku.untouched2.code, ctx.sku.untouched2.name, "7.00", 7),
    ];
    const noopRows = [
      buildRow(ctx.sku.untouched.id, ctx.sku.untouched.code, ctx.sku.untouched.name, 10, 10),
      buildRow(ctx.sku.raised.id, ctx.sku.raised.code, ctx.sku.raised.name, 12.5, "12.50"),
    ];

    const mixedId = await seedRequest({
      branchId: branch.id,
      userId: user.id,
      summary: ctx.mixedSummary,
      rows: mixedRows,
    });
    const noopId = await seedRequest({
      branchId: branch.id,
      userId: user.id,
      summary: ctx.noopSummary,
      rows: noopRows,
    });

    ctx.createdIds = [mixedId, noopId].filter(Boolean);
    if (ctx.createdIds.length !== 2) {
      ctx.skipReason = "Could not seed both labour-rate approval fixtures.";
      return;
    }
    ctx.ready = true;
  });

  test.afterAll(async () => {
    await deleteApprovalRequests(ctx.createdIds);
    await closeDb();
  });

  const openRequest = async (page, summary) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    const row = page.locator("tbody tr").filter({ hasText: summary });
    await expect(row).toHaveCount(1);
    await row.locator("[data-approval-view]").click();

    const panel = page.locator("[data-labour-rate-bulk-panel]:visible");
    await expect(panel).toBeVisible();
    return panel;
  };

  const visibleRows = (panel) => panel.locator("[data-labour-rate-bulk-body] tr");

  test("only the rates that actually change are listed, and they are highlighted", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    const panel = await openRequest(page, ctx.mixedSummary);

    // 3 of the 5 scope rows are real edits.
    await expect(panel.locator("[data-labour-rate-bulk-summary]")).toHaveText(
      "3 of 5 rates changing",
    );

    const rows = visibleRows(panel);
    await expect(rows).toHaveCount(3);
    await expect(panel.getByText(ctx.sku.raised.code)).toBeVisible();
    await expect(panel.getByText(ctx.sku.lowered.code)).toBeVisible();
    await expect(panel.getByText(ctx.sku.firstRate.code)).toBeVisible();
    // The untouched rows are the whole point: they must not be in the way.
    await expect(panel.getByText(ctx.sku.untouched.code)).toHaveCount(0);
    await expect(panel.getByText(ctx.sku.untouched2.code)).toHaveCount(0);

    const raisedRow = rows.filter({ hasText: ctx.sku.raised.code });
    await expect(raisedRow).toHaveClass(/bg-amber-50/);
    await expect(raisedRow).toContainText("12.50");
    await expect(raisedRow).toContainText("+2.50");

    const loweredRow = rows.filter({ hasText: ctx.sku.lowered.code });
    await expect(loweredRow).toHaveClass(/bg-amber-50/);
    await expect(loweredRow).toContainText("-6.00");

    const firstRateRow = rows.filter({ hasText: ctx.sku.firstRate.code });
    await expect(firstRateRow).toHaveClass(/bg-emerald-50/);
    await expect(firstRateRow).toContainText("8.00");
    await expect(firstRateRow).toContainText("New");
  });

  test("unticking 'Changed only' reveals the untouched rows, greyed out", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    const panel = await openRequest(page, ctx.mixedSummary);

    const filter = panel.locator("[data-labour-rate-changed-filter]");
    const checkbox = panel.locator("[data-labour-rate-changed-only]");
    await expect(filter).toBeVisible();
    await expect(checkbox).toBeChecked();
    // The preview disables its inputs after hydration; this control must survive.
    await expect(checkbox).toBeEnabled();

    await checkbox.uncheck();

    const rows = visibleRows(panel);
    await expect(rows).toHaveCount(5);
    const untouchedRow = rows.filter({ hasText: ctx.sku.untouched.code });
    await expect(untouchedRow).toHaveCount(1);
    await expect(untouchedRow).not.toHaveClass(/bg-amber-50|bg-emerald-50|bg-rose-50/);
    await expect(untouchedRow.locator("td").first()).toHaveClass(/text-slate-400/);
    // "7.00" vs 7 is not a change.
    await expect(rows.filter({ hasText: ctx.sku.untouched2.code })).not.toHaveClass(
      /bg-amber-50|bg-emerald-50|bg-rose-50/,
    );

    await checkbox.check();
    await expect(visibleRows(panel)).toHaveCount(3);
  });

  test("toggling the filter does not re-open or close the approval modal", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    // Regression guard: the filter must not carry data-approval-view, which a
    // document-level click handler treats as "open an approval request".
    const panel = await openRequest(page, ctx.mixedSummary);
    const checkbox = panel.locator("[data-labour-rate-changed-only]");

    await checkbox.uncheck();
    await checkbox.check();
    await checkbox.uncheck();

    await expect(page.locator("[data-approval-detail-modal]")).toBeVisible();
    await expect(panel.locator("[data-labour-rate-bulk-summary]")).toHaveText(
      "3 of 5 rates changing",
    );
    await expect(visibleRows(panel)).toHaveCount(5);
  });

  test("a request that changes nothing says so and hides the filter", async ({
    page,
  }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    const panel = await openRequest(page, ctx.noopSummary);

    await expect(panel.locator("[data-labour-rate-bulk-summary]")).toHaveText(
      "No rate changes — all 2 SKUs keep their current rate",
    );
    await expect(panel.locator("[data-labour-rate-changed-filter]")).toBeHidden();

    const rows = visibleRows(panel);
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).not.toHaveClass(/bg-amber-50|bg-emerald-50|bg-rose-50/);
  });
});
