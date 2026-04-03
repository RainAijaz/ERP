const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const {
  createStockCountAdjustmentVoucher,
  updateStockCountAdjustmentVoucher,
  deleteStockCountAdjustmentVoucher,
  loadStockCountAdjustmentVoucherOptions,
  loadRecentOpeningStockVouchers,
  getOpeningStockVoucherSeriesStats,
  getOpeningStockVoucherNeighbours,
  loadStockCountAdjustmentVoucherDetails,
  parseVoucherNo,
  INVENTORY_VOUCHER_TYPES,
} = require("../../services/inventory/inventory-voucher-service");

const scopeKey = "STOCK_COUNT_ADJ";
const voucherTypeCode = INVENTORY_VOUCHER_TYPES.stockCountAdjustment;

// Accept either structured lines array or JSON string from the voucher table script.
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

const canVoucherAction = (res, action) => {
  if (typeof res?.locals?.can !== "function") return false;
  return res.locals.can("VOUCHER", scopeKey, action);
};

const router = express.Router();

router.get(
  "/",
  requirePermission("VOUCHER", scopeKey, "view"),
  async (req, res, next) => {
    try {
      // Keep navigation behavior consistent with other vouchers: new mode vs view mode.
      const forceNew = String(req.query.new || "").trim() === "1";
      const forceView = String(req.query.view || "").trim() === "1";
      const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);
      const canListHistory = canVoucherAction(res, "navigate");

      const [options, rows, stats] = await Promise.all([
        loadStockCountAdjustmentVoucherOptions(req),
        canListHistory
          ? loadRecentOpeningStockVouchers({ req, voucherTypeCode })
          : Promise.resolve([]),
        getOpeningStockVoucherSeriesStats({ req, voucherTypeCode }),
      ]);

      if (!forceNew && !forceView) {
        return res.redirect(`${req.baseUrl}?new=1`);
      }

      if (!canListHistory && !forceNew) {
        return res.redirect(`${req.baseUrl}?new=1`);
      }

      const latestVoucherNo = Number(stats.latestVoucherNo || 0);
      const latestActiveVoucherNo = Number(stats.latestActiveVoucherNo || 0);
      const latestVisibleVoucherNo =
        latestActiveVoucherNo || latestVoucherNo || null;

      const selectedNo =
        !canListHistory || forceNew
          ? null
          : requestedVoucherNo || latestVisibleVoucherNo;

      const selectedVoucher = canListHistory
        ? await loadStockCountAdjustmentVoucherDetails({
            req,
            voucherTypeCode,
            voucherNo: selectedNo,
          })
        : null;

      const currentCursorNo = forceNew
        ? latestVoucherNo + 1
        : requestedVoucherNo ||
          Number(
            selectedVoucher?.voucher_no ||
              latestVisibleVoucherNo ||
              latestVoucherNo ||
              0,
          );

      const { prevVoucherNo, nextVoucherNo } = canListHistory
        ? await getOpeningStockVoucherNeighbours({
            req,
            voucherTypeCode,
            cursorNo: currentCursorNo,
          })
        : { prevVoucherNo: null, nextVoucherNo: null };

      return res.render("base/layouts/main", {
        title:
          res.locals.t("stock_count_adjustment_voucher") ||
          res.locals.t("stock_count"),
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../vouchers/stock-count/index",
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
        allowCreate: canVoucherAction(res, "create"),
        allowEdit: canVoucherAction(res, "edit"),
        allowDelete: canVoucherAction(res, "hard_delete"),
      });
    } catch (err) {
      console.error("Error in StockCountVoucherPageService:", err);
      return next(err);
    }
  },
);

router.post("/", async (req, res, next) => {
  try {
    // Service layer enforces gatekeeper + approval routing + stock/GL replay.
    const voucherId = Number(req.body?.voucher_id || 0) || null;

    const payload = {
      voucher_date: req.body?.voucher_date,
      stock_type: req.body?.stock_type,
      remarks: req.body?.remarks,
      reason_code_id: req.body?.reason_code_id,
      reason_notes: req.body?.reason_notes,
      lines: toLines(req.body),
    };

    const saved = voucherId
      ? await updateStockCountAdjustmentVoucher({
          req,
          voucherId,
          voucherTypeCode,
          scopeKey,
          payload,
        })
      : await createStockCountAdjustmentVoucher({
          req,
          voucherTypeCode,
          scopeKey,
          payload,
        });

    if (saved.queuedForApproval) {
      let msg;
      if (saved.negativeStockApprovalReroute === true) {
        msg =
          res.locals.t("approval_sent_negative_stock") ||
          "Insufficient stock would make inventory negative. Voucher has been submitted for Administrator approval.";
        const approvalReason = String(saved.approvalReason || "").trim();
        if (approvalReason) {
          const reasonLabel = res.locals.t("reason") || "Reason";
          msg = `${msg} ${reasonLabel}: ${approvalReason}`;
        }
      } else {
        msg = saved.permissionReroute
          ? res.locals.t("approval_sent") ||
            "Change submitted for Administrator approval."
          : res.locals.t("approval_submitted");
      }
      setNotice(res, msg, true);
    } else {
      setNotice(res, res.locals.t("saved_successfully"));
    }

    return res.redirect(`${req.baseUrl}?new=1`);
  } catch (err) {
    console.error("Error in StockCountVoucherSaveService:", err);
    setNotice(res, res.locals.t("generic_error"), true);
    return next(err);
  }
});

router.post("/delete", async (req, res, next) => {
  try {
    // Delete follows the same gatekeeper model: direct reject or pending approval request.
    const voucherId = Number(req.body?.voucher_id || 0);
    if (!Number.isInteger(voucherId) || voucherId <= 0) {
      setNotice(res, res.locals.t("error_invalid_id"), true);
      return res.redirect(req.baseUrl);
    }

    const saved = await deleteStockCountAdjustmentVoucher({
      req,
      voucherId,
      voucherTypeCode,
      scopeKey,
    });

    if (saved.queuedForApproval) {
      const msg = saved.permissionReroute
        ? res.locals.t("approval_sent") ||
          "Change submitted for Administrator approval."
        : res.locals.t("approval_submitted");
      setNotice(res, msg, true);
    } else {
      setNotice(
        res,
        res.locals.t("deleted_successfully") || "Deleted successfully.",
      );
    }

    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in StockCountVoucherDeleteService:", err);
    setNotice(res, res.locals.t("generic_error"), true);
    return next(err);
  }
});

module.exports = router;
