const express = require("express");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const {
  createOpeningStockVoucher,
  updateOpeningStockVoucher,
  deleteOpeningStockVoucher,
  loadOpeningStockVoucherOptions,
  loadRecentOpeningStockVouchers,
  getOpeningStockVoucherSeriesStats,
  getOpeningStockVoucherNeighbours,
  loadOpeningStockVoucherDetails,
  parseVoucherNo,
  INVENTORY_VOUCHER_TYPES,
} = require("../../services/inventory/inventory-voucher-service");

// Opening Stock voucher route uses a single voucher type with dynamic line behavior by stock type.
const scopeKey = "OPENING_STOCK";
const voucherTypeCode = INVENTORY_VOUCHER_TYPES.openingStock;

const toLines = (body) => {
  // UI posts lines as JSON; keep this helper tolerant of malformed payloads.
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
      // View mode resolves voucher navigation context (new/view, prev/next, latest visible).
      const forceNew = String(req.query.new || "").trim() === "1";
      const forceView = String(req.query.view || "").trim() === "1";
      const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);
      const canListHistory = canVoucherAction(res, "navigate");

      const [options, rows, stats] = await Promise.all([
        loadOpeningStockVoucherOptions(req),
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
        ? await loadOpeningStockVoucherDetails({
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
        title: `${res.locals.t("opening_stock_voucher") || res.locals.t("opening_stock")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../vouchers/inventory/index",
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
      console.error("Error in InventoryVoucherPageService:", err);
      return next(err);
    }
  },
);

router.post("/", async (req, res, next) => {
  try {
    // Save endpoint supports both create and update and lets service decide approval routing.
    const voucherId = Number(req.body?.voucher_id || 0) || null;

    const payload = {
      voucher_date: req.body?.voucher_date,
      stock_type: req.body?.stock_type,
      remarks: req.body?.remarks,
      lines: toLines(req.body),
    };

    const saved = voucherId
      ? await updateOpeningStockVoucher({
          req,
          voucherId,
          voucherTypeCode,
          scopeKey,
          payload,
        })
      : await createOpeningStockVoucher({
          req,
          voucherTypeCode,
          scopeKey,
          payload,
        });

    if (saved.queuedForApproval) {
      const msg = saved.permissionReroute
        ? res.locals.t("approval_sent") ||
          "Change submitted for Administrator approval."
        : res.locals.t("approval_submitted");
      setNotice(res, msg, true);
    } else {
      setNotice(res, res.locals.t("saved_successfully"));
    }

    return res.redirect(`${req.baseUrl}?new=1`);
  } catch (err) {
    console.error("Error in InventoryVoucherSaveService:", err);
    setNotice(res, res.locals.t("generic_error"), true);
    return next(err);
  }
});

router.post("/delete", async (req, res, next) => {
  try {
    // Delete follows the same gatekeeper pattern: direct delete if allowed, otherwise queue approval.
    const voucherId = Number(req.body?.voucher_id || 0);
    if (!Number.isInteger(voucherId) || voucherId <= 0) {
      setNotice(res, res.locals.t("error_invalid_id"), true);
      return res.redirect(req.baseUrl);
    }

    const saved = await deleteOpeningStockVoucher({
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
    console.error("Error in InventoryVoucherDeleteService:", err);
    setNotice(res, res.locals.t("generic_error"), true);
    return next(err);
  }
});

module.exports = router;
