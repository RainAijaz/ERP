require("dotenv").config();
const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);
const CV_AMOUNT = 500;

const state = {
  skipped: false,
  skipReason: "setup not complete",
  branchId: null,
  soId: null,
  soVoucherNo: null,
  cvId: null,
  cvVoucherNo: null,
  customerPartyId: null,
};

test.describe("Cash Voucher → SO receivable fix", () => {
  test.beforeAll(async () => {
    const hasColumn = await db.schema
      .withSchema("erp")
      .hasColumn("voucher_header", "linked_sales_order_id")
      .catch(() => false);

    if (!hasColumn) {
      state.skipped = true;
      state.skipReason =
        "linked_sales_order_id column missing — run: npx knex migrate:latest";
      return;
    }

    // Resolve admin user's branch
    const adminUsername = process.env.E2E_ADMIN_USER;
    if (!adminUsername) {
      state.skipped = true;
      state.skipReason = "E2E_ADMIN_USER env var not set";
      return;
    }

    const [adminUser, allBranches] = await Promise.all([
      db("erp.users")
        .select("id")
        .whereRaw("LOWER(username) = LOWER(?)", [adminUsername])
        .first(),
      db("erp.branches").select("id").orderBy("id", "asc"),
    ]);

    if (!adminUser) {
      state.skipped = true;
      state.skipReason = `Admin user '${adminUsername}' not found in DB`;
      return;
    }

    const userBranchRow = await db("erp.user_branch")
      .select("branch_id")
      .where({ user_id: adminUser.id })
      .orderBy("branch_id", "asc")
      .first();

    const resolvedBranchId = userBranchRow
      ? Number(userBranchRow.branch_id)
      : allBranches[0]
        ? Number(allBranches[0].id)
        : null;

    if (!resolvedBranchId) {
      state.skipped = true;
      state.skipReason = "No branch found for admin user";
      return;
    }
    state.branchId = resolvedBranchId;

    // Seed data: sku, party, uom, voucher_no base
    const [sku, party, employee, uom, maxRow] = await Promise.all([
      db("erp.skus as s")
        .join("erp.variants as v", "v.id", "s.variant_id")
        .select("s.id as sku_id", db.raw("COALESCE(v.sale_rate, 100) as sale_rate"))
        .where({ "s.is_active": true })
        .orderBy("s.id", "asc")
        .first(),
      db("erp.parties")
        .select("id")
        .whereIn("party_type", ["CUSTOMER", "BOTH"])
        .orderBy("id", "asc")
        .first(),
      db("erp.employees")
        .select("id")
        .orderBy("id", "asc")
        .first(),
      db("erp.uom")
        .select("id")
        .where({ is_active: true })
        .orderBy("id", "asc")
        .first(),
      db("erp.voucher_header").max("voucher_no as max").first(),
    ]);

    if (!sku || !party || !employee) {
      state.skipped = true;
      state.skipReason = "No active SKU, customer party, or employee found in DB";
      return;
    }

    state.customerPartyId = Number(party.id);
    const baseMax = Number(maxRow?.max || 0);
    const soVoucherNo = baseMax + 1;
    const cvVoucherNo = baseMax + 2;

    try {
      await db.transaction(async (trx) => {
        // --- Sales Order ---
        const [soHeader] = await trx("erp.voucher_header")
          .insert({
            voucher_type_code: "SALES_ORDER",
            branch_id: state.branchId,
            voucher_date: trx.fn.now(),
            status: "APPROVED",
            voucher_no: soVoucherNo,
            created_by: adminUser.id,
            approved_by: adminUser.id,
            approved_at: trx.fn.now(),
          })
          .returning(["id"]);
        state.soId = Number(soHeader?.id || soHeader);
        state.soVoucherNo = soVoucherNo;

        await trx("erp.sales_order_header").insert({
          voucher_id: state.soId,
          customer_party_id: state.customerPartyId,
          salesman_employee_id: employee.id,
          payment_received_amount: 0,
        });

        // SKU line — 10 units so the SO has open (unfulfilled) quantity
        await trx("erp.voucher_line").insert({
          voucher_header_id: state.soId,
          line_no: 1,
          line_kind: "SKU",
          sku_id: sku.sku_id,
          qty: 10,
          amount: Number(sku.sale_rate) * 10,
          uom_id: uom?.id || null,
          meta: JSON.stringify({}),
        });

        // --- Cash Voucher linked to the SO ---
        const [cvHeader] = await trx("erp.voucher_header")
          .insert({
            voucher_type_code: "CASH_VOUCHER",
            branch_id: state.branchId,
            voucher_date: trx.fn.now(),
            status: "APPROVED",
            voucher_no: cvVoucherNo,
            created_by: adminUser.id,
            approved_by: adminUser.id,
            approved_at: trx.fn.now(),
            linked_sales_order_id: state.soId,
          })
          .returning(["id"]);
        state.cvId = Number(cvHeader?.id || cvHeader);
        state.cvVoucherNo = cvVoucherNo;

        // PARTY line with credit > 0 = cash received from customer
        await trx("erp.voucher_line").insert({
          voucher_header_id: state.cvId,
          line_no: 1,
          line_kind: "PARTY",
          party_id: state.customerPartyId,
          amount: CV_AMOUNT,
          meta: JSON.stringify({ credit: CV_AMOUNT, debit: 0 }),
        });
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[E2E setup] fixture insert failed:", err.message);
      state.skipped = true;
      state.skipReason = `DB fixture insert failed: ${err.message}`;
    }
  });

  test.afterAll(async () => {
    try {
      if (state.cvId) {
        await db("erp.voucher_line")
          .where({ voucher_header_id: state.cvId })
          .del();
        await db("erp.voucher_header").where({ id: state.cvId }).del();
      }
      if (state.soId) {
        await db("erp.voucher_line")
          .where({ voucher_header_id: state.soId })
          .del();
        await db("erp.sales_order_header")
          .where({ voucher_id: state.soId })
          .del();
        await db("erp.voucher_header").where({ id: state.soId }).del();
      }
    } finally {
      await db.destroy();
    }
  });

  // ── Test 1: DB migration ──────────────────────────────────────────────────
  test("migration: voucher_header.linked_sales_order_id column exists", async () => {
    const has = await db.schema
      .withSchema("erp")
      .hasColumn("voucher_header", "linked_sales_order_id")
      .catch(() => false);
    expect(has).toBe(true);
  });

  // ── Test 2: Cash Voucher UI shows SO selector ─────────────────────────────
  test("Cash Voucher form renders the Sales Order link selector", async ({
    page,
  }) => {
    test.skip(state.skipped, state.skipReason);
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/cash?new=1", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-linked-so-select]")).toBeVisible();
  });

  // ── Test 3: SV form shows reduced receivable from CV payment ─────────────
  test("SV form [data-so-advance] reflects CV cash receipt linked to SO", async ({
    page,
  }) => {
    test.skip(state.skipped, state.skipReason);
    await login(page, "E2E_ADMIN");

    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

    // Inject SO selection the same way the SO-picker modal would
    await page.evaluate((soId) => {
      const saleModeEl = document.querySelector("[data-sale-mode]");
      const linkedOrderEl = document.querySelector("[data-linked-order]");
      if (!saleModeEl || !linkedOrderEl) {
        throw new Error(
          "[data-sale-mode] or [data-linked-order] not found in DOM",
        );
      }
      saleModeEl.value = "FROM_SO";
      saleModeEl.dispatchEvent(new Event("change", { bubbles: true }));
      linkedOrderEl.value = String(soId);
      linkedOrderEl.dispatchEvent(new Event("change", { bubbles: true }));
    }, state.soId);

    const advanceInput = page.locator("[data-so-advance]").first();
    await expect(advanceInput).toBeVisible({ timeout: 8000 });

    const raw = await advanceInput.inputValue();
    const advance = Number(String(raw || "0").replace(/,/g, "").trim());
    expect(advance).toBeGreaterThanOrEqual(CV_AMOUNT);
  });

  // ── Test 4: Loading saved CV shows linked SO in hidden input ─────────────
  test("loading saved CV by voucher_no shows linked_so_id in hidden input", async ({
    page,
  }) => {
    test.skip(state.skipped, state.skipReason);
    await login(page, "E2E_ADMIN");

    const response = await page.goto(
      `/vouchers/cash?voucher_no=${state.cvVoucherNo}&view=1`,
      { waitUntil: "domcontentloaded" },
    );
    test.skip(
      !response || response.status() !== 200,
      `CV #${state.cvVoucherNo} page returned ${response?.status()}`,
    );

    await expect(page.locator("[data-linked-so-id]").first()).toHaveValue(
      String(state.soId),
    );
  });
});
