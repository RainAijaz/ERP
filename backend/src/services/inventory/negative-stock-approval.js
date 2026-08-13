const {
  resolveVoucherApprovalRequiredTx,
} = require("../../utils/voucher-approval-policy");

const NEGATIVE_STOCK_APPROVAL_NOTICE_KEY = "approval_sent_negative_stock";
const NEGATIVE_STOCK_APPROVAL_FALLBACK_MESSAGE =
  "Insufficient stock would make inventory negative. Voucher has been submitted for Administrator approval.";

const NEGATIVE_STOCK_POLICY_ACTION = "negative_stock";

const roundShortQty = (value) => Number(Number(value || 0).toFixed(3));

// The approvals list rebuilds VOUCHER summaries from the payload and discards the
// stored summary, so the shortfall detail has to be readable on its own.
const describeShortfall = (shortfall) => {
  const parts = [
    shortfall?.item_name,
    shortfall?.color_name,
    shortfall?.size_name,
  ].filter(Boolean);
  const lineNo = shortfall?.line_no;
  // Names are not always resolved at validation time; the line number alone still
  // points the approver at the row, so fall back to it rather than printing "item".
  const label = [lineNo ? `line ${lineNo}` : "", parts.join(" / ")]
    .filter(Boolean)
    .join(" ")
    .trim();
  const subject = label || "a line";
  return `${subject} needs ${roundShortQty(shortfall?.short_qty)} more than the ${roundShortQty(shortfall?.available_qty)} on hand`;
};

const buildNegativeStockApprovalReason = ({
  voucherTypeCode,
  shortfalls = [],
} = {}) => {
  const code = String(voucherTypeCode || "").trim().toUpperCase();
  const subject = code ? `${code} would make stock negative` : "Voucher would make stock negative";
  const lines = Array.isArray(shortfalls) ? shortfalls.filter(Boolean) : [];
  if (!lines.length) return `${subject}.`;
  return `${subject} - ${lines.map(describeShortfall).join("; ")}`;
};

const resolveNegativeStockApprovalRouting = ({
  hasNegativeStockRisk,
  canApproveVoucherAction,
  canBypassNegativeStockApproval,
  voucherTypeCode,
  shortfalls = [],
}) => {
  const negativeStockRisk = hasNegativeStockRisk === true;
  const canApprove = canApproveVoucherAction === true;
  const hasBypass = canBypassNegativeStockApproval === true;
  const queueForApproval = negativeStockRisk && !canApprove && !hasBypass;

  return {
    negativeStockRisk,
    queueForApproval,
    negativeStockApprovalReroute: queueForApproval,
    negativeStockLines: negativeStockRisk ? shortfalls : [],
    approvalReason: queueForApproval
      ? buildNegativeStockApprovalReason({ voucherTypeCode, shortfalls })
      : null,
    noticeKey: NEGATIVE_STOCK_APPROVAL_NOTICE_KEY,
    noticeFallback: NEGATIVE_STOCK_APPROVAL_FALLBACK_MESSAGE,
  };
};

// Single entry point for every stock voucher. The per-voucher `detectRisk` closure is
// only ever invoked when the "Neg. Stock" checkbox is ticked for that voucher type, so
// leaving the box unticked costs nothing and lets the voucher post negative silently.
const resolveNegativeStockRoutingTx = async ({
  trx,
  voucherTypeCode,
  canApproveVoucherAction,
  canBypassNegativeStockApproval = false,
  detectRisk,
}) => {
  const policyRequired = await resolveVoucherApprovalRequiredTx({
    trx,
    voucherTypeCode,
    action: NEGATIVE_STOCK_POLICY_ACTION,
  });

  let hasNegativeStockRisk = false;
  let shortfalls = [];

  if (policyRequired && typeof detectRisk === "function") {
    const detected = await detectRisk();
    if (Array.isArray(detected)) {
      shortfalls = detected;
      hasNegativeStockRisk = detected.length > 0;
    } else if (detected && typeof detected === "object") {
      shortfalls = Array.isArray(detected.shortfalls) ? detected.shortfalls : [];
      hasNegativeStockRisk =
        detected.risk === true || (detected.risk == null && shortfalls.length > 0);
    } else {
      hasNegativeStockRisk = detected === true;
    }
  }

  return {
    ...resolveNegativeStockApprovalRouting({
      hasNegativeStockRisk,
      canApproveVoucherAction,
      canBypassNegativeStockApproval,
      voucherTypeCode,
      shortfalls,
    }),
    policyRequired,
  };
};

module.exports = {
  NEGATIVE_STOCK_APPROVAL_NOTICE_KEY,
  NEGATIVE_STOCK_APPROVAL_FALLBACK_MESSAGE,
  NEGATIVE_STOCK_POLICY_ACTION,
  buildNegativeStockApprovalReason,
  resolveNegativeStockApprovalRouting,
  resolveNegativeStockRoutingTx,
};
