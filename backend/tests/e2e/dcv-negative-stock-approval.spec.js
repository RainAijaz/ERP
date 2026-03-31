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
  createBomUiFixture,
  cleanupBomUiFixture,
  findLatestApprovalRequest,
  getLatestVoucherHeader,
  closeDb,
} = require("./utils/db");

const OPERATOR_USER = process.env.E2E_DCV_OPERATOR_USER || "e2e_dcv_operator";
const OPERATOR_PASS = process.env.E2E_DCV_OPERATOR_PASS || "Dcv@123";

const selectOptionForced = async (locator, value) =>
  locator.selectOption(String(value), { force: true });

const setSelectValue = async (locator, value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  await selectOptionForced(locator, normalized);
  let selected = String((await locator.inputValue()) || "").trim();
  if (selected === normalized) return selected;
  // Some searchable wrappers delay select reflection; force DOM value to keep the test deterministic.
  await locator.evaluate((element, nextValue) => {
    const select = element;
    select.value = String(nextValue || "");
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, normalized);
  selected = String((await locator.inputValue()) || "").trim();
  return selected;
};

const getNonEmptyOptionValues = async (locator) =>
  locator
    .locator("option")
    .evaluateAll((options) =>
      options
        .map((option) => String(option.value || "").trim())
        .filter(Boolean),
    );

const fillDcvVoucher = async (page, fixture) => {
  const labourSelect = page.locator("[data-dcv-labour]");
  const deptSelect = page.locator("[data-dcv-department]");

  await expect(labourSelect).toBeVisible();
  await setSelectValue(labourSelect, String(fixture.labourId));

  await expect
    .poll(async () => {
      const deptValues = await getNonEmptyOptionValues(deptSelect);
      return deptValues.length;
    })
    .toBeGreaterThan(0);

  const deptValues = await getNonEmptyOptionValues(deptSelect);
  const deptValue = deptValues.includes(String(fixture.deptId))
    ? String(fixture.deptId)
    : deptValues[0];
  await setSelectValue(deptSelect, deptValue);

  const firstRow = page.locator("[data-lines-body] tr").first();
  await expect(firstRow).toBeVisible();

  const skuSelect = firstRow.locator('select[data-field="sku_id"]');
  const skuValues = await getNonEmptyOptionValues(skuSelect);
  expect(skuValues).toContain(String(fixture.sfgSkuId));
  const selectedSku = await setSelectValue(skuSelect, String(fixture.sfgSkuId));
  expect(selectedSku).toBe(String(fixture.sfgSkuId));

  const unitSelect = firstRow.locator('select[data-field="unit"]');
  const unitValues = await getNonEmptyOptionValues(unitSelect);
  if (unitValues.includes("PAIR")) {
    await setSelectValue(unitSelect, "PAIR");
  } else if (unitValues.length) {
    await setSelectValue(unitSelect, unitValues[0]);
  }

  const qtyInput = firstRow.locator('input[data-field="qty"]');
  await qtyInput.fill("5");
  await expect(qtyInput).toHaveValue("5");
};

const clickConfirm = async (page) => {
  await page.locator("[data-production-form] button[type='submit']").click();
};

test.describe("DCV negative RM stock handling", () => {
  test.describe.configure({ mode: "serial" });

  const state = {
    ready: false,
    skipReason: "",
    fixture: null,
    branchId: null,
    adminUserId: null,
    operatorUserId: null,
    policySnapshot: null,
  };

  test.beforeAll(async () => {
    process.env.E2E_DCV_OPERATOR_USER = OPERATOR_USER;
    process.env.E2E_DCV_OPERATOR_PASS = OPERATOR_PASS;

    const branch = await getBranch();
    state.branchId = Number(branch?.id || 0) || null;

    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    state.adminUserId = Number(adminUser?.id || 0) || null;

    const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    state.fixture = await createBomUiFixture(`dcvneg${token}`);
    if (!state.fixture) {
      state.skipReason = "Unable to create DCV negative-stock fixture.";
      return;
    }

    state.operatorUserId = await upsertUserWithPermissions({
      username: OPERATOR_USER,
      password: OPERATOR_PASS,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId: state.branchId,
      scopeKeys: [],
    });

    await setUserScopePermission({
      userId: state.operatorUserId,
      scopeType: "VOUCHER",
      scopeKey: "DCV",
      permissions: {
        can_navigate: true,
        can_view: true,
        can_create: true,
        can_edit: true,
        can_delete: false,
        can_print: true,
        can_approve: false,
      },
    });

    state.policySnapshot = await getApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "DCV",
      action: "create",
    });
    // Disable policy-driven create approval so this suite specifically exercises RM-shortage reroute behavior.
    await upsertApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "DCV",
      action: "create",
      requiresApproval: false,
    });

    state.ready = true;
  });

  test.afterAll(async () => {
    try {
      await cleanupBomUiFixture({ fixture: state.fixture, bomIds: [] });
    } catch (err) {
      // Ignore cleanup FK leftovers from vouchers created during this suite.
    }
    if (
      state.policySnapshot &&
      typeof state.policySnapshot.requires_approval === "boolean"
    ) {
      await upsertApprovalPolicy({
        entityType: "VOUCHER_TYPE",
        entityKey: "DCV",
        action: "create",
        requiresApproval: state.policySnapshot.requires_approval,
      });
    } else {
      await deleteApprovalPolicy({
        entityType: "VOUCHER_TYPE",
        entityKey: "DCV",
        action: "create",
      });
    }
    await closeDb();
  });

  test.beforeEach(async () => {
    test.skip(!state.ready, state.skipReason || "Fixture setup failed.");
  });

  test("admin confirm posts DCV even when RM goes negative", async ({
    page,
  }) => {
    // Admin path should post immediately (APPROVED) even when derived RM consumption crosses below zero.
    test.skip(!state.adminUserId, "Missing E2E admin credentials.");

    const beforeVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "DCV",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/department-completion?new=1", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await fillDcvVoucher(page, state.fixture);
    await clickConfirm(page);

    await expect(page).toHaveURL(/\/vouchers\/department-completion\?new=1/i);
    await expect(page.locator("[data-ui-error-modal]")).toBeHidden();

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "DCV",
          createdBy: state.adminUserId,
          branchId: state.branchId,
        });
        return Number(row?.id || 0);
      })
      .toBeGreaterThan(Number(beforeVoucher?.id || 0));

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "DCV",
          createdBy: state.adminUserId,
          branchId: state.branchId,
        });
        return String(row?.status || "").toUpperCase();
      })
      .toBe("APPROVED");
  });

  test("non-admin confirm queues approval and shows shortage reason modal", async ({
    page,
  }) => {
    // Non-admin path should not fail hard: queue pending approval and surface shortage reason in modal.
    test.skip(!state.operatorUserId, "Unable to provision DCV operator user.");

    const beforeApproval = await findLatestApprovalRequest({
      requestedBy: state.operatorUserId,
      status: "PENDING",
      entityType: "VOUCHER",
    });
    const beforeVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "DCV",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });

    await login(page, "E2E_DCV_OPERATOR");
    const response = await page.goto("/vouchers/department-completion?new=1", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await fillDcvVoucher(page, state.fixture);
    await clickConfirm(page);

    const modal = page.locator("[data-ui-error-modal]");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(/approval|submitted/i);
    await expect(modal).toContainText(/insufficient|required|available/i);

    await page.locator("[data-ui-error-close]").click();

    await expect
      .poll(async () => {
        const row = await findLatestApprovalRequest({
          requestedBy: state.operatorUserId,
          status: "PENDING",
          entityType: "VOUCHER",
        });
        return Number(row?.id || 0);
      })
      .toBeGreaterThan(Number(beforeApproval?.id || 0));

    await expect
      .poll(async () => {
        const row = await findLatestApprovalRequest({
          requestedBy: state.operatorUserId,
          status: "PENDING",
          entityType: "VOUCHER",
        });
        return String(row?.summary || "");
      })
      .toContain("DCV");

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "DCV",
          createdBy: state.operatorUserId,
          branchId: state.branchId,
        });
        return Number(row?.id || 0);
      })
      .toBeGreaterThan(Number(beforeVoucher?.id || 0));

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "DCV",
          createdBy: state.operatorUserId,
          branchId: state.branchId,
        });
        return String(row?.status || "").toUpperCase();
      })
      .toBe("PENDING");
  });
});
