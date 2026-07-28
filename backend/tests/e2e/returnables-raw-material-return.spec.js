// The return leg of a raw-material loan. Lending is a stock-state reclass
// (ON_HAND -> WITH_THIRD_PARTY) inside the same branch, so the material coming back
// through a Returnable Receipt must reverse exactly that move: a completed round trip
// lands on the balances it started from, and no GL entry is ever written.
//
// The dispatch-only case lives in returnables-raw-material-loan.spec.js; this file
// covers what happens after dispatch — partial return, full return, and the two
// quantity guards (cannot lend more than is on hand, cannot get back more than went out).
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const knex = require("../../src/db/knex");

const applyBucketFilter = (query, ref, stockState) =>
  query
    .where({
      branch_id: ref.branchId,
      stock_state: stockState,
      item_id: ref.itemId,
    })
    .whereRaw("COALESCE(color_id, 0) = ?", [Number(ref.colorId || 0)])
    .whereRaw("COALESCE(size_id, 0) = ?", [Number(ref.sizeId || 0)]);

const readBucket = async (ref, stockState) => {
  const row = await applyBucketFilter(
    knex("erp.stock_balance_rm").select("qty", "value"),
    ref,
    stockState,
  ).first();
  return { qty: Number(row?.qty || 0), value: Number(row?.value || 0) };
};

const readBalances = async (ref) => ({
  onHand: await readBucket(ref, "ON_HAND"),
  out: await readBucket(ref, "WITH_THIRD_PARTY"),
});

const restoreBalances = async (ref, snapshot) => {
  for (const [stockState, values] of [
    ["ON_HAND", snapshot.onHand],
    ["WITH_THIRD_PARTY", snapshot.out],
  ]) {
    await applyBucketFilter(knex("erp.stock_balance_rm"), ref, stockState).update({
      qty: values.qty,
      value: values.value,
    });
  }
};

// Receipts reference outward lines with ON DELETE RESTRICT, so inward vouchers have to
// go first or the outward delete is rejected.
const deleteVouchers = async (voucherIds) => {
  const ids = voucherIds.map(Number).filter(Boolean);
  if (!ids.length) return;
  const rows = await knex("erp.voucher_header")
    .select("id", "voucher_type_code")
    .whereIn("id", ids);
  const ordered = [
    ...rows.filter((row) => row.voucher_type_code === "RRV").map((row) => row.id),
    ...rows.filter((row) => row.voucher_type_code !== "RRV").map((row) => row.id),
  ];
  for (const id of ordered) {
    await knex("erp.stock_ledger").where({ voucher_header_id: id }).del();
    await knex("erp.voucher_header").where({ id }).del();
  }
};

const findBranchSupplier = async (branchId) =>
  knex("erp.parties as p")
    .leftJoin("erp.party_branch as pb", "pb.party_id", "p.id")
    .select("p.id", "p.name")
    .whereRaw("upper(coalesce(p.party_type::text, '')) = 'SUPPLIER'")
    .where("p.is_active", true)
    .andWhere((q) => q.where("pb.branch_id", branchId).orWhereNull("pb.branch_id"))
    .first();

// The bucket with the most stock, so a lend/partial-return/lend-too-much sequence has
// room to run without draining the branch.
const findLargestRmBucket = async (branchId) => {
  const row = await knex("erp.stock_balance_rm as sb")
    .join("erp.items as i", "i.id", "sb.item_id")
    .select("sb.item_id", "sb.color_id", "sb.size_id", "sb.qty")
    .where({ "sb.branch_id": branchId, "sb.stock_state": "ON_HAND" })
    .whereRaw("upper(coalesce(i.item_type::text, '')) = 'RM'")
    .where("sb.qty", ">", 0)
    .orderBy("sb.qty", "desc")
    .first();
  if (!row) return null;
  return {
    ref: {
      branchId,
      itemId: Number(row.item_id),
      colorId: row.color_id === null ? null : Number(row.color_id),
      sizeId: row.size_id === null ? null : Number(row.size_id),
    },
    bucketKey: [
      Number(row.item_id),
      Number(row.color_id || 0),
      Number(row.size_id || 0),
    ].join(":"),
    available: Number(row.qty),
  };
};

const readSessionBranchId = async (page) =>
  Number(
    await page.evaluate(() => {
      const el = document.getElementById("branch-select");
      return el instanceof HTMLSelectElement ? el.value : "";
    }),
  );

const chooseSearchableValue = async (page, selectName, value) => {
  const select = page.locator(`select[name="${selectName}"]`).first();
  await select.selectOption(String(value));
  await select.dispatchEvent("change");
};

// Saving is async, so the outcome has to be waited for rather than sampled: whichever
// of the success toast / error modal appears first decides it. The modal spreads its
// text over a title, a summary and an issue list, so the whole thing is read back.
const awaitSubmitOutcome = async (page) => {
  const toast = page.locator("[data-ui-notice-toast]");
  const errorModal = page.locator("[data-ui-error-modal]");
  await expect(toast.or(errorModal).first()).toBeVisible({ timeout: 20000 });
  if (!(await errorModal.isVisible())) return null;
  const text = (await errorModal.innerText()) || "";
  return text.replace(/\s+/g, " ").trim();
};

const openDispatchForm = async (page) => {
  const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
    waitUntil: "domcontentloaded",
  });
  test.skip(
    !response || response.status() !== 200,
    "Returnable dispatch page not accessible for admin.",
  );
  await page.waitForSelector("[data-returnable-form]");
};

// Fills a dispatch for one raw-material line and submits it. Returns the UI error when
// the save was refused, so guard tests can assert on the message.
const submitRawMaterialDispatch = async (page, { supplierId, bucketKey, qty }) => {
  await openDispatchForm(page);
  await chooseSearchableValue(page, "vendor_party_id", supplierId);
  await chooseSearchableValue(page, "reason_code", "OTHERS");
  await page.locator('input[name="remarks"]').fill("e2e: raw material loan return");

  const voucherDateValue = await page
    .locator('input[name="voucher_date"]')
    .first()
    .inputValue();
  const expected = new Date(`${voucherDateValue}T00:00:00`);
  expected.setDate(expected.getDate() + 14);
  await page
    .locator('input[name="expected_return_date"]')
    .fill(
      `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`,
    );

  const kindSelect = page
    .locator("[data-lines-body] tr")
    .first()
    .locator('select[data-row-field="entry_kind"]');
  await expect(kindSelect).toBeVisible();
  await kindSelect.selectOption("RM");
  await kindSelect.dispatchEvent("change");

  // Switching the kind re-renders the row, so the bucket select has to be re-located.
  const rmSelect = page
    .locator("[data-lines-body] tr")
    .first()
    .locator('select[data-row-field="rm_bucket_id"]');
  await expect(rmSelect).toBeAttached();
  await rmSelect.selectOption(bucketKey);
  await rmSelect.dispatchEvent("change");

  const qtyInput = page
    .locator("[data-lines-body] tr")
    .first()
    .locator('input[data-row-field="qty"]');
  await qtyInput.fill(String(qty));
  await qtyInput.dispatchEvent("input");

  await page.locator("[data-enter-submit]").click();
  return awaitSubmitOutcome(page);
};

const latestVoucher = async (branchId, voucherTypeCode) =>
  knex("erp.voucher_header")
    .select("id", "voucher_no")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .orderBy("id", "desc")
    .first();

// Only a voucher newer than the baseline belongs to this run. Without the check a
// refused save would hand back a pre-existing voucher, which cleanup would then delete.
const voucherCreatedSince = async (branchId, voucherTypeCode, baselineId) => {
  const row = await latestVoucher(branchId, voucherTypeCode);
  if (!row?.id) return null;
  return Number(row.id) > Number(baselineId || 0) ? row : null;
};

const latestVoucherId = async (branchId, voucherTypeCode) =>
  Number((await latestVoucher(branchId, voucherTypeCode))?.id || 0);

// Drives the receipt screen: pick the vendor, pull the outward voucher in through the
// reference picker, then set what is actually being returned on the line.
const submitReturnReceipt = async (page, { supplierId, outwardVoucherNo, qty }) => {
  const response = await page.goto("/vouchers/returnable-receipt?new=1", {
    waitUntil: "domcontentloaded",
  });
  test.skip(
    !response || response.status() !== 200,
    "Returnable receipt page not accessible for admin.",
  );
  await page.waitForSelector("[data-returnable-form]");

  await chooseSearchableValue(page, "vendor_party_id", supplierId);
  await page.locator("[data-outward-picker-open]").click();
  await page.waitForSelector('[data-outward-picker-modal][aria-hidden="false"]');

  const pickerRow = page
    .locator("[data-outward-picker-body] tr")
    .filter({ has: page.locator(`td:text-is("${outwardVoucherNo}")`) })
    .first();
  await expect(pickerRow).toBeVisible();
  await pickerRow.locator('input[data-picker-field="selected"]').check();
  await page.locator("[data-outward-picker-apply]").click();

  const receiptRow = page.locator("[data-lines-body] tr").first();
  await expect(receiptRow).toBeVisible();

  // Set the returned quantity on the line itself rather than in the picker, so the
  // value the server receives is the one under test even if the picker pre-fills it.
  const returnedQtyInput = receiptRow.locator('input[data-row-field="returned_qty"]');
  await returnedQtyInput.fill(String(qty));
  await returnedQtyInput.dispatchEvent("input");
  await returnedQtyInput.dispatchEvent("change");

  await page.locator("[data-enter-submit]").click();
  return awaitSubmitOutcome(page);
};

const outwardStatus = async (voucherId) => {
  const row = await knex("erp.rgp_outward")
    .select("status")
    .where({ voucher_id: voucherId })
    .first();
  return row?.status || null;
};

const glEntryCount = async (voucherIds) => {
  const ids = voucherIds.map(Number).filter(Boolean);
  if (!ids.length) return 0;
  // gl_entry hangs off gl_batch, which is what carries the source voucher.
  const row = await knex("erp.gl_entry as ge")
    .join("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .count({ total: "*" })
    .whereIn("gb.source_voucher_id", ids)
    .first();
  return Number(row?.total || 0);
};

test.describe("Returnable receipt: raw material return", () => {
  test("a lent raw material comes back in two parts and lands on the original balances", async ({
    page,
  }) => {
    test.setTimeout(150000);

    await login(page, "E2E_ADMIN");
    await openDispatchForm(page);

    const branchId = await readSessionBranchId(page);
    test.skip(!branchId, "No active branch on the session.");

    const supplier = await findBranchSupplier(branchId);
    test.skip(!supplier, "No supplier available for this branch.");

    const bucket = await findLargestRmBucket(branchId);
    test.skip(!bucket, "No raw material with on-hand stock in this branch.");
    test.skip(bucket.available < 2, "Need at least 2 units on hand to split a return.");

    const LEND_QTY = 2;
    const FIRST_RETURN = 1;
    const before = await readBalances(bucket.ref);
    const createdVoucherIds = [];

    try {
      // ---- lend it out ---------------------------------------------------
      const dispatchBaseline = await latestVoucherId(branchId, "RDV");
      const dispatchError = await submitRawMaterialDispatch(page, {
        supplierId: supplier.id,
        bucketKey: bucket.bucketKey,
        qty: LEND_QTY,
      });
      expect(dispatchError).toBeNull();

      const dispatch = await voucherCreatedSince(branchId, "RDV", dispatchBaseline);
      expect(dispatch?.id).toBeTruthy();
      createdVoucherIds.push(dispatch.id);

      const afterLend = await readBalances(bucket.ref);
      expect(afterLend.onHand.qty).toBeCloseTo(before.onHand.qty - LEND_QTY, 2);
      expect(afterLend.out.qty).toBeCloseTo(before.out.qty + LEND_QTY, 2);
      expect(await outwardStatus(dispatch.id)).toBe("PENDING");

      // ---- get half of it back -------------------------------------------
      const receiptBaseline = await latestVoucherId(branchId, "RRV");
      const partialError = await submitReturnReceipt(page, {
        supplierId: supplier.id,
        outwardVoucherNo: dispatch.voucher_no,
        qty: FIRST_RETURN,
      });
      expect(partialError).toBeNull();

      const firstReceipt = await voucherCreatedSince(branchId, "RRV", receiptBaseline);
      expect(firstReceipt?.id).toBeTruthy();
      createdVoucherIds.push(firstReceipt.id);

      const afterPartial = await readBalances(bucket.ref);
      expect(afterPartial.onHand.qty).toBeCloseTo(
        before.onHand.qty - LEND_QTY + FIRST_RETURN,
        2,
      );
      expect(afterPartial.out.qty).toBeCloseTo(
        before.out.qty + LEND_QTY - FIRST_RETURN,
        2,
      );
      expect(await outwardStatus(dispatch.id)).toBe("PARTIALLY_RETURNED");

      // ---- and the rest ---------------------------------------------------
      const finalError = await submitReturnReceipt(page, {
        supplierId: supplier.id,
        outwardVoucherNo: dispatch.voucher_no,
        qty: LEND_QTY - FIRST_RETURN,
      });
      expect(finalError).toBeNull();

      const secondReceipt = await voucherCreatedSince(
        branchId,
        "RRV",
        firstReceipt.id,
      );
      expect(secondReceipt?.id).toBeTruthy();
      createdVoucherIds.push(secondReceipt.id);

      const afterFull = await readBalances(bucket.ref);
      expect(afterFull.onHand.qty).toBeCloseTo(before.onHand.qty, 2);
      expect(afterFull.out.qty).toBeCloseTo(before.out.qty, 2);
      // The round trip is value-neutral end to end, not just in aggregate.
      expect(afterFull.onHand.value).toBeCloseTo(before.onHand.value, 1);
      expect(await outwardStatus(dispatch.id)).toBe("CLOSED");

      // Lending is a reclass, never a disposal: nothing may reach the ledger.
      expect(await glEntryCount(createdVoucherIds)).toBe(0);
    } finally {
      await deleteVouchers(createdVoucherIds);
      await restoreBalances(bucket.ref, before);
    }
  });

  test("lending more than is on hand is refused and moves no stock", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await login(page, "E2E_ADMIN");
    await openDispatchForm(page);

    const branchId = await readSessionBranchId(page);
    test.skip(!branchId, "No active branch on the session.");

    const supplier = await findBranchSupplier(branchId);
    test.skip(!supplier, "No supplier available for this branch.");

    const bucket = await findLargestRmBucket(branchId);
    test.skip(!bucket, "No raw material with on-hand stock in this branch.");

    const before = await readBalances(bucket.ref);
    const dispatchBefore = await latestVoucher(branchId, "RDV");

    const error = await submitRawMaterialDispatch(page, {
      supplierId: supplier.id,
      bucketKey: bucket.bucketKey,
      qty: bucket.available + 1,
    });

    try {
      expect(error).not.toBeNull();
      expect(String(error).toLowerCase()).toContain("available");

      const after = await readBalances(bucket.ref);
      expect(after.onHand.qty).toBeCloseTo(before.onHand.qty, 3);
      expect(after.out.qty).toBeCloseTo(before.out.qty, 3);

      // A refused save must not leave a voucher behind either.
      const dispatchAfter = await latestVoucher(branchId, "RDV");
      expect(Number(dispatchAfter?.id || 0)).toBe(Number(dispatchBefore?.id || 0));
    } finally {
      await restoreBalances(bucket.ref, before);
    }
  });

  test("no more can come back than went out", async ({ page }) => {
    test.setTimeout(150000);

    await login(page, "E2E_ADMIN");
    await openDispatchForm(page);

    const branchId = await readSessionBranchId(page);
    test.skip(!branchId, "No active branch on the session.");

    const supplier = await findBranchSupplier(branchId);
    test.skip(!supplier, "No supplier available for this branch.");

    const bucket = await findLargestRmBucket(branchId);
    test.skip(!bucket, "No raw material with on-hand stock in this branch.");

    const LEND_QTY = 1;
    const before = await readBalances(bucket.ref);
    const createdVoucherIds = [];

    try {
      const dispatchBaseline = await latestVoucherId(branchId, "RDV");
      const dispatchError = await submitRawMaterialDispatch(page, {
        supplierId: supplier.id,
        bucketKey: bucket.bucketKey,
        qty: LEND_QTY,
      });
      expect(dispatchError).toBeNull();

      const dispatch = await voucherCreatedSince(branchId, "RDV", dispatchBaseline);
      expect(dispatch?.id).toBeTruthy();
      createdVoucherIds.push(dispatch.id);

      // The guard is only meaningful if the loan itself actually went out.
      const afterLend = await readBalances(bucket.ref);
      expect(afterLend.out.qty).toBeCloseTo(before.out.qty + LEND_QTY, 2);

      // Ask for far more than is outstanding. The form clamps and the service guards;
      // either way the branch must never end up with more than it lent.
      const receiptBaseline = await latestVoucherId(branchId, "RRV");
      await submitReturnReceipt(page, {
        supplierId: supplier.id,
        outwardVoucherNo: dispatch.voucher_no,
        qty: LEND_QTY + 5,
      });

      const receipt = await voucherCreatedSince(branchId, "RRV", receiptBaseline);
      if (receipt?.id) createdVoucherIds.push(receipt.id);

      const after = await readBalances(bucket.ref);
      expect(after.onHand.qty).toBeLessThanOrEqual(before.onHand.qty + 0.0005);
      expect(after.out.qty).toBeGreaterThanOrEqual(-0.0005);

      const returned = await knex("erp.rgp_inward_line as ril")
        .join("erp.voucher_line as ovl", "ovl.id", "ril.rgp_out_voucher_line_id")
        .where("ovl.voucher_header_id", dispatch.id)
        .sum({ total: "ril.returned_qty" })
        .first();
      expect(Number(returned?.total || 0)).toBeLessThanOrEqual(LEND_QTY + 0.0005);
    } finally {
      await deleteVouchers(createdVoucherIds);
      await restoreBalances(bucket.ref, before);
    }
  });
});
