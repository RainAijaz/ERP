const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const {
  createStockTransferVoucher,
  updateStockTransferVoucher,
  deleteStockTransferVoucher,
  loadStockTransferVoucherOptions,
  loadRecentStockTransferVouchers,
  getStockTransferVoucherSeriesStats,
  getStockTransferVoucherNeighbours,
  loadStockTransferVoucherDetails,
  parseVoucherNo,
} = require("../../services/inventory/stock-transfer-voucher-service");

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

const canVoucherAction = (res, scopeKey, action) => {
  if (typeof res?.locals?.can !== "function") return false;
  return res.locals.can("VOUCHER", scopeKey, action);
};

const createStockTransferVoucherRouter = ({
  mode,
  voucherTypeCode,
  scopeKey,
  titleKey,
}) => {
  const normalizedMode = String(mode || "").trim().toLowerCase() === "in" ? "in" : "out";
  const router = express.Router();

  router.get(
    "/",
    requirePermission("VOUCHER", scopeKey, "view"),
    async (req, res, next) => {
      try {
        const forceNew = String(req.query.new || "").trim() === "1";
        const forceView = String(req.query.view || "").trim() === "1";
        const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);
        const canListHistory = canVoucherAction(res, scopeKey, "navigate");

        const rowsPromise = canListHistory
          ? loadRecentStockTransferVouchers({ req, voucherTypeCode })
          : Promise.resolve([]);
        const [rows, stats] = await Promise.all([
          rowsPromise,
          getStockTransferVoucherSeriesStats({ req, voucherTypeCode }),
        ]);

        if (!forceNew && !forceView) {
          return res.redirect(`${req.baseUrl}?new=1`);
        }

        if (!canListHistory && !forceNew) {
          return res.redirect(`${req.baseUrl}?new=1`);
        }

        const latestVoucherNo = Number(stats.latestVoucherNo || 0);
        const latestActiveVoucherNo = Number(stats.latestActiveVoucherNo || 0);
        const latestVisibleVoucherNo = latestActiveVoucherNo || latestVoucherNo || null;

        const selectedNo =
          !canListHistory || forceNew
            ? null
            : requestedVoucherNo || latestVisibleVoucherNo;

        const selectedVoucher = canListHistory
          ? await loadStockTransferVoucherDetails({
              req,
              voucherTypeCode,
              voucherNo: selectedNo,
            })
          : null;

        const options = await loadStockTransferVoucherOptions({
          req,
          voucherTypeCode,
          includeReceivedForVoucherId:
            normalizedMode === "in" ? Number(selectedVoucher?.id || 0) || null : null,
        });

        if (
          normalizedMode === "in" &&
          selectedVoucher?.stn_out_voucher_id &&
          Array.isArray(options.pendingTransfers) &&
          !options.pendingTransfers.some(
            (entry) =>
              Number(entry?.stn_out_voucher_id || 0) ===
              Number(selectedVoucher.stn_out_voucher_id),
          )
        ) {
          options.pendingTransfers.push({
            stn_out_voucher_id: Number(selectedVoucher.stn_out_voucher_id),
            transfer_ref_no: selectedVoucher.transfer_ref_no || "",
            bill_book_no: selectedVoucher.bill_book_no || "",
            stock_type: selectedVoucher.stock_type || "FG",
            source_branch_id: Number(selectedVoucher.source_branch_id || 0) || null,
            source_branch_name: selectedVoucher.source_branch_name || "",
            destination_branch_id: Number(selectedVoucher.destination_branch_id || req.branchId),
            destination_branch_name: selectedVoucher.destination_branch_name || "",
            dispatch_date: selectedVoucher.voucher_date,
            status: "RECEIVED",
            lines: selectedVoucher.lines || [],
          });
        }

        const currentCursorNo = forceNew
          ? latestVoucherNo + 1
          : requestedVoucherNo ||
            Number(selectedVoucher?.voucher_no || latestVisibleVoucherNo || latestVoucherNo || 0);

        const { prevVoucherNo, nextVoucherNo } = canListHistory
          ? await getStockTransferVoucherNeighbours({
              req,
              voucherTypeCode,
              cursorNo: currentCursorNo,
            })
          : { prevVoucherNo: null, nextVoucherNo: null };

        return res.render("base/layouts/main", {
          title: res.locals.t(titleKey) || titleKey,
          user: req.user,
          branchId: req.branchId,
          branchScope: req.branchScope,
          csrfToken: res.locals.csrfToken,
          view: "../../vouchers/stn/index",
          t: res.locals.t,
          mode: normalizedMode,
          showModeSwitch: false,
          options,
          rows,
          selectedVoucher,
          prevVoucherNo,
          nextVoucherNo,
          latestVoucherNo,
          basePath: req.baseUrl,
          scopeKey,
          voucherTypeCode,
          allowCreate: canVoucherAction(res, scopeKey, "create"),
          allowEdit: canVoucherAction(res, scopeKey, "edit"),
          allowDelete: canVoucherAction(res, scopeKey, "hard_delete"),
        });
      } catch (err) {
        console.error("Error in StockTransferVoucherPageService:", err);
        return next(err);
      }
    },
  );

  router.get(
    "/gate-pass",
    requirePermission("VOUCHER", scopeKey, "print"),
    async (req, res, next) => {
      try {
        const voucherNo = parseVoucherNo(req.query?.voucher_no);
        if (!voucherNo) {
          setNotice(res, res.locals.t("error_invalid_id"), true);
          return res.redirect(req.baseUrl);
        }

        const voucher = await loadStockTransferVoucherDetails({
          req,
          voucherTypeCode,
          voucherNo,
        });
        if (!voucher) {
          setNotice(res, res.locals.t("generic_error"), true);
          return res.redirect(req.baseUrl);
        }

        return res.render("vouchers/stn/gate-pass", {
          t: res.locals.t,
          voucher,
          titleKey,
          voucherTypeCode,
          mode: normalizedMode,
        });
      } catch (err) {
        console.error("Error in StockTransferGatePassService:", err);
        return next(err);
      }
    },
  );

  router.post(
    "/",
    requirePermission("VOUCHER", scopeKey, "view"),
    async (req, res, next) => {
      try {
        const voucherId = Number(req.body?.voucher_id || 0) || null;
        const payload = {
          voucher_date: req.body?.voucher_date,
          stock_type: req.body?.stock_type,
          destination_branch_id: req.body?.destination_branch_id,
          transfer_ref_no: req.body?.transfer_ref_no,
          bill_book_no: req.body?.bill_book_no,
          transfer_reason: req.body?.transfer_reason,
          transporter_name: req.body?.transporter_name,
          stn_out_voucher_id: req.body?.stn_out_voucher_id,
          remarks: req.body?.remarks,
          received_date_time: req.body?.received_date_time,
          lines: toLines(req.body),
        };

        const saved = voucherId
          ? await updateStockTransferVoucher({
              req,
              voucherId,
              voucherTypeCode,
              scopeKey,
              payload,
            })
          : await createStockTransferVoucher({
              req,
              voucherTypeCode,
              scopeKey,
              payload,
            });

        if (saved.queuedForApproval) {
          let msg;
          if (saved.negativeStockApprovalReroute === true) {
            msg =
              res.locals.t("approval_sent_negative_stock") ;
            const approvalReason = String(saved.approvalReason || "").trim();
            if (approvalReason) {
              const reasonLabel = res.locals.t("reason") ;
              msg = `${msg} ${reasonLabel}: ${approvalReason}`;
            }
          } else {
            msg = saved.permissionReroute
              ? res.locals.t("approval_sent") 
              : res.locals.t("approval_submitted");
          }
          setNotice(res, msg, true);
        } else {
          setNotice(res, res.locals.t("saved_successfully"));
        }

        return res.redirect(`${req.baseUrl}?new=1`);
      } catch (err) {
        console.error("Error in StockTransferVoucherSaveService:", err);
        setNotice(res, res.locals.t("generic_error"), true);
        return next(err);
      }
    },
  );

  router.post(
    "/delete",
    requirePermission("VOUCHER", scopeKey, "view"),
    async (req, res, next) => {
      try {
        const voucherId = Number(req.body?.voucher_id || 0);
        if (!Number.isInteger(voucherId) || voucherId <= 0) {
          setNotice(res, res.locals.t("error_invalid_id"), true);
          return res.redirect(req.baseUrl);
        }

        const saved = await deleteStockTransferVoucher({
          req,
          voucherId,
          voucherTypeCode,
          scopeKey,
        });

        if (saved.queuedForApproval) {
          const msg = saved.permissionReroute
            ? res.locals.t("approval_sent") 
            : res.locals.t("approval_submitted");
          setNotice(res, msg, true);
        } else {
          setNotice(
            res,
            res.locals.t("deleted_successfully") ,
          );
        }

        return res.redirect(req.baseUrl);
      } catch (err) {
        console.error("Error in StockTransferVoucherDeleteService:", err);
        setNotice(res, res.locals.t("generic_error"), true);
        return next(err);
      }
    },
  );

  return router;
};

module.exports = { createStockTransferVoucherRouter };
