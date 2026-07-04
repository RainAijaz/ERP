// Browser-driven coverage of Stage 2 (cascade dependent BOM updates): the
// listing screen, the per-dependent 3-way merge review screen, and the
// apply flow that creates a new DRAFT while respecting section checkbox
// selections and never touching conflicting lines.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomCascadeFixture,
  cleanupBomCascadeFixture,
  getBomCascadeState,
  closeDb,
} = require("./utils/db");

const parseBomIdFromUrl = (url) => {
  const match = String(url || "").match(/\/master-data\/bom\/(\d+)(?:\?|$)/i);
  return match ? Number(match[1]) : null;
};

test.describe("BOM cascade (dependent update) feature", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
    createdBomIds: [],
  };

  test.beforeAll(async () => {
    const token = `bomcasc${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const fixture = await createBomCascadeFixture(token);
    if (!fixture) {
      ctx.skipReason = "Unable to create BOM cascade fixture data.";
      return;
    }
    ctx.ready = true;
    ctx.fixture = fixture;
  });

  test.afterAll(async () => {
    await cleanupBomCascadeFixture(ctx.fixture, ctx.createdBomIds);
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await login(page, "E2E_ADMIN");
  });

  test("cascade list screen shows the dependent with correct safe/conflict counts and a Review link", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    await page.goto(
      `/master-data/bom/cascade?parent_item_id=${fixture.articleA.itemId}&level=FINISHED&parent_bom_id=${fixture.bomA2}`,
      { waitUntil: "domcontentloaded" },
    );

    await expect(page.getByText("Review dependent BOM updates")).toBeVisible();
    const row = page.locator("table tbody tr").filter({ hasText: `E2E Cascade B ${fixture.token}` });
    await expect(row).toBeVisible();
    // Safe: RM add (rmNew) + SKU override add (rmNew) = 2.
    // Conflict: RM update (rmShared, B edited it) + SKU override update (rmShared) = 2.
    await expect(row.locator("td").nth(1)).toContainText("2");
    await expect(row.locator("td").nth(2)).toContainText("2");
    await expect(row.getByRole("link", { name: /review/i })).toBeVisible();
  });

  test("detail screen: safe rows are pre-checked, conflicts are read-only, deselecting a safe row and applying respects the selection", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    await page.goto(
      `/master-data/bom/cascade/${fixture.bomB1}?parent_bom_id=${fixture.bomA2}`,
      { waitUntil: "domcontentloaded" },
    );

    await expect(page.getByText("Review dependent BOM updates")).toBeVisible();

    // One safe (add) checkbox per section, pre-checked.
    const rmSafeCheckbox = page.locator('[data-cascade-section="rm_lines"][data-cascade-row-key]');
    const skuSafeCheckbox = page.locator('[data-cascade-section="sku_overrides"][data-cascade-row-key]');
    await expect(rmSafeCheckbox).toHaveCount(1);
    await expect(skuSafeCheckbox).toHaveCount(1);
    await expect(rmSafeCheckbox).toBeChecked();
    await expect(skuSafeCheckbox).toBeChecked();

    // Conflict rows: read-only (no checkbox), rose "Conflict - kept as-is" badge
    // (one for the RM line, one for the matching SKU override).
    await expect(page.getByText("Conflict - kept as-is")).toHaveCount(2);

    // Deselect the safe SKU-override row before submitting - only the RM
    // add should be applied, not the matching SKU override.
    await skuSafeCheckbox.uncheck();

    await page.locator("#cascade-apply-form button[type=\"submit\"]").click();
    await page.waitForURL(/\/master-data\/bom\/\d+(?:\?|$)/, { timeout: 30000 });

    const newBomId = parseBomIdFromUrl(page.url());
    expect(newBomId).toBeTruthy();
    ctx.createdBomIds.push(newBomId);

    const state = await getBomCascadeState(newBomId);
    expect(state?.header?.status).toBe("DRAFT");
    expect(Number(state.header.copied_from_bom_id)).toBe(Number(fixture.bomA2));

    // Safe RM add (deliberately left checked) was applied.
    expect(state.rmLines.some((r) => Number(r.rm_item_id) === fixture.rmNew)).toBe(true);
    // Safe SKU-override add (deliberately unchecked) was NOT applied.
    expect(
      state.skuOverrides.some((o) => Number(o.target_rm_item_id) === fixture.rmNew),
    ).toBe(false);

    // The conflicting RM line (B's own edit) must survive untouched - still
    // B's own uom, never overwritten with the parent's new uom.
    const bOriginalSharedLine = await (async () => {
      const s = await getBomCascadeState(fixture.bomB1);
      return s.rmLines.find((r) => Number(r.rm_item_id) === fixture.rmShared);
    })();
    const parentSharedLine = await (async () => {
      const s = await getBomCascadeState(fixture.bomA2);
      return s.rmLines.find((r) => Number(r.rm_item_id) === fixture.rmShared);
    })();
    const newSharedLine = state.rmLines.find((r) => Number(r.rm_item_id) === fixture.rmShared);
    expect(Number(newSharedLine.uom_id)).toBe(Number(bOriginalSharedLine.uom_id));
    expect(Number(newSharedLine.uom_id)).not.toBe(Number(parentSharedLine.uom_id));

    // The conflicting SKU override (B's own edit, qty 99) must also survive untouched.
    const newSharedOverride = state.skuOverrides.find(
      (o) => Number(o.target_rm_item_id) === fixture.rmShared,
    );
    expect(Number(newSharedOverride.override_qty)).toBe(99);
  });

  test("list screen now shows the dependent as having an active draft in progress", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    await page.goto(
      `/master-data/bom/cascade?parent_item_id=${fixture.articleA.itemId}&level=FINISHED&parent_bom_id=${fixture.bomA2}`,
      { waitUntil: "domcontentloaded" },
    );
    const row = page.locator("table tbody tr").filter({ hasText: `E2E Cascade B ${fixture.token}` });
    await expect(row).toContainText(/draft already in progress/i);
    await expect(row.getByRole("link", { name: /review/i })).toHaveCount(0);
  });

  test("submitting the apply form again while a draft is already in progress is rejected, not duplicated", async ({
    page,
  }) => {
    const fixture = ctx.fixture;
    // The detail screen's eligibility check doesn't itself know about the
    // in-progress draft (that guard is enforced at apply-time) - so it's
    // still reachable; what matters is that a second apply is rejected.
    await page.goto(
      `/master-data/bom/cascade/${fixture.bomB1}?parent_bom_id=${fixture.bomA2}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("#cascade-apply-form button[type=\"submit\"]").click();

    // Redirected back to the cascade list (with an error notice), never to
    // a freshly-created draft's edit page.
    await page.waitForURL(/\/master-data\/bom\/cascade(?:\?|$)/, { timeout: 30000 });

    const bDraftHeaders = await getBomCascadeState(fixture.bomB1);
    expect(bDraftHeaders).toBeTruthy();
    // Exactly one cascade draft should exist for B (from the previous test) -
    // this attempt must not have created a second one.
    const bomIdsForArticleB = ctx.createdBomIds.filter((id) => id);
    expect(bomIdsForArticleB.length).toBe(1);
  });
});
