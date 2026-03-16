const express = require("express");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const {
  createProductionVoucher,
  updateProductionVoucher,
  deleteProductionVoucher,
  loadProductionVoucherOptions,
  loadRecentProductionVouchers,
  getProductionVoucherSeriesStats,
  getProductionVoucherNeighbours,
  loadProductionVoucherDetails,
  parseVoucherNo,
} = require("../../services/production/production-voucher-service");

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

const createProductionVoucherRouter = ({
  titleKey,
  subtitleKey,
  voucherTypeCode,
  scopeKey,
  mode = "production",
  allowCreate = true,
  allowEdit = true,
  allowDelete = true,
}) => {
  const router = express.Router();

  router.get("/", requirePermission("VOUCHER", scopeKey, "view"), async (req, res, next) => {
    try {
      const forceNew = String(req.query.new || "").trim() === "1";
      const forceView = String(req.query.view || "").trim() === "1";
      const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);

      const [rows, stats] = await Promise.all([
        loadRecentProductionVouchers({ req, voucherTypeCode }),
        getProductionVoucherSeriesStats({ req, voucherTypeCode }),
      ]);

      if (!forceNew && !forceView) {
        return res.redirect(`${req.baseUrl}?new=1`);
      }

      const latestVoucherNo = Number(stats.latestVoucherNo || 0);
      const latestActiveVoucherNo = Number(stats.latestActiveVoucherNo || 0);
      const latestVisibleVoucherNo = latestActiveVoucherNo || latestVoucherNo || null;

      const selectedNo = forceNew ? null : requestedVoucherNo || latestVisibleVoucherNo;
      const selectedVoucher = await loadProductionVoucherDetails({
        req,
        voucherTypeCode,
        voucherNo: selectedNo,
      });

      const options = await loadProductionVoucherOptions(req, {
        voucherTypeCode,
        selectedVoucher,
      });

      const currentCursorNo = forceNew
        ? latestVoucherNo + 1
        : requestedVoucherNo || Number(selectedVoucher?.voucher_no || latestVisibleVoucherNo || latestVoucherNo || 0);
      const { prevVoucherNo, nextVoucherNo } = await getProductionVoucherNeighbours({
        req,
        voucherTypeCode,
        cursorNo: currentCursorNo,
      });

      return res.render("base/layouts/main", {
        title: `${res.locals.t(titleKey)} - ${res.locals.t("production")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../vouchers/production/index",
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
        mode,
        allowCreate,
        allowEdit,
        allowDelete,
      });
    } catch (err) {
      console.error("Error in ProductionVoucherPageService:", err);
      return next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      if (!allowCreate && !req.body?.voucher_id) {
        setNotice(res, res.locals.t("generic_error"), true);
        return res.redirect(req.baseUrl);
      }
      if (!allowEdit && req.body?.voucher_id) {
        setNotice(res, res.locals.t("generic_error"), true);
        return res.redirect(req.baseUrl);
      }

      const voucherId = Number(req.body?.voucher_id || 0) || null;
      const payload = {
        voucher_date: req.body?.voucher_date,
        reference_no: req.body?.reference_no,
        remarks: req.body?.remarks,
        dept_id: req.body?.dept_id,
        labour_id: req.body?.labour_id,
        plan_kind: req.body?.plan_kind,
        reason_code_id: req.body?.reason_code_id,
        lines: toLines(req.body),
      };

      const saved = voucherId
        ? await updateProductionVoucher({
            req,
            voucherId,
            voucherTypeCode,
            scopeKey,
            payload,
          })
        : await createProductionVoucher({
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
      console.error("Error in ProductionVoucherSaveService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  router.post("/delete", async (req, res, next) => {
    try {
      if (!allowDelete) {
        setNotice(res, res.locals.t("generic_error"), true);
        return res.redirect(req.baseUrl);
      }

      const voucherId = Number(req.body?.voucher_id || 0);
      if (!Number.isInteger(voucherId) || voucherId <= 0) {
        setNotice(res, res.locals.t("error_invalid_id"), true);
        return res.redirect(req.baseUrl);
      }

      const saved = await deleteProductionVoucher({
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
      console.error("Error in ProductionVoucherDeleteService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  return router;
};

module.exports = {
  createProductionVoucherRouter,
};
