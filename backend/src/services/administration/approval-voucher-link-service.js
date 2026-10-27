const knex = require("../../db/knex");
const { resolveScopeMetaByKey } = require("../../utils/activity-scope-resolver");

// Resolve the actual stored voucher, not mutable approval-payload numbers.
const resolveApprovalVoucherLink = async ({ request, user, can, db = knex }) => {
  try {
    if (request?.entity_type !== "VOUCHER" || request?.request_type !== "VOUCHER") return null;
    if (!user?.isAdmin && Number(request.requested_by) !== Number(user?.id)) return null;
    const id = Number(request.entity_id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const voucher = await db("erp.voucher_header")
      .select("id", "voucher_no", "voucher_type_code", "branch_id")
      .where({ id }).first();
    if (!voucher) return null;
    const scope = resolveScopeMetaByKey({ scopeType: "VOUCHER", scopeKey: voucher.voucher_type_code });
    if (!scope?.route || !can("VOUCHER", scope.scopeKey, "view")) return null;
    if (!user?.isAdmin && !(user?.branchIds || []).map(Number).includes(Number(voucher.branch_id))) return null;
    const voucherNo = Number(voucher.voucher_no);
    const branchId = Number(voucher.branch_id);
    if (!Number.isSafeInteger(voucherNo) || voucherNo <= 0 || !Number.isSafeInteger(branchId) || branchId <= 0) return null;
    const params = new URLSearchParams({ view: "1", voucher_no: String(voucherNo), branch_id: String(branchId) });
    return `${scope.route}?${params}`;
  } catch (err) {
    console.error("Error in ApprovalVoucherLinkService:", err);
    throw err;
  }
};

module.exports = { resolveApprovalVoucherLink };
