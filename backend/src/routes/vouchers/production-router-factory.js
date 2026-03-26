const express = require("express");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const { UI_ERROR_COOKIE } = require("../../middleware/core/ui-flash");
const { friendlyErrorMessage } = require("../../middleware/errors/friendly-error");
const {
  createProductionVoucher,
  updateProductionVoucher,
  deleteProductionVoucher,
  loadProductionVoucherOptions,
  loadRecentProductionVouchers,
  getProductionVoucherSeriesStats,
  getProductionVoucherNeighbours,
  loadProductionVoucherDetails,
  resolveDcvRateForSku,
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

const setError = (res, message) => {
  if (!message) return;
  setCookie(
    res,
    UI_ERROR_COOKIE,
    JSON.stringify({ message: String(message) }),
    { path: "/", maxAge: 30, sameSite: "Lax" },
  );
};

const prefersJson = (req) => {
  const accept = String(req.get("accept") || "").toLowerCase();
  const requestedWith = String(req.get("x-requested-with") || "").toLowerCase();
  if (requestedWith === "xmlhttprequest") return true;
  return accept.includes("application/json");
};

const formatQty = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(3)));
};

const buildSavedTotalsNotice = ({ res, saved, voucherTypeCode }) => {
  const base = res.locals.t("saved_successfully") || "Saved successfully.";
  const totalPairs = Number(saved?.quantityTotals?.totalPairs || 0);
  const totalDozens = Number(saved?.quantityTotals?.totalDozens || 0);
  if (!Number.isFinite(totalPairs) || totalPairs <= 0) return base;

  const totalLabel = res.locals.t("total") || "Total";
  const pairsLabel = res.locals.t("pairs") || "Pairs";
  const dozensLabel = res.locals.t("dozens") || "Dozens";
  return `${base} ${totalLabel}: ${pairsLabel} ${formatQty(totalPairs)}, ${dozensLabel} ${formatQty(totalDozens)}.`;
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

  router.get("/dcv-rate", requirePermission("VOUCHER", scopeKey, "view"), async (req, res) => {
    try {
      const result = await resolveDcvRateForSku({
        req,
        labourId: req.query?.labour_id,
        deptId: req.query?.dept_id,
        skuId: req.query?.sku_id,
        unitCode: req.query?.unit,
      });
      return res.json(result || { rate: 0, found: false });
    } catch (err) {
      console.error("Error in ProductionVoucherDcvRateService:", err);
      const message = friendlyErrorMessage(err, res.locals.t);
      const status = Number(err?.status || 500);
      return res.status(status).json({ error: message, requestId: req.id || null });
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
        stage_id: req.body?.stage_id,
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
        setNotice(
          res,
          buildSavedTotalsNotice({ res, saved, voucherTypeCode }),
        );
      }

      return res.redirect(`${req.baseUrl}?new=1`);
    } catch (err) {
      console.error("Error in ProductionVoucherSaveService:", err);
      const message = friendlyErrorMessage(err, res.locals.t);
      if (prefersJson(req)) {
        const status = Number(err?.status || 500);
        return res.status(status).json({ error: message, requestId: req.id || null });
      }
      setError(res, message);
      return res.redirect(req.baseUrl);
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
      const message = friendlyErrorMessage(err, res.locals.t);
      if (prefersJson(req)) {
        const status = Number(err?.status || 500);
        return res.status(status).json({ error: message, requestId: req.id || null });
      }
      setError(res, message);
      return res.redirect(req.baseUrl);
    }
  });

  return router;
};

module.exports = {
  createProductionVoucherRouter,
};
