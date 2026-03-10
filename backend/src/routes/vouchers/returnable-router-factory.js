const express = require("express");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const {
  RETURNABLE_VOUCHER_TYPES,
  parseVoucherNo,
  loadReturnableVoucherOptions,
  loadRecentReturnableVouchers,
  getReturnableVoucherSeriesStats,
  getReturnableVoucherNeighbours,
  loadReturnableVoucherDetails,
  createReturnableVoucher,
  updateReturnableVoucher,
  deleteReturnableVoucher,
} = require("../../services/returnables/returnable-voucher-service");

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

const canViewVoucher = (req, voucherTypeCode) => {
  const check = typeof req?.res?.locals?.can === "function" ? req.res.locals.can : null;
  if (!check) return false;
  return check("VOUCHER", voucherTypeCode, "view");
};

const createReturnableVoucherRouter = ({
  voucherTypeCode,
  scopeKey,
  dispatchPath,
  receiptPath,
}) => {
  const router = express.Router();

  router.get("/", requirePermission("VOUCHER", scopeKey, "view"), async (req, res, next) => {
    try {
      const forceNew = String(req.query.new || "").trim() === "1";
      const forceView = String(req.query.view || "").trim() === "1";
      const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);
      const canDispatch = canViewVoucher(req, RETURNABLE_VOUCHER_TYPES.dispatch);
      const canReceipt = canViewVoucher(req, RETURNABLE_VOUCHER_TYPES.receipt);

      const [options, rows, stats] = await Promise.all([
        loadReturnableVoucherOptions(req),
        loadRecentReturnableVouchers({ req, voucherTypeCode }),
        getReturnableVoucherSeriesStats({ req, voucherTypeCode }),
      ]);

      if (!forceNew && !forceView) {
        return res.redirect(`${req.baseUrl}?new=1`);
      }

      const latestVoucherNo = Number(stats.latestVoucherNo || 0);
      const latestActiveVoucherNo = Number(stats.latestActiveVoucherNo || 0);
      const latestVisibleVoucherNo = latestActiveVoucherNo || latestVoucherNo || null;

      const selectedNo = forceNew ? null : requestedVoucherNo || latestVisibleVoucherNo;
      const selectedVoucher = await loadReturnableVoucherDetails({
        req,
        voucherTypeCode,
        voucherNo: selectedNo,
      });

      const currentCursorNo = forceNew
        ? latestVoucherNo + 1
        : requestedVoucherNo || Number(selectedVoucher?.voucher_no || latestVisibleVoucherNo || latestVoucherNo || 0);

      const { prevVoucherNo, nextVoucherNo } = await getReturnableVoucherNeighbours({
        req,
        voucherTypeCode,
        cursorNo: currentCursorNo,
      });

      const pageTitle =
        voucherTypeCode === RETURNABLE_VOUCHER_TYPES.receipt
          ? res.locals.t("returnable_receipt_voucher")
          : res.locals.t("returnable_dispatch_voucher");

      return res.render("base/layouts/main", {
        title: `${pageTitle} - ${res.locals.t("outward_returnable")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../vouchers/returnables/index",
        t: res.locals.t,
        options,
        rows,
        selectedVoucher,
        prevVoucherNo,
        nextVoucherNo,
        latestVoucherNo,
        basePath: req.baseUrl,
        voucherTypeCode,
        canDispatch,
        canReceipt,
        dispatchCode: RETURNABLE_VOUCHER_TYPES.dispatch,
        receiptCode: RETURNABLE_VOUCHER_TYPES.receipt,
        dispatchPath,
        receiptPath,
      });
    } catch (err) {
      console.error("Error in ReturnableVoucherPageService:", err);
      return next(err);
    }
  });

  if (voucherTypeCode === RETURNABLE_VOUCHER_TYPES.dispatch) {
    router.get("/gate-pass", requirePermission("VOUCHER", scopeKey, "print"), async (req, res, next) => {
      try {
        const voucherNo = parseVoucherNo(req.query.voucher_no);
        const selectedVoucher = await loadReturnableVoucherDetails({
          req,
          voucherTypeCode: RETURNABLE_VOUCHER_TYPES.dispatch,
          voucherNo,
        });
        if (!selectedVoucher) {
          const err = new Error(res.locals.t("error_not_found"));
          err.status = 404;
          throw err;
        }
        return res.render("vouchers/returnables/gate-pass", {
          t: res.locals.t,
          voucher: selectedVoucher,
          formatDateDisplay: res.locals.formatDateDisplay,
        });
      } catch (err) {
        console.error("Error in ReturnableGatePassService:", err);
        return next(err);
      }
    });
  }

  router.post("/", async (req, res, next) => {
    const voucherId = Number(req.body?.voucher_id || 0) || null;
    try {
      const payload = {
        voucher_date: req.body?.voucher_date,
        vendor_party_id: req.body?.vendor_party_id,
        reason_code: req.body?.reason_code,
        expected_return_date: req.body?.expected_return_date,
        rgp_out_voucher_id: req.body?.rgp_out_voucher_id,
        remarks: req.body?.remarks,
        lines: toLines(req.body),
      };

      const saved = voucherId
        ? await updateReturnableVoucher({
            req,
            voucherId,
            voucherTypeCode,
            scopeKey,
            payload,
          })
        : await createReturnableVoucher({
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
      console.error("Error in ReturnableVoucherSaveService:", err);
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

      const saved = await deleteReturnableVoucher({
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

      return res.redirect(`${req.baseUrl}?new=1`);
    } catch (err) {
      console.error("Error in ReturnableVoucherDeleteService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  return router;
};

module.exports = {
  createReturnableVoucherRouter,
};
