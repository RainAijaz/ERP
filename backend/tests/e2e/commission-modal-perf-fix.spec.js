/**
 * Verifies the three changes made to the sales-commission modal:
 *   1. Parallel DB queries (fetchTargetSkus + fetchExistingRules via Promise.all)
 *   2. O(1) indexed rule lookup (indexExistingRules / resolvePreviousForSkuIndexed)
 *   3. Debounce increased from 200 ms → 400 ms
 *
 * The rate_type field must be set before loadPreview will fire a /bulk-preview
 * request (it guards: `if (!rateType) return`). In each test we arm the
 * network interceptor BEFORE setting rate_type so that the debounced call
 * triggered by the rate_type change is the one we observe.
 */

const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

// ── helpers ────────────────────────────────────────────────────────────────

const getSelectOptions = async (page, fieldName) => {
  const sel = page
    .locator(`[data-modal-form] [data-field="${fieldName}"]`)
    .first();
  if (!(await sel.count())) return [];
  return sel.evaluate((el) =>
    Array.from(el.options || [])
      .map((opt) => ({
        value: String(opt.value || "").trim(),
        label: String(opt.textContent || "").trim(),
      }))
      .filter((opt) => opt.value),
  );
};

const setSelectSingle = async (page, fieldName, value) => {
  await page
    .locator(`[data-modal-form] [data-field="${fieldName}"]`)
    .evaluate((el, val) => {
      el.value = String(val || "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
};

const setSelectMulti = async (page, fieldName, values) => {
  await page
    .locator(`[data-modal-form] [data-field="${fieldName}"]`)
    .evaluate((el, vals) => {
      const wanted = new Set(
        (Array.isArray(vals) ? vals : [])
          .map((v) => String(v || "").trim())
          .filter(Boolean),
      );
      Array.from(el.options || []).forEach((opt) => {
        opt.selected = wanted.has(String(opt.value || "").trim());
      });
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, values);
};

// Open the modal and return the first employee id + first group id from the DB.
// Returns null if either is unavailable (caller should test.skip).
const openModalAndPickGroupSetup = async (page, db) => {
  await page.goto("/hr-payroll/employees/commissions", {
    waitUntil: "domcontentloaded",
  });
  await page.locator("[data-modal-open]").first().click();
  await expect(page.locator("[data-modal-form]")).toBeVisible();

  const empOpts = await getSelectOptions(page, "employee_id");
  if (!empOpts.length) return null;

  await setSelectSingle(page, "apply_on", "GROUP");
  await page.waitForTimeout(150);

  const groupOpts = await getSelectOptions(page, "group_id");
  if (!groupOpts.length) return null;

  const employeeId = Number(empOpts[0].value);
  const groupId = Number(groupOpts[0].value);

  const skuRows = await db("erp.skus as s")
    .join("erp.variants as v", "s.variant_id", "v.id")
    .join("erp.items as i", "v.item_id", "i.id")
    .select("s.id as sku_id")
    .where("i.group_id", groupId)
    .andWhere("i.item_type", "FG");

  if (!skuRows.length) return null;

  return { employeeId, groupId, empOpts, groupOpts, skuRows };
};

// ══════════════════════════════════════════════════════════════════════════
// Suite A — Debounce is 400 ms (not the old 200 ms)
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission modal fix — debounce", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("bulk-preview fires ≥ 380 ms after the triggering field change (debounce = 400 ms)", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const setup = await openModalAndPickGroupSetup(page, db);
    test.skip(!setup, "No employee/group/SKU data — skipping.");

    const { empOpts, groupOpts } = setup;

    await setSelectMulti(page, "employee_id", [empOpts[0].value]);
    await setSelectSingle(page, "group_id", groupOpts[0].value);
    // rate_type is still empty here — preview will NOT fire yet

    // Arm interceptor, then dispatch the rate_type change.
    // The rate_type change is the LAST debounce-triggering event, so it
    // resets the 400 ms timer. We measure elapsed from that moment.
    const requestPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/bulk-preview") && req.method() === "GET",
      { timeout: 8000 },
    );

    const t0 = Date.now();
    await setSelectSingle(page, "rate_type", "PER_PAIR");
    await requestPromise;
    const elapsed = Date.now() - t0;

    console.log(`[debounce] bulk-preview fired ${elapsed} ms after rate_type change`);

    // Must be ≥ 380 ms. The old 200 ms debounce would fire ~200–250 ms — well below.
    expect(elapsed).toBeGreaterThanOrEqual(380);
    // Sanity upper bound — if this fires it means something else stalled.
    expect(elapsed).toBeLessThan(4000);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite B — Parallel queries: /bulk-preview returns the right rows
// Correct counts + correct sku_ids prove both DB queries ran and joined.
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission modal fix — parallel queries correctness (GROUP)", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("bulk-preview returns 200 with rows that match DB SKUs for selected GROUP", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const setup = await openModalAndPickGroupSetup(page, db);
    test.skip(!setup, "No employee/group/SKU data — skipping.");

    const { empOpts, groupOpts, skuRows, groupId } = setup;

    await setSelectMulti(page, "employee_id", [empOpts[0].value]);
    await setSelectSingle(page, "group_id", groupOpts[0].value);

    // Arm interceptor before rate_type change (the final debounce trigger)
    const previewResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/bulk-preview") && resp.request().method() === "GET",
      { timeout: 10000 },
    );
    await setSelectSingle(page, "rate_type", "PER_PAIR");

    const previewResp = await previewResponsePromise;
    expect(previewResp.status()).toBe(200);

    const body = await previewResp.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(skuRows.length);

    const dbSkuIds = new Set(skuRows.map((r) => Number(r.sku_id)));
    for (const row of body.rows) {
      expect(dbSkuIds.has(Number(row.sku_id))).toBe(
        true,
        `sku_id ${row.sku_id} in response not found in DB for group ${groupId}`,
      );
    }
  });

  test("bulk-preview returns 200 with rows that match DB SKUs for selected SUBGROUP", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/employees/commissions", {
      waitUntil: "domcontentloaded",
    });

    await page.locator("[data-modal-open]").first().click();
    await expect(page.locator("[data-modal-form]")).toBeVisible();

    const empOpts = await getSelectOptions(page, "employee_id");
    test.skip(!empOpts.length, "No employees — skipping.");

    await setSelectSingle(page, "apply_on", "SUBGROUP");
    await page.waitForTimeout(150);

    const subgroupOpts = await getSelectOptions(page, "subgroup_id");
    test.skip(!subgroupOpts.length, "No subgroups — skipping.");
    const subgroupId = Number(subgroupOpts[0].value);

    const dbSkuRows = await db("erp.skus as s")
      .join("erp.variants as v", "s.variant_id", "v.id")
      .join("erp.items as i", "v.item_id", "i.id")
      .select("s.id as sku_id")
      .where("i.subgroup_id", subgroupId)
      .andWhere("i.item_type", "FG");
    test.skip(!dbSkuRows.length, "Subgroup has no FG SKUs — skipping.");

    await setSelectMulti(page, "employee_id", [empOpts[0].value]);
    await setSelectSingle(page, "subgroup_id", subgroupOpts[0].value);

    const previewResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/bulk-preview") && resp.request().method() === "GET",
      { timeout: 10000 },
    );
    await setSelectSingle(page, "rate_type", "PER_PAIR");

    const previewResp = await previewResponsePromise;
    expect(previewResp.status()).toBe(200);

    const body = await previewResp.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(dbSkuRows.length);

    const dbSkuIds = new Set(dbSkuRows.map((r) => Number(r.sku_id)));
    for (const row of body.rows) {
      expect(dbSkuIds.has(Number(row.sku_id))).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite C — Indexed rule lookup: previous_rate resolves correctly
// Insert a known SKU-level rule, trigger GROUP preview, confirm the indexed
// lookup returns that rule's value as previous_rate for the target SKU.
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission modal fix — O(1) indexed lookup correctness", () => {
  const db = createKnex(knexConfig);

  const ctx = {
    employeeId: null,
    skuId: null,
    groupId: null,
    insertedRate: 77.50,
    insertedRuleId: null,
  };

  test.describe.configure({ mode: "serial" });

  test.afterAll(async () => {
    if (ctx.insertedRuleId) {
      await db("erp.employee_commission_rules")
        .where({ id: ctx.insertedRuleId })
        .delete();
    }
    await db.destroy();
  });

  test("previous_rate in preview matches the known inserted SKU-level rule", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const setup = await openModalAndPickGroupSetup(page, db);
    test.skip(!setup, "No employee/group/SKU data — skipping.");

    const { empOpts, groupOpts, skuRows, employeeId, groupId } = setup;
    ctx.employeeId = employeeId;
    ctx.groupId = groupId;
    ctx.skuId = Number(skuRows[0].sku_id);

    // Remove any pre-existing rule for this employee+sku to keep the test clean
    await db("erp.employee_commission_rules")
      .where({
        employee_id: ctx.employeeId,
        sku_id: ctx.skuId,
        apply_on: "SKU",
        commission_basis: "FIXED_PER_UNIT",
        status: "active",
      })
      .delete();

    // Insert a synthetic SKU-level rule with a known rate
    const [inserted] = await db("erp.employee_commission_rules")
      .insert({
        employee_id: ctx.employeeId,
        sku_id: ctx.skuId,
        apply_on: "SKU",
        commission_basis: "FIXED_PER_UNIT",
        commission_type: "SALESMAN_SALE",
        value_type: "FIXED",
        value: ctx.insertedRate,
        rate_type: "PER_PAIR",
        reverse_on_returns: true,
        status: "active",
      })
      .returning("id");
    ctx.insertedRuleId =
      typeof inserted === "object" ? Number(inserted.id) : Number(inserted);

    await setSelectMulti(page, "employee_id", [String(ctx.employeeId)]);
    await setSelectSingle(page, "group_id", groupOpts[0].value);

    const previewResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/bulk-preview") && resp.request().method() === "GET",
      { timeout: 10000 },
    );
    await setSelectSingle(page, "rate_type", "PER_PAIR");

    const previewResp = await previewResponsePromise;
    expect(previewResp.status()).toBe(200);

    const body = await previewResp.json();
    expect(Array.isArray(body.rows)).toBe(true);

    const matchRow = body.rows.find((r) => Number(r.sku_id) === ctx.skuId);
    expect(
      matchRow,
      `SKU ${ctx.skuId} not found in preview rows for group ${ctx.groupId}`,
    ).toBeTruthy();

    // The O(1) indexed lookup must have found and returned the inserted rate
    expect(Number(matchRow.previous_rate)).toBeCloseTo(ctx.insertedRate, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite D — Preview table renders in UI after field selection
// End-to-end: user sees rate-input rows, summary counter matches SKU count
// ══════════════════════════════════════════════════════════════════════════

test.describe("Commission modal fix — UI preview table renders", () => {
  const db = createKnex(knexConfig);
  test.afterAll(() => db.destroy());

  test("bulk preview panel shows rate inputs after selecting GROUP + rate_type", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const setup = await openModalAndPickGroupSetup(page, db);
    test.skip(!setup, "No employee/group/SKU data — skipping.");

    const { empOpts, groupOpts, skuRows, groupId } = setup;

    await setSelectMulti(page, "employee_id", [empOpts[0].value]);
    await setSelectSingle(page, "group_id", groupOpts[0].value);
    await setSelectSingle(page, "rate_type", "PER_PAIR");

    // Panel must become visible
    const panel = page.locator("[data-commission-bulk-panel]");
    await expect(panel).toBeVisible({ timeout: 8000 });

    // Rate inputs must appear — one per SKU
    const rateInputs = page.locator(
      "[data-commission-bulk-body] [data-commission-row-rate]",
    );
    await expect(rateInputs.first()).toBeVisible({ timeout: 8000 });

    const renderedCount = await rateInputs.count();
    expect(renderedCount).toBe(skuRows.length);

    // Summary counter must match
    const summaryText = await page
      .locator("[data-commission-bulk-summary]")
      .textContent();
    expect(Number(summaryText?.trim())).toBe(renderedCount);

    console.log(
      `[ui] Preview rendered ${renderedCount} SKU rows for group ${groupId}`,
    );
  });
});
