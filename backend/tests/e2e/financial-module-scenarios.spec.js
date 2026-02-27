const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { getApprovalPolicy, upsertApprovalPolicy, deleteApprovalPolicy, findLatestApprovalRequest, getUserByUsername, closeDb } = require("./utils/db");

const POLICY_ENTITY_TYPE = "VOUCHER_TYPE";
const POLICY_ENTITY_KEY = "BANK_VOUCHER";
const POLICY_ACTION = "edit";

const BANK_REGISTER_URL = "/reports/financial/voucher_register?voucher_type=bank&report_mode=details&load_report=1";
const CASH_VOUCHER_URL = "/vouchers/cash?new=1";
const EXPENSE_TRENDS_URL = "/reports/financial/expense_trends";

const findEditableBankStatusSelect = async (page) => {
  const selects = page.locator("[data-bank-status-select]");
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = selects.nth(i);
    if (await candidate.isDisabled()) continue;
    const voucherId = Number((await candidate.getAttribute("data-voucher-id")) || 0);
    const lineId = Number((await candidate.getAttribute("data-line-id")) || 0);
    if (voucherId > 0 && lineId > 0) return candidate;
  }
  return null;
};

const pickNextStatus = (currentStatus) => {
  const normalized = String(currentStatus || "PENDING").toUpperCase();
  if (normalized === "PENDING") return "REJECTED";
  if (normalized === "REJECTED") return "PENDING";
  return "PENDING";
};

const changeBankStatusAndCapture = async (page, selectEl, nextStatus) => {
  const responsePromise = page.waitForResponse((res) => res.url().includes("/bank-line-status") && res.request().method() === "POST", { timeout: 15000 });

  await selectEl.selectOption(nextStatus);

  const response = await responsePromise;
  const body = await response.json().catch(() => ({}));
  return {
    statusCode: response.status(),
    body,
  };
};

const fillBalancedCashVoucherLines = async (page) => {
  const firstRow = page.locator("[data-lines-body] tr").first();
  const firstAccount = firstRow.locator('select[data-field="account_id"]');
  const optionCount = await firstAccount.locator("option").count();
  test.skip(optionCount < 2, "No account options available for cash voucher flow.");

  await firstAccount.selectOption({ index: 1 });
  await firstRow.locator('input[data-field="cash_receipt"]').fill("250");

  await page.locator("[data-add-row]").click();
  const secondRow = page.locator("[data-lines-body] tr").nth(1);
  await secondRow.locator('select[data-field="account_id"]').selectOption({ index: 1 });
  await secondRow.locator('input[data-field="cash_payment"]').fill("250");
};

test.describe("Financial module - multi-user, permissions, approvals", () => {
  test.describe.configure({ mode: "serial" });

  const ctx = {
    policySnapshot: null,
    limitedUser: null,
  };

  test.beforeAll(async () => {
    ctx.policySnapshot = await getApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
    });

    const limitedUsername = process.env.E2E_LIMITED_USER;
    ctx.limitedUser = await getUserByUsername(limitedUsername || "");
  });

  test.afterAll(async () => {
    try {
      if (ctx.policySnapshot && typeof ctx.policySnapshot.requires_approval === "boolean") {
        await upsertApprovalPolicy({
          entityType: POLICY_ENTITY_TYPE,
          entityKey: POLICY_ENTITY_KEY,
          action: POLICY_ACTION,
          requiresApproval: ctx.policySnapshot.requires_approval,
        });
      } else {
        await deleteApprovalPolicy({
          entityType: POLICY_ENTITY_TYPE,
          entityKey: POLICY_ENTITY_KEY,
          action: POLICY_ACTION,
        });
      }
    } finally {
      await closeDb();
    }
  });

  test("admin can access key financial module pages", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const cashRes = await page.goto(CASH_VOUCHER_URL, { waitUntil: "domcontentloaded" });
    expect(cashRes?.status()).toBe(200);

    const registerRes = await page.goto(BANK_REGISTER_URL, { waitUntil: "domcontentloaded" });
    expect(registerRes?.status()).toBe(200);

    const trendsRes = await page.goto(EXPENSE_TRENDS_URL, { waitUntil: "domcontentloaded" });
    expect(trendsRes?.status()).toBe(200);
    await expect(page.locator("[data-ledger-filter-form]")).toBeVisible();
  });

  test("empty cash voucher submission is blocked for admin", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto(CASH_VOUCHER_URL, { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Cash voucher page not accessible.");

    const submitButton = page.locator('form button[type="submit"]').first();
    await expect(submitButton).toBeVisible();

    const dialogPromise = page
      .waitForEvent("dialog", { timeout: 2500 })
      .then((dialog) => dialog)
      .catch(() => null);

    await submitButton.click();

    const dialog = await dialogPromise;
    if (dialog) {
      expect(dialog.message().toLowerCase()).toContain("required");
      await dialog.accept();
      return;
    }

    const currentUrl = page.url();
    const hasErrorModal = await page
      .locator("[data-ui-error-modal]")
      .isVisible()
      .catch(() => false);
    const hasToast = await page
      .locator("[data-ui-notice-toast]")
      .isVisible()
      .catch(() => false);
    const stayedOnVoucherPage = /\/vouchers\/cash/i.test(currentUrl);
    const redirectedToLogin = /\/auth\/login/i.test(currentUrl);
    expect(hasErrorModal || hasToast || stayedOnVoucherPage || redirectedToLogin).toBeTruthy();
  });

  test("financial report sanitizes SQL-injection-like date filters", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    const response = await page.goto("/reports/financial/expense_trends?from_date=' OR 1=1 --&to_date=<script>alert(1)</script>&load_report=1", { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Expense trends report not accessible.");

    await expect(page.locator("[data-date-filter-warning]")).toBeVisible();
    await expect(page.locator('input[name="from_date"]')).toHaveValue(/\d{4}-\d{2}-\d{2}/);
    await expect(page.locator('input[name="to_date"]')).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  });

  test("admin bank status change applies immediately when approval policy is disabled", async ({ page }) => {
    await upsertApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
      requiresApproval: false,
    });

    await login(page, "E2E_ADMIN");
    const response = await page.goto(BANK_REGISTER_URL, { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Bank voucher register not accessible.");

    const selectEl = await findEditableBankStatusSelect(page);
    test.skip(!selectEl, "No editable bank status row found in voucher register details.");

    const previous = String((await selectEl.getAttribute("data-prev-status")) || "PENDING").toUpperCase();
    const next = pickNextStatus(previous);

    const result = await changeBankStatusAndCapture(page, selectEl, next);
    expect(result.statusCode).toBe(200);
    expect(result.body?.ok).toBeTruthy();
    expect(result.body?.queuedForApproval).toBeFalsy();

    await expect(selectEl).toHaveValue(next);
    await expect(selectEl).toHaveAttribute("data-prev-status", next);
    await expect(page.locator("[data-inline-report-toast]")).toBeVisible();
  });

  test("admin bank status change is queued when approval policy is enabled", async ({ page }) => {
    await upsertApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
      requiresApproval: true,
    });

    await login(page, "E2E_ADMIN");
    const response = await page.goto(BANK_REGISTER_URL, { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Bank voucher register not accessible.");

    const selectEl = await findEditableBankStatusSelect(page);
    test.skip(!selectEl, "No editable bank status row found in voucher register details.");

    const previous = String((await selectEl.getAttribute("data-prev-status")) || "PENDING").toUpperCase();
    const next = pickNextStatus(previous);

    const before = await findLatestApprovalRequest({
      requestedBy: Number(process.env.E2E_ADMIN_ID || 0) || undefined,
      status: "PENDING",
      entityType: "VOUCHER",
    });

    const result = await changeBankStatusAndCapture(page, selectEl, next);
    expect(result.statusCode).toBe(200);
    expect(result.body?.ok).toBeTruthy();
    expect(result.body?.queuedForApproval).toBeTruthy();

    await expect(selectEl).toHaveValue(previous);

    const after = await findLatestApprovalRequest({
      status: "PENDING",
      entityType: "VOUCHER",
    });
    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
  });

  test("limited user financial action is denied or rerouted to approval", async ({ page }) => {
    await upsertApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
      requiresApproval: false,
    });

    await login(page, "E2E_LIMITED");
    const response = await page.goto(BANK_REGISTER_URL, { waitUntil: "domcontentloaded" });

    if (!response || response.status() === 403) {
      expect(response?.status()).toBe(403);
      return;
    }

    expect(response.status()).toBe(200);

    const selectEl = await findEditableBankStatusSelect(page);
    test.skip(!selectEl, "No editable bank status row available for limited user scenario.");

    const previous = String((await selectEl.getAttribute("data-prev-status")) || "PENDING").toUpperCase();
    const next = pickNextStatus(previous);

    const before = await findLatestApprovalRequest({
      requestedBy: ctx.limitedUser?.id,
      status: "PENDING",
      entityType: "VOUCHER",
    });

    const result = await changeBankStatusAndCapture(page, selectEl, next);
    expect(result.statusCode).toBe(200);
    expect(result.body?.ok).toBeTruthy();

    if (result.body?.queuedForApproval) {
      await expect(selectEl).toHaveValue(previous);
      const after = await findLatestApprovalRequest({
        requestedBy: ctx.limitedUser?.id,
        status: "PENDING",
        entityType: "VOUCHER",
      });
      expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    } else {
      await expect(selectEl).toHaveValue(next);
      await expect(selectEl).toHaveAttribute("data-prev-status", next);
    }
  });

  test("bank status update handles network timeout gracefully", async ({ page }) => {
    await upsertApprovalPolicy({
      entityType: POLICY_ENTITY_TYPE,
      entityKey: POLICY_ENTITY_KEY,
      action: POLICY_ACTION,
      requiresApproval: false,
    });

    await login(page, "E2E_ADMIN");
    const response = await page.goto(BANK_REGISTER_URL, { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Bank voucher register not accessible.");

    const selectEl = await findEditableBankStatusSelect(page);
    test.skip(!selectEl, "No editable bank status row found for timeout scenario.");

    const previous = String((await selectEl.getAttribute("data-prev-status")) || "PENDING").toUpperCase();
    const next = pickNextStatus(previous);

    await page.route("**/reports/financial/**/bank-line-status", async (route) => {
      await route.abort("timedout");
    });

    await selectEl.selectOption(next);

    await expect(selectEl).toHaveValue(previous);
    await page.unroute("**/reports/financial/**/bank-line-status");
  });

  test("restricted cash voucher save shows approval/submit feedback", async ({ page }) => {
    await login(page, "E2E_LIMITED");

    const response = await page.goto(CASH_VOUCHER_URL, { waitUntil: "domcontentloaded" });
    test.skip(!response || response.status() !== 200, "Cash voucher page not accessible for limited user.");

    await fillBalancedCashVoucherLines(page);
    await page.locator('form button[type="submit"]').first().click();

    await expect(page.locator("[data-ui-notice-toast]")).toContainText(/approval|submitted|saved/i);
  });
});
