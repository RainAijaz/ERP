const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  getUserByUsername,
  setUserScopePermission,
  clearUserScopePermission,
} = require("./utils/db");

const GENERAL_PURCHASE_URL = "/vouchers/purchase?new=1";
const PURCHASE_REPORT_URL = "/reports/purchases";
const POLICY_ENTITY_TYPE = "VOUCHER_TYPE";
const POLICY_ENTITY_KEY = "PI";
const POLICY_ACTION = "create";

const getSelectOptionValues = async (selectLocator) =>
  selectLocator
    .locator("option")
    .evaluateAll((options) =>
      options
        .map((option) => String(option.value || "").trim())
        .filter(Boolean),
    );

const createGeneralPurchaseVoucher = async ({
  page,
  purchaseCategory,
  referenceNo,
  qty = "1.000",
  rate = "99.5000",
}) => {
  const normalizedCategory =
    String(purchaseCategory || "").trim().toUpperCase() === "ASSET"
      ? "ASSET"
      : "RAW_MATERIAL";

  const response = await page.goto(GENERAL_PURCHASE_URL, {
    waitUntil: "domcontentloaded",
  });
  test.skip(
    !response || response.status() !== 200,
    "General Purchase page is not accessible.",
  );

  const form = page.locator("[data-purchase-voucher-form]");
  await expect(form).toBeVisible();

  const purchaseCategorySelect = form.locator("[data-purchase-category]");
  await purchaseCategorySelect.selectOption(normalizedCategory);

  const supplierSelect = form.locator("[data-supplier-select]");
  const supplierOptions = await getSelectOptionValues(supplierSelect);
  test.skip(!supplierOptions.length, "No suppliers available.");
  await supplierSelect.selectOption(supplierOptions[0]);

  let row = page.locator("[data-lines-body] tr").first();
  await expect(row).toBeVisible();
  let itemSelect = row.locator('select[data-row-field="item"]');
  let itemOptions = await getSelectOptionValues(itemSelect);
  test.skip(
    !itemOptions.length,
    normalizedCategory === "ASSET"
      ? "No asset options available for ASSET purchase category."
      : "No raw material options available for RAW_MATERIAL purchase category.",
  );

  await itemSelect.selectOption(itemOptions[0]);

  row = page.locator("[data-lines-body] tr").first();
  await row.locator('input[data-row-field="qty"]').fill(String(qty));
  await row.locator('input[data-row-field="rate"]').fill(String(rate));
  await form.locator('input[name="reference_no"]').fill(referenceNo);

  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/vouchers\/purchase\?new=1/i, {
    timeout: 20000,
  });
  const notice = page.locator("[data-ui-notice-toast]");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/saved/i);
};

const applyPurchaseReportCategoryFilter = async ({ page, categoryValue }) => {
  const form = page.locator("[data-purchase-report-filter-form]");
  await expect(form).toBeVisible();

  await form
    .locator(
      `input[name="purchase_category"][value="${String(categoryValue || "").toLowerCase()}"]`,
    )
    .check();

  await form.locator('button[type="submit"]').click();
  await page.waitForLoadState("domcontentloaded");
};

test.describe("Purchase report category filter", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    piPolicySnapshot: null,
    adminUserId: null,
  };

  test.beforeAll(async () => {
    ctx.piPolicySnapshot = await getApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
    });

    await upsertApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
      requiresApproval: false,
    });

    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    ctx.adminUserId = Number(adminUser?.id || 0) || null;
    if (ctx.adminUserId) {
      await setUserScopePermission({
        userId: ctx.adminUserId,
        scopeType: "REPORT",
        scopeKey: "purchase_report",
        permissions: {
          can_navigate: true,
          can_view: true,
          can_load: true,
          can_view_details: true,
          can_print: true,
          can_export_excel_csv: true,
        },
      });
    }
  });

  test.afterAll(async () => {
    if (ctx.adminUserId) {
      await clearUserScopePermission({
        userId: ctx.adminUserId,
        scopeType: "REPORT",
        scopeKey: "purchase_report",
      });
    }
    if (
      ctx.piPolicySnapshot &&
      typeof ctx.piPolicySnapshot.requires_approval === "boolean"
    ) {
      await upsertApprovalPolicy({
        entityType: POLICY_ENTITY_TYPE,
        entityKey: POLICY_ENTITY_KEY,
        action: POLICY_ACTION,
        requiresApproval: ctx.piPolicySnapshot.requires_approval,
      });
      return;
    }
    await deleteApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
    });
  });

  test("purchase report filters RAW_MATERIAL and ASSET rows correctly", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const token = Date.now();
    const rawReference = `PI-RM-RPT-${token}`;
    const assetReference = `PI-ASSET-RPT-${token}`;

    await createGeneralPurchaseVoucher({
      page,
      purchaseCategory: "RAW_MATERIAL",
      referenceNo: rawReference,
      qty: "1.000",
      rate: "125.2500",
    });
    await createGeneralPurchaseVoucher({
      page,
      purchaseCategory: "ASSET",
      referenceNo: assetReference,
      qty: "1.000",
      rate: "225.7500",
    });

    const reportResponse = await page.goto(PURCHASE_REPORT_URL, {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !reportResponse || reportResponse.status() !== 200,
      "Purchase report page is not accessible.",
    );
    test.skip(
      !/\/reports\/purchases/i.test(page.url()),
      "Current admin credentials do not have Purchase Report access in this environment.",
    );

    await applyPurchaseReportCategoryFilter({
      page,
      categoryValue: "raw_material",
    });
    const table = page.locator("[data-report-table]");
    await expect(table).toBeVisible();
    await expect(table).toContainText(rawReference);
    await expect(table).not.toContainText(assetReference);

    await applyPurchaseReportCategoryFilter({
      page,
      categoryValue: "asset",
    });
    await expect(table).toBeVisible();
    await expect(table).toContainText(assetReference);
    await expect(table).not.toContainText(rawReference);

    await applyPurchaseReportCategoryFilter({
      page,
      categoryValue: "all",
    });
    await expect(table).toBeVisible();
    await expect(table).toContainText(rawReference);
    await expect(table).toContainText(assetReference);
  });
});
