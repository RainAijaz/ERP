const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog, queueAuditLog } = require("../../utils/audit-log");
const { toLocalDateOnlyOrRaw } = require("../../utils/date-only");
const { syncVoucherGlPostingTx } = require("./gl-posting-service");

const VOUCHER_TYPES = {
  cash: "CASH_VOUCHER",
  bank: "BANK_VOUCHER",
  journal: "JOURNAL_VOUCHER",
};
const AUTO_BANK_SETTLEMENT_PREFIX = "[AUTO_BANK_SETTLEMENT]";

const normalizeNumber = (value, decimals = 2) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(decimals));
};

const normalizeText = (value, max = 500) => {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
};

const toLineRef = (line = {}) => {
  const accountId = Number(line.account_id || line.accountId || 0);
  const partyId = Number(line.party_id || line.partyId || 0);
  const labourId = Number(line.labour_id || line.labourId || 0);
  const employeeId = Number(line.employee_id || line.employeeId || 0);

  const refs = [
    accountId > 0 ? { line_kind: "ACCOUNT", account_id: accountId } : null,
    partyId > 0 ? { line_kind: "PARTY", party_id: partyId } : null,
    labourId > 0 ? { line_kind: "LABOUR", labour_id: labourId } : null,
    employeeId > 0 ? { line_kind: "EMPLOYEE", employee_id: employeeId } : null,
  ].filter(Boolean);

  if (refs.length !== 1) {
    throw new HttpError(
      400,
      "Each line must reference exactly one entity (account/party/labour/employee)",
    );
  }

  return refs[0];
};

const getAccountPostingClassMapTx = async ({ trx, req, accountIds = [] }) => {
  const uniqueIds = [
    ...new Set(
      (accountIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!uniqueIds.length) return new Map();
  const rows = await trx("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .leftJoin("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .select(
      "a.id",
      "a.lock_posting",
      "apc.code as posting_class_code",
      "apc.is_active as posting_class_active",
      "ag.account_type",
    )
    .whereIn("a.id", uniqueIds)
    .where({ "a.is_active": true })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .andWhere("ab.branch_id", req.branchId);
    });
  const map = new Map(
    rows.map((row) => [
      Number(row.id),
      {
        postingClassCode: String(row.posting_class_code || "").toLowerCase(),
        postingClassActive: row.posting_class_active !== false,
        accountType: String(row.account_type || "").toLowerCase(),
        lockPosting: row.lock_posting === true,
      },
    ]),
  );
  return map;
};

const validateLines = async ({
  trx,
  req,
  voucherTypeCode,
  rawLines = [],
  headerAccountId = null,
}) => {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) throw new HttpError(400, "Voucher lines are required");
  const normalizedHeaderAccountId = Number(headerAccountId || 0);
  const lineRefs = lines.map((line, index) => ({
    line,
    index,
    ref: toLineRef(line),
  }));
  const accountPostingClassById = await getAccountPostingClassMapTx({
    trx,
    req,
    accountIds: lineRefs
      .filter(({ ref }) => ref.line_kind === "ACCOUNT")
      .map(({ ref }) => Number(ref.account_id || 0)),
  });

  const normalized = lineRefs.map(({ line, index, ref }) => {
    if (
      (voucherTypeCode === VOUCHER_TYPES.cash ||
        voucherTypeCode === VOUCHER_TYPES.bank) &&
      normalizedHeaderAccountId > 0 &&
      ref.line_kind === "ACCOUNT" &&
      Number(ref.account_id || 0) === normalizedHeaderAccountId
    ) {
      throw new HttpError(
        400,
        `Line ${index + 1}: line account cannot be same as selected cash/bank account`,
      );
    }
    const description = normalizeText(
      line.description || line.narration || "",
      500,
    );
    let departmentId = Number(line.department_id || line.dept_id || 0) || null;
    if (ref.line_kind !== "ACCOUNT") {
      departmentId = null;
    } else {
      const accountMeta =
        accountPostingClassById.get(Number(ref.account_id || 0)) || null;
      if (!accountMeta) {
        throw new HttpError(
          400,
          `Line ${index + 1}: account is invalid for current branch`,
        );
      }
      if (accountMeta.lockPosting === true) {
        throw new HttpError(
          400,
          `Line ${index + 1}: selected account is locked for manual posting`,
        );
      }
      const postingClassCode = String(
        accountMeta.postingClassCode || "",
      ).toLowerCase();
      if (postingClassCode && accountMeta.postingClassActive === false) {
        throw new HttpError(
          400,
          `Line ${index + 1}: account posting class is invalid`,
        );
      }
      const accountType = String(accountMeta.accountType || "").toLowerCase();
      const departmentRequired =
        postingClassCode === "expense" || accountType === "expense";
      if (departmentRequired && !departmentId) {
        throw new HttpError(400, `Line ${index + 1}: department is required`);
      }
      if (!departmentRequired) {
        departmentId = null;
      }
    }

    const debit = normalizeNumber(line.debit || 0);
    const credit = normalizeNumber(line.credit || 0);
    const cashReceipt = normalizeNumber(line.cash_receipt || 0);
    const cashPayment = normalizeNumber(line.cash_payment || 0);
    const bankReceipt = normalizeNumber(line.bank_receipt || 0);
    const bankPayment = normalizeNumber(line.bank_payment || 0);

    let dr = debit;
    let cr = credit;

    if (voucherTypeCode === VOUCHER_TYPES.cash) {
      // Cash vouchers: line "payment" is the expense-side debit; header cash account is balanced automatically.
      dr = cashPayment;
      cr = cashReceipt;
    }
    if (voucherTypeCode === VOUCHER_TYPES.bank) {
      // Bank vouchers follow the same direction model as cash vouchers.
      dr = bankPayment;
      cr = bankReceipt;
    }

    if ((dr > 0 && cr > 0) || (dr <= 0 && cr <= 0)) {
      throw new HttpError(
        400,
        `Line ${index + 1}: exactly one side must be non-zero`,
      );
    }

    const amount = normalizeNumber(Math.max(dr, cr));
    const sourceVoucherId = Number(line.source_voucher_id || 0);
    const sourceVoucherNo = Number(line.source_voucher_no || 0);
    const sourceLineId = Number(line.source_line_id || 0);
    const sourceLineNo = Number(line.source_line_no || 0);
    const sourceVoucherTypeCode = String(line.source_voucher_type_code || "")
      .trim()
      .toUpperCase();
    const referenceNo =
      voucherTypeCode === VOUCHER_TYPES.bank
        ? normalizeText(line.reference_no || line.reference || "", 120)
        : null;

    return {
      line_no: index + 1,
      ...ref,
      reference_no: referenceNo,
      qty: 0,
      rate: amount,
      amount,
      meta: {
        description,
        department_id: departmentId,
        debit: dr,
        credit: cr,
        bank_status:
          voucherTypeCode === VOUCHER_TYPES.bank
            ? String(line.bank_status || "PENDING").toUpperCase()
            : undefined,
        reference_no:
          voucherTypeCode === VOUCHER_TYPES.bank
            ? referenceNo || undefined
            : undefined,
        direction_version:
          voucherTypeCode === VOUCHER_TYPES.cash ||
          voucherTypeCode === VOUCHER_TYPES.bank
            ? 2
            : undefined,
        source_voucher_id:
          voucherTypeCode === VOUCHER_TYPES.bank &&
          Number.isInteger(sourceVoucherId) &&
          sourceVoucherId > 0
            ? sourceVoucherId
            : undefined,
        source_voucher_type_code:
          voucherTypeCode === VOUCHER_TYPES.bank && sourceVoucherTypeCode
            ? sourceVoucherTypeCode
            : undefined,
        source_voucher_no:
          voucherTypeCode === VOUCHER_TYPES.bank &&
          Number.isInteger(sourceVoucherNo) &&
          sourceVoucherNo > 0
            ? sourceVoucherNo
            : undefined,
        source_line_id:
          voucherTypeCode === VOUCHER_TYPES.bank &&
          Number.isInteger(sourceLineId) &&
          sourceLineId > 0
            ? sourceLineId
            : undefined,
        source_line_no:
          voucherTypeCode === VOUCHER_TYPES.bank &&
          Number.isInteger(sourceLineNo) &&
          sourceLineNo > 0
            ? sourceLineNo
            : undefined,
        vr_type:
          voucherTypeCode === VOUCHER_TYPES.journal
            ? normalizeText(line.vr_type || "adjustment", 40)
            : undefined,
      },
    };
  });

  const totalDebit = normalizeNumber(
    normalized.reduce(
      (sum, line) => sum + normalizeNumber(line.meta.debit || 0),
      0,
    ),
  );
  const totalCredit = normalizeNumber(
    normalized.reduce(
      (sum, line) => sum + normalizeNumber(line.meta.credit || 0),
      0,
    ),
  );
  if (totalDebit <= 0 && totalCredit <= 0) {
    throw new HttpError(
      400,
      "Voucher must contain at least one non-zero debit or credit line",
    );
  }
  // Cash voucher must be single-direction only: either receipt or payment.
  if (
    voucherTypeCode === VOUCHER_TYPES.cash &&
    totalDebit > 0 &&
    totalCredit > 0
  ) {
    throw new HttpError(
      400,
      "Cash voucher must be single-direction: use either receipt or payment",
    );
  }
  // Strict balancing is required for Journal vouchers.
  if (
    voucherTypeCode === VOUCHER_TYPES.journal &&
    (totalDebit <= 0 || totalCredit <= 0 || totalDebit !== totalCredit)
  ) {
    throw new HttpError(
      400,
      "Voucher must be balanced (total debit must equal total credit)",
    );
  }

  return { lines: normalized, totalDebit, totalCredit };
};

const getNextVoucherNo = async (trx, branchId, voucherTypeCode) => {
  const latest = await trx("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: voucherTypeCode })
    .max({ value: "voucher_no" })
    .first();
  return Number(latest?.value || 0) + 1;
};

const requiresApproval = async (trx, voucherTypeCode) => {
  const policy = await trx("erp.approval_policy")
    .select("requires_approval")
    .where({
      entity_type: "VOUCHER_TYPE",
      entity_key: voucherTypeCode,
      action: "create",
    })
    .first();
  if (policy) return policy.requires_approval === true;
  const voucherType = await trx("erp.voucher_type")
    .select("requires_approval")
    .where({ code: voucherTypeCode })
    .first();
  if (!voucherType) throw new HttpError(400, "Invalid voucher type");
  return voucherType.requires_approval === true;
};

const requiresApprovalForAction = async (trx, voucherTypeCode, action) => {
  const policy = await trx("erp.approval_policy")
    .select("requires_approval")
    .where({ entity_type: "VOUCHER_TYPE", entity_key: voucherTypeCode, action })
    .first();
  if (policy) return policy.requires_approval === true;
  if (action === "create") return requiresApproval(trx, voucherTypeCode);
  return false;
};

const canDo = (req, scopeType, scopeKey, action) => {
  const check = req?.res?.locals?.can;
  if (typeof check !== "function") return false;
  return check(scopeType, scopeKey, action);
};

const canApproveVoucherAction = (req, scopeKey) =>
  req?.user?.isAdmin === true || canDo(req, "VOUCHER", scopeKey, "approve");

const isAutoSettlementSourceVoucher = (voucherTypeCode) =>
  voucherTypeCode === VOUCHER_TYPES.cash ||
  voucherTypeCode === VOUCHER_TYPES.journal;

const toIsoDate = (value) => {
  return toLocalDateOnlyOrRaw(value);
};

const toTitleCase = (value) =>
  String(value || "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const getBankSettlementEligibleAccountSetTx = async (trx, accountIds = []) => {
  const unique = [
    ...new Set(
      (accountIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!unique.length) return new Set();
  const rows = await trx("erp.accounts as a")
    .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
    .select("a.id")
    .whereIn("a.id", unique)
    .where({
      "a.is_active": true,
      "apc.is_active": true,
      "apc.code": "bank",
    });
  return new Set(rows.map((row) => Number(row.id)));
};

const cleanupEmptyAutoBankVouchersTx = async ({ trx, branchId }) => {
  if (!branchId) return;
  const rows = await trx("erp.voucher_header as vh")
    .leftJoin("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .select("vh.id")
    .where({
      "vh.branch_id": branchId,
      "vh.voucher_type_code": VOUCHER_TYPES.bank,
      "vh.status": "PENDING",
    })
    .whereRaw("vh.remarks like ?", [`${AUTO_BANK_SETTLEMENT_PREFIX}%`])
    .groupBy("vh.id")
    .havingRaw("count(vl.id) = 0");

  const ids = rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  await trx("erp.voucher_header").whereIn("id", ids).del();
};

const markBankVoucherLinesRejectedTx = async ({ trx, voucherId }) => {
  const normalizedVoucherId = Number(voucherId || 0);
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0)
    return;
  await trx("erp.voucher_line")
    .where({ voucher_header_id: normalizedVoucherId })
    .update({
      meta: trx.raw(
        "jsonb_set(COALESCE(meta, '{}'::jsonb), '{bank_status}', to_jsonb(?::text), true)",
        ["REJECTED"],
      ),
    });
};

const findOrCreateAutoBankVoucherTx = async ({
  trx,
  branchId,
  voucherDate,
  actorUserId,
  sourceVoucherId,
  sourceVoucherNo,
  sourceVoucherTypeCode,
  bankAccountId,
}) => {
  const normalizedSourceVoucherId = Number(sourceVoucherId || 0);
  const normalizedBankAccountId = Number(bankAccountId || 0);
  if (
    !Number.isInteger(normalizedSourceVoucherId) ||
    normalizedSourceVoucherId <= 0
  ) {
    throw new HttpError(
      400,
      "Auto bank settlement requires source voucher context",
    );
  }
  if (
    !Number.isInteger(normalizedBankAccountId) ||
    normalizedBankAccountId <= 0
  ) {
    throw new HttpError(
      400,
      "Auto bank settlement requires a bank account in header",
    );
  }

  let existing = await trx("erp.voucher_header")
    .leftJoin(
      "erp.voucher_line as vl",
      "vl.voucher_header_id",
      "erp.voucher_header.id",
    )
    .select(
      "erp.voucher_header.id",
      "erp.voucher_header.voucher_no",
      "erp.voucher_header.remarks",
      "erp.voucher_header.status",
    )
    .where({
      "erp.voucher_header.branch_id": branchId,
      "erp.voucher_header.voucher_type_code": VOUCHER_TYPES.bank,
      "erp.voucher_header.header_account_id": normalizedBankAccountId,
    })
    .whereRaw("erp.voucher_header.remarks like ?", [
      `${AUTO_BANK_SETTLEMENT_PREFIX}%`,
    ])
    .andWhereRaw(
      "COALESCE(NULLIF(vl.meta->>'source_voucher_id', ''), '0')::int = ?",
      [normalizedSourceVoucherId],
    )
    .whereNot({ "erp.voucher_header.status": "REJECTED" })
    .groupBy(
      "erp.voucher_header.id",
      "erp.voucher_header.voucher_no",
      "erp.voucher_header.remarks",
      "erp.voucher_header.status",
    )
    .orderBy("erp.voucher_header.id", "asc")
    .first();

  if (existing) return existing;

  const voucherNo = await getNextVoucherNo(trx, branchId, VOUCHER_TYPES.bank);
  const [created] = await trx("erp.voucher_header")
    .insert({
      voucher_type_code: VOUCHER_TYPES.bank,
      voucher_no: voucherNo,
      branch_id: branchId,
      voucher_date: voucherDate,
      header_account_id: normalizedBankAccountId,
      status: "PENDING",
      created_by: actorUserId || null,
      approved_by: null,
      approved_at: null,
      remarks: `${AUTO_BANK_SETTLEMENT_PREFIX} Auto-created from ${toTitleCase(sourceVoucherTypeCode)} #${Number(sourceVoucherNo || 0) || 0} on ${toIsoDate(voucherDate)}`,
    })
    .returning(["id", "voucher_no", "remarks", "status"]);

  return created;
};

const removeAutoBankLinesForSourceVoucherTx = async ({
  trx,
  sourceVoucherId,
}) => {
  const normalizedId = Number(sourceVoucherId || 0);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) return;

  const autoBankIds = await trx("erp.voucher_header")
    .pluck("id")
    .where({ voucher_type_code: VOUCHER_TYPES.bank })
    .whereRaw("remarks like ?", [`${AUTO_BANK_SETTLEMENT_PREFIX}%`]);
  if (!autoBankIds.length) return;

  await trx("erp.voucher_line")
    .whereIn("voucher_header_id", autoBankIds)
    .andWhereRaw(
      "COALESCE(NULLIF(meta->>'source_voucher_id', ''), '0')::int = ?",
      [normalizedId],
    )
    .del();
};

const hasApprovedBankSettlementForSourceVoucherTx = async ({
  trx,
  sourceVoucherId,
}) => {
  const normalizedId = Number(sourceVoucherId || 0);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) return false;

  const row = await trx("erp.voucher_line as bl")
    .join("erp.voucher_header as bh", "bh.id", "bl.voucher_header_id")
    .select("bh.id")
    .where("bh.voucher_type_code", VOUCHER_TYPES.bank)
    .andWhereRaw(
      "COALESCE(NULLIF(bl.meta->>'source_voucher_id', ''), '0')::int = ?",
      [normalizedId],
    )
    .andWhere(function whereApprovedBank() {
      this.where("bh.status", "APPROVED").orWhereRaw(
        "upper(COALESCE(bl.meta->>'bank_status', 'PENDING')) = 'APPROVED'",
      );
    })
    .first();

  return Boolean(row?.id);
};

const syncAutoBankSettlementForVoucherTx = async ({
  trx,
  voucherId,
  actorUserId = null,
}) => {
  const normalizedVoucherId = Number(voucherId || 0);
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0)
    return;

  const sourceHeader = await trx("erp.voucher_header")
    .select(
      "id",
      "branch_id",
      "voucher_type_code",
      "voucher_no",
      "voucher_date",
      "status",
      "created_by",
      "header_account_id",
    )
    .where({ id: normalizedVoucherId })
    .first();
  if (!sourceHeader) return;

  const sourceType = String(sourceHeader.voucher_type_code || "").toUpperCase();
  if (!isAutoSettlementSourceVoucher(sourceType)) return;

  await removeAutoBankLinesForSourceVoucherTx({
    trx,
    sourceVoucherId: normalizedVoucherId,
  });

  if (String(sourceHeader.status || "").toUpperCase() !== "APPROVED") {
    await cleanupEmptyAutoBankVouchersTx({
      trx,
      branchId: sourceHeader.branch_id,
    });
    return;
  }

  const sourceLines = await trx("erp.voucher_line")
    .select(
      "id",
      "line_no",
      "line_kind",
      "account_id",
      "party_id",
      "labour_id",
      "employee_id",
      "qty",
      "rate",
      "amount",
      "reference_no",
      "meta",
    )
    .where({ voucher_header_id: normalizedVoucherId })
    .orderBy("line_no", "asc");

  const accountIds = sourceLines
    .map((line) => Number(line.account_id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
  const enabledAccountSet = await getBankSettlementEligibleAccountSetTx(
    trx,
    accountIds,
  );
  const eligibleLines = sourceLines.filter(
    (line) =>
      String(line.line_kind || "").toUpperCase() === "ACCOUNT" &&
      enabledAccountSet.has(Number(line.account_id || 0)),
  );

  if (!eligibleLines.length) {
    await cleanupEmptyAutoBankVouchersTx({
      trx,
      branchId: sourceHeader.branch_id,
    });
    return;
  }

  const eligibleByBankAccount = eligibleLines.reduce((acc, line) => {
    const bankAccountId = Number(line.account_id || 0);
    if (!Number.isInteger(bankAccountId) || bankAccountId <= 0) return acc;
    const rows = acc.get(bankAccountId) || [];
    rows.push(line);
    acc.set(bankAccountId, rows);
    return acc;
  }, new Map());

  const distinctBankAccounts = [...eligibleByBankAccount.keys()];
  const canUseContraRows = distinctBankAccounts.length === 1;

  for (const [bankAccountId, bankLines] of eligibleByBankAccount.entries()) {
    const autoHeader = await findOrCreateAutoBankVoucherTx({
      trx,
      branchId: sourceHeader.branch_id,
      voucherDate: sourceHeader.voucher_date,
      actorUserId: actorUserId || sourceHeader.created_by || null,
      sourceVoucherId: normalizedVoucherId,
      sourceVoucherNo: sourceHeader.voucher_no,
      sourceVoucherTypeCode: sourceType,
      bankAccountId,
    });

    const candidateLines = canUseContraRows
      ? sourceLines.filter(
          (line) => !enabledAccountSet.has(Number(line.account_id || 0)),
        )
      : bankLines;
    const finalLines = candidateLines.length ? candidateLines : bankLines;
    const useCashHeaderContraFallback =
      canUseContraRows &&
      !candidateLines.length &&
      sourceType === VOUCHER_TYPES.cash &&
      Number.isInteger(Number(sourceHeader.header_account_id || 0)) &&
      Number(sourceHeader.header_account_id || 0) > 0;

    const maxLine = await trx("erp.voucher_line")
      .where({ voucher_header_id: autoHeader.id })
      .max({ value: "line_no" })
      .first();
    let nextLineNo = Number(maxLine?.value || 0);
    const rowsToInsert = finalLines.map((line) => {
      nextLineNo += 1;
      const sourceMeta =
        line.meta && typeof line.meta === "object" ? { ...line.meta } : {};
      const sourceReferenceNo = normalizeText(
        line.reference_no || sourceMeta.reference_no || "",
        120,
      );
      sourceMeta.auto_generated = true;
      sourceMeta.auto_source = "AUTO_BANK_SETTLEMENT";
      sourceMeta.source_voucher_id = normalizedVoucherId;
      sourceMeta.source_voucher_type_code = sourceType;
      sourceMeta.source_voucher_no =
        Number(sourceHeader.voucher_no || 0) || null;
      sourceMeta.source_line_id = Number(line.id || 0) || null;
      sourceMeta.source_line_no = Number(line.line_no || 0) || null;
      sourceMeta.bank_status = "PENDING";

      const resolvedLineKind = useCashHeaderContraFallback
        ? "ACCOUNT"
        : String(line.line_kind || "").toUpperCase() || "ACCOUNT";
      const resolvedAccountId = useCashHeaderContraFallback
        ? Number(sourceHeader.header_account_id || 0)
        : Number(line.account_id || 0) || null;
      const resolvedPartyId = useCashHeaderContraFallback
        ? null
        : Number(line.party_id || 0) || null;
      const resolvedLabourId = useCashHeaderContraFallback
        ? null
        : Number(line.labour_id || 0) || null;
      const resolvedEmployeeId = useCashHeaderContraFallback
        ? null
        : Number(line.employee_id || 0) || null;

      return {
        voucher_header_id: autoHeader.id,
        line_no: nextLineNo,
        line_kind: resolvedLineKind,
        item_id: null,
        sku_id: null,
        account_id: resolvedAccountId,
        party_id: resolvedPartyId,
        labour_id: resolvedLabourId,
        employee_id: resolvedEmployeeId,
        uom_id: null,
        qty: Number(line.qty || 0),
        rate: Number(line.rate || 0),
        amount: Number(line.amount || 0),
        reference_no: sourceReferenceNo,
        meta: sourceMeta,
      };
    });

    if (rowsToInsert.length) {
      await trx("erp.voucher_line").insert(rowsToInsert);
      await trx("erp.voucher_header").where({ id: autoHeader.id }).update({
        status: "PENDING",
        approved_by: null,
        approved_at: null,
      });
    }
  }

  await cleanupEmptyAutoBankVouchersTx({
    trx,
    branchId: sourceHeader.branch_id,
  });
};

const createApprovalRequest = async ({
  trx,
  req,
  voucherId,
  voucherTypeCode,
  summary,
  oldValue = null,
  newValue = null,
}) => {
  const [row] = await trx("erp.approval_request")
    .insert({
      branch_id: req.branchId,
      request_type: "VOUCHER",
      entity_type: "VOUCHER",
      entity_id: String(voucherId),
      summary,
      old_value: oldValue,
      new_value: newValue,
      requested_by: req.user.id,
    })
    .returning(["id"]);

  await insertActivityLog(trx, {
    branch_id: req.branchId,
    user_id: req.user.id,
    entity_type: "VOUCHER",
    entity_id: String(voucherId),
    voucher_type_code: voucherTypeCode,
    action: "SUBMIT",
    ip_address: req.ip,
    context: {
      approval_request_id: row?.id || null,
      summary,
      source: "financial-voucher-service",
      new_value: newValue,
    },
  });

  return row?.id || null;
};

const ensureHeaderAccount = async ({
  trx,
  req,
  voucherTypeCode,
  headerAccountId,
}) => {
  const normalizedHeaderAccountId = Number(headerAccountId || 0);
  if (
    voucherTypeCode !== VOUCHER_TYPES.cash &&
    voucherTypeCode !== VOUCHER_TYPES.bank
  ) {
    return null;
  }

  // Cash voucher requires a selected cash account in header.
  if (
    voucherTypeCode === VOUCHER_TYPES.cash &&
    (!Number.isInteger(normalizedHeaderAccountId) ||
      normalizedHeaderAccountId <= 0)
  ) {
    throw new HttpError(400, "Cash/Bank account is required");
  }

  // Bank voucher header account is optional in source-driven settlement flow.
  if (
    voucherTypeCode === VOUCHER_TYPES.bank &&
    (!Number.isInteger(normalizedHeaderAccountId) ||
      normalizedHeaderAccountId <= 0)
  ) {
    return null;
  }

  let query = trx("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .select("a.id", "a.lock_posting", "apc.code as posting_class_code")
    .where({ "a.id": normalizedHeaderAccountId, "a.is_active": true });
  query = query.whereExists(function branchAccess() {
    this.select(1)
      .from("erp.account_branch as ab")
      .whereRaw("ab.account_id = a.id")
      .andWhere("ab.branch_id", req.branchId);
  });
  const account = await query.first();
  if (!account) {
    throw new HttpError(
      400,
      "Selected cash/bank account is invalid for current branch",
    );
  }
  if (account.lock_posting === true) {
    throw new HttpError(
      400,
      "Selected cash/bank account is locked for manual posting",
    );
  }
  if (voucherTypeCode === VOUCHER_TYPES.cash) {
    const postingClassCode = String(
      account.posting_class_code || "",
    ).toLowerCase();
    if (postingClassCode !== "cash") {
      throw new HttpError(
        400,
        "Selected cash account must have CASH posting class",
      );
    }
  }
  if (
    voucherTypeCode === VOUCHER_TYPES.bank &&
    String(account.posting_class_code || "").toLowerCase() !== "bank"
  ) {
    throw new HttpError(
      400,
      "Selected bank account must have BANK posting class",
    );
  }
  return normalizedHeaderAccountId;
};

const enforceCashVoucherContraRule = async ({
  trx,
  req,
  voucherTypeCode,
  lines = [],
}) => {
  if (voucherTypeCode !== VOUCHER_TYPES.cash) return;
  const accountIds = [
    ...new Set(
      (lines || [])
        .filter(
          (line) => String(line.line_kind || "").toUpperCase() === "ACCOUNT",
        )
        .map((line) => Number(line.account_id || 0))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!accountIds.length) return;

  const cashRows = await trx("erp.accounts as a")
    .leftJoin(
      "erp.account_posting_classes as apc",
      "apc.id",
      "a.posting_class_id",
    )
    .select("a.id")
    .whereIn("a.id", accountIds)
    .where({ "a.is_active": true })
    .whereExists(function branchAccess() {
      this.select(1)
        .from("erp.account_branch as ab")
        .whereRaw("ab.account_id = a.id")
        .andWhere("ab.branch_id", req.branchId);
    })
    .whereRaw("upper(COALESCE(apc.code, '')) = 'CASH'");

  const cashAccountIdSet = new Set(cashRows.map((row) => Number(row.id)));
  if (!cashAccountIdSet.size) return;

  const violatingLine = (lines || []).find(
    (line) =>
      String(line.line_kind || "").toUpperCase() === "ACCOUNT" &&
      cashAccountIdSet.has(Number(line.account_id || 0)),
  );
  const violatingLineNo = Number(violatingLine?.line_no || 0) || 0;
  throw new HttpError(
    400,
    violatingLineNo > 0
      ? `Line ${violatingLineNo}: cash account is not allowed in cash voucher rows. Use Cash Transfer Voucher.`
      : "Cash account is not allowed in cash voucher rows. Use Cash Transfer Voucher.",
  );
};

const createVoucher = async ({
  req,
  voucherTypeCode,
  voucherDate,
  remarks,
  lines,
  scopeKey,
  headerAccountId = null,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const canCreate = canDo(req, "VOUCHER", scopeKey, "create");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const validated = await validateLines({
      trx,
      req,
      voucherTypeCode,
      rawLines: lines,
      headerAccountId,
    });
    const validHeaderAccountId = await ensureHeaderAccount({
      trx,
      req,
      voucherTypeCode,
      headerAccountId,
    });
    await enforceCashVoucherContraRule({
      trx,
      req,
      voucherTypeCode,
      lines: validated.lines,
    });
    const voucherNo = await getNextVoucherNo(
      trx,
      req.branchId,
      voucherTypeCode,
    );
    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "create",
    );
    const queuedForApproval =
      !canCreate || (policyRequiresApproval && !canApprove);

    const [header] = await trx("erp.voucher_header")
      .insert({
        voucher_type_code: voucherTypeCode,
        voucher_no: voucherNo,
        branch_id: req.branchId,
        voucher_date: voucherDate,
        header_account_id: validHeaderAccountId,
        status: queuedForApproval ? "PENDING" : "APPROVED",
        created_by: req.user.id,
        approved_by: queuedForApproval ? null : req.user.id,
        approved_at: queuedForApproval ? null : trx.fn.now(),
        remarks: normalizeText(remarks, 1000),
      })
      .returning(["id", "voucher_no", "status"]);

    const lineRows = validated.lines.map((line) => ({
      voucher_header_id: header.id,
      line_no: line.line_no,
      line_kind: line.line_kind,
      item_id: null,
      sku_id: null,
      account_id: line.account_id || null,
      party_id: line.party_id || null,
      labour_id: line.labour_id || null,
      employee_id: line.employee_id || null,
      uom_id: null,
      qty: line.qty,
      rate: line.rate,
      amount: line.amount,
      reference_no: line.reference_no || null,
      meta: line.meta || {},
    }));

    await trx("erp.voucher_line").insert(lineRows);

    if (!queuedForApproval && isAutoSettlementSourceVoucher(voucherTypeCode)) {
      await syncAutoBankSettlementForVoucherTx({
        trx,
        voucherId: header.id,
        actorUserId: req.user.id,
      });
    }
    if (!queuedForApproval) {
      await syncVoucherGlPostingTx({ trx, voucherId: header.id });
    }

    let approvalRequestId = null;
    if (queuedForApproval) {
      approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: header.id,
        voucherTypeCode,
        summary: `ADD ${voucherTypeCode}`,
        newValue: {
          action: "create",
          voucher_type_code: voucherTypeCode,
          voucher_no: header.voucher_no,
          voucher_date: voucherDate,
          remarks: normalizeText(remarks, 1000),
          total_debit: validated.totalDebit,
          total_credit: validated.totalCredit,
          header_account_id: validHeaderAccountId,
          permission_reroute: !canCreate,
        },
      });
    }

    return {
      id: header.id,
      voucherNo: header.voucher_no,
      status: header.status,
      totalDebit: validated.totalDebit,
      totalCredit: validated.totalCredit,
      approvalRequestId,
      queuedForApproval,
      permissionReroute: !canCreate,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "CREATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      total_debit: result.totalDebit,
      total_credit: result.totalCredit,
    },
  });

  return result;
};

const updateVoucher = async ({
  req,
  voucherId,
  voucherTypeCode,
  voucherDate,
  remarks,
  lines,
  scopeKey,
  headerAccountId = null,
}) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherId = Number(voucherId || 0);
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0) {
    throw new HttpError(400, "Invalid voucher id");
  }

  const canEdit = canDo(req, "VOUCHER", scopeKey, "edit");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    const validated = await validateLines({
      trx,
      req,
      voucherTypeCode,
      rawLines: lines,
      headerAccountId,
    });
    const validHeaderAccountId = await ensureHeaderAccount({
      trx,
      req,
      voucherTypeCode,
      headerAccountId,
    });
    await enforceCashVoucherContraRule({
      trx,
      req,
      voucherTypeCode,
      lines: validated.lines,
    });
    let headerQuery = trx("erp.voucher_header")
      .select(
        "id",
        "branch_id",
        "voucher_no",
        "voucher_type_code",
        "voucher_date",
        "remarks",
        "status",
      )
      .where({
        id: normalizedVoucherId,
        voucher_type_code: voucherTypeCode,
        branch_id: req.branchId,
      });
    const existing = await headerQuery.first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (existing.status === "REJECTED")
      throw new HttpError(400, "Deleted voucher cannot be edited");

    const existingLines = await trx("erp.voucher_line")
      .select(
        "line_no",
        "line_kind",
        "account_id",
        "party_id",
        "labour_id",
        "employee_id",
        "reference_no",
        "meta",
      )
      .where({ voucher_header_id: existing.id })
      .orderBy("line_no", "asc");

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "edit",
    );
    const queuedForApproval =
      !canEdit || (policyRequiresApproval && !canApprove);

    const updatePayload = {
      action: "update",
      voucher_id: existing.id,
      voucher_no: existing.voucher_no,
      voucher_type_code: voucherTypeCode,
      voucher_date: voucherDate,
      remarks: normalizeText(remarks, 1000),
      lines: validated.lines,
      total_debit: validated.totalDebit,
      total_credit: validated.totalCredit,
      header_account_id: validHeaderAccountId,
      permission_reroute: !canEdit,
    };

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: existing.id,
        voucherTypeCode,
        summary: `EDIT ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: {
          voucher_date: existing.voucher_date,
          remarks: existing.remarks,
          status: existing.status,
          lines: existingLines,
        },
        newValue: updatePayload,
      });

      return {
        id: existing.id,
        voucherNo: existing.voucher_no,
        status: existing.status,
        totalDebit: validated.totalDebit,
        totalCredit: validated.totalCredit,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canEdit,
        updated: false,
      };
    }

    await trx("erp.voucher_header")
      .where({ id: existing.id })
      .update({
        voucher_date: voucherDate,
        header_account_id: validHeaderAccountId,
        remarks: normalizeText(remarks, 1000),
        status: "APPROVED",
        approved_by: req.user.id,
        approved_at: trx.fn.now(),
      });

    await trx("erp.voucher_line")
      .where({ voucher_header_id: existing.id })
      .del();
    const lineRows = validated.lines.map((line) => ({
      voucher_header_id: existing.id,
      line_no: line.line_no,
      line_kind: line.line_kind,
      item_id: null,
      sku_id: null,
      account_id: line.account_id || null,
      party_id: line.party_id || null,
      labour_id: line.labour_id || null,
      employee_id: line.employee_id || null,
      uom_id: null,
      qty: line.qty,
      rate: line.rate,
      amount: line.amount,
      reference_no: line.reference_no || null,
      meta: line.meta || {},
    }));
    await trx("erp.voucher_line").insert(lineRows);

    if (isAutoSettlementSourceVoucher(voucherTypeCode)) {
      await syncAutoBankSettlementForVoucherTx({
        trx,
        voucherId: existing.id,
        actorUserId: req.user.id,
      });
    }
    await syncVoucherGlPostingTx({ trx, voucherId: existing.id });

    return {
      id: existing.id,
      voucherNo: existing.voucher_no,
      status: "APPROVED",
      totalDebit: validated.totalDebit,
      totalCredit: validated.totalCredit,
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      updated: true,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "UPDATE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      total_debit: result.totalDebit,
      total_credit: result.totalCredit,
      updated: result.updated === true,
    },
  });

  return result;
};

const deleteVoucher = async ({ req, voucherId, voucherTypeCode, scopeKey }) => {
  if (!req?.user?.id) throw new HttpError(401, "Not authenticated");
  if (!req.branchId) throw new HttpError(400, "Branch context is required");

  const normalizedVoucherId = Number(voucherId || 0);
  if (!Number.isInteger(normalizedVoucherId) || normalizedVoucherId <= 0) {
    throw new HttpError(400, "Invalid voucher id");
  }

  const canDelete = canDo(req, "VOUCHER", scopeKey, "hard_delete");
  const canApprove = canApproveVoucherAction(req, scopeKey);

  const result = await knex.transaction(async (trx) => {
    let headerQuery = trx("erp.voucher_header")
      .select(
        "id",
        "branch_id",
        "voucher_no",
        "voucher_type_code",
        "voucher_date",
        "remarks",
        "status",
      )
      .where({
        id: normalizedVoucherId,
        voucher_type_code: voucherTypeCode,
        branch_id: req.branchId,
      });
    const existing = await headerQuery.first();
    if (!existing) throw new HttpError(404, "Voucher not found");
    if (existing.status === "REJECTED")
      throw new HttpError(400, "Voucher already deleted");

    if (isAutoSettlementSourceVoucher(voucherTypeCode)) {
      const linkedApprovedBank =
        await hasApprovedBankSettlementForSourceVoucherTx({
          trx,
          sourceVoucherId: existing.id,
        });
      if (linkedApprovedBank) {
        throw new HttpError(
          400,
          req?.res?.locals?.t?.("error_voucher_linked_bank_approved") ||
            "Cannot delete voucher because linked bank settlement is approved. Reverse bank approval first.",
        );
      }
    }

    const policyRequiresApproval = await requiresApprovalForAction(
      trx,
      voucherTypeCode,
      "delete",
    );
    const queuedForApproval =
      !canDelete || (policyRequiresApproval && !canApprove);

    if (queuedForApproval) {
      const approvalRequestId = await createApprovalRequest({
        trx,
        req,
        voucherId: existing.id,
        voucherTypeCode,
        summary: `DELETE ${voucherTypeCode} #${existing.voucher_no}`,
        oldValue: {
          voucher_date: existing.voucher_date,
          remarks: existing.remarks,
          status: existing.status,
        },
        newValue: {
          action: "delete",
          voucher_id: existing.id,
          voucher_no: existing.voucher_no,
          voucher_type_code: voucherTypeCode,
          permission_reroute: !canDelete,
        },
      });

      return {
        id: existing.id,
        voucherNo: existing.voucher_no,
        status: existing.status,
        approvalRequestId,
        queuedForApproval: true,
        permissionReroute: !canDelete,
        deleted: false,
      };
    }

    await trx("erp.voucher_header").where({ id: existing.id }).update({
      status: "REJECTED",
      approved_by: req.user.id,
      approved_at: trx.fn.now(),
    });
    if (voucherTypeCode === VOUCHER_TYPES.bank) {
      await markBankVoucherLinesRejectedTx({ trx, voucherId: existing.id });
    }
    await syncVoucherGlPostingTx({ trx, voucherId: existing.id });

    if (isAutoSettlementSourceVoucher(voucherTypeCode)) {
      await syncAutoBankSettlementForVoucherTx({
        trx,
        voucherId: existing.id,
        actorUserId: req.user.id,
      });
    }

    return {
      id: existing.id,
      voucherNo: existing.voucher_no,
      status: "REJECTED",
      approvalRequestId: null,
      queuedForApproval: false,
      permissionReroute: false,
      deleted: true,
    };
  });

  queueAuditLog(req, {
    entityType: "VOUCHER",
    entityId: result.id,
    action: "DELETE",
    voucherTypeCode,
    context: {
      voucher_no: result.voucherNo,
      status: result.status,
      approval_request_id: result.approvalRequestId || null,
      deleted: result.deleted === true,
    },
  });

  return result;
};

module.exports = {
  VOUCHER_TYPES,
  createVoucher,
  updateVoucher,
  deleteVoucher,
  validateLines,
  syncAutoBankSettlementForVoucherTx,
  markBankVoucherLinesRejectedTx,
};
