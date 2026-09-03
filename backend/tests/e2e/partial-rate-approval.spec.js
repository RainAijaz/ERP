const { test, expect } = require("@playwright/test");
const knex = require("../../src/db/knex");
const { login } = require("./utils/auth");
const {
  getBranch,
  getTwoDistinctUsers,
  getVariantForSkuApproval,
  createApprovalRequest,
  deleteApprovalRequests,
  setVariantSaleRate,
  closeDb,
} = require("./utils/db");

test.describe("Partial rate approval", () => {
  test.describe.configure({ mode: "serial" });

  const state = { ready: false, ids: [], branch: null, requester: null, admin: null, variant: null };

  test.beforeAll(async () => {
    state.branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
    state.variant = await getVariantForSkuApproval();
    if (!state.branch || !users || !state.variant) return;
    state.admin = users.primary;
    state.requester = users.secondary;
    state.variant.id = Number(state.variant.id);
    state.ready = true;
  });

  test.afterAll(async () => {
    await deleteApprovalRequests(state.ids);
    await closeDb();
  });

  const seedRequest = async (newValue, entityType = "SKU_BULK_RATE_UPDATE") => {
    const summary = `E2E partial rate ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const id = await createApprovalRequest({
      branch_id: state.branch.id,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: entityType,
      entity_id: entityType === "SKU_BULK_RATE_UPDATE" ? "BULK" : "ALL",
      summary,
      new_value: newValue,
      status: "PENDING",
      requested_by: state.requester.id,
      requested_at: new Date(),
    });
    state.ids.push(id);
    return { id, summary };
  };

  const csrf = async (page) => page.locator('input[name="_csrf"]').first().inputValue();

  test("administrator removes one SKU row and persists only the retained row", async ({ page }) => {
    test.skip(!state.ready, "Missing branch, users, or SKU fixture");
    const request = await seedRequest({
      _action: "bulk_rate_update",
      variants: [
        { id: state.variant.id, old_rate: state.variant.sale_rate, new_rate: Number(state.variant.sale_rate || 0) + 1 },
        { id: state.variant.id + 1, old_rate: 20, new_rate: 21 },
      ],
    });

    await login(page, "E2E_ADMIN");
    await page.goto(`/administration/approvals?status=PENDING`, { waitUntil: "domcontentloaded" });
    const requestRow = page.locator("tbody tr").filter({ hasText: request.summary });
    await expect(requestRow).toBeVisible();
    await requestRow.locator("[data-approval-view]").click();
    const modal = page.locator("[data-approval-detail-modal]");
    await expect(modal).toBeVisible();
    await modal.locator("[data-approval-edit-btn]").click();
    const rows = modal.locator("[data-approval-preview-after] [data-approval-rate-row], [data-approval-preview-single] [data-approval-rate-row]");
    await expect(rows).toHaveCount(2);
    await rows.nth(1).locator("[data-approval-row-remove]").click();
    await expect(modal.locator("[data-approval-preview-after] [data-approval-rate-row], [data-approval-preview-single] [data-approval-rate-row]")).toHaveCount(1);
    await expect.poll(async () => modal.locator("[data-approval-preview-after] [data-approval-rate-row], [data-approval-preview-single] [data-approval-rate-row]").first().evaluate((row) => row.closest("[data-approval-preview]")?.dataset.removedRateRowIds)).toContain(String(state.variant.id + 1));
    const editResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/administration/approvals/${request.id}/edit`));
    await modal.locator("[data-approval-edit-save]").click();
    const editResponse = await editResponsePromise;
    expect(editResponse.status()).toBe(200);
    const editResult = await editResponse.json();
    expect(editResult.ok).toBe(true);
    expect(editResult.changed_fields).toHaveLength(1);
    await expect(page).toHaveURL(/administration\/approvals/);

    expect(editResult.changed_fields[0].new_value).toHaveLength(1);
    expect(Number(editResult.changed_fields[0].new_value[0].id)).toBe(Number(state.variant.id));
  });

  test("administrator removes one labour-rate row and persists only the retained row", async ({ page }) => {
    test.skip(!state.ready, "Missing branch, users, or SKU fixture");
    const request = await seedRequest({
      mode: "BULK_LABOUR_RATE_SKU_UPSERT",
      labour_id: "ALL",
      rows: [
        { sku_id: state.variant.id, previous_rate: 10, new_rate: 11 },
        { sku_id: state.variant.id + 1, previous_rate: 10, new_rate: 12 },
      ],
    }, "LABOUR");

    await login(page, "E2E_ADMIN");
    await page.goto(`/administration/approvals?status=PENDING`, { waitUntil: "domcontentloaded" });
    const requestRow = page.locator("tbody tr").filter({ hasText: request.summary });
    await requestRow.locator("[data-approval-view]").click();
    const modal = page.locator("[data-approval-detail-modal]");
    await modal.locator("[data-approval-edit-btn]").click();
    const rows = modal.locator("[data-approval-preview-after] [data-approval-rate-row], [data-approval-preview-single] [data-approval-rate-row]");
    await expect(rows).toHaveCount(2);
    await rows.nth(0).locator("[data-approval-row-remove]").click();
    await expect(rows).toHaveCount(1);
    const editResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/administration/approvals/${request.id}/edit`));
    await modal.locator("[data-approval-edit-save]").click();
    const editResponse = await editResponsePromise;
    expect(editResponse.status()).toBe(200);
  });

  test("removing every rate row rejects the pending request", async ({ page }) => {
    test.skip(!state.ready, "Missing branch, users, or SKU fixture");
    const request = await seedRequest({
      _action: "bulk_rate_update",
      variants: [{ id: state.variant.id, old_rate: 10, new_rate: 11 }],
    });

    await login(page, "E2E_ADMIN");
    await page.goto(`/administration/approvals?status=PENDING`, { waitUntil: "domcontentloaded" });
    const requestRow = page.locator("tbody tr").filter({ hasText: request.summary });
    await requestRow.locator("[data-approval-view]").click();
    const modal = page.locator("[data-approval-detail-modal]");
    await modal.locator("[data-approval-edit-btn]").click();
    await modal.locator("[data-approval-preview-after] [data-approval-row-remove], [data-approval-preview-single] [data-approval-row-remove]").first().click();
    const editResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/administration/approvals/${request.id}/edit`));
    await modal.locator("[data-approval-edit-save]").click();
    const editResponse = await editResponsePromise;
    expect(editResponse.status()).toBe(200);
    expect((await editResponse.json()).cancelled).toBe(true);

    await expect.poll(async () => {
      const row = await knex("erp.approval_request").select("status").where({ id: request.id }).first();
      return row?.status;
    }).toBe("REJECTED");
  });

  test("server rejects a selected SKU row outside the original request", async ({ page }) => {
    test.skip(!state.ready, "Missing branch, users, or SKU fixture");
    const request = await seedRequest({
      _action: "bulk_rate_update",
      variants: [{ id: state.variant.id, old_rate: 10, new_rate: 11 }],
    });

    await login(page, "E2E_ADMIN");
    await page.goto(`/administration/approvals?status=PENDING`, { waitUntil: "domcontentloaded" });
    const token = await csrf(page);
    const response = await page.request.post(`/administration/approvals/${request.id}/edit`, {
      form: {
        _csrf: token,
        edited_payload: JSON.stringify({ selected_row_ids: [state.variant.id + 999999] }),
      },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).ok).toBe(false);

    const saved = await knex("erp.approval_request").select("status", "new_value").where({ id: request.id }).first();
    expect(saved.status).toBe("PENDING");
    expect(saved.new_value.variants).toHaveLength(1);
  });

  test("SKU rate approval asks before sending the WhatsApp message", async ({ page }) => {
    test.skip(!state.ready, "Missing branch, users, or SKU fixture");
    const request = await seedRequest({
      _action: "bulk_rate_update",
      send_whatsapp: true,
      variants: [{ id: state.variant.id, old_rate: 10, new_rate: 11 }],
    });

    await login(page, "E2E_ADMIN");
    await page.goto(`/administration/approvals?status=PENDING`, { waitUntil: "domcontentloaded" });
    const row = page.locator("tbody tr").filter({ hasText: request.summary });
    const form = row.locator("form[data-new-sku-approve]");
    await expect(form).toHaveCount(1);
    await expect(form.locator('input[name="send_article_rate"]')).toHaveValue("0");
    await form.locator("button[type=submit]").click();

    const dialog = page.locator("[data-new-sku-modal]");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-new-sku-send]")).toBeVisible();
    await expect(dialog.locator("[data-new-sku-approve-only]")).toBeVisible();
    await dialog.locator("[data-new-sku-cancel]").first().click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
  });

  test("SKU rate approval can choose Approve only without sending WhatsApp", async ({ page }) => {
    test.skip(!state.ready, "Missing branch, users, or SKU fixture");
    const request = await seedRequest({
      _action: "bulk_rate_update",
      send_whatsapp: false,
      variants: [{ id: state.variant.id, old_rate: 10, new_rate: 11 }],
    });

    await login(page, "E2E_ADMIN");
    await page.goto(`/administration/approvals?status=PENDING`, { waitUntil: "domcontentloaded" });
    const row = page.locator("tbody tr").filter({ hasText: request.summary });
    await row.locator("form[data-new-sku-approve] button[type=submit]").click();
    const dialog = page.locator("[data-new-sku-modal]");
    await expect(dialog).toBeVisible();

    const approveRequest = page.waitForRequest(
      (requestEvent) =>
        requestEvent.method() === "POST" &&
        requestEvent.url().endsWith(`/administration/approvals/${request.id}/approve`),
    );
    await dialog.locator("[data-new-sku-approve-only]").click();
    const posted = await approveRequest;
    expect(posted.postData() || "").toContain("send_article_rate=0");
    expect(posted.postData() || "").not.toContain("send_article_rate=1");
    await page.waitForURL(/administration\/approvals/, { timeout: 30000 });
    await setVariantSaleRate(state.variant.id, state.variant.sale_rate);
  });
});
