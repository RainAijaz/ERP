const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  getBranch,
  upsertUserWithPermissions,
  getUserByUsername,
  setUserScopePermission,
  findLatestApprovalRequest,
  getLatestVoucherHeader,
  closeDb,
} = require("./utils/db");

const VOUCHER_CASES = [
  {
    path: "/vouchers/sales-order?new=1",
    voucherTypeCode: "SALES_ORDER",
    scopeKey: "SALES_ORDER",
  },
  {
    path: "/vouchers/sales?new=1",
    voucherTypeCode: "SALES_VOUCHER",
    scopeKey: "SALES_VOUCHER",
  },
];

const policySnapshots = new Map();
const contextState = {
  creatorUserId: null,
};

const selectFirstOption = async (locator) => {
  const values = await locator
    .locator("option")
    .evaluateAll((options) =>
      options
        .map((option) => String(option.value || "").trim())
        .filter((value) => value.length > 0),
    );
  if (!values.length) return null;
  await locator.evaluate((el, value) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, values[0]);
  return values[0];
};

const ensureFirstRow = async (page) => {
  const rows = page.locator("[data-lines-body] tr");
  if ((await rows.count()) === 0) {
    const addRow = page.locator("[data-add-row]").first();
    await expect(addRow).toHaveCount(1);
    await addRow.click();
  }
  const row = page.locator("[data-lines-body] tr").first();
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  return row;
};

const fillVoucherHeader = async (page) => {
  const customer = page.locator('select[name="customer_party_id"]').first();
  const salesman = page.locator('select[name="salesman_employee_id"]').first();
  const referenceNo = page.locator('input[name="reference_no"]').first();
  const walkInCustomerName = page.locator("[data-customer-name]").first();
  const walkInCustomerPhone = page.locator("[data-customer-phone]").first();
  const customerNameInput = page
    .locator('input[name="customer_name"]:visible')
    .first();
  const customerPhoneInput = page
    .locator('input[name="customer_phone_number"]:visible')
    .first();
  const receiveAccount = page
    .locator('select[name="receive_into_account_id"]:visible')
    .first();

  if ((await customer.count()) > 0) {
    const customerValue = await selectFirstOption(customer);
    expect(customerValue).toBeTruthy();
  }

  if ((await walkInCustomerName.count()) > 0) {
    await walkInCustomerName.fill(`E2E Customer ${Date.now()}`);
  } else if ((await customerNameInput.count()) > 0) {
    await customerNameInput.fill(`E2E Customer ${Date.now()}`);
  }

  if ((await walkInCustomerPhone.count()) > 0) {
    await walkInCustomerPhone.fill("03123456789");
  } else if ((await customerPhoneInput.count()) > 0) {
    await customerPhoneInput.fill("03123456789");
  }

  await expect(salesman).toHaveCount(1);
  await expect(referenceNo).toHaveCount(1);
  const salesmanValue = await selectFirstOption(salesman);
  expect(salesmanValue).toBeTruthy();

  if ((await receiveAccount.count()) > 0) {
    await selectFirstOption(receiveAccount);
  }

  await referenceNo.fill(`E2E-SALES-APP-${Date.now()}`);
};

const fillVoucherLine = async (page) => {
  const row = await ensureFirstRow(page);
  const sku = row
    .locator('select[data-f="sku_id"], select[data-f="sales_order_line_id"]')
    .first();
  await expect(sku).toHaveCount(1);

  const selectedSku = await selectFirstOption(sku);
  expect(selectedSku).toBeTruthy();

  const qty = row.locator('input[data-f="sale_qty"]').first();
  await expect(qty).toHaveCount(1);
  await qty.fill("1");
  await qty.blur();
};

const submitVoucher = async (page, path) => {
  let response = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await page.goto(path, { waitUntil: "domcontentloaded" });
      break;
    } catch (err) {
      const message = String(err?.message || "");
      if (!message.includes("ERR_ABORTED") || attempt === 2) {
        throw err;
      }
    }
  }
  const expectedPath = String(path || "").split("?")[0];
  if (response) {
    expect(response.status()).toBe(200);
  } else {
    expect(page.url()).toContain(expectedPath);
  }

  await fillVoucherHeader(page);
  await fillVoucherLine(page);

  const voucherIdInput = page.locator('input[name="voucher_id"]').first();
  if ((await voucherIdInput.count()) > 0) {
    await voucherIdInput.evaluate((el) => {
      el.value = "";
    });
  }

  await page.locator('[data-sales-voucher-form] button[type="submit"]').click();
  await page.waitForLoadState("domcontentloaded");

  const errorModal = page.locator("[data-ui-error-modal]");
  const hasVisibleError = await errorModal.isVisible().catch(() => false);
  expect(hasVisibleError).toBeFalsy();
};

const setCreateApprovalPolicy = async (voucherTypeCode, requiresApproval) => {
  await upsertApprovalPolicy({
    entityType: "VOUCHER_TYPE",
    entityKey: voucherTypeCode,
    action: "create",
    requiresApproval,
  });
};

const snapshotPolicy = async (voucherTypeCode) => {
  const key = `${voucherTypeCode}:create`;
  if (policySnapshots.has(key)) return;
  const snapshot = await getApprovalPolicy({
    entityType: "VOUCHER_TYPE",
    entityKey: voucherTypeCode,
    action: "create",
  });
  policySnapshots.set(key, snapshot || null);
};

const waitForApprovalRequestAdvance = async ({
  requestedBy,
  baselineId,
  attempts = 10,
  delayMs = 200,
}) => {
  for (let i = 0; i < attempts; i += 1) {
    const latest = await findLatestApprovalRequest({
      requestedBy,
      status: "PENDING",
      entityType: "VOUCHER",
    });
    if (Number(latest?.id || 0) > Number(baselineId || 0)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return findLatestApprovalRequest({
    requestedBy,
    status: "PENDING",
    entityType: "VOUCHER",
  });
};

const waitForLatestVoucherAdvance = async ({
  voucherTypeCode,
  createdBy,
  baselineId,
  attempts = 10,
  delayMs = 200,
}) => {
  for (let i = 0; i < attempts; i += 1) {
    const latest = await getLatestVoucherHeader({ voucherTypeCode, createdBy });
    if (Number(latest?.id || 0) > Number(baselineId || 0)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return getLatestVoucherHeader({ voucherTypeCode, createdBy });
};

test.describe("Sales voucher approval policy matrix", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;
    const creatorUser =
      process.env.E2E_SALES_CREATOR_USER || "e2e_sales_creator";
    const creatorPass = process.env.E2E_SALES_CREATOR_PASS || "Creator@123";

    process.env.E2E_SALES_CREATOR_USER = creatorUser;
    process.env.E2E_SALES_CREATOR_PASS = creatorPass;

    const creatorUserId = await upsertUserWithPermissions({
      username: creatorUser,
      password: creatorPass,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId,
      scopeKeys: [],
    });
    contextState.creatorUserId = Number(creatorUserId || 0) || null;

    for (const voucherCase of VOUCHER_CASES) {
      await snapshotPolicy(voucherCase.voucherTypeCode);
      await setUserScopePermission({
        userId: contextState.creatorUserId,
        scopeType: "VOUCHER",
        scopeKey: voucherCase.scopeKey,
        permissions: {
          can_navigate: true,
          can_view: true,
          can_create: true,
          can_edit: true,
          can_delete: true,
          can_print: true,
          can_approve: false,
        },
      });
    }

    const resolved = await getUserByUsername(creatorUser);
    contextState.creatorUserId =
      Number(resolved?.id || contextState.creatorUserId || 0) || null;
  });

  test.afterAll(async () => {
    try {
      for (const voucherCase of VOUCHER_CASES) {
        const key = `${voucherCase.voucherTypeCode}:create`;
        const snapshot = policySnapshots.get(key);
        if (snapshot && typeof snapshot.requires_approval === "boolean") {
          await upsertApprovalPolicy({
            entityType: "VOUCHER_TYPE",
            entityKey: voucherCase.voucherTypeCode,
            action: "create",
            requiresApproval: snapshot.requires_approval,
          });
        } else {
          await deleteApprovalPolicy({
            entityType: "VOUCHER_TYPE",
            entityKey: voucherCase.voucherTypeCode,
            action: "create",
          });
        }
      }
    } finally {
      await closeDb();
    }
  });

  test("create policy=required routes sales vouchers into pending approvals", async ({
    page,
  }) => {
    await login(page, "E2E_SALES_CREATOR");

    for (const voucherCase of VOUCHER_CASES) {
      await setCreateApprovalPolicy(voucherCase.voucherTypeCode, true);

      const beforeApproval = await findLatestApprovalRequest({
        requestedBy: contextState.creatorUserId || undefined,
        status: "PENDING",
        entityType: "VOUCHER",
      });

      await submitVoucher(page, voucherCase.path);

      const afterApproval = await waitForApprovalRequestAdvance({
        requestedBy: contextState.creatorUserId || undefined,
        baselineId: Number(beforeApproval?.id || 0),
      });

      expect(Number(afterApproval?.id || 0)).toBeGreaterThan(
        Number(beforeApproval?.id || 0),
      );
    }
  });

  test("create policy=off saves sales vouchers directly as approved", async ({
    page,
  }) => {
    await login(page, "E2E_SALES_CREATOR");

    const policyOffCases = VOUCHER_CASES.filter(
      (voucherCase) => voucherCase.voucherTypeCode === "SALES_ORDER",
    );

    for (const voucherCase of policyOffCases) {
      await setCreateApprovalPolicy(voucherCase.voucherTypeCode, false);
      const beforeVoucher = await getLatestVoucherHeader({
        voucherTypeCode: voucherCase.voucherTypeCode,
        createdBy: contextState.creatorUserId || undefined,
      });

      await submitVoucher(page, voucherCase.path);

      const latestVoucher = await waitForLatestVoucherAdvance({
        voucherTypeCode: voucherCase.voucherTypeCode,
        createdBy: contextState.creatorUserId || undefined,
        baselineId: Number(beforeVoucher?.id || 0),
      });
      expect(Number(latestVoucher?.id || 0)).toBeGreaterThan(
        Number(beforeVoucher?.id || 0),
      );
      expect(String(latestVoucher?.status || "").toUpperCase()).toBe(
        "APPROVED",
      );
    }
  });
});
