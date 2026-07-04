// Regression coverage for bugs found and fixed during the code review of the
// "copy BOM from approved BOM" feature:
//  1. hasBomCopiedFromColumn missing `await` (not browser-observable - see
//     note at the bottom of this file).
//  2. sku_overrides copy requests silently skipped the missing_rm_line check
//     when the "rm" section wasn't also requested.
//  3. buildCopyComparison silently collapsed source SKUs that share the same
//     size/grade/color/packing, risking a wrong "copied"/"edited" verdict.
//  4. The post-approval dependents notice could report a false failure after
//     a real success (not browser-observable - see note at the bottom).
//  5. loadSkuVariantAttrs/hydrateBomSnapshotForPreview ignored locale and
//     always showed English names.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createBomCopyFixture,
  seedBomCopyPendingApproval,
  cleanupBomCopyFixture,
  closeDb,
} = require("./utils/db");

const getArticleBSkuCode = (fixture) => `E2E-CPB-${fixture.token}`;

test.describe("BOM copy feature - fixed-bug regression", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    ready: false,
    skipReason: "",
    fixture: null,
    approvalRequestId: null,
    bomBId: null,
  };

  test.beforeAll(async () => {
    const token = `bomcopy${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const fixture = await createBomCopyFixture(token);
    if (!fixture) {
      ctx.skipReason = "Unable to create BOM copy-fixes fixture data.";
      return;
    }
    ctx.fixture = fixture;
    const { bomBId, approvalRequestId } = await seedBomCopyPendingApproval(fixture);
    ctx.bomBId = bomBId;
    ctx.approvalRequestId = approvalRequestId;
    ctx.ready = true;
  });

  test.afterAll(async () => {
    await cleanupBomCopyFixture(ctx.fixture, [ctx.bomBId]);
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await login(page, "E2E_ADMIN");
  });

  test("fix #2: sku_overrides-only copy still reports missing_rm_line for a combo that doesn't exist on the source BOM", async ({
    page,
  }) => {
    const { fixture } = ctx;
    const params = new URLSearchParams({
      target_item_id: String(fixture.articleBId),
      target_level: "FINISHED",
      // Deliberately excludes "rm" - before the fix this made the
      // missing_rm_line check a no-op.
      sections: "sku_overrides",
    });
    const res = await page.request.get(
      `/master-data/bom/${fixture.bomAId}/copy-payload?${params.toString()}`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const skuOverridesReport = body.report.sku_overrides;
    expect(skuOverridesReport.total).toBe(3);
    // Only skuA1's valid (rmItemId, dept) combo can map successfully.
    expect(skuOverridesReport.copied).toBe(1);

    const skippedReasons = skuOverridesReport.skipped.map((entry) => entry.reason);
    expect(skippedReasons).toContain("missing_rm_line");
    // skuA2 shares skuA1's target sku, so its otherwise-valid combo lands on
    // the same target row second and is reported as a duplicate.
    expect(skippedReasons).toContain("duplicate_after_mapping");

    // The mapped line really is the valid-combo one, not the orphaned one.
    expect(body.lines.sku_overrides).toHaveLength(1);
    expect(Number(body.lines.sku_overrides[0].target_rm_item_id)).toBe(
      Number(fixture.rmItemId),
    );
  });

  test("fix #3: ambiguous same-variant source SKUs are not silently matched in the approval comparison", async ({
    page,
  }) => {
    const res = await page.request.get(
      `/administration/approvals/${ctx.approvalRequestId}/preview`,
    );
    expect(res.status()).toBe(200);
    const html = await res.text();

    // Sanity: this is really the BOM preview partial with our comparison
    // data attached (not a fallback/empty preview).
    expect(html).toContain("Copied from");

    // Load the fragment into a real page so we can use DOM locators instead
    // of fragile string/regex matching on raw HTML.
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);

    const skuOverrideRow = page
      .locator("div")
      .filter({ hasText: getArticleBSkuCode(ctx.fixture) })
      .last();
    await expect(skuOverrideRow).toBeVisible();

    // The genuinely ambiguous override (skuA1 and skuA2 share one variant
    // identity, so which source row it corresponds to is unknowable) must
    // NOT be labelled as resolved against either source SKU.
    await expect(skuOverrideRow).not.toContainText("Copied as-is");
    await expect(skuOverrideRow).not.toContainText("Edited after copy");
    await expect(skuOverrideRow).toContainText("New");
  });

  test("fix #5: copy report shows Urdu variant names when locale=ur, English otherwise", async ({
    page,
  }) => {
    const { fixture } = ctx;
    const baseParams = {
      target_item_id: String(fixture.articleBId),
      target_level: "FINISHED",
      sections: "sku_overrides",
    };

    const enRes = await page.request.get(
      `/master-data/bom/${fixture.bomAId}/copy-payload?${new URLSearchParams(baseParams).toString()}`,
    );
    const enBody = await enRes.json();
    const enLabels = enBody.report.sku_overrides.skipped.map((entry) => entry.label).join(" | ");
    expect(enLabels).toContain(`E2E Copy Size ${fixture.token}`);
    expect(enLabels).not.toContain(`اردو سائز ${fixture.token}`);

    const urRes = await page.request.get(
      `/master-data/bom/${fixture.bomAId}/copy-payload?${new URLSearchParams({
        ...baseParams,
        lang: "ur",
      }).toString()}`,
    );
    const urBody = await urRes.json();
    const urLabels = urBody.report.sku_overrides.skipped.map((entry) => entry.label).join(" | ");
    expect(urLabels).toContain(`اردو سائز ${fixture.token}`);
    expect(urLabels).not.toContain(`E2E Copy Size ${fixture.token}`);
  });
});

// NOTE on fixes #1 and #4 (not covered above):
//
// Fix #1 (hasBomCopiedFromColumn missing `await`) only manifests when the
// underlying `information_schema` query itself rejects (a transient DB/
// connection failure). Fix #4 (post-approval dependents-notice lookup could
// report a false failure) only manifests when listCopiedFromDependents
// throws. Both are defensive-programming fixes for a rare failure path, not
// behavior reachable by driving the real app with valid data - there is no
// browser action or API call that makes Postgres reject a schema-introspection
// query or an ordinary SELECT on demand. Proving those two fixes needs
// fault injection (e.g. temporarily stubbing knex.schema.hasColumn / the
// listCopiedFromDependents call to throw) in a unit-level test, which is a
// different test tier from Playwright's browser/HTTP-driven E2E tests.
