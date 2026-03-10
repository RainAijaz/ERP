const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  getUserByUsername,
  upsertUserWithPermissions,
  setUserScopePermission,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  findLatestApprovalRequest,
  getLatestVoucherHeader,
  closeDb,
} = require("./utils/db");

const LIMITED_USER = process.env.E2E_RDV_LIMITED_USER || "e2e_rdv_limited";
const LIMITED_PASS = process.env.E2E_RDV_LIMITED_PASS || "Rdv@123";

const chooseFirstSearchableValue = async (wrapper, label) => {
  const input = wrapper.locator("input").first();
  const select = wrapper.locator("select").first();

  await expect(input).toBeVisible();
  for (let i = 0; i < 4; i += 1) {
    await input.click();
    await input.press("Enter");
    const value = String((await select.inputValue()) || "").trim();
    if (value) return value;
    await input.press("ArrowDown");
    await input.press("Enter");
    const movedValue = String((await select.inputValue()) || "").trim();
    if (movedValue) return movedValue;
  }

  throw new Error(`No non-empty selectable value found for ${label}`);
};

const fillDispatchVoucher = async (page) => {
  await page.waitForSelector("[data-returnable-form]");

  const vendorWrapper = page
    .locator("[data-searchable-wrapper]")
    .filter({ has: page.locator('select[name="vendor_party_id"]') })
    .first();
  const reasonWrapper = page
    .locator("[data-searchable-wrapper]")
    .filter({ has: page.locator('select[name="reason_code"]') })
    .first();
  await chooseFirstSearchableValue(vendorWrapper, "vendor_party_id");
  await chooseFirstSearchableValue(reasonWrapper, "reason_code");

  const voucherDateInput = page.locator('input[name="voucher_date"]').first();
  const expectedDateInput = page.locator('input[name="expected_return_date"]').first();
  const voucherDateValue = await voucherDateInput.inputValue();
  const voucherDate = new Date(`${voucherDateValue}T00:00:00`);
  const expectedDate = new Date(voucherDate.getTime());
  expectedDate.setDate(expectedDate.getDate() + 1);
  const yyyy = expectedDate.getFullYear();
  const mm = String(expectedDate.getMonth() + 1).padStart(2, "0");
  const dd = String(expectedDate.getDate()).padStart(2, "0");
  await expectedDateInput.fill(`${yyyy}-${mm}-${dd}`);

  const firstRow = page.locator("[data-lines-body] tr").first();
  await expect(firstRow).toBeVisible();

  const assetWrapper = firstRow.locator("[data-searchable-wrapper]").first();
  await chooseFirstSearchableValue(assetWrapper, "asset_id");

  await page.waitForTimeout(100);
  const updatedFirstRow = page.locator("[data-lines-body] tr").first();
  const conditionWrapper = updatedFirstRow.locator("[data-searchable-wrapper]").nth(1);
  await chooseFirstSearchableValue(conditionWrapper, "condition_out_code");

  const qtyInput = updatedFirstRow.locator('input[data-row-field="qty"]').first();
  await qtyInput.fill("1");
};

const submitAndAssertNoUiError = async (page) => {
  await page.locator("[data-enter-submit]").click();
  await page.waitForLoadState("domcontentloaded");

  const errorModal = page.locator("[data-ui-error-modal]");
  if (await errorModal.isVisible()) {
    const message = (await page.locator("[data-ui-error-message]").textContent()) || "Unknown UI error";
    throw new Error(`UI error shown after submit: ${message.trim()}`);
  }
};

test.describe("Returnable dispatch create flow", () => {
  test.describe.configure({ mode: "serial" });

  const policyKey = "RDV:create";
  const state = {
    branchId: null,
    adminUserId: null,
    limitedUserId: null,
    policySnapshot: null,
  };

  test.beforeAll(async () => {
    process.env.E2E_RDV_LIMITED_USER = LIMITED_USER;
    process.env.E2E_RDV_LIMITED_PASS = LIMITED_PASS;

    const branch = await getBranch();
    state.branchId = Number(branch?.id || 0) || null;

    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    state.adminUserId = Number(adminUser?.id || 0) || null;

    state.limitedUserId = await upsertUserWithPermissions({
      username: LIMITED_USER,
      password: LIMITED_PASS,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId: state.branchId,
      scopeKeys: [],
    });

    await setUserScopePermission({
      userId: state.limitedUserId,
      scopeType: "VOUCHER",
      scopeKey: "RDV",
      permissions: {
        can_navigate: true,
        can_view: true,
        can_create: false,
        can_edit: false,
        can_delete: false,
        can_print: false,
        can_approve: false,
      },
    });

    state.policySnapshot = await getApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "RDV",
      action: "create",
    });

    await upsertApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "RDV",
      action: "create",
      requiresApproval: false,
    });
  });

  test.afterAll(async () => {
    try {
      if (state.policySnapshot && typeof state.policySnapshot.requires_approval === "boolean") {
        await upsertApprovalPolicy({
          entityType: "VOUCHER_TYPE",
          entityKey: "RDV",
          action: "create",
          requiresApproval: state.policySnapshot.requires_approval,
        });
      } else {
        await deleteApprovalPolicy({
          entityType: "VOUCHER_TYPE",
          entityKey: "RDV",
          action: "create",
        });
      }
    } finally {
      await closeDb();
    }
  });

  test("admin can create returnable dispatch voucher", async ({ page }) => {
    test.skip(!state.adminUserId, "Admin user not found. Set E2E_ADMIN_USER/E2E_ADMIN_PASS.");

    const beforeVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "RDV",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await fillDispatchVoucher(page);
    await submitAndAssertNoUiError(page);
    await expect(page).toHaveURL(/\/vouchers\/returnable-dispatch\?new=1/i);

    const afterVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "RDV",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });
    expect(Number(afterVoucher?.id || 0)).toBeGreaterThan(Number(beforeVoucher?.id || 0));
    expect(String(afterVoucher?.status || "").toUpperCase()).toBe("APPROVED");
  });

  test("restricted user create is rerouted to pending approval", async ({ page }) => {
    test.skip(!state.limitedUserId, "Unable to provision limited RDV user.");

    const beforeApproval = await findLatestApprovalRequest({
      requestedBy: state.limitedUserId,
      status: "PENDING",
      entityType: "VOUCHER",
    });

    await login(page, "E2E_RDV_LIMITED");
    const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await fillDispatchVoucher(page);
    await submitAndAssertNoUiError(page);
    await expect(page).toHaveURL(/\/vouchers\/returnable-dispatch\?new=1/i);

    const afterApproval = await findLatestApprovalRequest({
      requestedBy: state.limitedUserId,
      status: "PENDING",
      entityType: "VOUCHER",
    });
    expect(Number(afterApproval?.id || 0)).toBeGreaterThan(Number(beforeApproval?.id || 0));
    expect(String(afterApproval?.summary || "")).toContain("RDV");
  });
});
