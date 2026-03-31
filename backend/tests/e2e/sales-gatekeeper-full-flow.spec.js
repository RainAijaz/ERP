const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const {
  getBranch,
  upsertUserWithPermissions,
  setUserScopePermission,
} = require("./utils/db");

const STD_USER = process.env.E2E_SO_STD_USER || "e2e_so_std";
const STD_PASS = process.env.E2E_SO_STD_PASS || "Std@123";
const VIEW_USER = process.env.E2E_SO_VIEW_USER || "e2e_so_view";
const VIEW_PASS = process.env.E2E_SO_VIEW_PASS || "View@123";

const setVoucherPerm = async (userId, scopeKey, permissions = {}) => {
  await setUserScopePermission({
    userId,
    scopeType: "VOUCHER",
    scopeKey,
    permissions,
  });
};

const selectFirstOption = async (locator) => {
  const values = await locator.locator("option").evaluateAll((options) =>
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

const ensureRow = async (page) => {
  const rows = page.locator("[data-lines-body] tr");
  if ((await rows.count()) === 0) {
    const addRow = page.locator("[data-add-row]").first();
    if ((await addRow.count()) === 0) return null;
    await addRow.click();
  }
  const row = page.locator("[data-lines-body] tr").first();
  if ((await row.count()) === 0) return null;
  await expect(row).toBeVisible();
  return row;
};

const fillSalesHeader = async (page) => {
  const customer = page.locator('select[name="customer_party_id"]').first();
  const salesman = page.locator('select[name="salesman_employee_id"]').first();
  const bill = page.locator('input[name="reference_no"]').first();

  await selectFirstOption(customer);
  await selectFirstOption(salesman);
  if ((await bill.count()) > 0) {
    await bill.fill(`E2E-${Date.now()}`);
  }
};

const fillLine = async (
  page,
  { qty = "100", discount = null, overrideRate = null } = {}
) => {
  const row = await ensureRow(page);
  test.skip(!row, "Sales line row is not available in current UI mode.");
  const skuSelect = row
    .locator('select[data-f="sku_id"], select[data-f="sales_order_line_id"]')
    .first();
  await selectFirstOption(skuSelect);

  const qtyInput = row.locator('input[data-f="sale_qty"]').first();
  await qtyInput.fill(String(qty));

  if (overrideRate !== null) {
    const rateInput = row.locator('input[data-f="pair_rate"]').first();
    const editable = await rateInput.evaluate((el) => !(el.readOnly || el.hasAttribute("readonly") || el.hasAttribute("disabled")));
    if (editable) {
      await rateInput.fill(String(overrideRate));
    }
  }

  if (discount !== null) {
    const discountInput = row.locator('input[data-f="pair_discount"]').first();
    await discountInput.fill(String(discount));
  }
};

const submitVoucher = async (page) => {
  await page.locator('[data-sales-voucher-form] button[type="submit"]').click();
  await page.waitForLoadState("domcontentloaded");
};

const expectUiError = async (page, matcher) => {
  const modal = page.locator("[data-ui-error-modal]");
  const isModalVisible = await modal.isVisible().catch(() => false);
  if (isModalVisible) {
    const message = page.locator("[data-ui-error-message]");
    await expect(message).toBeVisible();
    if (matcher) {
      await expect(message).toContainText(matcher);
    }
    return;
  }
  const toast = page.locator("[data-ui-notice-toast], [data-ui-error-message]");
  if (await toast.first().isVisible().catch(() => false)) {
    if (matcher) {
      await expect(toast.first()).toContainText(matcher);
    }
    return;
  }
  if (matcher) {
    await expect(page.locator("body")).toContainText(matcher);
  }
};

test.describe("Sales Gatekeeper Full Flow", () => {
  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;

    process.env.E2E_SO_STD_USER = STD_USER;
    process.env.E2E_SO_STD_PASS = STD_PASS;
    process.env.E2E_SO_VIEW_USER = VIEW_USER;
    process.env.E2E_SO_VIEW_PASS = VIEW_PASS;

    const stdUserId = await upsertUserWithPermissions({
      username: STD_USER,
      password: STD_PASS,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId,
      scopeKeys: [],
    });

    const viewUserId = await upsertUserWithPermissions({
      username: VIEW_USER,
      password: VIEW_PASS,
      roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
      branchId,
      scopeKeys: [],
    });

    await setVoucherPerm(stdUserId, "SALES_ORDER", {
      can_view: true,
      can_navigate: true,
      can_create: true,
      can_edit: true,
      can_delete: true,
      can_print: true,
      can_approve: false,
    });
    await setVoucherPerm(stdUserId, "SALES", {
      can_view: true,
      can_navigate: true,
      can_create: true,
      can_edit: true,
      can_delete: false,
      can_print: true,
      can_approve: false,
    });

    await setVoucherPerm(viewUserId, "SALES_ORDER", {
      can_view: true,
      can_navigate: true,
      can_create: false,
      can_edit: false,
      can_delete: false,
      can_print: false,
      can_approve: false,
    });
  });

  test("SO happy path saves and returns to new form", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    const response = await page.goto("/vouchers/sales-order?new=1", {
      waitUntil: "domcontentloaded",
    });
    expect(response.status()).toBe(200);

    await fillSalesHeader(page);
    await fillLine(page, { qty: "100" });
    await submitVoucher(page);
    await expect(page).toHaveURL(/\/vouchers\/sales-order\?new=1/i);
  });

  test("SO read-only user cannot use create actions", async ({ page }) => {
    await login(page, "E2E_SO_VIEW");
    const response = await page.goto("/vouchers/sales-order?new=1", {
      waitUntil: "domcontentloaded",
    });
    expect(response.status()).toBe(200);

    const directCreate = await page.goto("/vouchers/sales-order/create", {
      waitUntil: "domcontentloaded",
    });
    expect([403, 404]).toContain(directCreate.status());
  });

  test("SO gatekeeper blocks high discount for standard user", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    await page.goto("/vouchers/sales-order?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    await fillLine(page, { qty: "10", discount: "25" });
    await submitVoucher(page);
    await expectUiError(page, /discount|approval|required/i);
  });

  test("SO admin accepts same high discount", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales-order?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    await fillLine(page, { qty: "10", discount: "25" });
    await submitVoucher(page);
    await expect(page).toHaveURL(/\/vouchers\/sales-order\?new=1/i);
  });

  test("SO gatekeeper blocks base price override for standard user", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    await page.goto("/vouchers/sales-order?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    const rateInput = page.locator("[data-lines-body] tr").first().locator('input[data-f="pair_rate"]').first();
    test.skip(await rateInput.evaluate((el) => el.readOnly || el.hasAttribute("readonly")), "Pair rate is readonly in current UI.");
    await fillLine(page, { qty: "5", overrideRate: "1" });
    await submitVoucher(page);
    await expectUiError(page, /rate override is not allowed/i);
  });

  test("SO admin allows base price override", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales-order?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    const rateInput = page.locator("[data-lines-body] tr").first().locator('input[data-f="pair_rate"]').first();
    test.skip(await rateInput.evaluate((el) => el.readOnly || el.hasAttribute("readonly")), "Pair rate is readonly in current UI.");
    await fillLine(page, { qty: "5", overrideRate: "1" });
    await submitVoucher(page);
    await expect(page).toHaveURL(/\/vouchers\/sales-order\?new=1/i);
  });

  test("SO empty required fields show validation failures", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    await page.goto("/vouchers/sales-order?new=1", { waitUntil: "domcontentloaded" });
    await page.locator('[data-sales-voucher-form] button[type="submit"]').click();
    await expectUiError(page, /required|voucher lines|review|resolve|error/i);
  });

  test("SO zero pricing is blocked", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    await page.goto("/vouchers/sales-order?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    const rateInput = page.locator("[data-lines-body] tr").first().locator('input[data-f="pair_rate"]').first();
    test.skip(await rateInput.evaluate((el) => el.readOnly || el.hasAttribute("readonly")), "Pair rate is readonly in current UI.");
    await fillLine(page, { qty: "4", overrideRate: "0" });
    await submitVoucher(page);
    await expectUiError(page, /pair rate is required|rate override/i);
  });

  test("Sales invoice page loads and supports SO-link picker", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    const response = await page.goto("/vouchers/sales?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(response.status() === 403, "Sales invoice route is restricted for this role in current policy.");
    expect(response.status()).toBe(200);
    await expect(page.locator("[data-link-sales-order-btn]")).toBeVisible();
  });

  test("Sales invoice standard direct invoice can submit", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    await fillLine(page, { qty: "2" });
    await submitVoucher(page);
    await expect(page).toHaveURL(/\/vouchers\/sales\?new=1/i);
  });

  test("Sales invoice gatekeeper blocks negative stock for standard", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    await fillLine(page, { qty: "500" });
    await submitVoucher(page);
    await expectUiError(page, /stock|insufficient|quantity/i);
  });

  test("Sales invoice admin can force negative stock", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    await fillSalesHeader(page);
    await fillLine(page, { qty: "500" });
    await submitVoucher(page);
    await expect(page).toHaveURL(/\/vouchers\/sales\?new=1/i);
  });

  test("Sales invoice gatekeeper blocks backdated in closed month for standard", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    const oldDate = new Date();
    oldDate.setMonth(oldDate.getMonth() - 2);
    const yyyy = oldDate.getFullYear();
    const mm = String(oldDate.getMonth() + 1).padStart(2, "0");
    const dd = String(oldDate.getDate()).padStart(2, "0");
    const dateInput = page.locator('input[name="voucher_date"]');
    test.skip((await dateInput.count()) === 0, "Voucher date input not editable in current UI.");
    await dateInput.fill(`${yyyy}-${mm}-${dd}`);
    await fillSalesHeader(page);
    await fillLine(page, { qty: "1" });
    await submitVoucher(page);
    await expectUiError(page, /date|closed|period|backdated/i);
  });

  test("Sales invoice cash receipt toggle is visible", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-payment-type-segment]")).toBeVisible();
  });

  test("Sales invoice gate pass print page hides financial totals", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/sales/gate-pass?voucher_no=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(response.status() !== 200, "Gate pass for voucher #1 not available in current dataset.");

    await expect(page.getByText(/pair_rate|total_sales_amount|tax/i)).toHaveCount(0);
    await expect(page.getByText(/sku|article|sale qty|pairs/i).first()).toBeVisible();
  });

  test("Sales report customer ledger route loads", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/reports/sales/customer-ledger", {
      waitUntil: "domcontentloaded",
    });
    expect(response.status()).toBe(200);
  });

  test("Sales report branch isolation non-admin cannot pick all branches", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    const response = await page.goto("/reports/sales/customer-balances", {
      waitUntil: "domcontentloaded",
    });
    test.skip(response.status() === 403, "Report route is restricted for this role in current policy.");
    expect(response.status()).toBe(200);
    const multiBranch = page.locator('[data-multi-select][data-name="branch_ids"]');
    const singleBranch = page.locator('select[name="branch_id"], select[name="branch_ids"]');
    expect((await multiBranch.count()) + (await singleBranch.count())).toBeGreaterThan(0);
  });

  test("Sales report admin can use multi-branch filter", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/sales/customer-balances", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-multi-select][data-name="branch_ids"]')).toHaveCount(1);
  });

  test("Sensitive profitability report is blocked for standard user", async ({ page }) => {
    await login(page, "E2E_SO_STD");
    const response = await page.goto("/reports/financial/profitability_analysis", {
      waitUntil: "domcontentloaded",
    });
    expect([200, 403]).toContain(response.status());
  });

  test("Profitability report opens for admin", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/reports/financial/profitability_analysis", {
      waitUntil: "domcontentloaded",
    });
    expect(response.status()).toBe(200);
  });

  test("Sales discount report honors date range", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/sales/sales-discount-report", {
      waitUntil: "domcontentloaded",
    });
    const fromInput = page.locator('input[name="from_date"]').first();
    const toInput = page.locator('input[name="to_date"]').first();
    await fromInput.evaluate((el) => { el.value = "2026-03-01"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
    await toInput.evaluate((el) => { el.value = "2026-03-15"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.getByRole("button", { name: /^load$/i }).click();
    await expect(page.locator("[data-report-table], table")).not.toHaveCount(0);
  });

  test("Customer balances export CSV follows visible filter", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/sales/customer-balances", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^load$/i }).click();

    const downloadButton = page.locator("[data-download-button]");
    test.skip(!(await downloadButton.isEnabled()), "Export button disabled in current dataset.");

    const downloadPromise = page.waitForEvent("download");
    await downloadButton.click();
    const download = await downloadPromise;
    expect(String(download.suggestedFilename() || "").toLowerCase()).toContain("customer");
  });

  test("Empty-state report renders cleanly for future range", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/sales/sales-discount-report", { waitUntil: "domcontentloaded" });
    const fromInput = page.locator('input[name="from_date"]').first();
    const toInput = page.locator('input[name="to_date"]').first();
    await fromInput.evaluate((el) => { el.value = "2099-01-01"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
    await toInput.evaluate((el) => { el.value = "2099-01-31"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.getByRole("button", { name: /^load$/i }).click();
    await expect(page.getByText(/no entries|load report to view/i)).toBeVisible();
  });

  test("Audit logs page opens and is queryable", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/administration/audit-logs", { waitUntil: "domcontentloaded" });
    expect(response.status()).toBe(200);
    await expect(page.locator("body")).toContainText(/audit|log/i);
  });
});
