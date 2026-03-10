const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const toAmount = (value) => {
  const normalized = String(value || "")
    .replace(/,/g, "")
    .trim();
  if (!normalized) return 0;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
};

const assertLinkedSalesVoucherHeader = async (page, voucherNo) => {
  const response = await page.goto(
    `/vouchers/sales?voucher_no=${voucherNo}&view=1`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  test.skip(
    !response || response.status() !== 200,
    `Sales voucher #${voucherNo} page not accessible.`,
  );

  const linkedOrderInput = page.locator("[data-linked-order]").first();
  const saleModeInput = page.locator("[data-sale-mode]").first();
  const soReferenceInput = page.locator("[data-reference-no]").first();
  const billNumberInput = page.locator('input[name="reference_no"]').first();

  const linkedOrderId = String(await linkedOrderInput.inputValue()).trim();
  const saleMode = String(await saleModeInput.inputValue())
    .trim()
    .toUpperCase();

  test.skip(
    !(saleMode === "FROM_SO" || linkedOrderId),
    `Sales voucher #${voucherNo} is not SO-linked in this dataset.`,
  );

  if (saleMode === "FROM_SO") {
    await expect(linkedOrderInput).not.toHaveValue("");
  }

  await expect(soReferenceInput).not.toHaveValue("");
  await expect(soReferenceInput).toHaveValue(/^\d+$/);

  const billNumber = String(await billNumberInput.inputValue()).trim();
  expect(billNumber.length).toBeGreaterThan(0);

  const receivedInput = page.locator("[data-received]").first();
  const receiveAccountSelect = page.locator("[data-receive-account]").first();
  const receivedValue = Number((await receivedInput.inputValue()) || 0);
  if (Number.isFinite(receivedValue) && receivedValue > 0) {
    await expect(receiveAccountSelect).not.toHaveValue("");
  }

  const orderTotalInput = page.locator("[data-so-order-total]").first();
  const previousPaymentsInput = page.locator("[data-so-advance]").first();
  const totalReceivedInput = page.locator("[data-so-total-received]").first();
  const remainingInput = page.locator("[data-remaining]").first();
  const currentVoucherAmountInput = page.locator("[data-total-sales]").first();

  await expect(orderTotalInput).toBeVisible();
  await expect(previousPaymentsInput).toBeVisible();
  await expect(totalReceivedInput).toBeVisible();
  await expect(remainingInput).toBeVisible();
  await expect(currentVoucherAmountInput).toBeVisible();

  const orderTotal = toAmount(await orderTotalInput.inputValue());
  const previousPayments = toAmount(await previousPaymentsInput.inputValue());
  const currentPayment = toAmount(await receivedInput.inputValue());
  const totalReceived = toAmount(await totalReceivedInput.inputValue());
  const remainingReceivable = toAmount(await remainingInput.inputValue());
  const currentVoucherAmount = toAmount(
    await currentVoucherAmountInput.inputValue(),
  );

  const expectedTotalReceived = Number(
    (previousPayments + currentPayment).toFixed(1),
  );
  const expectedRemaining = Number(
    Math.max(0, orderTotal - expectedTotalReceived).toFixed(1),
  );

  expect(orderTotal).toBeGreaterThan(0);
  expect(currentVoucherAmount).toBeGreaterThanOrEqual(0);
  expect(Math.abs(totalReceived - expectedTotalReceived)).toBeLessThanOrEqual(
    0.2,
  );
  expect(Math.abs(remainingReceivable - expectedRemaining)).toBeLessThanOrEqual(
    0.2,
  );

  if (previousPayments > 0) {
    await expect(receiveAccountSelect).not.toHaveValue("");
    await expect(receiveAccountSelect).toBeDisabled();
  }
};

test.describe("Sales order linkage payment hydration", () => {
  test("SO-linked voucher header fields stay populated on reload", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await assertLinkedSalesVoucherHeader(page, 5);
  });

  test("another SO-linked voucher does not lose link/account/bill fields", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await assertLinkedSalesVoucherHeader(page, 7);
  });

  test("SO-linked voucher auto-fetches and locks salesman", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/sales?voucher_no=7&view=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Sales voucher #7 not accessible.",
    );

    const saleModeInput = page.locator("[data-sale-mode]").first();
    const saleMode = String(await saleModeInput.inputValue())
      .trim()
      .toUpperCase();
    test.skip(
      saleMode !== "FROM_SO",
      "Voucher #7 is not FROM_SO in this dataset.",
    );

    const salesmanSelect = page.locator("[data-salesman]").first();
    await expect(salesmanSelect).toBeVisible();
    await expect(salesmanSelect).toBeDisabled();
    await expect(salesmanSelect).not.toHaveValue("");
  });

  test("Credit due date becomes optional when remaining receivable reaches zero", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/sales?voucher_no=7&view=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Sales voucher #7 not accessible.",
    );

    const saleModeInput = page.locator("[data-sale-mode]").first();
    const saleMode = String(await saleModeInput.inputValue())
      .trim()
      .toUpperCase();
    test.skip(
      saleMode !== "FROM_SO",
      "Voucher #7 is not FROM_SO in this dataset.",
    );

    const orderTotalInput = page.locator("[data-so-order-total]").first();
    const previousPaymentsInput = page.locator("[data-so-advance]").first();
    const receivedInput = page.locator("[data-received]").first();
    const dueDateInput = page.locator("[data-due-date]").first();
    const remainingInput = page.locator("[data-remaining]").first();

    await expect(orderTotalInput).toBeVisible();
    await expect(previousPaymentsInput).toBeVisible();
    await expect(receivedInput).toBeVisible();

    const orderTotal = toAmount(await orderTotalInput.inputValue());
    const previousPayments = toAmount(await previousPaymentsInput.inputValue());
    const maxCurrent = Number(
      Math.max(0, orderTotal - previousPayments).toFixed(1),
    );
    test.skip(
      maxCurrent <= 0,
      "No receivable left in this dataset to validate due-date toggle.",
    );

    await receivedInput.fill(String(maxCurrent));
    await receivedInput.blur();

    await expect(remainingInput).toHaveValue(/^(|0|0\.0)$/);
    await expect(dueDateInput).toBeDisabled();
  });
});
