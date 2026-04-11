const knex = require("../../db/knex");

const VOUCHER_TYPES = {
  cash: "CASH_VOUCHER",
  bank: "BANK_VOUCHER",
  journal: "JOURNAL_VOUCHER",
};
const PURCHASE_VOUCHER_TYPES = {
  generalPurchase: "PI",
  purchaseReturn: "PR",
};
const SALES_VOUCHER_TYPES = {
  salesOrder: "SALES_ORDER",
  salesVoucher: "SALES_VOUCHER",
};
const PURCHASE_PAYMENT_TYPES = {
  cash: "CASH",
  credit: "CREDIT",
};
const PURCHASE_ACCOUNT_GROUP_CODES = {
  inventoryRm: "inventory_rm",
};
const SALES_ACCOUNT_GROUP_CODES = {
  salesRevenue: "sales_revenue",
  advancesFromCustomers: "advances_from_customers",
};

const SUPPORTED_POSTING_RULES = {
  [VOUCHER_TYPES.cash]: {
    includeLine: () => true,
  },
  [VOUCHER_TYPES.journal]: {
    includeLine: () => true,
  },
  [VOUCHER_TYPES.bank]: {
    // Prevent duplicate economics: auto-settlement rows reference source voucher in meta.
    includeLine: (line) => {
      const sourceVoucherId = Number(line?.meta?.source_voucher_id || 0);
      return !(Number.isInteger(sourceVoucherId) && sourceVoucherId > 0);
    },
  },
  [PURCHASE_VOUCHER_TYPES.generalPurchase]: {
    buildEntriesTx: ({ trx, header, voucherId }) =>
      buildGeneralPurchaseEntriesTx({ trx, header, voucherId }),
  },
  [PURCHASE_VOUCHER_TYPES.purchaseReturn]: {
    buildEntriesTx: ({ trx, header, voucherId }) =>
      buildPurchaseReturnEntriesTx({ trx, header, voucherId }),
  },
  [SALES_VOUCHER_TYPES.salesOrder]: {
    buildEntriesTx: ({ trx, header, voucherId }) =>
      buildSalesOrderAdvanceEntriesTx({ trx, header, voucherId }),
    allowWhenAffectsGlFalse: true,
  },
  [SALES_VOUCHER_TYPES.salesVoucher]: {
    buildEntriesTx: ({ trx, header, voucherId }) =>
      buildSalesVoucherEntriesTx({ trx, header, voucherId }),
  },
};

const VOUCHERS_WITH_HEADER_BALANCING = new Set([
  VOUCHER_TYPES.cash,
  VOUCHER_TYPES.bank,
]);
const CONTROL_GROUP_CODES = {
  partyReceivable: "accounts_receivable_control",
  partyPayable: "accounts_payable_control",
  payrollLiabilities: "payroll_liabilities",
  labourPayable: "wages_payable",
  employeePayable: "salaries_payable",
};
const CONTROL_GROUP_PREFERRED_ACCOUNT_CODES = {
  [CONTROL_GROUP_CODES.partyReceivable]: "gl_ar_control",
  [CONTROL_GROUP_CODES.partyPayable]: "gl_ap_control",
  [CONTROL_GROUP_CODES.labourPayable]: "gl_wages_payable_control",
  [CONTROL_GROUP_CODES.employeePayable]: "gl_salaries_payable_control",
  [SALES_ACCOUNT_GROUP_CODES.salesRevenue]: "gl_sales_revenue",
  [SALES_ACCOUNT_GROUP_CODES.advancesFromCustomers]:
    "gl_advances_from_customers",
};
const PARTY_TYPE_TO_CONTROL_GROUP = {
  CUSTOMER: CONTROL_GROUP_CODES.partyReceivable,
  SUPPLIER: CONTROL_GROUP_CODES.partyPayable,
  BOTH: CONTROL_GROUP_CODES.partyReceivable,
};

const normalizeAmount = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(2));
};

const toNullableInt = (value) => {
  const n = Number(value || 0);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const toNarration = (lineMeta = {}, fallback = "") => {
  const text = String(lineMeta.description || fallback || "").trim();
  return text || null;
};
const normalizePurchasePaymentType = (value) => {
  const text = String(value || PURCHASE_PAYMENT_TYPES.credit)
    .trim()
    .toUpperCase();
  return text === PURCHASE_PAYMENT_TYPES.cash
    ? PURCHASE_PAYMENT_TYPES.cash
    : PURCHASE_PAYMENT_TYPES.credit;
};

const normalizeSalesPaymentType = (value) => {
  const text = String(value || "CASH")
    .trim()
    .toUpperCase();
  return text === "CREDIT" ? "CREDIT" : "CASH";
};

const deleteGlBatchByVoucherIdTx = async (trx, voucherId) => {
  const normalizedVoucherId = Number(voucherId || 0);
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0)
    return;
  await trx("erp.gl_batch")
    .where({ source_voucher_id: normalizedVoucherId })
    .del();
};

const loadAccountsByGroupTx = async ({ trx, branchId, groupCodes = [] }) => {
  const normalizedGroupCodes = [
    ...new Set(
      (groupCodes || [])
        .map((code) => String(code || "").trim())
        .filter(Boolean),
    ),
  ];
  if (!normalizedGroupCodes.length) return new Map();
  const rows = await trx("erp.accounts as a")
    .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .join("erp.account_branch as ab", "ab.account_id", "a.id")
    .select("a.id", "a.code", "ag.code as group_code")
    .where({
      "ab.branch_id": branchId,
      "a.is_active": true,
      "ag.is_active": true,
    })
    .whereIn("ag.code", normalizedGroupCodes)
    .orderBy("a.id", "asc");

  const grouped = new Map();
  for (const row of rows) {
    const code = String(row.group_code || "").trim();
    if (!code) continue;
    const candidates = grouped.get(code) || [];
    candidates.push({
      id: Number(row.id),
      code: String(row.code || "")
        .trim()
        .toLowerCase(),
    });
    grouped.set(code, candidates);
  }
  return grouped;
};

const resolveSingleAccountIdForGroup = ({
  accountsByGroup,
  groupCode,
  voucherId,
  lineNo,
  explicitPreferredCode = null,
  fallbackGroupCodes = [],
}) => {
  const groupCodesToSearch = [
    groupCode,
    ...(fallbackGroupCodes || []).map((code) => String(code || "").trim()),
  ].filter(Boolean);
  const preferredCode = String(
    explicitPreferredCode || CONTROL_GROUP_PREFERRED_ACCOUNT_CODES[groupCode] || "",
  )
    .trim()
    .toLowerCase();

  let foundAnyCandidates = false;
  for (const candidateGroupCode of groupCodesToSearch) {
    const candidates = (accountsByGroup.get(candidateGroupCode) || []).filter(
      (row) => Number.isInteger(Number(row.id || 0)) && Number(row.id) > 0,
    );
    if (!candidates.length) continue;
    foundAnyCandidates = true;

    if (preferredCode) {
      const preferredMatches = candidates.filter(
        (row) => String(row.code || "").toLowerCase() === preferredCode,
      );
      if (preferredMatches.length === 1) {
        return Number(preferredMatches[0].id);
      }
      if (preferredMatches.length > 1) {
        throw new Error(
          `GL posting failed: voucher ${voucherId} line ${lineNo} has duplicate preferred control account code '${preferredCode}' in group '${candidateGroupCode}'`,
        );
      }
      continue;
    }

    if (candidates.length > 1) {
      throw new Error(
        `GL posting failed: voucher ${voucherId} line ${lineNo} has multiple accounts in control account group '${candidateGroupCode}' for current branch`,
      );
    }
    return Number(candidates[0].id);
  }

  if (!foundAnyCandidates) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} line ${lineNo} requires control account group '${groupCode}' in current branch`,
    );
  }
  if (preferredCode) {
    const searchedGroups = groupCodesToSearch.join(", ");
    throw new Error(
      `GL posting failed: voucher ${voucherId} line ${lineNo} requires control account code '${preferredCode}' in group(s) '${searchedGroups}'`,
    );
  }
  throw new Error(
    `GL posting failed: voucher ${voucherId} line ${lineNo} could not resolve control account for group '${groupCode}'`,
  );
};

const loadPurchaseItemTotalTx = async ({ trx, voucherId }) => {
  const lines = await trx("erp.voucher_line")
    .select("line_no", "amount", "qty", "rate")
    .where({ voucher_header_id: voucherId, line_kind: "ITEM" })
    .orderBy("line_no", "asc");
  if (!lines.length) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} has no ITEM lines`,
    );
  }
  return normalizeAmount(
    lines.reduce((sum, line) => {
      const amount = normalizeAmount(line.amount || 0);
      if (amount > 0) return sum + amount;
      const qty = Number(line.qty || 0);
      const rate = Number(line.rate || 0);
      if (qty > 0 && rate > 0) return sum + normalizeAmount(qty * rate);
      throw new Error(
        `GL posting failed: voucher ${voucherId} line ${Number(line.line_no || 0) || "?"} has invalid amount`,
      );
    }, 0),
  );
};

const loadPartyTypeByIdTx = async ({ trx, partyId }) => {
  const normalizedPartyId = Number(partyId || 0);
  if (!Number.isInteger(normalizedPartyId) || normalizedPartyId <= 0)
    return null;
  const party = await trx("erp.parties")
    .select("party_type", "is_active")
    .where({ id: normalizedPartyId })
    .first();
  if (!party || party.is_active !== true) return null;
  return String(party.party_type || "").toUpperCase() || null;
};

const ensureCashOrBankAccountTx = async ({
  trx,
  branchId,
  voucherId,
  accountId,
}) => {
  const normalizedAccountId = Number(accountId || 0);
  if (!Number.isInteger(normalizedAccountId) || normalizedAccountId <= 0) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} has invalid cash paid account`,
    );
  }

  const row = await trx("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .select("a.id", "a.lock_posting", "apc.code as posting_class_code")
    .where({ "a.id": normalizedAccountId, "a.is_active": true })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .andWhere("ab.branch_id", branchId);
    })
    .first();

  if (!row)
    throw new Error(
      `GL posting failed: voucher ${voucherId} cash paid account is invalid for current branch`,
    );
  const postingClassCode = String(row.posting_class_code || "")
    .trim()
    .toLowerCase();
  if (postingClassCode !== "cash" && postingClassCode !== "bank") {
    throw new Error(
      `GL posting failed: voucher ${voucherId} cash paid account must be cash/bank`,
    );
  }
  if (row.lock_posting === true) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} cash paid account is posting-locked`,
    );
  }
  return Number(row.id);
};

const buildGeneralPurchaseEntriesTx = async ({ trx, header, voucherId }) => {
  const extension = await trx("erp.purchase_invoice_header_ext")
    .select("supplier_party_id", "payment_type", "cash_paid_account_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!extension)
    throw new Error(
      `GL posting failed: voucher ${voucherId} missing purchase invoice extension`,
    );

  const paymentType = normalizePurchasePaymentType(extension.payment_type);
  const supplierPartyId = Number(extension.supplier_party_id || 0);
  const totalAmount = await loadPurchaseItemTotalTx({ trx, voucherId });
  if (totalAmount <= 0) return [];

  const accountsByGroup = await loadAccountsByGroupTx({
    trx,
    branchId: Number(header.branch_id),
    groupCodes: [
      PURCHASE_ACCOUNT_GROUP_CODES.inventoryRm,
      CONTROL_GROUP_CODES.partyPayable,
    ],
  });
  const inventoryRmAccountId = resolveSingleAccountIdForGroup({
    accountsByGroup,
    groupCode: PURCHASE_ACCOUNT_GROUP_CODES.inventoryRm,
    voucherId,
    lineNo: 0,
  });

  const entries = [
    {
      branch_id: Number(header.branch_id),
      entry_date: header.voucher_date,
      account_id: Number(inventoryRmAccountId),
      dept_id: null,
      party_id: null,
      dr: totalAmount,
      cr: 0,
      narration: toNarration({}, header.remarks),
    },
  ];

  if (paymentType === PURCHASE_PAYMENT_TYPES.cash) {
    const cashAccountId = await ensureCashOrBankAccountTx({
      trx,
      branchId: Number(header.branch_id),
      voucherId,
      accountId: extension.cash_paid_account_id,
    });
    entries.push({
      branch_id: Number(header.branch_id),
      entry_date: header.voucher_date,
      account_id: Number(cashAccountId),
      dept_id: null,
      party_id: null,
      dr: 0,
      cr: totalAmount,
      narration: toNarration({}, header.remarks),
    });
    return entries;
  }

  if (!Number.isInteger(supplierPartyId) || supplierPartyId <= 0) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} has invalid supplier`,
    );
  }
  const partyType = await loadPartyTypeByIdTx({
    trx,
    partyId: supplierPartyId,
  });
  if (partyType !== "SUPPLIER" && partyType !== "BOTH") {
    throw new Error(
      `GL posting failed: voucher ${voucherId} supplier party type must be SUPPLIER/BOTH`,
    );
  }

  const apControlAccountId = resolveSingleAccountIdForGroup({
    accountsByGroup,
    groupCode: CONTROL_GROUP_CODES.partyPayable,
    voucherId,
    lineNo: 0,
  });
  entries.push({
    branch_id: Number(header.branch_id),
    entry_date: header.voucher_date,
    account_id: Number(apControlAccountId),
    dept_id: null,
    party_id: supplierPartyId,
    dr: 0,
    cr: totalAmount,
    narration: toNarration({}, header.remarks),
  });
  return entries;
};

const buildPurchaseReturnEntriesTx = async ({ trx, header, voucherId }) => {
  const extension = await trx("erp.purchase_return_header_ext")
    .select("supplier_party_id")
    .where({ voucher_id: voucherId })
    .first();
  if (!extension)
    throw new Error(
      `GL posting failed: voucher ${voucherId} missing purchase return extension`,
    );

  const supplierPartyId = Number(extension.supplier_party_id || 0);
  if (!Number.isInteger(supplierPartyId) || supplierPartyId <= 0) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} has invalid supplier`,
    );
  }
  const partyType = await loadPartyTypeByIdTx({
    trx,
    partyId: supplierPartyId,
  });
  if (partyType !== "SUPPLIER" && partyType !== "BOTH") {
    throw new Error(
      `GL posting failed: voucher ${voucherId} supplier party type must be SUPPLIER/BOTH`,
    );
  }

  const totalAmount = await loadPurchaseItemTotalTx({ trx, voucherId });
  if (totalAmount <= 0) return [];

  const accountsByGroup = await loadAccountsByGroupTx({
    trx,
    branchId: Number(header.branch_id),
    groupCodes: [
      PURCHASE_ACCOUNT_GROUP_CODES.inventoryRm,
      CONTROL_GROUP_CODES.partyPayable,
    ],
  });
  const inventoryRmAccountId = resolveSingleAccountIdForGroup({
    accountsByGroup,
    groupCode: PURCHASE_ACCOUNT_GROUP_CODES.inventoryRm,
    voucherId,
    lineNo: 0,
  });
  const apControlAccountId = resolveSingleAccountIdForGroup({
    accountsByGroup,
    groupCode: CONTROL_GROUP_CODES.partyPayable,
    voucherId,
    lineNo: 0,
  });

  return [
    {
      branch_id: Number(header.branch_id),
      entry_date: header.voucher_date,
      account_id: Number(apControlAccountId),
      dept_id: null,
      party_id: supplierPartyId,
      dr: totalAmount,
      cr: 0,
      narration: toNarration({}, header.remarks),
    },
    {
      branch_id: Number(header.branch_id),
      entry_date: header.voucher_date,
      account_id: Number(inventoryRmAccountId),
      dept_id: null,
      party_id: null,
      dr: 0,
      cr: totalAmount,
      narration: toNarration({}, header.remarks),
    },
  ];
};

const loadSalesVoucherNetAmountTx = async ({ trx, voucherId }) => {
  const row = await trx("erp.voucher_line")
    .sum({ amount: knex.raw("COALESCE(amount, 0)") })
    .where({ voucher_header_id: voucherId, line_kind: "SKU" })
    .first();
  return normalizeAmount(row?.amount || 0);
};

const buildSalesOrderAdvanceEntriesTx = async ({ trx, header, voucherId }) => {
  const extension = await trx("erp.sales_order_header")
    .select(
      "customer_party_id",
      "payment_received_amount",
      "receive_into_account_id",
    )
    .where({ voucher_id: voucherId })
    .first();
  if (!extension)
    throw new Error(
      `GL posting failed: voucher ${voucherId} missing sales order extension`,
    );

  const customerPartyId = Number(extension.customer_party_id || 0);
  if (!Number.isInteger(customerPartyId) || customerPartyId <= 0) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} has invalid customer`,
    );
  }
  const partyType = await loadPartyTypeByIdTx({
    trx,
    partyId: customerPartyId,
  });
  if (partyType !== "CUSTOMER" && partyType !== "BOTH") {
    throw new Error(
      `GL posting failed: voucher ${voucherId} customer party type must be CUSTOMER/BOTH`,
    );
  }

  const advanceAmount = normalizeAmount(extension.payment_received_amount || 0);
  if (advanceAmount <= 0) return [];

  const receiveAccountId = await ensureCashOrBankAccountTx({
    trx,
    branchId: Number(header.branch_id),
    voucherId,
    accountId: extension.receive_into_account_id,
  });

  const accountsByGroup = await loadAccountsByGroupTx({
    trx,
    branchId: Number(header.branch_id),
    groupCodes: [SALES_ACCOUNT_GROUP_CODES.advancesFromCustomers],
  });
  const advancesAccountId = resolveSingleAccountIdForGroup({
    accountsByGroup,
    groupCode: SALES_ACCOUNT_GROUP_CODES.advancesFromCustomers,
    voucherId,
    lineNo: 0,
  });

  return [
    {
      branch_id: Number(header.branch_id),
      entry_date: header.voucher_date,
      account_id: Number(receiveAccountId),
      dept_id: null,
      party_id: null,
      dr: advanceAmount,
      cr: 0,
      narration: toNarration({}, header.remarks),
    },
    {
      branch_id: Number(header.branch_id),
      entry_date: header.voucher_date,
      account_id: Number(advancesAccountId),
      dept_id: null,
      party_id: customerPartyId,
      dr: 0,
      cr: advanceAmount,
      narration: toNarration({}, header.remarks),
    },
  ];
};

const buildSalesVoucherEntriesTx = async ({ trx, header, voucherId }) => {
  const extension = await trx("erp.sales_header")
    .select(
      "sale_mode",
      "payment_type",
      "customer_party_id",
      "receive_into_account_id",
      "payment_received_amount",
      "extra_discount",
    )
    .where({ voucher_id: voucherId })
    .first();
  if (!extension)
    throw new Error(
      `GL posting failed: voucher ${voucherId} missing sales voucher extension`,
    );

  const paymentType = normalizeSalesPaymentType(extension.payment_type);
  const saleMode = String(extension.sale_mode || "DIRECT")
    .trim()
    .toUpperCase();
  const customerPartyId = Number(extension.customer_party_id || 0) || null;
  const lineNetAmount = await loadSalesVoucherNetAmountTx({ trx, voucherId });
  const extraDiscount = normalizeAmount(extension.extra_discount || 0);
  const netSaleAmount = normalizeAmount(lineNetAmount - extraDiscount);
  const paymentReceivedAmount = normalizeAmount(
    extension.payment_received_amount || 0,
  );

  if (netSaleAmount === 0) return [];

  const accountsByGroup = await loadAccountsByGroupTx({
    trx,
    branchId: Number(header.branch_id),
    groupCodes: [
      SALES_ACCOUNT_GROUP_CODES.salesRevenue,
      CONTROL_GROUP_CODES.partyReceivable,
    ],
  });
  const salesRevenueAccountId = resolveSingleAccountIdForGroup({
    accountsByGroup,
    groupCode: SALES_ACCOUNT_GROUP_CODES.salesRevenue,
    voucherId,
    lineNo: 0,
  });

  if (paymentType === "CASH") {
    const settlementAmount = normalizeAmount(Math.abs(netSaleAmount));
    if (normalizeAmount(paymentReceivedAmount - settlementAmount) !== 0) {
      throw new Error(
        `GL posting failed: voucher ${voucherId} cash sale settlement mismatch`,
      );
    }
    const receiveAccountId = await ensureCashOrBankAccountTx({
      trx,
      branchId: Number(header.branch_id),
      voucherId,
      accountId: extension.receive_into_account_id,
    });
    if (netSaleAmount > 0) {
      return [
        {
          branch_id: Number(header.branch_id),
          entry_date: header.voucher_date,
          account_id: Number(salesRevenueAccountId),
          dept_id: null,
          party_id: null,
          dr: 0,
          cr: netSaleAmount,
          narration: toNarration({}, header.remarks),
        },
        {
          branch_id: Number(header.branch_id),
          entry_date: header.voucher_date,
          account_id: Number(receiveAccountId),
          dept_id: null,
          party_id: null,
          dr: netSaleAmount,
          cr: 0,
          narration: toNarration({}, header.remarks),
        },
      ];
    }
    return [
      {
        branch_id: Number(header.branch_id),
        entry_date: header.voucher_date,
        account_id: Number(salesRevenueAccountId),
        dept_id: null,
        party_id: null,
        dr: settlementAmount,
        cr: 0,
        narration: toNarration({}, header.remarks),
      },
      {
        branch_id: Number(header.branch_id),
        entry_date: header.voucher_date,
        account_id: Number(receiveAccountId),
        dept_id: null,
        party_id: null,
        dr: 0,
        cr: settlementAmount,
        narration: toNarration({}, header.remarks),
      },
    ];
  }

  if (netSaleAmount < 0) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} negative net amount is only supported for cash settlement`,
    );
  }

  const entries = [
    {
      branch_id: Number(header.branch_id),
      entry_date: header.voucher_date,
      account_id: Number(salesRevenueAccountId),
      dept_id: null,
      party_id: null,
      dr: 0,
      cr: netSaleAmount,
      narration: toNarration({}, header.remarks),
    },
  ];

  if (
    !Number.isInteger(Number(customerPartyId || 0)) ||
    Number(customerPartyId) <= 0
  ) {
    throw new Error(
      `GL posting failed: voucher ${voucherId} credit sale requires customer`,
    );
  }
  const partyType = await loadPartyTypeByIdTx({
    trx,
    partyId: Number(customerPartyId),
  });
  if (partyType !== "CUSTOMER" && partyType !== "BOTH") {
    throw new Error(
      `GL posting failed: voucher ${voucherId} customer party type must be CUSTOMER/BOTH`,
    );
  }

  const arControlAccountId = resolveSingleAccountIdForGroup({
    accountsByGroup,
    groupCode: CONTROL_GROUP_CODES.partyReceivable,
    voucherId,
    lineNo: 0,
  });
  entries.push({
    branch_id: Number(header.branch_id),
    entry_date: header.voucher_date,
    account_id: Number(arControlAccountId),
    dept_id: null,
    party_id: Number(customerPartyId),
    dr: netSaleAmount,
    cr: 0,
    narration: toNarration({}, header.remarks),
  });

  if (paymentReceivedAmount > 0) {
    if (saleMode !== "FROM_SO" && paymentReceivedAmount > netSaleAmount) {
      throw new Error(
        `GL posting failed: voucher ${voucherId} received amount exceeds net sale`,
      );
    }
    const receiveAccountId = await ensureCashOrBankAccountTx({
      trx,
      branchId: Number(header.branch_id),
      voucherId,
      accountId: extension.receive_into_account_id,
    });
    entries.push(
      {
        branch_id: Number(header.branch_id),
        entry_date: header.voucher_date,
        account_id: Number(receiveAccountId),
        dept_id: null,
        party_id: null,
        dr: paymentReceivedAmount,
        cr: 0,
        narration: toNarration({}, header.remarks),
      },
      {
        branch_id: Number(header.branch_id),
        entry_date: header.voucher_date,
        account_id: Number(arControlAccountId),
        dept_id: null,
        party_id: Number(customerPartyId),
        dr: 0,
        cr: paymentReceivedAmount,
        narration: toNarration({}, header.remarks),
      },
    );
  }

  return entries;
};

const resolvePartyTypeTx = async ({ trx, partyId, partyTypeByIdCache }) => {
  const normalizedPartyId = Number(partyId || 0);
  if (!Number.isInteger(normalizedPartyId) || normalizedPartyId <= 0) {
    return null;
  }
  if (partyTypeByIdCache.has(normalizedPartyId)) {
    return partyTypeByIdCache.get(normalizedPartyId);
  }
  const party = await trx("erp.parties")
    .select("party_type")
    .where({ id: normalizedPartyId })
    .first();
  const partyType = String(party?.party_type || "").toUpperCase() || null;
  partyTypeByIdCache.set(normalizedPartyId, partyType);
  return partyType;
};

const resolvePostingAccountForLineTx = async ({
  trx,
  voucherId,
  line,
  controlAccountsByGroup,
  partyTypeByIdCache,
}) => {
  const lineNo = Number(line.line_no || 0) || "?";
  const lineKind = String(line.line_kind || "").toUpperCase();

  if (lineKind === "ACCOUNT") {
    const accountId = Number(line.account_id || 0);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new Error(
        `GL posting failed: voucher ${voucherId} line ${lineNo} has invalid account reference`,
      );
    }
    return { accountId, partyId: toNullableInt(line.party_id) };
  }

  if (lineKind === "PARTY") {
    const partyId = Number(line.party_id || 0);
    if (!Number.isInteger(partyId) || partyId <= 0) {
      throw new Error(
        `GL posting failed: voucher ${voucherId} line ${lineNo} has invalid party reference`,
      );
    }
    const partyType = await resolvePartyTypeTx({
      trx,
      partyId,
      partyTypeByIdCache,
    });
    const groupCode =
      PARTY_TYPE_TO_CONTROL_GROUP[String(partyType || "").toUpperCase()];
    if (!groupCode) {
      throw new Error(
        `GL posting failed: voucher ${voucherId} line ${lineNo} has unsupported party type`,
      );
    }
    return {
      accountId: resolveSingleAccountIdForGroup({
        accountsByGroup: controlAccountsByGroup,
        groupCode,
        voucherId,
        lineNo,
      }),
      partyId: partyId,
    };
  }

  if (lineKind === "LABOUR") {
    return {
      accountId: resolveSingleAccountIdForGroup({
        accountsByGroup: controlAccountsByGroup,
        groupCode: CONTROL_GROUP_CODES.payrollLiabilities,
        fallbackGroupCodes: [CONTROL_GROUP_CODES.labourPayable],
        explicitPreferredCode: "gl_wages_payable_control",
        voucherId,
        lineNo,
      }),
      partyId: null,
    };
  }

  if (lineKind === "EMPLOYEE") {
    return {
      accountId: resolveSingleAccountIdForGroup({
        accountsByGroup: controlAccountsByGroup,
        groupCode: CONTROL_GROUP_CODES.payrollLiabilities,
        fallbackGroupCodes: [CONTROL_GROUP_CODES.employeePayable],
        explicitPreferredCode: "gl_salaries_payable_control",
        voucherId,
        lineNo,
      }),
      partyId: null,
    };
  }

  throw new Error(
    `GL posting failed: voucher ${voucherId} line ${lineNo} has unsupported line kind '${lineKind}'`,
  );
};

const syncVoucherGlPostingTx = async ({ trx, voucherId }) => {
  const normalizedVoucherId = Number(voucherId || 0);
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0)
    return { mode: "noop", lines: 0 };

  const header = await trx("erp.voucher_header as vh")
    .leftJoin("erp.voucher_type as vt", "vt.code", "vh.voucher_type_code")
    .select(
      "vh.id",
      "vh.voucher_type_code",
      "vh.status",
      "vh.branch_id",
      "vh.voucher_date",
      "vh.remarks",
      "vh.header_account_id",
      "vt.affects_gl",
    )
    .where("vh.id", normalizedVoucherId)
    .first();

  if (!header) return { mode: "missing", lines: 0 };

  const rule =
    SUPPORTED_POSTING_RULES[
      String(header.voucher_type_code || "").toUpperCase()
    ];
  if (!rule) {
    await deleteGlBatchByVoucherIdTx(trx, normalizedVoucherId);
    return { mode: "unsupported", lines: 0 };
  }

  if (
    header.status !== "APPROVED" ||
    (header.affects_gl !== true && rule.allowWhenAffectsGlFalse !== true)
  ) {
    await deleteGlBatchByVoucherIdTx(trx, normalizedVoucherId);
    return { mode: "unposted", lines: 0 };
  }

  let entries = [];
  if (typeof rule.buildEntriesTx === "function") {
    entries = await rule.buildEntriesTx({
      trx,
      header,
      voucherId: normalizedVoucherId,
    });
  } else {
    const lines = await trx("erp.voucher_line")
      .select(
        "id",
        "line_no",
        "line_kind",
        "account_id",
        "party_id",
        "labour_id",
        "employee_id",
        "meta",
      )
      .where({ voucher_header_id: normalizedVoucherId })
      .orderBy("line_no", "asc");
    const controlAccountsByGroup = await loadAccountsByGroupTx({
      trx,
      branchId: Number(header.branch_id),
      groupCodes: Object.values(CONTROL_GROUP_CODES),
    });
    const partyTypeByIdCache = new Map();

    entries = [];
    for (const line of lines) {
      if (!rule.includeLine(line)) continue;
      const postingRef = await resolvePostingAccountForLineTx({
        trx,
        voucherId: normalizedVoucherId,
        line,
        controlAccountsByGroup,
        partyTypeByIdCache,
      });
      const meta = line.meta && typeof line.meta === "object" ? line.meta : {};
      const dr = normalizeAmount(meta.debit || 0);
      const cr = normalizeAmount(meta.credit || 0);
      if ((dr > 0 && cr > 0) || (dr <= 0 && cr <= 0)) continue;

      entries.push({
        branch_id: Number(header.branch_id),
        entry_date: header.voucher_date,
        account_id: Number(postingRef.accountId),
        dept_id: toNullableInt(meta.department_id),
        party_id: toNullableInt(postingRef.partyId),
        dr,
        cr,
        narration: toNarration(meta, header.remarks),
      });
    }
  }

  if (!entries.length) {
    await deleteGlBatchByVoucherIdTx(trx, normalizedVoucherId);
    return { mode: "no_entries", lines: 0 };
  }

  let totalDebit = normalizeAmount(
    entries.reduce((sum, row) => sum + normalizeAmount(row.dr || 0), 0),
  );
  let totalCredit = normalizeAmount(
    entries.reduce((sum, row) => sum + normalizeAmount(row.cr || 0), 0),
  );
  const voucherTypeCode = String(header.voucher_type_code || "").toUpperCase();
  const headerAccountId = Number(header.header_account_id || 0);

  if (
    totalDebit !== totalCredit &&
    VOUCHERS_WITH_HEADER_BALANCING.has(voucherTypeCode)
  ) {
    if (!Number.isInteger(headerAccountId) || headerAccountId <= 0) {
      throw new Error(
        `GL posting failed: voucher ${normalizedVoucherId} requires a header account for balancing`,
      );
    }
    if (totalDebit > totalCredit) {
      entries.push({
        branch_id: Number(header.branch_id),
        entry_date: header.voucher_date,
        account_id: headerAccountId,
        dept_id: null,
        party_id: null,
        dr: 0,
        cr: normalizeAmount(totalDebit - totalCredit),
        narration: toNarration({}, header.remarks),
      });
    } else {
      entries.push({
        branch_id: Number(header.branch_id),
        entry_date: header.voucher_date,
        account_id: headerAccountId,
        dept_id: null,
        party_id: null,
        dr: normalizeAmount(totalCredit - totalDebit),
        cr: 0,
        narration: toNarration({}, header.remarks),
      });
    }

    totalDebit = normalizeAmount(
      entries.reduce((sum, row) => sum + normalizeAmount(row.dr || 0), 0),
    );
    totalCredit = normalizeAmount(
      entries.reduce((sum, row) => sum + normalizeAmount(row.cr || 0), 0),
    );
  }

  if (totalDebit !== totalCredit) {
    throw new Error(
      `GL posting failed: voucher ${normalizedVoucherId} is unbalanced for posting (debit ${totalDebit} != credit ${totalCredit})`,
    );
  }

  let batch = await trx("erp.gl_batch")
    .select("id")
    .where({ source_voucher_id: normalizedVoucherId })
    .first();
  if (!batch) {
    const [created] = await trx("erp.gl_batch")
      .insert({ source_voucher_id: normalizedVoucherId })
      .returning("id");
    batch = { id: Number(created?.id || created) };
  } else {
    await trx("erp.gl_entry").where({ batch_id: batch.id }).del();
  }

  await trx("erp.gl_entry").insert(
    entries.map((entry) => ({
      batch_id: batch.id,
      ...entry,
    })),
  );

  return { mode: "posted", lines: entries.length };
};

const syncVoucherGlPosting = async ({ voucherId }) =>
  knex.transaction(async (trx) => syncVoucherGlPostingTx({ trx, voucherId }));

module.exports = {
  syncVoucherGlPostingTx,
  syncVoucherGlPosting,
  deleteGlBatchByVoucherIdTx,
};
