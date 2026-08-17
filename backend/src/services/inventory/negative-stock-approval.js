const {
  resolveVoucherApprovalRequiredTx,
} = require("../../utils/voucher-approval-policy");

const NEGATIVE_STOCK_APPROVAL_NOTICE_KEY = "approval_sent_negative_stock";
const NEGATIVE_STOCK_APPROVAL_FALLBACK_MESSAGE =
  "Insufficient stock would make inventory negative. Voucher has been submitted for Administrator approval.";

const NEGATIVE_STOCK_POLICY_ACTION = "negative_stock";

const roundShortQty = (value) => Number(Number(value || 0).toFixed(3));

// Not every voucher draws from shelf stock, so a blanket "on hand" is simply wrong for
// some of them: a GRN_IN consumes the goods-in-transit bucket that its STN_OUT filled,
// never the receiving branch's shelf. Naming the right bucket is what makes the reason
// mean something to the approver instead of reading as a contradiction (a receipt that
// "makes stock negative"). Anything absent from this map draws from ordinary stock.
const STOCK_BUCKET_LABELS = {
  GRN_IN: "in transit",
};
const DEFAULT_STOCK_BUCKET_LABEL = "on hand";

// A short voucher can be short on every one of its lines. Spelling out twenty of them
// buries the point in a wall of text, and the approver has the full voucher one click
// away in View, so list a few and count the rest.
const MAX_LISTED_SHORTFALLS = 4;

const resolveStockBucketLabel = (voucherTypeCode) =>
  STOCK_BUCKET_LABELS[String(voucherTypeCode || "").trim().toUpperCase()] ||
  DEFAULT_STOCK_BUCKET_LABEL;

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
  return `${subject} short by ${roundShortQty(shortfall?.short_qty)} (${roundShortQty(shortfall?.available_qty)} available)`;
};

const buildNegativeStockApprovalReason = ({
  voucherTypeCode,
  shortfalls = [],
} = {}) => {
  const bucket = resolveStockBucketLabel(voucherTypeCode);
  const subject = `Not enough stock ${bucket}`;
  const lines = Array.isArray(shortfalls) ? shortfalls.filter(Boolean) : [];
  if (!lines.length) return `${subject} to post this voucher.`;

  const listed = lines.slice(0, MAX_LISTED_SHORTFALLS);
  const remaining = lines.length - listed.length;
  const count = `${lines.length} ${lines.length === 1 ? "line is" : "lines are"} short`;
  const detail = listed.map(describeShortfall).join("; ");
  const more = remaining > 0 ? `; +${remaining} more` : "";
  return `${subject} — ${count}: ${detail}${more}`;
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
