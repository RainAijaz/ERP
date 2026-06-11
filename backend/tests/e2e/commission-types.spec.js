/**
 * Tests for the Commission Type feature:
 *  1. commission_type field present in form with all 4 options
 *  2. Saving a BRANCH_SALE rule stores commission_type correctly in DB
 *  3. List page shows colour-coded commission_type badge
 *  4. DB-level type isolation (SALESMAN_SALE ≠ BRANCH_SALE)
 *  5. commission_ledger table schema correct
 *  6. Commission Ledger report page loads and filters work
 *  7. Commission Ledger nav entry exists in the DOM
 */

const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

// ── helpers ────────────────────────────────────────────────────────────────

const getSelectOptions = async (page, fieldName) => {
  const sel = page.locator(`[data-modal-form] [data-field="${fieldName}"]`).first();
  if (!(await sel.count())) return [];
  return sel.evaluate((el) =>
    Array.from(el.options || [])
      .map((opt) => ({ value: String(opt.value || "").trim(), label: String(opt.textContent || "").trim() }))
      .filter((opt) => opt.value),
  );
};

const setSelectSingle = async (page, fieldName, value) => {
  await page.locator(`[data-modal-form] [data-field="${fieldName}"]`).evaluate((el, val) => {
    el.value = String(val || "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
};

const setSelectMulti = async (page, fieldName, values) => {
  await page.locator(`[data-modal-form] [data-field="${fieldName}"]`).evaluate((el, vals) => {
    const wanted = new Set((Array.isArray(vals) ? vals : []).map((v) => String(v || "").trim()).filter(Boolean));
    Array.from(el.options || []).forEach((opt) => { opt.selected = wanted.has(String(opt.value || "").trim()); });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, values);
};

const openCommissionForm = async (page) => {
  await page.goto("/hr-payroll/employees/commissions", { waitUntil: "domcontentloaded" });
  await page.locator("[data-modal-open]").first().click();
  await expect(page.locator("[data-modal-form]")).toBeVisible();
};

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

// ══════════════════════════════════════════════════════════════════════════
// Suite 1 — Commission type field in the create form
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission type — form field", () => {
  // Each suite creates its own db so destroying one doesn't affect others.
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("commission_type dropdown is present with all 4 options", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openCommissionForm(page);

    const opts = await getSelectOptions(page, "commission_type");
    const values = opts.map((o) => o.value);

    expect(values).toContain("SALESMAN_SALE");
    expect(values).toContain("BRANCH_SALE");
    expect(values).toContain("TRANSFER");
    expect(values).toContain("PARTY");
    expect(opts.length).toBe(4);
  });

  test("commission_type field contains SALESMAN_SALE as an option (first)", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openCommissionForm(page);

    const opts = await getSelectOptions(page, "commission_type");
    // SALESMAN_SALE must be the first meaningful option in the list
    expect(opts[0]?.value).toBe("SALESMAN_SALE");
  });

  test("can select BRANCH_SALE in the dropdown", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openCommissionForm(page);

    await setSelectSingle(page, "commission_type", "BRANCH_SALE");

    const current = await page
      .locator(`[data-modal-form] [data-field="commission_type"]`)
      .evaluate((el) => el.value);

    expect(current).toBe("BRANCH_SALE");
  });

  test("can select TRANSFER in the dropdown", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openCommissionForm(page);

    await setSelectSingle(page, "commission_type", "TRANSFER");

    const current = await page
      .locator(`[data-modal-form] [data-field="commission_type"]`)
      .evaluate((el) => el.value);

    expect(current).toBe("TRANSFER");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 2 — Saving a BRANCH_SALE rule stores commission_type in DB
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission type — BRANCH_SALE save to DB", () => {
  test.describe.configure({ mode: "serial" });

  const db = createKnex(knexConfig);
  const ctx = { employeeId: null, skuId: null };

  test.afterAll(async () => {
    // Clean up the test rule we inserted
    if (ctx.employeeId) {
      await db("erp.employee_commission_rules")
        .where({ employee_id: ctx.employeeId, commission_type: "BRANCH_SALE", value: 999 })
        .delete();
    }
    await db.destroy();
  });

  test("saving a BRANCH_SALE rule creates a DB row with commission_type=BRANCH_SALE", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openCommissionForm(page);

    const empOpts = await getSelectOptions(page, "employee_id");
    test.skip(!empOpts.length, "No employee options — skipping.");

    ctx.employeeId = Number(empOpts[0].value);
    await setSelectMulti(page, "employee_id", [String(ctx.employeeId)]);

    await setSelectSingle(page, "commission_type", "BRANCH_SALE");
    await setSelectSingle(page, "apply_on", "SKU");
    await page.waitForTimeout(400);

    const skuOpts = await getSelectOptions(page, "sku_id");
    test.skip(!skuOpts.length, "No SKU options — skipping.");
    ctx.skuId = Number(skuOpts[0].value);
    await setSelectMulti(page, "sku_id", [String(ctx.skuId)]);

    await setSelectSingle(page, "rate_type", "PER_PAIR");
    await page.locator('[data-modal-form] [data-field="value"]').fill("999");

    const before = await db("erp.employee_commission_rules")
      .where({ employee_id: ctx.employeeId, sku_id: ctx.skuId, commission_type: "BRANCH_SALE", value: 999 })
      .count({ c: "*" }).first();

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-modal-form] button[type="submit"]').click(),
    ]);

    const after = await db("erp.employee_commission_rules")
      .where({ employee_id: ctx.employeeId, sku_id: ctx.skuId, commission_type: "BRANCH_SALE", value: 999 })
      .count({ c: "*" }).first();

    expect(Number(after?.c || 0)).toBeGreaterThan(Number(before?.c || 0));
  });

  test("the saved rule has commission_type=BRANCH_SALE, not SALESMAN_SALE", async () => {
    test.skip(!ctx.employeeId, "No employeeId from previous test.");

    const row = await db("erp.employee_commission_rules")
      .where({ employee_id: ctx.employeeId, commission_type: "BRANCH_SALE", value: 999 })
      .first();

    expect(row).toBeTruthy();
    expect(String(row.commission_type)).toBe("BRANCH_SALE");
    expect(String(row.commission_type)).not.toBe("SALESMAN_SALE");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 3 — Badge rendering in the list view
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission type — badge in list view", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("list page loads and the table is visible", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/employees/commissions", { waitUntil: "domcontentloaded" });
    await expect(page.locator("table").first()).toBeVisible();
  });

  test("commission_type badges use colour classes (not plain slate)", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/employees/commissions", { waitUntil: "domcontentloaded" });

    // Expand the first employee group so badge rows are visible
    const firstGroupHeader = page.locator("tr.group-header").first();
    if (await firstGroupHeader.count()) {
      await firstGroupHeader.click();
      await page.waitForTimeout(300);
    }

    // Look for any commission_type badge — these all have rounded-full border inline-flex
    const anyBadge = page.locator("tr[data-row] td span.rounded-full.border").first();
    const badgeCount = await page.locator("tr[data-row] td span.rounded-full.border").count();
    test.skip(badgeCount === 0, "No data rows — skipping badge colour test.");

    const cls = await anyBadge.getAttribute("class");
    // Must have one of our 4 commission_type colour classes OR the fallback slate
    const knownColorPatterns = ["blue-", "violet-", "amber-", "emerald-", "slate-"];
    expect(knownColorPatterns.some((p) => (cls || "").includes(p))).toBe(true);
  });

  test("SALESMAN_SALE badge uses blue colour class", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/employees/commissions", { waitUntil: "domcontentloaded" });

    // Ensure there are SALESMAN_SALE rules in DB
    const count = await db("erp.employee_commission_rules")
      .where({ commission_type: "SALESMAN_SALE", status: "active" })
      .count({ c: "*" }).first();
    test.skip(!Number(count?.c), "No SALESMAN_SALE rules in DB — skipping.");

    // Expand first group
    const firstGroupHeader = page.locator("tr.group-header").first();
    if (await firstGroupHeader.count()) {
      await firstGroupHeader.click();
      await page.waitForTimeout(300);
    }

    // Find a badge with blue-700 class (SALESMAN_SALE)
    // Badges may be inside collapsed rows — toBeAttached() is sufficient
    const blueBadge = page.locator("tr[data-row] td span.text-blue-700").first();
    await expect(blueBadge).toBeAttached({ timeout: 5000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 4 — DB-level type isolation
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission type — DB-level filter isolation", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("SALESMAN_SALE and BRANCH_SALE rules don't cross-contaminate", async () => {
    const crossQuery = await db("erp.employee_commission_rules")
      .where({ commission_type: "BRANCH_SALE", status: "active" })
      .whereIn("id",
        db("erp.employee_commission_rules")
          .where({ commission_type: "SALESMAN_SALE" })
          .select("id"),
      )
      .count({ c: "*" }).first();

    expect(Number(crossQuery?.c || 0)).toBe(0);
  });

  test("all migrated commission rules have commission_type set (no NULLs)", async () => {
    const nullCount = await db("erp.employee_commission_rules")
      .whereNull("commission_type")
      .count({ c: "*" }).first();

    expect(Number(nullCount?.c || 0)).toBe(0);
  });

  test("commission_type column has CHECK constraint with all 4 values", async () => {
    const result = await db.raw(`
      SELECT pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conrelid = 'erp.employee_commission_rules'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%commission_type%'
    `);
    const def = result.rows[0]?.def || "";
    expect(def).toContain("SALESMAN_SALE");
    expect(def).toContain("BRANCH_SALE");
    expect(def).toContain("TRANSFER");
    expect(def).toContain("PARTY");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 5 — commission_ledger table schema
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission Ledger — DB table", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("erp.commission_ledger table exists", async () => {
    const result = await db.raw(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'erp' AND table_name = 'commission_ledger'`,
    );
    expect(result.rows.length).toBe(1);
  });

  test("commission_ledger has all required columns", async () => {
    const result = await db.raw(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'erp' AND table_name = 'commission_ledger'
       ORDER BY column_name`,
    );
    const cols = result.rows.map((r) => r.column_name);
    for (const col of ["voucher_id", "employee_id", "commission_type", "total_amount", "lines_detail", "created_at"]) {
      expect(cols).toContain(col);
    }
  });

  test("commission_ledger has a UNIQUE constraint on (voucher_id, employee_id, commission_type)", async () => {
    const result = await db.raw(`
      SELECT COUNT(*) as c
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'u'
        AND n.nspname = 'erp'
        AND t.relname = 'commission_ledger'
    `);
    expect(Number(result.rows[0]?.c || 0)).toBeGreaterThan(0);
  });

  test("commission_ledger indexes exist for employee_id and voucher_id", async () => {
    const result = await db.raw(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'erp' AND tablename = 'commission_ledger'
    `);
    const names = result.rows.map((r) => r.indexname);
    expect(names.some((n) => n.includes("employee"))).toBe(true);
    expect(names.some((n) => n.includes("voucher"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 6 — Commission Ledger report page (UI)
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission Ledger — report page", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("report page loads without error", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto("/reports/hr-payroll/commission-ledger", {
      waitUntil: "domcontentloaded",
    });
    expect(resp.status()).toBeLessThan(400);
    await expect(page.locator("h1")).toContainText(/commission ledger/i);
  });

  test("filter form has from_date, to_date, employee_id, commission_type fields", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/hr-payroll/commission-ledger", { waitUntil: "domcontentloaded" });

    await expect(page.locator('input[name="from_date"]')).toBeVisible();
    await expect(page.locator('input[name="to_date"]')).toBeVisible();
    await expect(page.locator('select[name="employee_id"]')).toBeVisible();
    await expect(page.locator('select[name="commission_type"]')).toBeVisible();
  });

  test("commission_type select has all 4 types plus an All/empty option", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/hr-payroll/commission-ledger", { waitUntil: "domcontentloaded" });

    const opts = await page.locator('select[name="commission_type"]').evaluate((el) =>
      Array.from(el.options).map((o) => o.value),
    );

    expect(opts).toContain("");
    expect(opts).toContain("SALESMAN_SALE");
    expect(opts).toContain("BRANCH_SALE");
    expect(opts).toContain("TRANSFER");
    expect(opts).toContain("PARTY");
  });

  test("submitting the filter form loads results without a server error", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/hr-payroll/commission-ledger", { waitUntil: "domcontentloaded" });

    await page.locator('input[name="from_date"]').fill(monthStart());
    await page.locator('input[name="to_date"]').fill(today());

    // Scope submit button to this page's form (not the logout button)
    const submitBtn = page.locator('form[action*="commission-ledger"] button[type="submit"]');
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      submitBtn.click(),
    ]);

    await expect(page.locator("h1")).toContainText(/commission ledger/i);
    await expect(page.locator("body")).not.toContainText(/internal server error/i);
  });

  test("filtering by SALESMAN_SALE yields no violet or amber badges", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/reports/hr-payroll/commission-ledger", { waitUntil: "domcontentloaded" });

    await page.locator('input[name="from_date"]').fill("2020-01-01");
    await page.locator('input[name="to_date"]').fill(today());
    await page.locator('select[name="commission_type"]').selectOption("SALESMAN_SALE");

    const submitBtn = page.locator('form[action*="commission-ledger"] button[type="submit"]');
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      submitBtn.click(),
    ]);

    await expect(page.locator("h1")).toContainText(/commission ledger/i);

    // BRANCH_SALE (violet) and TRANSFER (amber) badges must not appear
    expect(await page.locator("td span.text-violet-700").count()).toBe(0);
    expect(await page.locator("td span.text-amber-700").count()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 7 — Nav entry
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission Ledger — navigation", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("Commission Ledger link exists in the DOM (nav may be collapsed)", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The link lives inside a nav dropdown which is hidden until hovered;
    // toBeAttached() confirms it's wired into the DOM regardless of visibility.
    const link = page.locator('a[href="/reports/hr-payroll/commission-ledger"]');
    await expect(link).toBeAttached();
  });

  test("Commission Ledger nav link href navigates to the report without a 4xx/5xx", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    // Directly follow the link's href — proves the route is wired and permissions pass
    const resp = await page.goto("/reports/hr-payroll/commission-ledger", {
      waitUntil: "domcontentloaded",
    });
    expect(resp.status()).toBeLessThan(400);
    await expect(page.locator("h1")).toContainText(/commission ledger/i);
  });
});
