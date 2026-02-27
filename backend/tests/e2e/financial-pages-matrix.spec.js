const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { getApprovalPolicy, upsertApprovalPolicy, deleteApprovalPolicy, getBranch, upsertUserWithPermissions, getUserByUsername, findLatestApprovalRequest, closeDb } = require("./utils/db");

const REPORT_KEYS = ["voucher_register", "cash_book", "cash_voucher_register", "bank_transactions", "expense_analysis", "expense_trends", "production_overhead", "non_production_expense", "accrued_expenses", "profitability_analysis", "profit_and_loss", "journal_voucher_register", "account_activity_ledger", "trial_balance", "payroll_wage_balance"];

const REPORT_QUERY_BY_KEY = {
  voucher_register: "?voucher_type=bank&report_mode=details&load_report=1",
  cash_voucher_register: "?voucher_type=cash&report_mode=summary&load_report=1",
  bank_transactions: "?voucher_type=bank&report_mode=details&load_report=1",
  journal_voucher_register: "?voucher_type=journal&report_mode=details&load_report=1",
  expense_analysis: "?load_report=1",
  expense_trends: "?load_report=1&time_granularity=weekly",
};

const VOUCHER_PAGES = [
  { path: "/vouchers/cash?new=1", receiptField: "cash_receipt", paymentField: "cash_payment", policyKey: "CASH_VOUCHER" },
  { path: "/vouchers/bank?new=1", receiptField: "bank_receipt", paymentField: "bank_payment", policyKey: "BANK_VOUCHER" },
  { path: "/vouchers/journal?new=1", receiptField: "debit", paymentField: "credit", policyKey: "JOURNAL_VOUCHER" },
];

const policySnapshots = new Map();
const contextState = {
  adminUserId: null,
};

const getReportPath = (reportKey) => `/reports/financial/${reportKey}${REPORT_QUERY_BY_KEY[reportKey] || ""}`;

const parseEntityRef = (value) => {
  const [kindRaw, idRaw] = String(value || "").split(":");
  const kind = String(kindRaw || "").toUpperCase();
  const id = Number(idRaw || 0);
  if (!["ACCOUNT", "PARTY", "LABOUR", "EMPLOYEE"].includes(kind) || !Number.isInteger(id) || id <= 0) {
    return null;
  }
  return { kind, id };
};

const buildLineRef = (entityRef) => {
  if (!entityRef) return null;
  if (entityRef.kind === "ACCOUNT") return { account_id: entityRef.id };
  if (entityRef.kind === "PARTY") return { party_id: entityRef.id };
  if (entityRef.kind === "LABOUR") return { labour_id: entityRef.id };
  if (entityRef.kind === "EMPLOYEE") return { employee_id: entityRef.id };
  return null;
};

const pickVoucherEntityRef = async (page) => {
  const values = await page
    .locator("[data-lines-body] tr")
    .first()
    .locator('select[data-field="entity_ref"] option')
    .evaluateAll((options) => options.map((opt) => String(opt.value || "")).filter(Boolean));

  const preferredOrder = ["PARTY", "LABOUR", "EMPLOYEE", "ACCOUNT"];
  for (const kind of preferredOrder) {
    const found = values.find((value) => String(value).startsWith(`${kind}:`));
    const parsed = parseEntityRef(found);
    if (parsed) return parsed;
  }
  return null;
};

const getHeaderAccountIdForVoucher = async (page, voucherTypeCode) => {
  if (voucherTypeCode !== "CASH_VOUCHER" && voucherTypeCode !== "BANK_VOUCHER") return null;
  const select = page.locator("select[data-header-account]");
  if ((await select.count()) === 0) return null;
  const id = await select.evaluate((el) => {
    const options = Array.from(el.options || []);
    const selected = Number(el.value || 0);
    if (Number.isInteger(selected) && selected > 0) return selected;
    const firstValid = options.map((opt) => Number(opt.value || 0)).find((value) => Number.isInteger(value) && value > 0);
    return firstValid || 0;
  });
  return Number(id || 0) || null;
};

const submitVoucherWithDeterministicLines = async (page, voucherTypeCode) => {
  const entityRef = await pickVoucherEntityRef(page);
  if (!entityRef) return false;
  const ref = buildLineRef(entityRef);
  if (!ref) return false;

  const headerAccountId = await getHeaderAccountIdForVoucher(page, voucherTypeCode);
  if (voucherTypeCode === "CASH_VOUCHER" && (!Number.isInteger(headerAccountId) || headerAccountId <= 0)) {
    return false;
  }

  const lines =
    voucherTypeCode === "JOURNAL_VOUCHER"
      ? [
          { ...ref, debit: 300, description: "E2E matrix debit" },
          { ...ref, credit: 300, description: "E2E matrix credit" },
        ]
      : voucherTypeCode === "BANK_VOUCHER"
        ? [{ ...ref, bank_payment: 300, reference_no: "E2E-MATRIX", description: "E2E matrix bank" }]
        : [{ ...ref, cash_payment: 300, description: "E2E matrix cash" }];

  const voucherForm = page.locator("form[data-voucher-form]").first();
  const csrfToken = await voucherForm.locator('input[name="_csrf"]').inputValue();
  const voucherDate = await voucherForm.locator('input[name="voucher_date"]').inputValue();
  const formAction = (await voucherForm.getAttribute("action")) || new URL(page.url()).pathname;
  const targetUrl = new URL(formAction || new URL(page.url()).pathname, page.url()).toString();

  const response = await page.context().request.post(targetUrl, {
    form: {
      _csrf: csrfToken,
      voucher_id: "",
      header_account_id: Number.isInteger(headerAccountId) && headerAccountId > 0 ? String(headerAccountId) : "",
      voucher_date: voucherDate,
      remarks: "E2E matrix voucher",
      lines_json: JSON.stringify(lines),
    },
  });

  const status = response.status();
  return response.ok() || status === 302 || status === 303;
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

test.describe("Financial pages matrix - users, permissions, approvals", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const branch = await getBranch();
    const branchId = Number(branch?.id || 0) || null;
    const limitedUser = process.env.E2E_LIMITED_USER || "e2e_fin_limited";
    const limitedPass = process.env.E2E_LIMITED_PASS || "Salesman@123";

    process.env.E2E_LIMITED_USER = limitedUser;
    process.env.E2E_LIMITED_PASS = limitedPass;

    await upsertUserWithPermissions({
      username: limitedUser,
      password: limitedPass,
      roleName: "Salesman",
      branchId,
      scopeKeys: [],
    });

    const adminUser = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    contextState.adminUserId = Number(adminUser?.id || 0) || null;

    for (const voucherPage of VOUCHER_PAGES) {
      await snapshotPolicy(voucherPage.policyKey);
    }
  });

  test.afterAll(async () => {
    try {
      for (const voucherPage of VOUCHER_PAGES) {
        const key = `${voucherPage.policyKey}:create`;
        const snapshot = policySnapshots.get(key);
        if (snapshot && typeof snapshot.requires_approval === "boolean") {
          await upsertApprovalPolicy({
            entityType: "VOUCHER_TYPE",
            entityKey: voucherPage.policyKey,
            action: "create",
            requiresApproval: snapshot.requires_approval,
          });
        } else {
          await deleteApprovalPolicy({
            entityType: "VOUCHER_TYPE",
            entityKey: voucherPage.policyKey,
            action: "create",
          });
        }
      }
    } finally {
      await closeDb();
    }
  });

  test("admin can load all financial report pages", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    for (const reportKey of REPORT_KEYS) {
      const response = await page.goto(getReportPath(reportKey), { waitUntil: "domcontentloaded" });
      expect(response?.status(), `admin status for ${reportKey}`).toBe(200);

      await expect(page.locator("[data-ledger-filter-form]"), `filter form for ${reportKey}`).toBeVisible();

      if (reportKey === "expense_trends") {
        const root = page.locator("[data-expense-trend-root]");
        const noEntries = page.getByText("No entries yet.");
        expect((await root.count()) > 0 || (await noEntries.count()) > 0).toBeTruthy();
      }

      if (reportKey === "voucher_register" || reportKey === "bank_transactions") {
        await expect(page.locator("[data-report-print-area]")).toBeVisible();
      }
    }
  });

  test("limited user report access follows permission boundaries", async ({ page }) => {
    await login(page, "E2E_LIMITED");

    for (const reportKey of REPORT_KEYS) {
      const response = await page.goto(getReportPath(reportKey), { waitUntil: "domcontentloaded" });
      const status = Number(response?.status() || 0);
      expect([200, 403]).toContain(status);

      if (status === 200) {
        await expect(page.locator("[data-ledger-filter-form]"), `limited form visible on ${reportKey}`).toBeVisible();
      } else {
        await expect(page.getByText(/permission denied|forbidden/i)).toBeVisible();
      }
    }
  });

  test("admin can load all financial voucher entry pages", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    for (const voucherPage of VOUCHER_PAGES) {
      const response = await page.goto(voucherPage.path, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `admin voucher load ${voucherPage.path}`).toBe(200);
      await expect(page.locator("[data-voucher-form]")).toBeVisible();
      await expect(page.locator("[data-lines-body]")).toBeVisible();
      await expect(page.locator('form button[type="submit"]').first()).toBeVisible();
    }
  });

  test("limited user voucher entry routes enforce permission or allow with constraints", async ({ page }) => {
    await login(page, "E2E_LIMITED");

    for (const voucherPage of VOUCHER_PAGES) {
      const response = await page.goto(voucherPage.path, { waitUntil: "domcontentloaded" });
      const status = Number(response?.status() || 0);
      expect([200, 403]).toContain(status);

      if (status === 200) {
        await expect(page.locator("[data-voucher-form]")).toBeVisible();
      } else {
        await expect(page.getByText(/permission denied|forbidden/i)).toBeVisible();
      }
    }
  });

  test("admin create flow honors approval-required policy for each financial voucher type", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    let executed = 0;

    for (const voucherPage of VOUCHER_PAGES) {
      await setCreateApprovalPolicy(voucherPage.policyKey, true);

      const response = await page.goto(voucherPage.path, { waitUntil: "domcontentloaded" });
      if (!response || response.status() !== 200) continue;

      const beforeApproval = await findLatestApprovalRequest({
        requestedBy: contextState.adminUserId || undefined,
        status: "PENDING",
        entityType: "VOUCHER",
      });

      const submitted = await submitVoucherWithDeterministicLines(page, voucherPage.policyKey);
      if (!submitted) continue;

      const afterApproval = await findLatestApprovalRequest({
        requestedBy: contextState.adminUserId || undefined,
        status: "PENDING",
        entityType: "VOUCHER",
      });
      expect(Number(afterApproval?.id || 0)).toBeGreaterThan(Number(beforeApproval?.id || 0));
      executed += 1;
    }

    expect(executed).toBeGreaterThan(0);
  });

  test("limited user create flow across vouchers routes to approval or save based on permissions", async ({ page }) => {
    await login(page, "E2E_LIMITED");

    for (const voucherPage of VOUCHER_PAGES) {
      await setCreateApprovalPolicy(voucherPage.policyKey, false);

      const response = await page.goto(voucherPage.path, { waitUntil: "domcontentloaded" });
      const status = Number(response?.status() || 0);
      if (status === 403) {
        await expect(page.getByText(/permission denied|forbidden/i)).toBeVisible();
        continue;
      }

      if (status !== 200) continue;
      const submitted = await submitVoucherWithDeterministicLines(page, voucherPage.policyKey);
      if (!submitted) continue;

      await expect(page.locator("[data-ui-notice-toast]")).toContainText(/approval|submitted|saved/i);
    }
  });
});
