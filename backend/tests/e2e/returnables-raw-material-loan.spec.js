// Lending raw material to a third party through the Returnable Dispatch screen.
// The stock effect is a state reclass (ON_HAND -> WITH_THIRD_PARTY) inside the same
// branch, so usable stock drops while total inventory value is untouched.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const knex = require("../../src/db/knex");

const readRmBucket = async ({ branchId, itemId, colorId, sizeId, stockState }) => {
  const row = await knex("erp.stock_balance_rm")
    .select("qty", "value")
    .where({ branch_id: branchId, stock_state: stockState, item_id: itemId })
    .whereRaw("COALESCE(color_id, 0) = ?", [Number(colorId || 0)])
    .whereRaw("COALESCE(size_id, 0) = ?", [Number(sizeId || 0)])
    .first();
  return { qty: Number(row?.qty || 0), value: Number(row?.value || 0) };
};

const findBranchSupplier = async (branchId) =>
  knex("erp.parties as p")
    .leftJoin("erp.party_branch as pb", "pb.party_id", "p.id")
    .select("p.id", "p.name")
    .whereRaw("upper(coalesce(p.party_type::text, '')) = 'SUPPLIER'")
    .where("p.is_active", true)
    .andWhere((q) => q.where("pb.branch_id", branchId).orWhereNull("pb.branch_id"))
    .first();

const chooseSearchableValue = async (page, wrapper, value) => {
  const select = wrapper.locator("select").first();
  await select.selectOption(String(value));
  await select.dispatchEvent("change");
};

test.describe("Returnable dispatch: raw material loan", () => {
  test("lending raw material moves it out of on-hand stock without changing total value", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Returnable dispatch page not accessible for admin.",
    );
    await page.waitForSelector("[data-returnable-form]");

    // Everything is driven off the session's own branch and the options the page
    // actually offers, so the test never assumes which branch holds stock.
    const resolvedBranchId = Number(
      await page.evaluate(() => {
        const el = document.getElementById("branch-select");
        return el instanceof HTMLSelectElement ? el.value : "";
      }),
    );
    test.skip(!resolvedBranchId, "No active branch on the session.");

    const supplier = await findBranchSupplier(resolvedBranchId);
    test.skip(!supplier, "No supplier available for this branch.");

    const LEND_QTY = 1;
    // ---- header ----------------------------------------------------------
    const vendorWrapper = page
      .locator("[data-searchable-wrapper]")
      .filter({ has: page.locator('select[name="vendor_party_id"]') })
      .first();
    await chooseSearchableValue(page, vendorWrapper, supplier.id);

    const reasonWrapper = page
      .locator("[data-searchable-wrapper]")
      .filter({ has: page.locator('select[name="reason_code"]') })
      .first();
    await chooseSearchableValue(page, reasonWrapper, "OTHERS");
    await page.locator('input[name="remarks"]').fill("e2e: raw material loan");

    const voucherDateInput = page.locator('input[name="voucher_date"]').first();
    const voucherDateValue = await voucherDateInput.inputValue();
    const expected = new Date(`${voucherDateValue}T00:00:00`);
    expected.setDate(expected.getDate() + 14);
    await page
      .locator('input[name="expected_return_date"]')
      .fill(
        `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`,
      );

    // ---- switch the line to Raw Material ---------------------------------
    const firstRow = page.locator("[data-lines-body] tr").first();
    const kindSelect = firstRow.locator('select[data-row-field="entry_kind"]');
    await expect(kindSelect).toBeVisible();
    await kindSelect.selectOption("RM");
    await kindSelect.dispatchEvent("change");

    const rmSelect = page
      .locator("[data-lines-body] tr")
      .first()
      .locator('select[data-row-field="rm_bucket_id"]');
    await expect(rmSelect).toBeAttached();

    // Take the first bucket the picker offers: it only lists raw material that has
    // on-hand stock in this branch, which is exactly what can be lent.
    const bucketKey = await rmSelect
      .locator("option")
      .evaluateAll((options) => {
        const first = options.find((option) => option.value);
        return first ? first.value : "";
      });
    test.skip(!bucketKey, "No raw material with on-hand stock in this branch.");

    const [itemId, colorId, sizeId] = bucketKey.split(":").map(Number);
    const bucketRef = {
      branchId: resolvedBranchId,
      itemId,
      colorId: colorId || null,
      sizeId: sizeId || null,
    };
    const before = {
      onHand: await readRmBucket({ ...bucketRef, stockState: "ON_HAND" }),
      out: await readRmBucket({ ...bucketRef, stockState: "WITH_THIRD_PARTY" }),
    };
    expect(before.onHand.qty).toBeGreaterThanOrEqual(LEND_QTY);

    await rmSelect.selectOption(bucketKey);
    await rmSelect.dispatchEvent("change");

    // The row shows the unit and what is left on hand for the chosen bucket.
    const refreshedRow = page.locator("[data-lines-body] tr").first();
    await expect(refreshedRow).toContainText(String(Math.trunc(before.onHand.qty)));

    const qtyInput = refreshedRow.locator('input[data-row-field="qty"]');
    await qtyInput.fill(String(LEND_QTY));
    await qtyInput.dispatchEvent("input");

    // ---- save ------------------------------------------------------------
    await page.locator("[data-enter-submit]").click();
    await page.waitForLoadState("domcontentloaded");

    const errorModal = page.locator("[data-ui-error-modal]");
    if (await errorModal.isVisible()) {
      const message =
        (await page.locator("[data-ui-error-message]").textContent()) || "unknown";
      throw new Error(`UI error after submit: ${message.trim()}`);
    }
    await expect(page.locator("[data-ui-notice-toast]")).toBeVisible();

    // ---- stock effect ----------------------------------------------------
    const after = {
      onHand: await readRmBucket({ ...bucketRef, stockState: "ON_HAND" }),
      out: await readRmBucket({ ...bucketRef, stockState: "WITH_THIRD_PARTY" }),
    };

    try {
      expect(after.onHand.qty).toBeCloseTo(before.onHand.qty - LEND_QTY, 2);
      expect(after.out.qty).toBeCloseTo(before.out.qty + LEND_QTY, 2);
      // Value only changes bucket, never total: lending is not a disposal.
      expect(after.onHand.value + after.out.value).toBeCloseTo(
        before.onHand.value + before.out.value,
        1,
      );
    } finally {
      // Give the material back, so repeated runs do not drain the branch's stock.
      const voucher = await knex("erp.voucher_header")
        .select("id")
        .where({ branch_id: resolvedBranchId, voucher_type_code: "RDV" })
        .orderBy("id", "desc")
        .first();
      if (voucher?.id) {
        await knex("erp.stock_ledger").where({ voucher_header_id: voucher.id }).del();
        await knex("erp.voucher_header").where({ id: voucher.id }).del();
      }
      await knex("erp.stock_balance_rm")
        .where({
          branch_id: resolvedBranchId,
          stock_state: "ON_HAND",
          item_id: bucketRef.itemId,
        })
        .whereRaw("COALESCE(color_id, 0) = ?", [Number(bucketRef.colorId || 0)])
        .whereRaw("COALESCE(size_id, 0) = ?", [Number(bucketRef.sizeId || 0)])
        .update({ qty: before.onHand.qty, value: before.onHand.value });
      await knex("erp.stock_balance_rm")
        .where({
          branch_id: resolvedBranchId,
          stock_state: "WITH_THIRD_PARTY",
          item_id: bucketRef.itemId,
        })
        .whereRaw("COALESCE(color_id, 0) = ?", [Number(bucketRef.colorId || 0)])
        .whereRaw("COALESCE(size_id, 0) = ?", [Number(bucketRef.sizeId || 0)])
        .update({ qty: before.out.qty, value: before.out.value });
    }
  });
});
