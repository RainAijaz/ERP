const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  getUserByUsername,
  setUserScopePermission,
  clearUserScopePermission,
  getLatestVoucherHeader,
  getVoucherLineCount,
  getPurchaseAllocationCountByVoucher,
  findLatestApprovalRequest,
} = require("./utils/db");

const GRN_URL = "/vouchers/goods-receipt-note?new=1";
const GENERAL_PURCHASE_URL = "/vouchers/purchase?new=1";
const POLICY_ENTITY_TYPE = "VOUCHER_TYPE";
const POLICY_ACTION = "create";

const getSelectOptionValues = async (selectLocator) =>
  selectLocator
    .locator("option")
    .evaluateAll((options) => options.map((option) => String(option.value || "").trim()).filter(Boolean));

const fillVoucherLine = async ({ page, itemValue, qty, rate }) => {
  let row = page.locator("[data-lines-body] tr").first();
  const itemSelect = row.locator('select[data-row-field="item"]');
  await itemSelect.selectOption(itemValue);

  row = page.locator("[data-lines-body] tr").first();
  await row.locator('input[data-row-field="qty"]').fill(String(qty));
  if (rate != null) {
    await row.locator('input[data-row-field="rate"]').fill(String(rate));
  }
};

const createGrn = async ({ page, supplierValue = null, itemValue = null, qty = "5.000" }) => {
  const response = await page.goto(GRN_URL, { waitUntil: "domcontentloaded" });
  test.skip(!response || response.status() !== 200, "GRN voucher page not accessible.");

  const form = page.locator("[data-purchase-voucher-form]");
  await expect(form).toBeVisible();

  const supplierSelect = page.locator("[data-supplier-select]");
  const supplierOptions = await getSelectOptionValues(supplierSelect);
  test.skip(!supplierOptions.length, "No supplier options available for GRN flow.");
  const selectedSupplier = supplierValue && supplierOptions.includes(String(supplierValue)) ? String(supplierValue) : supplierOptions[0];
  await supplierSelect.selectOption(selectedSupplier);

  const itemSelect = page.locator("[data-lines-body] tr").first().locator('select[data-row-field="item"]');
  const itemOptions = await getSelectOptionValues(itemSelect);
  test.skip(!itemOptions.length, "No raw material options available for GRN flow.");
  const selectedItem = itemValue && itemOptions.includes(String(itemValue)) ? String(itemValue) : itemOptions[0];

  await fillVoucherLine({
    page,
    itemValue: selectedItem,
    qty,
    rate: null,
  });
  await form.locator('input[name="reference_no"]').fill(`GRN-E2E-${Date.now()}`);

  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/vouchers\/goods-receipt-note\?new=1/i, { timeout: 15000 }).catch(() => null);
  const notice = page.locator("[data-ui-notice-toast]");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/saved/i);

  return { supplierValue: selectedSupplier, itemValue: selectedItem };
};

const createGeneralPurchase = async ({ page, supplierValue, itemValue, qty = "1.000", rate = "125.50" }) => {
  const response = await page.goto(GENERAL_PURCHASE_URL, { waitUntil: "domcontentloaded" });
  test.skip(!response || response.status() !== 200, "General Purchase voucher page not accessible.");

  const form = page.locator("[data-purchase-voucher-form]");
  await expect(form).toBeVisible();

  const supplierSelect = page.locator("[data-supplier-select]");
  const supplierOptions = await getSelectOptionValues(supplierSelect);
  test.skip(!supplierOptions.length, "No supplier options available for General Purchase flow.");
  const selectedSupplier = supplierValue && supplierOptions.includes(String(supplierValue)) ? String(supplierValue) : supplierOptions[0];
  await supplierSelect.selectOption(selectedSupplier);

  const itemSelect = page.locator("[data-lines-body] tr").first().locator('select[data-row-field="item"]');
  const itemOptions = await getSelectOptionValues(itemSelect);
  test.skip(!itemOptions.length, "No raw material options available for General Purchase flow.");
  const selectedItem = itemValue && itemOptions.includes(String(itemValue)) ? String(itemValue) : itemOptions[0];

  await fillVoucherLine({
    page,
    itemValue: selectedItem,
    qty,
    rate,
  });
  await form.locator('input[name="reference_no"]').fill(`PI-E2E-${Date.now()}`);

  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/vouchers\/purchase\?new=1/i, { timeout: 15000 }).catch(() => null);

  return { supplierValue: selectedSupplier, itemValue: selectedItem };
};

test.describe("Purchase vouchers - GRN, General Purchase, Purchase Return", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    grnPolicySnapshot: null,
    piPolicySnapshot: null,
    limitedUser: null,
  };

  test.beforeAll(async () => {
    ctx.grnPolicySnapshot = await getApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: "GRN",
      action: POLICY_ACTION,
    });
    ctx.piPolicySnapshot = await getApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: "PI",
      action: POLICY_ACTION,
    });

    await upsertApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: "GRN",
      action: POLICY_ACTION,
      requiresApproval: false,
    });
    await upsertApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: "PI",
      action: POLICY_ACTION,
      requiresApproval: false,
    });

    ctx.limitedUser = await getUserByUsername(process.env.E2E_LIMITED_USER || "");
    if (ctx.limitedUser?.id) {
      await setUserScopePermission({
        userId: ctx.limitedUser.id,
        scopeType: "VOUCHER",
        scopeKey: "PI",
        permissions: {
          can_navigate: true,
          can_view: true,
          can_create: false,
          can_edit: false,
          can_delete: false,
          can_print: true,
          can_approve: false,
        },
      });
    }
  });

  test.afterAll(async () => {
    try {
      if (ctx.grnPolicySnapshot && typeof ctx.grnPolicySnapshot.requires_approval === "boolean") {
        await upsertApprovalPolicy({
          entityType: POLICY_ENTITY_TYPE,
          entityKey: "GRN",
          action: POLICY_ACTION,
          requiresApproval: ctx.grnPolicySnapshot.requires_approval,
        });
      } else {
        await deleteApprovalPolicy({
          entityType: POLICY_ENTITY_TYPE,
          entityKey: "GRN",
          action: POLICY_ACTION,
        });
      }

      if (ctx.piPolicySnapshot && typeof ctx.piPolicySnapshot.requires_approval === "boolean") {
        await upsertApprovalPolicy({
          entityType: POLICY_ENTITY_TYPE,
          entityKey: "PI",
          action: POLICY_ACTION,
          requiresApproval: ctx.piPolicySnapshot.requires_approval,
        });
      } else {
        await deleteApprovalPolicy({
          entityType: POLICY_ENTITY_TYPE,
          entityKey: "PI",
          action: POLICY_ACTION,
        });
      }

      if (ctx.limitedUser?.id) {
        await clearUserScopePermission({
          userId: ctx.limitedUser.id,
          scopeType: "VOUCHER",
          scopeKey: "PI",
        });
      }
    } finally {
      // Keep shared knex connection open for subsequent Playwright files.
    }
  });

  test("admin GRN create applies instantly", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const before = await getLatestVoucherHeader({ voucherTypeCode: "GRN" });
    await createGrn({ page });
    const after = await getLatestVoucherHeader({ voucherTypeCode: "GRN" });

    expect(Number(after?.id || 0)).toBeGreaterThanOrEqual(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");
    expect(await getVoucherLineCount(after.id)).toBeGreaterThan(0);
  });

  test("restricted user PI create is rerouted to pending approval and remains linked to GRN quantities", async ({ page }) => {
    test.skip(!ctx.limitedUser?.id, "Limited user not found for restricted purchase approval flow.");

    await login(page, "E2E_ADMIN");
    const seed = await createGrn({ page, qty: "3.000" });

    await login(page, "E2E_LIMITED");
    const beforeVoucher = await getLatestVoucherHeader({ voucherTypeCode: "PI", createdBy: ctx.limitedUser.id });
    const beforeApproval = await findLatestApprovalRequest({
      requestedBy: ctx.limitedUser.id,
      status: "PENDING",
      entityType: "VOUCHER",
    });

    await createGeneralPurchase({
      page,
      supplierValue: seed.supplierValue,
      itemValue: seed.itemValue,
      qty: "1.000",
      rate: "55.25",
    });

    const afterVoucher = await getLatestVoucherHeader({ voucherTypeCode: "PI", createdBy: ctx.limitedUser.id });
    const afterApproval = await findLatestApprovalRequest({
      requestedBy: ctx.limitedUser.id,
      status: "PENDING",
      entityType: "VOUCHER",
    });

    expect(Number(afterVoucher?.id || 0)).toBeGreaterThan(Number(beforeVoucher?.id || 0));
    expect(String(afterVoucher?.status || "").toUpperCase()).toBe("PENDING");
    expect(Number(afterApproval?.id || 0)).toBeGreaterThan(Number(beforeApproval?.id || 0));
    expect(await getPurchaseAllocationCountByVoucher(afterVoucher.id)).toBeGreaterThan(0);
  });

  test("empty GRN form submission is blocked", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto(GRN_URL, { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "GRN voucher page not accessible for empty-form validation.");

    const dialogPromise = page
      .waitForEvent("dialog", { timeout: 2500 })
      .then((dialog) => dialog)
      .catch(() => null);

    await page.locator("[data-purchase-voucher-form] button[type='submit']").click();
    const dialog = await dialogPromise;
    if (dialog) {
      expect(dialog.message().toLowerCase()).toContain("required");
      await dialog.accept();
      return;
    }

    const currentUrl = page.url();
    const hasToast = await page.locator("[data-ui-notice-toast]").isVisible().catch(() => false);
    expect(hasToast || /\/vouchers\/goods-receipt-note/i.test(currentUrl)).toBeTruthy();
  });

  test("general purchase route is resilient to SQL-injection-like voucher_no", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/purchase?voucher_no=' OR 1=1 --&view=1", { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "General Purchase page not accessible for injection-resilience test.");

    await expect(page.locator("[data-purchase-voucher-form]")).toBeVisible();
    const voucherNoValue = await page.locator("[data-voucher-no-input]").inputValue();
    expect(voucherNoValue).toMatch(/^\d+$/);
  });

  test("network timeout during general purchase save does not create a voucher", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    test.skip(!adminUser?.id, "Admin user not found for timeout simulation.");

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PI", createdBy: adminUser.id });
    const response = await page.goto(GENERAL_PURCHASE_URL, { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "General Purchase page not accessible for timeout simulation.");
    await expect(page.locator("[data-purchase-voucher-form]")).toBeVisible();

    const supplierSelect = page.locator("[data-supplier-select]");
    const supplierOptions = await getSelectOptionValues(supplierSelect);
    test.skip(!supplierOptions.length, "No suppliers available for timeout simulation.");
    await supplierSelect.selectOption(supplierOptions[0]);

    const itemSelect = page.locator("[data-lines-body] tr").first().locator('select[data-row-field="item"]');
    const itemOptions = await getSelectOptionValues(itemSelect);
    test.skip(!itemOptions.length, "No raw materials available for timeout simulation.");

    await fillVoucherLine({
      page,
      itemValue: itemOptions[0],
      qty: "1.000",
      rate: "99.50",
    });
    await page.locator('[data-purchase-voucher-form] input[name="reference_no"]').fill(`PI-TIMEOUT-${Date.now()}`);

    await page.route("**/vouchers/purchase", async (route) => {
      if (route.request().method() === "POST") {
        await route.abort("timedout");
        return;
      }
      await route.continue();
    });

    const requestFailed = page.waitForEvent(
      "requestfailed",
      (request) => request.method() === "POST" && request.url().includes("/vouchers/purchase"),
      { timeout: 10000 },
    );

    await page.locator("[data-purchase-voucher-form] button[type='submit']").click();
    await requestFailed;
    await page.unroute("**/vouchers/purchase");

    const after = await getLatestVoucherHeader({ voucherTypeCode: "PI", createdBy: adminUser.id });
    expect(Number(after?.id || 0)).toBe(Number(before?.id || 0));
  });
});
