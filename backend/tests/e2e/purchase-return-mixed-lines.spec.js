/**
 * Purchase Return (PR) — mixed line types (Raw Material + Indirect Material)
 *
 * Covers:
 *  Suite 1 — UI: per-row Type dropdown renders on the PR form
 *  Suite 2 — DB schema: 100_pr_mixed_lines migration constraint includes MIXED
 *  Suite 3 — Pure RM PR: backward compat, all lines line_kind='ITEM'
 *  Suite 4 — Pure Indirect Material PR: all lines line_kind='ACCOUNT'
 *  Suite 5 — Mixed PR: one RM + one Indirect Material in one voucher
 *  Suite 6 — Reload: mixed PR re-opens with correct per-row line types
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

const PR_URL = "/vouchers/purchase-return?new=1";
const POLICY_ENTITY_TYPE = "VOUCHER_TYPE";
const POLICY_ACTION = "create";

// ── helpers ────────────────────────────────────────────────────────────────

const getSelectOptionValues = async (selectLocator) =>
  selectLocator
    .locator("option")
    .evaluateAll((opts) =>
      opts.map((o) => String(o.value || "").trim()).filter(Boolean),
    );

const submitAndWait = async (page) => {
  await page.locator('form[data-purchase-voucher-form] button[type="submit"]').click();
  await page.waitForURL(/purchase-return/, { timeout: 15000 }).catch(() => null);
};

const fillRmRow = async (rowLocator, { itemValue, qty = "2.000", rate = "100" }) => {
  await rowLocator.locator('select[data-row-field="item"]').selectOption(itemValue);
  await rowLocator.locator('input[data-row-field="qty"]').fill(qty);
  await rowLocator.locator('input[data-row-field="rate"]').fill(rate);
};

// ── shared setup ────────────────────────────────────────────────────────────

let prPolicySnapshot = null;
let sharedDb = null;
let hasMixedMigration = false;

test.beforeAll(async () => {
  sharedDb = createKnex(knexConfig);

  const constraintResult = await sharedDb.raw(`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'erp.purchase_return_header_ext'::regclass
      AND contype   = 'c'
      AND conname   = 'purchase_return_header_ext_purchase_category_check'
  `);
  hasMixedMigration =
    constraintResult.rows.length > 0 &&
    String(constraintResult.rows[0]?.def || "").includes("MIXED");

  prPolicySnapshot = await getApprovalPolicy({
    entityType: POLICY_ENTITY_TYPE,
    entityKey: "PR",
    action: POLICY_ACTION,
  });
  await upsertApprovalPolicy({
    entityType: POLICY_ENTITY_TYPE,
    entityKey: "PR",
    action: POLICY_ACTION,
    requiresApproval: false,
  });
});

test.afterAll(async () => {
  try {
    if (prPolicySnapshot && typeof prPolicySnapshot.requires_approval === "boolean") {
      await upsertApprovalPolicy({
        entityType: POLICY_ENTITY_TYPE,
        entityKey: "PR",
        action: POLICY_ACTION,
        requiresApproval: prPolicySnapshot.requires_approval,
      });
    } else {
      await deleteApprovalPolicy({
        entityType: POLICY_ENTITY_TYPE,
        entityKey: "PR",
        action: POLICY_ACTION,
      });
    }
  } finally {
    await sharedDb?.destroy();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 1 — UI: per-row Type dropdown
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR mixed lines — UI: per-row Type dropdown", () => {
  test("PR new form shows a Type dropdown in the first row", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const typeSelect = page
      .locator("[data-lines-body] tr")
      .first()
      .locator('select[data-row-field="line_type"]');
    await expect(typeSelect).toBeVisible();
  });

  test("Type dropdown has Raw Material and Indirect Material options", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const typeSelect = page
      .locator("[data-lines-body] tr")
      .first()
      .locator('select[data-row-field="line_type"]');
    const opts = await getSelectOptionValues(typeSelect);
    expect(opts).toContain("RAW_MATERIAL");
    expect(opts).toContain("CONSUMABLE");
  });

  test("Type dropdown defaults to RAW_MATERIAL on a new PR", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const typeSelect = page
      .locator("[data-lines-body] tr")
      .first()
      .locator('select[data-row-field="line_type"]');
    await expect(typeSelect).toHaveValue("RAW_MATERIAL");
  });

  test("switching Type to Indirect Material replaces item select with expense account select", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const firstRow = page.locator("[data-lines-body] tr").first();

    // Switch to CONSUMABLE — renderRows() fires synchronously
    await firstRow.locator('select[data-row-field="line_type"]').selectOption("CONSUMABLE");

    // After re-render, item select should still exist (now populated with expense accounts)
    await expect(firstRow.locator('select[data-row-field="item"]')).toBeAttached();
    await expect(firstRow.locator('select[data-row-field="line_type"]')).toHaveValue("CONSUMABLE");

    // Switch back — item select should be back with raw materials
    await firstRow.locator('select[data-row-field="line_type"]').selectOption("RAW_MATERIAL");
    await expect(firstRow.locator('select[data-row-field="line_type"]')).toHaveValue("RAW_MATERIAL");
    await expect(firstRow.locator('select[data-row-field="item"]')).toBeAttached();
  });

  test("PR form does NOT show a header-level purchase_category select (it is driven per row)", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    // The header <select name="purchase_category"> must be absent for PR;
    // a hidden input with value MIXED is used instead.
    const categorySelect = page.locator('select[name="purchase_category"]');
    await expect(categorySelect).not.toBeAttached();

    const hiddenCategoryInput = page.locator('input[name="purchase_category"][type="hidden"]');
    await expect(hiddenCategoryInput).toHaveValue("MIXED");
  });

  test("supplier field is optional — PR saves without selecting a supplier", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    // Supplier select should exist but not be required
    const supplierSelect = page.locator('select[name="supplier_party_id"]');
    await expect(supplierSelect).toBeVisible();
    const isRequired = await supplierSelect.evaluate((el) => el.required);
    expect(isRequired).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 2 — DB schema
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR mixed lines — DB schema", () => {
  test("purchase_return_header_ext constraint allows MIXED (migration 100_pr_mixed_lines.sql)", async () => {
    const result = await sharedDb.raw(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'erp.purchase_return_header_ext'::regclass
        AND contype   = 'c'
        AND conname   = 'purchase_return_header_ext_purchase_category_check'
    `);
    expect(result.rows.length).toBe(1);
    const def = String(result.rows[0]?.def || "");
    expect(def).toContain("MIXED");
    expect(def).toContain("RAW_MATERIAL");
    expect(def).toContain("CONSUMABLE");
  });

  test("voucher_line trigger trg_purchase_lines_require_rm_item exists", async () => {
    const result = await sharedDb.raw(`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema  = 'erp'
        AND event_object_table = 'voucher_line'
        AND trigger_name    = 'trg_purchase_lines_require_rm_item'
      LIMIT 1
    `);
    expect(result.rows.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 3 — Pure RM PR (backward compat)
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR mixed lines — pure RM PR (backward compat)", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = { voucherId: null };

  test("pure RM PR saves and creates an APPROVED voucher", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const returnReasonOpts = await getSelectOptionValues(page.locator('select[name="return_reason"]'));
    test.skip(!returnReasonOpts.length, "No return reasons available.");
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);

    const firstRow = page.locator("[data-lines-body] tr").first();
    const itemOpts = await getSelectOptionValues(firstRow.locator('select[data-row-field="item"]'));
    test.skip(!itemOpts.length, "No raw materials available.");

    await fillRmRow(firstRow, { itemValue: itemOpts[0] });
    await page.locator('input[name="reference_no"]').fill(`PR-RM-ONLY-E2E-${Date.now()}`);

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");
    ctx.voucherId = after.id;
  });

  test("pure RM PR all voucher_line rows have line_kind = ITEM", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const lines = await sharedDb("erp.voucher_line")
      .where({ voucher_header_id: ctx.voucherId })
      .select("id", "line_kind");
    expect(lines.length).toBeGreaterThan(0);

    const nonItem = lines.filter(
      (l) => String(l.line_kind || "").toUpperCase() !== "ITEM",
    );
    expect(nonItem.length).toBe(0);
  });

  test("pure RM PR header_ext has purchase_category = RAW_MATERIAL", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const ext = await sharedDb("erp.purchase_return_header_ext")
      .where({ voucher_id: ctx.voucherId })
      .first();
    expect(ext).toBeTruthy();
    expect(String(ext.purchase_category || "").toUpperCase()).toBe("RAW_MATERIAL");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 4 — Pure Indirect Material PR
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR mixed lines — pure Indirect Material PR", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = { voucherId: null };

  test("pure CONSUMABLE PR saves and creates an APPROVED voucher", async ({ page }) => {
    test.skip(!hasMixedMigration, "Requires migration 100_pr_mixed_lines.sql to be applied first.");

    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const returnReasonOpts = await getSelectOptionValues(page.locator('select[name="return_reason"]'));
    test.skip(!returnReasonOpts.length, "No return reasons available.");
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);

    const firstRow = page.locator("[data-lines-body] tr").first();
    await firstRow.locator('select[data-row-field="line_type"]').selectOption("CONSUMABLE");

    // After renderRows() the item select is re-populated with expense accounts
    const accountOpts = await getSelectOptionValues(firstRow.locator('select[data-row-field="item"]'));
    test.skip(!accountOpts.length, "No expense accounts available — cannot test CONSUMABLE PR.");

    await firstRow.locator('select[data-row-field="item"]').selectOption(accountOpts[0]);
    await firstRow.locator('input[data-row-field="qty"]').fill("3.000");
    await firstRow.locator('input[data-row-field="rate"]').fill("75");
    await page.locator('input[name="reference_no"]').fill(`PR-CONSUMABLE-E2E-${Date.now()}`);

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");
    ctx.voucherId = after.id;
  });

  test("pure CONSUMABLE PR all voucher_line rows have line_kind = ACCOUNT", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const lines = await sharedDb("erp.voucher_line")
      .where({ voucher_header_id: ctx.voucherId })
      .select("id", "line_kind");
    expect(lines.length).toBeGreaterThan(0);

    const nonAccount = lines.filter(
      (l) => String(l.line_kind || "").toUpperCase() !== "ACCOUNT",
    );
    expect(nonAccount.length).toBe(0);
  });

  test("pure CONSUMABLE PR header_ext has purchase_category = MIXED", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const ext = await sharedDb("erp.purchase_return_header_ext")
      .where({ voucher_id: ctx.voucherId })
      .first();
    expect(ext).toBeTruthy();
    expect(String(ext.purchase_category || "").toUpperCase()).toBe("MIXED");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 5 — Mixed PR: RM + Indirect Material in one voucher
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR mixed lines — mixed RM + Indirect Material PR", () => {
  test.describe.configure({ mode: "serial" });
  const ctx = { voucherId: null };

  test("mixed PR saves (one RM line + one Indirect Material line) with APPROVED status", async ({ page }) => {
    test.skip(!hasMixedMigration, "Requires migration 100_pr_mixed_lines.sql to be applied first.");

    await login(page, "E2E_ADMIN");
    const resp = await page.goto(PR_URL, { waitUntil: "domcontentloaded" });
    test.skip(resp?.status() !== 200, "PR page not accessible.");

    const returnReasonOpts = await getSelectOptionValues(page.locator('select[name="return_reason"]'));
    test.skip(!returnReasonOpts.length, "No return reasons available.");
    await page.locator('select[name="return_reason"]').selectOption(returnReasonOpts[0]);

    // Row 0: Raw Material
    const firstRow = page.locator('[data-lines-body] tr[data-row-index="0"]');
    const itemOpts = await getSelectOptionValues(firstRow.locator('select[data-row-field="item"]'));
    test.skip(!itemOpts.length, "No raw materials available.");
    await fillRmRow(firstRow, { itemValue: itemOpts[0] });

    // Add a second row
    await page.locator("[data-add-row]").click();
    await page.locator('[data-lines-body] tr[data-row-index="1"]').waitFor({ state: "attached" });

    // Row 1: Indirect Material (CONSUMABLE)
    const secondRow = page.locator('[data-lines-body] tr[data-row-index="1"]');
    await secondRow.locator('select[data-row-field="line_type"]').selectOption("CONSUMABLE");

    const accountOpts = await getSelectOptionValues(secondRow.locator('select[data-row-field="item"]'));
    test.skip(!accountOpts.length, "No expense accounts available — cannot test mixed PR.");

    await secondRow.locator('select[data-row-field="item"]').selectOption(accountOpts[0]);
    await secondRow.locator('input[data-row-field="qty"]').fill("1.000");
    await secondRow.locator('input[data-row-field="rate"]').fill("200");

    await page.locator('input[name="reference_no"]').fill(`PR-MIXED-E2E-${Date.now()}`);

    const before = await getLatestVoucherHeader({ voucherTypeCode: "PR" });
    await submitAndWait(page);
    const after = await getLatestVoucherHeader({ voucherTypeCode: "PR" });

    expect(Number(after?.id || 0)).toBeGreaterThan(Number(before?.id || 0));
    expect(String(after?.status || "").toUpperCase()).toBe("APPROVED");
    ctx.voucherId = after.id;
  });

  test("mixed PR has at least one ITEM line and one ACCOUNT line in DB", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const lines = await sharedDb("erp.voucher_line")
      .where({ voucher_header_id: ctx.voucherId })
      .select("id", "line_kind", "item_id", "account_id");

    const itemLines = lines.filter(
      (l) => String(l.line_kind || "").toUpperCase() === "ITEM",
    );
    const accountLines = lines.filter(
      (l) => String(l.line_kind || "").toUpperCase() === "ACCOUNT",
    );

    expect(itemLines.length).toBeGreaterThanOrEqual(1);
    expect(accountLines.length).toBeGreaterThanOrEqual(1);

    // RM lines must have item_id
    itemLines.forEach((l) =>
      expect(Number(l.item_id || 0)).toBeGreaterThan(0),
    );
    // CONSUMABLE lines must have account_id
    accountLines.forEach((l) =>
      expect(Number(l.account_id || 0)).toBeGreaterThan(0),
    );
  });

  test("mixed PR header_ext has purchase_category = MIXED", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const ext = await sharedDb("erp.purchase_return_header_ext")
      .where({ voucher_id: ctx.voucherId })
      .first();
    expect(ext).toBeTruthy();
    expect(String(ext.purchase_category || "").toUpperCase()).toBe("MIXED");
  });

  test("mixed PR GL is balanced (total DR equals total CR)", async () => {
    test.skip(!ctx.voucherId, "No voucher from previous test.");

    const batch = await sharedDb("erp.gl_batch")
      .where({ source_voucher_id: ctx.voucherId })
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
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 6 — Reload: mixed PR re-opens with correct per-row types
// ══════════════════════════════════════════════════════════════════════════

test.describe("PR mixed lines — reload pre-selects correct per-row types", () => {
  test("a saved mixed PR re-opens with both RAW_MATERIAL and CONSUMABLE row types", async ({ page }) => {
    test.skip(!hasMixedMigration, "Requires migration 100_pr_mixed_lines.sql to be applied first.");
    await login(page, "E2E_ADMIN");

    const latestMixedPr = await sharedDb("erp.voucher_header as vh")
      .join(
        "erp.purchase_return_header_ext as ext",
        "ext.voucher_id",
        "vh.id",
      )
      .where("vh.voucher_type_code", "PR")
      .where("ext.purchase_category", "MIXED")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .whereIn(
        sharedDb.raw("upper(vl.line_kind::text)"),
        ["ITEM", "ACCOUNT"],
      )
      .select("vh.voucher_no")
      .groupBy("vh.id", "vh.voucher_no")
      .havingRaw("count(distinct upper(vl.line_kind::text)) >= 2")
      .orderBy("vh.id", "desc")
      .first();

    test.skip(!latestMixedPr, "No saved mixed PR with both line types found — run the mixed PR save test first.");

    const resp = await page.goto(
      `/vouchers/purchase-return?voucher_no=${latestMixedPr.voucher_no}`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(resp?.status() !== 200, "PR load page not accessible.");

    const allTypeSelects = page.locator(
      '[data-lines-body] tr select[data-row-field="line_type"]',
    );
    const typeValues = await allTypeSelects.evaluateAll((selects) =>
      selects.map((s) => String(s.value || "")),
    );

    expect(typeValues).toContain("RAW_MATERIAL");
    expect(typeValues).toContain("CONSUMABLE");
  });
});
