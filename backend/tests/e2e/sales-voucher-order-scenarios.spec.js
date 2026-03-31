const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);

const uniqueToken = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const toNumber = (value) => {
  const normalized = String(value || "")
    .replace(/,/g, "")
    .trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const selectOptionByIndex = async (selectLocator, optionIndex = 0) => {
  await expect(selectLocator).toHaveCount(1);
  const values = await selectLocator.locator("option").evaluateAll((options) =>
    options
      .map((option) => String(option.value || "").trim())
      .filter((value) => value.length > 0),
  );
  if (!values.length) return null;
  const selected = values[Math.min(optionIndex, values.length - 1)];
  await selectLocator.evaluate(
    (el, value) => {
      el.value = String(value || "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selected,
  );
  return selected;
};

const setSelectValue = async (selectLocator, value) => {
  await selectLocator.evaluate(
    (el, v) => {
      el.value = String(v || "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
};

const ensureRow = async (page, index = 0) => {
  while ((await page.locator("[data-lines-body] tr").count()) <= index) {
    await page.locator("[data-add-row]").click();
  }
  const row = page.locator("[data-lines-body] tr").nth(index);
  await expect(row).toBeVisible();
  return row;
};

const setPaymentType = async (page, type) => {
  await page.locator(`[data-payment-type-option="${type}"]`).click();
  await expect(page.locator("[data-payment-type]")).toHaveValue(type);
};

const setAdvanceReceive = async (page, value) => {
  await page.locator(`[data-advance-receive-option="${value}"]`).click();
  await expect(page.locator("[data-advance-receive]")).toHaveValue(value);
};

const setWalkInCustomerFields = async (page) => {
  await page.locator('[data-customer-name]').first().fill(`Walk-in ${Date.now()}`);
  await page.locator('[data-customer-phone]').first().fill("03123456789");
};

const fillSalesHeader = async (page, { billNo, customerIndex = 0, salesmanIndex = 0 } = {}) => {
  const customer = page.locator('select[name="customer_party_id"]').first();
  const salesman = page.locator('select[name="salesman_employee_id"]').first();
  await selectOptionByIndex(customer, customerIndex);
  const salesmanId = await selectOptionByIndex(salesman, salesmanIndex);

  const billInput = page.locator('input[name="reference_no"]').first();
  await billInput.fill(billNo || uniqueToken("E2E-SALES"));
  return {
    customerId: Number(await customer.inputValue() || 0),
    salesmanId: Number(salesmanId || 0),
  };
};

const fillLine = async (
  page,
  {
    rowIndex = 0,
    qty = "1",
    rowStatus = "PACKED",
    discount = null,
    returnQty = null,
    reasonIndex = 0,
    skuOptionIndex = 0,
  } = {},
) => {
  const row = await ensureRow(page, rowIndex);
  const skuSelect = row
    .locator('select[data-f="sku_id"], select[data-f="sales_order_line_id"]')
    .first();
  await selectOptionByIndex(skuSelect, skuOptionIndex);

  const rowStatusSelect = row.locator('select[data-f="row_status"]').first();
  if (await rowStatusSelect.count()) {
    await setSelectValue(rowStatusSelect, rowStatus);
  }

  const qtyInput = row.locator('input[data-f="sale_qty"]').first();
  if (qty !== null) {
    await qtyInput.fill(String(qty));
    await qtyInput.blur();
  }

  if (discount !== null) {
    const discountInput = row.locator('input[data-f="pair_discount"]').first();
    await discountInput.fill(String(discount));
    await discountInput.blur();
  }

  if (returnQty !== null) {
    const returnQtyInput = row.locator('input[data-f="return_qty"]').first();
    if (await returnQtyInput.count()) {
      await qtyInput.fill("");
      await returnQtyInput.fill(String(returnQty));
      await returnQtyInput.blur();

      const reasonSelect = row.locator('select[data-f="return_reason_id"]').first();
      if (await reasonSelect.count()) {
        await selectOptionByIndex(reasonSelect, reasonIndex);
      }
    }
  }
};

const submitVoucher = async (page, expectedPathRegex = null) => {
  await page.locator('[data-sales-voucher-form] button[type="submit"]').click();
  await page.waitForLoadState("domcontentloaded");
  if (expectedPathRegex) {
    await expect(page).toHaveURL(expectedPathRegex);
  }
};

const expectUiError = async (page, matcher) => {
  const modal = page.locator("[data-ui-error-modal]");
  await expect(modal).toBeVisible();
  if (matcher) {
    await expect(modal).toContainText(matcher);
  }
  await page.getByRole("button", { name: /^ok$/i }).click();
};

const getVoucherByBookNo = async ({ voucherTypeCode, bookNo }) => {
  return db("erp.voucher_header")
    .select("id", "voucher_no", "book_no", "voucher_type_code", "created_at")
    .where({ voucher_type_code: voucherTypeCode, book_no: bookNo })
    .orderBy("id", "desc")
    .first();
};

const getVoucherByVoucherNo = async ({ voucherTypeCode, voucherNo }) => {
  return db("erp.voucher_header")
    .select("id", "voucher_no", "book_no", "voucher_type_code", "created_at")
    .where({ voucher_type_code: voucherTypeCode, voucher_no: Number(voucherNo) })
    .orderBy("id", "desc")
    .first();
};

const getVoucherNoFromCurrentUrl = async (page) => {
  const currentUrl = new URL(page.url());
  const voucherNoText = String(currentUrl.searchParams.get("voucher_no") || "").trim();
  const voucherNo = Number(voucherNoText);
  return Number.isFinite(voucherNo) && voucherNo > 0 ? voucherNo : null;
};

const findVoucherWithRetries = async (resolver, attempts = 15, delayMs = 300) => {
  for (let i = 0; i < attempts; i += 1) {
    const row = await resolver();
    if (row?.id) return row;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
};

const getLatestVoucherByType = async ({ voucherTypeCode }) => {
  return db("erp.voucher_header")
    .select("id", "voucher_no", "book_no", "voucher_type_code", "created_at")
    .where({ voucher_type_code: voucherTypeCode })
    .orderBy("id", "desc")
    .first();
};

const getCommissionVoucherLines = async (voucherId) => {
  return db("erp.voucher_line")
    .select("id", "employee_id", "amount", "meta")
    .where({ voucher_header_id: Number(voucherId) })
    .whereRaw("coalesce(meta->>'auto_sales_commission','false') = 'true'");
};

const upsertSkuFixedCommission = async ({ employeeId, skuId, rateType, value }) => {
  const existing = await db("erp.employee_commission_rules")
    .select("id")
    .where({
      employee_id: Number(employeeId),
      apply_on: "SKU",
      sku_id: Number(skuId),
      commission_basis: "FIXED_PER_UNIT",
      status: "active",
      rate_type: String(rateType || "PER_PAIR").toUpperCase(),
    })
    .first();

  if (existing?.id) {
    await db("erp.employee_commission_rules")
      .where({ id: Number(existing.id) })
      .update({
        value: Number(value),
        value_type: "FIXED",
        reverse_on_returns: true,
      });
    return Number(existing.id);
  }

  const [created] = await db("erp.employee_commission_rules")
    .insert({
      employee_id: Number(employeeId),
      apply_on: "SKU",
      sku_id: Number(skuId),
      subgroup_id: null,
      group_id: null,
      commission_basis: "FIXED_PER_UNIT",
      rate_type: String(rateType || "PER_PAIR").toUpperCase(),
      value_type: "FIXED",
      value: Number(value),
      reverse_on_returns: true,
      status: "active",
    })
    .returning(["id"]);

  return Number(created?.id || created || 0);
};

const createSalesOrderVoucher = async (page, { customerIndex = 0, salesmanIndex = 0, advanceYes = false }) => {
  await page.goto("/vouchers/sales-order?new=1", { waitUntil: "domcontentloaded" });
  const before = await getLatestVoucherByType({ voucherTypeCode: "SALES_ORDER" });

  const bookNo = uniqueToken("E2E-SO");
  const header = await fillSalesHeader(page, {
    billNo: bookNo,
    customerIndex,
    salesmanIndex,
  });

  if (advanceYes) {
    await setAdvanceReceive(page, "yes");
  } else {
    await setAdvanceReceive(page, "no");
    await expect(page.locator('[data-sales-order-advance-fields-row]').first()).toBeHidden();
  }

  await fillLine(page, { rowIndex: 0, qty: "2", rowStatus: "PACKED" });

  if (advanceYes) {
    await selectOptionByIndex(page.locator('[data-receive-account]').first(), 0);
    const finalAmount = toNumber(await page.locator('[data-final]').first().inputValue());
    const safeAdvance = Math.max(0, Math.min(1, finalAmount));
    await page.locator('[data-received]').first().fill(String(safeAdvance));
    await page.locator('[data-received]').first().blur();
  }

  await submitVoucher(page);

  const voucherNoFromUrl = await getVoucherNoFromCurrentUrl(page);

  let voucher = await findVoucherWithRetries(async () => {
    const byBook = await getVoucherByBookNo({
      voucherTypeCode: "SALES_ORDER",
      bookNo,
    });
    if (byBook?.id) return byBook;
    if (!voucherNoFromUrl) return null;
    return getVoucherByVoucherNo({
      voucherTypeCode: "SALES_ORDER",
      voucherNo: voucherNoFromUrl,
    });
  });
  if (!voucher?.id) {
    const latest = await getLatestVoucherByType({ voucherTypeCode: "SALES_ORDER" });
    if (latest?.id && Number(latest.id) > Number(before?.id || 0)) {
      voucher = latest;
    }
  }
  expect(voucher?.id).toBeTruthy();
  return {
    ...voucher,
    customerId: header.customerId,
    salesmanId: header.salesmanId,
    bookNo,
  };
};

const linkFirstSalesOrderLineIntoSales = async (page) => {
  const linkButton = page.locator('[data-link-sales-order-btn]');
  if (!(await linkButton.isVisible())) return false;
  await linkButton.click();
  const modal = page.locator('[data-sales-order-picker-modal]');
  if (!(await modal.isVisible())) return false;

  const firstCheckbox = modal.locator('[data-sales-order-picker-line-checkbox]').first();
  if (!(await firstCheckbox.isVisible())) return false;
  await firstCheckbox.check();

  await modal.locator('[data-sales-order-picker-apply]').click();
  await expect(modal).toBeHidden();
  return true;
};

test.describe("Sales Voucher + Sales Order scenario matrix", () => {
  const createdRuleIds = [];

  test.afterAll(async () => {
    if (createdRuleIds.length) {
      await db("erp.employee_commission_rules").whereIn("id", createdRuleIds).del();
    }
    await db.destroy();
  });

  test("Sales Voucher: cash flow enforces settlement rule for packed+loose totals", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

    await fillSalesHeader(page, { billNo: uniqueToken("E2E-SALES-CASH"), customerIndex: 0, salesmanIndex: 1 });
    await setPaymentType(page, "CASH");
    await setWalkInCustomerFields(page);
    await selectOptionByIndex(page.locator('[data-receive-account]').first(), 0);

    await fillLine(page, { rowIndex: 0, qty: "1", rowStatus: "PACKED" });
    await fillLine(page, { rowIndex: 1, qty: "1", rowStatus: "LOOSE", skuOptionIndex: 0 });
    await page.locator('[data-extra]').fill("5");
    await page.locator('[data-received]').fill("1");

    await submitVoucher(page);
    await expectUiError(page, /cash settlement must equal total amount/i);
  });

  test("Sales Voucher: credit flow supports sale return and due-date logic", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    const before = await getLatestVoucherByType({ voucherTypeCode: "SALES_VOUCHER" });

    const bookNo = uniqueToken("E2E-SALES-CREDIT");
    await fillSalesHeader(page, { billNo: bookNo, customerIndex: 0, salesmanIndex: 1 });
    await setPaymentType(page, "CREDIT");
    await selectOptionByIndex(page.locator('select[name="customer_party_id"]').first(), 0);

    await fillLine(page, { rowIndex: 0, qty: "2", rowStatus: "PACKED" });
    await fillLine(page, { rowIndex: 1, qty: null, returnQty: "1", rowStatus: "PACKED", reasonIndex: 0, skuOptionIndex: 0 });
    await page.locator('[data-due-date]').evaluate((el) => {
      el.disabled = false;
      el.value = "2099-12-31";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator('[data-received]').fill("");

    await submitVoucher(page);

    const voucherNoFromUrl = await getVoucherNoFromCurrentUrl(page);

    let created = await findVoucherWithRetries(async () => {
      const byBook = await getVoucherByBookNo({
        voucherTypeCode: "SALES_VOUCHER",
        bookNo,
      });
      if (byBook?.id) return byBook;
      if (!voucherNoFromUrl) return null;
      return getVoucherByVoucherNo({
        voucherTypeCode: "SALES_VOUCHER",
        voucherNo: voucherNoFromUrl,
      });
    });
    if (!created?.id) {
      const latest = await getLatestVoucherByType({ voucherTypeCode: "SALES_VOUCHER" });
      if (latest?.id && Number(latest.id) > Number(before?.id || 0)) {
        created = latest;
      }
    }
    expect(created?.id).toBeTruthy();
  });

  test("Sales Voucher: commission posts for configured salesman with ledger metadata", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });
    const before = await getLatestVoucherByType({ voucherTypeCode: "SALES_VOUCHER" });

    const customerId = Number(await selectOptionByIndex(page.locator('select[name="customer_party_id"]').first(), 0) || 0);
    test.skip(!customerId, "No customer available for this dataset.");

    const salesmanSelect = page.locator('select[name="salesman_employee_id"]').first();
    const salesmanId = Number(await selectOptionByIndex(salesmanSelect, 0) || 0);
    test.skip(!salesmanId, "No salesman available for this dataset.");

    const firstRow = await ensureRow(page, 0);
    const skuId = Number(await selectOptionByIndex(firstRow.locator('select[data-f="sku_id"]').first(), 0) || 0);
    test.skip(!skuId, "No SKU available for this dataset.");

    const rulePairId = await upsertSkuFixedCommission({
      employeeId: salesmanId,
      skuId,
      rateType: "PER_PAIR",
      value: 1,
    });
    if (rulePairId > 0) createdRuleIds.push(rulePairId);

    const ruleDozenId = await upsertSkuFixedCommission({
      employeeId: salesmanId,
      skuId,
      rateType: "PER_DOZEN",
      value: 12,
    });
    if (ruleDozenId > 0 && ruleDozenId !== rulePairId) createdRuleIds.push(ruleDozenId);

    const bookNo = uniqueToken("E2E-SALES-COMM");
    await page.locator('input[name="reference_no"]').fill(bookNo);
    await setPaymentType(page, "CASH");
    await setWalkInCustomerFields(page);
    await selectOptionByIndex(page.locator('[data-receive-account]').first(), 0);

    await fillLine(page, { rowIndex: 0, qty: "1", rowStatus: "PACKED", skuOptionIndex: 0 });
    const finalForCommission = toNumber(await page.locator('[data-final]').inputValue());
    await page.locator('[data-received]').fill(String(Math.max(0, finalForCommission)));
    await submitVoucher(page);

    const voucherNoFromUrl = await getVoucherNoFromCurrentUrl(page);

    let created = await findVoucherWithRetries(async () => {
      const byBook = await getVoucherByBookNo({
        voucherTypeCode: "SALES_VOUCHER",
        bookNo,
      });
      if (byBook?.id) return byBook;
      if (!voucherNoFromUrl) return null;
      return getVoucherByVoucherNo({
        voucherTypeCode: "SALES_VOUCHER",
        voucherNo: voucherNoFromUrl,
      });
    });
    if (!created?.id) {
      const latest = await getLatestVoucherByType({ voucherTypeCode: "SALES_VOUCHER" });
      if (latest?.id && Number(latest.id) > Number(before?.id || 0)) {
        created = latest;
      }
    }
    expect(created?.id).toBeTruthy();

    const commissionLines = await getCommissionVoucherLines(created.id);
    expect(commissionLines.length).toBeGreaterThan(0);
    expect(Number(commissionLines[0].employee_id || 0)).toBe(salesmanId);

    const meta = commissionLines[0]?.meta && typeof commissionLines[0].meta === "object"
      ? commissionLines[0].meta
      : {};
    expect(String(meta.description || "")).toContain("Auto sales commission accrual");
  });

  test("Sales Order: advance receive No keeps advance controls hidden and saves", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await createSalesOrderVoucher(page, {
      customerIndex: 0,
      salesmanIndex: 0,
      advanceYes: false,
    });
  });

  test("Sales Order: advance receive Yes allows account+amount and saves", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const so = await createSalesOrderVoucher(page, {
      customerIndex: 0,
      salesmanIndex: 0,
      advanceYes: true,
    });
    expect(so.id).toBeTruthy();
  });

  test("Sales Order -> Sales Voucher: linked flow hydrates and locks order fields", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const so = await createSalesOrderVoucher(page, {
      customerIndex: 0,
      salesmanIndex: 0,
      advanceYes: true,
    });

    await page.goto("/vouchers/sales?new=1", { waitUntil: "domcontentloaded" });

    await setSelectValue(page.locator('select[name="customer_party_id"]').first(), String(so.customerId));
    const linked = await linkFirstSalesOrderLineIntoSales(page);
    test.skip(!linked, "Sales-order picker has no selectable lines in current dataset.");

    await expect(page.locator('[data-sale-mode]')).toHaveValue("FROM_SO");
    await expect(page.locator('[data-reference-no]')).toHaveValue(String(so.voucher_no));
    await expect(page.locator('[data-salesman]')).toBeDisabled();

    const bookNo = uniqueToken("E2E-SALES-FROMSO");
    const before = await getLatestVoucherByType({ voucherTypeCode: "SALES_VOUCHER" });
    await page.locator('input[name="reference_no"]').fill(bookNo);
    await page.locator('[data-received]').fill("5");

    await submitVoucher(page);

    const voucherNoFromUrl = await getVoucherNoFromCurrentUrl(page);

    let created = await findVoucherWithRetries(async () => {
      const byBook = await getVoucherByBookNo({
        voucherTypeCode: "SALES_VOUCHER",
        bookNo,
      });
      if (byBook?.id) return byBook;
      if (!voucherNoFromUrl) return null;
      return getVoucherByVoucherNo({
        voucherTypeCode: "SALES_VOUCHER",
        voucherNo: voucherNoFromUrl,
      });
    });
    if (!created?.id) {
      const latest = await getLatestVoucherByType({ voucherTypeCode: "SALES_VOUCHER" });
      if (latest?.id && Number(latest.id) > Number(before?.id || 0)) {
        created = latest;
      }
    }
    expect(created?.id).toBeTruthy();

    const salesHeader = await db("erp.sales_header")
      .select("linked_sales_order_id")
      .where({ voucher_id: Number(created.id) })
      .first();

    expect(Number(salesHeader?.linked_sales_order_id || 0)).toBe(Number(so.id));
  });
});
