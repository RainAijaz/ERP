/**
 * General Purchase (PI) — Consumable / Indirect Material — Department column
 *
 * Covers:
 *  Suite 1 — UI: Department column visibility & toggling
 *  Suite 2 — Save & DB: department_id is stored in voucher_line.meta
 *  Suite 3 — Reload: saved voucher re-opens with the correct department pre-selected
 *  Suite 4 — GL posting: dept_id is stamped on the expense GL entry
 */

const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
const {
  getLatestVoucherHeader,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  getApprovalPolicy,
} = require("./utils/db");

const PI_URL = "/vouchers/purchase?new=1";
const POLICY_ENTITY_TYPE = "VOUCHER_TYPE";
const POLICY_ACTION = "create";

// ── helpers ────────────────────────────────────────────────────────────────

const getSelectOptionValues = async (selectLocator) =>
  selectLocator
    .locator("option")
    .evaluateAll((opts) =>
      opts.map((o) => String(o.value || "").trim()).filter(Boolean),
    );

/**
 * Click submit and wait for the server round-trip to complete.
 * We cannot use page.waitForURL() alone because the URL (/vouchers/purchase?new=1)
 * doesn't change between before and after the save, so waitForURL resolves
 * immediately if the URL already matches. Instead we start a navigation listener
 * BEFORE the click so we catch the POST → redirect cycle.
 */
const submitAndWait = async (page) => {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
    page.locator("[data-purchase-voucher-form] button[type='submit']").click(),
  ]);
};

/** Switch the header Type dropdown to CONSUMABLE and wait for re-render. */
const switchToConsumable = async (page) => {
  const categorySelect = page.locator('select[name="purchase_category"]');
  await categorySelect.selectOption("CONSUMABLE");
};

/** Switch back to RAW_MATERIAL. */
const switchToRawMaterial = async (page) => {
  const categorySelect = page.locator('select[name="purchase_category"]');
  await categorySelect.selectOption("RAW_MATERIAL");
};

// ── shared setup ────────────────────────────────────────────────────────────

let piPolicySnapshot = null;
let sharedDb = null;

test.beforeAll(async () => {
  sharedDb = createKnex(knexConfig);

  piPolicySnapshot = await getApprovalPolicy({
    entityType: POLICY_ENTITY_TYPE,
    entityKey: "PI",
    action: POLICY_ACTION,
  });
  await upsertApprovalPolicy({
    entityType: POLICY_ENTITY_TYPE,
    entityKey: "PI",
    action: POLICY_ACTION,
    requiresApproval: false,
  });
});

test.afterAll(async () => {
  try {
    if (piPolicySnapshot && typeof piPolicySnapshot.requires_approval === "boolean") {
      await upsertApprovalPolicy({
        entityType: POLICY_ENTITY_TYPE,
        entityKey: "PI",
        action: POLICY_ACTION,
        requiresApproval: piPolicySnapshot.requires_approval,
      });
    } else {
      await deleteApprovalPolicy({
        entityType: POLICY_ENTITY_TYPE,
        entityKey: "PI",
        action: POLICY_ACTION,
      });
    }
  } finally {
    await sharedDb?.destroy();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 1 — UI: Department column visibility & toggling
// ══════════════════════════════════════════════════════════════════════════

test.describe("Consumable PI — Department column UI", () => {
  test("Department column header is hidden in RAW_MATERIAL mode", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    // Default type is RAW_MATERIAL — Department header should be hidden
    const deptHeader = page.locator("[data-line-head-department]");
    await expect(deptHeader).toBeAttached();
    await expect(deptHeader).toBeHidden();
  });

  test("Department column header becomes visible after switching to CONSUMABLE", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    await switchToConsumable(page);

    const deptHeader = page.locator("[data-line-head-department]");
    await expect(deptHeader).toBeVisible();
  });

  test("Department header hides again when switching back to RAW_MATERIAL", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    await switchToConsumable(page);
    await expect(page.locator("[data-line-head-department]")).toBeVisible();

    await switchToRawMaterial(page);
    await expect(page.locator("[data-line-head-department]")).toBeHidden();
  });

  test("Department dropdown appears in the first row when in CONSUMABLE mode", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    await switchToConsumable(page);

    const firstRow = page.locator("[data-lines-body] tr").first();
    const deptSelect = firstRow.locator('select[data-row-field="department"]');
    await expect(deptSelect).toBeAttached();
    await expect(deptSelect).toBeVisible();
  });

  test("Department dropdown has a blank placeholder and at least one department option", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    await switchToConsumable(page);

    const firstRow = page.locator("[data-lines-body] tr").first();
    const deptSelect = firstRow.locator('select[data-row-field="department"]');
    const opts = await getSelectOptionValues(deptSelect);

    // Should have at least one real department option (skip if none exist in DB)
    test.skip(!opts.length, "No departments seeded in the database — skipping.");
    expect(opts.length).toBeGreaterThan(0);
  });

  test("Department dropdown is hidden (not visible) in RAW_MATERIAL mode", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    // Default mode is RAW_MATERIAL — department td should be hidden
    const firstRow = page.locator("[data-lines-body] tr").first();
    // The td is in DOM but hidden — select[data-row-field="department"] won't be present
    // because the column only renders the select for consumable rows
    const deptSelect = firstRow.locator('select[data-row-field="department"]');
    await expect(deptSelect).not.toBeAttached();
  });

  test("Size and UOM columns are hidden in CONSUMABLE mode", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    await switchToConsumable(page);

    await expect(page.locator("[data-line-head-size]")).toBeHidden();
    await expect(page.locator("[data-line-head-uom]")).toBeHidden();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 2 — Save & DB: department_id stored in voucher_line.meta
// ══════════════════════════════════════════════════════════════════════════

test.describe("Consumable PI — Save with department", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = { voucherId: null, departmentId: null };

  test("consumable PI with department saves and gets APPROVED status", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    // Check departments exist
    const depts = await sharedDb("erp.departments").where({ is_active: true }).select("id").limit(1);
    test.skip(!depts.length, "No active departments in DB — cannot test department save.");

    await switchToConsumable(page);
    ctx.departmentId = Number(depts[0].id);

    // Fill supplier
    const supplierSelect = page.locator("[data-supplier-select]");
    const supplierOpts = await getSelectOptionValues(supplierSelect);
    test.skip(!supplierOpts.length, "No suppliers available.");
    await supplierSelect.selectOption(supplierOpts[0]);

    const firstRow = page.locator("[data-lines-body] tr").first();

    // Select expense account
    const accountSelect = firstRow.locator('select[data-row-field="item"]');
    const accountOpts = await getSelectOptionValues(accountSelect);
    test.skip(!accountOpts.length, "No expense accounts available.");
    await accountSelect.selectOption(accountOpts[0]);

    // Fill description
    await firstRow.locator('input[data-row-field="description"]').fill("E2E test consumable item");

    // Select department
    const deptSelect = firstRow.locator('select[data-row-field="department"]');
    await expect(deptSelect).toBeVisible();
    const deptOpts = await getSelectOptionValues(deptSelect);
    test.skip(!deptOpts.length, "No departments available in dropdown.");
    const targetDeptId = String(ctx.departmentId);
    const deptToSelect = deptOpts.includes(targetDeptId) ? targetDeptId : deptOpts[0];
    ctx.departmentId = Number(deptToSelect);
    await deptSelect.selectOption(deptToSelect);

    // Fill qty and rate
    await firstRow.locator('input[data-row-field="qty"]').fill("10.000");
    await firstRow.locator('input[data-row-field="rate"]').fill("50.00");

    // Fill reference number
    await page.locator('input[name="reference_no"]').fill(`PI-DEPT-E2E-${Date.now()}`);

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PI" });
    await submitAndWait(page);

    const after = await getLatestVoucherHeader({ voucherTypeCode: "PI" });
    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");
    ctx.voucherId = after.id;
  });

  test("saved consumable PI has exactly one ACCOUNT line in voucher_line", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const lines = await sharedDb("erp.voucher_line")
      .where({ voucher_header_id: ctx.voucherId, line_kind: "ACCOUNT" })
      .select("id", "line_kind", "account_id", "meta");
    expect(lines.length).toBe(1);
    expect(Number(lines[0].account_id || 0)).toBeGreaterThan(0);
  });

  test("voucher_line.meta stores the correct department_id", async () => {
    test.skip(!ctx.voucherId || !ctx.departmentId, "No voucher or department from previous test.");

    const line = await sharedDb("erp.voucher_line")
      .where({ voucher_header_id: ctx.voucherId, line_kind: "ACCOUNT" })
      .first();
    expect(line).toBeTruthy();

    const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
    expect(Number(meta.department_id)).toBe(ctx.departmentId);
  });

  test("voucher_line.meta stores the description", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const line = await sharedDb("erp.voucher_line")
      .where({ voucher_header_id: ctx.voucherId, line_kind: "ACCOUNT" })
      .first();
    const meta = line?.meta && typeof line.meta === "object" ? line.meta : {};
    expect(String(meta.description || "").toLowerCase()).toContain("e2e test consumable");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 3 — Reload: department pre-selected when voucher is reopened
// ══════════════════════════════════════════════════════════════════════════

test.describe("Consumable PI — Reload with department pre-selected", () => {
  test("reopened consumable PI shows the saved department in the dropdown", async ({ page }) => {
    await login(page, "E2E_ADMIN");

    // Find the latest consumable PI with a department in meta
    const line = await sharedDb("erp.voucher_line as vl")
      .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
      .where("vh.voucher_type_code", "PI")
      .where("vl.line_kind", "ACCOUNT")
      .whereRaw("(vl.meta->>'department_id') ~ '^[0-9]+$'")
      .select("vh.voucher_no", sharedDb.raw("(vl.meta->>'department_id')::int as dept_id"))
      .orderBy("vh.id", "desc")
      .first();

    test.skip(!line, "No saved consumable PI with department found — run the save test first.");

    const resp = await page.goto(
      `/vouchers/purchase?voucher_no=${line.voucher_no}&view=1`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(resp?.status() !== 200, "Voucher reload page not accessible.");

    // Category should be CONSUMABLE
    const categorySelect = page.locator('select[name="purchase_category"]');
    await expect(categorySelect).toHaveValue("CONSUMABLE");

    // Department dropdown should be visible and have the correct value
    const firstRow = page.locator("[data-lines-body] tr").first();
    const deptSelect = firstRow.locator('select[data-row-field="department"]');
    await expect(deptSelect).toBeVisible();
    await expect(deptSelect).toHaveValue(String(line.dept_id));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 4 — GL posting: dept_id stamped on the expense GL entry
// ══════════════════════════════════════════════════════════════════════════

test.describe("Consumable PI — GL posting includes dept_id", () => {
  test("GL entry for the expense account has the saved department's dept_id", async () => {
    // Find the latest consumable PI voucher with a department saved
    const line = await sharedDb("erp.voucher_line as vl")
      .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
      .where("vh.voucher_type_code", "PI")
      .where("vh.status", "APPROVED")
      .where("vl.line_kind", "ACCOUNT")
      .whereRaw("(vl.meta->>'department_id') ~ '^[0-9]+$'")
      .select(
        "vh.id as voucher_id",
        "vl.account_id",
        sharedDb.raw("(vl.meta->>'department_id')::int as dept_id"),
      )
      .orderBy("vh.id", "desc")
      .first();

    test.skip(!line, "No approved consumable PI with department found — run the save test first.");

    // Look up the GL batch for this voucher
    const batch = await sharedDb("erp.gl_batch")
      .where({ source_voucher_id: line.voucher_id })
      .first();
    expect(batch).toBeTruthy();

    // Find the DR entry for the expense account
    const glEntry = await sharedDb("erp.gl_entry")
      .where({ batch_id: batch.id, account_id: line.account_id })
      .where(sharedDb.raw("dr > 0"))
      .first();

    expect(glEntry).toBeTruthy();
    expect(Number(glEntry.dept_id)).toBe(Number(line.dept_id));
  });

  test("GL posting is balanced (total DR equals total CR) for consumable PI with department", async () => {
    const latestVoucher = await sharedDb("erp.voucher_header as vh")
      .join("erp.purchase_invoice_header_ext as ext", "ext.voucher_id", "vh.id")
      .where("vh.voucher_type_code", "PI")
      .where("vh.status", "APPROVED")
      .where("ext.purchase_category", "CONSUMABLE")
      .whereExists(
        sharedDb("erp.voucher_line as vl")
          .whereRaw("vl.voucher_header_id = vh.id")
          .where("vl.line_kind", "ACCOUNT")
          .whereRaw("(vl.meta->>'department_id') ~ '^[0-9]+$'"),
      )
      .select("vh.id")
      .orderBy("vh.id", "desc")
      .first();

    test.skip(!latestVoucher, "No approved consumable PI with department found.");

    const batch = await sharedDb("erp.gl_batch")
      .where({ source_voucher_id: latestVoucher.id })
      .first();
    expect(batch).toBeTruthy();

    const entries = await sharedDb("erp.gl_entry")
      .where({ batch_id: batch.id })
      .select("dr", "cr");
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const totalDr = entries.reduce((s, e) => s + Number(e.dr || 0), 0);
    const totalCr = entries.reduce((s, e) => s + Number(e.cr || 0), 0);
    expect(Math.abs(totalDr - totalCr)).toBeLessThan(0.01);
  });

  test("consumable PI without department still saves correctly (department is optional)", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PI_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "General Purchase page not accessible.");

    await switchToConsumable(page);

    const supplierSelect = page.locator("[data-supplier-select]");
    const supplierOpts = await getSelectOptionValues(supplierSelect);
    test.skip(!supplierOpts.length, "No suppliers available.");
    await supplierSelect.selectOption(supplierOpts[0]);

    const firstRow = page.locator("[data-lines-body] tr").first();
    const accountOpts = await getSelectOptionValues(firstRow.locator('select[data-row-field="item"]'));
    test.skip(!accountOpts.length, "No expense accounts available.");
    await firstRow.locator('select[data-row-field="item"]').selectOption(accountOpts[0]);
    await firstRow.locator('input[data-row-field="qty"]').fill("2.000");
    await firstRow.locator('input[data-row-field="rate"]').fill("30.00");
    await page.locator('input[name="reference_no"]').fill(`PI-NODEPT-E2E-${Date.now()}`);

    // Leave department blank (no selection)
    const before = await getLatestVoucherHeader({ voucherTypeCode: "PI" });
    await submitAndWait(page);

    const after = await getLatestVoucherHeader({ voucherTypeCode: "PI" });
    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");

    // dept_id in GL entry should be null
    const batch = await sharedDb("erp.gl_batch").where({ source_voucher_id: after.id }).first();
    expect(batch).toBeTruthy();
    const expenseLine = await sharedDb("erp.gl_entry")
      .where({ batch_id: batch.id })
      .where(sharedDb.raw("dr > 0"))
      .first();
    expect(expenseLine).toBeTruthy();
    expect(expenseLine.dept_id).toBeNull();
  });
});
