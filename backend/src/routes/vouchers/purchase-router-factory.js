const express = require("express");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const {
  createPurchaseVoucher,
  updatePurchaseVoucher,
  deletePurchaseVoucher,
  loadPurchaseVoucherOptions,
  loadRecentPurchaseVouchers,
  getPurchaseVoucherSeriesStats,
  getPurchaseVoucherNeighbours,
  loadPurchaseVoucherDetails,
  parseVoucherNo,
} = require("../../services/purchase/purchase-voucher-service");

const toLines = (body) => {
  if (Array.isArray(body?.lines)) return body.lines;
  if (typeof body?.lines_json === "string" && body.lines_json.trim()) {
    try {
      const parsed = JSON.parse(body.lines_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
};

const toGrnAllocations = (body) => {
  if (body?.grn_allocations && typeof body.grn_allocations === "object") {
    return body.grn_allocations;
  }
  if (typeof body?.grn_allocations_json === "string" && body.grn_allocations_json.trim()) {
    try {
      const parsed = JSON.parse(body.grn_allocations_json);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      return null;
    }
  }
  return null;
};

const setNotice = (res, message, sticky = false) => {
  if (!message) return;
  setCookie(
    res,
    UI_NOTICE_COOKIE,
    JSON.stringify({
      message,
      sticky,
      autoClose: !sticky,
    }),
    { path: "/", maxAge: 30, sameSite: "Lax" },
  );
};

const createPurchaseVoucherRouter = ({
  titleKey,
  subtitleKey,
  voucherTypeCode,
  scopeKey,
}) => {
  const router = express.Router();

  router.get("/", requirePermission("VOUCHER", scopeKey, "view"), async (req, res, next) => {
    try {
      const forceNew = String(req.query.new || "").trim() === "1";
      const forceView = String(req.query.view || "").trim() === "1";
      const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);

      const [options, rows, stats] = await Promise.all([
        loadPurchaseVoucherOptions(req),
        loadRecentPurchaseVouchers({ req, voucherTypeCode }),
        getPurchaseVoucherSeriesStats({ req, voucherTypeCode }),
      ]);

      if (!forceNew && !forceView) {
        return res.redirect(`${req.baseUrl}?new=1`);
      }

      const latestVoucherNo = Number(stats.latestVoucherNo || 0);
      const latestActiveVoucherNo = Number(stats.latestActiveVoucherNo || 0);
      const latestVisibleVoucherNo = latestActiveVoucherNo || latestVoucherNo || null;

      const selectedNo = forceNew ? null : requestedVoucherNo || latestVisibleVoucherNo;
      const selectedVoucher = await loadPurchaseVoucherDetails({
        req,
        voucherTypeCode,
        voucherNo: selectedNo,
      });

      const currentCursorNo = forceNew
        ? latestVoucherNo + 1
        : requestedVoucherNo || Number(selectedVoucher?.voucher_no || latestVisibleVoucherNo || latestVoucherNo || 0);

      const { prevVoucherNo, nextVoucherNo } = await getPurchaseVoucherNeighbours({
        req,
        voucherTypeCode,
        cursorNo: currentCursorNo,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t(titleKey)} - ${res.locals.t("purchase")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../vouchers/purchase/common",
        t: res.locals.t,
        options,
        rows,
        selectedVoucher,
        prevVoucherNo,
        nextVoucherNo,
        latestVoucherNo,
        basePath: req.baseUrl,
        scopeKey,
        voucherTypeCode,
        titleKey,
        subtitleKey,
      });
    } catch (err) {
      console.error("Error in PurchaseVoucherPageService:", err);
      return next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const voucherId = Number(req.body?.voucher_id || 0) || null;
      const payload = {
        voucher_date: req.body?.voucher_date,
        supplier_party_id: req.body?.supplier_party_id,
        reference_no: req.body?.reference_no,
        description: req.body?.description,
        payment_type: req.body?.payment_type,
        cash_paid_account_id: req.body?.cash_paid_account_id,
        return_reason: req.body?.return_reason,
        grn_reference_voucher_no: req.body?.grn_reference_voucher_no,
        grn_allocations: toGrnAllocations(req.body),
        lines: toLines(req.body),
      };

      const saved = voucherId
        ? await updatePurchaseVoucher({
            req,
            voucherId,
            voucherTypeCode,
            scopeKey,
            payload,
          })
        : await createPurchaseVoucher({
            req,
            voucherTypeCode,
            scopeKey,
            payload,
          });

      if (saved.queuedForApproval) {
        const msg = saved.permissionReroute
          ? res.locals.t("approval_sent") || "Change submitted for Administrator approval."
          : res.locals.t("approval_submitted");
        setNotice(res, msg, true);
      } else {
        setNotice(res, res.locals.t("saved_successfully"));
      }

      return res.redirect(`${req.baseUrl}?new=1`);
    } catch (err) {
      console.error("Error in PurchaseVoucherSaveService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  router.post("/delete", async (req, res, next) => {
    try {
      const voucherId = Number(req.body?.voucher_id || 0);
      if (!Number.isInteger(voucherId) || voucherId <= 0) {
        setNotice(res, res.locals.t("error_invalid_id"), true);
        return res.redirect(req.baseUrl);
      }

      const saved = await deletePurchaseVoucher({
        req,
        voucherId,
        voucherTypeCode,
        scopeKey,
      });

      if (saved.queuedForApproval) {
        const msg = saved.permissionReroute
          ? res.locals.t("approval_sent") || "Change submitted for Administrator approval."
          : res.locals.t("approval_submitted");
        setNotice(res, msg, true);
      } else {
        setNotice(res, res.locals.t("deleted_successfully") || "Deleted successfully.");
      }

      return res.redirect(req.baseUrl);
    } catch (err) {
      console.error("Error in PurchaseVoucherDeleteService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  return router;
};

module.exports = {
  createPurchaseVoucherRouter,
};
