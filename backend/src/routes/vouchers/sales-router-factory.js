const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const {
  createSalesVoucher,
  updateSalesVoucher,
  deleteSalesVoucher,
  loadSalesVoucherOptions,
  loadRecentSalesVouchers,
  getSalesVoucherSeriesStats,
  getSalesVoucherNeighbours,
  loadSalesVoucherDetails,
  loadSalesGatePassDetails,
  parseVoucherNo,
} = require("../../services/sales/sales-voucher-service");

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

const actionDeniedMessage = (res) =>
  res.locals.t("error_action_not_allowed") ||
  res.locals.t("permission_denied") ||
  res.locals.t("generic_error");

const createSalesVoucherRouter = ({
  titleKey,
  subtitleKey,
  voucherTypeCode,
  scopeKey,
}) => {
  const router = express.Router();

  router.get(
    "/",
    requirePermission("VOUCHER", scopeKey, "view"),
    async (req, res, next) => {
      try {
        const forceNew = String(req.query.new || "").trim() === "1";
        const forceView = String(req.query.view || "").trim() === "1";
        const forceGatePassOpen =
          String(req.query.open_gate_pass || "").trim() === "1";
        const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);
        const canListHistory =
          typeof res.locals.can === "function" &&
          res.locals.can("VOUCHER", scopeKey, "navigate");

        const [rows, stats] = await Promise.all([
          canListHistory
            ? loadRecentSalesVouchers({ req, voucherTypeCode })
            : Promise.resolve([]),
          getSalesVoucherSeriesStats({ req, voucherTypeCode }),
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
          ? await loadSalesVoucherDetails({
              req,
              voucherTypeCode,
              voucherNo: selectedNo,
            })
          : null;

        const options = await loadSalesVoucherOptions(req, {
          selectedVoucher,
          voucherTypeCode,
        });

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
          ? await getSalesVoucherNeighbours({
              req,
              voucherTypeCode,
              cursorNo: currentCursorNo,
            })
          : { prevVoucherNo: null, nextVoucherNo: null };

        const canOverrideRateDiscount =
          req.user?.isAdmin === true ||
          (typeof res.locals.can === "function" &&
            res.locals.can("VOUCHER", scopeKey, "approve"));
        const allowCreate = canVoucherAction(res, scopeKey, "create");
        const allowEdit = canVoucherAction(res, scopeKey, "edit");
        const allowDelete = canVoucherAction(res, scopeKey, "hard_delete");
        const allowPrintGatePass = canVoucherAction(res, scopeKey, "print");
        const selectedVoucherNo =
          Number(selectedVoucher?.voucher_no || 0) || null;

        return res.render("base/layouts/main", {
          title: `${res.locals.t(titleKey)} - ${res.locals.t("sales")}`,
          user: req.user,
          branchId: req.branchId,
          branchScope: req.branchScope,
          csrfToken: res.locals.csrfToken,
          view: "../../vouchers/sales/index",
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
          canOverrideRateDiscount,
          allowCreate,
          allowEdit,
          allowDelete,
          allowPrintGatePass,
          autoOpenGatePass:
            forceGatePassOpen &&
            allowPrintGatePass &&
            Boolean(selectedVoucherNo),
        });
      } catch (err) {
        console.error("Error in SalesVoucherPageService:", err);
        return next(err);
      }
    },
  );

  router.post("/", async (req, res, next) => {
    try {
      const voucherId = Number(req.body?.voucher_id || 0) || null;
      if (voucherId && !canVoucherAction(res, scopeKey, "edit")) {
        setNotice(res, actionDeniedMessage(res), true);
        return res.redirect(req.baseUrl);
      }

      const payload = {
        voucher_date: req.body?.voucher_date,
        book_no: req.body?.book_no,
        reference_no: req.body?.reference_no,
        description: req.body?.description,
        sale_mode: req.body?.sale_mode,
        payment_type: req.body?.payment_type,
        customer_party_id: req.body?.customer_party_id,
        customer_name: req.body?.customer_name,
        customer_phone_number: req.body?.customer_phone_number,
        linked_sales_order_id: req.body?.linked_sales_order_id,
        salesman_employee_id: req.body?.salesman_employee_id,
        advance_receive: req.body?.advance_receive,
        payment_due_date: req.body?.payment_due_date,
        receive_into_account_id: req.body?.receive_into_account_id,
        payment_received_amount: req.body?.payment_received_amount,
        delivery_method: req.body?.delivery_method,
        extra_discount: req.body?.extra_discount,
        lines: toLines(req.body),
      };

      const saved = voucherId
        ? await updateSalesVoucher({
            req,
            voucherId,
            voucherTypeCode,
            scopeKey,
            payload,
          })
        : await createSalesVoucher({
            req,
            voucherTypeCode,
            scopeKey,
            payload,
          });

      if (saved.queuedForApproval) {
        const msg = saved.permissionReroute
          ? res.locals.t("approval_sent")
          : res.locals.t("approval_submitted");
        setNotice(res, msg, true);
      } else {
        setNotice(res, res.locals.t("saved_successfully"));
      }

      const savedVoucherNo = Number(saved?.voucherNo || 0) || null;
      const canPrintGatePass = canVoucherAction(res, scopeKey, "print");
      const shouldAutoOpenGatePass =
        voucherTypeCode === "SALES_VOUCHER" &&
        canPrintGatePass &&
        Boolean(savedVoucherNo);

      if (shouldAutoOpenGatePass) {
        return res.redirect(
          `${req.baseUrl}?voucher_no=${savedVoucherNo}&view=1&open_gate_pass=1`,
        );
      }

      return res.redirect(`${req.baseUrl}?new=1`);
    } catch (err) {
      console.error("Error in SalesVoucherSaveService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  router.post("/delete", async (req, res, next) => {
    try {
      if (!canVoucherAction(res, scopeKey, "hard_delete")) {
        setNotice(res, actionDeniedMessage(res), true);
        return res.redirect(req.baseUrl);
      }

      const voucherId = Number(req.body?.voucher_id || 0);
      if (!Number.isInteger(voucherId) || voucherId <= 0) {
        setNotice(res, res.locals.t("error_invalid_id"), true);
        return res.redirect(req.baseUrl);
      }

      const saved = await deleteSalesVoucher({
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
        setNotice(res, res.locals.t("deleted_successfully"));
      }

      return res.redirect(req.baseUrl);
    } catch (err) {
      console.error("Error in SalesVoucherDeleteService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  router.get(
    "/gate-pass",
    requirePermission("VOUCHER", scopeKey, "print"),
    async (req, res, next) => {
      try {
        const voucherNo = parseVoucherNo(req.query.voucher_no);
        const embedMode = String(req.query.embed || "").trim() === "1";
        const downloadMode = String(req.query.download || "").trim() === "1";
        const localeCode =
          String(res.locals?.locale || "en")
            .trim()
            .toLowerCase() === "ur"
            ? "ur"
            : "en";
        if (!voucherNo) throw new Error("Invalid voucher no");

        const gatePass = await loadSalesGatePassDetails({
          req,
          voucherTypeCode,
          voucherNo,
        });
        if (!gatePass) throw new Error("Gate pass data not found");

        if (downloadMode) {
          const filename = `sales-gate-pass-${voucherNo}.html`;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename=\"${filename}\"`,
          );
        }

        return res.render("vouchers/sales/gate-pass", {
          layout: false,
          t: res.locals.t,
          gatePass,
          voucherTypeCode,
          locale: localeCode,
          dir: localeCode === "ur" ? "rtl" : "ltr",
          embedMode,
        });
      } catch (err) {
        console.error("Error in SalesGatePassService:", err);
        setNotice(res, res.locals.t("generic_error"), true);
        return res.redirect(req.baseUrl);
      }
    },
  );

  return router;
};

module.exports = {
  createSalesVoucherRouter,
};
