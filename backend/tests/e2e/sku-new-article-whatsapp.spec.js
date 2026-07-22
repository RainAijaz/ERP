const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getTwoDistinctUsers,
  getVariantForSkuApproval,
  createApprovalRequest,
  deleteApprovalRequests,
  findVariantsBySaleRate,
  createThrowawayColor,
  deleteColorById,
  deleteVariantCascadeById,
  closeDb,
} = require("./utils/db");

// Verifies the "new article" WhatsApp confirm-dialog feature:
//  - Approving a NEW-article SKU create opens a confirm dialog (the admin is asked)
//  - "Send & Approve" posts send_article_rate=1; "Approve only" posts 0
//  - A plain rate-EDIT SKU approval still submits directly with no dialog (regression)
//
// The server under test should run with WHATSAPP_CLIENT_DISABLED=1 so the rate
// notifier never delivers a real message; these tests assert the posted flag and
// the applied DB effect, not real WhatsApp delivery.
test.describe("New-article SKU WhatsApp approval dialog", () => {
  test.describe.configure({ mode: "serial" });

  // Distinctive marker rates so the variant produced by an approved create can be
  // found and cleaned up (variants have no unique attribute tuple to match on).
  const MARKER_SEND = 91234.11;
  const MARKER_APPROVE_ONLY = 91234.22;

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    otherUserId: null,
    variant: null,
    throwawayColorIds: [],
    ids: {
      createCancel: null,
      createSend: null,
      createApproveOnly: null,
      rateEdit: null,
    },
    createdApprovalIds: [],
  };

  // colorId defaults to the source variant's color. The two creates that must
  // actually apply pass the throwaway color id so their attribute tuple is unique
  // (ux_variants_identity) and the approval doesn't collide with an existing row.
  const seedCreate = async ({ saleRate, summary, colorId }) =>
    createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: "NEW",
      summary,
      new_value: {
        _action: "create",
        item_id: ctx.variant.item_id,
        size_id: ctx.variant.size_id,
        grade_id: ctx.variant.grade_id,
        color_id: colorId != null ? colorId : ctx.variant.color_id,
        packing_type_id: ctx.variant.packing_type_id,
        sale_rate: saleRate,
      },
      status: "PENDING",
      requested_by: ctx.otherUserId,
      requested_at: new Date(),
    });

  test.beforeAll(async () => {
    const branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
    const variant = await getVariantForSkuApproval();
    if (!branch || !users || !variant) {
      ctx.skipReason = `Missing branch/users/variant. hasBranch=${Boolean(branch)} hasUsers=${Boolean(users)} hasVariant=${Boolean(variant)}`;
      return;
    }
    ctx.ready = true;
    ctx.branchId = branch.id;
    ctx.otherUserId = users.secondary.id;
    ctx.variant = variant;
    // Two distinct throwaway colors so each applied create gets its own unique
    // attribute tuple (ux_variants_identity) and neither collides with the other.
    const stamp = Date.now();
    const colorSend = await createThrowawayColor(`E2E WA Color S ${stamp}`);
    const colorApproveOnly = await createThrowawayColor(`E2E WA Color A ${stamp}`);
    ctx.throwawayColorIds = [colorSend, colorApproveOnly];

    ctx.ids.createCancel = await seedCreate({
      saleRate: 555.5,
      summary: "New Variant: E2E Cancel Flow",
    });
    ctx.ids.createSend = await seedCreate({
      saleRate: MARKER_SEND,
      summary: "New Variant: E2E Send And Approve",
      colorId: colorSend,
    });
    ctx.ids.createApproveOnly = await seedCreate({
      saleRate: MARKER_APPROVE_ONLY,
      summary: "New Variant: E2E Approve Only",
      colorId: colorApproveOnly,
    });
    ctx.ids.rateEdit = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: String(variant.id),
      summary: "Edit SKUs E2E Regression",
      new_value: { _action: "update", sale_rate: Number(variant.sale_rate || 0) + 3 },
      status: "PENDING",
      requested_by: ctx.otherUserId,
      requested_at: new Date(),
    });

    ctx.createdApprovalIds.push(
      ctx.ids.createCancel,
      ctx.ids.createSend,
      ctx.ids.createApproveOnly,
      ctx.ids.rateEdit,
    );
  });

  test.afterAll(async () => {
    await deleteApprovalRequests(ctx.createdApprovalIds.filter(Boolean));
    // Remove any variants an approved create produced (found by marker rate)
    // before the throwaway color they reference (variants.color_id FK).
    for (const rate of [MARKER_SEND, MARKER_APPROVE_ONLY]) {
      const ids = await findVariantsBySaleRate(rate);
      for (const id of ids) await deleteVariantCascadeById(id);
    }
    for (const colorId of ctx.throwawayColorIds) await deleteColorById(colorId);
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    await login(page, "E2E_ADMIN");
  });

  const gotoPending = (page) =>
    page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });

  const rowFor = (page, id) =>
    page.locator(`tbody tr:has(form[action$="/${id}/approve"])`).first();

  test("new-article SKU approve form carries the dialog hook and a default-off flag", async ({ page }) => {
    await gotoPending(page);
    const form = rowFor(page, ctx.ids.createCancel).locator("form[data-new-sku-approve]");
    await expect(form).toHaveCount(1);
    const hidden = form.locator('input[name="send_article_rate"]');
    await expect(hidden).toHaveValue("0");
  });

  test("clicking Approve opens the confirm dialog and does not approve until confirmed", async ({ page }) => {
    await gotoPending(page);
    const row = rowFor(page, ctx.ids.createCancel);
    await row.locator("form[data-new-sku-approve] button[type=submit]").click();

    const dialog = page.locator("[data-new-sku-modal]");
    await expect(dialog).toBeVisible();
    // The row must still be here — nothing was submitted yet.
    await expect(row).toBeVisible();

    // Cancel closes the dialog and leaves the request pending.
    await dialog.locator("[data-new-sku-cancel]").click();
    await expect(dialog).toBeHidden();
    await expect(rowFor(page, ctx.ids.createCancel)).toBeVisible();
  });

  test("'Send & Approve' posts send_article_rate=1 and applies the create", async ({ page }) => {
    await gotoPending(page);
    const row = rowFor(page, ctx.ids.createSend);
    await row.locator("form[data-new-sku-approve] button[type=submit]").click();

    const dialog = page.locator("[data-new-sku-modal]");
    await expect(dialog).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.method() === "POST" &&
          req.url().includes(`/${ctx.ids.createSend}/approve`),
      ),
      dialog.locator("[data-new-sku-send]").click(),
    ]);
    expect(request.postData() || "").toContain("send_article_rate=1");

    const toast = page.locator("[data-ui-notice-toast]").first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/approved/i);

    // The create actually applied: a variant with the marker rate now exists.
    const created = await findVariantsBySaleRate(MARKER_SEND);
    expect(created.length).toBeGreaterThan(0);
  });

  test("'Approve only' posts send_article_rate=0 and still applies the create", async ({ page }) => {
    await gotoPending(page);
    const row = rowFor(page, ctx.ids.createApproveOnly);
    await row.locator("form[data-new-sku-approve] button[type=submit]").click();

    const dialog = page.locator("[data-new-sku-modal]");
    await expect(dialog).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.method() === "POST" &&
          req.url().includes(`/${ctx.ids.createApproveOnly}/approve`),
      ),
      dialog.locator("[data-new-sku-approve-only]").click(),
    ]);
    const body = request.postData() || "";
    expect(body).toContain("send_article_rate=0");
    expect(body).not.toContain("send_article_rate=1");

    const toast = page.locator("[data-ui-notice-toast]").first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/approved/i);

    const created = await findVariantsBySaleRate(MARKER_APPROVE_ONLY);
    expect(created.length).toBeGreaterThan(0);
  });

  test("rate-EDIT SKU approval submits directly with no confirm dialog", async ({ page }) => {
    await gotoPending(page);
    const row = rowFor(page, ctx.ids.rateEdit);
    // Edit rows must not carry the dialog hook at all.
    await expect(row.locator("form[data-new-sku-approve]")).toHaveCount(0);

    await Promise.all([
      page.waitForURL(/approvals/i, { timeout: 30000 }),
      row.locator(`form[action$="/${ctx.ids.rateEdit}/approve"] button`).click(),
    ]);
    // No dialog should ever have appeared.
    await expect(page.locator("[data-new-sku-modal]")).toBeHidden();

    const toast = page.locator("[data-ui-notice-toast]").first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/approved/i);
  });
});
