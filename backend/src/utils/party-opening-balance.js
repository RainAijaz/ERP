// Purpose: Posts a party's opening balance as a real Journal Voucher.
//
// Party balances are never stored on erp.parties — every ledger derives them by
// summing erp.gl_entry on party_id, and erp.gl_batch.source_voucher_id is NOT NULL,
// so the only way an opening balance can exist is behind a voucher.
//
// IMPORTANT: createVoucher opens its own knex.transaction, so this helper must be
// called AFTER the caller's transaction has committed — never from inside one.
const knex = require("../db/knex");
const {
  createVoucher,
  VOUCHER_TYPES,
} = require("../services/financial/voucher-service");
const {
  POSTABLE_PARTY_TYPES,
} = require("../services/financial/gl-posting-service");

// The contra side of every opening balance. Seeded as an account GROUP (subgroup),
// not an account — the branch's chart of accounts supplies the actual account, and
// accounts are never seeded, so this must be created once on the Accounts screen.
const OPENING_BALANCE_GROUP_CODE = "opening_balance_equity";

// Disambiguates when a branch has several accounts under the group, matching the
// gl_* convention in CONTROL_GROUP_PREFERRED_ACCOUNT_CODES (gl_ap_control, ...).
const PREFERRED_ACCOUNT_CODE = "gl_opening_balance_equity";

const DIRECTIONS = Object.freeze({ debit: "DR", credit: "CR" });

// Which way round the party line goes. Kept explicit rather than derived from
// party_type, so a supplier advance (debit balance on an AP party) is expressible.
const normalizeDirection = (value, partyType) => {
  const text = String(value || "").trim().toUpperCase();
  if (text === DIRECTIONS.debit || text === DIRECTIONS.credit) return text;
  // Sensible default when the form omitted it: customers owe us, suppliers are owed.
  return String(partyType || "").toUpperCase() === "SUPPLIER"
    ? DIRECTIONS.credit
    : DIRECTIONS.debit;
};

const normalizeAmount = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Number(num.toFixed(2));
};

// Mirrors loadAccountsByGroupTx in gl-posting-service.js: accounts are tied to a
// group via subgroup_id and scoped to a branch via account_branch.
const resolveOpeningBalanceAccountId = async ({ branchId }) => {
  const rows = await knex("erp.accounts as a")
    .join("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .join("erp.account_branch as ab", "ab.account_id", "a.id")
    .select("a.id", "a.code")
    .where({
      "ab.branch_id": branchId,
      "a.is_active": true,
      "ag.is_active": true,
      "ag.code": OPENING_BALANCE_GROUP_CODE,
    })
    .orderBy("a.id", "asc");

  if (!rows.length) {
    // Accounts are never seeded — this one has to be created by hand once, so say
    // exactly that rather than leaving the user with a bare lookup failure.
    throw new Error(
      `no account exists in the '${OPENING_BALANCE_GROUP_CODE}' group for this branch. ` +
        `Create one on Master Data > Accounts (suggested code '${PREFERRED_ACCOUNT_CODE}') ` +
        `under the Opening Balance Equity group, and assign it to this branch.`,
    );
  }
  if (rows.length === 1) return Number(rows[0].id);

  const preferred = rows.filter(
    (row) => String(row.code || "").toLowerCase() === PREFERRED_ACCOUNT_CODE,
  );
  if (preferred.length === 1) return Number(preferred[0].id);
  throw new Error(
    `this branch has ${rows.length} accounts in the '${OPENING_BALANCE_GROUP_CODE}' group. ` +
      `Rename the one to use to '${PREFERRED_ACCOUNT_CODE}' so it can be identified.`,
  );
};

/**
 * Posts the opening balance JV for a newly created party.
 *
 * Returns null (no voucher) when there is nothing to post — a zero/blank amount, or
 * a party type that cannot carry a balance. Both are normal, not errors.
 *
 * @param {object}  args
 * @param {number}  args.partyId
 * @param {string}  args.partyType   CUSTOMER | SUPPLIER | BOTH | OTHER
 * @param {number}  args.branchId    The PARTY's branch, not the actor's.
 * @param {number}  args.amount
 * @param {string}  args.direction   "DR" (they owe us) | "CR" (we owe them)
 * @param {string}  args.asOfDate
 * @param {object}  args.req         Live request, used for user/permissions.
 */
const postPartyOpeningBalance = async ({
  partyId,
  partyType,
  branchId,
  amount,
  direction,
  asOfDate,
  req,
}) => {
  const normalizedPartyId = Number(partyId || 0);
  const normalizedAmount = normalizeAmount(amount);
  if (!normalizedPartyId || !normalizedAmount) return null;

  // OTHER parties are neither bought from nor sold to, so they have no control
  // account to post against. Sourced from gl-posting-service so this can never
  // drift from what posting actually accepts.
  const normalizedPartyType = String(partyType || "").trim().toUpperCase();
  if (!POSTABLE_PARTY_TYPES.includes(normalizedPartyType)) return null;

  const normalizedBranchId = Number(branchId || 0);
  if (!normalizedBranchId) {
    throw new Error("Opening balance failed: party has no branch");
  }

  const equityAccountId = await resolveOpeningBalanceAccountId({
    branchId: normalizedBranchId,
  });
  const resolvedDirection = normalizeDirection(direction, normalizedPartyType);
  const partyIsDebit = resolvedDirection === DIRECTIONS.debit;
  const description = `Opening balance as at ${asOfDate}`;

  // The party line needs no account_id: gl-posting-service derives the AR/AP
  // control account from party_type when the batch is posted.
  const lines = [
    {
      party_id: normalizedPartyId,
      debit: partyIsDebit ? normalizedAmount : 0,
      credit: partyIsDebit ? 0 : normalizedAmount,
      description,
    },
    {
      account_id: equityAccountId,
      debit: partyIsDebit ? 0 : normalizedAmount,
      credit: partyIsDebit ? normalizedAmount : 0,
      description,
    },
  ];

  // createVoucher reads req.branchId, which on the approvals screen is the
  // APPROVER's branch. Shadow it with the party's own branch while inheriting
  // everything else (req.user, res.locals.can) from the live request.
  const voucherReq = Object.create(req);
  voucherReq.branchId = normalizedBranchId;

  return createVoucher({
    req: voucherReq,
    voucherTypeCode: VOUCHER_TYPES.journal,
    voucherDate: asOfDate,
    remarks: description,
    lines,
    scopeKey: VOUCHER_TYPES.journal,
  });
};

module.exports = {
  postPartyOpeningBalance,
  OPENING_BALANCE_GROUP_CODE,
  DIRECTIONS,
};
