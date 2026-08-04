// Browser coverage for the Recalculate Commission modal on the Sales Commission
// screen. The service and route layers are covered by the node scripts
// (test:commission-recalc:db, test:commission-recalc:approval); what only a real
// browser can prove is that the modal opens, the filters submit, the diff renders,
// the changed-only filter works, and the destructive orphan option is gated behind
// a confirmation.
//
//   npm run test:e2e:commission-recalc
//
// Applying is exercised against a throwaway sales voucher created in beforeAll and
// removed in afterAll, so no pre-existing commission is rewritten.
const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const SCREEN = "/hr-payroll/employees/commissions";
const db = createKnex(knexConfig);

const ctx = {
  voucherId: null,
  voucherNo: null,
  voucherDate: null,
  employeeId: null,
  employeeName: null,
  skuId: null,
  branchId: null,
  ruleId: null,
  createdRule: false,
};

test.beforeAll(async () => {
  // Reuse a real approved sale as the template so the fixture exercises the same
  // shape production data has (packed meta, total_pairs, sales_header salesman).
  const template = await db("erp.voucher_header as vh")
    .join("erp.sales_header as sh", "sh.voucher_id", "vh.id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .select(
      "vh.id",
      "vh.branch_id",
      "vh.created_by",
      db.raw("vh.voucher_date::text as voucher_date"),
      "sh.salesman_employee_id",
      "vl.sku_id",
      "vl.uom_id",
      "vl.qty",
      "vl.rate",
      "vl.amount",
      "vl.meta",
    )
    .where({
      "vh.voucher_type_code": "SALES_VOUCHER",
      "vh.status": "APPROVED",
      "vl.line_kind": "SKU",
    })
    .whereNotNull("sh.salesman_employee_id")
    .orderBy("vh.id", "desc")
    .first();

  test.skip(!template, "No approved sales voucher with a salesman in this database");

  ctx.employeeId = Number(template.salesman_employee_id);
  ctx.branchId = Number(template.branch_id);
  ctx.skuId = Number(template.sku_id);

  const employee = await db("erp.employees").select("name").where({ id: ctx.employeeId }).first();
  ctx.employeeName = employee?.name || "";

  // A rule must actually COVER this SKU. Having "some active rule" is not enough —
  // these salesmen typically hold dozens of SKU-scoped rules, none of which match
  // an arbitrary article, and the recompute would then correctly produce nothing.
  ctx.matchingRules = await db("erp.employee_commission_rules")
    .select("id", "status")
    .where({ employee_id: ctx.employeeId, commission_type: "SALESMAN_SALE" })
    .andWhere((qb) =>
      qb.where({ apply_on: "ALL" }).orWhere({ apply_on: "SKU", sku_id: ctx.skuId }),
    );

  if (!ctx.matchingRules.some((rule) => String(rule.status) === "active")) {
    const [row] = await db("erp.employee_commission_rules")
      .insert({
        employee_id: ctx.employeeId,
        apply_on: "SKU",
        sku_id: ctx.skuId,
        commission_type: "SALESMAN_SALE",
        commission_basis: "FIXED_PER_UNIT",
        rate_type: "PER_PAIR",
        value: 3,
        value_type: "FIXED",
        reverse_on_returns: true,
        status: "active",
      })
      .returning("id");
    ctx.ruleId = Number(row.id || row);
    ctx.createdRule = true;
    ctx.matchingRules.push({ id: ctx.ruleId, status: "active" });
  }

  // A dated-today voucher, so the test's date range can never collide with the
  // historical vouchers the other suites rely on.
  ctx.voucherDate = new Date().toISOString().slice(0, 10);
  const maxNo = await db("erp.voucher_header")
    .where({ voucher_type_code: "SALES_VOUCHER", branch_id: ctx.branchId })
    .max("voucher_no as m")
    .first();
  ctx.voucherNo = Number(maxNo?.m || 0) + 1;

  const [vh] = await db("erp.voucher_header")
    .insert({
      voucher_type_code: "SALES_VOUCHER",
      voucher_no: ctx.voucherNo,
      branch_id: ctx.branchId,
      voucher_date: ctx.voucherDate,
      status: "APPROVED",
      created_by: template.created_by,
      approved_by: template.created_by,
      approved_at: db.fn.now(),
    })
    .returning("id");
  ctx.voucherId = Number(vh.id || vh);

  // Clone the template's sales_header rather than hand-building one: the table
  // carries seven interlocking CHECK constraints (payment type vs received
  // amount, single buyer, walk-in name+phone, sale mode vs linked order), and a
  // copy satisfies all of them by construction.
  const templateSalesHeader = await db("erp.sales_header")
    .select("*")
    .where({ voucher_id: template.id })
    .first();
  await db("erp.sales_header").insert({
    ...templateSalesHeader,
    voucher_id: ctx.voucherId,
    salesman_employee_id: ctx.employeeId,
    linked_sales_order_id: null,
    sale_mode: "DIRECT",
  });

  await db("erp.voucher_line").insert({
    voucher_header_id: ctx.voucherId,
    line_no: 1,
    line_kind: "SKU",
    sku_id: ctx.skuId,
    uom_id: template.uom_id,
    qty: template.qty,
    rate: template.rate,
    amount: template.amount,
    meta: template.meta,
  });
});

test.afterAll(async () => {
  if (ctx.voucherId) {
    await db("erp.commission_ledger").where({ voucher_id: ctx.voucherId }).del();
    await db("erp.voucher_line").where({ voucher_header_id: ctx.voucherId }).del();
    await db("erp.sales_header").where({ voucher_id: ctx.voucherId }).del();
    await db("erp.voucher_header").where({ id: ctx.voucherId }).del();
  }
  if (ctx.createdRule && ctx.ruleId) {
    await db("erp.employee_commission_rules").where({ id: ctx.ruleId }).del();
  }
  await db.destroy();
});

const openModal = async (page) => {
  await page.goto(SCREEN, { waitUntil: "domcontentloaded" });
  await page.locator("[data-recalc-open]").click();
  await expect(page.locator("[data-recalc-modal]")).toBeVisible();
};

const runPreview = async (page) => {
  await page.locator("[data-recalc-from]").fill(ctx.voucherDate);
  await page.locator("[data-recalc-to]").fill(ctx.voucherDate);
  await page.locator("[data-recalc-employee]").selectOption(String(ctx.employeeId));
  await page.locator("[data-recalc-preview]").click();
  await expect(page.locator("[data-recalc-results]")).toBeVisible();
};

test.describe("Recalculate Commission", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  test("opens from the Sales Commission screen and shows the rate-date warning", async ({ page }) => {
    await openModal(page);
    // Rules have no effective dates, so this caveat must always be on screen.
    await expect(page.locator("[data-recalc-modal]")).toContainText(/rates active today/i);
  });

  test("accepts an arbitrary cycle range and offers no month picker", async ({ page }) => {
    await openModal(page);
    const from = page.locator("[data-recalc-from]");
    const to = page.locator("[data-recalc-to]");
    // A 26th-to-25th salary cycle is the whole reason this is not a month picker.
    await expect(from).toHaveAttribute("type", "date");
    await expect(to).toHaveAttribute("type", "date");
    await expect(page.locator("[data-recalc-modal] input[type='month']")).toHaveCount(0);

    await from.fill("2026-06-26");
    await to.fill("2026-07-25");
    await expect(from).toHaveValue("2026-06-26");
    await expect(to).toHaveValue("2026-07-25");
  });

  test("lists the rules that will be applied", async ({ page }) => {
    await openModal(page);
    await page.locator("[data-recalc-employee]").selectOption(String(ctx.employeeId));
    const rules = page.locator("[data-recalc-rules]");
    await expect(rules).toContainText("SALESMAN_SALE", { timeout: 10000 });
  });

  test("previews the fixture voucher with an old and new amount", async ({ page }) => {
    await openModal(page);
    await runPreview(page);

    const rows = page.locator("[data-recalc-rows] tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`#${ctx.voucherNo}`);
    await expect(page.locator("[data-recalc-summary]")).toContainText(/\d/);
    await expect(page.locator("[data-recalc-apply]")).toBeEnabled();
  });

  test("changed-only is on by default and toggling reveals unchanged rows", async ({ page }) => {
    await openModal(page);
    await runPreview(page);

    const changedOnly = page.locator("[data-recalc-changed-only]");
    await expect(changedOnly).toBeChecked();
    const changedCount = await page.locator("[data-recalc-rows] tr").count();

    await changedOnly.uncheck();
    const allCount = await page.locator("[data-recalc-rows] tr").count();
    expect(allCount).toBeGreaterThanOrEqual(changedCount);
  });

  test("preview is required before Apply becomes available", async ({ page }) => {
    await openModal(page);
    await expect(page.locator("[data-recalc-apply]")).toBeDisabled();
  });

  test("applying writes the commission and the employee ledger reflects it", async ({ page }) => {
    await openModal(page);
    await runPreview(page);

    const before = await db("erp.voucher_line")
      .where({ voucher_header_id: ctx.voucherId, line_kind: "EMPLOYEE" })
      .count("* as n")
      .first();
    expect(Number(before.n)).toBe(0);

    const skuBefore = await db("erp.voucher_line")
      .select("id", "qty", "rate", "amount")
      .where({ voucher_header_id: ctx.voucherId, line_kind: "SKU" })
      .orderBy("line_no", "asc");

    await page.locator("[data-recalc-apply]").click();
    await expect(page.locator("[data-recalc-success]")).toBeVisible();

    const after = await db("erp.voucher_line")
      .select("amount", "meta")
      .where({ voucher_header_id: ctx.voucherId, line_kind: "EMPLOYEE" });
    const auto = after.filter((line) => line.meta?.auto_sales_commission === true);
    expect(auto).toHaveLength(1);
    expect(Number(auto[0].amount)).toBeGreaterThan(0);
    // Provenance is what makes a bad recompute traceable without effective dates.
    expect(auto[0].meta?.commission_recalc?.source).toBe("commission-recalc-screen");

    // Sales GL is derived from the sum of SKU line amounts, so leaving those
    // untouched is what makes a commission rewrite GL-neutral. (GL rows being
    // byte-identical is asserted directly, on a voucher that has real GL entries,
    // by npm run test:commission-recalc:db.)
    const skuAfter = await db("erp.voucher_line")
      .select("id", "qty", "rate", "amount")
      .where({ voucher_header_id: ctx.voucherId, line_kind: "SKU" })
      .orderBy("line_no", "asc");
    expect(skuAfter).toEqual(skuBefore);
  });

  test("clearing unmatched commission requires an explicit confirmation", async ({ page }) => {
    // Deactivate only the rules that cover this SKU, so the fixture's stored
    // commission becomes unmatched. Every one is restored to its ORIGINAL status
    // afterwards — blanket-activating would silently enable rules that were
    // deliberately inactive before the test ran.
    await db("erp.employee_commission_rules")
      .whereIn("id", ctx.matchingRules.map((rule) => rule.id))
      .update({ status: "inactive" });

    try {
      await openModal(page);
      await runPreview(page);

      const band = page.locator("[data-recalc-orphan-band]");
      await expect(band).toBeVisible();
      const clearBox = page.locator("[data-recalc-clear-orphans]");
      await expect(clearBox).not.toBeChecked();

      await clearBox.check();
      await expect(page.locator("[data-recalc-results]")).toBeVisible();

      // Dismissing the confirmation must leave the stored commission alone.
      page.once("dialog", (dialog) => dialog.dismiss());
      const confirmModal = page.locator("[data-confirm-modal]");
      await page.locator("[data-recalc-apply]").click();
      if (await confirmModal.isVisible().catch(() => false)) {
        await confirmModal.getByRole("button", { name: /cancel|منسوخ/i }).click();
      }

      const stillThere = await db("erp.voucher_line")
        .select("amount", "meta")
        .where({ voucher_header_id: ctx.voucherId, line_kind: "EMPLOYEE" });
      const auto = stillThere.filter((line) => line.meta?.auto_sales_commission === true);
      expect(auto).toHaveLength(1);
      expect(Number(auto[0].amount)).toBeGreaterThan(0);
    } finally {
      for (const rule of ctx.matchingRules) {
        await db("erp.employee_commission_rules")
          .where({ id: rule.id })
          .update({ status: rule.status });
      }
    }
  });
});
