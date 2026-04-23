const NEGATIVE_STOCK_APPROVAL_NOTICE_KEY = "approval_sent_negative_stock";
const NEGATIVE_STOCK_APPROVAL_FALLBACK_MESSAGE =
  "Insufficient stock would make inventory negative. Voucher has been submitted for Administrator approval.";

const buildNegativeStockApprovalReason = ({ voucherTypeCode }) => {
  const code = String(voucherTypeCode || "").trim().toUpperCase();
  if (code) {
    return `${code} would make stock negative.`;
  }
  return "Voucher would make stock negative.";
};

const resolveNegativeStockApprovalRouting = ({
  hasNegativeStockRisk,
  canApproveVoucherAction,
  canBypassNegativeStockApproval,
  voucherTypeCode,
}) => {
  const negativeStockRisk = hasNegativeStockRisk === true;
  const canApprove = canApproveVoucherAction === true;
  const hasBypass = canBypassNegativeStockApproval === true;
  const queueForApproval = negativeStockRisk && !canApprove && !hasBypass;

  return {
    negativeStockRisk,
    queueForApproval,
    negativeStockApprovalReroute: queueForApproval,
    approvalReason: queueForApproval
      ? buildNegativeStockApprovalReason({ voucherTypeCode })
      : null,
    noticeKey: NEGATIVE_STOCK_APPROVAL_NOTICE_KEY,
    noticeFallback: NEGATIVE_STOCK_APPROVAL_FALLBACK_MESSAGE,
  };
};

module.exports = {
  NEGATIVE_STOCK_APPROVAL_NOTICE_KEY,
  NEGATIVE_STOCK_APPROVAL_FALLBACK_MESSAGE,
  resolveNegativeStockApprovalRouting,
};
