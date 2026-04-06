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

const OPERATOR_USER =
  process.env.E2E_INVENTORY_NEG_OPERATOR_USER || "e2e_inventory_neg_operator";
const OPERATOR_PASS =
  process.env.E2E_INVENTORY_NEG_OPERATOR_PASS || "InvNeg@123";

const selectOptionForced = async (locator, value) =>
  locator.selectOption(String(value), { force: true });

const setSelectValue = async (locator, value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  await selectOptionForced(locator, normalized);
  let selected = String((await locator.inputValue()) || "").trim();
  if (selected === normalized) return selected;
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

const getNonPhysicalReasonValue = async (reasonSelect) =>
  reasonSelect.locator("option").evaluateAll((options) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/[^a-z0-9]+/gi, "")
        .toUpperCase();
    const rows = options
      .map((option) => ({
        value: String(option.value || "").trim(),
        code: normalize(option.getAttribute("data-reason-value") || ""),
      }))
      .filter((row) => row.value);
    const nonPhysical = rows.find((row) => !row.code.startsWith("PHYSICALCOUNT"));
    return nonPhysical ? nonPhysical.value : rows[0]?.value || "";
  });

const readNumericInputValue = async (locator) => {
  const text = await locator.inputValue();
  const normalized = String(text || "")
    .replace(/,/g, "")
    .trim();
  const num = Number(normalized);
  return Number.isFinite(num) ? num : NaN;
};

const submitVoucherForm = async (page) => {
  await page.locator("[data-voucher-form] button[type='submit']").click();
};

const fillStockTransferOutForNegative = async (page) => {
  const response = await page.goto("/vouchers/stock-transfer-out?new=1", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.status()).toBe(200);

  const destinationSelect = page.locator("[data-destination-branch]");
  await expect(destinationSelect).toBeVisible();
  const destinationValues = await getNonEmptyOptionValues(destinationSelect);
  test.skip(
    !destinationValues.length,
    "Destination branch is required for stock transfer out test.",
  );
  await setSelectValue(destinationSelect, destinationValues[0]);

  const stockType = page.locator("[data-stock-type]");
  if (await stockType.count()) {
    await setSelectValue(stockType, "FG");
  }

  const firstRow = page.locator("[data-lines-body] tr[data-row-index]").first();
  await expect(firstRow).toBeVisible();

  const skuSelect = firstRow.locator('select[data-out-change="sku_id"]').first();
  await expect(skuSelect).toBeVisible();
  const skuValues = await getNonEmptyOptionValues(skuSelect);
  test.skip(
    !skuValues.length,
    "No SKU options available for Stock Transfer Out negative-stock test.",
  );
  await setSelectValue(skuSelect, skuValues[0]);

  const refreshedRow = page.locator("[data-lines-body] tr[data-row-index]").first();
  const uomSelect = refreshedRow.locator('select[data-out-change="uom_id"]').first();
  await expect(uomSelect).toBeVisible();
  const uomValues = await getNonEmptyOptionValues(uomSelect);
  test.skip(
    !uomValues.length,
    "No unit options available for selected SKU in Stock Transfer Out.",
  );
  await setSelectValue(uomSelect, uomValues[0]);

  const availableQtyInput = page
    .locator("[data-lines-body] tr[data-row-index]")
    .first()
    .locator("td")
    .nth(2)
    .locator("input")
    .first();
  await expect(availableQtyInput).toBeVisible();
  const availableQty = await readNumericInputValue(availableQtyInput);

  const transferQtyInput = page
    .locator("[data-lines-body] tr[data-row-index]")
    .first()
    .locator('input[data-out-input="transfer_qty"]')
    .first();
  await expect(transferQtyInput).toBeVisible();

  const nextQty = (Number.isFinite(availableQty) ? Math.max(availableQty, 0) : 0) + 1;
  await transferQtyInput.fill(String(nextQty));
};

const fillStockCountForNegative = async (page) => {
  const response = await page.goto("/vouchers/stock-count?new=1", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.status()).toBe(200);

  const stockType = page.locator("[data-stock-type]");
  if (await stockType.count()) {
    await setSelectValue(stockType, "FG");
  }

  const reasonSelect = page.locator("[data-reason-code]");
  const reasonNotes = page.locator("[data-reason-notes]");
  await expect(reasonSelect).toBeVisible();
  const reasonValue = await getNonPhysicalReasonValue(reasonSelect);
  test.skip(
    !reasonValue,
    "No reason codes available for Stock Count negative-stock test.",
  );
  await setSelectValue(reasonSelect, reasonValue);
  if (await reasonNotes.count()) {
    await reasonNotes.fill("E2E negative stock approval routing check.");
  }

  const firstRow = page.locator("tr[data-line-index]").first();
  await expect(firstRow).toBeVisible();

  const skuSelect = firstRow.locator('select[data-field="sku_id"]').first();
  await expect(skuSelect).toBeVisible();
  const skuValues = await getNonEmptyOptionValues(skuSelect);
  test.skip(
    !skuValues.length,
    "No SKU options available for Stock Count negative-stock test.",
  );
  await setSelectValue(skuSelect, skuValues[0]);

  const refreshedRow = page.locator("tr[data-line-index]").first();
  const uomSelect = refreshedRow.locator('select[data-field="uom_id"]').first();
  await expect(uomSelect).toBeVisible();
  const uomValues = await getNonEmptyOptionValues(uomSelect);
  test.skip(
    !uomValues.length,
    "No UOM options available for selected SKU in Stock Count.",
  );
  await setSelectValue(uomSelect, uomValues[0]);

  const systemQtyInput = page
    .locator("tr[data-line-index]")
    .first()
    .locator("td")
    .nth(2)
    .locator("input")
    .first();
  await expect(systemQtyInput).toBeVisible();
  const systemQty = await readNumericInputValue(systemQtyInput);

  const qtyOutInput = page
    .locator("tr[data-line-index]")
    .first()
    .locator('input[data-field="qty_out"]')
    .first();
  await expect(qtyOutInput).toBeVisible();

  const nextQtyOut = (Number.isFinite(systemQty) ? Math.max(systemQty, 0) : 0) + 1;
  await qtyOutInput.fill(String(nextQtyOut));
};

const expectApprovalFeedback = async (page) => {
  const modal = page.locator("[data-ui-error-modal]");
  const toast = page.locator("[data-ui-notice-toast]");

  const modalVisible = await modal.isVisible().catch(() => false);
  if (modalVisible) {
    await expect(modal).toContainText(/approval|submitted/i);
    await expect(modal).toContainText(/negative|insufficient|stock|reason/i);
    await page.locator("[data-ui-error-close]").click();
    return;
  }

  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/approval|submitted/i);
  await expect(toast).toContainText(/negative|insufficient|stock|reason/i);
};

test.describe("Inventory voucher negative-stock routing", () => {
  test.describe.configure({ mode: "serial" });

  const state = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUserId: null,
    operatorUserId: null,
    policySnapshots: {
      STN_OUT: null,
      STOCK_COUNT_ADJ: null,
    },
  };

  test.beforeAll(async () => {
    process.env.E2E_INVENTORY_NEG_OPERATOR_USER = OPERATOR_USER;
    process.env.E2E_INVENTORY_NEG_OPERATOR_PASS = OPERATOR_PASS;

    const branch = await getBranch();
    state.branchId = Number(branch?.id || 0) || null;

    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    state.adminUserId = Number(adminUser?.id || 0) || null;

    state.operatorUserId = await upsertUserWithPermissions({
      username: OPERATOR_USER,
      password: OPERATOR_PASS,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId: state.branchId,
      scopeKeys: [],
    });

    if (!state.operatorUserId) {
      state.skipReason = "Unable to provision operator user for inventory negative-stock tests.";
      return;
    }

    await setUserScopePermission({
      userId: state.operatorUserId,
      scopeType: "VOUCHER",
      scopeKey: "STN_OUT",
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

    await setUserScopePermission({
      userId: state.operatorUserId,
      scopeType: "VOUCHER",
      scopeKey: "STOCK_COUNT_ADJ",
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

    state.policySnapshots.STN_OUT = await getApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STN_OUT",
      action: "create",
    });
    state.policySnapshots.STOCK_COUNT_ADJ = await getApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STOCK_COUNT_ADJ",
      action: "create",
    });

    // Keep create-policy disabled so this suite validates negative-stock reroute specifically.
    await upsertApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STN_OUT",
      action: "create",
      requiresApproval: false,
    });
    await upsertApprovalPolicy({
      entityType: "VOUCHER_TYPE",
      entityKey: "STOCK_COUNT_ADJ",
      action: "create",
      requiresApproval: false,
    });

    state.ready = true;
  });

  test.afterAll(async () => {
    const restorePolicy = async (entityKey, snapshot) => {
      if (snapshot && typeof snapshot.requires_approval === "boolean") {
        await upsertApprovalPolicy({
          entityType: "VOUCHER_TYPE",
          entityKey,
          action: "create",
          requiresApproval: snapshot.requires_approval,
        });
        return;
      }
      await deleteApprovalPolicy({
        entityType: "VOUCHER_TYPE",
        entityKey,
        action: "create",
      });
    };

    await restorePolicy("STN_OUT", state.policySnapshots.STN_OUT);
    await restorePolicy("STOCK_COUNT_ADJ", state.policySnapshots.STOCK_COUNT_ADJ);
    await closeDb();
  });

  test.beforeEach(async () => {
    test.skip(!state.ready, state.skipReason || "Fixture setup failed.");
  });

  test("admin can save stock transfer out even when stock would go negative", async ({ page }) => {
    test.skip(!state.adminUserId, "Missing E2E admin credentials.");

    const beforeVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "STN_OUT",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });

    await login(page, "E2E_ADMIN");
    await fillStockTransferOutForNegative(page);
    await submitVoucherForm(page);

    await expect(page).toHaveURL(/\/vouchers\/stock-transfer-out\?new=1/i);
    await expect(page.locator("[data-ui-error-modal]")).toBeHidden();

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STN_OUT",
          createdBy: state.adminUserId,
          branchId: state.branchId,
        });
        return Number(row?.id || 0);
      })
      .toBeGreaterThan(Number(beforeVoucher?.id || 0));

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STN_OUT",
          createdBy: state.adminUserId,
          branchId: state.branchId,
        });
        return String(row?.status || "").toUpperCase();
      })
      .toBe("APPROVED");
  });

  test("non-admin stock transfer out queues approval and shows shortage reason", async ({ page }) => {
    const beforeApproval = await findLatestApprovalRequest({
      requestedBy: state.operatorUserId,
      status: "PENDING",
      entityType: "VOUCHER",
    });
    const beforeVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "STN_OUT",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });

    await login(page, "E2E_INVENTORY_NEG_OPERATOR");
    await fillStockTransferOutForNegative(page);
    await submitVoucherForm(page);
    await expectApprovalFeedback(page);

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
      .toContain("STN_OUT");

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STN_OUT",
          createdBy: state.operatorUserId,
          branchId: state.branchId,
        });
        return Number(row?.id || 0);
      })
      .toBeGreaterThan(Number(beforeVoucher?.id || 0));

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STN_OUT",
          createdBy: state.operatorUserId,
          branchId: state.branchId,
        });
        return String(row?.status || "").toUpperCase();
      })
      .toBe("PENDING");
  });

  test("admin can save stock count adjustment even when count would go negative", async ({ page }) => {
    test.skip(!state.adminUserId, "Missing E2E admin credentials.");

    const beforeVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.adminUserId,
      branchId: state.branchId,
    });

    await login(page, "E2E_ADMIN");
    await fillStockCountForNegative(page);
    await submitVoucherForm(page);

    await expect(page).toHaveURL(/\/vouchers\/stock-count\?new=1/i);
    await expect(page.locator("[data-ui-error-modal]")).toBeHidden();

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STOCK_COUNT_ADJ",
          createdBy: state.adminUserId,
          branchId: state.branchId,
        });
        return Number(row?.id || 0);
      })
      .toBeGreaterThan(Number(beforeVoucher?.id || 0));

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STOCK_COUNT_ADJ",
          createdBy: state.adminUserId,
          branchId: state.branchId,
        });
        return String(row?.status || "").toUpperCase();
      })
      .toBe("APPROVED");
  });

  test("non-admin stock count adjustment queues approval and shows shortage reason", async ({ page }) => {
    const beforeApproval = await findLatestApprovalRequest({
      requestedBy: state.operatorUserId,
      status: "PENDING",
      entityType: "VOUCHER",
    });
    const beforeVoucher = await getLatestVoucherHeader({
      voucherTypeCode: "STOCK_COUNT_ADJ",
      createdBy: state.operatorUserId,
      branchId: state.branchId,
    });

    await login(page, "E2E_INVENTORY_NEG_OPERATOR");
    await fillStockCountForNegative(page);
    await submitVoucherForm(page);
    await expectApprovalFeedback(page);

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
      .toContain("STOCK_COUNT_ADJ");

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STOCK_COUNT_ADJ",
          createdBy: state.operatorUserId,
          branchId: state.branchId,
        });
        return Number(row?.id || 0);
      })
      .toBeGreaterThan(Number(beforeVoucher?.id || 0));

    await expect
      .poll(async () => {
        const row = await getLatestVoucherHeader({
          voucherTypeCode: "STOCK_COUNT_ADJ",
          createdBy: state.operatorUserId,
          branchId: state.branchId,
        });
        return String(row?.status || "").toUpperCase();
      })
      .toBe("PENDING");
  });
});
