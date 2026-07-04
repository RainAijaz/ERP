const express = require("express");
const knex = require("../../../db/knex");
const {
  requirePermission,
} = require("../../../middleware/access/role-permissions");
const {
  friendlyErrorMessage,
} = require("../../../middleware/errors/friendly-error");
const { setCookie } = require("../../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../../middleware/core/ui-notice");
const bomCascadeService = require("../../../services/bom/cascade-service");

const router = express.Router();
const BOM_SCOPE = "master_data.bom";

const setUiNotice = (res, message, options = {}) => {
  if (!message) return;
  setCookie(res, UI_NOTICE_COOKIE, JSON.stringify({ message, ...options }), {
    path: "/",
    maxAge: 30,
    sameSite: "Lax",
  });
};

const renderPage = (req, res, view, title, payload = {}) =>
  res.render("base/layouts/main", {
    title,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view,
    t: res.locals.t,
    ...payload,
  });

const safeJsonArray = (raw) => {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
};

// GET /cascade?parent_item_id=&level=&parent_bom_id=
router.get(
  "/",
  requirePermission("SCREEN", BOM_SCOPE, "view"),
  async (req, res, next) => {
    try {
      const parentItemId = Number(req.query.parent_item_id || 0);
      const level = String(req.query.level || "").trim().toUpperCase();
      const parentBomId = Number(req.query.parent_bom_id || 0);
      if (!parentItemId || !parentBomId || !["FINISHED", "SEMI_FINISHED"].includes(level)) {
        setUiNotice(res, res.locals.t("error_invalid_id"), { autoClose: true });
        return res.redirect("/master-data/bom");
      }

      const parentItem = await knex("erp.items")
        .select("id", "name")
        .where({ id: parentItemId })
        .first();

      const candidates = await bomCascadeService.listCascadeCandidates(knex, {
        itemId: parentItemId,
        level,
        parentNewBomId: parentBomId,
      });

      return renderPage(
        req,
        res,
        "../../master_data/bom/cascade/list",
        res.locals.t("bom_cascade_review_title"),
        {
          parentItem,
          parentBomId,
          level,
          candidates,
          basePath: req.baseUrl,
        },
      );
    } catch (err) {
      return next(err);
    }
  },
);

// GET /cascade/:dependentBomId?parent_bom_id=
router.get(
  "/:dependentBomId",
  requirePermission("SCREEN", BOM_SCOPE, "view"),
  async (req, res, next) => {
    try {
      const dependentBomId = Number(req.params.dependentBomId);
      const parentBomId = Number(req.query.parent_bom_id || 0);
      if (!dependentBomId || !parentBomId) {
        setUiNotice(res, res.locals.t("error_invalid_id"), { autoClose: true });
        return res.redirect("/master-data/bom");
      }

      const plan = await bomCascadeService.computeDependentMergePlan(knex, {
        dependentApprovedBomId: dependentBomId,
        parentNewBomId: parentBomId,
        locale: req.locale,
      });
      if (!plan.eligible) {
        setUiNotice(res, res.locals.t("bom_cascade_error_not_eligible"), {
          autoClose: true,
        });
        return res.redirect(
          `${req.baseUrl}?parent_bom_id=${parentBomId}`,
        );
      }

      const dependentItem = await knex("erp.items")
        .select("id", "name")
        .where({ id: plan.dependent.item_id })
        .first();
      const parentHeaderRow = await knex("erp.bom_header as bh")
        .select("bh.bom_no", "bh.version_no", "i.name as item_name")
        .leftJoin("erp.items as i", "bh.item_id", "i.id")
        .where({ "bh.id": parentBomId })
        .first();

      return renderPage(
        req,
        res,
        "../../master_data/bom/cascade/detail",
        res.locals.t("bom_cascade_review_title"),
        {
          plan,
          dependentBomId,
          parentBomId,
          dependentItem,
          parentHeader: parentHeaderRow,
          basePath: req.baseUrl,
        },
      );
    } catch (err) {
      return next(err);
    }
  },
);

// POST /cascade/:dependentBomId/apply
router.post(
  "/:dependentBomId/apply",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) => {
    const dependentBomId = Number(req.params.dependentBomId);
    const parentBomId = Number(req.body.parent_bom_id || 0);
    // The list page requires parent_item_id + level in addition to
    // parent_bom_id - resolved on demand so an error redirect lands back on
    // the review list instead of silently falling through to its own
    // "missing params" guard and bouncing to the generic BOM register.
    const buildListRedirectUrl = async () => {
      if (!parentBomId) return "/master-data/bom";
      const parentHeader = await knex("erp.bom_header")
        .select("item_id", "level")
        .where({ id: parentBomId })
        .first();
      if (!parentHeader) return "/master-data/bom";
      return `${req.baseUrl}?parent_item_id=${parentHeader.item_id}&level=${parentHeader.level}&parent_bom_id=${parentBomId}`;
    };
    try {
      if (!dependentBomId || !parentBomId) {
        setUiNotice(res, res.locals.t("error_invalid_id"), { autoClose: true });
        return res.redirect("/master-data/bom");
      }
      const selectedKeysBySection = {
        rm_lines: safeJsonArray(req.body.selected_rm_lines),
        sku_overrides: safeJsonArray(req.body.selected_sku_overrides),
        stage_routes: safeJsonArray(req.body.selected_stage_routes),
        sfg_lines: safeJsonArray(req.body.selected_sfg_lines),
      };

      const result = await bomCascadeService.createCascadeDraft(knex, {
        dependentApprovedBomId: dependentBomId,
        parentNewBomId: parentBomId,
        selectedKeysBySection,
        userId: req.user?.id || null,
        requestId: null,
        t: res.locals.t,
        locale: req.locale,
      });

      setUiNotice(res, res.locals.t("bom_cascade_apply_success"), {
        autoClose: true,
      });
      return res.redirect(`/master-data/bom/${result.id}`);
    } catch (err) {
      if (err?.code === "BOM_CASCADE_DRAFT_EXISTS" || err?.code === "BOM_CASCADE_NOT_ELIGIBLE") {
        setUiNotice(res, err.message, { autoClose: true, type: "error" });
        return res.redirect(await buildListRedirectUrl());
      }
      const message = friendlyErrorMessage(err, res.locals.t);
      setUiNotice(res, message, { autoClose: true, type: "error" });
      return res.redirect(await buildListRedirectUrl());
    }
  },
);

module.exports = router;
