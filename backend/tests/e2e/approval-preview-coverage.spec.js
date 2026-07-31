// Every pending approval must be viewable.
//
// The approvals modal renders whatever GET /:id/preview returns. When that
// route could not resolve an entity-specific preview it answered 204, and the
// client's only fallback was the row's old/new values -- which the View button
// never passes -- so the approver got a modal reading "No entries" and had no
// way to see what they were approving.
//
// These are the payload shapes that used to blank out, one per root cause.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  createApprovalRequest,
  deleteApprovalRequests,
  getBranch,
  getUserByUsername,
} = require("./utils/db");

const CASES = [
  {
    name: "HR labour request raised in Urdu (no _scope_key, no mode)",
    // resolveHrScopeKey used to match only English summary keywords, so any
    // request raised in Urdu resolved to no HR screen at all.
    entity_type: "LABOUR",
    entity_id: "1",
    request_type: "MASTER_DATA_CHANGE",
    summary: "[E2E-PREVIEW] مزدور کی شرح میں ترمیم",
    old_value: { rate_value: 10 },
    new_value: { rate_value: 12, dept_id: 1 },
  },
  {
    name: "HR employee request raised in Urdu",
    entity_type: "EMPLOYEE",
    entity_id: "1",
    request_type: "MASTER_DATA_CHANGE",
    summary: "[E2E-PREVIEW] ملازم میں ترمیم",
    old_value: { name: "Before" },
    new_value: { name: "After" },
  },
  {
    name: "ITEM edit whose payload carries no item_type",
    // The FG/SFG/RM branches all missed, and the resolver fell off the end.
    entity_type: "ITEM",
    entity_id: "1",
    request_type: "MASTER_DATA_CHANGE",
    summary: "[E2E-PREVIEW] Edit Item",
    old_value: { name: "Old name" },
    new_value: { name: "New name" },
  },
  {
    name: "ITEM delete (new_value holds only _action)",
    entity_type: "ITEM",
    entity_id: "1",
    request_type: "MASTER_DATA_CHANGE",
    summary: "[E2E-PREVIEW] Delete Item",
    old_value: { name: "Doomed item" },
    new_value: { _action: "delete" },
  },
  {
    name: "Registered entity type with no bespoke preview",
    // Anything in entity_type_registry can be queued; only some have a preview.
    entity_type: "STOCKCOUNTADJUSTMENT",
    entity_id: "5",
    request_type: "MASTER_DATA_CHANGE",
    summary: "[E2E-PREVIEW] Stock count adjustment",
    old_value: { qty: 1 },
    new_value: { qty: 2, reason: "recount" },
  },
  {
    name: "MASTER_DATA_IMPORT request",
    entity_type: "MASTER_DATA_IMPORT",
    entity_id: "5",
    request_type: "MASTER_DATA_CHANGE",
    summary: "[E2E-PREVIEW] Import master data",
    old_value: null,
    new_value: { targets: ["colors", "sizes"], row_count: 12 },
  },
  {
    name: "VOUCHER request with an empty payload",
    entity_type: "VOUCHER",
    entity_id: "NEW",
    request_type: "VOUCHER",
    summary: "[E2E-PREVIEW] Add CASH_VOUCHER",
    old_value: null,
    new_value: {},
  },
];

test.describe("approval preview coverage", () => {
  // Seeded once for the whole file. Both tests need these rows, so seeding
  // inside the first test would make the second silently pass against an empty
  // list whenever the first one fails.
  const seeded = [];

  test.beforeAll(async () => {
    const branch = await getBranch();
    const admin = await getUserByUsername(process.env.E2E_ADMIN_USER || "admin");
    if (!branch || !admin) {
      throw new Error("a branch and the admin user are required to seed rows");
    }

    for (const testCase of CASES) {
      const id = await createApprovalRequest({
        branch_id: branch.id,
        request_type: testCase.request_type,
        entity_type: testCase.entity_type,
        entity_id: testCase.entity_id,
        summary: testCase.summary,
        old_value: testCase.old_value,
        new_value: testCase.new_value,
        requested_by: admin.id,
        status: "PENDING",
      });
      if (!id) throw new Error(`failed to seed: ${testCase.name}`);
      seeded.push({ ...testCase, id });
    }
  });

  test.afterAll(async () => {
    await deleteApprovalRequests(seeded.map((row) => row.id));
  });

  test("every pending approval renders a readable preview for an admin", async ({
    page,
  }) => {
    expect(seeded.length, "fixtures must be seeded").toBe(CASES.length);

    await login(page, "E2E_ADMIN");

    for (const testCase of seeded) {
      await test.step(testCase.name, async () => {
        // Deep-link so the row is reachable regardless of which page of the
        // pending queue it landed on. The page auto-clicks that row's View
        // button on load, which is exactly the path being tested.
        await page.goto(
          `/administration/approvals?status=PENDING&request_id=${testCase.id}`,
          { waitUntil: "domcontentloaded" },
        );

        const trigger = page.locator(
          `[data-approval-view][data-approval-id="${testCase.id}"]`,
        );
        await expect(trigger, "the View button must exist").toHaveCount(1);

        const modal = page.locator("[data-approval-detail-modal]");
        await expect(modal).toBeVisible();

        // At least one preview panel must have been rendered by the server,
        // rather than the client falling back to an empty field list.
        const panel = modal.locator("[data-approval-preview]").first();
        await expect(panel).toBeVisible();

        // And it must actually say something. "No entries" was the old
        // symptom, so assert it is gone as well as asserting on length.
        const visibleText = (
          await modal
            .locator(
              "[data-approval-preview-before], [data-approval-preview-after], [data-approval-preview-single]",
            )
            .filter({ has: page.locator("[data-approval-preview]") })
            .first()
            .innerText()
        ).trim();
        expect(
          visibleText.length,
          `blank preview for: ${testCase.name}`,
        ).toBeGreaterThan(10);
        expect(
          visibleText.toLowerCase(),
          `preview degraded to the empty state for: ${testCase.name}`,
        ).not.toMatch(/^no entries/);

        await page.locator("[data-approval-detail-close]").click();
        await expect(modal).toBeHidden();
      });
    }
  });

  test("the preview endpoint never answers with an empty body", async ({
    page,
  }) => {
    expect(seeded.length, "fixtures must be seeded").toBe(CASES.length);

    await login(page, "E2E_ADMIN");

    for (const { id } of seeded) {
      for (const side of ["old", "new"]) {
        const response = await page.request.get(
          `/administration/approvals/${id}/preview?side=${side}`,
        );
        expect(
          response.status(),
          `preview ${id} side=${side} must not 204/error`,
        ).toBe(200);
        const body = await response.text();
        expect(
          body.trim().length,
          `preview ${id} side=${side} returned an empty body`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
